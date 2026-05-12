// scripts/replay-cargurus.js
//
// One-shot backfill for CarGurus leads that were silently dropped at
// status='no_adf' before the plain-text parser landed (commit 73ad19b,
// 2026-05-11). Defaults are scoped tight so Franco can just run it —
// no args, no token-juggling.
//
// What it does:
//   1. Print Hunt's CRM count by source BEFORE (lookups against
//      desk_crm scoped to Hunt's tenant_id)
//   2. Walk the IMAP-polled inbox for messages sent to
//      leads@firstfinancialcanada.com SINCE Mil's signup window
//      (2026-04-25), and re-run each through processMessage. The
//      new plain-text fallback inside processMessage handles
//      CarGurus; the dedup-on-success guard makes the replay safe
//      to re-run (anything that landed OK before is skipped).
//   3. Print Hunt's CRM count by source AFTER + the delta.
//
// USAGE (from V1.4 root, with Railway env loaded):
//   railway run node scripts/replay-cargurus.js              # do it
//   railway run node scripts/replay-cargurus.js --dry-run    # walk inbox, don't insert
//
// Reads:  desk_tenants, desk_crm, lead_intake_log
// Writes: desk_crm, lead_intake_log (only when not --dry-run)

'use strict';

require('dotenv').config();

const { Pool }         = require('pg');
const imapSimple       = require('imap-simple');
const { simpleParser } = require('mailparser');
const { processMessage } = require('../lib/lead-intake');

const FILTER_TO    = 'leads@firstfinancialcanada.com';
const FILTER_SINCE = '2026-04-25';                  // covers Mil's signup window
const HUNT_OWNER   = 'mil@huntchrysler.com';        // resolves Hunt's tenant_id
const DRY_RUN      = process.argv.includes('--dry-run');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

function banner(title) {
  console.log('\n' + '─'.repeat(70));
  console.log('  ' + title);
  console.log('─'.repeat(70));
}

// ── CRM snapshot helper ──────────────────────────────────────────────
async function snapshot(tenantId, label) {
  const total = await pool.query(
    `SELECT COUNT(*)::int AS n FROM desk_crm WHERE tenant_id = $1`,
    [tenantId]
  );
  const bySource = await pool.query(
    `SELECT COALESCE(source, '(null)') AS source, COUNT(*)::int AS n
       FROM desk_crm WHERE tenant_id = $1
      GROUP BY source ORDER BY n DESC`,
    [tenantId]
  );
  console.log('  ' + label + ' total in Hunt CRM: ' + total.rows[0].n);
  bySource.rows.forEach(r => console.log('    ' + r.source.padEnd(20) + ' ' + r.n));
  return total.rows[0].n;
}

// ── IMAP replay (mirrors replay-dropped-leads.js's core loop) ────────
async function replayInbox() {
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

  const conn = await imapSimple.connect(cfg);
  await conn.openBox('INBOX');
  console.log('  ✅ Connected to ' + cfg.imap.user);

  const messages = await conn.search(
    [['SINCE', FILTER_SINCE], ['TO', FILTER_TO]],
    { bodies: [''], markSeen: false, struct: true }
  );
  console.log('  Found ' + messages.length + ' messages to leads@... since ' + FILTER_SINCE);

  const counts = { ok: 0, duplicate: 0, no_tenant: 0, no_adf: 0, parse_error: 0, error: 0, dry_run: 0, skipped: 0 };
  let processed = 0;

  for (const m of messages) {
    processed++;
    const all = m.parts.find(p => p.which === '');
    if (!all || !all.body) { counts.skipped++; continue; }

    let parsedMail;
    try {
      parsedMail = await simpleParser(all.body);
    } catch (e) {
      counts.error++;
      continue;
    }

    const subj = (parsedMail.subject || '(no subject)').slice(0, 55);
    const date = parsedMail.date ? parsedMail.date.toISOString().slice(0, 16) : '?';

    if (DRY_RUN) {
      counts.dry_run++;
      console.log('  [' + String(processed).padStart(3) + '] DRY ' + date + '  ' + subj);
      continue;
    }

    const summary = await processMessage(parsedMail, 'replay-cargurus');
    const status  = summary.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;

    const tag =
      status === 'ok'        ? '✅' :
      status === 'duplicate' ? '⏭ ' :
      status === 'no_tenant' ? '❌' :
                               '⚠ ';
    const extra = (summary.crmEntryId ? '  → CRM #' + summary.crmEntryId : '')
                + (summary.source ? '  [' + summary.source + ']' : '');
    console.log('  [' + String(processed).padStart(3) + '] ' + tag + ' ' + status.padEnd(11) + ' ' + date + '  ' + subj + extra);
  }

  await conn.end();
  return counts;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  banner('Replay CarGurus (and other plain-text drops)');
  console.log('  Mode:        ' + (DRY_RUN ? 'DRY RUN (will not insert)' : 'LIVE (will insert)'));
  console.log('  Filter to:   ' + FILTER_TO);
  console.log('  Since:       ' + FILTER_SINCE);

  // Resolve Hunt's tenant_id
  const u = await pool.query(
    `SELECT id FROM desk_users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [HUNT_OWNER]
  );
  if (!u.rows.length) {
    console.error('❌ No desk_users row for ' + HUNT_OWNER);
    await pool.end();
    process.exit(1);
  }
  const userId = u.rows[0].id;
  const t = await pool.query(
    `SELECT id FROM desk_tenants WHERE owner_user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!t.rows.length) {
    console.error('❌ No tenant for owner ' + HUNT_OWNER + ' (user_id=' + userId + ')');
    await pool.end();
    process.exit(1);
  }
  const tenantId = t.rows[0].id;
  console.log('  Hunt tenant_id: ' + tenantId);

  banner('Hunt CRM — BEFORE');
  const before = await snapshot(tenantId, 'Before');

  banner('Replaying IMAP messages');
  const counts = await replayInbox();

  banner('Replay summary');
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) console.log('  ' + k.padEnd(12) + ': ' + v);
  }

  banner('Hunt CRM — AFTER');
  const after = await snapshot(tenantId, 'After ');

  banner('Delta');
  const delta = after - before;
  console.log('  Net new CRM rows for Hunt: ' + delta + (DRY_RUN ? '  (dry-run — nothing actually inserted)' : ''));

  await pool.end();
  console.log('\n✅ Done.\n');
}

main().catch(err => {
  console.error('\n❌ Replay failed:', err.message);
  console.error(err.stack);
  pool.end().catch(() => {});
  process.exit(1);
});
