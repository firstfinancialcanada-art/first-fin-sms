// ============================================================
// add-vin-column.js — Adds VIN column to desk_inventory
// Run once: node add-vin-column.js
// ============================================================
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Check if column already exists
    const check = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'desk_inventory' AND column_name = 'vin'
    `);
    if (check.rows.length > 0) {
      console.log('ℹ️  vin column already exists — skipping');
    } else {
      await client.query('ALTER TABLE desk_inventory ADD COLUMN vin VARCHAR(20)');
      console.log('✅ Added vin column to desk_inventory');
    }
  } catch (e) {
    console.error('❌ Migration error:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
