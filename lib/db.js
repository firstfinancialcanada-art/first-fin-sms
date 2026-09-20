const { Pool } = require('pg');
const { normalizePhone } = require('./helpers');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  // One stuck query used to take the whole app with it: a hung inventory
  // sync held its client, later requests piled up behind it, the pool hit
  // its 20 and then every query — anywhere in the app — blocked forever in
  // pool.connect(). These bounds keep a single bad query local to itself.
  connectionTimeoutMillis: 10000,          // waiting for a free client
  statement_timeout: 60000,                // server-side cap per statement
  idle_in_transaction_session_timeout: 60000, // never sit on locks
});

pool.on('error', (err) => {
  console.error('⚠️ Unexpected database error:', err);
});

pool.connect()
  .then(client => { console.log('✅ Database connected'); client.release(); })
  .catch(err => console.error('❌ Database connection error:', err));

// ── desk_users.settings_json must be JSONB ───────────────────────────────
// setup-database-v2 declares it JSONB, but the live table predates that and
// is still TEXT, so every `settings_json->>'key'` threw
// "operator does not exist: text ->> unknown". That silently broke the lead
// notification fan-out (lib/notify.js picks the managers to text out of
// this column) and the tenant branding migration — both failing at boot
// with nothing but a one-line error to show for it.
//
// Runs here because lib/db is required before any route module, so the
// column is the right type before anything queries it. Rows that aren't
// valid JSON objects become '{}' rather than failing the migration.
//
// Exported as a promise, not fire-and-forget: being required first only
// guarantees this STARTS first, not that it FINISHES first. lib/notify
// calls init() at require time and its backfill reads
// settings_json->>'notifyPhone', so it races this conversion — boot logs
// on 2026-09-19 still showed "notify init: operator does not exist:
// text ->> unknown" long after the migration itself had landed, meaning
// that boot's backfill lost the race and did nothing. It evidently wins
// on other boots, so the damage is a backfill that runs or doesn't
// depending on timing, which is worse than one that never runs: you
// can't tell from the outside which happened. Anything that reads
// settings_json at boot must await this.
const migrationsReady = (async () => {
  try {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'desk_users' AND column_name = 'settings_json'`
    );
    if (!rows.length || rows[0].data_type === 'jsonb') return;
    // The column carries a text default ('{}'), and Postgres refuses to
    // cast a default automatically — "default for column settings_json
    // cannot be cast automatically to type jsonb". Drop it, convert, then
    // put it back as jsonb.
    await pool.query(`ALTER TABLE desk_users ALTER COLUMN settings_json DROP DEFAULT`);
    await pool.query(`
      ALTER TABLE desk_users
        ALTER COLUMN settings_json TYPE JSONB
        USING CASE
          WHEN settings_json IS NULL OR btrim(settings_json) = '' THEN '{}'::jsonb
          WHEN btrim(settings_json) LIKE '{%' THEN settings_json::jsonb
          ELSE '{}'::jsonb
        END
    `);
    await pool.query(`ALTER TABLE desk_users ALTER COLUMN settings_json SET DEFAULT '{}'::jsonb`);
    console.log('✅ desk_users.settings_json migrated TEXT → JSONB');
  } catch (e) {
    console.error('❌ settings_json JSONB migration:', e.message);
  }
})();

// ── Get or create customer ────────────────────────────────────────
async function getOrCreateCustomer(phone, userId) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM customers WHERE phone = $1 AND user_id = $2',
      [phone, userId]
    );
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO customers (phone, user_id) VALUES ($1, $2) RETURNING *',
        [phone, userId]
      );
      console.log('📝 New customer created:', phone);
    }
    return result.rows[0];
  } finally {
    client.release();
  }
}

// ── Get or create active conversation ────────────────────────────
async function getOrCreateConversation(phone, userId) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 1',
      [phone, userId]
    );
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO conversations (customer_phone, user_id) VALUES ($1, $2) RETURNING *',
        [phone, userId]
      );
      console.log('💬 New conversation started:', phone);
    } else {
      const conv = result.rows[0];
      if (conv.status === 'stopped') {
        // DO NOT auto-reactivate stopped conversations — CASL compliance
        // They must be reactivated by dealer action or customer replying START
        await client.query(
          'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [conv.id]
        );
        console.log('💬 Stopped conversation updated (not reactivated):', phone);
      } else {
        await client.query(
          'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [conv.id]
        );
        console.log('💬 Continuing conversation:', phone);
      }
    }
    return result.rows[0];
  } finally {
    client.release();
  }
}

// ── Update conversation data ──────────────────────────────────────
async function updateConversation(conversationId, updates) {
  const ALLOWED_FIELDS = new Set([
    'status', 'stage', 'vehicle_type', 'budget', 'budget_amount',
    'customer_name', 'intent', 'datetime', 'updated_at',
    // Phase 7 — Sarah modes + acquisition + trade-in fields
    'mode', 'vehicle_detail',
    'vehicle_make', 'vehicle_model', 'vehicle_year', 'vehicle_mileage',
    'vehicle_condition', 'asking_price', 'replacement_interest',
    'trade_in_make', 'trade_in_model', 'trade_in_year', 'trade_in_value'
  ]);
  const client = await pool.connect();
  try {
    const fields = [];
    const values = [];
    let paramCount = 1;
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_FIELDS.has(key)) {
        console.warn(`⚠️ updateConversation: ignored unknown field "${key}"`);
        continue;
      }
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
    if (fields.length === 0) return;
    values.push(conversationId);
    await client.query(
      `UPDATE conversations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount}`,
      values
    );
  } finally {
    client.release();
  }
}

// ── Check for duplicate messages ─────────────────────────────────
async function messageExists(conversationId, role, content) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id FROM messages 
       WHERE conversation_id = $1 
       AND role = $2 
       AND content = $3 
       AND created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`,
      [conversationId, role, content]
    );
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

// ── Save message to database ──────────────────────────────────────
async function saveMessage(conversationId, phone, role, content, userId) {
  const isDuplicate = await messageExists(conversationId, role, content);
  if (isDuplicate) {
    console.log('⚠️ Duplicate message prevented:', content.substring(0, 50) + '...');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO messages (conversation_id, customer_phone, role, content, user_id) VALUES ($1, $2, $3, $4, $5)',
      [conversationId, phone, role, content, userId || null]
    );
  } finally {
    client.release();
  }
}

// ── Check if customer has any conversation ────────────────────────
async function hasActiveConversation(phone, userId) {
  const client = await pool.connect();
  try {
    const result = userId
      ? await client.query(
          'SELECT id FROM conversations WHERE customer_phone = $1 AND user_id = $2 LIMIT 1',
          [phone, userId]
        )
      : await client.query(
          'SELECT id FROM conversations WHERE customer_phone = $1 LIMIT 1',
          [phone]
        );
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

// ── Delete conversation ───────────────────────────────────────────
// Transactional: all four child tables + conversations deleted atomically.
// On any failure, entire operation rolls back to avoid orphan rows.
async function deleteConversation(phone, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversations = userId
      ? await client.query(
          'SELECT id FROM conversations WHERE customer_phone = $1 AND user_id = $2',
          [phone, userId]
        )
      : await client.query(
          'SELECT id FROM conversations WHERE customer_phone = $1',
          [phone]
        );
    if (conversations.rows.length > 0) {
      const ids = conversations.rows.map(r => r.id);
      await client.query('DELETE FROM messages WHERE conversation_id = ANY($1)', [ids]);
      if (userId) {
        await client.query('DELETE FROM appointments WHERE customer_phone = $1 AND user_id = $2', [phone, userId]);
        await client.query('DELETE FROM callbacks WHERE customer_phone = $1 AND user_id = $2', [phone, userId]);
        await client.query('DELETE FROM conversations WHERE customer_phone = $1 AND user_id = $2', [phone, userId]);
      } else {
        await client.query('DELETE FROM appointments WHERE customer_phone = $1', [phone]);
        await client.query('DELETE FROM callbacks WHERE customer_phone = $1', [phone]);
        await client.query('DELETE FROM conversations WHERE customer_phone = $1', [phone]);
      }
      await client.query('COMMIT');
      console.log(`🗑️ Deleted ${conversations.rows.length} conversation(s) for:`, phone);
      return true;
    }
    await client.query('COMMIT');
    return false;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Save appointment ──────────────────────────────────────────────
async function saveAppointment(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO appointments (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime, data.userId || null]
    );
    console.log('🚗 Appointment saved:', data.name);
  } finally {
    client.release();
  }
}

// ── Save callback ─────────────────────────────────────────────────
async function saveCallback(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO callbacks (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime, data.userId || null]
    );
    console.log('📞 Callback saved:', data.name);
  } finally {
    client.release();
  }
}

// ── Log analytics event ───────────────────────────────────────────
async function logAnalytics(eventType, phone, data, userId) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO analytics (event_type, customer_phone, data, user_id) VALUES ($1, $2, $3, $4)',
      [eventType, phone, JSON.stringify(data), userId || null]
    );
  } catch(e) {
    console.error('Analytics log error:', e.message);
  } finally {
    client.release();
  }
}

// ── Global opt-out (CASL/TCPA compliance) ────────────────────────
async function createOptOutTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sms_opt_outs (
        phone VARCHAR(20) PRIMARY KEY,
        opted_out_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        source VARCHAR(50) DEFAULT 'sms_stop'
      )
    `);
    console.log('✅ sms_opt_outs table ready');
  } catch (e) {
    console.error('❌ sms_opt_outs table error:', e.message);
  } finally {
    client.release();
  }
}

// Opt-out rows are written from inbound STOP messages, where Twilio always
// hands us E.164. Campaign contacts arrive from CSVs, the CRM and the API in
// whatever shape the source used them in. An exact string compare made
// "+15875550000" and "5875550000" two different people, so someone who had
// already texted STOP could be let straight back into a campaign — a CASL
// problem, and a billed message either way. Compare against every equivalent
// form of the number instead of trusting the caller's formatting.
function phoneKeys(phone) {
  const raw = String(phone == null ? '' : phone).trim();
  const keys = new Set();
  if (raw) keys.add(raw);
  const e164 = normalizePhone(raw);
  if (e164) {
    keys.add(e164);            // +15875550000
    keys.add(e164.slice(1));   //  15875550000
    keys.add(e164.slice(2));   //   5875550000
  }
  return [...keys];
}

async function addOptOut(phone, source = 'sms_stop') {
  try {
    // Store the canonical form so new rows are consistent; lookups still
    // match the legacy shapes already in the table via phoneKeys().
    const canonical = normalizePhone(phone) || String(phone || '').trim();
    if (!canonical) return;
    await pool.query(
      `INSERT INTO sms_opt_outs (phone, source) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
      [canonical, source]
    );
  } catch (e) {
    console.error('❌ addOptOut error:', e.message);
  }
}

async function removeOptOut(phone) {
  try {
    const keys = phoneKeys(phone);
    if (!keys.length) return;
    await pool.query('DELETE FROM sms_opt_outs WHERE phone = ANY($1)', [keys]);
  } catch (e) {
    console.error('❌ removeOptOut error:', e.message);
  }
}

async function isOptedOut(phone) {
  try {
    const keys = phoneKeys(phone);
    if (!keys.length) return false;
    const r = await pool.query('SELECT 1 FROM sms_opt_outs WHERE phone = ANY($1) LIMIT 1', [keys]);
    return r.rows.length > 0;
  } catch { return false; }
}

// Returns the subset of `phones` that are opted out, keyed by the exact
// strings the caller passed in — callers do optedOutSet.has(contact.phone).
async function filterOptedOut(phones) {
  if (!phones.length) return new Set();
  try {
    const keysByInput = phones.map(p => ({ input: p, keys: phoneKeys(p) }));
    const allKeys = [...new Set(keysByInput.flatMap(k => k.keys))];
    if (!allKeys.length) return new Set();
    const r = await pool.query('SELECT phone FROM sms_opt_outs WHERE phone = ANY($1)', [allKeys]);
    const hit = new Set(r.rows.map(row => row.phone));
    return new Set(keysByInput.filter(k => k.keys.some(x => hit.has(x))).map(k => k.input));
  } catch { return new Set(); }
}

module.exports = {
  pool,
  migrationsReady,
  phoneKeys,
  getOrCreateCustomer,
  getOrCreateConversation,
  updateConversation,
  messageExists,
  saveMessage,
  hasActiveConversation,
  deleteConversation,
  saveAppointment,
  saveCallback,
  logAnalytics,
  createOptOutTable,
  addOptOut,
  removeOptOut,
  isOptedOut,
  filterOptedOut
};

