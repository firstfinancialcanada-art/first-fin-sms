// scripts/check-mil-state.js
//
// Read-only diagnostic for Hunt Chrysler / Mil Radenkovic — answers:
//   1. What email address is actually in desk_tenants.lead_intake_email
//      for Hunt right now? (We've gone back and forth between the wizard
//      suggesting a custom slug like huntchrysler@firstfinancialcanada.com
//      and a shared Leads@FirstFinancialCanada.com fallback.)
//   2. Have any leads been arriving at our IMAP-polled Gmail and been
//      silently dropped because the recipient address didn't match a
//      tenant? Last 20 entries from lead_intake_log, all statuses.
//   3. Is Hunt's tenant fully provisioned (tier, seats, dealership name)?
//
// USAGE (from V1.4 root with Railway env loaded):
//   railway run node scripts/check-mil-state.js
//
// Does NOT mutate anything. Safe to run repeatedly.

'use strict';

require('dotenv').config();

const { Pool } = require('pg');

const MIL_EMAIL = 'mil@huntchrysler.com';

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

async function main() {
  banner('Mil / Hunt Chrysler — current platform state');

  // ── 1. User ────────────────────────────────────────────────────────────
  const u = await pool.query(
    `SELECT id, email, display_name, subscription_status, twilio_number, last_login
       FROM desk_users WHERE LOWER(email) = LOWER($1)`,
    [MIL_EMAIL]
  );
  if (u.rows.length === 0) {
    console.error(`❌ No desk_users row for ${MIL_EMAIL}.`);
    await pool.end();
    process.exit(1);
  }
  const user = u.rows[0];
  banner('1. desk_users');
  console.log(JSON.stringify(user, null, 2));

  // ── 2. Tenant ──────────────────────────────────────────────────────────
  const t = await pool.query(
    `SELECT id, dealership, tier, seats_allowed, lead_intake_email, owner_user_id
       FROM desk_tenants WHERE owner_user_id = $1`,
    [user.id]
  );
  banner('2. desk_tenants');
  if (t.rows.length === 0) {
    console.log('⚠️  No tenant — owner_user_id mismatch or never provisioned.');
  } else {
    console.log(JSON.stringify(t.rows[0], null, 2));
    console.log('\n→ lead_intake_email is what gets matched against the To:/Cc:/');
    console.log('  Delivered-To headers of incoming emails to route them to');
    console.log('  this tenant. If it is null or set to an address that nothing');
    console.log('  is forwarding to, leads silently fail to attach.');
  }

  // ── 3. Members (seats) ─────────────────────────────────────────────────
  const m = await pool.query(
    `SELECT m.id, m.role, m.crm_mode, m.active, du.email AS member_email, du.display_name
       FROM desk_members m JOIN desk_users du ON du.id = m.user_id
      WHERE m.tenant_id = $1 ORDER BY m.id`,
    [t.rows[0]?.id || 0]
  );
  banner('3. desk_members (seats)');
  console.log(`Count: ${m.rows.length}`);
  m.rows.forEach(r => console.log(`  - ${r.role.padEnd(8)} ${r.member_email}  active=${r.active}  crm_mode=${r.crm_mode}`));

  // ── 4. Recent lead_intake_log ──────────────────────────────────────────
  const log = await pool.query(
    `SELECT created_at, tenant_id, status, intake_addr, sender_from, subject, source, error
       FROM lead_intake_log
       ORDER BY created_at DESC
       LIMIT 25`
  );
  banner('4. lead_intake_log — last 25 messages (ALL tenants)');
  if (log.rows.length === 0) {
    console.log('(empty — IMAP poll has never logged a message)');
  } else {
    log.rows.forEach(r => {
      const ts = r.created_at.toISOString().replace('T', ' ').slice(0, 19);
      const status = r.status.padEnd(11);
      const tenant = (r.tenant_id || '—').toString().padEnd(4);
      const addr = (r.intake_addr || '—').padEnd(40);
      const subj = (r.subject || '').slice(0, 50);
      console.log(`  ${ts}  ${status}  tenant=${tenant}  to=${addr}  subj="${subj}"`);
      if (r.error) console.log(`    └─ error: ${r.error}`);
    });
  }

  // ── 5. Aggregate by status (last 7 days) ───────────────────────────────
  const agg = await pool.query(
    `SELECT status, COUNT(*)::int AS n
       FROM lead_intake_log
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY status ORDER BY n DESC`
  );
  banner('5. lead_intake_log — status breakdown, last 7 days');
  if (agg.rows.length === 0) {
    console.log('(no messages logged in the last 7 days)');
  } else {
    agg.rows.forEach(r => console.log(`  ${r.status.padEnd(15)} ${r.n}`));
  }

  // ── 6. desk_inventory size for Hunt ───────────────────────────────────
  if (t.rows[0]) {
    const inv = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(vin)::int AS with_vin,
              COUNT(stock)::int AS with_stock
         FROM desk_inventory WHERE tenant_id = $1`,
      [t.rows[0].id]
    );
    banner('6. Hunt inventory — for VIN/stock-based routing fallback');
    console.log(JSON.stringify(inv.rows[0], null, 2));
  }

  await pool.end();
  console.log('\n✅ Done.\n');
}

main().catch(err => {
  console.error('\n❌ Diagnostic failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
