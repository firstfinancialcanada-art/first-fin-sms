const { pool, getOrCreateConversation, updateConversation, saveMessage, isOptedOut } = require('./db');

const BULK_BATCH_SIZE = parseInt(process.env.BULK_BATCH_SIZE) || 5;
const BULK_INTERVAL_MS = parseInt(process.env.BULK_INTERVAL_MS) || 5000;

// ── Shared mutable state ──────────────────────────────────────────
const state = {
  bulkSmsProcessor: null,
  bulkSmsProcessorPaused: false,
  aiResponderPaused: false
};

// ── Table setup ───────────────────────────────────────────────────
async function createBulkMessagesTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bulk_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
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
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bulk_messages_processing
      ON bulk_messages(status, scheduled_at)
      WHERE status = 'pending'
    `);
    console.log('✅ bulk_messages table ready');
    // Safe migrations
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS user_id INTEGER`).catch(() => {});
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'unknown'`).catch(() => {});
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS twilio_sid VARCHAR(50)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bulk_messages_sid ON bulk_messages(twilio_sid) WHERE twilio_sid IS NOT NULL`).catch(() => {});
    console.log('✅ bulk_messages columns + indexes ready');
  } catch (error) {
    console.error('❌ bulk_messages table error:', error);
  } finally {
    client.release();
  }
}

// ── Campaign helpers ──────────────────────────────────────────────
async function saveBulkCampaign(campaignName, messageTemplate, contacts, userId) {
  const client = await pool.connect();
  try {
    const startTime = new Date(Date.now() + 60000);
    const scheduledTimes = contacts.map((_, i) =>
      new Date(startTime.getTime() + (i * 15000))
    );
    if (contacts.length === 0) return [];
    const valuePlaceholders = contacts.map((_, i) =>
      `($${i*6+1}, $${i*6+2}, $${i*6+3}, $${i*6+4}, $${i*6+5}, $${i*6+6})`
    ).join(', ');
    const flatValues = contacts.flatMap((contact, i) => [
      campaignName, messageTemplate, contact.name, contact.phone, scheduledTimes[i], userId || null
    ]);
    const result = await client.query(
      `INSERT INTO bulk_messages (campaign_name, message_template, recipient_name, recipient_phone, scheduled_at, user_id) VALUES ${valuePlaceholders} RETURNING id`,
      flatValues
    );
    return result.rows.map(r => r.id);
  } finally {
    client.release();
  }
}

async function getPendingBulkMessages(limit = BULK_BATCH_SIZE, client = null) {
  const c = client || await pool.connect();
  try {
    const result = await c.query(
      'SELECT * FROM bulk_messages WHERE status = $1 AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT $2',
      ['pending', limit]
    );
    return result.rows;
  } finally {
    if (!client) c.release();
  }
}

async function updateBulkMessageStatus(messageId, status, errorMessage = null, client = null) {
  const c = client || await pool.connect();
  try {
    await c.query(
      'UPDATE bulk_messages SET status = $1, error_message = $2, sent_at = CASE WHEN $1 = $3 THEN NOW() ELSE sent_at END WHERE id = $4',
      [status, errorMessage, 'sent', messageId]
    );
  } finally {
    if (!client) c.release();
  }
}

async function getBulkCampaignStats(campaignName, userId) {
  const client = await pool.connect();
  try {
    const result = userId
      ? await client.query(
          'SELECT COUNT(*) as total, COUNT(CASE WHEN status = $1 THEN 1 END) as sent, COUNT(CASE WHEN status = $2 THEN 1 END) as pending, COUNT(CASE WHEN status = $3 THEN 1 END) as failed FROM bulk_messages WHERE campaign_name = $4 AND user_id = $5',
          ['sent', 'pending', 'failed', campaignName, userId]
        )
      : await client.query(
          'SELECT COUNT(*) as total, COUNT(CASE WHEN status = $1 THEN 1 END) as sent, COUNT(CASE WHEN status = $2 THEN 1 END) as pending, COUNT(CASE WHEN status = $3 THEN 1 END) as failed FROM bulk_messages WHERE campaign_name = $4',
          ['sent', 'pending', 'failed', campaignName]
        );
    return result.rows[0];
  } finally {
    client.release();
  }
}

// ── Processor (needs twilioClient injected) ───────────────────────
function makeBulkProcessor(twilioClient) {
  async function processBulkMessages() {
    if (state.bulkSmsProcessorPaused) {
      console.log('⏸️  Paused');
      return;
    }
    try {
      const pendingMessages = await getPendingBulkMessages(BULK_BATCH_SIZE);
      if (pendingMessages.length === 0) return;

      // Build a per-tenant from-number cache for this batch
      const tenantNumberCache = {};
      async function getTenantFromNumber(userId) {
        if (!userId) return process.env.TWILIO_PHONE_NUMBER;
        if (tenantNumberCache[userId] !== undefined) return tenantNumberCache[userId];
        try {
          const r = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [userId]);
          const s = r.rows[0]?.settings_json;
          const parsed = typeof s === 'string' ? JSON.parse(s) : (s || {});
          tenantNumberCache[userId] = parsed.twilioNumber || process.env.TWILIO_PHONE_NUMBER;
        } catch(e) {
          tenantNumberCache[userId] = process.env.TWILIO_PHONE_NUMBER;
        }
        return tenantNumberCache[userId];
      }

      for (const message of pendingMessages) {
        try {
          // 🚨 BLOCK SPAMMER +12899688778
          if (message.recipient_phone.includes('2899688778') ||
              message.recipient_phone.includes('12899688778')) {
            await updateBulkMessageStatus(message.id, 'blocked', 'Blacklisted number');
            console.log('🚫 BLOCKED SPAMMER:', message.recipient_phone);
            continue;
          }

          // CASL: skip opted-out numbers
          if (await isOptedOut(message.recipient_phone)) {
            await updateBulkMessageStatus(message.id, 'blocked', 'Opted out (STOP)');
            console.log('🚫 SKIPPED OPT-OUT:', message.recipient_phone);
            continue;
          }

          // Per-number cooldown: skip if this phone got bulk SMS in last 24 hours
          const cooldownCheck = await pool.query(
            `SELECT 1 FROM bulk_messages WHERE recipient_phone = $1 AND status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
            [message.recipient_phone]
          );
          if (cooldownCheck.rows.length > 0) {
            // Reschedule for 24 hours later instead of blocking
            await pool.query('UPDATE bulk_messages SET scheduled_at = NOW() + INTERVAL \'24 hours\' WHERE id = $1', [message.id]);
            console.log('⏳ COOLDOWN: rescheduled', message.recipient_phone);
            continue;
          }

          let personalizedMessage = message.message_template.replace(/{name}/g, message.recipient_name);
          // CASL compliance: ensure opt-out footer is present
          const hasStopFooter = /reply\s+stop|text\s+stop|opt.?out/i.test(personalizedMessage);
          if (!hasStopFooter) {
            personalizedMessage += ' (Reply STOP to opt out)';
          }
          const fromNumber = await getTenantFromNumber(message.user_id);
          try {
            const statusCallbackUrl = process.env.BASE_URL ? process.env.BASE_URL + '/api/sms-status' : null;
            const sendOpts = { body: personalizedMessage, from: fromNumber, to: message.recipient_phone };
            if (statusCallbackUrl) sendOpts.statusCallback = statusCallbackUrl;
            const twilioMsg = await twilioClient.messages.create(sendOpts);
            // Store Twilio SID for delivery tracking
            if (twilioMsg.sid) {
              await pool.query('UPDATE bulk_messages SET twilio_sid = $1 WHERE id = $2', [twilioMsg.sid, message.id]);
            }
          } catch (twilioErr) {
            console.error(`❌ Bulk send FAILED to \${message.recipient_name} [\${message.recipient_phone}] — Code: \${twilioErr.code} Msg: \${twilioErr.message}`);
            await updateBulkMessageStatus(message.id, 'failed', `Twilio \${twilioErr.code}: \${twilioErr.message}`);
            continue;
          }

          const conversation = await getOrCreateConversation(message.recipient_phone, message.user_id);
          if (message.recipient_name && !conversation.customer_name) {
            await updateConversation(conversation.id, { customer_name: message.recipient_name });
          }
          await saveMessage(conversation.id, message.recipient_phone, 'assistant', personalizedMessage, message.user_id);
          await updateBulkMessageStatus(message.id, 'sent');
          console.log(`✅ Bulk SMS sent to ${message.recipient_name} [tenant:${message.user_id||'global'}]`);

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
    if (state.bulkSmsProcessor) return;
    console.log('🚀 Bulk SMS processor started');
    console.log(`⚙️  Batch size: ${BULK_BATCH_SIZE}, Interval: ${BULK_INTERVAL_MS}ms`);
    processBulkMessages();
    state.bulkSmsProcessor = setInterval(processBulkMessages, BULK_INTERVAL_MS);
  }

  return { startBulkProcessor, processBulkMessages };
}

module.exports = {
  state,
  createBulkMessagesTable,
  saveBulkCampaign,
  getPendingBulkMessages,
  updateBulkMessageStatus,
  getBulkCampaignStats,
  makeBulkProcessor,
  BULK_BATCH_SIZE,
  BULK_INTERVAL_MS
};

