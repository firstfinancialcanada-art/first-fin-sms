// scripts/verify-hunt-leads.js
//
// End-to-end pipeline verifier for Hunt Chrysler (or any tenant). Proves
// the lead-intake pipeline is alive without depending on an external lead
// provider firing a real customer message. Run this:
//
//   - After Sarah / lead-intake / routing changes ship
//   - When a dealer reports "I'm missing leads" and you need a binary
//     pass/fail in < 60 seconds
//   - Before telling a new dealer "give your aggregators this address"
//
// What it does (no external email sender needed):
//
//   1. Build a synthetic ADF XML payload that mentions Hunt's vendor name
//      + a unique VIN-shaped string in the comments, plus a known
//      message-id, addressed To: <tenant.lead_intake_email>.
//   2. Use the IMAP APPEND command to inject that payload directly into
//      the polled INBOX as if it had been received from outside. APPEND
//      preserves the To: header so the address-match router picks it up.
//   3. Wait for the live IMAP poller to process it (poll lead_intake_log
//      by message-id, with a 90s timeout).
//   4. Print pass/fail + routing details (which path matched, which
//      tenant, which CRM row id). Optional --cleanup deletes the synthetic
//      CRM row so it doesn't pollute the dealer's inbox.
//
// USAGE (from V1.4 root, with Railway env loaded):
//   railway run node scripts/verify-hunt-leads.js                # Hunt by default
//   railway run node scripts/verify-hunt-leads.js --tenant 5      # by id
//   railway run node scripts/verify-hunt-leads.js --email mil@huntchrysler.com
//   railway run node scripts/verify-hunt-leads.js --cleanup       # remove synth CRM row + log row after
//   railway run node scripts/verify-hunt-leads.js --timeout 60    # seconds (default 90)
//
// Designed to be idempotent: each run generates a fresh message-id, so
// re-running creates a fresh test (no dedup collision). The synthetic CRM
// row is tagged in notes so a human can spot/clean it. With --cleanup it
// removes the row automatically.

'use strict';

require('dotenv').config();

const { Pool }     = require('pg');
const imapSimple   = require('imap-simple');
const crypto       = require('crypto');

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => {
    if (a.startsWith('--')) {
      const key  = a.slice(2);
      const next = arr[i + 1];
      if (next && !next.startsWith('--')) return [key, next];
      return [key, true];
    }
    return null;
  }).filter(Boolean)
);

const HUNT_EMAIL = 'mil@huntchrysler.com';
const TIMEOUT_SEC = parseInt(args.timeout, 10) || 90;
const POLL_INTERVAL_MS = 3000;
const DO_CLEANUP = !!args.cleanup;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const imapCfg = {
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

// ── Helpers ──────────────────────────────────────────────────────────
function banner(title) {
  console.log('\n' + '─'.repeat(70));
  console.log('  ' + title);
  console.log('─'.repeat(70));
}
function pad(s, n) { return String(s).padEnd(n); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Resolve the target tenant (by --tenant id, --email, or default Hunt).
async function resolveTenant() {
  if (args.tenant) {
    const r = await pool.query(
      `SELECT t.id, t.dealership, t.lead_intake_email, t.owner_user_id, u.email AS owner_email
         FROM desk_tenants t JOIN desk_users u ON u.id = t.owner_user_id
        WHERE t.id = $1`, [parseInt(args.tenant, 10)]);
    return r.rows[0] || null;
  }
  const ownerEmail = (args.email || HUNT_EMAIL).toLowerCase();
  const r = await pool.query(
    `SELECT t.id, t.dealership, t.lead_intake_email, t.owner_user_id, u.email AS owner_email
       FROM desk_users u JOIN desk_tenants t ON t.owner_user_id = u.id
      WHERE LOWER(u.email) = $1`, [ownerEmail]);
  return r.rows[0] || null;
}

// Build a synthetic ADF XML payload with a deterministic message-id so we
// can poll the log for outcome. The "customer" is clearly marked SYNTH so
// a human glancing at the CRM knows not to call them.
function buildSyntheticAdfMessage(tenant, messageId) {
  const intake     = tenant.lead_intake_email || 'leads@firstfinancialcanada.com';
  const dealership = tenant.dealership || 'Hunt Chrysler';
  const dateIso    = new Date().toISOString();
  const xml = [
    '<?xml version="1.0"?>',
    '<?adf version="1.0"?>',
    '<adf>',
    '<prospect>',
    `<requestdate>${dateIso}</requestdate>`,
    '<vehicle interest="buy" status="new">',
    '<year>2026</year>',
    '<make>Verifier</make>',
    '<model>Synthetic</model>',
    '<trim>Pipeline Test</trim>',
    `<vin>SYNTH-${messageId.slice(0, 14).toUpperCase()}</vin>`,
    `<stock>VERIFY-${messageId.slice(0, 8)}</stock>`,
    '</vehicle>',
    '<customer>',
    '<contact>',
    '<name part="full">SYNTH Verifier (DO NOT CALL)</name>',
    '<email>verifier@firstfinancialcanada.com</email>',
    '<phone>+10000000000</phone>',
    '</contact>',
    '</customer>',
    `<vendor><vendorname>${dealership}</vendorname></vendor>`,
    `<comments>verify-hunt-leads synthetic test ${messageId} — safe to delete</comments>`,
    '</prospect>',
    '</adf>',
  ].join('\n');

  // RFC822 envelope. The poller reads To/Cc/Delivered-To via mailparser;
  // setting To to the tenant's intake address means resolveTenantByAddress
  // matches it directly (the strong path we just fixed for Hunt).
  const rfc822 = [
    `Message-ID: <${messageId}@verifier.firstfinancialcanada.com>`,
    `Date: ${new Date().toUTCString()}`,
    `From: "Verifier" <verifier@firstfinancialcanada.com>`,
    `To: <${intake}>`,
    `Subject: [VERIFY] Synthetic ADF Lead — ${messageId.slice(0, 10)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    '',
    'This is a synthetic lead injected by scripts/verify-hunt-leads.js',
    'to verify the lead-intake pipeline is alive. ADF XML follows:',
    '',
    xml,
    '',
  ].join('\r\n');
  return rfc822;
}

// IMAP APPEND the synthetic message into INBOX. Returns true on success.
async function appendSynthetic(rfc822) {
  const conn = await imapSimple.connect(imapCfg);
  try {
    // imap-simple's `connection.imap.append` accepts a Buffer + options
    await new Promise((resolve, reject) => {
      conn.imap.append(rfc822, { mailbox: 'INBOX', flags: ['\\Recent'] }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return true;
  } finally {
    try { conn.end(); } catch {}
  }
}

// Poll lead_intake_log for the test message-id. Returns the log row or null.
async function waitForLogEntry(messageIdFragment, timeoutSec) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const r = await pool.query(
      `SELECT id, tenant_id, message_id, intake_addr, status, source,
              prospect_id, crm_entry_id, error, processed_at
         FROM lead_intake_log
        WHERE message_id LIKE $1
        ORDER BY processed_at DESC NULLS LAST LIMIT 1`,
      [`%${messageIdFragment}%`]
    );
    if (r.rows.length) return r.rows[0];
    process.stdout.write('.');
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function cleanupSyntheticRows(logRow) {
  if (!logRow) return { logDeleted: 0, crmDeleted: 0 };
  let crmDeleted = 0;
  if (logRow.crm_entry_id) {
    const r = await pool.query(
      `DELETE FROM desk_crm WHERE id = $1 AND notes LIKE '%verify-hunt-leads synthetic%' RETURNING id`,
      [logRow.crm_entry_id]
    );
    crmDeleted = r.rowCount || 0;
  }
  const lr = await pool.query(`DELETE FROM lead_intake_log WHERE id = $1 RETURNING id`, [logRow.id]);
  return { logDeleted: lr.rowCount || 0, crmDeleted };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  banner('verify-hunt-leads — end-to-end lead pipeline check');

  if (!process.env.LEADS_IMAP_USER || !process.env.LEADS_IMAP_PASS) {
    console.error('❌ LEADS_IMAP_USER / LEADS_IMAP_PASS not set');
    process.exit(1);
  }

  // 1. Resolve tenant
  const tenant = await resolveTenant();
  if (!tenant) {
    console.error('❌ Tenant not found.');
    await pool.end();
    process.exit(1);
  }
  console.log('  Tenant:           ' + tenant.dealership + ' (id=' + tenant.id + ')');
  console.log('  Owner:            ' + tenant.owner_email);
  console.log('  Lead intake addr: ' + (tenant.lead_intake_email || '(not set!)'));
  console.log('  IMAP user:        ' + imapCfg.imap.user);
  console.log('  Timeout:          ' + TIMEOUT_SEC + 's');
  console.log('  Cleanup after:    ' + (DO_CLEANUP ? 'YES' : 'no (use --cleanup to auto-delete)'));

  if (!tenant.lead_intake_email) {
    console.error('\n❌ Tenant has no lead_intake_email set. Set it before verifying.');
    await pool.end();
    process.exit(1);
  }

  // 2. Inject synthetic message
  const messageId = `verify-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  banner('Injecting synthetic ADF via IMAP APPEND');
  console.log('  Message-ID fragment: ' + messageId);
  const rfc822 = buildSyntheticAdfMessage(tenant, messageId);
  try {
    await appendSynthetic(rfc822);
    console.log('  ✅ APPEND succeeded');
  } catch (e) {
    console.error('  ❌ APPEND failed: ' + e.message);
    await pool.end();
    process.exit(1);
  }

  // 3. Wait for poller to process
  banner('Waiting for poller to process');
  console.log('  Polling lead_intake_log (every ' + (POLL_INTERVAL_MS / 1000) + 's, up to ' + TIMEOUT_SEC + 's)…');
  const logRow = await waitForLogEntry(messageId, TIMEOUT_SEC);
  console.log('');

  // 4. Report
  banner('Result');
  if (!logRow) {
    console.error('  ❌ TIMEOUT — message never reached lead_intake_log');
    console.error('     The poller may be down, IMAP creds may be wrong, or the');
    console.error('     poll interval may be longer than ' + TIMEOUT_SEC + 's. Check Railway logs');
    console.error('     for "[lead-intake] poll" entries.');
    await pool.end();
    process.exit(2);
  }

  console.log('  ' + pad('status:', 18) + logRow.status);
  console.log('  ' + pad('tenant_id:', 18) + logRow.tenant_id + (logRow.tenant_id === tenant.id ? '  ✅' : '  ❌ mismatch!'));
  console.log('  ' + pad('intake_addr:', 18) + (logRow.intake_addr || '—'));
  console.log('  ' + pad('source:', 18) + (logRow.source || '—'));
  console.log('  ' + pad('crm_entry_id:', 18) + (logRow.crm_entry_id || '—'));
  console.log('  ' + pad('processed_at:', 18) + (logRow.processed_at ? logRow.processed_at.toISOString() : '—'));
  if (logRow.error) console.log('  ' + pad('error:', 18) + logRow.error);

  const isOk = logRow.status === 'ok' && logRow.tenant_id === tenant.id && logRow.crm_entry_id;
  const isAddressMatch = logRow.intake_addr && !logRow.intake_addr.startsWith('<');

  if (isOk) {
    console.log('\n  ✅ PASS — lead routed end-to-end into CRM');
    if (isAddressMatch) {
      console.log('         Direct address match via ' + logRow.intake_addr + ' (strong path)');
    } else {
      console.log('         Routed via content fallback (' + logRow.intake_addr + ')');
      console.log('         Suggests tenant.lead_intake_email may not match what aggregators send to.');
    }
  } else {
    console.log('\n  ❌ FAIL — did not produce a clean CRM row');
  }

  // 5. Cleanup if requested
  if (DO_CLEANUP) {
    banner('Cleanup');
    const { logDeleted, crmDeleted } = await cleanupSyntheticRows(logRow);
    console.log('  Removed ' + crmDeleted + ' CRM row(s) and ' + logDeleted + ' log row(s)');
  } else {
    console.log('\n  (Synthetic CRM row left in place — re-run with --cleanup to remove,');
    console.log('   or delete CRM row id=' + (logRow.crm_entry_id || '?') + ' manually)');
  }

  await pool.end();
  process.exit(isOk ? 0 : 1);
}

main().catch(err => {
  console.error('\n❌ Verifier crashed:', err.message);
  console.error(err.stack);
  pool.end().catch(() => {});
  process.exit(1);
});
