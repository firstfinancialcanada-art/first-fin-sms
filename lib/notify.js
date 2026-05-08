// lib/notify.js — Tenant-scoped lead notification fan-out
//
// Replaces the legacy single-phone notifyOwner() that read FORWARD_PHONE /
// OWNER_PHONE from env, which sent EVERY tenant's appointment + callback
// alerts to a single hardcoded number (the platform operator's phone).
// That was a cross-tenant data leak — Hunt Chrysler's customers were
// pinging Franco's cell instead of Mil.
//
// New behaviour (per Franco's directive):
//   - Owners + managers in the booking lead's tenant get the SMS.
//   - Reps do NOT get SMS — they watch Sarah conversations in-app.
//   - If no member of the tenant has a notify_phone set, fall back ONCE
//     to the legacy tenant-settings notifyPhone (settings_json.notifyPhone)
//     so existing single-tenant configs keep working until the owner sets
//     a per-user notify_phone.
//   - There is NO env-var fallback. Missing a notification is safer than
//     leaking customer details cross-tenant.
//
// Idempotent on require: adds desk_users.notify_phone column + a one-shot
// backfill that copies the legacy tenant-settings notifyPhone onto the
// owner's user row so live tenants don't go dark on first deploy.
'use strict';

const { pool } = require('./db');

let _initPromise = null;
function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      await pool.query(`
        ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS notify_phone VARCHAR(20);
      `);
      // One-shot backfill: every owner whose user row has no notify_phone yet
      // but whose settings_json.notifyPhone is populated → copy it forward.
      // Idempotent: re-runs are no-ops because the WHERE clause excludes
      // already-populated rows.
      const r = await pool.query(`
        UPDATE desk_users u
           SET notify_phone = u.settings_json->>'notifyPhone'
         WHERE u.notify_phone IS NULL
           AND u.settings_json->>'notifyPhone' IS NOT NULL
           AND length(u.settings_json->>'notifyPhone') >= 10
      `);
      if (r.rowCount > 0) {
        console.log(`📞 notify: backfilled notify_phone for ${r.rowCount} user(s) from legacy settings`);
      }
      console.log('✅ desk_users.notify_phone ready + backfilled');
    } catch (e) {
      console.error('❌ notify init:', e.message);
    }
  })();
  return _initPromise;
}
init();

// Returns the list of phone numbers that should receive a notification
// for a lead in the given tenant. Owner + managers only (active members).
// Falls back to the tenant-settings notifyPhone for tenants that haven't
// migrated yet. Returns [] if nothing is configured anywhere — caller
// should log + skip silently rather than leak to a global default.
async function getNotifyTargets(tenantId) {
  if (!tenantId) return [];
  // 1. Members with role owner/manager that have a per-user notify_phone
  const memberRes = await pool.query(
    `SELECT u.id AS user_id, u.display_name, u.notify_phone, m.role
       FROM desk_members m
       JOIN desk_users   u ON u.id = m.user_id
      WHERE m.tenant_id = $1
        AND m.active = TRUE
        AND m.role IN ('owner','manager')
        AND u.notify_phone IS NOT NULL
        AND length(u.notify_phone) >= 10`,
    [tenantId]
  );
  if (memberRes.rows.length) {
    return memberRes.rows.map(r => ({
      userId: r.user_id, name: r.display_name, phone: r.notify_phone, role: r.role,
    }));
  }
  // 2. Fallback: legacy tenant-settings notifyPhone (the owner's settings_json)
  const ownerRes = await pool.query(
    `SELECT u.id AS user_id, u.display_name, u.settings_json->>'notifyPhone' AS phone
       FROM desk_tenants t
       JOIN desk_users   u ON u.id = t.owner_user_id
      WHERE t.id = $1
        AND u.settings_json->>'notifyPhone' IS NOT NULL
        AND length(u.settings_json->>'notifyPhone') >= 10
      LIMIT 1`,
    [tenantId]
  );
  if (ownerRes.rows.length) {
    return [{ userId: ownerRes.rows[0].user_id, name: ownerRes.rows[0].display_name,
              phone: ownerRes.rows[0].phone, role: 'owner' }];
  }
  return [];
}

// Send the SMS body to every owner+manager in the tenant. Returns
// { sent, skipped, errors } so callers can log. NEVER falls back to a
// global env phone — missing config means missing notification.
//
// twilioClient: the live Twilio client (passed in so this module doesn't
//               import twilio directly — easier to test/mock and matches
//               the existing pattern in lib/helpers.js makeNotifyOwner).
async function notifyTenantManagers({ tenantId, fromNumber, body, twilioClient }) {
  const targets = await getNotifyTargets(tenantId);
  if (!targets.length) {
    console.warn(`⚠️ notify: tenant ${tenantId} has no notify_phone configured — alert skipped`);
    return { sent: 0, skipped: 1, errors: 0, reason: 'no_targets' };
  }
  if (!twilioClient || !fromNumber) {
    console.warn('⚠️ notify: missing twilioClient or fromNumber — alert skipped');
    return { sent: 0, skipped: targets.length, errors: 0, reason: 'no_client' };
  }
  let sent = 0, errors = 0;
  await Promise.all(targets.map(async t => {
    try {
      await twilioClient.messages.create({ body, from: fromNumber, to: t.phone });
      sent++;
      console.log(`📱 notify → ${t.name} (${t.role}) ${t.phone.slice(-4).padStart(t.phone.length, '*')}`);
    } catch (e) {
      errors++;
      console.error(`❌ notify failed for ${t.name}:`, e.message);
    }
  }));
  return { sent, skipped: 0, errors, targetCount: targets.length };
}

module.exports = {
  init,
  getNotifyTargets,
  notifyTenantManagers,
};
