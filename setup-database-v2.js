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

    // ── 3. INVENTORY (replaces hardcoded array in HTML) ────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS desk_inventory (
        id SERIAL PRIMARY KEY,
        stock VARCHAR(50) UNIQUE NOT NULL,
        year INTEGER,
        make VARCHAR(100),
        model VARCHAR(100),
        mileage INTEGER,
        price NUMERIC(12,2),
        condition VARCHAR(50) DEFAULT 'Average',
        carfax NUMERIC(10,2) DEFAULT 0,
        type VARCHAR(200),
        vin VARCHAR(20),
        status VARCHAR(20) DEFAULT 'available',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_dinv_stock ON desk_inventory(stock);
      CREATE INDEX IF NOT EXISTS idx_dinv_status ON desk_inventory(status);
    `);
    console.log('✅ desk_inventory table');

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

    console.log('\n🎉 Phase 1 migration complete!');
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
