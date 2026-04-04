// routes/bulk-sms.js
const { pool, filterOptedOut } = require('../lib/db');
const { state, saveBulkCampaign, getBulkCampaignStats } = require('../lib/bulk');
const { normalizePhone } = require('../lib/helpers');

module.exports = function bulkSmsRoutes(app, { requireAuth, requireBilling }) {

  // ── Parse CSV ─────────────────────────────────────────────────
  app.post('/api/bulk-sms/parse-csv', requireAuth, async (req, res) => {
    try {
      const csvData = req.body.csvData || req.body;
      if (!csvData || typeof csvData !== 'string') {
        return res.status(400).json({ error: 'No CSV data' });
      }
      const lines = csvData.split(/\r?\n/);
      const contacts = [], errors = [], seenPhones = new Set();
      const BLACKLIST = ['2899688778', '12899688778'];
      let startRow = 0;
      if (lines[0] && lines[0].toLowerCase().includes('name')) startRow = 1;

      for (let i = startRow; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(',');
        if (parts.length < 2) { errors.push({ row: i + 1, error: 'Missing name or phone' }); continue; }
        const name      = parts[0].trim().replace(/^[\"']|[\"']$/g, '');
        const rawPhone  = parts[1].trim().replace(/^[\"']|[\"']$/g, '');
        const digitsOnly = rawPhone.replace(/[^0-9]/g, '');
        let phone = digitsOnly;
        if (digitsOnly.length === 10) phone = '1' + digitsOnly;
        if (phone.length !== 11 || !phone.startsWith('1')) { errors.push({ row: i + 1, name, phone: rawPhone, error: 'Invalid phone' }); continue; }
        if (BLACKLIST.some(blocked => phone.includes(blocked))) { errors.push({ row: i + 1, name, phone: rawPhone, error: 'Blacklisted number' }); continue; }
        if (seenPhones.has(phone)) { errors.push({ row: i + 1, name, phone: rawPhone, error: 'Duplicate phone number' }); continue; }
        seenPhones.add(phone);
        contacts.push({ name, phone: '+' + phone, row: i + 1 });
      }
      // CASL: filter out opted-out numbers
      const optedOutSet = await filterOptedOut(contacts.map(c => c.phone));
      const filtered = [];
      for (const c of contacts) {
        if (optedOutSet.has(c.phone)) {
          errors.push({ row: c.row, name: c.name || '', phone: c.phone, error: 'Previously opted out (STOP)' });
        } else {
          filtered.push(c);
        }
      }
      res.json({ success: true, contacts: filtered, errors, total: filtered.length, errorCount: errors.length, optedOut: optedOutSet.size });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Create campaign ───────────────────────────────────────────
  app.post('/api/bulk-sms/create-campaign', requireAuth, requireBilling, async (req, res) => {
    try {
      const { campaignName, messageTemplate, contacts } = req.body;
      if (!campaignName || !messageTemplate || !contacts || contacts.length === 0) {
        return res.status(400).json({ error: 'Missing fields' });
      }
      if (!messageTemplate.includes('{name}')) {
        return res.status(400).json({ error: 'Message must include {name}' });
      }
      if (contacts.length > 500) {
        return res.status(400).json({ error: `Campaign too large — maximum 500 contacts per campaign (you uploaded ${contacts.length}). Split into smaller batches.` });
      }
      if (messageTemplate.length > 1600) {
        return res.status(400).json({ error: 'Message too long (max 1600 characters)' });
      }
      // Cross-campaign duplicate check (last 30 days)
      const phones = contacts.map(c => c.phone);
      const dupResult = await pool.query(
        `SELECT DISTINCT recipient_phone FROM bulk_messages
         WHERE user_id = $1 AND recipient_phone = ANY($2)
         AND status IN ('sent','pending') AND created_at > NOW() - INTERVAL '30 days'`,
        [req.user.userId, phones]
      );
      const recentlySent = new Set(dupResult.rows.map(r => r.recipient_phone));
      if (recentlySent.size > 0) {
        // Warn but don't block — let dealer decide
        console.log(`⚠️ Campaign "${campaignName}": ${recentlySent.size} contacts already contacted in last 30 days`);
      }
      const placeholderCount = (messageTemplate.match(/{name}/g) || []).length;
      if (placeholderCount > 3) {
        console.warn(`⚠️ Campaign "${campaignName}" has ${placeholderCount} {name} placeholders`);
      }
      const messageIds = await saveBulkCampaign(campaignName, messageTemplate, contacts, req.user.userId);
      res.json({ success: true, campaignName, messageCount: messageIds.length, estimatedTime: Math.ceil(contacts.length * 15 / 60) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Campaign stats ────────────────────────────────────────────
  app.get('/api/bulk-sms/campaign/:campaignName', requireAuth, async (req, res) => {
    try {
      const campaignName = decodeURIComponent(req.params.campaignName);
      const stats = await getBulkCampaignStats(campaignName, req.user.userId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Emergency stop all bulk ───────────────────────────────────
  app.post('/api/emergency-stop-bulk', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
    }
    try {
      const client = await pool.connect();
      try {
        if (state.bulkSmsProcessor) {
          clearInterval(state.bulkSmsProcessor);
          state.bulkSmsProcessor = null;
          console.log('🚨 BULK PROCESSOR STOPPED');
        }
        const result = await client.query(
          `UPDATE bulk_messages SET status = 'cancelled', error_message = 'Emergency stop by user' WHERE status = 'pending'`
        );
        res.json({ success: true, message: '🚨 EMERGENCY STOP ACTIVATED', cancelled: result.rowCount, processorStopped: true });
      } finally { client.release(); }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Stop my pending bulk messages (dealer-scoped, JWT auth) ─────
  app.post('/api/bulk-sms/stop-mine', requireAuth, requireBilling, async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `UPDATE bulk_messages SET status = 'cancelled', error_message = 'Stopped by dealer'
           WHERE user_id = $1 AND status = 'pending'`,
          [req.user.userId]
        );
        res.json({ success: true, cancelled: result.rowCount });
      } finally { client.release(); }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Bulk status ───────────────────────────────────────────────
  app.get('/api/bulk-status', requireAuth, async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT status, COUNT(*) as count, COUNT(DISTINCT campaign_name) as campaigns
          FROM bulk_messages WHERE user_id = $1 GROUP BY status
        `, [req.user.userId]);
        res.json({
          processorRunning: state.bulkSmsProcessor !== null,
          paused: state.bulkSmsProcessorPaused,
          stats: result.rows
        });
      } finally { client.release(); }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

};

