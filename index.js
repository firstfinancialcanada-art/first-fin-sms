const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// Single Twilio client instance (not recreated per request)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve unified frontend
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// 🆕 FIX #6: Configurable bulk SMS processing parameters
const BULK_BATCH_SIZE = parseInt(process.env.BULK_BATCH_SIZE) || 5;
const BULK_INTERVAL_MS = parseInt(process.env.BULK_INTERVAL_MS) || 5000;

// ===== DATABASE CONNECTION =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection on startup


// ✅ Handle unexpected database errors
pool.on('error', (err) => {
  console.error('⚠️ Unexpected database error:', err);
});

// Test database connection on startup
pool.connect()
  .then(client => { console.log('✅ Database connected'); client.release(); })
  .catch(err => console.error('❌ Database connection error:', err));



// ===== EMAIL & HELPERS =====
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
});

async function sendEmailNotification(subject, htmlContent) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('⚠️  Email not configured');
    return false;
  }
  try {
    const info = await emailTransporter.sendMail({
      from: '"Sarah AI - First Financial" <' + process.env.EMAIL_USER + '>',
      to: process.env.EMAIL_TO || 'firstfinancialcanada@gmail.com',
      subject: subject,
      html: htmlContent
    });
    console.log('📧 Email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('❌ Email error:', error.message);
    return false;
  }
}

// ── Phone Utilities ──────────────────────────────────────────────────────
// Accepts: 5873066133 / 587-306-6133 / 587-3066133 / 15873066133 / +15873066133
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}
// Pretty → +1 (587) 306-6133  (Launch SMS field & message view header)
function formatPretty(input) {
  const e164 = normalizePhone(input);
  if (!e164) return String(input || '');
  const ten = e164.slice(2);
  return '+1 (' + ten.slice(0,3) + ') ' + ten.slice(3,6) + '-' + ten.slice(6);
}
// E.164 compact → +15873066133  (Recent Conversations list)
function formatE164Display(input) {
  return normalizePhone(input) || String(input || '');
}
// Legacy aliases kept for any server-side route references
function formatPhone(phone) { return formatPretty(phone); }
function toE164NorthAmerica(input) { return normalizePhone(input) || ''; }

// 🆕 FIX #7: Standardized API response helpers
function errorResponse(message) {
  return { success: false, error: message };
}

function successResponse(data = {}) {
  return { success: true, ...data };
}

// ===== DATABASE HELPER FUNCTIONS =====

// Get or create customer
async function getOrCreateCustomer(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM customers WHERE phone = $1',
      [phone]
    );
    
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO customers (phone) VALUES ($1) RETURNING *',
        [phone]
      );
      console.log('📝 New customer created:', phone);
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Get or create active conversation
async function getOrCreateConversation(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 AND status = $2 ORDER BY started_at DESC LIMIT 1',
      [phone, 'active']
    );
    
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO conversations (customer_phone) VALUES ($1) RETURNING *',
        [phone]
      );
      console.log('💬 New conversation started:', phone);
    } else {
      await client.query(
        'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [result.rows[0].id]
      );
      console.log('💬 Continuing conversation:', phone);
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Update conversation data
async function updateConversation(conversationId, updates) {
  // Whitelist allowed column names to prevent SQL injection
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

// Update conversation timestamp
async function touchConversation(conversationId) {
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [conversationId]
    );
  } finally {
    client.release();
  }
}

// Check if customer already has an active conversation
async function hasActiveConversation(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id FROM conversations WHERE customer_phone = $1 AND status = $2 LIMIT 1',
      [phone, 'active']
    );
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

// Delete conversation and its messages
async function deleteConversation(phone) {
  const client = await pool.connect();
  try {
    const conversation = await client.query(
      'SELECT id FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
      [phone]
    );

    if (conversation.rows.length > 0) {
      const conversationId = conversation.rows[0].id;

      // Delete from all related tables
      await client.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
      await client.query('DELETE FROM appointments WHERE customer_phone = $1', [phone]);
      await client.query('DELETE FROM callbacks WHERE customer_phone = $1', [phone]);
      await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);

      console.log('🗑️ Conversation deleted (with appointments & callbacks):', phone);
      return true;
    }

    return false;
  } finally {
    client.release();
  }
}

// 🆕 FIX #9: Check for duplicate messages (prevents duplicate messages after conversion)
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

// Save message to database (with duplicate prevention)
async function saveMessage(conversationId, phone, role, content) {
  // 🆕 FIX #9: Check for duplicate before saving
  const isDuplicate = await messageExists(conversationId, role, content);
  if (isDuplicate) {
    console.log('⚠️ Duplicate message prevented:', content.substring(0, 50) + '...');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO messages (conversation_id, customer_phone, role, content) VALUES ($1, $2, $3, $4)',
      [conversationId, phone, role, content]
    );
  } finally {
    client.release();
  }
}

// Save appointment
async function saveAppointment(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO appointments (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('🚗 Appointment saved:', data.name);
  } finally {
    client.release();
  }
}

// Save callback
async function saveCallback(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO callbacks (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('📞 Callback saved:', data.name);
  } finally {
    client.release();
  }
}

// Log analytics event
async function logAnalytics(eventType, phone, data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO analytics (event_type, customer_phone, data) VALUES ($1, $2, $3)',
      [eventType, phone, JSON.stringify(data)]
    );
  } finally {
    client.release();
  }
}


// ===== BULK SMS =====

async function createBulkMessagesTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bulk_messages (
        id SERIAL PRIMARY KEY,
        campaign_name VARCHAR(255),
        message_template TEXT NOT NULL,
        recipient_name VARCHAR(255) NOT NULL,
        recipient_phone VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        error_message TEXT,
        scheduled_at TIMESTAMP,
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 🆕 FIX #8: Performance index for bulk message queries (10-100x speedup)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bulk_messages_processing 
      ON bulk_messages(status, scheduled_at) 
      WHERE status = 'pending'
    `);

    console.log('✅ bulk_messages table ready');
    console.log('✅ bulk_messages performance index ready');
  } catch (error) {
    console.error('❌ bulk_messages table error:', error);
  } finally {
    client.release();
  }
}

createBulkMessagesTable();

async function saveBulkCampaign(campaignName, messageTemplate, contacts) {
  const client = await pool.connect();
  try {
    const startTime = new Date(Date.now() + 60000);
    const scheduledTimes = contacts.map((_, i) => 
      new Date(startTime.getTime() + (i * 15000))
    );

    // Batch INSERT - single query instead of N queries (10-50x faster)
    if (contacts.length === 0) return [];
    const valuePlaceholders = contacts.map((_, i) => 
      `($${i*5+1}, $${i*5+2}, $${i*5+3}, $${i*5+4}, $${i*5+5})`
    ).join(', ');
    const flatValues = contacts.flatMap((contact, i) => [
      campaignName, messageTemplate, contact.name, contact.phone, scheduledTimes[i]
    ]);
    const result = await client.query(
      `INSERT INTO bulk_messages (campaign_name, message_template, recipient_name, recipient_phone, scheduled_at) VALUES ${valuePlaceholders} RETURNING id`,
      flatValues
    );
    return result.rows.map(r => r.id);
  } finally {
    client.release();
  }
}

async function getPendingBulkMessages(limit = BULK_BATCH_SIZE) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM bulk_messages WHERE status = $1 AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT $2',
      ['pending', limit]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

async function updateBulkMessageStatus(messageId, status, errorMessage = null) {
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE bulk_messages SET status = $1, error_message = $2, sent_at = CASE WHEN $1 = $3 THEN NOW() ELSE sent_at END WHERE id = $4',
      [status, errorMessage, 'sent', messageId]
    );
  } finally {
    client.release();
  }
}

async function getBulkCampaignStats(campaignName) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT COUNT(*) as total, COUNT(CASE WHEN status = $1 THEN 1 END) as sent, COUNT(CASE WHEN status = $2 THEN 1 END) as pending, COUNT(CASE WHEN status = $3 THEN 1 END) as failed FROM bulk_messages WHERE campaign_name = $4',
      ['sent', 'pending', 'failed', campaignName]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

let bulkSmsProcessor = null;
let bulkSmsProcessorPaused = false;

async function processBulkMessages() {
  
  if (bulkSmsProcessorPaused) {
    console.log('⏸️  Paused');
    return;
  }

  try {
    const pendingMessages = await getPendingBulkMessages(BULK_BATCH_SIZE);
    if (pendingMessages.length === 0) return;

    for (const message of pendingMessages) {
      try {

      // 🚨 BLOCK SPAMMER +12899688778
      if (message.recipient_phone.includes('2899688778') || 
          message.recipient_phone.includes('12899688778')) {
        await updateBulkMessageStatus(message.id, 'blocked', 'Blacklisted number');
        console.log('🚫 BLOCKED SPAMMER:', message.recipient_phone);
        continue;
      }

        const personalizedMessage = message.message_template.replace(/{name}/g, message.recipient_name);
        await twilioClient.messages.create({
          body: personalizedMessage,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: message.recipient_phone
        });

        const conversation = await getOrCreateConversation(message.recipient_phone);
        if (message.recipient_name && !conversation.customer_name) {
          await updateConversation(conversation.id, { customer_name: message.recipient_name });
        }
        await saveMessage(conversation.id, message.recipient_phone, 'assistant', personalizedMessage);
        await updateBulkMessageStatus(message.id, 'sent');

        console.log(`✅ Bulk SMS sent to ${message.recipient_name}`);

      } catch (error) {
        console.error(`❌ Bulk SMS failed for ${message.recipient_name}:`, error.message);
        await updateBulkMessageStatus(message.id, 'failed', error.message);
      }
    }
  } catch (error) {
    console.error('❌ Bulk processor error:', error);
  }
}

function startBulkProcessor() {
  if (bulkSmsProcessor) return;
  console.log('🚀 Bulk SMS processor started');
  console.log(`⚙️  Batch size: ${BULK_BATCH_SIZE}, Interval: ${BULK_INTERVAL_MS}ms`);
  processBulkMessages();
  bulkSmsProcessor = setInterval(processBulkMessages, BULK_INTERVAL_MS);
}
startBulkProcessor();


// 🚨 EMERGENCY STOP +12899688778 - BLOCKS ALL VARIANTS
app.get('/api/stop-12899688778', async (req, res) => {
  // 🔒 Admin auth check
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }
  const BLOCKED_NUMBERS = ['+12899688778', '12899688778', '2899688778'];
  const client = await pool.connect();
  try {
    let totalBulkDeleted = 0;
    let totalConvStopped = 0;
    let totalApptDeleted = 0;
    let totalCallDeleted = 0;

    // Delete ALL bulk messages with ANY format of this number
    for (const num of BLOCKED_NUMBERS) {
      const bulkResult = await client.query(
        'DELETE FROM bulk_messages WHERE recipient_phone LIKE $1',
        ['%' + num + '%']
      );
      totalBulkDeleted += bulkResult.rowCount;

      // Stop conversations
      const convResult = await client.query(
        "UPDATE conversations SET status = 'stopped' WHERE customer_phone LIKE $1",
        ['%' + num + '%']
      );
      totalConvStopped += convResult.rowCount;

      // Delete appointments
      const apptResult = await client.query(
        'DELETE FROM appointments WHERE customer_phone LIKE $1',
        ['%' + num + '%']
      );
      totalApptDeleted += apptResult.rowCount;

      // Delete callbacks
      const callResult = await client.query(
        'DELETE FROM callbacks WHERE customer_phone LIKE $1',
        ['%' + num + '%']
      );
      totalCallDeleted += callResult.rowCount;
    }

    console.log(`🚨 STOPPED +12899688778 - Bulk: ${totalBulkDeleted}, Conv: ${totalConvStopped}, Appt: ${totalApptDeleted}, Call: ${totalCallDeleted}`);

    res.json({
      success: true,
      blocked: '+12899688778',
      bulkDeleted: totalBulkDeleted,
      conversationsStopped: totalConvStopped,
      appointmentsDeleted: totalApptDeleted,
      callbacksDeleted: totalCallDeleted,
      message: '🚨 +12899688778 PERMANENTLY STOPPED & BLOCKED'
    });
  } catch (error) {
    console.error('Stop error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 🧹 WIPE ALL BULK MESSAGES (use once to clear old CSV data)
app.get('/api/wipe-bulk', async (req, res) => {
  const client = await pool.connect();
  // 🔒 Admin auth check
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }

  try {
    const result = await client.query('DELETE FROM bulk_messages');
    console.log(`🧹 WIPED ${result.rowCount} bulk messages`);
    res.json({ 
      success: true, 
      wiped: result.rowCount,
      message: 'Bulk table cleared! Ready for fresh upload.'
    });
  } catch (error) {
    console.error('Wipe error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/bulk-sms/pause', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }
  try {
    bulkSmsProcessorPaused = true;
    res.json({ success: true, paused: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/bulk-sms/resume', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }
  try {
    bulkSmsProcessorPaused = false;
    res.json({ success: true, paused: false });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});



// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Sarah AI Backend LIVE - Database Edition',
    database: '✅ PostgreSQL Connected',
    endpoints: {
      startSms: '/api/start-sms',
      webhook: '/api/sms-webhook',
      dashboard: '/dashboard',
      apiDashboard: '/api/dashboard',
      conversations: '/api/conversations',
      conversation: '/api/conversation/:phone',
      deleteConversation: 'DELETE /api/conversation/:phone',
      manualReply: 'POST /api/manual-reply', testEmail: '/test-email', exportAppointments: '/api/export/appointments', exportCallbacks: '/api/export/callbacks', exportConversations: '/api/export/conversations', exportAnalytics: '/api/export/analytics'
    },
    timestamp: new Date()
  });
});


// EMERGENCY STOP - ALL BULK MESSAGES
app.get('/api/stop-bulk', async (req, res) => {
  const client = await pool.connect();
  // 🔒 Admin auth check
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }

  try {
    const result = await client.query(
      `UPDATE bulk_messages SET status = 'cancelled', error_message = 'Emergency stop by user' 
       WHERE status = 'pending'`
    );

    const cancelled = result.rowCount;
    console.log(`🚨 EMERGENCY STOP: ${cancelled} messages cancelled`);

    res.json({
      success: true,
      cancelled: cancelled,
      message: `Emergency stop: ${cancelled} pending messages cancelled`
    });
  } catch (error) {
    console.error('Emergency stop error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// Interactive HTML Dashboard
app.get('/dashboard', (req, res) => {
  // Redirect old dashboard URL to new unified platform
  res.redirect('/');
})
});

// API: Dashboard stats
app.get('/api/dashboard', async (req, res) => {
  const client = await pool.connect();
  try {
    const customers = await client.query('SELECT COUNT(*) as count FROM customers');
    const conversations = await client.query('SELECT COUNT(*) as count FROM conversations');
    const messages = await client.query('SELECT COUNT(*) as count FROM messages');
    const appointments = await client.query('SELECT * FROM appointments ORDER BY created_at DESC LIMIT 25');
    const callbacks = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC LIMIT 25');
    
    res.json({
      stats: {
        totalCustomers: parseInt(customers.rows[0].count),
        totalConversations: parseInt(conversations.rows[0].count),
        totalMessages: parseInt(messages.rows[0].count),
        totalAppointments: appointments.rows.length,
        totalCallbacks: callbacks.rows.length
      },
      recentAppointments: appointments.rows,
      recentCallbacks: callbacks.rows
    });
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Get all conversations
app.get('/api/conversations', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        c.id,
        c.customer_phone,
        cu.name as customer_name,
        c.stage,
        c.status,
        c.vehicle_type,
        c.budget,
        c.started_at,
        c.updated_at,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
      FROM conversations c
      LEFT JOIN customers cu ON c.customer_phone = cu.phone
      ORDER BY c.updated_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Get conversation history
app.get('/api/conversation/:phone', async (req, res) => {
  const client = await pool.connect();
  try {
    const { phone } = req.params;
    
    const conversation = await client.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
      [phone]
    );
    
    if (conversation.rows.length === 0) {
      return res.json({ error: 'No conversation found' });
    }
    
    const messages = await client.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversation.rows[0].id]
    );
    
    res.json({
      conversation: conversation.rows[0],
      messages: messages.rows
    });
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Delete conversation
app.delete('/api/conversation/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const deleted = await deleteConversation(phone);
    
    if (deleted) {
      res.json({ success: true, message: 'Conversation deleted' });
    } else {
      res.json({ success: false, error: 'Conversation not found' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});
// API Delete individual appointment
app.delete('/api/appointment/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('DELETE FROM appointments WHERE id = $1', [id]);
    console.log('✅ Appointment deleted:', id);
    res.json({ success: true, message: 'Appointment deleted' });
  } catch (error) {
    console.error('Error deleting appointment:', error);
    res.json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// API Delete individual callback
app.delete('/api/callback/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('DELETE FROM callbacks WHERE id = $1', [id]);
    console.log('✅ Callback deleted:', id);
    res.json({ success: true, message: 'Callback deleted' });
  } catch (error) {
    console.error('Error deleting callback:', error);
    res.json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// API: Manual reply (NEW)
app.post('/api/manual-reply', async (req, res) => {
  // 🔒 Admin auth check
  const token = req.body.token || req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.json({ success: false, error: 'Phone and message required' });
    }
    
    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'assistant', message);
    await logAnalytics('manual_reply_sent', phone, { message });
    
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });
    
    console.log('✅ Manual reply sent to:', phone);
    res.json({ success: true, message: 'Reply sent!' });
  } catch (error) {
    console.error('❌ Error sending manual reply:', error);
    res.json({ success: false, error: error.message });
  }
});

// Start SMS campaign
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone) {
      return res.json({ success: false, error: 'Phone number required' });
    }

    const normalizedPhone = toE164NorthAmerica(phone);
    if (!normalizedPhone) {
      return res.json({ success: false, error: 'Invalid phone number format' });
    }
    
    const hasActive = await hasActiveConversation(normalizedPhone);
    
    if (hasActive) {
      return res.json({ 
        success: false, 
        error: 'This customer already has an active conversation. Check "Recent Conversations" below to continue their conversation.' 
      });
    }
    
    const messageBody = message || "Hi! 👋 I'm Sarah from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)";
    
    await getOrCreateCustomer(normalizedPhone);
const conversation = await getOrCreateConversation(normalizedPhone);

// Save the outgoing message to database so it appears in Recent Messages
await saveMessage(conversation.id, normalizedPhone, 'assistant', messageBody);

await logAnalytics('sms_sent', normalizedPhone, { messageBody });


    
    await twilioClient.messages.create({
      body: messageBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalizedPhone
    });
    
    console.log('✅ SMS sent to:', normalizedPhone);
    res.json({ success: true, message: 'SMS sent!' });
  } catch (error) {
    console.error('❌ Error sending SMS:', error);
    res.json({ success: false, error: error.message });
  }
});

// Twilio Webhook
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From: phone, Body: message } = req.body;
    
    console.log('📩 Received from:', phone);
    console.log('💬 Message:', message);
    
    // Respond to Twilio IMMEDIATELY (prevents retries/duplicates)
    res.type('text/xml').send('<Response></Response>');
    
    // Now do all the work in background (won't block Twilio)
    (async () => {
      try {
        await getOrCreateCustomer(phone);
        // Check if customer is stopped before starting a new conversation
        const lowerBody = message.toLowerCase().trim();
        const isStartCmd = lowerBody === 'start' || lowerBody.includes('resubscribe');
        const isStopCmd = lowerBody === 'stop' || lowerBody.startsWith('stop') || lowerBody.includes('unsubscribe');

        const recentConvResult = await pool.query(
          'SELECT * FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
          [phone]
        );
        const recentConv = recentConvResult.rows[0];

        if (recentConv && recentConv.status === 'stopped' && !isStartCmd && !isStopCmd) {
          await twilioClient.messages.create({
            body: "You're currently unsubscribed. Reply START to receive messages again.",
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone
          });
          return;
        }

        const conversation = await getOrCreateConversation(phone);
        await saveMessage(conversation.id, phone, 'user', message);
        try { await logAnalytics('message_received', phone, { message }); } catch(e) { console.error('Analytics error:', e.message); }
        
        const aiResponse = await getJerryResponse(phone, message, conversation);
        await saveMessage(conversation.id, phone, 'assistant', aiResponse);
        
        // Send SMS
        await twilioClient.messages.create({
          body: aiResponse,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone
        });
        
               console.log('✅ Sarah replied:', aiResponse);
        
        // Send email notification (non-blocking, won't slow down SMS)
        sendEmailNotification(
          '🚨 New Message from ' + (conversation.customer_name || formatPhone(phone)),
          '<div style="font-family: Arial; max-width: 600px;"><div style="background: linear-gradient(135deg, #1e3a5f 0%, #2c4e6f 100%); padding: 20px; border-radius: 10px 10px 0 0;"><h1 style="color: white; margin: 0;">🚨 New Customer Message</h1></div><div style="background: #f7fafc; padding: 25px; border-radius: 0 0 10px 10px;"><table><tr><td style="padding: 12px; font-weight: bold;">Phone:</td><td style="padding: 12px;">' + formatPhone(phone) + '</td></tr><tr><td style="padding: 12px; font-weight: bold;">Name:</td><td style="padding: 12px;">' + (conversation.customer_name||'Not provided') + '</td></tr><tr><td style="padding: 12px; font-weight: bold;">Message:</td><td style="padding: 12px; font-weight: 600;">' + message + '</td></tr></table></div></div>'
        ).catch(err => {
          console.error('Email error:', err);
        });
        
      } catch (bgError) {
        console.error('❌ Background processing error:', bgError);
      }
    })();
    
  } catch (error) {
    console.error('❌ Webhook error:', error);        
        

    res.type('text/xml').send('<Response></Response>');
  }
});


// Jerry AI Logic
async function getJerryResponse(phone, message, conversation) {
  const lowerMsg = message.toLowerCase();
  
  // STOP: accept "stop", "stop.", "STOP!", "please stop", "unsubscribe" etc.
  if (lowerMsg.trim() === 'stop' || /^stop[^a-z]/i.test(message.trim()) || 
      lowerMsg.includes('unsubscribe') || lowerMsg.includes('opt out') || lowerMsg.includes('opt-out')) {
    await updateConversation(conversation.id, { status: 'stopped' });
    await logAnalytics('conversation_stopped', phone, {});
    return "You've been unsubscribed and won't receive further messages. Reply START anytime to resume.";
  }

  // START: reactivate a stopped conversation
  if (lowerMsg.trim() === 'start' || lowerMsg.includes('resubscribe') || lowerMsg.includes('opt in')) {
    await updateConversation(conversation.id, { status: 'active', stage: 'greeting' });
    await logAnalytics('conversation_restarted', phone, {});
    return "Welcome back! 👋 I'm Sarah from the dealership. What type of vehicle are you looking for? (SUV, Truck, Sedan, etc.)";
  }

  // If conversation is stopped and not START, don't engage
  if (conversation.status === 'stopped') {
    return "You're currently unsubscribed. Reply START to receive messages again.";
  }
  
  // Handle negative responses gracefully
  if (lowerMsg.includes('not interested') || lowerMsg.includes('no thanks') || 
      lowerMsg.includes('no thank you') || lowerMsg.includes('wrong number') || 
      lowerMsg.includes('leave me alone') || lowerMsg.includes('remove me') ||
      lowerMsg.includes('do not contact') || lowerMsg === 'no') {
    await updateConversation(conversation.id, { status: 'stopped' });
    await logAnalytics('conversation_stopped', phone, { reason: 'not_interested' });
    return "No problem at all! I've removed you from our list. Have a great day! 😊 Reply START anytime if you change your mind.";
  }

  if (lowerMsg.includes('location') || lowerMsg.includes('where') || lowerMsg.includes('address') || 
      lowerMsg.includes('dealership') || lowerMsg.includes('calgary') || lowerMsg.includes('alberta')) {
    await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
    return "We're located in Calgary, Alberta and deliver all across Canada! 🇨🇦 I can have a manager call you with directions and details — what's your name?";
  }
  
  if (lowerMsg.includes('detail') || lowerMsg.includes('more info') || lowerMsg.includes('tell me more') ||
      (lowerMsg.includes('manager') && lowerMsg.includes('call'))) {
    await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
    return "I'd love to have one of our managers reach out with all the details! First, what's your name?";
  }
  
  // Financing, credit, trade-in questions → funnel to callback
  if (lowerMsg.includes('financ') || lowerMsg.includes('credit') || lowerMsg.includes('loan') ||
      lowerMsg.includes('payment') || lowerMsg.includes('monthly') || lowerMsg.includes('down payment') ||
      lowerMsg.includes('trade') || lowerMsg.includes('trade-in') || lowerMsg.includes('trade in') ||
      lowerMsg.includes('bad credit') || lowerMsg.includes('no credit') || lowerMsg.includes('poor credit')) {
    await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
    return "Great news — we work with all credit situations and have flexible financing options! 💳 Our finance team can walk you through everything. What's your name so I can set up a quick call?";
  }

  // Price / cost questions → funnel into budget stage or callback
  if (lowerMsg.includes('how much') || lowerMsg.includes('what does it cost') || 
      lowerMsg.includes('price') || lowerMsg.includes('cheapest') || lowerMsg.includes('expensive') ||
      lowerMsg.includes('cost') || lowerMsg.includes('rates')) {
    if (!conversation.vehicle_type) {
      await updateConversation(conversation.id, { stage: 'budget' });
      return "We have vehicles across a wide range! To find you the best match, what's your budget in mind? (e.g., $15k, $25k, $40k, $60k+)";
    } else {
      await updateConversation(conversation.id, { stage: 'budget' });
      return `Great question! ${conversation.vehicle_type}s vary by trim and features. What budget are you working with? (e.g., $15k, $25k, $40k, $60k+)`;
    }
  }

  // Specific make/model questions → capture vehicle type and funnel
  if (lowerMsg.includes('ram') || lowerMsg.includes('f-150') || lowerMsg.includes('f150') || 
      lowerMsg.includes('silverado') || lowerMsg.includes('tacoma') || lowerMsg.includes('tundra') ||
      lowerMsg.includes('highlander') || lowerMsg.includes('rav4') || lowerMsg.includes('cr-v') ||
      lowerMsg.includes('pilot') || lowerMsg.includes('explorer') || lowerMsg.includes('suburban') ||
      lowerMsg.includes('tahoe') || lowerMsg.includes('yukon') || lowerMsg.includes('equinox') ||
      lowerMsg.includes('escape') || lowerMsg.includes('compass') || lowerMsg.includes('cherokee') ||
      lowerMsg.includes('wrangler') || lowerMsg.includes('mustang') || lowerMsg.includes('civic') ||
      lowerMsg.includes('corolla') || lowerMsg.includes('camry') || lowerMsg.includes('accord') ||
      lowerMsg.includes('altima') || lowerMsg.includes('tesla') || lowerMsg.includes('model 3') ||
      lowerMsg.includes('model y') || lowerMsg.includes('pickup')) {
    const isTruck = lowerMsg.includes('ram') || lowerMsg.includes('f-150') || lowerMsg.includes('f150') || 
                    lowerMsg.includes('silverado') || lowerMsg.includes('tacoma') || lowerMsg.includes('tundra') ||
                    lowerMsg.includes('pickup');
    const isEV = lowerMsg.includes('tesla') || lowerMsg.includes('model 3') || lowerMsg.includes('model y');
    const vehicleType = isTruck ? 'Truck' : isEV ? 'Electric/Hybrid' : 'SUV';
    await updateConversation(conversation.id, { vehicle_type: vehicleType, stage: 'budget' });
    return `Love it! We have great options in that category. 🚗 What's your budget range? (e.g., $25k, $40k, $60k+)`;
  }

  // Availability / inventory questions → funnel to appointment
  if (lowerMsg.includes('do you have') || lowerMsg.includes('got any') || lowerMsg.includes('available') ||
      lowerMsg.includes('in stock') || lowerMsg.includes('inventory') && conversation.stage === 'greeting') {
    await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
    return "Yes! We have a great selection across all makes and models. 🚗 I can have a manager send you our current inventory — what's your name?";
  }

  if (conversation.stage === 'greeting' || !conversation.vehicle_type) {
    
    if (lowerMsg.includes('suv')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'SUV',
        stage: 'budget'
      });
      return `Great choice! SUVs are very popular. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('truck')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Truck',
        stage: 'budget'
      });
      return `Awesome! Trucks are great. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('sedan')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Sedan',
        stage: 'budget'
      });
      return `Perfect! Sedans are reliable. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
        
    if (lowerMsg.includes('sports') || lowerMsg.includes('coupe') || lowerMsg.includes('convertible')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Sports Car',
        stage: 'budget'
      });
      return `Exciting! Sports cars are fun. What's your budget range? (e.g., $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('minivan') || lowerMsg.includes('van')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Minivan',
        stage: 'budget'
      });
      return `Great for families! What's your budget range? (e.g., $20k, $30k, $50k+)`;
    }
    
    if (lowerMsg.includes('electric') || lowerMsg.includes('ev') || lowerMsg.includes('hybrid')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Electric/Hybrid',
        stage: 'budget'
      });
      return `Excellent choice! Eco-friendly options. What's your budget range? (e.g., $30k, $50k, $70k+)`;
    }

    if (lowerMsg.includes('car') || lowerMsg.includes('vehicle') || 
        lowerMsg.includes('yes') || lowerMsg.includes('interested') ||
        lowerMsg.includes('want') || lowerMsg.includes('looking')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Vehicle',
        stage: 'budget'
      });
      return `Great! What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    return "What type of vehicle interests you? We have SUVs, Trucks, Sedans, Coupes, and more!";
  }
  
  if (conversation.stage === 'budget' && !conversation.budget) {
    const numbers = message.match(/\d+/g);
    let budgetAmount = 0;
    
    if (numbers && numbers.length > 0) {
      budgetAmount = parseInt(numbers[0]);
      
      if (lowerMsg.includes('k') && budgetAmount < 1000) {
        budgetAmount = budgetAmount * 1000;
      }
      
      if (message.includes(',')) {
        const fullNumber = message.replace(/,/g, '');
        const extracted = fullNumber.match(/\d+/);
        if (extracted) {
          budgetAmount = parseInt(extracted[0]);
        }
      }
    }
       
    // Validate budget amount is realistic
    if (budgetAmount > 0 && budgetAmount < 5000) {
      return "Just to clarify - is that $" + budgetAmount + " your total budget or down payment? Most vehicles start around $15k. Reply with your full budget (e.g., $20k, $30k).";
    }
 
    if (budgetAmount > 0) {
      let budgetRange = '';
      if (budgetAmount < 30000) {
        budgetRange = 'Under $30k';
      } else if (budgetAmount >= 30000 && budgetAmount <= 50000) {
        budgetRange = '$30k-$50k';
      } else {
        budgetRange = '$50k+';
      }
      
      await updateConversation(conversation.id, { 
        budget: budgetRange,
        budget_amount: budgetAmount,
        stage: 'appointment'
      });
      
      return `Perfect! I have some great ${conversation.vehicle_type}s around $${(budgetAmount/1000).toFixed(0)}k. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!`;
    }
    
    if (lowerMsg.includes('cheap') || lowerMsg.includes('low') || lowerMsg.includes('budget')) {
      await updateConversation(conversation.id, { 
        budget: 'Under $30k',
        stage: 'appointment'
      });
      return `Got it! I have great budget-friendly options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    if (lowerMsg.includes('high') || lowerMsg.includes('premium') || lowerMsg.includes('luxury')) {
      await updateConversation(conversation.id, { 
        budget: '$50k+',
        stage: 'appointment'
      });
      return `Excellent! I have some premium options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    return "What's your budget? Just give me a number like $15k, $20k, $40k, etc.";
  }
  
  if (conversation.stage === 'appointment' && !conversation.intent) {
    if (lowerMsg.includes('1') || lowerMsg.includes('test') || lowerMsg.includes('drive') || 
        lowerMsg.includes('appointment') || lowerMsg.includes('visit')) {
      await updateConversation(conversation.id, { 
        intent: 'test_drive',
        stage: 'name'
      });
      return "Awesome! What's your name so I can get this set up for you? 😊";
    }
    
    if (lowerMsg.includes('2') || lowerMsg.includes('call') || lowerMsg.includes('phone') || 
        lowerMsg.includes('talk')) {
      await updateConversation(conversation.id, { 
        intent: 'callback',
        stage: 'name'
      });
      return "Great! What's your name so I can set this up? 😊";
    }
    
    // Soft nudge for non-committal responses
    if (lowerMsg.includes('maybe') || lowerMsg.includes('not sure') || lowerMsg.includes('think') ||
        lowerMsg.includes('later') || lowerMsg.includes('busy') || lowerMsg.includes('soon')) {
      return `No rush at all ${conversation.customer_name || ''}! A test drive is only 30 mins and we work around your schedule 😊 Whenever you're ready:\n1️⃣ Book a test drive\n2️⃣ Quick call with our team\nJust reply 1 or 2!`.trim();
    }
    return "Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!";
  }
  
  if (conversation.stage === 'name' && !conversation.customer_name) {
    let name = message.trim();
    
    if (lowerMsg.includes('my name is')) {
      name = message.split(/my name is/i)[1].trim();
    } else if (lowerMsg.includes("i'm")) {
      name = message.split(/i'm/i)[1].trim();
    } else if (lowerMsg.includes("i am")) {
      name = message.split(/i am/i)[1].trim();
    }
    
    // Clean up name - only take first 2 words max, stop at punctuation
    name = name.replace(/[^a-zA-Z\s'-]/g, '').trim();
    const nameParts = name.split(/\s+/).slice(0, 2);
    name = nameParts.join(' ');
    name = name.charAt(0).toUpperCase() + name.slice(1);
    
    await updateConversation(conversation.id, { 
      customer_name: name,
      stage: 'datetime'
    });
    
    await pool.query(
      'UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2',
      [name, phone]
    );
    
    if (conversation.intent === 'test_drive') {
      return `Nice to meet you, ${name}! When works best for your test drive? (e.g., Tomorrow afternoon, Saturday morning, Next week)`;
    } else {
      return `Nice to meet you, ${name}! When's the best time to call you? (e.g., Tomorrow at 2pm, Friday morning, This evening)`;
    }
  }
  
  if (conversation.stage === 'datetime' && !conversation.datetime) {
    // NEW CODE - Handle vague datetime responses
    let finalDateTime = message;
    const lowerMsg = message.toLowerCase().trim();
    
    // Handle "today" variations
    if (lowerMsg.includes('today')) {
      if (lowerMsg.includes('morning')) finalDateTime = 'Today morning';
      else if (lowerMsg.includes('afternoon')) finalDateTime = 'Today afternoon';
      else if (lowerMsg.includes('evening')) finalDateTime = 'Today evening';
      else finalDateTime = 'Today afternoon';
    }
    // Handle "tomorrow" variations
    else if (lowerMsg.includes('tomorrow')) {
      if (lowerMsg.includes('morning')) finalDateTime = 'Tomorrow morning';
      else if (lowerMsg.includes('afternoon')) finalDateTime = 'Tomorrow afternoon';
      else if (lowerMsg.includes('evening')) finalDateTime = 'Tomorrow evening';
      else finalDateTime = 'Tomorrow afternoon';
    }
    // Handle "this weekend"
    else if (lowerMsg.includes('this weekend') || lowerMsg === 'weekend') {
      finalDateTime = 'This weekend';
    }
    // Handle "next week"
    else if (lowerMsg.includes('next week')) {
      finalDateTime = 'Next week';
    }
    // Handle "this morning/afternoon/evening"
    else if (lowerMsg.includes('this morning')) {
      finalDateTime = 'Today morning';
    }
    else if (lowerMsg.includes('this afternoon')) {
      finalDateTime = 'Today afternoon';
    }
    else if (lowerMsg.includes('this evening') || lowerMsg.includes('tonight')) {
      finalDateTime = 'Today evening';
    }
    // END NEW CODE
    
       await updateConversation(conversation.id, { 
      datetime: finalDateTime,
      stage: 'confirmed',
      status: 'converted'
    });
    
    const appointmentData = {
      phone: phone,
      name: conversation.customer_name,
      vehicleType: conversation.vehicle_type,
      budget: conversation.budget,
      budgetAmount: conversation.budget_amount,
      datetime: message
    };
    
    if (conversation.intent === 'test_drive') {
      await saveAppointment(appointmentData);
      try {
        await sendEmailNotification('📅 Test Drive: ' + conversation.customer_name, '<div style="font-family: Arial;"><h1 style="color: #10b981;">📅 New Appointment!</h1><p><strong>Customer:</strong> ' + conversation.customer_name + '</p><p><strong>Phone:</strong> ' + formatPhone(phone) + '</p><p><strong>Date/Time:</strong> ' + message + '</p></div>');
      } catch (e) { }
      await logAnalytics('appointment_booked', phone, appointmentData);
      return `✅ Perfect ${conversation.customer_name}! I've booked your test drive for ${message}.\n\n📍 We're in Calgary, Alberta and we deliver all across Canada!\n📧 Confirmation sent!\n\nLooking forward to seeing you! Reply STOP to opt out.`;
    } else {
      await saveCallback(appointmentData);
      try {
        await sendEmailNotification('📞 Callback: ' + conversation.customer_name, '<div style="font-family: Arial;"><h1 style="color: #f59e0b;">📞 Callback Requested!</h1><p><strong>Customer:</strong> ' + conversation.customer_name + '</p><p><strong>Phone:</strong> ' + formatPhone(phone) + '</p><p><strong>Time:</strong> ' + message + '</p></div>');
      } catch (e) { }
      await logAnalytics('callback_requested', phone, appointmentData);
      return `✅ Got it ${conversation.customer_name}! One of our managers will call you ${message} with all the details.\n\nWe're excited to help you find your perfect ${conversation.vehicle_type}!\n\nTalk soon! Reply STOP to opt out.`;
    }
  }
  
 if (conversation.stage === 'confirmed') {
    // Check for specific keywords after booking
    if (lowerMsg.includes('reschedule') || lowerMsg.includes('change') || lowerMsg.includes('different time')) {
      await updateConversation(conversation.id, { stage: 'datetime', datetime: null });
      return `No problem ${conversation.customer_name}! What time works better for you? (e.g., Friday afternoon, Next Tuesday, This weekend)`;
    }
    
    if (lowerMsg.includes('cancel')) {
      await updateConversation(conversation.id, { status: 'active', stage: 'datetime', datetime: null, intent: conversation.intent });
      return `No worries ${conversation.customer_name}! Would you like to pick a different time instead? Just tell me when works better and I'll get you rebooked! 😊`;
    }
    
    if (lowerMsg.includes('inventory') || lowerMsg.includes('photos') || lowerMsg.includes('pictures') || lowerMsg.includes('see vehicles')) {
      // Log as a callback so the team knows to follow up with photos
      const followUpData = {
        phone: phone,
        name: conversation.customer_name,
        vehicleType: conversation.vehicle_type,
        budget: conversation.budget,
        budgetAmount: conversation.budget_amount,
        datetime: 'ASAP - Customer requested inventory photos'
      };
      await saveCallback(followUpData);
      await logAnalytics('inventory_requested', phone, followUpData);
      try {
        await sendEmailNotification(
          '📸 Inventory Photos Requested: ' + conversation.customer_name,
          '<div style="font-family: Arial;"><h1 style="color: #6366f1;">📸 Customer Wants Photos!</h1>' +
          '<p><strong>Customer:</strong> ' + conversation.customer_name + '</p>' +
          '<p><strong>Phone:</strong> ' + formatPhone(phone) + '</p>' +
          '<p><strong>Looking for:</strong> ' + (conversation.vehicle_type || 'Not specified') + ' / ' + (conversation.budget || 'Budget TBD') + '</p>' +
          '<p><strong>Action:</strong> Send inventory photos ASAP</p></div>'
        );
      } catch(e) {}
      return `Great question ${conversation.customer_name}! I've let our team know — a manager will text you photos of ${conversation.vehicle_type || 'vehicles'} in your ${conversation.budget || 'budget'} range shortly! 📸`;
    }
    
    // Default response for confirmed stage
    return `Thanks ${conversation.customer_name}! We're all set for ${conversation.datetime}. 📅\n\nNeed to:\n• RESCHEDULE - Change your appointment time\n• INVENTORY - See photos of available vehicles\n• Just reply if you have questions!\n\nWe're in Calgary and deliver across Canada! 🚗`;
  }
  
  // Smart fallback - redirect to wherever they are in the funnel
  if (!conversation.vehicle_type || conversation.stage === 'greeting') {
    return "What type of vehicle are you looking for? We have SUVs, Trucks, Sedans, EVs and more! 🚗";
  }
  if (!conversation.budget || conversation.stage === 'budget') {
    return `What budget are you working with for your ${conversation.vehicle_type || 'vehicle'}? (e.g., $15k, $25k, $40k, $60k+)`;
  }
  if (conversation.stage === 'appointment' && !conversation.intent) {
    return "Ready to take the next step? Reply:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back";
  }
  if (conversation.stage === 'name' && !conversation.customer_name) {
    return "What's your name so I can get this set up for you? 😊";
  }
  if (conversation.stage === 'datetime' && !conversation.datetime) {
    return conversation.intent === 'test_drive'
      ? "When works best for your test drive? (e.g., Tomorrow afternoon, Saturday morning)"
      : "When's the best time to call you? (e.g., Tomorrow at 2pm, Friday morning)";
  }
  return `Hi ${conversation.customer_name || 'there'}! Is there anything else I can help you with? 😊`;
}


// ===== TEST & EXPORT ENDPOINTS =====
app.get('/test-email', async (req, res) => {
  try {
    const result = await sendEmailNotification('🧪 Test Email', '<h1>Email Working!</h1><p>Test: ' + new Date().toLocaleString() + '</p>');
    res.json({ success: result, message: result ? '✅ Email sent!' : '❌ Not configured' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/export/appointments', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send('Forbidden: invalid token');
  }
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM appointments ORDER BY created_at DESC');
    const rows = [['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(',')];
    result.rows.forEach(r => rows.push([r.id, '"' + r.customer_phone + '"', '"' + (r.customer_name||'') + '"', '"' + (r.vehicle_type||'') + '"', '"' + (r.budget||'') + '"', r.budget_amount||'', '"' + (r.datetime||'') + '"', '"' + r.created_at + '"'].join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="appointments_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'appointments');
  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="appointments_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

app.get('/api/export/callbacks', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send('Forbidden: invalid token');
  }
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC');
    const rows = [['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(',')];
    result.rows.forEach(r => rows.push([r.id, '"' + r.customer_phone + '"', '"' + (r.customer_name||'') + '"', '"' + (r.vehicle_type||'') + '"', '"' + (r.budget||'') + '"', r.budget_amount||'', '"' + (r.datetime||'') + '"', '"' + r.created_at + '"'].join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="callbacks_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'callbacks');
  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="callbacks_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

app.get('/api/export/conversations', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send('Forbidden: invalid token');
  }
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM conversations ORDER BY started_at DESC');
    const rows = [['ID', 'Phone', 'Status', 'Name', 'Vehicle', 'Budget', 'Started', 'Updated'].join(',')];
    result.rows.forEach(r => rows.push([r.id, '"' + r.customer_phone + '"', '"' + r.status + '"', '"' + (r.customer_name||'') + '"', '"' + (r.vehicle_type||'') + '"', '"' + (r.budget||'') + '"', '"' + r.started_at + '"', '"' + r.updated_at + '"'].join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="conversations_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'conversations');
  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="conversations_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

app.get('/api/export/analytics', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send('Forbidden: invalid token');
  }
  const client = await pool.connect();
  try {
    // ===== COMPREHENSIVE ANALYTICS REPORT =====

    // 1. SUMMARY METRICS
    const totalConvs = await client.query('SELECT COUNT(*) as count FROM conversations');
    const totalConversations = parseInt(totalConvs.rows[0].count);

    const converted = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted'");
    const totalConverted = parseInt(converted.rows[0].count);

    const responded = await client.query("SELECT COUNT(DISTINCT conversation_id) as count FROM messages WHERE role = 'user'");
    const totalResponded = parseInt(responded.rows[0].count);

    const totalAppts = await client.query('SELECT COUNT(*) as count FROM appointments');
    const appointmentCount = parseInt(totalAppts.rows[0].count);

    const totalCalls = await client.query('SELECT COUNT(*) as count FROM callbacks');
    const callbackCount = parseInt(totalCalls.rows[0].count);

    const avgMsgs = await client.query("SELECT COALESCE(AVG(msg_count), 0)::numeric(10,1) as avg FROM (SELECT conversation_id, COUNT(*) as msg_count FROM messages GROUP BY conversation_id) as counts");
    const avgMessages = parseFloat(avgMsgs.rows[0].avg || 0);

    // 2. CONVERSATION BREAKDOWN BY STATUS
    const statusBreakdown = await client.query("SELECT status, COUNT(*) as count FROM conversations GROUP BY status ORDER BY count DESC");

    // 3. TOP VEHICLE TYPES
    const topVehicles = await client.query("SELECT vehicle_type, COUNT(*) as count FROM conversations WHERE vehicle_type IS NOT NULL AND vehicle_type != '' GROUP BY vehicle_type ORDER BY count DESC LIMIT 10");

    // 4. BUDGET RANGES
    const budgetRanges = await client.query("SELECT budget, COUNT(*) as count FROM conversations WHERE budget IS NOT NULL AND budget != '' GROUP BY budget ORDER BY count DESC");

    // 5. DAILY CONVERSATION TREND (Last 30 days)
    const dailyTrend = await client.query(`
      SELECT DATE(started_at) as date, 
             COUNT(*) as conversations,
             COUNT(CASE WHEN status = 'converted' THEN 1 END) as converted
      FROM conversations 
      WHERE started_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(started_at)
      ORDER BY date DESC
    `);

    // 6. CUSTOMER ENGAGEMENT LEVELS
    const engagement = await client.query(`
      SELECT 
        CASE 
          WHEN msg_count >= 5 THEN 'High Engagement (5+ messages)'
          WHEN msg_count >= 2 THEN 'Medium Engagement (2-4 messages)'
          WHEN msg_count = 1 THEN 'Low Engagement (1 message)'
          ELSE 'No Response'
        END as engagement_level,
        COUNT(*) as count
      FROM (
        SELECT c.id, COUNT(m.id) as msg_count
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
        GROUP BY c.id
      ) as engagement_counts
      GROUP BY engagement_level
      ORDER BY count DESC
    `);

    // BUILD CSV REPORT
    const rows = [];

    // SECTION 1: SUMMARY METRICS
    rows.push('SUMMARY METRICS');
    rows.push('Metric,Value');
    rows.push(`Total Conversations,${totalConversations}`);
    rows.push(`Total Converted (Appointments + Callbacks),${totalConverted}`);
    rows.push(`Conversion Rate,${totalConversations > 0 ? ((totalConverted / totalConversations) * 100).toFixed(1) : '0.0'}%`);
    rows.push(`Customers Who Responded,${totalResponded}`);
    rows.push(`Response Rate,${totalConversations > 0 ? ((totalResponded / totalConversations) * 100).toFixed(1) : '0.0'}%`);
    rows.push(`Total Appointments,${appointmentCount}`);
    rows.push(`Total Callbacks,${callbackCount}`);
    rows.push(`Average Messages Per Conversation,${avgMessages.toFixed(1)}`);
    rows.push('');

    // SECTION 2: CONVERSATION STATUS BREAKDOWN
    rows.push('CONVERSATION STATUS BREAKDOWN');
    rows.push('Status,Count,Percentage');
    statusBreakdown.rows.forEach(r => {
      const pct = totalConversations > 0 ? ((r.count / totalConversations) * 100).toFixed(1) : '0.0';
      rows.push(`"${r.status}",${r.count},${pct}%`);
    });
    rows.push('');

    // SECTION 3: TOP VEHICLE TYPES
    rows.push('TOP VEHICLE TYPES REQUESTED');
    rows.push('Vehicle Type,Count');
    topVehicles.rows.forEach(r => {
      rows.push(`"${r.vehicle_type}",${r.count}`);
    });
    rows.push('');

    // SECTION 4: BUDGET RANGES
    rows.push('BUDGET DISTRIBUTION');
    rows.push('Budget Range,Count');
    budgetRanges.rows.forEach(r => {
      rows.push(`"${r.budget}",${r.count}`);
    });
    rows.push('');

    // SECTION 5: CUSTOMER ENGAGEMENT
    rows.push('CUSTOMER ENGAGEMENT LEVELS');
    rows.push('Engagement Level,Count');
    engagement.rows.forEach(r => {
      rows.push(`"${r.engagement_level}",${r.count}`);
    });
    rows.push('');

    // SECTION 6: DAILY TREND (Last 30 days)
    rows.push('DAILY CONVERSATION TREND (Last 30 Days)');
    rows.push('Date,Total Conversations,Converted,Conversion Rate');
    dailyTrend.rows.forEach(r => {
      const convRate = r.conversations > 0 ? ((r.converted / r.conversations) * 100).toFixed(1) : '0.0';
      rows.push(`${r.date},${r.conversations},${r.converted},${convRate}%`);
    });

    // SEND CSV
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics_report_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));

    console.log('📊 Exported comprehensive analytics report');

  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

// API: Analytics Dashboard Data
app.get('/api/analytics', async (req, res) => {
  const client = await pool.connect();
  try {
    const totalConvs = await client.query('SELECT COUNT(*) as count FROM conversations');
    const totalConversations = parseInt(totalConvs.rows[0].count);

    const converted = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted'");
    const totalConverted = parseInt(converted.rows[0].count);

    const responded = await client.query("SELECT COUNT(DISTINCT conversation_id) as count FROM messages WHERE role = 'user'");
    const totalResponded = parseInt(responded.rows[0].count);

    const avgMsgs = await client.query("SELECT COALESCE(AVG(msg_count), 0)::numeric(10,1) as avg FROM (SELECT conversation_id, COUNT(*) as msg_count FROM messages GROUP BY conversation_id) as counts");
    const avgMessages = parseFloat(avgMsgs.rows[0].avg || 0);

    const weekConvs = await client.query("SELECT COUNT(*) as count FROM conversations WHERE started_at >= NOW() - INTERVAL '7 days'");
    const weekConversations = parseInt(weekConvs.rows[0].count);

    const weekConverted = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted' AND started_at >= NOW() - INTERVAL '7 days'");
    const weekConvertedCount = parseInt(weekConverted.rows[0].count);

    const topVehicles = await client.query("SELECT vehicle_type, COUNT(*) as count FROM conversations WHERE vehicle_type IS NOT NULL AND vehicle_type != '' GROUP BY vehicle_type ORDER BY count DESC LIMIT 5");

    const budgets = await client.query("SELECT budget, COUNT(*) as count FROM conversations WHERE budget IS NOT NULL AND budget != '' GROUP BY budget ORDER BY count DESC");

    res.json({
      conversionRate: totalConversations > 0 ? ((totalConverted / totalConversations) * 100).toFixed(1) : '0.0',
      totalConverted,
      totalConversations,
      responseRate: totalConversations > 0 ? ((totalResponded / totalConversations) * 100).toFixed(1) : '0.0',
      totalResponded,
      avgMessages: avgMessages.toFixed(1),
      weekConversations,
      weekConverted: weekConvertedCount,
      topVehicles: topVehicles.rows,
      budgetDist: budgets.rows
    });
  } catch (error) {
    console.error('❌ Analytics error:', error);
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});


app.get('/api/export/engaged', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT DISTINCT c.* 
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id 
      WHERE m.role = 'user'
      ORDER BY c.started_at DESC
    `);
    const rows = [['ID', 'Phone', 'Status', 'Name', 'Vehicle', 'Budget', 'Started', 'Updated'].join(',')];
    result.rows.forEach(r => {
      rows.push([
        r.id,
        '"' + (r.customer_phone || '') + '"',
        '"' + (r.status || '') + '"',
        '"' + (r.customer_name || '') + '"',
        '"' + (r.vehicle_type || '') + '"',
        '"' + (r.budget || '') + '"',
        '"' + (r.started_at || '') + '"',
        '"' + (r.updated_at || '') + '"'
      ].join(','));
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="engaged_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
  } catch (e) {
    res.status(500).send('Export failed');
  } finally {
    client.release();
  }
});


// ===== BULK SMS ENDPOINTS =====

app.post('/api/bulk-sms/parse-csv', async (req, res) => {
  try {
    // ✅ FIXED: Handle both { csvData: "..." } and direct string formats
    const csvData = req.body.csvData || req.body;
    if (!csvData || typeof csvData !== 'string') {
      return res.status(400).json({ error: 'No CSV data' });
    }

    const lines = csvData.split(/\r?\n/);
    const contacts = [];
    const errors = [];
    const seenPhones = new Set();
    const BLACKLIST = ['2899688778', '12899688778'];
    let startRow = 0;
    if (lines[0] && lines[0].toLowerCase().includes('name')) startRow = 1;

    for (let i = startRow; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      if (parts.length < 2) {
        errors.push({ row: i + 1, error: 'Missing name or phone' });
        continue;
      }

      const name = parts[0].trim().replace(/^["']|["']$/g, '');
      const rawPhone = parts[1].trim().replace(/^["']|["']$/g, '');
      const digitsOnly = rawPhone.replace(/[^0-9]/g, '');

      let phone = digitsOnly;
      if (digitsOnly.length === 10) phone = '1' + digitsOnly;

      if (phone.length !== 11 || !phone.startsWith('1')) {
        errors.push({ row: i + 1, name, phone: rawPhone, error: 'Invalid phone' });
        continue;
      }

      if (BLACKLIST.some(blocked => phone.includes(blocked))) {
        errors.push({ row: i + 1, name, phone: rawPhone, error: 'Blacklisted number' });
        continue;
      }

      if (seenPhones.has(phone)) {
        errors.push({ row: i + 1, name, phone: rawPhone, error: 'Duplicate phone number' });
        continue;
      }
      seenPhones.add(phone);

      contacts.push({ name, phone: '+' + phone, row: i + 1 });
    }

    res.json({ success: true, contacts, errors, total: contacts.length, errorCount: errors.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bulk-sms/create-campaign', async (req, res) => {
  try {
    const { campaignName, messageTemplate, contacts } = req.body;
    if (!campaignName || !messageTemplate || !contacts || contacts.length === 0) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (!messageTemplate.includes('{name}')) {
      return res.status(400).json({ error: 'Message must include {name}' });
    }

    if (messageTemplate.length > 1600) {
      return res.status(400).json({ error: 'Message too long (max 1600 characters)' });
    }

    const placeholderCount = (messageTemplate.match(/{name}/g) || []).length;
    if (placeholderCount > 3) {
      console.warn(`⚠️ Campaign "${campaignName}" has ${placeholderCount} {name} placeholders - verify intentional`);
    }

    const messageIds = await saveBulkCampaign(campaignName, messageTemplate, contacts);
    res.json({ success: true, campaignName, messageCount: messageIds.length, estimatedTime: Math.ceil(contacts.length * 15 / 60) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bulk-sms/campaign/:campaignName', async (req, res) => {
  try {
    const campaignName = decodeURIComponent(req.params.campaignName);
    const stats = await getBulkCampaignStats(campaignName);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// 🚨 EMERGENCY STOP ALL BULK SMS
app.get('/api/emergency-stop-bulk', async (req, res) => {
  try {
  // 🔒 Admin auth check
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }

    const client = await pool.connect();
    try {
      if (bulkSmsProcessor) {
        clearInterval(bulkSmsProcessor);
        bulkSmsProcessor = null;
        console.log('🚨 BULK PROCESSOR STOPPED');
      }

      const result = await client.query(
        `UPDATE bulk_messages SET status = 'cancelled', error_message = 'Emergency stop by user' WHERE status = 'pending'`
      );

      res.json({
        success: true,
        message: '🚨 EMERGENCY STOP ACTIVATED',
        cancelled: result.rowCount,
        processorStopped: true
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET BULK STATUS
app.get('/api/bulk-status', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          status,
          COUNT(*) as count,
          COUNT(DISTINCT campaign_name) as campaigns
        FROM bulk_messages
        GROUP BY status
      `);

      res.json({
        processorRunning: bulkSmsProcessor !== null,
        paused: bulkSmsProcessorPaused,
        stats: result.rows
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
// PHASE 2 — FIRST-FIN DESK INTEGRATION  (sarah_v4.js)
// ═══════════════════════════════════════════════════════════════════

// ── DEALS TABLE ───────────────────────────────────────────────────
async function createDealsTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        customer_name     VARCHAR(255),
        customer_phone    VARCHAR(30),
        customer_email    VARCHAR(255),
        vehicle_desc      VARCHAR(500),
        stock_num         VARCHAR(50),
        selling_price     NUMERIC(12,2),
        finance_amount    NUMERIC(12,2),
        apr               NUMERIC(6,3),
        term_months       INTEGER,
        monthly_payment   NUMERIC(10,2),
        down_payment      NUMERIC(12,2),
        trade_allowance   NUMERIC(12,2),
        trade_payoff      NUMERIC(12,2),
        doc_fee           NUMERIC(10,2),
        gst_amount        NUMERIC(10,2),
        vsc_price         NUMERIC(10,2),
        gap_price         NUMERIC(10,2),
        tw_price          NUMERIC(10,2),
        wa_price          NUMERIC(10,2),
        front_gross       NUMERIC(12,2),
        back_gross        NUMERIC(12,2),
        total_gross       NUMERIC(12,2),
        pvr               NUMERIC(12,2),
        salesperson       VARCHAR(255),
        dealership        VARCHAR(255),
        follow_up_sent    BOOLEAN DEFAULT FALSE,
        logged_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        raw_data          JSONB
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deals_phone ON deals(customer_phone);
      CREATE INDEX IF NOT EXISTS idx_deals_logged ON deals(logged_at DESC);
    `);
    console.log('✅ deals table ready');
  } catch (e) {
    console.error('❌ deals table error:', e.message);
  } finally {
    client.release();
  }
}
createDealsTable();

// ── 1. GET /api/qualified-leads ───────────────────────────────────
// Returns all leads Sarah has qualified — feeds directly into Desk CRM
app.get('/api/qualified-leads', async (req, res) => {
  // 🔒 Token check
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        c.customer_phone          AS phone,
        c.customer_name           AS name,
        c.vehicle_type            AS vehicle_interest,
        c.budget                  AS budget_range,
        c.budget_amount           AS budget_amount,
        c.stage                   AS stage,
        c.status                  AS conv_status,
        c.started_at,
        c.updated_at,
        cu.email                  AS email,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND role = 'user')
                                  AS reply_count,
        EXISTS(SELECT 1 FROM appointments a WHERE a.customer_phone = c.customer_phone)
                                  AS has_appointment,
        EXISTS(SELECT 1 FROM callbacks cb WHERE cb.customer_phone = c.customer_phone)
                                  AS wants_callback,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1)
                                  AS last_message
      FROM conversations c
      LEFT JOIN customers cu ON cu.phone = c.customer_phone
      WHERE c.status != 'deleted'
      ORDER BY c.updated_at DESC
      LIMIT 200
    `);
    res.json({ success: true, leads: result.rows, total: result.rows.length });
  } catch (e) {
    console.error('❌ /api/qualified-leads error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});

// ── 2. POST /api/deals — Save deal from Desk to PostgreSQL ────────
app.post('/api/deals', async (req, res) => {
  const token = req.body.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const client = await pool.connect();
  try {
    const d = req.body.deal || req.body;
    const result = await client.query(`
      INSERT INTO deals (
        customer_name, customer_phone, customer_email,
        vehicle_desc, stock_num,
        selling_price, finance_amount, apr, term_months, monthly_payment,
        down_payment, trade_allowance, trade_payoff, doc_fee, gst_amount,
        vsc_price, gap_price, tw_price, wa_price,
        front_gross, back_gross, total_gross, pvr,
        salesperson, dealership, raw_data
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26
      ) RETURNING id, logged_at
    `, [
      d.customerName   || null, d.customerPhone  || null, d.customerEmail || null,
      d.vehicleDesc    || null, d.stockNum        || null,
      d.sellingPrice   || 0,    d.financeAmount   || 0,
      d.apr            || 0,    d.termMonths      || 72,  d.monthlyPayment || 0,
      d.downPayment    || 0,    d.tradeAllowance  || 0,   d.tradePayoff    || 0,
      d.docFee         || 0,    d.gstAmount       || 0,
      d.vscPrice       || 0,    d.gapPrice        || 0,   d.twPrice        || 0,
      d.waPrice        || 0,    d.frontGross      || 0,   d.backGross      || 0,
      d.totalGross     || 0,    d.pvr             || 0,
      d.salesperson    || null, d.dealership      || null,
      JSON.stringify(d)
    ]);
    console.log('💾 Deal saved to DB:', result.rows[0].id, d.customerName || 'Unknown');
    res.json({ success: true, dealId: result.rows[0].id, loggedAt: result.rows[0].logged_at });
  } catch (e) {
    console.error('❌ /api/deals POST error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});

// ── 3. GET /api/deals — Load all deals for Desk analytics ─────────
app.get('/api/deals', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit) || 100;
    const result = await client.query(
      'SELECT * FROM deals ORDER BY logged_at DESC LIMIT $1', [limit]
    );
    res.json({ success: true, deals: result.rows, total: result.rows.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});

// ── 4. POST /api/deal-funded — Trigger follow-up SMS after deal ────
app.post('/api/deal-funded', async (req, res) => {
  const token = req.body.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  try {
    const { phone, customerName, vehicleDesc, dealId, dealership } = req.body;

    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });

    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ success: false, error: 'Invalid phone number' });

    const name      = customerName  || 'there';
    const vehicle   = vehicleDesc   || 'your new vehicle';
    const store     = dealership    || 'First Financial';

    const message =
      `Hi ${name.split(' ')[0]}! 🎉 Congratulations on your ${vehicle} from ${store}! ` +
      `We'd love a quick Google review — it means the world to us: https://g.page/r/review

` +
      `Know anyone looking for a vehicle? Send them our way and we'll take great care of them!`;

    // Save to conversation and send
    const conversation = await getOrCreateConversation(normalized);
    await saveMessage(conversation.id, normalized, 'assistant', message);

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalized
    });

    // Mark deal as follow-up sent if dealId provided
    if (dealId) {
      const client = await pool.connect();
      try {
        await client.query('UPDATE deals SET follow_up_sent = TRUE WHERE id = $1', [dealId]);
      } finally {
        client.release();
      }
    }

    await logAnalytics('deal_funded_followup', normalized, { vehicleDesc, dealId });
    console.log('✅ Deal follow-up SMS sent to:', normalized);
    res.json({ success: true, message: 'Follow-up SMS sent!', to: normalized });
  } catch (e) {
    console.error('❌ /api/deal-funded error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 5. POST /api/campaign-from-crm — Bulk SMS from Desk CRM list ──
app.post('/api/campaign-from-crm', async (req, res) => {
  const token = req.body.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  try {
    const { campaignName, messageTemplate, contacts } = req.body;
    // contacts: [{ name, phone }, ...]

    if (!campaignName || !messageTemplate || !contacts || !contacts.length) {
      return res.status(400).json({ success: false, error: 'campaignName, messageTemplate, contacts[] required' });
    }

    // Normalize phones and filter invalid
    const valid = contacts
      .map(c => ({ ...c, phone: normalizePhone(c.phone) }))
      .filter(c => c.phone);

    if (!valid.length) {
      return res.status(400).json({ success: false, error: 'No valid phone numbers in contacts' });
    }

    await saveBulkCampaign(campaignName, messageTemplate, valid);

    console.log(`📋 CRM campaign created: "${campaignName}" — ${valid.length} contacts`);
    res.json({
      success: true,
      message: `Campaign "${campaignName}" created with ${valid.length} contacts`,
      total: valid.length,
      skipped: contacts.length - valid.length
    });
  } catch (e) {
    console.error('❌ /api/campaign-from-crm error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 6. POST /api/voice/drop — Single voicemail drop ───────────────
app.post('/api/voice/drop', async (req, res) => {
  const token = req.body.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  try {
    const { phone, message, callbackUrl } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: 'phone and message required' });
    }
    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ success: false, error: 'Invalid phone' });

    // Build TwiML — speak the message then optionally offer press-1 callback
    const twimlUrl = callbackUrl || process.env.BASE_URL + '/api/voice/twiml';
    const encodedMsg = encodeURIComponent(message);

    const call = await twilioClient.calls.create({
      to: normalized,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Say voice="Polly.Joanna">${message.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Say><Pause length="1"/><Say voice="Polly.Joanna">Press 1 to speak with us now or simply reply to this number by text. Thank you!</Say><Gather numDigits="1" action="${process.env.BASE_URL || ''}/api/voice/keypress"><Pause length="5"/></Gather></Response>`
    });

    await logAnalytics('voice_drop', normalized, { callSid: call.sid });
    console.log('📞 Voice drop initiated:', call.sid, '->', normalized);
    res.json({ success: true, callSid: call.sid, to: normalized });
  } catch (e) {
    console.error('❌ /api/voice/drop error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 6b. POST /api/voice/campaign — Bulk voicemail drops ───────────
app.post('/api/voice/campaign', async (req, res) => {
  const token = req.body.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  try {
    const { contacts, message, delaySeconds } = req.body;
    // contacts: [{ name, phone }]
    if (!contacts || !contacts.length || !message) {
      return res.status(400).json({ success: false, error: 'contacts[] and message required' });
    }

    const delay = parseInt(delaySeconds) || 10; // 10s between calls by default
    let scheduled = 0;

    for (let i = 0; i < contacts.length; i++) {
      const normalized = normalizePhone(contacts[i].phone);
      if (!normalized) continue;

      // Stagger calls with setTimeout
      setTimeout(async () => {
        try {
          const personalizedMsg = message.replace(/{name}/gi, contacts[i].name || 'there');
          await twilioClient.calls.create({
            to: normalized,
            from: process.env.TWILIO_PHONE_NUMBER,
            twiml: `<Response><Say voice="Polly.Joanna">${personalizedMsg.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Say><Pause length="1"/><Say voice="Polly.Joanna">Press 1 to speak with us or reply by text. Thank you!</Say><Gather numDigits="1" action="${process.env.BASE_URL || ''}/api/voice/keypress"><Pause length="5"/></Gather></Response>`
          });
          console.log('📞 Voice drop sent:', normalized);
        } catch (err) {
          console.error('❌ Voice drop failed for', normalized, err.message);
        }
      }, i * delay * 1000);

      scheduled++;
    }

    res.json({ success: true, scheduled, message: `${scheduled} voice drops queued` });
  } catch (e) {
    console.error('❌ /api/voice/campaign error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 6c. POST /api/voice/keypress — Handle press-1 forward ─────────
app.post('/api/voice/keypress', (req, res) => {
  const digit = req.body.Digits;
  const forwardTo = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;

  if (digit === '1' && forwardTo) {
    res.type('text/xml').send(
      `<Response><Say voice="Polly.Joanna">Please hold while we connect you.</Say><Dial>${forwardTo}</Dial></Response>`
    );
  } else {
    res.type('text/xml').send(
      `<Response><Say voice="Polly.Joanna">Thank you! Feel free to text us anytime. Goodbye!</Say><Hangup/></Response>`
    );
  }
});

// ── HEALTH CHECK for Desk connection test ─────────────────────────
app.get('/api/desk-ping', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  res.json({
    success: true,
    version: 'sarah_v4',
    timestamp: new Date().toISOString(),
    features: ['qualified-leads','deals','deal-funded','campaign-from-crm','voice-drop','voice-campaign']
  });
});

// ═══════════════════════════════════════════════════════════════════
// END PHASE 2 ROUTES
// ═══════════════════════════════════════════════════════════════════

app.listen(PORT, HOST, () => {
  console.log(`✅ FIRST-FIN PLATFORM v1.0 — Port ${PORT}`);
  console.log(`🌐 Open: http://localhost:${PORT}`);
});
