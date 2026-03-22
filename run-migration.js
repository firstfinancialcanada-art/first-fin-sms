// ============================================================
// run-migration.js — Execute SQL migration files
// Usage: node run-migration.js
// Or with public URL: DATABASE_PUBLIC_URL=... node run-migration.js
// ============================================================
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const connStr = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connStr) {
  console.error('❌ No DATABASE_URL or DATABASE_PUBLIC_URL set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const migrationFile = path.join(__dirname, 'migrations', '002-pre-launch-multitenant.sql');
  const sql = fs.readFileSync(migrationFile, 'utf8');

  console.log('🔧 Running pre-launch migration...\n');

  const client = await pool.connect();
  try {
    // Split on semicolons but respect DO $$ blocks
    // Run as a single statement since DO blocks contain semicolons
    await client.query(sql);
    console.log('✅ Migration complete!');
  } catch (e) {
    console.error('❌ Migration error:', e.message);
    console.error('   Detail:', e.detail || '(none)');
    console.error('\n   You may need to run individual statements manually.');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
