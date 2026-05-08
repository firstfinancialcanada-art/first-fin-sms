// routes/sarah.js
const { pool, getOrCreateCustomer, getOrCreateConversation, updateConversation,
        saveMessage, hasActiveConversation, deleteConversation,
        saveAppointment, saveCallback, logAnalytics,
        addOptOut, removeOptOut, isOptedOut } = require('../lib/db');
const { normalizePhone, toE164NorthAmerica, formatPretty, makeTwilioWebhookValidator } = require('../lib/helpers');
const { state } = require('../lib/bulk');
const { guardedSmsSend, recordSpend, reconcileSpend } = require('../lib/spend-cap');
const validateTwilio = makeTwilioWebhookValidator();

module.exports = function sarahRoutes(app, { twilioClient, requireAuth, requireBilling, notifyOwner }) {

  // ── Tenant settings cache — 5 min TTL ────────────────────────────
  const _tenantCache = new Map();
  const TENANT_CACHE_TTL = 5 * 60 * 1000;

  async function getTenantSettings(userId) {
    const cached = _tenantCache.get(userId);
    if (cached && Date.now() - cached.ts < TENANT_CACHE_TTL) return cached.data;
    const result = await pool.query(
      `SELECT settings_json, twilio_number FROM desk_users WHERE id = $1`,
      [userId]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    const parsed = typeof row.settings_json === 'string'
      ? JSON.parse(row.settings_json) : (row.settings_json || {});
    const data = {
      twilioNumber:    row.twilio_number || parsed.twilioNumber  || null,
      notifyPhone:     parsed.notifyPhone   || null,
      dealerName:      parsed.dealerName    || null,
      dealerCity:      parsed.dealerCity    || null,
      googleReviewUrl: parsed.googleReviewUrl || null,
    };
    _tenantCache.set(userId, { data, ts: Date.now() });
    return data;
  }

  function invalidateTenantCache(userId) { _tenantCache.delete(userId); }

  // Expose cache invalidation for desk.js settings save
  app.locals.invalidateTenantCache = invalidateTenantCache;

  // ── Ensure twilio_number index exists ─────────────────────────────
  ;(async () => {
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_desk_users_twilio_number
        ON desk_users(twilio_number)
        WHERE twilio_number IS NOT NULL
      `);
    } catch(e) { /* index already exists or schema issue */ }
  })();

  // ── Sarah modes + acquisition fields (Phase 7) ─────────────────────
  // Adds a 'mode' switch on conversations + the columns the acquisition
  // FSM populates (vehicle being sold, mileage, condition, asking price,
  // replacement interest). Plus trade-in fields used by BOTH modes — the
  // sales flow asks "got a trade?" before booking, the acquisition flow
  // asks "looking to replace it?" — same fields, opposite lead direction.
  // Idempotent ALTER ADD COLUMN IF NOT EXISTS so re-deploys are no-ops.
  ;(async () => {
    try {
      await pool.query(`
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'sales';
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source VARCHAR(40);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_make    VARCHAR(60);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_model   VARCHAR(80);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_year    INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_mileage INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_condition VARCHAR(50);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS asking_price   INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS replacement_interest BOOLEAN;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_make  VARCHAR(60);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_model VARCHAR(80);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_year  INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_value INTEGER;
      `);
      // bulk_messages carries the campaign mode through to the processor so
      // the conversation it creates inherits the right mode.
      await pool.query(`
        ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'sales';
      `);
      console.log('✅ conversations.mode + acquisition/trade-in columns ready');
    } catch(e) { console.warn('Sarah modes schema:', e.message); }
  })();


  // ── Dashboard stats ───────────────────────────────────────────
  app.get('/api/dashboard', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const customers      = await client.query('SELECT COUNT(*) as count FROM customers WHERE user_id = $1', [uid]);
      const conversations  = await client.query('SELECT COUNT(*) as count FROM conversations WHERE user_id = $1', [uid]);
      const messages       = await client.query('SELECT COUNT(*) as count FROM messages WHERE user_id = $1', [uid]);
      const appointments   = await client.query('SELECT * FROM appointments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25', [uid]);
      const callbacks      = await client.query('SELECT * FROM callbacks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25', [uid]);
      res.json({
        stats: {
          totalCustomers:     parseInt(customers.rows[0].count),
          totalConversations: parseInt(conversations.rows[0].count),
          totalMessages:      parseInt(messages.rows[0].count),
          totalAppointments:  appointments.rows.length,
          totalCallbacks:     callbacks.rows.length
        },
        recentAppointments: appointments.rows,
        recentCallbacks:    callbacks.rows
      });
    } catch (error) {
      res.json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ── All conversations ─────────────────────────────────────────
  app.get('/api/conversations', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT ON (c.customer_phone)
          c.id, c.customer_phone,
          cu.name as customer_name,
          c.stage, c.status, c.vehicle_type, c.budget,
          c.started_at, c.updated_at,
          (SELECT COUNT(*) FROM messages m
           JOIN conversations cx ON m.conversation_id = cx.id
           WHERE cx.customer_phone = c.customer_phone AND cx.user_id = $1) as message_count,
          (SELECT m2.content FROM messages m2
           JOIN conversations cx2 ON m2.conversation_id = cx2.id
           WHERE cx2.customer_phone = c.customer_phone AND cx2.user_id = $1
           ORDER BY m2.created_at DESC LIMIT 1) as last_message
        FROM conversations c
        LEFT JOIN customers cu ON c.customer_phone = cu.phone AND cu.user_id = $1
        WHERE c.user_id = $1
        ORDER BY c.customer_phone, c.updated_at DESC
      `, [uid]);
      result.rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      res.json(result.rows.slice(0, 50));
    } catch (error) {
      res.json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Single conversation history ───────────────────────────────
  app.get('/api/conversation/:phone', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const { phone } = req.params;
      const conversation = await client.query(
        'SELECT * FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 1',
        [phone, uid]
      );
      if (conversation.rows.length === 0) {
        return res.json({ error: 'No conversation found' });
      }
      const allConvIds = await client.query(
        'SELECT id FROM conversations WHERE customer_phone = $1 AND user_id = $2',
        [phone, uid]
      );
      const ids = allConvIds.rows.map(r => r.id);
      let messages;
      if (ids.length === 1) {
        messages = await client.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [ids[0]]);
      } else {
        messages = await client.query('SELECT * FROM messages WHERE conversation_id = ANY($1) ORDER BY created_at ASC', [ids]);
      }
      res.json({ conversation: conversation.rows[0], messages: messages.rows });
    } catch (error) {
      res.json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Delete conversation ───────────────────────────────────────
  app.delete('/api/conversation/:phone', requireAuth, requireBilling, async (req, res) => {
    try {
      const { phone } = req.params;
      const deleted = await deleteConversation(phone, req.user.userId);
      if (deleted) {
        res.json({ success: true, message: 'Conversation deleted' });
      } else {
        res.json({ success: false, error: 'Conversation not found' });
      }
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

  // ── Delete appointment ────────────────────────────────────────
  app.delete('/api/appointment/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      await client.query('DELETE FROM appointments WHERE id = $1 AND user_id = $2', [id, req.user.userId]);
      console.log('✅ Appointment deleted:', id);
      res.json({ success: true, message: 'Appointment deleted' });
    } catch (error) {
      console.error('Error deleting appointment:', error);
      res.json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Delete callback ───────────────────────────────────────────
  app.delete('/api/callback/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      await client.query('DELETE FROM callbacks WHERE id = $1 AND user_id = $2', [id, req.user.userId]);
      console.log('✅ Callback deleted:', id);
      res.json({ success: true, message: 'Callback deleted' });
    } catch (error) {
      console.error('Error deleting callback:', error);
      res.json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Manual reply ──────────────────────────────────────────────
  app.post('/api/manual-reply', requireAuth, requireBilling, async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) return res.json({ success: false, error: 'Phone and message required' });
      // CASL: block replies to opted-out customers (global opt-out table + conversation status)
      if (await isOptedOut(phone)) {
        return res.json({ success: false, error: 'This number is on the global opt-out list. They must reply START to re-subscribe.' });
      }
      const stoppedCheck = await pool.query(
        `SELECT status FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1`,
        [phone, req.user.userId]
      );
      if (stoppedCheck.rows[0]?.status === 'stopped') {
        return res.json({
          success: false,
          error: 'This customer has opted out (replied STOP). They must reply START before you can contact them.'
        });
      }
      const conversation = await getOrCreateConversation(phone, req.user.userId);
      await saveMessage(conversation.id, phone, 'assistant', message, req.user.userId);
      await logAnalytics('manual_reply_sent', phone, { message }, req.user.userId);
      // Use tenant's twilio number for outbound
      let manualFromNumber = process.env.TWILIO_PHONE_NUMBER;
      try {
        const ts = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [req.user.userId]);
        const sp = typeof ts.rows[0]?.settings_json === 'string' ? JSON.parse(ts.rows[0].settings_json) : (ts.rows[0]?.settings_json || {});
        if (sp.twilioNumber) manualFromNumber = sp.twilioNumber;
      } catch(e) {}
      const sendResult = await guardedSmsSend(twilioClient, req.user.userId, {
        body: message, from: manualFromNumber, to: phone
      });
      if (!sendResult.ok && sendResult.reason === 'SPEND_CAP_EXCEEDED') {
        return res.status(402).json({
          success: false, code: 'SPEND_CAP_EXCEEDED',
          error: 'Monthly Twilio cap reached. Top up overage balance to continue sending.',
          usage: sendResult.usage, needCents: sendResult.needCents,
        });
      }
      if (!sendResult.ok) throw sendResult.error || new Error('SMS send failed');
      console.log('✅ Manual reply sent to:', phone);
      res.json({ success: true, message: 'Reply sent!' });
    } catch (error) {
      console.error('❌ Error sending manual reply:', error);
      res.json({ success: false, error: error.message });
    }
  });

  // ── Start SMS campaign ────────────────────────────────────────
  app.post('/api/start-sms', requireAuth, requireBilling, async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone) return res.json({ success: false, error: 'Phone number required' });
      const normalizedPhone = toE164NorthAmerica(phone);
      if (!normalizedPhone) return res.json({ success: false, error: 'Invalid phone number format' });
      const hasActive = await hasActiveConversation(normalizedPhone, req.user.userId);
      if (hasActive) {
        return res.json({
          success: false,
          error: 'This customer already has an active conversation. Check "Recent Conversations" below to continue their conversation.'
        });
      }
      // CASL: block if customer has previously opted out
      const stoppedCheck = await pool.query(
        `SELECT status FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1`,
        [normalizedPhone, req.user.userId]
      );
      if (stoppedCheck.rows[0]?.status === 'stopped') {
        return res.json({
          success: false,
          error: 'This number has opted out (replied STOP). You cannot contact them unless they reply START.'
        });
      }
      // Resolve dealer name from tenant settings (TENANT_DEALER_NAME is only scoped to the webhook handler)
      let tenantName = 'the dealership';
      try {
        const ts = await getTenantSettings(req.user.userId);
        if (ts?.dealerName) tenantName = ts.dealerName;
      } catch(e) {}
      const messageBody = message || `Hi! 👋 I'm Sarah from ${tenantName}. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)`;
      const uid = req.user.userId;
      await getOrCreateCustomer(normalizedPhone, uid);
      const conversation = await getOrCreateConversation(normalizedPhone, uid);
      if (!conversation.source) {
        await pool.query('UPDATE conversations SET source = $1 WHERE id = $2', ['manual', conversation.id]).catch(() => {});
      }
      await saveMessage(conversation.id, normalizedPhone, 'assistant', messageBody, uid);
      await logAnalytics('sms_sent', normalizedPhone, { messageBody }, uid);
      // Use tenant's twilio number for outbound
      let startFromNumber = process.env.TWILIO_PHONE_NUMBER;
      try {
        const ts = await getTenantSettings(uid);
        if (ts?.twilioNumber) startFromNumber = ts.twilioNumber;
      } catch(e) {}
      const startResult = await guardedSmsSend(twilioClient, uid, {
        body: messageBody, from: startFromNumber, to: normalizedPhone
      });
      if (!startResult.ok && startResult.reason === 'SPEND_CAP_EXCEEDED') {
        return res.status(402).json({
          success: false, code: 'SPEND_CAP_EXCEEDED',
          error: 'Monthly Twilio cap reached. Top up overage balance to continue sending.',
          usage: startResult.usage, needCents: startResult.needCents,
        });
      }
      if (!startResult.ok) throw startResult.error || new Error('SMS send failed');
      console.log('✅ SMS sent to:', normalizedPhone);
      res.json({ success: true, message: 'SMS sent!' });
    } catch (error) {
      console.error('❌ Error sending SMS:', error);
      res.json({ success: false, error: error.message });
    }
  });

  // ── SMS Delivery Status Callback (Twilio) ─────────────────────
  // Twilio POSTs here after each message status transition. Final 'delivered'
  // or 'failed' events typically include Price (negative decimal string in
  // account currency), which we reconcile against the at-send-time estimate
  // stored in tenant_spend_events so tenant_usage.sms_spend_cents reflects
  // actual Twilio billing rather than our 1¢/segment approximation.
  app.post('/api/sms-status', async (req, res) => {
    try {
      const { MessageSid, MessageStatus, Price } = req.body;
      if (MessageSid && MessageStatus) {
        await pool.query(
          'UPDATE bulk_messages SET delivery_status = $1 WHERE twilio_sid = $2',
          [MessageStatus, MessageSid]
        );
      }
      if (MessageSid && Price) {
        const actualCents = Math.round(Math.abs(parseFloat(Price)) * 100);
        if (Number.isFinite(actualCents)) {
          await reconcileSpend(MessageSid, actualCents);
        }
      }
    } catch (e) {
      console.error('❌ sms-status callback error:', e.message);
    }
    res.status(200).send('<Response></Response>');
  });

  // ── SMS Webhook (Twilio) ──────────────────────────────────────
  app.post('/api/sms-webhook', validateTwilio, async (req, res) => {
    // Phase 1: resolve tenant from Twilio 'To' number
    const toNumber = req.body.To || process.env.TWILIO_PHONE_NUMBER;
    let WEBHOOK_USER_ID;

    // Helper: fall back to the tenant whose twilio_number matches the master env number.
    // This covers: unprovisioned tenants, demo mode texts, and mis-routed messages.
    // Never falls back to "first in DB" which is order-dependent and fragile.
    async function resolveFallbackTenant() {
      const masterNumber = process.env.TWILIO_PHONE_NUMBER;
      if (masterNumber) {
        const r = await pool.query(
          `SELECT id FROM desk_users WHERE twilio_number = $1 LIMIT 1`, [masterNumber]
        );
        if (r.rows.length) return r.rows[0].id;
      }
      // Last resort: owner account (exempt email) — predictable, not order-dependent
      const ownerEmail = process.env.OWNER_EMAIL || 'kevlarkarz@gmail.com';
      const r = await pool.query(
        `SELECT id FROM desk_users WHERE email = $1 LIMIT 1`, [ownerEmail]
      );
      return r.rows[0]?.id || null;
    }

    try {
      const tenantResult = await pool.query(
        `SELECT id FROM desk_users WHERE twilio_number = $1 LIMIT 1`,
        [toNumber]
      );
      if (tenantResult.rows.length > 0) {
        WEBHOOK_USER_ID = tenantResult.rows[0].id;
      } else {
        console.log(`⚠️ No tenant for number ${toNumber} — using fallback`);
        WEBHOOK_USER_ID = await resolveFallbackTenant();
      }
    } catch(e) {
      console.error('⚠️ Tenant lookup failed:', e.message);
      try { WEBHOOK_USER_ID = await resolveFallbackTenant(); } catch(e2) {}
    }
    if (!WEBHOOK_USER_ID) {
      console.error('❌ No tenant found for webhook');
      return res.status(500).send('No tenant');
    }

    // Fetch tenant settings (cached) + inventory in parallel
    let TENANT_FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
    let TENANT_NOTIFY_PHONE = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;
    let TENANT_DEALER_NAME  = process.env.DEALER_NAME  || 'First Financial Auto';
    let TENANT_DEALER_CITY  = process.env.DEALER_CITY  || 'Calgary, AB';
    let TENANT_INVENTORY    = [];
    try {
      const [ts, invResult] = await Promise.all([
        getTenantSettings(WEBHOOK_USER_ID),
        pool.query(
          `SELECT year, make, model, mileage, price, type, condition, stock
           FROM desk_inventory WHERE user_id = $1 AND status = 'available'
           ORDER BY year DESC LIMIT 20`,
          [WEBHOOK_USER_ID]
        )
      ]);
      if (ts) {
        if (ts.twilioNumber) TENANT_FROM_NUMBER  = ts.twilioNumber;
        if (ts.notifyPhone)  TENANT_NOTIFY_PHONE = ts.notifyPhone;
        if (ts.dealerName)   TENANT_DEALER_NAME  = ts.dealerName;
        if (ts.dealerCity)   TENANT_DEALER_CITY  = ts.dealerCity;
      }
      TENANT_INVENTORY = invResult.rows;
    } catch(e) { console.error('⚠️ Tenant settings/inventory fetch failed:', e.message); }

    try {
      const { From: phone, Body: message } = req.body;
      console.log('📩 Received from:', phone);
      console.log('💬 Message:', message);

      // Respond to Twilio IMMEDIATELY (prevents retries/duplicates)
      res.type('text/xml').send('<Response></Response>');

      // Background processing
      (async () => {
        try {
          // ── Dedup: block if this MessageSid was already processed ──
          const msgSid = req.body.MessageSid || req.body.SmsSid || '';
          if (msgSid) {
            const sidKey = `twilio_sid_${msgSid}`;
            if (global._processedSids && global._processedSids.has(sidKey)) {
              console.log('[WEBHOOK] Duplicate MessageSid blocked:', msgSid);
              return;
            }
            if (!global._processedSids) global._processedSids = new Set();
            global._processedSids.add(sidKey);
            // Clean up after 5 minutes to prevent memory growth
            setTimeout(() => { if (global._processedSids) global._processedSids.delete(sidKey); }, 5 * 60 * 1000);
          }

          const _wd = String(phone).replace(/\D/g,'');
          const _nanp = (_wd.length===10&&_wd[0]>='2')||(_wd.length===11&&_wd.startsWith('1')&&_wd[1]>='2');
          if (!_nanp) { console.log('[WEBHOOK] Non-NANP blocked:', phone); return; }
          if (state.aiResponderPaused) { console.log('[WEBHOOK] AI paused, skipping', phone); return; }

          await getOrCreateCustomer(phone, WEBHOOK_USER_ID);

          // Phase 6: bump desk_crm.last_contact whenever the customer
          // texts in. Lets the 'Last Activity' column on the manager's
          // CRM dashboard reflect every inbound engagement, not just
          // explicit notes-panel saves. Fire-and-forget; CRM might not
          // have a row for this phone yet (the lead might come from
          // SMS-first not ADF-first), in which case the UPDATE is a
          // no-op. Match on the last 10 digits so format variance
          // (+1 prefix, dashes, etc.) doesn't miss the row.
          pool.query(
            `UPDATE desk_crm
             SET last_contact = NOW(), updated_at = NOW()
             WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10)
                 = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
               AND tenant_id IN (
                 SELECT tenant_id FROM desk_members WHERE user_id = $2 AND active = TRUE
               )`,
            [phone, WEBHOOK_USER_ID]
          ).catch((e) => console.warn('crm last_contact bump failed:', e.message));

          const lowerBody = message.toLowerCase().trim();
          const isStartCmd = lowerBody === 'start' || lowerBody.includes('resubscribe');
          const isStopCmd  = lowerBody === 'stop' || lowerBody.startsWith('stop') || lowerBody.includes('unsubscribe');

          const recentConvResult = await pool.query(
            'SELECT * FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1',
            [phone, WEBHOOK_USER_ID]
          );
          const recentConv = recentConvResult.rows[0];

          if (recentConv && recentConv.status === 'stopped' && !isStartCmd && !isStopCmd) {
            await twilioClient.messages.create({
              body: "You're currently unsubscribed. Reply START to receive messages again.",
              from: TENANT_FROM_NUMBER,
              to: phone
            });
            return;
          }

          const conversation = await getOrCreateConversation(phone, WEBHOOK_USER_ID);
          // Set source if new conversation (source will be null on first message)
          if (!conversation.source) {
            await pool.query('UPDATE conversations SET source = $1 WHERE id = $2', ['inbound', conversation.id]).catch(() => {});
          }

          // Mark conversation as 'engaged' on first customer reply (was 'active' = outreach sent, no reply yet)
          if (conversation.status === 'active' && !isStopCmd && !isStartCmd) {
            await updateConversation(conversation.id, { status: 'engaged' });
            conversation.status = 'engaged';
          }

          await saveMessage(conversation.id, phone, 'user', message, WEBHOOK_USER_ID);
          try { await logAnalytics('message_received', phone, { message }, WEBHOOK_USER_ID); } catch(e) { console.error('Analytics error:', e.message); }

          const aiResponse = await getJerryResponse(phone, message, conversation, WEBHOOK_USER_ID, TENANT_FROM_NUMBER, TENANT_NOTIFY_PHONE, TENANT_DEALER_NAME, TENANT_DEALER_CITY, TENANT_INVENTORY);
          await saveMessage(conversation.id, phone, 'assistant', aiResponse, WEBHOOK_USER_ID);

          try {
            const sarahSend = await guardedSmsSend(twilioClient, WEBHOOK_USER_ID, {
              body: aiResponse, from: TENANT_FROM_NUMBER, to: phone
            });
            if (sarahSend.ok) {
              console.log('✅ Sarah replied:', aiResponse);
              // Phase 6: bump CRM last_contact when Sarah successfully replies.
              // Together with the inbound bump above, this gives the manager's
              // 'Last Activity' column a true picture of engagement over time.
              pool.query(
                `UPDATE desk_crm
                 SET last_contact = NOW(), updated_at = NOW()
                 WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10)
                     = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
                   AND tenant_id IN (
                     SELECT tenant_id FROM desk_members WHERE user_id = $2 AND active = TRUE
                   )`,
                [phone, WEBHOOK_USER_ID]
              ).catch((e) => console.warn('crm last_contact bump (sarah reply) failed:', e.message));
            } else if (sarahSend.reason === 'SPEND_CAP_EXCEEDED') {
              console.warn(`⚠️ SARAH reply BLOCKED by spend cap for user ${WEBHOOK_USER_ID} → ${phone}`);
              try {
                await logAnalytics('sms_cap_blocked', phone, {
                  usage: sarahSend.usage, need_cents: sarahSend.needCents,
                  attempted_message: aiResponse.substring(0, 100)
                }, WEBHOOK_USER_ID);
              } catch(e) {}
            } else {
              const err = sarahSend.error || {};
              console.error(`❌ Sarah send FAILED to ${phone} — Code: ${err.code} Status: ${err.status} Msg: ${err.message}`);
              try {
                await logAnalytics('sms_send_failed', phone, {
                  error_code: err.code, error_message: err.message,
                  attempted_message: aiResponse.substring(0, 100)
                }, WEBHOOK_USER_ID);
              } catch(e) {}
            }
          } catch (outerErr) {
            console.error(`❌ Sarah outer send error to ${phone}:`, outerErr.message);
          }

          const custName  = conversation.customer_name || 'Unknown';
          const custPhone = formatPretty(phone);
          const preview   = message.length > 100 ? message.substring(0, 100) + '...' : message;
          // Only notify dealer on first contact (new lead) — stage-change events
          // (appt booked, callback) send their own dedicated alerts already.
          // Notifying on every reply is too noisy for active conversations.
          const isFirstContact = conversation.stage === 'greeting' ||
            (await pool.query(
              'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = $1',
              [conversation.id]
            )).rows[0]?.cnt <= 2;
          if (TENANT_NOTIFY_PHONE && isFirstContact) {
            guardedSmsSend(twilioClient, WEBHOOK_USER_ID, {
              body: `💬 New lead from ${custName}\n📞 ${custPhone}\n\n"${preview}"\n\nReply via: app.firstfinancialcanada.com`,
              from: TENANT_FROM_NUMBER,
              to: TENANT_NOTIFY_PHONE
            }).then(r => {
              if (r.ok) console.log(`✅ New lead notify sent to ${TENANT_NOTIFY_PHONE}`);
              else if (r.reason === 'SPEND_CAP_EXCEEDED') console.warn(`⚠️ Notify skipped (spend cap) for user ${WEBHOOK_USER_ID}`);
              else console.error(`❌ Notify FAILED to ${TENANT_NOTIFY_PHONE}: ${r.error?.message} (code ${r.error?.code})`);
            }).catch(err => {
              console.error(`❌ Notify send error: ${err.message}`);
            });
          } else if (!TENANT_NOTIFY_PHONE) {
            console.warn('⚠️ No notify phone configured — skipping lead alert');
          }

        } catch (bgError) {
          console.error('❌ Background processing error:', bgError);
        }
      })();

    } catch (error) {
      console.error('❌ Webhook error:', error);
      res.type('text/xml').send('<Response></Response>');
    }
  });

  // ── Sarah / Jerry AI Logic ────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────
  // ACQUISITION MODE — Sarah is reaching out to a prospective seller
  // (Kijiji private listing, etc.) instead of a buyer. Mirrors the design
  // of getJerryResponse (rule-based FSM, no LLM, on-rails by design) but
  // with stages tuned for "buy a car FROM the customer" instead of "sell
  // a car TO the customer". Both flows always land on appointment OR
  // callback per Franco's universal rule.
  //
  // Stages (conversation.stage values used in acquisition mode):
  //   acq_confirm        — opener replied to; confirm vehicle + intent
  //   acq_mileage        — capture km/mi
  //   acq_condition      — accidents, mods, owners, overall shape
  //   acq_asking_price   — what they want for it
  //   acq_replacement    — Mil's pivot: are they also looking to buy?
  //   acq_appointment    — appraisal vs callback choice
  //   name / datetime / confirmed — shared with sales mode
  // ────────────────────────────────────────────────────────────────────
  async function getAcquisitionResponse(phone, message, conversation, userId, fromNumber, notifyPhone, dealerName = 'the dealership', dealerCity = 'our location') {
    const lowerMsg = message.toLowerCase().trim();
    const name = conversation.customer_name || '';
    function pick(...opts) { return opts[Math.floor(Math.random() * opts.length)]; }

    // ── Universal handlers (mirror sales mode) ─────────────────────
    // STOP / unsubscribe
    if (lowerMsg === 'stop' || /^stop[^a-z]/i.test(message.trim()) ||
        lowerMsg.includes('unsubscribe') || lowerMsg.includes('opt out') || lowerMsg.includes('opt-out')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await addOptOut(phone, 'sms_stop');
      await logAnalytics('conversation_stopped', phone, { mode: 'acquisition' }, userId);
      return "You've been unsubscribed and won't receive further messages. Reply START anytime to resume.";
    }
    if (lowerMsg === 'start' || lowerMsg.includes('resubscribe') || lowerMsg.includes('opt in')) {
      await updateConversation(conversation.id, { status: 'active', stage: 'acq_confirm' });
      await removeOptOut(phone);
      return `Welcome back! I'm Sarah from ${dealerName}. Are you still considering selling your vehicle?`;
    }
    if (conversation.status === 'stopped') return "You're currently unsubscribed. Reply START to receive messages again.";

    // "Already sold it" / "already in the works with someone" — graceful exit + door open
    if (lowerMsg.includes('already sold') || lowerMsg.includes('sold it') ||
        lowerMsg.includes('already gone') || lowerMsg.includes('found a buyer') ||
        lowerMsg.includes('not selling anymore') || lowerMsg.includes("don't want to sell")) {
      await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
      if (!name) {
        return pick(
          "All good — congrats on the sale! 🎉 If you ever have another vehicle to sell or are looking to buy something next, we'd love the chance. What's your name? I'll keep you on file.",
          "Got it — congrats! 🎉 If something else comes up down the road, just text me. What's your name?"
        );
      }
      return `Congrats ${name}! 🎉 If something else comes up — selling, trading, or buying — we'd love the chance. Want a quick call from our team to introduce themselves?`;
    }

    // Hard "not interested" — same handling as sales mode
    if (lowerMsg.includes('not interested') || lowerMsg.includes('no thanks') || lowerMsg.includes('wrong number') ||
        lowerMsg.includes('leave me alone') || lowerMsg.includes('remove me') || lowerMsg.includes('do not contact') ||
        lowerMsg === 'no' || lowerMsg === 'nah' || lowerMsg === 'nope' || lowerMsg.includes('go away')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await logAnalytics('conversation_stopped', phone, { reason: 'not_interested', mode: 'acquisition' }, userId);
      return "No worries! I've taken you off our list. If anything changes — selling, buying, or trading — just text back anytime.";
    }

    // ── STAGE: acq_confirm — opener replied to ─────────────────────
    // Default initial stage for acquisition; "Yes" / "I am" / "sure"
    // affirms; numbers in this stage we treat as mileage (skip ahead).
    if (!conversation.stage || conversation.stage === 'greeting' || conversation.stage === 'acq_confirm') {
      // Negative — they said no / not really / not sure
      if (lowerMsg === 'no' || lowerMsg === 'nah' || lowerMsg === 'nope' ||
          lowerMsg.includes('not really') || lowerMsg.includes('not sure') ||
          lowerMsg.includes('maybe later') || lowerMsg.includes('thinking about')) {
        await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
        if (!name) return "No worries! If you ever decide to, we'd love the chance to give you a fair offer — and we can also help if you're looking for something next. What's your name? I'll have someone follow up later.";
        return `${name}, no rush! When you're ready, we'd love the chance — and if you're also looking for something next, we can line that up too. Want a quick call now or later?`;
      }
      // Positive confirm — yes, sure, considering, looking to sell
      if (lowerMsg === 'yes' || lowerMsg === 'yep' || lowerMsg === 'sure' || lowerMsg === 'i am' ||
          lowerMsg.includes('selling') || lowerMsg.includes('considering') || lowerMsg.includes('thinking of') ||
          lowerMsg.includes('looking to sell') || lowerMsg.includes('want to sell') ||
          lowerMsg.includes('would sell') || lowerMsg.includes('open to')) {
        await updateConversation(conversation.id, { stage: 'acq_mileage' });
        return pick(
          "Great! What's the current mileage on it? (km or miles is fine)",
          "Awesome — to get you a real offer I'll need a couple quick details. What's the mileage?"
        );
      }
      // Customer said wrong direction — "I'm buying not selling" or similar
      if (lowerMsg.includes('not selling') || lowerMsg.includes("i'm buying") || lowerMsg.includes('looking to buy') ||
          lowerMsg.includes('want to buy')) {
        // Pivot: switch them to sales mode and acknowledge
        await updateConversation(conversation.id, { mode: 'sales', stage: 'greeting' });
        return "Oh got it — I had you down as a potential seller but if you're looking to buy, we can absolutely help! Are you thinking Car, Truck, Van, or SUV?";
      }
      // Number alone — treat as mileage if reasonable
      const acqNumbers = message.match(/\d[\d,]*/g);
      if (acqNumbers && acqNumbers.length === 1) {
        const num = parseInt(acqNumbers[0].replace(/,/g, ''));
        if (num >= 1000 && num <= 500000) {
          await updateConversation(conversation.id, { vehicle_mileage: num, stage: 'acq_condition' });
          return `Got it — ${num.toLocaleString()} km. How's the condition? Any accidents, major repairs, or modifications I should know about?`;
        }
      }
      // Default — re-confirm
      return pick(
        "Just to confirm — are you still considering selling your vehicle? A simple yes or no is fine.",
        "Sorry if I caught you at a weird time — are you open to selling? Yes or no, no pressure either way."
      );
    }

    // ── STAGE: acq_mileage ─────────────────────────────────────────
    if (conversation.stage === 'acq_mileage' && !conversation.vehicle_mileage) {
      const numbers = message.match(/\d[\d,]*/g);
      if (numbers) {
        let n = parseInt(numbers[0].replace(/,/g, ''));
        if (lowerMsg.includes('k')) n *= 1000;
        if (n >= 1000 && n <= 500000) {
          await updateConversation(conversation.id, { vehicle_mileage: n, stage: 'acq_condition' });
          return pick(
            `Got it — ${n.toLocaleString()} km. How's the overall condition? Any accidents, repairs, or modifications worth mentioning?`,
            `${n.toLocaleString()} km, noted. What's the condition like? Accidents, mods, or anything I should flag?`
          );
        }
      }
      return "Just need a rough number — like 80,000 or 150k. Whatever's close.";
    }

    // ── STAGE: acq_condition ───────────────────────────────────────
    if (conversation.stage === 'acq_condition' && !conversation.vehicle_condition) {
      // Categorize roughly so the closer has a snapshot
      let cond = null;
      if (lowerMsg.includes('mint') || lowerMsg.includes('excellent') || lowerMsg.includes('like new') ||
          lowerMsg.includes('immaculate') || lowerMsg.includes('perfect')) cond = 'Excellent';
      else if (lowerMsg.includes('good') || lowerMsg.includes('clean') || lowerMsg.includes('great shape') ||
          lowerMsg.includes('well maintained') || lowerMsg === 'no accidents' || lowerMsg.includes('no accidents')) cond = 'Good';
      else if (lowerMsg.includes('fair') || lowerMsg.includes('decent') || lowerMsg.includes('average') ||
          lowerMsg.includes('minor') || lowerMsg.includes('small dent') || lowerMsg.includes('scratch')) cond = 'Fair';
      else if (lowerMsg.includes('rough') || lowerMsg.includes('accident') || lowerMsg.includes('damage') ||
          lowerMsg.includes('rebuilt') || lowerMsg.includes('salvage') || lowerMsg.includes('mechanical')) cond = 'Needs Work';
      else cond = message.slice(0, 50); // Free-text capture if unclassifiable
      await updateConversation(conversation.id, { vehicle_condition: cond, stage: 'acq_asking_price' });
      return pick(
        "Thanks. What are you hoping to get for it?",
        "Got it. What number are you hoping to sell it for?",
        "Noted. Ballpark — what would you want for it?"
      );
    }

    // ── STAGE: acq_asking_price ────────────────────────────────────
    if (conversation.stage === 'acq_asking_price' && !conversation.asking_price) {
      const numbers = message.match(/\d[\d,]*/g);
      if (numbers) {
        let n = parseInt(numbers[0].replace(/,/g, ''));
        if (lowerMsg.includes('k') && n < 1000) n *= 1000;
        if (n >= 500 && n <= 500000) {
          await updateConversation(conversation.id, { asking_price: n, stage: 'acq_replacement' });
          return pick(
            `$${n.toLocaleString()} — got it. Quick question while we're at it: are you also looking to replace it with something? We could line up the appraisal AND a test drive at the same visit.`,
            `Noted — $${n.toLocaleString()}. One more thing: are you considering buying something next? If so we can do both at once and save you a trip.`
          );
        }
      }
      // Customer said "not sure" or "what's it worth" — they want our opinion
      if (lowerMsg.includes('not sure') || lowerMsg.includes("don't know") || lowerMsg.includes("what's it worth") ||
          lowerMsg.includes('what would you offer') || lowerMsg.includes('open to offers') || lowerMsg.includes('best offer')) {
        await updateConversation(conversation.id, { asking_price: 0, stage: 'acq_replacement' });
        return pick(
          "All good — we can put a real number on it once we see it in person. Quick question: are you also looking to replace it with something? We can do both in one visit.",
          "No problem — we'll give you a fair appraisal once we look at it. While we're at it, are you also looking for something next? Trade-in often makes the math work better."
        );
      }
      return "Just a rough number is fine — even a range like $8k–$10k. Or 'not sure' if you'd like an offer from us.";
    }

    // ── STAGE: acq_replacement — the Mil pivot ─────────────────────
    if (conversation.stage === 'acq_replacement' && conversation.replacement_interest == null) {
      if (lowerMsg === 'yes' || lowerMsg === 'yep' || lowerMsg === 'sure' || lowerMsg === 'maybe' ||
          lowerMsg.includes('looking') || lowerMsg.includes('interested') || lowerMsg.includes('thinking about') ||
          lowerMsg.includes('would like') || lowerMsg.includes('want to')) {
        await updateConversation(conversation.id, { replacement_interest: true, stage: 'acq_appointment' });
        return pick(
          "Perfect — that's how most of our deals work. Want to come in for a free appraisal and check out a few options at the same time? Or would a quick call to line it up first work better?",
          "Awesome — we'll put both together. Easier to come by in person for the appraisal + look at options, or do you want a quick call first?"
        );
      }
      if (lowerMsg === 'no' || lowerMsg === 'nope' || lowerMsg === 'nah' ||
          lowerMsg.includes('not looking') || lowerMsg.includes("don't need") || lowerMsg.includes('just selling') ||
          lowerMsg.includes('not interested in buying')) {
        await updateConversation(conversation.id, { replacement_interest: false, stage: 'acq_appointment' });
        return pick(
          "All good — selling only. Want to come in for a free appraisal, or would a quick call from our buyer work better first?",
          "Got it. Free appraisal in person, or a quick call to talk numbers — what's easier for you?"
        );
      }
      // Customer named a vehicle type / make in the response
      const replWords = ['truck','suv','car','sedan','van','minivan','jeep','ram','ford','chevy','toyota','honda'];
      if (replWords.some(w => lowerMsg.includes(w))) {
        await updateConversation(conversation.id, { replacement_interest: true, stage: 'acq_appointment' });
        return "Nice — we'll have options ready. Easier to come in for the appraisal + a look around, or want a call first?";
      }
      return "Yes or no is fine — looking to replace it, or just selling?";
    }

    // ── STAGE: acq_appointment — book or callback ─────────────────
    if (conversation.stage === 'acq_appointment' && !conversation.intent) {
      if (lowerMsg.includes('come') || lowerMsg.includes('visit') || lowerMsg.includes('appraisal') ||
          lowerMsg.includes('in person') || lowerMsg.includes('drop by') || lowerMsg.includes('show') ||
          lowerMsg.includes('book') || lowerMsg.includes('appointment')) {
        await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when works best to come in? We're flexible — mornings, afternoons, evenings, weekends.`
          : "Sounds great! What's your name so I can get the appraisal lined up?";
      }
      if (lowerMsg.includes('call') || lowerMsg.includes('phone') || lowerMsg.includes('talk') ||
          lowerMsg.includes('reach') || lowerMsg.includes('contact') || lowerMsg.includes('ring')) {
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when's the best time for our buyer to give you a call?`
          : "Got it — what's your name? I'll have our buyer reach out.";
      }
      if (lowerMsg.includes('maybe') || lowerMsg.includes('not sure') || lowerMsg.includes('think') || lowerMsg.includes('busy')) {
        return `No rush${name ? ' '+name : ''}. Whenever you're ready — appraisal in person or a quick call from our buyer. Either works.`;
      }
      // Default — assume callback so we always advance
      await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
      return name
        ? `${name}, I'll have our buyer give you a call. When's the best time?`
        : "What's your name? I'll have our buyer reach out and line everything up.";
    }

    // ── STAGE: name ────────────────────────────────────────────────
    if (conversation.stage === 'name' && !name) {
      let parsedName = message.trim();
      if (lowerMsg.includes('my name is')) parsedName = message.split(/my name is/i)[1].trim();
      else if (lowerMsg.includes("i'm")) parsedName = message.split(/i'm/i)[1].trim();
      else if (lowerMsg.includes("i am")) parsedName = message.split(/i am/i)[1].trim();
      else if (lowerMsg.includes("call me")) parsedName = message.split(/call me/i)[1].trim();
      parsedName = parsedName.replace(/[^a-zA-Z\s'-]/g, '').trim().substring(0, 100);
      const parts = parsedName.split(/\s+/).slice(0, 2);
      parsedName = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      if (!parsedName || parsedName.length < 2) return "Sorry, didn't catch that — what's your first name?";
      await updateConversation(conversation.id, { customer_name: parsedName, stage: 'datetime' });
      await pool.query('UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2', [parsedName, phone]);
      if (conversation.intent === 'test_drive') {
        return `Hey ${parsedName}! When works best to come by for the appraisal? Mornings, afternoons, or evenings — and weekends are open too.`;
      }
      return `Hey ${parsedName}! When's the best time for our buyer to give you a quick call?`;
    }

    // ── STAGE: datetime — handled by the shared logic in getJerryResponse
    // Reuse: re-enter the sales-mode getJerryResponse from datetime onward
    // since the datetime → confirmed path is identical regardless of mode.
    if (conversation.stage === 'datetime' || conversation.stage === 'confirmed') {
      // Hand off to the buy-side function for datetime parsing + confirmation
      // (it doesn't read mode-specific fields past this point).
      return await getJerryResponse(phone, message, conversation, userId, fromNumber, notifyPhone, dealerName, dealerCity, []);
    }

    // ── Fallback: re-prompt to keep her on rails ───────────────────
    return pick(
      `Sorry — to make sure I help right, are you still considering selling? A yes or no is fine.`,
      "Got a bit lost there — let me reset. Are you open to selling your vehicle?"
    );
  }

  async function getJerryResponse(phone, message, conversation, userId, fromNumber, notifyPhone, dealerName = 'the dealership', dealerCity = 'our location', inventory = []) {
    // Mode router — acquisition campaigns go to a separate FSM that asks
    // about the seller's vehicle, mileage, condition, asking price, and
    // pivots to "looking to replace it?" before booking. Sales mode (the
    // historical default) continues unchanged below.
    if (conversation.mode === 'acquisition') {
      return getAcquisitionResponse(phone, message, conversation, userId, fromNumber, notifyPhone, dealerName, dealerCity);
    }

    const lowerMsg = message.toLowerCase().trim();
    const name = conversation.customer_name || '';
    function pick(...opts) { return opts[Math.floor(Math.random() * opts.length)]; }

    // ── BARE GREETING — hi/hello/hey ─────────────────────────
    if (lowerMsg === 'hi' || lowerMsg === 'hello' || lowerMsg === 'hey' ||
        lowerMsg === 'hey there' || lowerMsg === 'hi there' || lowerMsg === 'good morning' ||
        lowerMsg === 'good afternoon' || lowerMsg === 'good evening' || lowerMsg === 'howdy') {
      if (conversation.stage === 'confirmed' || conversation.status === 'converted') {
        return `Hey${name ? ' '+name : ''}! You're all set for ${conversation.datetime || 'your appointment'}. Anything else I can help with?`;
      }
      if (name && conversation.vehicle_type) {
        // Returning customer mid-funnel — pick up where they left off
        if (conversation.stage === 'budget' && !conversation.budget) return `Hey ${name}! Still here 😊 Where are you comfortable for monthly payments on a ${conversation.vehicle_type}?`;
        if (conversation.stage === 'appointment') return `Hey ${name}! Would you like to schedule a viewing — we can also deliver — or would a quick call be easier?`;
        if (conversation.stage === 'datetime') return `Hey ${name}! When works best for you?`;
      }
      return pick(
        `Hey${name ? ' '+name : ''}! 👋 Great to hear from you. Are you looking for a Car, Truck, Van, or SUV?`,
        `Hi${name ? ' '+name : ''}! I'm Sarah — what type of vehicle are you looking for today?`,
        `Hey there${name ? ' '+name : ''}! Looking for a vehicle? Car, Truck, Van, or SUV — what are you after?`
      );
    }

    // ── AMBIGUOUS POSITIVE — ok/sure/yeah/sounds good ────────
    if (lowerMsg === 'ok' || lowerMsg === 'okay' || lowerMsg === 'sure' ||
        lowerMsg === 'yeah' || lowerMsg === 'yep' || lowerMsg === 'sounds good' ||
        lowerMsg === 'alright' || lowerMsg === 'cool' || lowerMsg === 'great' ||
        lowerMsg === 'perfect' || lowerMsg === 'works for me') {
      // Route based on current stage
      if (conversation.stage === 'confirmed') return `${name ? 'Great '+name+'! ' : 'Great! '}See you ${conversation.datetime || 'soon'}! Text me if anything changes.`;
      if (conversation.stage === 'appointment' && !conversation.intent) {
        await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
        return name ? `${name}, when works best to book a time?` : "What's your name? I'll get everything set up for you.";
      }
      if (conversation.stage === 'datetime') return `When works best${name ? ' '+name : ''}? Morning, afternoon, or evening?`;
      if (conversation.stage === 'name' && !name) return "What's your name?";
      if (!conversation.vehicle_type) return "Are you looking for a Car, Truck, Van, or SUV?";
      if (!conversation.budget) return `What monthly payment range works for you on a ${conversation.vehicle_type}?`;
      return `${name ? name+', when' : 'When'} works best — would you prefer to schedule a viewing or have someone call you?`;
    }

    // ── STOP / UNSUBSCRIBE ────────────────────────────────────
    if (lowerMsg === 'stop' || /^stop[^a-z]/i.test(message.trim()) ||
        lowerMsg.includes('unsubscribe') || lowerMsg.includes('opt out') || lowerMsg.includes('opt-out')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await addOptOut(phone, 'sms_stop');
      await logAnalytics('conversation_stopped', phone, {}, userId);
      return "You've been unsubscribed and won't receive further messages. Reply START anytime to resume.";
    }

    // ── START / RESUBSCRIBE ───────────────────────────────────
    if (lowerMsg === 'start' || lowerMsg.includes('resubscribe') || lowerMsg.includes('opt in')) {
      await updateConversation(conversation.id, { status: 'active', stage: 'greeting' });
      await removeOptOut(phone);
      await logAnalytics('conversation_restarted', phone, {}, userId);
      return `Welcome back! I'm Sarah from ${dealerName}. Are you still looking for a vehicle? Car, Truck, Van, or SUV?`;
    }

    if (conversation.status === 'stopped') {
      return "You're currently unsubscribed. Reply START to receive messages again.";
    }

    // ── NOT INTERESTED ────────────────────────────────────────
    // ── ALREADY SPOKE TO SOMEONE ─────────────────────────────
    if (lowerMsg.includes('already spoke') || lowerMsg.includes('already talked') ||
        lowerMsg.includes('already called') || lowerMsg.includes('someone called me') ||
        lowerMsg.includes('already dealing') || lowerMsg.includes('already working') ||
        lowerMsg.includes('salesperson') || lowerMsg.includes('sales person') ||
        lowerMsg.includes('already in touch') || lowerMsg.includes('already contacted')) {
      if (conversation.stage === 'confirmed' || conversation.status === 'converted') {
        return `${name ? 'Hey '+name+'! ' : ''}Sounds like you\'re all set — our team will take great care of you. If you have any other questions, just text me anytime!`;
      }
      await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
      if (!name) return "No problem at all! What's your name so I can make sure the right person follows up?";
      return `${name}, no problem! I'll make a note so the right person follows up. When would be a good time for them to reach out?`;
    }

    // ── ALREADY BOUGHT / FOUND ONE ELSEWHERE ────────────────
    if (lowerMsg.includes('already bought') || lowerMsg.includes('already got') ||
        lowerMsg.includes('found one') || lowerMsg.includes('got one') ||
        lowerMsg.includes('purchased') || lowerMsg.includes('just bought') ||
        lowerMsg.includes('went with') || lowerMsg.includes('went somewhere') ||
        lowerMsg.includes('got a car') || lowerMsg.includes('got a truck') ||
        lowerMsg.includes('got a vehicle') || lowerMsg.includes('nevermind') ||
        lowerMsg.includes('never mind') || lowerMsg.includes('no longer') ||
        lowerMsg.includes('not looking anymore') || lowerMsg.includes('found what')) {
      // Congratulate but still try to open a door
      await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
      if (conversation.status === 'converted') {
        return `${name ? 'Congrats '+name+'! ' : 'Congrats! '}Excited for you — enjoy the new ride! If you ever need anything down the road, we're always here.`;
      }
      if (!name) {
        return pick(
          "Congrats on the new vehicle! 🎉 Just so you know — if you ever need anything down the road, financing options, trade-in, or protection packages, we're always here. What's your name? I'll keep you on file.",
          "Oh nice, congrats! 🎉 If things don't work out or you're ever looking again, we'd love to earn your business. What's your name?"
        );
      }
      return pick(
        `Congrats ${name}! 🎉 Enjoy the new ride. If you ever need anything — trade-in, protection packages, or a vehicle down the road — just text me anytime. Would you be open to a quick call from our manager just to introduce himself?`,
        `That's awesome ${name}! 🎉 If anything comes up or you know someone looking, we'd love the chance. Would a quick call from our team be okay — just a 2-minute intro, no pressure?`
      );
    }

    if (lowerMsg.includes('not interested') || lowerMsg.includes('no thanks') ||
        lowerMsg.includes('no thank you') || lowerMsg.includes('wrong number') ||
        lowerMsg.includes('leave me alone') || lowerMsg.includes('remove me') ||
        lowerMsg.includes('do not contact') || lowerMsg === 'no' || lowerMsg === 'nah' ||
        lowerMsg === 'nope' || lowerMsg.includes('go away')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await logAnalytics('conversation_stopped', phone, { reason: 'not_interested' }, userId);
      return "No worries at all! I've taken you off our list. If anything changes down the road, just text back anytime. Take care!";
    }

    // ── ODD QUESTIONS → funnel to callback ───────────────────
    if (lowerMsg.includes('location') || lowerMsg.includes('where are you') || lowerMsg.includes('address') || lowerMsg.includes('directions')) {
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `We're in ${dealerCity} — and we deliver all across Canada! I can have one of our team call you with details and details. What's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `We're in ${dealerCity} ${name} — and we deliver all across Canada! When's a good time for one of our team to call you with directions?`;
    }

    if (lowerMsg.includes('financ') || lowerMsg.includes('credit') || lowerMsg.includes('loan') ||
        lowerMsg.includes('bad credit') || lowerMsg.includes('no credit') || lowerMsg.includes('poor credit') ||
        lowerMsg.includes('bankrupt') || lowerMsg.includes('consumer proposal') || lowerMsg.includes('cosign') ||
        lowerMsg.includes('down payment') || lowerMsg.includes('trade') || lowerMsg.includes('trading')) {
      const hasTrade = lowerMsg.includes('trade') || lowerMsg.includes('trading');
      if (hasTrade) {
        if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Trades are no problem — we handle all makes and models, and we'll give you a fair value. What's your name? I'll have someone reach out to discuss what you've got."; }
        await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
        return `${name}, trades are no problem at all! Our team will assess your vehicle and give you a real number. When's a good time for a quick call to go over the details?`;
      }
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Great question — that's exactly what our finance team handles. We work with all credit situations and have flexible options. What's your name? I'll have someone reach out who can walk you through everything."; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, our finance team handles all of that — they work with every credit situation. When's a good time for them to give you a quick call? No obligation.`;
    }

    // ── FINANCING TIMELINE / PROCESS QUESTIONS ──────────────
    if (lowerMsg.includes('how long') || lowerMsg.includes('how does') || lowerMsg.includes('how do') ||
        lowerMsg.includes('process') || lowerMsg.includes('timeline') || lowerMsg.includes('how fast') ||
        lowerMsg.includes('quick') || lowerMsg.includes('same day') || lowerMsg.includes('how soon') ||
        lowerMsg.includes('when can i') || lowerMsg.includes('how does financing') ||
        lowerMsg.includes('what do i need') || lowerMsg.includes('what documents') ||
        lowerMsg.includes('what papers') || lowerMsg.includes('requirements') ||
        (lowerMsg.includes('financing') && (lowerMsg.includes('work') || lowerMsg.includes('take') || lowerMsg.includes('long') || lowerMsg.includes('fast')))) {
      if (!name) {
        await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
        return "Great question! Our finance managers can walk you through the whole process — it's usually pretty quick. What's your name? I'll have one of them reach out.";
      }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, our finance manager can walk you through everything — most deals move fast, sometimes same day depending on the situation. When's a good time for a quick call? They'll answer all your questions.`;
    }

    if (lowerMsg.includes('how much') || lowerMsg.includes('price') || lowerMsg.includes('cost') ||
        lowerMsg.includes('cheapest') || lowerMsg.includes('expensive') || lowerMsg.includes('rates')) {
      if (!conversation.vehicle_type) { await updateConversation(conversation.id, { stage: 'greeting' }); return "Pricing really depends on what you're looking for! Are you thinking Car, Truck, Van, or SUV? Once I know that I can point you in the right direction."; }
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `${conversation.vehicle_type} pricing varies by year and features. I can have one of our team send you some options with pricing — what's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, pricing on ${conversation.vehicle_type}s really depends on the specifics. When's a good time for one of our team to call you? They can go over everything and find the best fit.`;
    }

    if (lowerMsg.includes('detail') || lowerMsg.includes('more info') || lowerMsg.includes('tell me more') ||
        lowerMsg.includes('manager') || lowerMsg.includes('speak to') || lowerMsg.includes('talk to someone')) {
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Absolutely — I'll have one of our team reach out with all the details. What's your name?"; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll get one of our team on it. When's the best time to reach you?`;
    }

    // ── SPECIFIC YEAR/MAKE/MODEL REQUEST ─────────────────────
    const yearMatch = message.match(/\b(19|20)\d{2}\b/);
    const makeWords = ['ford','toyota','honda','chevrolet','chevy','gmc','dodge','ram','jeep','nissan','hyundai','kia','mazda','subaru','volkswagen','vw','bmw','mercedes','audi','lexus','infiniti','acura','cadillac','lincoln','buick','chrysler','mitsubishi','volvo','tesla','genesis'];
    const hasMake = makeWords.some(m => lowerMsg.includes(m));
    if ((yearMatch || hasMake) && (lowerMsg.includes('have') || lowerMsg.includes('got') || lowerMsg.includes('looking') || lowerMsg.includes('want') || lowerMsg.includes('need') || lowerMsg.includes('find') || lowerMsg.includes('sell') || lowerMsg.includes('any') || lowerMsg.includes('do you') || lowerMsg.includes('stock'))) {
      const year = yearMatch ? yearMatch[0] : null;
      const make = makeWords.find(m => lowerMsg.includes(m)) || '';
      const makeLabel = make ? make.charAt(0).toUpperCase() + make.slice(1) : '';
      const label = [year, makeLabel].filter(Boolean).join(' ');
      if (inventory && inventory.length > 0) {
        const matches = inventory.filter(v => {
          const matchYear = year ? String(v.year) === year : true;
          const matchMake = make ? (v.make || '').toLowerCase().includes(make) : true;
          return matchYear && matchMake;
        });
        if (matches.length > 0) {
          const examples = matches.slice(0,3).map(v => `${v.year} ${v.make} ${v.model}${v.mileage ? ' ('+Math.round(v.mileage/1000)+'k km)' : ''}${v.price ? ' — $'+Number(v.price).toLocaleString() : ''}`).join(', ');
          if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name', vehicle_type: makeLabel || conversation.vehicle_type }); return `Yes! We have ${matches.length} ${label} option${matches.length>1?'s':''}: ${examples}. I can have someone reach out with full details and photos — what's your name?`; }
          await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime', vehicle_type: makeLabel || conversation.vehicle_type });
          return `${name}, we have ${matches.length} ${label} option${matches.length>1?'s':''} in stock: ${examples}. Would you like to schedule a viewing, or a quick call to go over the details?`;
        } else {
          if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `We don't have a ${label} in stock right now, but inventory moves fast and we can source vehicles. What's your name? I'll have someone reach out with what's coming in.`; }
          await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
          return `${name}, we don't have a ${label} right now but we can source them and get something close. When's a good time for one of our team to reach out with some options?`;
        }
      }
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `Great choice! I'll have one of our team reach out with details on ${label} options. What's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll have the team pull up ${label} options for you. When's a good time to reach out?`;
    }

    if (lowerMsg.includes('do you have') || lowerMsg.includes('got any') || lowerMsg.includes('available') ||
        lowerMsg.includes('in stock') || lowerMsg.includes('inventory') || lowerMsg.includes('photos') ||
        lowerMsg.includes('pictures') || lowerMsg.includes('send me')) {

      // Build inventory-aware response using tenant's actual stock
      function buildInventoryReply(filterFn, typeName) {
        if (!inventory || inventory.length === 0) return null;
        const matches = filterFn ? inventory.filter(filterFn) : inventory;
        if (matches.length === 0) return null;
        const count = matches.length;
        // Show up to 3 specific vehicles
        const examples = matches.slice(0, 3).map(v =>
          `${v.year} ${v.make} ${v.model}${v.mileage ? ' (' + Math.round(v.mileage/1000) + 'k km)' : ''}`
        ).join(', ');
        return { count, examples };
      }

      // Detect if asking about a specific type
      const askTruck   = ['truck','pickup','f-150','f150','silverado','ram','tacoma','tundra','sierra','ranger'].some(w => lowerMsg.includes(w));
      const askSuv     = ['suv','crossover','highlander','rav4','explorer','tahoe','suburban','pilot','4runner','tucson'].some(w => lowerMsg.includes(w));
      const askCar     = ['sedan','car','civic','corolla','camry','accord','altima'].some(w => lowerMsg.includes(w));
      const askVan     = ['van','minivan','sienna','odyssey','pacifica'].some(w => lowerMsg.includes(w));

      let invReply = null;
      if (askTruck)    invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('truck') || v.make?.toLowerCase().match(/ford|ram|chevrolet|gmc|toyota|nissan/), 'truck');
      else if (askSuv) invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('suv') || v.type?.toLowerCase().includes('4x4'), 'SUV');
      else if (askCar) invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('car') || v.type?.toLowerCase().includes('sedan'), 'car');
      else if (askVan) invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('van'), 'van');
      else             invReply = buildInventoryReply(null, 'vehicle');

      if (invReply && invReply.count > 0) {
        const typeLabel = askTruck ? 'truck' : askSuv ? 'SUV' : askCar ? 'car' : askVan ? 'van' : 'vehicle';
        if (!name) {
          await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
          return `Yes! We have ${invReply.count} ${typeLabel}${invReply.count > 1 ? 's' : ''} in stock — ${invReply.examples}. Our team can reach out with photos and full details. What's your name?`;
        }
        await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
        return `${name}, we have ${invReply.count} ${typeLabel}${invReply.count > 1 ? 's' : ''} in stock right now — ${invReply.examples}. Would you like to book a time to view them, or a quick call to walk through what we have?`;
      }

      // Fallback if no inventory or no match
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Yes! We have a great selection. I can have one of our team send you photos and details — what's your name?"; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll have the team send over what we've got. When's a good time to reach you? They can send photos and walk you through the options.`;
    }

    // ── MULTI-INTENT: inventory ask + call request in same message ──
    const wantsCall = lowerMsg.includes('call me') || lowerMsg.includes('give me a call') ||
                      lowerMsg.includes('reach me') || lowerMsg.includes('contact me') ||
                      lowerMsg.includes('someone call') || lowerMsg.includes('have someone');
    const wantsInfo = lowerMsg.includes('do you have') || lowerMsg.includes('got any') ||
                      lowerMsg.includes('in stock') || lowerMsg.includes('available');
    if (wantsCall && wantsInfo && conversation.stage !== 'confirmed') {
      // Answer the inventory question first, then capture callback intent
      if (inventory && inventory.length > 0) {
        const typeLabel = conversation.vehicle_type || 'vehicle';
        const matches = inventory.slice(0, 3).map(v => `${v.year} ${v.make} ${v.model}`).join(', ');
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        if (!name) return `Yes! We have ${inventory.length} vehicles in stock — ${matches} and more. What's your name? I'll have someone reach out with details and photos.`;
        return `${name}, yes! We have options in stock right now. I'll have one of our team call you — when's the best time to reach you?`;
      }
      await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
      if (!name) return "Yes we do! What's your name? I'll have someone call you with full details.";
      return `${name}, I'll have someone call you with what we've got. When's the best time to reach you?`;
    }

    // ── STAGE 1: GREETING ─────────────────────────────────────
    if (conversation.stage === 'greeting' || !conversation.vehicle_type) {
      const truckWords = ['ram','f-150','f150','silverado','tacoma','tundra','pickup','sierra','ranger','frontier','colorado','gladiator','canyon','half ton','3/4 ton','1 ton','ton','truck'];
      const suvWords   = ['suv','highlander','rav4','cr-v','crv','pilot','explorer','suburban','tahoe','yukon','equinox','escape','compass','cherokee','wrangler','4runner','pathfinder','tucson','santa fe','sorento','sportage','bronco','telluride'];
      const sedanWords = ['sedan','civic','corolla','camry','accord','altima','elantra','sonata','jetta','charger','car'];
      const vanWords   = ['van','minivan','sienna','odyssey','pacifica','carnival','caravan'];
      const evWords    = ['electric','ev','hybrid','tesla','model 3','model y'];

      let vehicleType = '';
      if (truckWords.some(w => lowerMsg.includes(w))) vehicleType = 'Truck';
      else if (suvWords.some(w => lowerMsg.includes(w))) vehicleType = 'SUV';
      else if (vanWords.some(w => lowerMsg.includes(w))) vehicleType = 'Van';
      else if (evWords.some(w => lowerMsg.includes(w))) vehicleType = 'Electric/Hybrid';
      else if (sedanWords.some(w => lowerMsg.includes(w))) vehicleType = 'Car';
      else if (lowerMsg.includes('yes') || lowerMsg.includes('interested') || lowerMsg.includes('looking') ||
               lowerMsg.includes('want') || lowerMsg.includes('need') || lowerMsg.includes('vehicle') ||
               lowerMsg.includes('something')) vehicleType = 'Vehicle';

      if (vehicleType) {
        await updateConversation(conversation.id, { vehicle_type: vehicleType, stage: 'budget' });
        return pick(
          `${vehicleType} — great choice! Where are you comfortable up to for monthly payments? That helps me find the best match.`,
          `${vehicleType}s are popular right now! What monthly payment range works for you? Just a rough number is fine.`,
          `Love it! To narrow things down — where are you at for monthly payments? Like $300, $500, $700 range?`
        );
      }
      // Number without context at greeting — could be a budget
      const greetNumbers = message.match(/\d+/g);
      if (greetNumbers && greetNumbers.length > 0) {
        const num = parseInt(greetNumbers[0]);
        if (num >= 200 && num <= 2000) {
          // Looks like a monthly budget — treat it as such
          const budgetRange = (num * 72) < 30000 ? 'Under $30k' : (num * 72) < 50000 ? '$30k-$50k' : '$50k+';
          await updateConversation(conversation.id, { budget: budgetRange, budget_amount: num, stage: 'appointment' });
          return pick(
            `$${num}/month — solid! I've got great options in that range. Would you like to schedule a viewing, or would a quick call work better?`,
            `Around $${num}/month works! I can find you some solid vehicles. Would you like to book a time to see it, or start with a quick call?`
          );
        }
      }
      return pick(
        "Are you looking for a Car, Truck, Van, or SUV? Just let me know and I'll find you the best options.",
        "What kind of vehicle are you after? Car, Truck, Van, or SUV?",
        "To get you the best match — are you thinking Car, Truck, Van, or SUV?"
      );
    }

    // ── STAGE 2: BUDGET ───────────────────────────────────────
    if (conversation.stage === 'budget' && !conversation.budget) {
      const numbers = message.match(/\d+/g);
      let budgetAmount = 0;
      if (numbers && numbers.length > 0) {
        budgetAmount = parseInt(numbers[0]);
        if (lowerMsg.includes('k') && budgetAmount < 1000) budgetAmount *= 1000;
        if (message.includes(',')) { const e = message.replace(/,/g,'').match(/\d+/); if (e) budgetAmount = parseInt(e[0]); }
      }
      if (budgetAmount > 0 && budgetAmount < 2000) {
        const estTotal = budgetAmount * 72;
        const budgetRange = estTotal < 30000 ? 'Under $30k' : estTotal < 50000 ? '$30k-$50k' : '$50k+';
        await updateConversation(conversation.id, { budget: budgetRange, budget_amount: budgetAmount, stage: 'appointment' });
        return pick(
          `$${budgetAmount}/month — solid. I have some great ${conversation.vehicle_type} options in that range. Would you like to schedule a viewing — we deliver too — or would a quick call with one of our team work better?`,
          `Around $${budgetAmount}/month — I have some solid options for you. Would you like to book a time to see one, or would a quick call work first?`
        );
      }
      if (budgetAmount >= 2000) {
        const budgetRange = budgetAmount < 30000 ? 'Under $30k' : budgetAmount < 50000 ? '$30k-$50k' : '$50k+';
        await updateConversation(conversation.id, { budget: budgetRange, budget_amount: budgetAmount, stage: 'appointment' });
        return pick(
          `Around $${(budgetAmount/1000).toFixed(0)}k — solid budget. I have some great options. Would you like to schedule a viewing, or a quick call to go over what we have?`,
          `$${(budgetAmount/1000).toFixed(0)}k — I can work with that. Would you like to book a time to view something, or prefer a call first?`
        );
      }
      if (lowerMsg.includes('cheap') || lowerMsg.includes('low') || lowerMsg.includes('budget') || lowerMsg.includes('affordable')) {
        await updateConversation(conversation.id, { budget: 'Under $30k', stage: 'appointment' });
        return "I hear you — we've got great value options. Would you like to book a time to view one, or should one of our team reach out with what's available?";
      }
      if (lowerMsg.includes("don't care") || lowerMsg.includes('whatever') || lowerMsg.includes('open') || lowerMsg.includes('flexible') || lowerMsg.includes('not sure')) {
        await updateConversation(conversation.id, { budget: 'Flexible', stage: 'appointment' });
        return "No problem — we'll find the right fit. Would you like to book a time to see what we have, or would a quick call be easier?";
      }
      if (lowerMsg.includes('high') || lowerMsg.includes('premium') || lowerMsg.includes('luxury')) {
        await updateConversation(conversation.id, { budget: '$50k+', stage: 'appointment' });
        return "Excellent taste! We have some premium options. Would you like to schedule a viewing, or should our team reach out with details and photos?";
      }
      if (budgetAmount > 0 && budgetAmount < 100) {
        return "Just to make sure I understand — is that $" + budgetAmount + " per month, or total budget? Most people are in the $300-$700/month range.";
      }
      // Price objection handler
      if (lowerMsg.includes('too expensive') || lowerMsg.includes('too much') || lowerMsg.includes("can't afford") ||
          lowerMsg.includes('cannot afford') || lowerMsg.includes('out of my budget') || lowerMsg.includes('too high') ||
          lowerMsg.includes('no money') || lowerMsg.includes('broke') || lowerMsg.includes('tight') ||
          lowerMsg.includes('cheaper') || lowerMsg.includes('less expensive') || lowerMsg.includes('lower payment')) {
        await updateConversation(conversation.id, { budget: 'Under $30k', stage: 'appointment' });
        return pick(
          `No worries at all${name ? ' '+name : ''}! We work with all budgets and every credit situation. Even $200-$300/month gets you into something solid. Would you like to schedule a time — we can also bring the vehicle to you — or would a quick call be easier?`,
          `${name ? name+', we' : "We"} specialize in making deals work — we've helped people in every situation. Let's find something that works for you. Would you like to book a time, or would a call be a better first step?`
        );
      }
      return pick(
        "Just a rough number is fine — like $300/month, $500/month, or a total budget like $25k, $40k. Whatever you're comfortable with.",
        "What range are you thinking? Like $300-500/month, or a total budget? Just ballpark it for me."
      );
    }

    // ── STAGE 3: APPOINTMENT ──────────────────────────────────
    if (conversation.stage === 'appointment' && !conversation.intent) {
      if (lowerMsg.includes('view') || lowerMsg.includes('book') || lowerMsg.includes('visit') || lowerMsg.includes('test') ||
          lowerMsg.includes('drive') || lowerMsg.includes('see') || lowerMsg.includes('look') ||
          lowerMsg.includes('come') || lowerMsg.includes('in person') || lowerMsg.includes('show up') || lowerMsg.includes('schedule')) {
        await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when works best for you? We're flexible — mornings, afternoons, evenings, weekends. We can also arrange delivery if that's easier.`
          : "Sounds great! What's your name so I can get everything set up for you?";
      }
      if (lowerMsg.includes('call') || lowerMsg.includes('phone') || lowerMsg.includes('talk') ||
          lowerMsg.includes('reach') || lowerMsg.includes('contact') || lowerMsg.includes('ring')) {
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when's the best time to give you a call?`
          : "Sounds good — what's your name? I'll have someone reach out.";
      }
      if (lowerMsg.includes('maybe') || lowerMsg.includes('not sure') || lowerMsg.includes('think') ||
          lowerMsg.includes('later') || lowerMsg.includes('busy')) {
        return `No rush at all${name ? ' '+name : ''}! Whenever you're ready — we can arrange a viewing, or start with a phone call. Either works for us.`;
      }
      await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
      return name
        ? `${name}, I have some great options lined up for you. When works best to book a time? We're flexible, and we can also deliver to you.`
        : "I've got some solid options lined up. What's your name? I'll get everything ready for you.";
    }

    // ── STAGE 4: NAME ─────────────────────────────────────────
    if (conversation.stage === 'name' && !name) {
      let parsedName = message.trim();
      if (lowerMsg.includes('my name is')) parsedName = message.split(/my name is/i)[1].trim();
      else if (lowerMsg.includes("i'm")) parsedName = message.split(/i'm/i)[1].trim();
      else if (lowerMsg.includes("i am")) parsedName = message.split(/i am/i)[1].trim();
      else if (lowerMsg.includes("it's") || lowerMsg.includes("its")) parsedName = message.split(/it'?s/i)[1]?.trim() || parsedName;
      else if (lowerMsg.includes("call me")) parsedName = message.split(/call me/i)[1].trim();
      parsedName = parsedName.replace(/[^a-zA-Z\s'-]/g, '').trim().substring(0, 100);
      const parts = parsedName.split(/\s+/).slice(0, 2);
      parsedName = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      if (!parsedName || parsedName.length < 2) return "Sorry, I didn't catch that — what's your first name?";
      // Phase 7 — sales flow now asks trade-in BEFORE datetime so the
      // closer walks into the conversation knowing if there's a trade
      // (and an appraisal opportunity) on the table.
      await updateConversation(conversation.id, { customer_name: parsedName, stage: 'trade_in_check' });
      await pool.query('UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2', [parsedName, phone]);
      return pick(
        `Hey ${parsedName}! Quick one before we lock in a time — do you have a vehicle to trade in? Even a rough year/make/model helps.`,
        `Nice to meet you ${parsedName}! One quick thing — any vehicle you'd want to trade in? If yes, what is it and what would you want for it?`,
        `${parsedName}, before we book — got a trade? If you tell me year/make/model and what you'd want for it, I can have it appraised by the time you come in.`
      );
    }

    // ── STAGE 4.5: TRADE-IN CHECK (Phase 7) ────────────────────
    // Asks every buyer about a potential trade-in. Captures details if
    // they have one; either way advances to datetime so we always end on
    // an appointment or callback.
    if (conversation.stage === 'trade_in_check') {
      // Negative — no trade
      if (lowerMsg === 'no' || lowerMsg === 'nope' || lowerMsg === 'nah' ||
          lowerMsg.includes('no trade') || lowerMsg.includes("don't have") || lowerMsg.includes('not trading') ||
          lowerMsg.includes('nothing to trade') || lowerMsg.includes('just buying')) {
        await updateConversation(conversation.id, { trade_in_value: 0, stage: 'datetime' });
        if (conversation.intent === 'test_drive') {
          return pick(
            `All good ${name}! When works best for a viewing? Mornings, afternoons, evenings — even weekends.`,
            `No worries ${name}! When would you like to come in?`
          );
        }
        return `No problem ${name}! When's the best time for a quick call? Morning, afternoon, or evening?`;
      }
      // Positive — they have a trade. Try to extract year/make.
      const yearMatch = message.match(/\b(19|20)\d{2}\b/);
      const makeWords = ['ford','toyota','honda','chevrolet','chevy','gmc','dodge','ram','jeep','nissan','hyundai','kia','mazda','subaru','volkswagen','vw','bmw','mercedes','audi','lexus','infiniti','acura','cadillac','lincoln','buick','chrysler','mitsubishi','volvo','tesla','genesis'];
      const make = makeWords.find(m => lowerMsg.includes(m));
      const dollarMatch = message.match(/\$?(\d{1,3}(?:[,.]?\d{3})+|\d{4,6})/);
      const year = yearMatch ? parseInt(yearMatch[0]) : null;
      const makeLabel = make ? make.charAt(0).toUpperCase() + make.slice(1) : null;
      const tradeValue = dollarMatch ? parseInt(dollarMatch[1].replace(/[,.]/g, '')) : null;
      // Affirmative without details — ask for them
      if ((lowerMsg === 'yes' || lowerMsg === 'yep' || lowerMsg === 'sure' || lowerMsg.includes('have one') ||
           lowerMsg.includes('have a trade') || lowerMsg === 'i do' || lowerMsg.includes('yeah')) &&
          !year && !make && !tradeValue) {
        return "Awesome — what is it? Year, make, model and what you'd want for it (rough number is fine).";
      }
      // We got something — capture what we can and advance
      const updates = { stage: 'datetime' };
      if (year)       updates.trade_in_year = year;
      if (makeLabel)  updates.trade_in_make = makeLabel;
      if (tradeValue && tradeValue >= 500 && tradeValue <= 200000) updates.trade_in_value = tradeValue;
      // If nothing parsed, save the raw message as the model so the closer has something
      if (!year && !makeLabel && !tradeValue) updates.trade_in_model = message.slice(0, 80);
      await updateConversation(conversation.id, updates);
      const summary = [year, makeLabel].filter(Boolean).join(' ') || 'your trade';
      const valueNote = tradeValue ? ` ($${tradeValue.toLocaleString()})` : '';
      if (conversation.intent === 'test_drive') {
        return `Perfect — ${summary}${valueNote} noted. We'll appraise it when you come in. When works best — mornings, afternoons, evenings, or a weekend?`;
      }
      return `Got it — ${summary}${valueNote} noted. Our team will work up a real number for the trade. When's a good time for a quick call?`;
    }

    // ── STAGE 5: DATETIME ─────────────────────────────────────
    if (conversation.stage === 'datetime' && !conversation.datetime) {
      let finalDateTime = message;
      if (lowerMsg.includes('today')) {
        finalDateTime = lowerMsg.includes('morning') ? 'Today morning' : lowerMsg.includes('evening') || lowerMsg.includes('tonight') ? 'Today evening' : 'Today afternoon';
      } else if (lowerMsg.includes('tomorrow')) {
        finalDateTime = lowerMsg.includes('morning') ? 'Tomorrow morning' : lowerMsg.includes('evening') ? 'Tomorrow evening' : 'Tomorrow afternoon';
      } else if (lowerMsg.includes('this weekend') || lowerMsg === 'weekend') {
        finalDateTime = 'This weekend';
      } else if (lowerMsg.includes('next week')) {
        finalDateTime = 'Next week';
      } else if (lowerMsg.includes('this morning')) {
        finalDateTime = 'Today morning';
      } else if (lowerMsg.includes('this afternoon')) {
        finalDateTime = 'Today afternoon';
      } else if (lowerMsg.includes('this evening') || lowerMsg.includes('tonight')) {
        finalDateTime = 'Today evening';
      } else if (lowerMsg.includes('anytime') || lowerMsg.includes('whenever') || lowerMsg.includes('asap') || lowerMsg.includes('now')) {
        finalDateTime = 'ASAP';
      }

      // After-hours awareness: flag if booked outside typical hours
      const nowHour = new Date().getHours();
      const isAfterHours = nowHour >= 21 || nowHour < 8; // After 9pm or before 8am
      await updateConversation(conversation.id, { datetime: finalDateTime, stage: 'confirmed', status: 'converted' });
      const data = {
        phone, name: conversation.customer_name, vehicleType: conversation.vehicle_type,
        budget: conversation.budget, budgetAmount: conversation.budget_amount, datetime: finalDateTime,
        userId
      };

      if (conversation.intent === 'test_drive') {
        await saveAppointment(data);
        try {
          if (notifyPhone) await twilioClient.messages.create({
            body: `APPOINTMENT BOOKED!\n${conversation.customer_name}\n${formatPretty(phone)}\n${conversation.vehicle_type || 'Vehicle TBD'} / ${conversation.budget || 'Budget TBD'}\nTime: ${finalDateTime}`,
            from: fromNumber, to: notifyPhone
          });
        } catch(e) {}
        // Send customer a confirmation reminder 60s later
        setTimeout(async () => {
          try {
            const confirmMsg = `Hi ${conversation.customer_name.split(' ')[0]}! Just confirming your appointment at ${dealerName} for ${finalDateTime}. We're looking forward to seeing you! Reply anytime if anything changes.`;
            await twilioClient.messages.create({ body: confirmMsg, from: fromNumber, to: phone });
          } catch(e) { console.warn('⚠️ Appt confirmation SMS failed:', e.message); }
        }, 60000);
        await logAnalytics('appointment_booked', phone, data, userId);
        const afterHoursNote = isAfterHours ? ` Our team will confirm your time in the morning.` : '';
        return `Perfect ${conversation.customer_name}! You're all set for ${finalDateTime}.${afterHoursNote} We're at ${dealerName} in ${dealerCity} and we deliver across Canada. Our team will have everything ready for you.\n\nIf anything changes just text me back. See you soon!`;
      } else {
        await saveCallback(data);
        try {
          if (notifyPhone) await twilioClient.messages.create({
            body: `CALLBACK REQUESTED!\n${conversation.customer_name}\n${formatPretty(phone)}\n${conversation.vehicle_type || 'Vehicle TBD'}\nCall them: ${finalDateTime}`,
            from: fromNumber, to: notifyPhone
          });
        } catch(e) {}
        await logAnalytics('callback_requested', phone, data, userId);
        return `Got it ${conversation.customer_name}! One of our team will call you ${finalDateTime}. They'll have all the details on ${conversation.vehicle_type || 'vehicle'} options in your range.\n\nIf anything comes up, just text me. Talk soon!`;
      }
    }

    // ── STAGE 6: CONFIRMED ────────────────────────────────────
    if (conversation.stage === 'confirmed') {
      if (lowerMsg.includes('reschedule') || lowerMsg.includes('change') || lowerMsg.includes('different time') || lowerMsg.includes('push')) {
        await updateConversation(conversation.id, { stage: 'datetime', datetime: null });
        return `No problem ${name}! What time works better?`;
      }
      if (lowerMsg.includes('cancel')) {
        await updateConversation(conversation.id, { status: 'active', stage: 'datetime', datetime: null, intent: conversation.intent });
        return `No worries ${name}! Want to pick a different time instead? Just let me know.`;
      }
      if (lowerMsg.includes('inventory') || lowerMsg.includes('photos') || lowerMsg.includes('pictures') || lowerMsg.includes('send')) {
        try {
          if (notifyPhone) await twilioClient.messages.create({
            body: `PHOTOS REQUESTED\n${name}\n${formatPretty(phone)}\n${conversation.vehicle_type || '—'} / ${conversation.budget || '—'}`,
            from: fromNumber, to: notifyPhone
          });
        } catch(e) {}
        await saveCallback({ phone, name, vehicleType: conversation.vehicle_type, budget: conversation.budget, budgetAmount: conversation.budget_amount, datetime: 'ASAP - Requested photos' });
        return `${name}, I've flagged it — someone will text you photos of what we've got in your range shortly!`;
      }
      if (lowerMsg.includes('warranty') || lowerMsg.includes('protection') || lowerMsg.includes('gap') || lowerMsg.includes('coverage')) {
        return `Great question ${name}! We offer full protection packages including payment coverage, powertrain warranty, GAP insurance, and tire & wheel. Your finance manager will walk you through all the options when you connect with our team.`;
      }
      if (lowerMsg.includes('payment') || lowerMsg.includes('first payment') || lowerMsg.includes('void') || lowerMsg.includes('cheque') || lowerMsg.includes('insurance') || lowerMsg.includes('pink slip')) {
        return `${name}, our finance team will go over all of that with you — payments, insurance, everything. They'll make sure it's all taken care of. Is there anything else I can help with?`;
      }
      if (lowerMsg.includes('thank') || lowerMsg.includes('thanks') || lowerMsg.includes('appreciate') || lowerMsg.includes('awesome') || lowerMsg.includes('perfect')) {
        return pick(
          `You're welcome ${name}! See you ${conversation.datetime || 'soon'}!`,
          `Anytime ${name}! Can't wait to get you behind the wheel. See you ${conversation.datetime || 'soon'}!`
        );
      }
      if (lowerMsg.includes('update') || lowerMsg.includes('status') || lowerMsg.includes('ready') || lowerMsg.includes('anything new')) {
        return `Still working on it ${name}! Quick heads up — if anyone from other dealerships reaches out, best not to engage. Conflicting info with the lenders can affect pre-approvals we have in place. I'll update you soon.`;
      }
      return `Hey ${name}! You're all set for ${conversation.datetime || 'your appointment'}. If you need to reschedule or have any questions, just text me back!`;
    }

    // ── FALLBACK ──────────────────────────────────────────────
    if (!conversation.vehicle_type || conversation.stage === 'greeting') {
      return pick("What type of vehicle are you looking for? Car, Truck, Van, or SUV?", "To find you the best match — are you thinking Car, Truck, Van, or SUV?");
    }
    if (!conversation.budget || conversation.stage === 'budget') {
      return `Where are you comfortable for monthly payments on a ${conversation.vehicle_type || 'vehicle'}? Just a rough number.`;
    }
    if (conversation.stage === 'appointment' && !conversation.intent) {
      return `${name ? name+', would' : 'Would'} you like to book a time to view one — we can deliver too — or would a quick call be a better start?`;
    }
    if (conversation.stage === 'name' && !name) {
      return "What's your name? I'll get everything set up for you.";
    }
    if (conversation.stage === 'datetime' && !conversation.datetime) {
      return conversation.intent === 'test_drive'
        ? `When works best${name ? ' '+name : ''}? We're flexible on timing.`
        : `When's the best time to call you${name ? ' '+name : ''}?`;
    }
    return `Hey${name ? ' '+name : ''}! Is there anything else I can help with? Just text me anytime.`;
  }

};

