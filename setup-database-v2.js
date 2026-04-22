// ============================================================
// FIRST-FIN Phase 1 — Database Migration v2
// Adds auth + desk tables alongside existing SARAH tables
// Safe to run multiple times (IF NOT EXISTS everywhere)
// Usage: node setup-database-v2.js
// ============================================================
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  const client = await pool.connect();
  try {
    console.log('🔧 Phase 1 Migration — Adding auth + desk tables...\n');

    // ── 1. USERS (auth) ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'owner',
        settings_json JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      );
    `);
    console.log('✅ desk_users table');

    // ── 2. REFRESH TOKENS ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES desk_users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_drt_user ON desk_refresh_tokens(user_id);
    `);
    console.log('✅ desk_refresh_tokens table');

    // ── 2b. TENANTS + MEMBERS (multi-user Phase 1 foundation) ──
    // desk_tenants: one per paying account. desk_members: links
    // users to tenants with role. Single-user accounts become
    // tenant-of-one via lib/tenants.js backfill at runtime boot.
    await client.query(`
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
    console.log('✅ desk_tenants + desk_members tables');

    // ── 3. INVENTORY (replaces hardcoded array in HTML) ────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_inventory (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES desk_users(id),
        stock VARCHAR(50) NOT NULL,
        year INTEGER,
        make VARCHAR(100),
        model VARCHAR(100),
        mileage INTEGER,
        price NUMERIC(12,2),
        book_value NUMERIC(12,2),
        condition VARCHAR(50) DEFAULT 'Average',
        carfax NUMERIC(10,2) DEFAULT 0,
        type VARCHAR(200),
        vin VARCHAR(20),
        color VARCHAR(50),
        trim VARCHAR(100),
        cost NUMERIC(12,2),
        status VARCHAR(20) DEFAULT 'available',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, stock)
      );
      CREATE INDEX IF NOT EXISTS idx_dinv_status ON desk_inventory(status);
      CREATE INDEX IF NOT EXISTS idx_dinv_user_stock ON desk_inventory(user_id, stock);
    `);
    console.log('✅ desk_inventory table');

    // ── 3b. FB POSTER COLUMNS (additive migration) ────────────
    await client.query(`
      ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS fb_status VARCHAR(20) DEFAULT 'pending';
      ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS fb_posted_date DATE;
      ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]';
    `);
    console.log('✅ desk_inventory fb_status + fb_posted_date + photos columns');

    // ── 4. CRM (replaces ffCRM localStorage) ───────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_crm (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES desk_users(id),
        name VARCHAR(255),
        phone VARCHAR(30),
        email VARCHAR(255),
        beacon INTEGER,
        income NUMERIC(12,2),
        obligations NUMERIC(12,2),
        status VARCHAR(50) DEFAULT 'Lead',
        source VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_dcrm_user ON desk_crm(user_id);
      CREATE INDEX IF NOT EXISTS idx_dcrm_phone ON desk_crm(phone);
    `);
    console.log('✅ desk_crm table');

    // Safe CRM column migrations
    await client.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS vehicle_interest VARCHAR(100)`).catch(() => {});
    await client.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS budget_range VARCHAR(50)`).catch(() => {});
    await client.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS follow_up_date DATE`).catch(() => {});
    await client.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS follow_up_note VARCHAR(255)`).catch(() => {});
    await client.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS last_contact TIMESTAMP`).catch(() => {});
    console.log('✅ desk_crm columns updated');

    // ── 5. DEAL LOG (replaces ffDealLog localStorage) ──────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_deal_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES desk_users(id),
        deal_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ddl_user ON desk_deal_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_ddl_created ON desk_deal_log(created_at DESC);
    `);
    console.log('✅ desk_deal_log table');

    // ── 6. LENDER RATE OVERRIDES (replaces ffLenderRates) ──────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_lender_rates (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES desk_users(id),
        overrides_json JSONB DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ desk_lender_rates table');

    // ── 7. SAVE SLOTS / SCENARIOS (replaces ffScenarios) ───────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_scenarios (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES desk_users(id),
        slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
        deal_data JSONB,
        label VARCHAR(255),
        saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, slot)
      );
    `);
    console.log('✅ desk_scenarios table');

    // ── 8. AUDIT LOG ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_audit (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES desk_users(id),
        action VARCHAR(100) NOT NULL,
        entity VARCHAR(50),
        entity_id INTEGER,
        detail JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_daudit_user ON desk_audit(user_id, created_at DESC);
    `);
    console.log('✅ desk_audit table');

    // ── 9. LENDER RATE HISTORY (versioning) ──────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lender_rate_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES desk_users(id),
        lender_name VARCHAR(100) NOT NULL,
        rates_json JSONB NOT NULL,
        replaced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ lender_rate_history table');

    // ── 10. ADMIN AUDIT LOG ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        admin_email VARCHAR(255),
        action VARCHAR(100) NOT NULL,
        target_type VARCHAR(50),
        target_id INTEGER,
        details JSONB,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(created_at DESC);
    `);
    console.log('✅ admin_audit_log table');

    // ── Safe migrations: deal_outcomes missing columns ─────────
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS approved_rate NUMERIC(5,2)`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS approved_term INTEGER`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS approved_amount NUMERIC(12,2)`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS stipulations TEXT`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS decline_reasons TEXT`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS conditions TEXT`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS stock VARCHAR(50)`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS vehicle_price NUMERIC(12,2)`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS book_value NUMERIC(12,2)`).catch(() => {});
    await client.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS amount_to_finance NUMERIC(12,2)`).catch(() => {});
    console.log('✅ deal_outcomes columns updated');

    // ── Safe migrations: soft delete + RBAC ────────────────────
    await client.query(`ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`).catch(() => {});
    await client.query(`ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS admin_role VARCHAR(20)`).catch(() => {});
    console.log('✅ desk_users soft delete + RBAC columns');

    // ── Safe migrations: analytics (conversations) ─────────────
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source VARCHAR(100)`).catch(() => {});
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS stop_reason VARCHAR(100)`).catch(() => {});
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 0`).catch(() => {});
    console.log('✅ conversations analytics columns');

    // ── Performance indexes for scale ──────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_desk_crm_user_phone ON desk_crm(user_id, phone)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bulk_user_status ON bulk_messages(user_id, status, scheduled_at) WHERE status = 'pending'`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deal_outcomes_user ON deal_outcomes(user_id, created_at DESC)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_desk_inventory_user ON desk_inventory(user_id, stock)`).catch(() => {});
    console.log('✅ performance indexes ready');

    console.log('\n🎉 Phase 1 + Phase 2 migration complete!');
    console.log('ℹ️  Your existing SARAH tables are untouched.');
    console.log('ℹ️  Run: node seed-inventory.js  to load your inventory into the DB.\n');

  } catch (error) {
    console.error('❌ Migration error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
