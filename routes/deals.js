// routes/deals.js
const { pool, getOrCreateConversation, saveMessage, logAnalytics } = require('../lib/db');
const { normalizePhone, sanitizeError } = require('../lib/helpers');
const { saveBulkCampaign } = require('../lib/bulk');

async function createDealsTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        user_id           INTEGER,
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
    // Safe migration — adds user_id if table already exists without it
    await client.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS user_id INTEGER`).catch(() => {});
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deals_phone  ON deals(customer_phone);
      CREATE INDEX IF NOT EXISTS idx_deals_logged ON deals(logged_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deals_user   ON deals(user_id);
    `);
    console.log('✅ deals table ready');
  } catch (e) {
    console.error('❌ deals table error:', e.message);
  } finally {
    client.release();
  }
}
// Table creation is called explicitly at app startup in index.js

function dealsRoutes(app, { requireAuth, requireBilling, twilioClient }) {

  // ── Qualified leads (Sarah → Desk CRM) ───────────────────────
  app.get('/api/qualified-leads', requireAuth, async (req, res) => {
    const uid = req.user.userId;
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
          EXISTS(SELECT 1 FROM appointments a WHERE a.customer_phone = c.customer_phone AND a.user_id = $1)
                                    AS has_appointment,
          EXISTS(SELECT 1 FROM callbacks cb WHERE cb.customer_phone = c.customer_phone AND cb.user_id = $1)
                                    AS wants_callback,
          (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1)
                                    AS last_message
        FROM conversations c
        LEFT JOIN customers cu ON cu.phone = c.customer_phone AND cu.user_id = $1
        WHERE c.status != 'deleted' AND c.user_id = $1
        ORDER BY c.updated_at DESC
        LIMIT 200
      `, [uid]);
      res.json({ success: true, leads: result.rows, total: result.rows.length });
    } catch (e) {
      console.error('❌ /api/qualified-leads error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally { client.release(); }
  });

  // ── Save deal from Desk ───────────────────────────────────────
  app.post('/api/deals', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const d = req.body.deal || req.body;
      const result = await client.query(`
        INSERT INTO deals (
          user_id,
          customer_name, customer_phone, customer_email,
          vehicle_desc, stock_num,
          selling_price, finance_amount, apr, term_months, monthly_payment,
          down_payment, trade_allowance, trade_payoff, doc_fee, gst_amount,
          vsc_price, gap_price, tw_price, wa_price,
          front_gross, back_gross, total_gross, pvr,
          salesperson, dealership, raw_data
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,$26,$27
        ) RETURNING id, logged_at
      `, [
        req.user.userId,
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
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally { client.release(); }
  });

  // ── Load all deals ────────────────────────────────────────────
  app.get('/api/deals', async (req, res) => {
    const token = req.query.token || req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const client = await pool.connect();
    try {
      const limit = parseInt(req.query.limit) || 100;
      const result = await client.query('SELECT * FROM deals ORDER BY logged_at DESC LIMIT $1', [limit]);
      res.json({ success: true, deals: result.rows, total: result.rows.length });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally { client.release(); }
  });

  // ── Deal funded follow-up SMS ─────────────────────────────────
  app.post('/api/deal-funded', requireAuth, requireBilling, async (req, res) => {
    try {
      const uid = req.user.userId;
      const { phone, customerName, vehicleDesc, dealId, dealership } = req.body;
      if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });
      const normalized = normalizePhone(phone);
      if (!normalized) return res.status(400).json({ success: false, error: 'Invalid phone number' });

      // Resolve tenant's provisioned Twilio number
      let fromNumber = process.env.TWILIO_PHONE_NUMBER;
      let storeName  = dealership || 'First Financial';
      try {
        const ts = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [uid]);
        const s  = ts.rows[0]?.settings_json;
        const parsed = typeof s === 'string' ? JSON.parse(s) : (s || {});
        if (parsed.twilioNumber) fromNumber = parsed.twilioNumber;
        if (parsed.dealerName)   storeName  = dealership || parsed.dealerName || storeName;
      } catch(e) { console.warn('⚠️ deal-funded tenant lookup failed:', e.message); }

      const name    = customerName || 'there';
      const vehicle = vehicleDesc  || 'your new vehicle';
      const message =
        `Hi ${name.split(' ')[0]}! 🎉 Congratulations on your ${vehicle} from ${storeName}! ` +
        `We'd love a quick Google review — it means the world to us: https://g.page/r/review\n\n` +
        `Know anyone looking for a vehicle? Send them our way and we'll take great care of them!`;

      const conversation = await getOrCreateConversation(normalized, uid);
      await saveMessage(conversation.id, normalized, 'assistant', message, uid);
      await twilioClient.messages.create({ body: message, from: fromNumber, to: normalized });

      if (dealId) {
        const client = await pool.connect();
        try { await client.query('UPDATE deals SET follow_up_sent = TRUE WHERE id = $1', [dealId]); }
        finally { client.release(); }
      }

      await logAnalytics('deal_funded_followup', normalized, { vehicleDesc, dealId }, uid);
      console.log(`✅ Deal follow-up SMS sent to ${normalized} [tenant:${uid}] from ${fromNumber}`);
      res.json({ success: true, message: 'Follow-up SMS sent!', to: normalized });
    } catch (e) {
      console.error('❌ /api/deal-funded error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── Bulk SMS campaign from CRM list ──────────────────────────
  app.post('/api/campaign-from-crm', requireAuth, requireBilling, async (req, res) => {
    const token = req.body.token || req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const { campaignName, messageTemplate, contacts } = req.body;
      if (!campaignName || !messageTemplate || !contacts || !contacts.length) {
        return res.status(400).json({ success: false, error: 'campaignName, messageTemplate, contacts[] required' });
      }
      const valid = contacts
        .map(c => ({ ...c, phone: normalizePhone(c.phone) }))
        .filter(c => c.phone);
      if (!valid.length) {
        return res.status(400).json({ success: false, error: 'No valid phone numbers in contacts' });
      }
      await saveBulkCampaign(campaignName, messageTemplate, valid, null);
      console.log(`📋 CRM campaign created: "${campaignName}" — ${valid.length} contacts`);
      res.json({ success: true, message: `Campaign "${campaignName}" created with ${valid.length} contacts`, total: valid.length, skipped: contacts.length - valid.length });
    } catch (e) {
      console.error('❌ /api/campaign-from-crm error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

};

module.exports = dealsRoutes;
module.exports.createDealsTable = createDealsTable;
