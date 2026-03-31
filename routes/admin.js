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

  // POST /api/request-access
  app.post('/api/request-access', async (req, res) => {
    const { name, dealership, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Name and phone are required' });
    }
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO platform_inquiries (name, dealership, phone, email) VALUES ($1, $2, $3, $4)`,
        [name, dealership || null, phone, email || null]
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
