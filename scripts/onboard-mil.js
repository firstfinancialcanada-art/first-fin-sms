// scripts/onboard-mil.js
// One-shot remediation for Hunt Chrysler / Mil Radenkovic onboarding.
//
// Background: Mil paid for Gold ($525/mo) on 2026-04-27 but entered the
// dealership main line (905-876-2580) instead of his cell at checkout.
// The setup-link SMS went to the dealership phone. Separately, the Stripe
// webhook auto-created the user but defaulted his tenant to 'single' tier
// with 1 seat (Phase 6e gap). This script repairs both.
//
// What it does (idempotent — safe to re-run):
//   1. Looks up Mil by email, prints current state
//   2. Invalidates any unconsumed setup_tokens (security: old token went
//      to a phone number Mil doesn't control)
//   3. Updates platform_inquiries.phone to his correct cell
//   4. Flips his tenant tier 'single' → 'gold', seats_allowed 1 → 10
//   5. Sets lead_intake_email = huntchrysler@firstfinancialcanada.com
//   6. With --send-sms flag: generates a fresh 24h setup_token + SMSes
//      the link to his correct cell. Without the flag, holds the SMS so
//      Franco can hand-deliver credentials after inventory preload.
//
// USAGE (from V1.4 root, with Railway env loaded):
//   railway run node scripts/onboard-mil.js               # fix everything except SMS
//   railway run node scripts/onboard-mil.js --send-sms    # also fire fresh setup SMS
//
// Requires env vars: DATABASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//                    TWILIO_PHONE_NUMBER, BASE_URL (for setup link)

'use strict';

require('dotenv').config();

// ── Constants — verify before running ─────────────────────────────────────
const MIL_EMAIL          = 'mil@huntchrysler.com';
const MIL_CORRECT_CELL   = '+19052082825';                     // E.164
const HUNT_INTAKE_EMAIL  = 'huntchrysler@firstfinancialcanada.com';
const TARGET_TIER        = 'gold';
const TARGET_SEATS       = 10;

// ── Twilio + DB ───────────────────────────────────────────────────────────
const { Pool } = require('pg');
const crypto   = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const SEND_SMS = process.argv.includes('--send-sms');

function banner(title) {
  console.log('\n' + '─'.repeat(70));
  console.log('  ' + title);
  console.log('─'.repeat(70));
}

async function main() {
  banner('Mil onboarding repair script');
  console.log(`  email:        ${MIL_EMAIL}`);
  console.log(`  new phone:    ${MIL_CORRECT_CELL}`);
  console.log(`  intake email: ${HUNT_INTAKE_EMAIL}`);
  console.log(`  target tier:  ${TARGET_TIER} (${TARGET_SEATS} seats)`);
  console.log(`  send SMS:     ${SEND_SMS ? 'YES (will fire Twilio)' : 'no (holding for hand-delivery)'}`);

  // ── Step 1: look up user ────────────────────────────────────────────────
  banner('1. Lookup');
  const u = await pool.query(
    `SELECT id, email, display_name, subscription_status, stripe_customer_id, settings_json
       FROM desk_users WHERE LOWER(email) = LOWER($1)`,
    [MIL_EMAIL]
  );
  if (u.rows.length === 0) {
    console.error(`❌ No desk_users row for ${MIL_EMAIL}. Did the Stripe webhook fire?`);
    process.exit(1);
  }
  const user = u.rows[0];
  console.log(`  user_id: ${user.id}`);
  console.log(`  display_name: ${user.display_name}`);
  console.log(`  subscription_status: ${user.subscription_status}`);
  console.log(`  stripe_customer_id: ${user.stripe_customer_id || '(none)'}`);

  const t = await pool.query(
    `SELECT id, dealership, tier, seats_allowed, lead_intake_email
       FROM desk_tenants WHERE owner_user_id = $1`,
    [user.id]
  );
  if (t.rows.length === 0) {
    console.error(`❌ No desk_tenants row for owner ${user.id}. lib/tenants.init() may not have run.`);
    process.exit(1);
  }
  const tenant = t.rows[0];
  console.log(`  tenant_id: ${tenant.id}`);
  console.log(`  current tier: ${tenant.tier} (${tenant.seats_allowed} seats)`);
  console.log(`  current intake email: ${tenant.lead_intake_email || '(unset)'}`);

  const tk = await pool.query(
    `SELECT token, expires_at, consumed_at, created_at
       FROM setup_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [user.id]
  );
  console.log(`  existing setup_tokens: ${tk.rows.length}`);
  for (const row of tk.rows) {
    const live = row.consumed_at == null && new Date(row.expires_at) > new Date();
    console.log(`    - ${row.token.slice(0,8)}… created=${row.created_at.toISOString()} expires=${row.expires_at.toISOString()} consumed=${row.consumed_at ? row.consumed_at.toISOString() : 'no'} ${live ? '⚠ LIVE' : '✓ dead'}`);
  }

  const inq = await pool.query(
    `SELECT id, phone, status FROM platform_inquiries WHERE LOWER(email) = LOWER($1)`,
    [MIL_EMAIL]
  );
  console.log(`  platform_inquiries rows: ${inq.rows.length}`);
  for (const r of inq.rows) console.log(`    - id=${r.id} phone=${r.phone} status=${r.status}`);

  // ── Step 2: invalidate live tokens ─────────────────────────────────────
  banner('2. Invalidate live setup_tokens (security)');
  const expired = await pool.query(
    `UPDATE setup_tokens SET expires_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING token`,
    [user.id]
  );
  console.log(`  ✅ Invalidated ${expired.rowCount} live token(s).`);

  // ── Step 3: update phone on file ───────────────────────────────────────
  banner('3. Update platform_inquiries.phone');
  // Strip leading +1 for storage consistency with what the webhook wrote
  const storedPhone = MIL_CORRECT_CELL.replace(/^\+?1?/, '');
  const phoneUpd = await pool.query(
    `UPDATE platform_inquiries SET phone = $1 WHERE LOWER(email) = LOWER($2) RETURNING id`,
    [storedPhone, MIL_EMAIL]
  );
  console.log(`  ✅ Updated ${phoneUpd.rowCount} inquiry row(s) → phone=${storedPhone}`);

  // ── Step 4: flip tier to gold + set seats ──────────────────────────────
  banner('4. Flip tenant to Gold tier (10 seats)');
  await pool.query(
    `UPDATE desk_tenants
        SET tier = $1, seats_allowed = $2
      WHERE id = $3`,
    [TARGET_TIER, TARGET_SEATS, tenant.id]
  );
  console.log(`  ✅ Tenant ${tenant.id}: tier=${TARGET_TIER}, seats_allowed=${TARGET_SEATS}`);

  // ── Step 5: set lead_intake_email ──────────────────────────────────────
  banner('5. Set lead_intake_email');
  // Idempotent: only set if column exists; otherwise warn (Phase 6 column).
  try {
    await pool.query(
      `UPDATE desk_tenants SET lead_intake_email = $1 WHERE id = $2`,
      [HUNT_INTAKE_EMAIL, tenant.id]
    );
    console.log(`  ✅ lead_intake_email = ${HUNT_INTAKE_EMAIL}`);
  } catch (e) {
    console.warn(`  ⚠️ Could not set lead_intake_email: ${e.message}`);
    console.warn(`     If column missing, add: ALTER TABLE desk_tenants ADD COLUMN lead_intake_email TEXT;`);
  }

  // ── Step 6: optional fresh setup SMS ───────────────────────────────────
  if (SEND_SMS) {
    banner('6. Generate fresh setup_token + send SMS to correct cell');
    const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'BASE_URL'];
    const missing = need.filter(k => !process.env[k]);
    if (missing.length) {
      console.error(`  ❌ Missing env: ${missing.join(', ')} — cannot send SMS.`);
      process.exit(1);
    }

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO setup_tokens (token, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
      [token, user.id]
    );
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const setupUrl = `${baseUrl}/setup?token=${token}`;
    console.log(`  Fresh setup URL: ${setupUrl}`);

    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const firstName = (user.display_name || 'there').split(' ')[0];
    const msg = await twilio.messages.create({
      body:
        `Welcome to FIRST-FIN, ${firstName}! 🎉\n\n` +
        `Your Hunt Chrysler account is ready. Complete setup here (link expires in 24h):\n\n` +
        `${setupUrl}\n\n` +
        `Questions? Call/text 587-306-6133`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   MIL_CORRECT_CELL,
    });
    console.log(`  ✅ Twilio SID: ${msg.sid} — sent to ${MIL_CORRECT_CELL}`);
  } else {
    banner('6. Skipping SMS (re-run with --send-sms to fire it)');
  }

  // ── Final state ────────────────────────────────────────────────────────
  banner('Final state');
  const final = await pool.query(
    `SELECT t.id AS tenant_id, t.tier, t.seats_allowed, t.lead_intake_email,
            (SELECT COUNT(*)::int FROM setup_tokens
              WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()) AS live_tokens
       FROM desk_tenants t WHERE t.owner_user_id = $1`,
    [user.id]
  );
  console.log(JSON.stringify(final.rows[0], null, 2));

  await pool.end();
  console.log('\n✅ Done.\n');
}

main().catch(err => {
  console.error('\n❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
