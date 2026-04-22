// lib/tenants.js — Multi-user tenant + member model (Phase 1: foundation)
//
// Adds two tables on top of the existing desk_users:
//
//   desk_tenants  — one row per paying account. Owner of the subscription,
//                   tier ('single' | 'gold'), seat allowance, optional
//                   Stripe subscription ID for webhook reconciliation.
//
//   desk_members  — links users to tenants with a role ('owner' | 'manager'
//                   | 'rep'), CRM visibility mode, and optional dedicated
//                   SARAH number.
//
// Phase 1 goal: stand up the schema + backfill every existing desk_users
// row into its own single-seat tenant (owner of itself). No existing
// queries or routes are changed. User-visible behavior is identical to
// pre-Phase-1. This unblocks Phase 2 (tenant_id columns on data tables +
// auth update) and Phase 3 (admin Members panel).
//
// See memory: project_firstfin_multiuser_plan.md for the full roadmap.
'use strict';

const { pool } = require('./db');

const VALID_TIERS     = ['single', 'gold'];
const VALID_ROLES     = ['owner', 'manager', 'rep'];
const VALID_CRM_MODES = ['private', 'pool_plus_own', 'team_read'];

const GOLD_DEFAULT_SEATS   = 10;
const SINGLE_DEFAULT_SEATS = 1;

// ── Schema + migration (idempotent, runs once per process boot) ─────────
// Uses ON CONFLICT DO NOTHING everywhere so re-runs are safe. Tables use
// IF NOT EXISTS so deploy #N won't fail on already-present schema.
let _initPromise = null;
function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS desk_tenants (
          id              SERIAL PRIMARY KEY,
          owner_user_id   INTEGER NOT NULL REFERENCES desk_users(id) ON DELETE CASCADE,
          dealership      VARCHAR(255),
          tier            VARCHAR(50)  NOT NULL DEFAULT 'single',
          seats_allowed   INTEGER      NOT NULL DEFAULT 1,
          stripe_sub_id   VARCHAR(255),
          created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(owner_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tenants_owner ON desk_tenants(owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_tenants_tier  ON desk_tenants(tier);

        CREATE TABLE IF NOT EXISTS desk_members (
          id           SERIAL PRIMARY KEY,
          tenant_id    INTEGER NOT NULL REFERENCES desk_tenants(id) ON DELETE CASCADE,
          user_id      INTEGER NOT NULL REFERENCES desk_users(id)   ON DELETE CASCADE,
          role         VARCHAR(50)  NOT NULL DEFAULT 'rep',
          crm_mode     VARCHAR(50)  NOT NULL DEFAULT 'pool_plus_own',
          sarah_number VARCHAR(50),
          active       BOOLEAN      NOT NULL DEFAULT TRUE,
          invited_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_members_user   ON desk_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_members_tenant ON desk_members(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_members_role   ON desk_members(tenant_id, role);
      `);
      console.log('✅ desk_tenants + desk_members tables ready');

      // Backfill: every existing desk_users row should have a tenant and
      // a matching 'owner' member row. team_read CRM mode because they're
      // currently the only user of their data — they see everything.
      // owner/manager both default to team_read for full visibility.
      const backfill = await pool.query(`
        WITH inserted_tenants AS (
          INSERT INTO desk_tenants (owner_user_id, dealership, tier, seats_allowed)
          SELECT u.id,
                 COALESCE(u.display_name, ''),
                 'single',
                 1
          FROM desk_users u
          LEFT JOIN desk_tenants t ON t.owner_user_id = u.id
          WHERE t.id IS NULL
          RETURNING id, owner_user_id
        )
        INSERT INTO desk_members (tenant_id, user_id, role, crm_mode, active)
        SELECT it.id, it.owner_user_id, 'owner', 'team_read', TRUE
        FROM inserted_tenants it
        ON CONFLICT (tenant_id, user_id) DO NOTHING;
      `);
      if (backfill.rowCount > 0) {
        console.log(`✅ backfilled ${backfill.rowCount} existing user(s) into tenants-of-one`);
      }

      // Safety net: catch any desk_users that exist but somehow have no
      // member row linking them to their tenant (shouldn't happen after
      // the CTE above, but guards against partial migration states).
      const patchup = await pool.query(`
        INSERT INTO desk_members (tenant_id, user_id, role, crm_mode, active)
        SELECT t.id, t.owner_user_id, 'owner', 'team_read', TRUE
        FROM desk_tenants t
        LEFT JOIN desk_members m
               ON m.tenant_id = t.id AND m.user_id = t.owner_user_id
        WHERE m.id IS NULL
        ON CONFLICT (tenant_id, user_id) DO NOTHING;
      `);
      if (patchup.rowCount > 0) {
        console.log(`⚠ patched ${patchup.rowCount} tenant(s) missing their owner member row`);
      }

      // ── Phase 2a: add tenant_id column to every user-scoped data table ──
      // Best-effort: tables that don't exist at boot time (created lazily by
      // route handlers later) are silently skipped. migrateDataTable() can
      // also be called from those route init blocks so newly-created tables
      // pick up tenant_id without waiting for the next boot.
      const DATA_TABLES = [
        'desk_inventory', 'desk_crm', 'desk_deal_log', 'desk_lender_rates',
        'desk_scenarios', 'desk_audit',
        'lender_rate_sheets', 'lender_rate_history',
        'tenant_usage', 'tenant_spend_events',
        'customers', 'conversations', 'messages', 'appointments', 'callbacks', 'analytics',
        'bulk_messages', 'sms_opt_outs', 'voicemails', 'deals',
        'feature_events', 'setup_tokens',
      ];
      let migrated = 0;
      for (const t of DATA_TABLES) {
        const ok = await migrateDataTable(t);
        if (ok) migrated++;
      }
      console.log(`✅ tenant_id column present on ${migrated}/${DATA_TABLES.length} data tables`);

      // ── Phase 4: add assigned_rep_id to tables with per-rep ownership ──
      // Nullable INTEGER → desk_users(id). NULL = unassigned (pool).
      // Used by reps with crm_mode='pool_plus_own' to see their own +
      // unassigned leads. Managers see everything regardless.
      //
      // Not used by any route as of Phase 4 — Phase 5 migrates the CRM
      // read/write routes to filter on this column.
      const REP_OWNED_TABLES = ['desk_crm', 'conversations'];
      for (const t of REP_OWNED_TABLES) {
        try {
          const { rows } = await pool.query(
            `SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = 'public'`,
            [t]
          );
          if (!rows.length) continue;
          await pool.query(
            `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS assigned_rep_id INTEGER REFERENCES desk_users(id) ON DELETE SET NULL`
          );
          await pool.query(
            `CREATE INDEX IF NOT EXISTS idx_${t}_assigned_rep ON ${t}(assigned_rep_id)`
          );
        } catch (e) {
          console.warn(`[tenants] assigned_rep_id on ${t}:`, e.message);
        }
      }
      console.log('✅ assigned_rep_id column present on rep-owned tables');
    } catch (e) {
      console.error('❌ desk_tenants/members init:', e.message);
      throw e;
    }
  })();
  return _initPromise;
}

// ── Phase 2a helper: add + backfill tenant_id on one table ──────────────
// Idempotent. Safe to call from route init blocks after their CREATE TABLE.
// Returns true if the table exists and was processed; false if the table
// doesn't exist (typical on first boot before a lazily-created table is
// registered) or on error.
//
// Does three things:
//   1. ALTER TABLE ADD COLUMN IF NOT EXISTS tenant_id INTEGER
//      (no FK constraint — adding one after-the-fact is risky if there
//      are orphaned rows; the JOIN-based backfill below will leave those
//      with tenant_id=NULL and they'll be ignored by tenant-scoped reads)
//   2. UPDATE rows with NULL tenant_id using user_id → desk_members lookup
//   3. CREATE INDEX on tenant_id for scoped-read performance
async function migrateDataTable(tableName) {
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) return false;  // injection guard
  try {
    // Check the table exists AND has a user_id column before touching it
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'`,
      [tableName]
    );
    if (cols.length === 0) return false;  // table doesn't exist
    const hasUserId   = cols.some(c => c.column_name === 'user_id');
    const hasTenantId = cols.some(c => c.column_name === 'tenant_id');
    if (!hasUserId && !hasTenantId) return false;  // not a user-scoped table

    if (!hasTenantId) {
      await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
    }
    if (hasUserId) {
      // Backfill: join desk_members on user_id to find the tenant.
      // Only touch rows still NULL to avoid overwriting manual assignments.
      await pool.query(`
        UPDATE ${tableName} SET tenant_id = dm.tenant_id
          FROM desk_members dm
         WHERE ${tableName}.user_id = dm.user_id
           AND ${tableName}.tenant_id IS NULL
           AND dm.active = TRUE
      `);
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${tableName}_tenant ON ${tableName}(tenant_id)`);
    return true;
  } catch (e) {
    // Log at warn, don't throw — one table failing shouldn't stall init
    console.warn(`[tenants] migrateDataTable(${tableName}): ${e.message}`);
    return false;
  }
}

// Fire-and-forget init on require (same pattern as lib/spend-cap.js).
// Callers that need to wait can also call init() and await the result.
init();

// ── Read helpers ────────────────────────────────────────────────────────

// Resolve a user's primary tenant + their member role within it.
// Returns { tenantId, memberRole, crmMode, tier, seatsAllowed } or null.
//
// Multi-tenant membership is supported by the schema but Phase 1 keeps
// things simple: a user's primary tenant is the FIRST active member row
// they have (lowest member.id), preferring 'owner' if present.
async function getPrimaryMembership(userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT m.tenant_id, m.role AS member_role, m.crm_mode,
            t.tier, t.seats_allowed, t.dealership
       FROM desk_members m
       JOIN desk_tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.active = TRUE
      ORDER BY (CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END),
               m.id ASC
      LIMIT 1`,
    [userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    tenantId:     r.tenant_id,
    memberRole:   r.member_role,
    crmMode:      r.crm_mode,
    tier:         r.tier,
    seatsAllowed: r.seats_allowed,
    dealership:   r.dealership,
  };
}

// Seat usage for a tenant — used when adding new members to enforce cap.
async function getSeatUsage(tenantId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS used,
            (SELECT seats_allowed FROM desk_tenants WHERE id = $1) AS allowed
       FROM desk_members
      WHERE tenant_id = $1 AND active = TRUE`,
    [tenantId]
  );
  const r = rows[0] || { used: 0, allowed: 1 };
  return {
    used:      r.used,
    allowed:   r.allowed,
    remaining: Math.max(0, r.allowed - r.used),
  };
}

// List all active members of a tenant, in display order (owner → managers → reps).
async function listMembers(tenantId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.user_id, m.role, m.crm_mode, m.sarah_number,
            m.active, m.invited_at,
            u.email, u.display_name, u.last_login
       FROM desk_members m
       JOIN desk_users   u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.active = TRUE
      ORDER BY (CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END),
               m.invited_at ASC`,
    [tenantId]
  );
  return rows;
}

// ── Write helpers (used by admin dashboard in Phase 3) ──────────────────

// Upgrade a tenant to gold (or downgrade). seats_allowed updates to match.
async function setTenantTier(tenantId, tier) {
  if (!VALID_TIERS.includes(tier)) throw new Error('Invalid tier: ' + tier);
  const seats = tier === 'gold' ? GOLD_DEFAULT_SEATS : SINGLE_DEFAULT_SEATS;
  await pool.query(
    `UPDATE desk_tenants SET tier = $2, seats_allowed = $3 WHERE id = $1`,
    [tenantId, tier, seats]
  );
}

// Add an existing user to a tenant (doesn't create the desk_users row —
// caller is responsible for that, typically via the existing password-
// setup-link flow). Enforces the seat cap.
async function addMember(tenantId, userId, role = 'rep', crmMode = 'pool_plus_own') {
  if (!VALID_ROLES.includes(role))       throw new Error('Invalid role: ' + role);
  if (!VALID_CRM_MODES.includes(crmMode)) throw new Error('Invalid crm_mode: ' + crmMode);
  const usage = await getSeatUsage(tenantId);
  if (usage.remaining <= 0) {
    throw new Error(`Tenant has no seats remaining (${usage.used}/${usage.allowed})`);
  }
  const { rows } = await pool.query(
    `INSERT INTO desk_members (tenant_id, user_id, role, crm_mode, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (tenant_id, user_id) DO UPDATE
       SET role     = EXCLUDED.role,
           crm_mode = EXCLUDED.crm_mode,
           active   = TRUE
     RETURNING id`,
    [tenantId, userId, role, crmMode]
  );
  return rows[0];
}

// Update a member's role / crm_mode / sarah_number.
async function updateMember(memberId, patch) {
  const fields = [];
  const values = [memberId];
  if (patch.role !== undefined) {
    if (!VALID_ROLES.includes(patch.role)) throw new Error('Invalid role');
    values.push(patch.role);
    fields.push(`role = $${values.length}`);
  }
  if (patch.crmMode !== undefined) {
    if (!VALID_CRM_MODES.includes(patch.crmMode)) throw new Error('Invalid crm_mode');
    values.push(patch.crmMode);
    fields.push(`crm_mode = $${values.length}`);
  }
  if (patch.sarahNumber !== undefined) {
    values.push(patch.sarahNumber || null);
    fields.push(`sarah_number = $${values.length}`);
  }
  if (patch.active !== undefined) {
    values.push(!!patch.active);
    fields.push(`active = $${values.length}`);
  }
  if (fields.length === 0) return;
  await pool.query(
    `UPDATE desk_members SET ${fields.join(', ')} WHERE id = $1`,
    values
  );
}

// Soft-remove a member (sets active = false, preserves history).
// Does not delete the desk_users row — that's a separate operator action.
async function removeMember(memberId) {
  await pool.query(
    `UPDATE desk_members SET active = FALSE WHERE id = $1`,
    [memberId]
  );
}

module.exports = {
  init,
  migrateDataTable,
  getPrimaryMembership,
  getSeatUsage,
  listMembers,
  setTenantTier,
  addMember,
  updateMember,
  removeMember,
  VALID_TIERS,
  VALID_ROLES,
  VALID_CRM_MODES,
  GOLD_DEFAULT_SEATS,
  SINGLE_DEFAULT_SEATS,
};
