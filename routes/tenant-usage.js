// ============================================================
// routes/tenant-usage.js — Tenant spend & capacity visibility
// Mounts: GET /api/tenant/usage
// ============================================================
'use strict';

const { getUsage, checkInventoryCap, checkCrmCap } = require('../lib/spend-cap');

module.exports = function tenantUsageRoutes(app, { requireAuth }) {

  // ── GET /api/tenant/usage ────────────────────────────────────
  // Returns current month's Twilio spend, inventory count, CRM count,
  // cap thresholds, and soft-warn/exceeded flags. Client uses this to
  // render the dashboard usage meter and trigger top-up prompts.
  app.get('/api/tenant/usage', requireAuth, async (req, res) => {
    try {
      const uid = req.user.userId;
      const [spend, inventory, crm] = await Promise.all([
        getUsage(uid),
        checkInventoryCap(uid),
        checkCrmCap(uid, 0),
      ]);
      res.json({ success: true, spend, inventory, crm });
    } catch (e) {
      console.error('❌ /api/tenant/usage error:', e.message);
      res.status(500).json({ success: false, error: 'Failed to fetch usage' });
    }
  });
};
