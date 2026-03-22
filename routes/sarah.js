// routes/sarah.js
const { pool, getOrCreateCustomer, getOrCreateConversation, updateConversation,
        saveMessage, hasActiveConversation, deleteConversation,
        saveAppointment, saveCallback, logAnalytics } = require('../lib/db');
const { normalizePhone, toE164NorthAmerica, formatPretty, makeTwilioWebhookValidator } = require('../lib/helpers');
const { state } = require('../lib/bulk');
const validateTwilio = makeTwilioWebhookValidator();

module.exports = function sarahRoutes(app, { twilioClient, requireAuth, requireBilling, notifyOwner }) {

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
           WHERE cx.customer_phone = c.customer_phone AND cx.user_id = $1) as message_count
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
      await twilioClient.messages.create({
        body: message,
        from: manualFromNumber,
        to: phone
      });
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
      const messageBody = message || "Hi! 👋 I'm Sarah from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)";
      const uid = req.user.userId;
      await getOrCreateCustomer(normalizedPhone, uid);
      const conversation = await getOrCreateConversation(normalizedPhone, uid);
      await saveMessage(conversation.id, normalizedPhone, 'assistant', messageBody, uid);
      await logAnalytics('sms_sent', normalizedPhone, { messageBody }, uid);
      // Use tenant's twilio number for outbound
      let startFromNumber = process.env.TWILIO_PHONE_NUMBER;
      try {
        const ts = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [uid]);
        const sp = typeof ts.rows[0]?.settings_json === 'string' ? JSON.parse(ts.rows[0].settings_json) : (ts.rows[0]?.settings_json || {});
        if (sp.twilioNumber) startFromNumber = sp.twilioNumber;
      } catch(e) {}
      await twilioClient.messages.create({
        body: messageBody,
        from: startFromNumber,
        to: normalizedPhone
      });
      console.log('✅ SMS sent to:', normalizedPhone);
      res.json({ success: true, message: 'SMS sent!' });
    } catch (error) {
      console.error('❌ Error sending SMS:', error);
      res.json({ success: false, error: error.message });
    }
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

    // Fetch tenant outbound number + notify phone
    let TENANT_FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
    let TENANT_NOTIFY_PHONE = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;
    let TENANT_DEALER_NAME  = process.env.DEALER_NAME  || 'First Financial Auto';
    let TENANT_DEALER_CITY  = process.env.DEALER_CITY  || 'Calgary, AB';
    let TENANT_INVENTORY    = [];
    try {
      const tenantSettings = await pool.query(
        `SELECT settings_json FROM desk_users WHERE id = $1`,
        [WEBHOOK_USER_ID]
      );
      if (tenantSettings.rows[0]?.settings_json) {
        const s = tenantSettings.rows[0].settings_json;
        const parsed = typeof s === 'string' ? JSON.parse(s) : s;
        if (parsed.twilioNumber) TENANT_FROM_NUMBER  = parsed.twilioNumber;
        if (parsed.notifyPhone)  TENANT_NOTIFY_PHONE = parsed.notifyPhone;
        if (parsed.dealerName)   TENANT_DEALER_NAME  = parsed.dealerName;
        if (parsed.dealerCity)   TENANT_DEALER_CITY  = parsed.dealerCity;
      }
      // Load available inventory for this tenant
      const invResult = await pool.query(
        `SELECT year, make, model, mileage, price, type, condition, stock
         FROM desk_inventory WHERE user_id = $1 AND status = 'available'
         ORDER BY year DESC LIMIT 20`,
        [WEBHOOK_USER_ID]
      );
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
          const _wd = String(phone).replace(/\D/g,'');
          const _nanp = (_wd.length===10&&_wd[0]>='2')||(_wd.length===11&&_wd.startsWith('1')&&_wd[1]>='2');
          if (!_nanp) { console.log('[WEBHOOK] Non-NANP blocked:', phone); return; }
          if (state.aiResponderPaused) { console.log('[WEBHOOK] AI paused, skipping', phone); return; }

          await getOrCreateCustomer(phone, WEBHOOK_USER_ID);

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
          await saveMessage(conversation.id, phone, 'user', message, WEBHOOK_USER_ID);
          try { await logAnalytics('message_received', phone, { message }, WEBHOOK_USER_ID); } catch(e) { console.error('Analytics error:', e.message); }

          const aiResponse = await getJerryResponse(phone, message, conversation, WEBHOOK_USER_ID, TENANT_FROM_NUMBER, TENANT_NOTIFY_PHONE, TENANT_DEALER_NAME, TENANT_DEALER_CITY, TENANT_INVENTORY);
          await saveMessage(conversation.id, phone, 'assistant', aiResponse, WEBHOOK_USER_ID);

          await twilioClient.messages.create({
            body: aiResponse,
            from: TENANT_FROM_NUMBER,
            to: phone
          });
          console.log('✅ Sarah replied:', aiResponse);

          const custName  = conversation.customer_name || 'Unknown';
          const custPhone = formatPretty(phone);
          const preview   = message.length > 100 ? message.substring(0, 100) + '...' : message;
          if (TENANT_NOTIFY_PHONE) {
            twilioClient.messages.create({
              body: `💬 New lead from ${custName}\n📞 ${custPhone}\n\n"${preview}"\n\nReply via: app.firstfinancialcanada.com`,
              from: TENANT_FROM_NUMBER,
              to: TENANT_NOTIFY_PHONE
            }).then(() => {
              console.log(`✅ Notify sent to ${TENANT_NOTIFY_PHONE} from ${TENANT_FROM_NUMBER}`);
            }).catch(err => {
              console.error(`❌ Notify FAILED to ${TENANT_NOTIFY_PHONE} from ${TENANT_FROM_NUMBER}: ${err.message} (code ${err.code})`);
            });
          } else {
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
  async function getJerryResponse(phone, message, conversation, userId, fromNumber, notifyPhone, dealerName = 'the dealership', dealerCity = 'our location', inventory = []) {
    const lowerMsg = message.toLowerCase().trim();
    const name = conversation.customer_name || '';
    function pick(...opts) { return opts[Math.floor(Math.random() * opts.length)]; }

    // ── STOP / UNSUBSCRIBE ────────────────────────────────────
    if (lowerMsg === 'stop' || /^stop[^a-z]/i.test(message.trim()) ||
        lowerMsg.includes('unsubscribe') || lowerMsg.includes('opt out') || lowerMsg.includes('opt-out')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await logAnalytics('conversation_stopped', phone, {}, userId);
      return "You've been unsubscribed and won't receive further messages. Reply START anytime to resume.";
    }

    // ── START / RESUBSCRIBE ───────────────────────────────────
    if (lowerMsg === 'start' || lowerMsg.includes('resubscribe') || lowerMsg.includes('opt in')) {
      await updateConversation(conversation.id, { status: 'active', stage: 'greeting' });
      await logAnalytics('conversation_restarted', phone, {}, userId);
      return `Welcome back! I'm Sarah from ${dealerName}. Are you still looking for a vehicle? Car, Truck, Van, or SUV?`;
    }

    if (conversation.status === 'stopped') {
      return "You're currently unsubscribed. Reply START to receive messages again.";
    }

    // ── NOT INTERESTED ────────────────────────────────────────
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
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `We're in ${dealerCity} — and we deliver all across Canada! I can have one of our guys call you with directions and details. What's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `We're in ${dealerCity} ${name} — and we deliver all across Canada! When's a good time for one of our guys to call you with directions?`;
    }

    if (lowerMsg.includes('financ') || lowerMsg.includes('credit') || lowerMsg.includes('loan') ||
        lowerMsg.includes('bad credit') || lowerMsg.includes('no credit') || lowerMsg.includes('poor credit') ||
        lowerMsg.includes('bankrupt') || lowerMsg.includes('consumer proposal') || lowerMsg.includes('cosign') ||
        lowerMsg.includes('down payment') || lowerMsg.includes('trade') || lowerMsg.includes('trading')) {
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Great question — that's exactly what our finance team handles. We work with all credit situations and have flexible options. What's your name? I'll have someone reach out who can walk you through everything."; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, our finance team handles all of that — they work with every credit situation. When's a good time for them to give you a quick call? No obligation.`;
    }

    if (lowerMsg.includes('how much') || lowerMsg.includes('price') || lowerMsg.includes('cost') ||
        lowerMsg.includes('cheapest') || lowerMsg.includes('expensive') || lowerMsg.includes('rates')) {
      if (!conversation.vehicle_type) { await updateConversation(conversation.id, { stage: 'greeting' }); return "Pricing really depends on what you're looking for! Are you thinking Car, Truck, Van, or SUV? Once I know that I can point you in the right direction."; }
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `${conversation.vehicle_type} pricing varies by year and features. I can have one of our guys text you some options with pricing — what's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, pricing on ${conversation.vehicle_type}s really depends on the specifics. When's a good time for one of our team to call you? They can go over everything and find the best fit.`;
    }

    if (lowerMsg.includes('detail') || lowerMsg.includes('more info') || lowerMsg.includes('tell me more') ||
        lowerMsg.includes('manager') || lowerMsg.includes('speak to') || lowerMsg.includes('talk to someone')) {
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Absolutely — I'll have one of our guys reach out with all the details. What's your name?"; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll get one of our team on it. When's the best time to reach you?`;
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
          return `Yes! We have ${invReply.count} ${typeLabel}${invReply.count > 1 ? 's' : ''} available right now — ${invReply.examples}. I can have someone reach out with photos and details. What's your name?`;
        }
        await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
        return `${name}, we have ${invReply.count} ${typeLabel}${invReply.count > 1 ? 's' : ''} in stock right now — ${invReply.examples}. Want to come see them, or would a quick call to walk through what we've got work better?`;
      }

      // Fallback if no inventory or no match
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Yes! We have a great selection. I can have one of our guys send you photos and details on what we've got — what's your name?"; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll have the team send over what we've got. When's a good time to reach you? They can send photos and walk you through the options.`;
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
          `$${budgetAmount}/month — I've got some great ${conversation.vehicle_type} options in that range. Would you like to come in for a test drive, or would a quick call with one of our guys work better?`,
          `Perfect, around $${budgetAmount}/month. I've got solid options for you. Want to come take a look, or would you rather a quick call first?`
        );
      }
      if (budgetAmount >= 2000) {
        const budgetRange = budgetAmount < 30000 ? 'Under $30k' : budgetAmount < 50000 ? '$30k-$50k' : '$50k+';
        await updateConversation(conversation.id, { budget: budgetRange, budget_amount: budgetAmount, stage: 'appointment' });
        return pick(
          `Around $${(budgetAmount/1000).toFixed(0)}k — solid budget. I've got great options. Would you like to come see them in person, or a quick call to go over what we've got?`,
          `$${(budgetAmount/1000).toFixed(0)}k range — I can work with that! Want to come in for a test drive, or prefer a call first?`
        );
      }
      if (lowerMsg.includes('cheap') || lowerMsg.includes('low') || lowerMsg.includes('budget') || lowerMsg.includes('affordable')) {
        await updateConversation(conversation.id, { budget: 'Under $30k', stage: 'appointment' });
        return "I hear you — we've got great value options. Would you like to come take a look, or should I have one of our guys call you with what's available?";
      }
      if (lowerMsg.includes("don't care") || lowerMsg.includes('whatever') || lowerMsg.includes('open') || lowerMsg.includes('flexible') || lowerMsg.includes('not sure')) {
        await updateConversation(conversation.id, { budget: 'Flexible', stage: 'appointment' });
        return "No problem — we'll find the right fit. Want to come in for a test drive, or would a quick call be easier?";
      }
      if (lowerMsg.includes('high') || lowerMsg.includes('premium') || lowerMsg.includes('luxury')) {
        await updateConversation(conversation.id, { budget: '$50k+', stage: 'appointment' });
        return "Excellent taste! I've got some premium options. Would you like to come see them, or should our team call you with details?";
      }
      if (budgetAmount > 0 && budgetAmount < 100) {
        return "Just to make sure I understand — is that $" + budgetAmount + " per month, or total budget? Most people are in the $300-$700/month range.";
      }
      return pick(
        "Just a rough number is fine — like $300/month, $500/month, or a total budget like $25k, $40k. Whatever you're comfortable with.",
        "What range are you thinking? Like $300-500/month, or a total budget? Just ballpark it for me."
      );
    }

    // ── STAGE 3: APPOINTMENT ──────────────────────────────────
    if (conversation.stage === 'appointment' && !conversation.intent) {
      if (lowerMsg.includes('come') || lowerMsg.includes('visit') || lowerMsg.includes('test') ||
          lowerMsg.includes('drive') || lowerMsg.includes('see') || lowerMsg.includes('look') ||
          lowerMsg.includes('in person') || lowerMsg.includes('show up')) {
        await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when works best for you? We're flexible — mornings, afternoons, evenings, weekends.`
          : "Love it! What's your name so I can get everything set up?";
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
        return `No rush at all${name ? ' '+name : ''}! Whenever you're ready — you can come in for a quick test drive or we can start with a phone call. Either way works.`;
      }
      await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
      return name
        ? `${name}, I've got some great options for you. When can you come take a look? We're flexible on timing.`
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
      await updateConversation(conversation.id, { customer_name: parsedName, stage: 'datetime' });
      await pool.query('UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2', [parsedName, phone]);
      if (conversation.intent === 'test_drive') {
        return pick(
          `Hey ${parsedName}! When works best to come in? We're flexible — mornings, afternoons, evenings, weekends.`,
          `Nice to meet you ${parsedName}! When can you come take a look? We'll have everything ready.`
        );
      } else {
        return pick(
          `Hey ${parsedName}! When's the best time for a quick call? Morning, afternoon, or evening?`,
          `${parsedName}, great! When should we give you a ring? We'll keep it quick.`
        );
      }
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
        return `Perfect ${conversation.customer_name}! You're all set for ${finalDateTime}. We're at ${dealerName} in ${dealerCity} and we deliver across Canada. I'll have everything ready when you get here.\n\nIf anything changes just text me back. See you soon!`;
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
        return `Great question ${name}! We offer full protection packages including payment coverage, powertrain warranty, GAP insurance, and tire & wheel. Your finance manager will walk you through all the options when you come in.`;
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
      return `${name ? name+', would' : 'Would'} you like to come in for a test drive, or would a quick call work better to start?`;
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

