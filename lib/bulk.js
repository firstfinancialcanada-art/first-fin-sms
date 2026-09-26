const { pool, getOrCreateConversation, updateConversation, saveMessage, isOptedOut, phoneKeys } = require('./db');
const { guardedSmsSend } = require('./spend-cap');
const { normalizePhone, fillTemplate } = require('./helpers');

const BULK_BATCH_SIZE = parseInt(process.env.BULK_BATCH_SIZE) || 5;
const BULK_INTERVAL_MS = parseInt(process.env.BULK_INTERVAL_MS) || 5000;

// ── Shared mutable state ──────────────────────────────────────────
const state = {
  bulkSmsProcessor: null,
  bulkSmsProcessorPaused: false,
  aiResponderPaused: false
};

// ── Table setup ───────────────────────────────────────────────────
// Memoized so the processor can wait for it. index.js calls this without
// awaiting and then starts the processor immediately, so the very first tick
// used to race the migrations — on the deploy that added claimed_at, tick one
// hit "column claimed_at does not exist" before the ALTER had landed. It
// recovered on the next tick, but a processor that throws on boot every time a
// column is added is a trap for whoever adds the next one.
let _schemaReady = null;
async function createBulkMessagesTable() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = _createBulkMessagesTable();
  return _schemaReady;
}

async function _createBulkMessagesTable() {
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
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`).catch(() => {});
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
async function saveBulkCampaign(campaignName, messageTemplate, contacts, userId, mode = 'sales') {
  const client = await pool.connect();
  try {
    const startTime = new Date(Date.now() + 60000);
    const scheduledTimes = contacts.map((_, i) =>
      new Date(startTime.getTime() + (i * 15000))
    );
    if (contacts.length === 0) return [];
    const safeMode = (mode === 'acquisition') ? 'acquisition' : 'sales';
    const valuePlaceholders = contacts.map((_, i) =>
      `($${i*7+1}, $${i*7+2}, $${i*7+3}, $${i*7+4}, $${i*7+5}, $${i*7+6}, $${i*7+7})`
    ).join(', ');
    // Store E.164 so the cooldown and opt-out comparisons downstream are
    // matching on one shape. The CSV importer already normalises; campaigns
    // built straight off the CRM carry whatever the rep typed.
    const flatValues = contacts.flatMap((contact, i) => [
      campaignName, messageTemplate, contact.name,
      normalizePhone(contact.phone) || contact.phone,
      scheduledTimes[i], userId || null, safeMode
    ]);
    const result = await client.query(
      `INSERT INTO bulk_messages (campaign_name, message_template, recipient_name, recipient_phone, scheduled_at, user_id, mode) VALUES ${valuePlaceholders} RETURNING id`,
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

// ── Claim a batch before sending it ─────────────────────────────────────
// The processor used to SELECT rows that were still 'pending', send them, and
// only mark them 'sent' afterwards — with getOrCreateConversation, saveMessage
// and two more updates in between. Anything that interrupted that window left
// the row 'pending' with the customer already texted, and the next tick sent
// it again.
//
// The likelier trigger was never a crash: setInterval fires every 5s and does
// not wait for the previous run, so one slow Twilio batch is enough for two
// runs to overlap and pick up the same rows.
//
// Claiming flips them to 'sending' in the same statement that selects them.
// SKIP LOCKED means a second worker takes the next rows instead of blocking.
async function claimPendingBulkMessages(limit = BULK_BATCH_SIZE) {
  const { rows } = await pool.query(
    `UPDATE bulk_messages SET status = 'sending', claimed_at = NOW()
      WHERE id IN (
        SELECT id FROM bulk_messages
         WHERE status = 'pending' AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit]
  );
  return rows;
}

// ── Rows that were claimed and never resolved ───────────────────────────
// A process that dies mid-send leaves 'sending' behind. We deliberately do NOT
// put these back to 'pending': the customer may well have received the text,
// and texting someone twice is worse than not recording that we texted them
// once. They are parked as 'unknown' and shouted about, for a human to check
// against Twilio's own log.
async function reapStuckBulkMessages(staleMinutes = 15) {
  try {
    const { rows } = await pool.query(
      `UPDATE bulk_messages
          SET status = 'unknown',
              error_message = 'Interrupted mid-send — check Twilio before resending'
        WHERE status = 'sending' AND claimed_at < NOW() - ($1 || ' minutes')::interval
        RETURNING id, recipient_phone, twilio_sid`,
      [String(staleMinutes)]
    );
    if (rows.length) {
      console.error(`⚠️ ${rows.length} bulk message(s) interrupted mid-send and NOT resent:`);
      for (const r of rows) {
        console.error(`   id=${r.id} to=${r.recipient_phone} sid=${r.twilio_sid || '(never reached Twilio)'}`);
      }
    }
  } catch (e) {
    console.error('bulk reaper failed:', e.message);
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
  // setInterval does not wait for an async callback, so a batch that outruns
  // BULK_INTERVAL_MS used to have two runs in flight at once. The claim below
  // makes that safe, this makes it not happen in the first place.
  let running = false;
  let reaperTick = 0;

  async function processBulkMessages() {
    if (state.bulkSmsProcessorPaused) {
      console.log('⏸️  Paused');
      return;
    }
    if (running) return;
    running = true;
    try {
      await createBulkMessagesTable();   // memoized; a no-op after the first call
      // Every ~5 minutes, surface anything a previous run died holding.
      if (++reaperTick % Math.max(1, Math.round(300000 / BULK_INTERVAL_MS)) === 0) {
        await reapStuckBulkMessages();
      }
      const pendingMessages = await claimPendingBulkMessages(BULK_BATCH_SIZE);
      if (pendingMessages.length === 0) return;

      // Build a per-tenant from-number cache for this batch
      // Caches the from-number AND the branding that fills {dealership} /
      // {city} in the campaign script — one lookup per tenant per batch.
      const tenantCache = {};
      async function getTenant(userId) {
        if (!userId) return { from: process.env.TWILIO_PHONE_NUMBER, dealership: process.env.DEALER_NAME || '', city: '' };
        if (tenantCache[userId]) return tenantCache[userId];
        let t = { from: process.env.TWILIO_PHONE_NUMBER, dealership: process.env.DEALER_NAME || '', city: '' };
        try {
          const r = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [userId]);
          const s = r.rows[0]?.settings_json;
          const parsed = typeof s === 'string' ? JSON.parse(s) : (s || {});
          t = {
            from:       parsed.twilioNumber || process.env.TWILIO_PHONE_NUMBER,
            dealership: parsed.dealerName   || process.env.DEALER_NAME || '',
            city:       parsed.dealerCity   || '',
          };
        } catch(e) { /* fall through to env defaults */ }
        tenantCache[userId] = t;
        return t;
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

          // A number we can't parse must never reach Twilio. Terminal
          // 'failed', not 'pending' — a row left pending gets picked up by
          // the very next tick and tries forever, which is how a handful of
          // bad CSV rows once turned into a rolling charge.
          const toNumber = normalizePhone(message.recipient_phone);
          if (!toNumber) {
            await updateBulkMessageStatus(message.id, 'failed', 'Invalid phone number — never sent');
            console.warn('🚫 INVALID NUMBER, not sent:', message.recipient_phone);
            continue;
          }

          // CASL: skip opted-out numbers
          if (await isOptedOut(message.recipient_phone)) {
            await updateBulkMessageStatus(message.id, 'blocked', 'Opted out (STOP)');
            console.log('🚫 SKIPPED OPT-OUT:', message.recipient_phone);
            continue;
          }

          // Per-number cooldown: skip if this phone got bulk SMS in last 24
          // hours. Matched across every stored format — an exact compare let
          // the same person be texted twice in a day under two spellings.
          const cooldownCheck = await pool.query(
            `SELECT 1 FROM bulk_messages
              WHERE recipient_phone = ANY($1) AND user_id IS NOT DISTINCT FROM $2
                AND status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
            [phoneKeys(message.recipient_phone), message.user_id]
          );
          if (cooldownCheck.rows.length > 0) {
            // Reschedule for 24 hours later instead of blocking. Back to
            // 'pending' too — it is claimed right now, and leaving it that way
            // would strand it in 'sending' forever.
            await pool.query(
              "UPDATE bulk_messages SET status = 'pending', claimed_at = NULL, scheduled_at = NOW() + INTERVAL '24 hours' WHERE id = $1",
              [message.id]
            );
            console.log('⏳ COOLDOWN: rescheduled', message.recipient_phone);
            continue;
          }

          const tenant = await getTenant(message.user_id);
          let personalizedMessage = fillTemplate(message.message_template, {
            name: message.recipient_name, dealership: tenant.dealership, city: tenant.city,
          });
          // CASL compliance: ensure opt-out footer is present
          const hasStopFooter = /reply\s+stop|text\s+stop|opt.?out/i.test(personalizedMessage);
          if (!hasStopFooter) {
            personalizedMessage += ' (Reply STOP to opt out)';
          }
          const fromNumber = tenant.from;
          const statusCallbackUrl = process.env.BASE_URL ? process.env.BASE_URL + '/api/sms-status' : null;
          const sendOpts = { body: personalizedMessage, from: fromNumber, to: toNumber };
          if (statusCallbackUrl) sendOpts.statusCallback = statusCallbackUrl;

          const bulkResult = await guardedSmsSend(twilioClient, message.user_id, sendOpts);
          if (!bulkResult.ok) {
            if (bulkResult.reason === 'SPEND_CAP_EXCEEDED') {
              // Pause this tenant's remaining queued messages until next period
              // or overage top-up. Mark as 'paused' (not failed) so they can resume.
              console.warn(`⚠️ Bulk spend-cap hit for user ${message.user_id} — pausing campaign`);
              await pool.query(
                `UPDATE bulk_messages SET status = 'paused', claimed_at = NULL,
                        error_message = 'Paused: monthly Twilio cap reached — top up overage to resume'
                 WHERE user_id = $1 AND status IN ('pending', 'sending')`,
                [message.user_id]
              ).catch(() => {});
              continue;
            }
            const err = bulkResult.error || {};
            console.error(`❌ Bulk send FAILED to ${message.recipient_name} [${message.recipient_phone}] — Code: ${err.code} Msg: ${err.message}`);
            await updateBulkMessageStatus(message.id, 'failed', `Twilio ${err.code}: ${err.message}`);
            continue;
          }
          // Resolve the row FIRST. The conversation bookkeeping below is four
          // more round trips, and anything that interrupts them must not leave
          // a row looking unsent — the customer already has the text.
          await pool.query(
            `UPDATE bulk_messages
                SET status = 'sent', sent_at = NOW(), twilio_sid = COALESCE($1, twilio_sid)
              WHERE id = $2`,
            [bulkResult.sid || null, message.id]
          );

          const conversation = await getOrCreateConversation(message.recipient_phone, message.user_id);
          if (message.recipient_name && !conversation.customer_name) {
            await updateConversation(conversation.id, { customer_name: message.recipient_name });
          }
          if (!conversation.source) {
            await pool.query('UPDATE conversations SET source = $1 WHERE id = $2', ['bulk_sms', conversation.id]).catch(() => {});
          }
          // Phase 7 — propagate campaign mode to the conversation so when
          // the customer replies, Sarah knows whether to run the buy-side
          // (sales) FSM or the seller-side (acquisition) FSM. Only sets
          // mode if it isn't already 'acquisition' — protects an existing
          // acquisition thread from being overwritten by a stray sales
          // campaign on the same number.
          if (message.mode === 'acquisition' && conversation.mode !== 'acquisition') {
            await updateConversation(conversation.id, { mode: 'acquisition', stage: 'acq_confirm' });
          }
          await saveMessage(conversation.id, message.recipient_phone, 'assistant', personalizedMessage, message.user_id);
          console.log(`✅ Bulk SMS sent to ${message.recipient_name} [tenant:${message.user_id||'global'}]`);

        } catch (error) {
          console.error(`❌ Bulk SMS failed for ${message.recipient_name}:`, error.message);
          // The row is marked 'sent' the instant Twilio accepts it, so a throw
          // from the conversation bookkeeping afterwards must not rewrite that
          // to 'failed' — the customer has the text either way, and a false
          // 'failed' is how someone ends up resending by hand.
          await pool.query(
            `UPDATE bulk_messages SET status = 'failed', error_message = $1
              WHERE id = $2 AND status <> 'sent'`,
            [String(error.message || error).slice(0, 300), message.id]
          ).catch(() => {});
        }
      }
    } catch (error) {
      console.error('❌ Bulk processor error:', error);
    } finally {
      running = false;
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
  claimPendingBulkMessages,
  reapStuckBulkMessages,
  updateBulkMessageStatus,
  getBulkCampaignStats,
  makeBulkProcessor,
  BULK_BATCH_SIZE,
  BULK_INTERVAL_MS
};

