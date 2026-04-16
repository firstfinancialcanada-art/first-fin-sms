const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20
});

pool.on('error', (err) => {
  console.error('⚠️ Unexpected database error:', err);
});

pool.connect()
  .then(client => { console.log('✅ Database connected'); client.release(); })
  .catch(err => console.error('❌ Database connection error:', err));

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
    'customer_name', 'intent', 'datetime', 'updated_at'
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

async function addOptOut(phone, source = 'sms_stop') {
  try {
    await pool.query(
      `INSERT INTO sms_opt_outs (phone, source) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
      [phone, source]
    );
  } catch (e) {
    console.error('❌ addOptOut error:', e.message);
  }
}

async function removeOptOut(phone) {
  try {
    await pool.query('DELETE FROM sms_opt_outs WHERE phone = $1', [phone]);
  } catch (e) {
    console.error('❌ removeOptOut error:', e.message);
  }
}

async function isOptedOut(phone) {
  try {
    const r = await pool.query('SELECT 1 FROM sms_opt_outs WHERE phone = $1', [phone]);
    return r.rows.length > 0;
  } catch { return false; }
}

async function filterOptedOut(phones) {
  if (!phones.length) return new Set();
  try {
    const r = await pool.query('SELECT phone FROM sms_opt_outs WHERE phone = ANY($1)', [phones]);
    return new Set(r.rows.map(row => row.phone));
  } catch { return new Set(); }
}

module.exports = {
  pool,
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

