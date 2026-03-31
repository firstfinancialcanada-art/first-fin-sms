const { Pool } = require('pg');

// PUT YOUR NEW PASSWORD HERE (the hex string you generated)
const NEW_PASSWORD = '53bb14cabdbead4fca4db6ff8768ac07dab3b9541f51198e';

const p = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const c = await p.connect();
  try {
    await c.query("ALTER USER postgres PASSWORD '" + NEW_PASSWORD + "'");
    console.log('✅ Postgres password changed to:', NEW_PASSWORD);
    console.log('Now update PGPASSWORD in Railway to match.');
  } catch(e) {
    console.error('❌ Failed:', e.message);
  } finally {
    c.release();
    await p.end();
  }
})();
