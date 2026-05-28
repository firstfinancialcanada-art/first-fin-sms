// routes/admin.js
const { pool } = require('../lib/db');
const { state } = require('../lib/bulk');

// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}

module.exports = function adminRoutes(app, { twilioClient }) {

  // 🚨 EMERGENCY STOP +12899688778
  app.get('/api/stop-12899688778', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
    }
    const BLOCKED_NUMBERS = ['+12899688778', '12899688778', '2899688778'];
    const client = await pool.connect();
    try {
      let totalBulkDeleted = 0, totalConvStopped = 0, totalApptDeleted = 0, totalCallDeleted = 0;
      for (const num of BLOCKED_NUMBERS) {
        const bulkResult = await client.query('DELETE FROM bulk_messages WHERE recipient_phone LIKE $1', ['%' + num + '%']);
        totalBulkDeleted += bulkResult.rowCount;
        const convResult = await client.query("UPDATE conversations SET status = 'stopped' WHERE customer_phone LIKE $1", ['%' + num + '%']);
        totalConvStopped += convResult.rowCount;
        const apptResult = await client.query('DELETE FROM appointments WHERE customer_phone LIKE $1', ['%' + num + '%']);
        totalApptDeleted += apptResult.rowCount;
        const callResult = await client.query('DELETE FROM callbacks WHERE customer_phone LIKE $1', ['%' + num + '%']);
        totalCallDeleted += callResult.rowCount;
      }
      res.json({
        success: true, blocked: '+12899688778',
        bulkDeleted: totalBulkDeleted, conversationsStopped: totalConvStopped,
        appointmentsDeleted: totalApptDeleted, callbacksDeleted: totalCallDeleted,
        message: 'PERMANENTLY STOPPED & BLOCKED'
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // WIPE ALL BULK MESSAGES
  app.post('/api/wipe-bulk', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
    }
    const client = await pool.connect();
    try {
      const result = await client.query('DELETE FROM bulk_messages');
      res.json({ success: true, wiped: result.rowCount, message: 'Bulk table cleared! Ready for fresh upload.' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // Pause / resume bulk SMS processor
  app.post('/api/bulk-sms/pause', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
    }
    state.bulkSmsProcessorPaused = true;
    res.json({ success: true, paused: true });
  });

  app.post('/api/bulk-sms/resume', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
    }
    state.bulkSmsProcessorPaused = false;
    res.json({ success: true, paused: false });
  });

  // Pause / resume AI responder
  app.post('/api/ai-responder/pause', (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(403).json({ success: false, error: 'Forbidden' });
    state.aiResponderPaused = true;
    res.json({ success: true, paused: true });
  });

  app.post('/api/ai-responder/resume', (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(403).json({ success: false, error: 'Forbidden' });
    state.aiResponderPaused = false;
    res.json({ success: true, paused: false });
  });

  // Nuclear clear
  app.post('/api/nuclear-clear', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(403).json({ success: false, error: 'Forbidden' });
    const results = { twilioQueued: 0, twilioSending: 0, bulkCancelled: 0, errors: [] };
    state.bulkSmsProcessorPaused = true;
    state.aiResponderPaused = true;
    try {
      const queued = await twilioClient.messages.list({ status: 'queued', limit: 200 });
      for (const m of queued) {
        try { await twilioClient.messages(m.sid).update({ status: 'canceled' }); results.twilioQueued++; }
        catch(e) { results.errors.push(e.message); }
      }
    } catch(e) { results.errors.push('list-queued:'+e.message); }
    try {
      const sending = await twilioClient.messages.list({ status: 'sending', limit: 200 });
      for (const m of sending) {
        try { await twilioClient.messages(m.sid).update({ status: 'canceled' }); results.twilioSending++; }
        catch(e) { results.errors.push(e.message); }
      }
    } catch(e) { results.errors.push('list-sending:'+e.message); }
    const client = await pool.connect();
    try {
      const r = await client.query("UPDATE bulk_messages SET status='cancelled', error_message='Nuclear clear' WHERE status='pending'");
      results.bulkCancelled = r.rowCount;
    } catch(e) { results.errors.push('bulk:'+e.message); } finally { client.release(); }
    state.bulkSmsProcessorPaused = false;
    state.aiResponderPaused = false;
    res.json({ success: true, message: 'Flush complete. All systems resumed.', ...results });
  });

  // EMERGENCY STOP - ALL BULK MESSAGES
  app.post('/api/stop-bulk', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
    }
    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE bulk_messages SET status = 'cancelled', error_message = 'Emergency stop by user' WHERE status = 'pending'`
      );
      res.json({ success: true, cancelled: result.rowCount, message: `Emergency stop: ${result.rowCount} pending messages cancelled` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Public inquiry rate limiting + abuse detection ─────────────
  // Bot hit on 2026-05-28 07:23-07:26 UTC inserted 6 garbage rows
  // (Test1-Test5 + "Test User") with sequential phones (5550001-5550005,
  // 5551234567), null email, null dealership — classic scripted POST.
  // Lock it down without killing the legitimate marketing-site form.
  const _inquiryHits = new Map();             // ip -> [timestamps]
  const INQ_WINDOW_MS = 60 * 60 * 1000;       // 1 hour sliding window
  const INQ_MAX_PER_IP = 3;                   // max per IP per window

  // POST /api/request-access
  app.post('/api/request-access', async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || 'unknown';
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 300);
    const { name, dealership, phone, email, website } = req.body || {};

    // Honeypot — hidden `website` form field. Real humans don't see it;
    // bots auto-fill every field. If present + non-empty, silently 200
    // to make the bot think it worked so it doesn't escalate.
    if (typeof website === 'string' && website.trim().length > 0) {
      console.warn(`🪤 inquiry honeypot tripped — ip=${ip} ua=${ua.slice(0, 60)}`);
      return res.json({ success: true });
    }

    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Name and phone are required' });
    }

    // Pattern reject — bot signature: Test\d? name + 555-phone + null
    // email + null dealership. All 6 attack rows matched this; zero
    // legitimate historical inquiries match.
    const looksBot =
      /^Test\s?\w{0,8}$/i.test(String(name).trim()) &&
      /^555/.test(String(phone).replace(/\D/g, '')) &&
      !email && !dealership;
    if (looksBot) {
      console.warn(`🚫 inquiry pattern-block — ip=${ip} name="${name}" phone="${phone}"`);
      return res.json({ success: true });   // 200 to confuse the bot
    }

    // Per-IP rate limit (in-memory, single-instance — fine for Railway 1-replica)
    const now = Date.now();
    const hits = (_inquiryHits.get(ip) || []).filter(t => now - t < INQ_WINDOW_MS);
    if (hits.length >= INQ_MAX_PER_IP) {
      console.warn(`🚫 inquiry rate-limited — ip=${ip} hits=${hits.length}`);
      return res.status(429).json({ success: false, error: 'Too many requests. Please contact First@FirstFinancialCanada.com.' });
    }
    hits.push(now);
    _inquiryHits.set(ip, hits);

    const client = await pool.connect();
    try {
      // Idempotent migration — ip + user_agent columns weren't on the
      // original platform_inquiries table; add them so we can audit.
      await client.query(`
        ALTER TABLE platform_inquiries
          ADD COLUMN IF NOT EXISTS ip TEXT,
          ADD COLUMN IF NOT EXISTS user_agent TEXT
      `).catch(() => {});
      await client.query(
        `INSERT INTO platform_inquiries (name, dealership, phone, email, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
        [name, dealership || null, phone, email || null, ip, ua]
      );
      const ownerPhone = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;
      if (ownerPhone && twilioClient) {
        try {
          await twilioClient.messages.create({
            body: `New platform inquiry — ${dealership || 'Unknown Dealership'}, ${name}, ${phone}`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: ownerPhone
          });
        } catch(e) { console.error('Notify error:', e.message); }
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Request access error:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // Redirect old dashboard URL
  app.get('/dashboard', (req, res) => res.redirect('/'));

};
