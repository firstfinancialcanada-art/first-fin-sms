// scripts/replay-dropped-leads.js
//
// Replay every email in the IMAP-polled inbox that was previously dropped
// because routing couldn't match a tenant (status='no_tenant'). The
// content-based fallback added 2026-05-07 to lib/lead-intake.js can now
// route them via VIN / stock # / ADF vendor name — most prior drops are
// recoverable. Use this once after the fallback ships to backfill any
// CRM rows that should have existed.
//
// What it does:
//   1. Connect to the same IMAP inbox the live poll uses
//      (process.env.LEADS_IMAP_USER / _PASS / _HOST).
//   2. Search for ALL messages — not just UNSEEN — to catch the ones
//      already marked Seen by the live poll.
//   3. Optionally narrow with --since=YYYY-MM-DD and --to=<addr>.
//   4. Hand each one to processMessage(); the new dedup logic (allows
//      reprocessing of any non-'ok' status) means it gets a real second
//      chance with the new fallback router.
//   5. Print a per-message outcome and a summary count at the end.
//
// USAGE (from V1.4 root, with Railway env loaded):
//   railway run node scripts/replay-dropped-leads.js
//   railway run node scripts/replay-dropped-leads.js --to=leads@firstfinancialcanada.com --since=2026-04-25
//
// Safe to run multiple times — the dedup check inside processMessage
// will skip anything that successfully landed in CRM on a prior pass.

'use strict';

require('dotenv').config();

const imapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const { processMessage } = require('../lib/lead-intake');

// ── Args ─────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const FILTER_TO    = args.to    || null;     // e.g. leads@firstfinancialcanada.com
const FILTER_SINCE = args.since || null;     // e.g. 2026-04-25
const DRY_RUN      = !!args['dry-run'];
const LIMIT        = args.limit ? parseInt(args.limit, 10) : 0;

// ── Env check ────────────────────────────────────────────────────────
const REQUIRED = ['LEADS_IMAP_USER', 'LEADS_IMAP_PASS'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing env: ' + missing.join(', '));
  process.exit(1);
}

const cfg = {
  imap: {
    user:     process.env.LEADS_IMAP_USER,
    password: process.env.LEADS_IMAP_PASS,
    host:     process.env.LEADS_IMAP_HOST || 'imap.gmail.com',
    port:     parseInt(process.env.LEADS_IMAP_PORT || '993', 10),
    tls:      true,
    authTimeout: 15000,
    tlsOptions: { rejectUnauthorized: false },
  },
};

// ── Banner ───────────────────────────────────────────────────────────
function banner(title) {
  console.log('\n' + '─'.repeat(70));
  console.log('  ' + title);
  console.log('─'.repeat(70));
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  banner('Lead-intake replay');
  console.log('  IMAP user:   ' + cfg.imap.user);
  console.log('  Filter to:   ' + (FILTER_TO    || '(none — all messages)'));
  console.log('  Since:       ' + (FILTER_SINCE || '(none — all dates)'));
  console.log('  Limit:       ' + (LIMIT        || '(none)'));
  console.log('  Dry run:     ' + (DRY_RUN ? 'YES (won\'t insert into CRM)' : 'no — will insert'));

  banner('Connecting to IMAP');
  const conn = await imapSimple.connect(cfg);
  await conn.openBox('INBOX');
  console.log('  ✅ Connected');

  // Build search criteria — IMAP search supports SINCE date and TO header.
  // 'ALL' returns every message in the box. We filter further client-side
  // because IMAP TO matches against the To header which lead aggregators
  // sometimes set to multiple addresses.
  const searchCriteria = ['ALL'];
  if (FILTER_SINCE) searchCriteria.push(['SINCE', FILTER_SINCE]);
  if (FILTER_TO)    searchCriteria.push(['TO', FILTER_TO]);

  banner('Searching');
  const fetchOptions = {
    bodies: [''],
    markSeen: false,   // do NOT mark seen — replay is idempotent
    struct: true,
  };
  const messages = await conn.search(searchCriteria, fetchOptions);
  console.log('  Found ' + messages.length + ' candidate messages');

  banner('Replaying');
  const counts = { ok: 0, duplicate: 0, no_tenant: 0, no_adf: 0, parse_error: 0, error: 0, dry_run: 0 };
  let processed = 0;
  for (const m of messages) {
    if (LIMIT && processed >= LIMIT) {
      console.log('  ⏹ Hit --limit, stopping.');
      break;
    }
    processed++;

    const all = m.parts.find(p => p.which === '');
    if (!all || !all.body) {
      console.log('  [' + processed + '] ⚠ no body — skip');
      continue;
    }

    let parsed;
    try {
      parsed = await simpleParser(all.body);
    } catch (e) {
      console.log('  [' + processed + '] ⚠ parse failure: ' + e.message);
      counts.error++;
      continue;
    }

    const subj = (parsed.subject || '(no subject)').slice(0, 60);
    const date = parsed.date ? parsed.date.toISOString().slice(0, 16) : '?';

    if (DRY_RUN) {
      console.log('  [' + processed + '] DRY ' + date + '  ' + subj);
      counts.dry_run++;
      continue;
    }

    const summary = await processMessage(parsed, 'replay');
    const status = summary.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
    const tag =
      status === 'ok'        ? '✅' :
      status === 'duplicate' ? '⏭ ' :
      status === 'no_tenant' ? '❌' :
      status === 'no_adf'    ? '⚠ ' :
                               '⚠ ';
    console.log('  [' + processed + '] ' + tag + ' ' + status.padEnd(11) + ' ' + date + '  ' + subj +
      (summary.crmEntryId ? '   → CRM #' + summary.crmEntryId : '') +
      (summary.intakeAddr && summary.intakeAddr.startsWith('<')
        ? '   via ' + summary.intakeAddr : ''));
  }

  banner('Summary');
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) console.log('  ' + k.padEnd(12) + ': ' + v);
  }

  await conn.end();
  console.log('\n✅ Done.\n');
}

main().catch(err => {
  console.error('\n❌ Replay failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
