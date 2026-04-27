// routes/admin-dashboard.js — FIRST-FIN Admin Panel API
const { pool } = require('../lib/db');
const { TENANT_CAPS } = require('../lib/constants');
const { addOverage } = require('../lib/spend-cap');
const tenants = require('../lib/tenants');

// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}

module.exports = function adminDashboardRoutes(app, { twilioClient } = {}) {

  function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  }

  // ── Audit logging helper ──────────────────────────────────
  async function auditLog(action, targetType, targetId, details, req) {
    try {
      await pool.query(
        `INSERT INTO admin_audit_log (admin_email, action, target_type, target_id, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req?.headers?.['x-admin-email'] || 'admin', action, targetType, targetId, JSON.stringify(details || {}), req?.ip || '']
      );
    } catch (e) { console.error('Audit log error:', e.message); }
  }

  // Serve admin.html without server-side guard — browser navigation can't send headers.
  // All API routes below remain protected by adminAuth.
  app.get('/admin', (req, res) => {
    const path = require('path');
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  // ── GET /api/admin/stats ──────────────────────────────────
  // Uses pool.query (not a single client) — Promise.all on one client would
  // trigger pg's "client is already executing a query" deprecation warning.
  app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
      const [users, inventory, deals, inquiries, conversations, appointments, bulk, sarahActive, subBreakdown] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM desk_users'),
        pool.query('SELECT COUNT(*) FROM desk_inventory').catch(() => ({ rows: [{ count: 0 }] })),
        pool.query('SELECT COUNT(*) FROM desk_deal_log').catch(() => ({ rows: [{ count: 0 }] })),
        pool.query("SELECT COUNT(*) FROM platform_inquiries WHERE status = 'pending'").catch(() => ({ rows: [{ count: 0 }] })),
        pool.query('SELECT COUNT(*) FROM conversations').catch(() => ({ rows: [{ count: 0 }] })),
        pool.query('SELECT COUNT(*) FROM appointments').catch(() => ({ rows: [{ count: 0 }] })),
        pool.query("SELECT COUNT(*) FROM bulk_messages WHERE status = 'pending'").catch(() => ({ rows: [{ count: 0 }] })),
        pool.query("SELECT COUNT(*) FROM desk_users WHERE subscription_status = 'active'").catch(() => ({ rows: [{ count: 0 }] })),
        pool.query("SELECT subscription_status, COUNT(*) as count FROM desk_users GROUP BY subscription_status").catch(() => ({ rows: [] })),
      ]);

      res.json({
        success: true,
        stats: {
          totalUsers:        parseInt(users.rows[0].count),
          activeUsers:       parseInt(sarahActive.rows[0].count),
          pendingInquiries:  parseInt(inquiries.rows[0].count),
          totalInventory:    parseInt(inventory.rows[0].count),
          totalDeals:        parseInt(deals.rows[0].count),
          totalConversations:parseInt(conversations.rows[0].count),
          totalAppointments: parseInt(appointments.rows[0].count),
          pendingBulk:       parseInt(bulk.rows[0].count),
          subBreakdown:      subBreakdown.rows
        }
      });
    } catch(e) {
      console.error('Admin stats error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── GET /api/admin/tenant-usage ──────────────────────────────────
  // Returns all tenants with their current Twilio spend, inventory count,
  // CRM count, and cap status. Used by the admin panel's usage-tracking
  // table. Joins tenant_usage (spend data) with desk_users (identity) and
  // counts desk_inventory + desk_crm on the fly.
  app.get('/api/admin/tenant-usage', adminAuth, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT
          u.id                AS user_id,
          u.email,
          u.subscription_status,
          COALESCE(tu.period_start,          CURRENT_DATE) AS period_start,
          COALESCE(tu.sms_spend_cents,       0)            AS sms_spend_cents,
          COALESCE(tu.voice_spend_cents,     0)            AS voice_spend_cents,
          COALESCE(tu.overage_balance_cents, 0)            AS overage_balance_cents,
          (SELECT COUNT(*)::int FROM desk_inventory WHERE user_id = u.id) AS inventory_count,
          (SELECT COUNT(*)::int FROM desk_crm      WHERE user_id = u.id) AS crm_count
        FROM desk_users u
        LEFT JOIN tenant_usage tu ON tu.user_id = u.id
        ORDER BY (COALESCE(tu.sms_spend_cents, 0) + COALESCE(tu.voice_spend_cents, 0)) DESC,
                 u.email ASC
      `);
      const capCents = TENANT_CAPS.smsVoiceCombinedCents;
      const tenants = q.rows.map(r => {
        const total = (r.sms_spend_cents || 0) + (r.voice_spend_cents || 0);
        return {
          userId:              r.user_id,
          email:               r.email,
          subscriptionStatus:  r.subscription_status,
          periodStart:         r.period_start,
          smsSpendCents:       r.sms_spend_cents,
          voiceSpendCents:     r.voice_spend_cents,
          totalSpendCents:     total,
          capCents,
          spendPct:            Math.min(100, Math.round((total / capCents) * 100)),
          overageBalanceCents: r.overage_balance_cents,
          inventoryCount:      r.inventory_count,
          inventoryCap:        TENANT_CAPS.inventoryMax,
          crmCount:            r.crm_count,
          crmCap:              TENANT_CAPS.crmMax,
        };
      });
      res.json({ success: true, tenants, caps: TENANT_CAPS });
    } catch(e) {
      console.error('Admin tenant-usage error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── POST /api/admin/tenant-usage/:userId/topup ───────────────────
  // Admin-grant overage balance (cents). Mirrors what a Stripe top-up
  // purchase would eventually do but manually for now.
  app.post('/api/admin/tenant-usage/:userId/topup', adminAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const cents  = parseInt(req.body?.cents, 10);
      if (!userId || !cents || cents <= 0) {
        return res.status(400).json({ success: false, error: 'userId and positive cents required' });
      }
      await addOverage(userId, cents);
      await auditLog('TOPUP_OVERAGE', 'desk_users', userId, { cents }, req);
      res.json({ success: true, addedCents: cents });
    } catch(e) {
      console.error('Admin topup error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── GET /api/admin/users ──────────────────────────────────
  app.get('/api/admin/users', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      // Check which columns actually exist on desk_users
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'desk_users'
      `);
      const cols = colCheck.rows.map(r => r.column_name);
      const hasSuspended = cols.includes('suspended');
      const hasCreatedAt = cols.includes('created_at');
      const hasLastLogin = cols.includes('last_login');

      // Try to add suspended if missing
      if (!hasSuspended) {
        try { await client.query('ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT FALSE'); } catch(e) {}
      }

      // Ensure features column exists
      try { await client.query(`ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'`); } catch(e) {}

      const suspendedSel = hasSuspended ? 'COALESCE(u.suspended, FALSE) AS suspended' : 'FALSE AS suspended';
      const createdSel   = hasCreatedAt ? 'u.created_at,' : '';
      const lastLoginSel = hasLastLogin ? 'u.last_login,' : '';
      const orderBy      = hasCreatedAt ? 'ORDER BY u.created_at DESC' : 'ORDER BY u.id DESC';

      // Use LATERAL subqueries instead of multi-table JOIN (avoids cartesian explosion)
      try {
        const result = await client.query(`
          SELECT u.id, u.email, u.display_name, u.role,
                 ${createdSel} ${lastLoginSel}
                 ${suspendedSel},
                 COALESCE(u.subscription_status, 'trial') AS subscription_status,
                 u.trial_ends_at,
                 u.twilio_number,
                 u.stripe_customer_id,
                 u.settings_json,
                 u.scrape_domain,
                 COALESCE(u.features, '{}') AS features,
                 COALESCE(ic.cnt, 0) AS inventory_count,
                 COALESCE(cc.cnt, 0) AS crm_count,
                 COALESCE(vc.cnt, 0) AS conversation_count,
                 COALESCE(ac.cnt, 0) AS appointment_count,
                 COALESCE(t.tier, 'single') AS tenant_tier,
                 COALESCE(t.seats_allowed, 1) AS seats_allowed,
                 t.id AS tenant_id,
                 COALESCE(mc.cnt, 1) AS member_count
          FROM desk_users u
          LEFT JOIN desk_tenants t ON t.owner_user_id = u.id
          LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM desk_inventory WHERE user_id = u.id) ic ON true
          LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM desk_crm WHERE user_id = u.id) cc ON true
          LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM conversations WHERE user_id = u.id) vc ON true
          LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM appointments WHERE user_id = u.id) ac ON true
          LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM desk_members WHERE tenant_id = t.id AND active = TRUE) mc ON true
          ${orderBy}
        `);
        return res.json({ success: true, users: result.rows });
      } catch(joinErr) {
        console.warn('Admin users query failed, bare fallback:', joinErr.message);
      }

      // Last resort — no joins at all
      const result = await client.query(`
        SELECT id, email, display_name, role,
               FALSE AS suspended, 0 AS inventory_count, 0 AS crm_count
        FROM desk_users ORDER BY id DESC
      `);
      res.json({ success: true, users: result.rows });

    } catch(e) {
      console.error('Admin users error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/suspend ─────────────────────
  app.post('/api/admin/users/:id/suspend', adminAuth, async (req, res) => {
    try {
      await pool.query('UPDATE desk_users SET suspended = TRUE WHERE id = $1', [req.params.id]);
      await auditLog('suspend_user', 'user', parseInt(req.params.id), { reason: req.body.reason || '' }, req);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  app.post('/api/admin/users/:id/unsuspend', adminAuth, async (req, res) => {
    try {
      await pool.query('UPDATE desk_users SET suspended = FALSE WHERE id = $1', [req.params.id]);
      await auditLog('unsuspend_user', 'user', parseInt(req.params.id), {}, req);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── DELETE /api/admin/users/:id ───────────────────────────
  // Soft delete — marks user as deleted, data preserved for 30 days
  app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
    const uid = req.params.id;
    try {
      const userRow = await pool.query('SELECT email, display_name FROM desk_users WHERE id = $1', [uid]);
      if (!userRow.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
      await pool.query('UPDATE desk_users SET deleted_at = NOW(), suspended = TRUE WHERE id = $1', [uid]);
      await auditLog('soft_delete_user', 'user', parseInt(uid), { email: userRow.rows[0].email, name: userRow.rows[0].display_name }, req);
      res.json({ success: true, softDeleted: true, message: 'User soft-deleted. Can be restored within 30 days.' });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // Restore soft-deleted user
  app.post('/api/admin/users/:id/restore', adminAuth, async (req, res) => {
    const uid = req.params.id;
    try {
      await pool.query('UPDATE desk_users SET deleted_at = NULL, suspended = FALSE WHERE id = $1', [uid]);
      await auditLog('restore_user', 'user', parseInt(uid), {}, req);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // Permanent purge — only for users deleted 30+ days ago
  app.post('/api/admin/users/:id/purge', adminAuth, async (req, res) => {
    const client = await pool.connect();
    const uid = req.params.id;
    try {
      const check = await client.query('SELECT email, deleted_at FROM desk_users WHERE id = $1', [uid]);
      if (!check.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
      if (!check.rows[0].deleted_at) return res.status(400).json({ success: false, error: 'User not soft-deleted. Delete first.' });
      const daysDeleted = (Date.now() - new Date(check.rows[0].deleted_at).getTime()) / 86400000;
      if (daysDeleted < 30 && !req.body.force) return res.status(400).json({ success: false, error: `Only ${Math.floor(daysDeleted)} days since deletion. Wait 30 days or pass force:true.` });
      // Cascade delete all data — table names hardcoded (never from user input)
      await client.query('DELETE FROM desk_refresh_tokens WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM desk_inventory WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM desk_crm WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM desk_deal_log WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM conversations WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM appointments WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM callbacks WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM bulk_messages WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM voicemails WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM lender_rate_sheets WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM desk_scenarios WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM deal_outcomes WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM feature_events WHERE user_id = $1', [uid]).catch(() => {});
      await client.query('DELETE FROM desk_users WHERE id = $1', [uid]);
      await auditLog('purge_user', 'user', parseInt(uid), { email: check.rows[0].email, daysDeleted: Math.floor(daysDeleted) }, req);
      res.json({ success: true, purged: true });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally { client.release(); }
  });

  // ── GET /api/admin/inquiries ──────────────────────────────
  app.get('/api/admin/inquiries', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS platform_inquiries (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          dealership TEXT,
          phone TEXT NOT NULL,
          email TEXT,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      const result = await client.query('SELECT * FROM platform_inquiries ORDER BY created_at DESC');
      res.json({ success: true, inquiries: result.rows });
    } catch(e) {
      console.error('Admin inquiries error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/inquiries/:id/status ──────────────────
  app.post('/api/admin/inquiries/:id/status', adminAuth, async (req, res) => {
    const { status } = req.body;
    const client = await pool.connect();
    try {
      await client.query('UPDATE platform_inquiries SET status = $1 WHERE id = $2', [status, req.params.id]);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/create ─────────────────────────
  app.post('/api/admin/users/create', adminAuth, async (req, res) => {
    const bcrypt = require('bcryptjs');
    const { email, password, name, dealerName } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ success: false, error: 'email, password, name required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const client = await pool.connect();
    try {
      const existing = await client.query('SELECT id FROM desk_users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }
      const hash = await bcrypt.hash(password, 12);
      const result = await client.query(
        `INSERT INTO desk_users (email, password_hash, display_name, role, settings_json, subscription_status)
         VALUES ($1, $2, $3, 'owner', $4, 'active') RETURNING id, email, display_name`,
        [email.toLowerCase(), hash, name, JSON.stringify({ salesName: name, dealerName: dealerName || name + ' Auto' })]
      );
      res.json({ success: true, user: result.rows[0] });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/subscription ───────────────
  app.post('/api/admin/users/:id/subscription', adminAuth, async (req, res) => {
    const { status } = req.body;
    const allowed = ['active', 'trial', 'lapsed', 'cancelled', 'past_due'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }
    const client = await pool.connect();
    try {
      const result = await client.query(
        'UPDATE desk_users SET subscription_status = $1 WHERE id = $2 RETURNING id, email, subscription_status',
        [status, req.params.id]
      );
      await auditLog('set_subscription', 'user', parseInt(req.params.id), { status }, req);
      res.json({ success: true, user: result.rows[0] });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/reset-password ──────────────
  app.post('/api/admin/users/:id/reset-password', adminAuth, async (req, res) => {
    const bcrypt = require('bcryptjs');
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    const client = await pool.connect();
    try {
      const hash = await bcrypt.hash(password, 12);
      await client.query('UPDATE desk_users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/release-number ──────────────
  // Releases a tenant's Twilio number back to Twilio's pool and clears it from their account
  app.post('/api/admin/users/:id/release-number', adminAuth, async (req, res) => {
    if (!twilioClient) return res.status(503).json({ success: false, error: 'Twilio not configured on server' });
    const client = await pool.connect();
    try {
      // Fetch the tenant's current twilio_number
      const row = await client.query(
        'SELECT twilio_number, settings_json FROM desk_users WHERE id = $1',
        [req.params.id]
      );
      if (!row.rows.length) return res.status(404).json({ success: false, error: 'Tenant not found' });

      const { twilio_number, settings_json } = row.rows[0];
      if (!twilio_number) {
        return res.status(400).json({ success: false, error: 'This tenant has no Twilio number assigned' });
      }

      // Find the Twilio IncomingPhoneNumber SID by number, then delete it
      const numbers = await twilioClient.incomingPhoneNumbers
        .list({ phoneNumber: twilio_number, limit: 1 });

      if (numbers.length > 0) {
        await twilioClient.incomingPhoneNumbers(numbers[0].sid).remove();
        console.log(`✅ Twilio number released: ${twilio_number} (SID: ${numbers[0].sid}) — tenant ${req.params.id}`);
      } else {
        // Number not found in Twilio (may have been manually removed) — still clear from DB
        console.warn(`⚠️  Twilio number ${twilio_number} not found in account — clearing from DB only`);
      }

      // Clear from settings_json and twilio_number column
      const s = typeof settings_json === 'string' ? JSON.parse(settings_json || '{}') : (settings_json || {});
      delete s.twilioNumber;
      delete s.wizDone; // Reset wizard so tenant re-runs setup with a new number
      await client.query(
        'UPDATE desk_users SET twilio_number = NULL, settings_json = $1::jsonb WHERE id = $2',
        [JSON.stringify(s), req.params.id]
      );

      res.json({
        success: true,
        releasedNumber: twilio_number,
        message: `${twilio_number} released from Twilio and cleared from tenant account. Wizard reset so they can claim a new number.`
      });
    } catch(e) {
      console.error('Release number error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/features ───────────────────
  // Sets per-tenant feature flags: { sarah, dt_sync, fb_poster }
  app.post('/api/admin/users/:id/features', adminAuth, async (req, res) => {
    const allowed = ['sarah', 'dt_sync', 'fb_poster'];
    const incoming = req.body; // e.g. { sarah: true, dt_sync: false, fb_poster: true }
    const features = {};
    for (const key of allowed) {
      if (key in incoming) features[key] = !!incoming[key];
    }
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE desk_users SET features = $1::jsonb WHERE id = $2`,
        [JSON.stringify(features), req.params.id]
      );
      res.json({ success: true, features });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/scrape-domain ────────────────
  app.post('/api/admin/users/:id/scrape-domain', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { domain } = req.body;
      const clean = domain ? domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim().toLowerCase() : null;
      await client.query('ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS scrape_domain VARCHAR(255) DEFAULT NULL').catch(() => {});
      await client.query('UPDATE desk_users SET scrape_domain = $1 WHERE id = $2', [clean || null, req.params.id]);
      res.json({ success: true, scrape_domain: clean || null });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/fintest/reset ─────────────────────────
  // Uses pool.query (not a single client) — Promise.all on one client would
  // trigger pg's "client is already executing a query" deprecation warning.
  app.post('/api/admin/fintest/reset', adminAuth, async (req, res) => {
    try {
      const u = await pool.query("SELECT id FROM desk_users WHERE email = 'fintest@fintest.com'");
      if (!u.rows.length) return res.status(404).json({ success: false, error: 'fintest account not found' });
      const uid = u.rows[0].id;
      await Promise.all([
        pool.query('DELETE FROM desk_inventory WHERE user_id = $1', [uid]),
        pool.query('DELETE FROM desk_deal_log WHERE user_id = $1', [uid]).catch(() => {}),
        pool.query('DELETE FROM desk_crm WHERE user_id = $1', [uid]).catch(() => {}),
        pool.query('DELETE FROM conversations WHERE user_id = $1', [uid]).catch(() => {}),
        pool.query('DELETE FROM appointments WHERE user_id = $1', [uid]).catch(() => {}),
        pool.query('DELETE FROM callbacks WHERE user_id = $1', [uid]).catch(() => {}),
        pool.query('DELETE FROM messages WHERE user_id = $1', [uid]).catch(() => {}),
      ]);
      res.json({ success: true, message: 'fintest account reset — all data cleared' });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── POST /api/admin/wipe-inventory/:email — delete only inventory for a user ──
  app.post('/api/admin/wipe-inventory/:email', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const u = await client.query('SELECT id FROM desk_users WHERE email = $1', [req.params.email]);
      if (!u.rows.length) return res.status(404).json({ success: false, error: 'user not found' });
      const uid = u.rows[0].id;
      const result = await client.query('DELETE FROM desk_inventory WHERE user_id = $1', [uid]);
      res.json({ success: true, deleted: result.rowCount, message: `Wiped ${result.rowCount} inventory items for ${req.params.email}` });
    } catch(e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ── GET /api/admin/system-status ──────────────────────────
  // ── TENANT HEALTH DASHBOARD ──────────────────────────────────────
  // Returns per-tenant usage stats, churn risk, feature adoption
  app.get('/api/admin/tenant-health', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      // Main tenant query — join desk_users with feature_events and conversations
      const { rows } = await client.query(`
        SELECT
          u.id,
          u.email,
          u.display_name,
          u.subscription_status,
          u.trial_ends_at,
          u.created_at            AS joined_at,
          u.last_active,
          u.twilio_number,
          u.settings_json,
          -- Days since last active
          EXTRACT(DAY FROM NOW() - u.last_active)::int AS days_inactive,
          -- Feature usage counts (last 30 days)
          COALESCE(fe.deal_count,  0) AS deals_last_30d,
          COALESCE(fe.inv_count,   0) AS inventory_uploads_last_30d,
          COALESCE(fe.crm_count,   0) AS crm_entries_last_30d,
          COALESCE(fe.set_count,   0) AS settings_saves_last_30d,
          COALESCE(fe.pdf_count,   0) AS lender_pdfs_last_30d,
          -- SARAH stats (all time)
          COALESCE(cv.total_convs, 0) AS total_conversations,
          COALESCE(cv.converted,   0) AS total_conversions,
          COALESCE(cv.appts,       0) AS total_appointments
        FROM desk_users u
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE feature = 'deal_desk')   AS deal_count,
            COUNT(*) FILTER (WHERE feature = 'inventory')   AS inv_count,
            COUNT(*) FILTER (WHERE feature = 'crm')         AS crm_count,
            COUNT(*) FILTER (WHERE feature = 'settings')    AS set_count,
            COUNT(*) FILTER (WHERE feature = 'lenders')     AS pdf_count
          FROM feature_events
          WHERE user_id = u.id AND created_at > NOW() - INTERVAL '30 days'
        ) fe ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)                                           AS total_convs,
            COUNT(*) FILTER (WHERE status = 'converted')       AS converted,
            0                                                  AS appts
          FROM conversations
          WHERE user_id = u.id
        ) cv ON true
        WHERE u.role != 'admin'
        AND u.email NOT IN ('fintest@fintest.com', 'kevlarkarz@gmail.com')
        ORDER BY u.last_active DESC NULLS LAST
      `);

      // Churn risk scoring
      const tenants = rows.map(t => {
        const daysInactive   = t.days_inactive ?? null;     // null = never logged in
        const neverLoggedIn  = daysInactive === null;
        const hasActivity    = t.deals_last_30d > 0 || t.crm_entries_last_30d > 0 || t.inventory_uploads_last_30d > 0;
        const isTrial        = t.subscription_status === 'trial';
        const trialExpired   = isTrial && t.trial_ends_at && new Date(t.trial_ends_at) < new Date();
        // How old is the account in days?
        const accountAgeDays = t.joined_at
          ? Math.floor((Date.now() - new Date(t.joined_at)) / 86400000) : 0;

        let churnRisk = 'active';
        if (trialExpired) {
          churnRisk = 'critical';
        } else if (neverLoggedIn && accountAgeDays > 3) {
          // Signed up but hasn't used it yet — not inactive, just not started
          churnRisk = 'medium';
        } else if (!neverLoggedIn && daysInactive > 21 && !hasActivity) {
          churnRisk = 'high';
        } else if (!neverLoggedIn && (daysInactive > 14 || (!hasActivity && accountAgeDays > 7))) {
          churnRisk = 'medium';
        } else {
          churnRisk = 'active';
        }

        const settings = typeof t.settings_json === 'string'
          ? JSON.parse(t.settings_json || '{}') : (t.settings_json || {});

        return {
          id:              t.id,
          email:           t.email,
          name:            t.display_name || settings.dealerName || t.email,
          dealerName:      settings.dealerName || '—',
          dealerCity:      settings.dealerCity || '—',
          status:          t.subscription_status,
          joinedAt:        t.joined_at,
          lastActive:      t.last_active,
          daysInactive:    daysInactive,
          hasPhone:        !!t.twilio_number,
          churnRisk,
          usage: {
            deals:         t.deals_last_30d,
            inventory:     t.inventory_uploads_last_30d,
            crm:           t.crm_entries_last_30d,
            settings:      t.settings_saves_last_30d,
            lenderPdfs:    t.lender_pdfs_last_30d,
          },
          sarah: {
            conversations: t.total_conversations,
            conversions:   t.total_conversions,
            appointments:  t.total_appointments,
          }
        };
      });

      // Platform-wide summary
      const summary = {
        total:       tenants.length,
        active30d:   tenants.filter(t => t.daysInactive !== null && t.daysInactive <= 30).length,
        riskHigh:    tenants.filter(t => t.churnRisk === 'high' || t.churnRisk === 'critical').length,
        riskMedium:  tenants.filter(t => t.churnRisk === 'medium').length,
        neverLoggedIn: tenants.filter(t => t.daysInactive === null).length,
        noPhone:     tenants.filter(t => !t.hasPhone).length,
        trials:      tenants.filter(t => t.status === 'trial').length,
      };

      res.json({ success: true, tenants, summary });
    } catch(e) {
      console.error('⚠️ tenant-health error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.get('/api/admin/system-status', adminAuth, async (req, res) => {
    const { state } = require('../lib/bulk');
    const client = await pool.connect();
    try {
      const queueR = await client.query(`
        SELECT COUNT(*) AS pending,
               EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/60 AS oldest_minutes
        FROM bulk_messages WHERE status = 'pending'
      `).catch(() => ({ rows: [{ pending: 0, oldest_minutes: null }] }));
      const q = queueR.rows[0];
      res.json({
        success: true,
        bulkProcessorRunning: !!state.bulkSmsProcessor,
        bulkPaused:           state.bulkSmsProcessorPaused,
        aiPaused:             state.aiResponderPaused,
        uptime:               Math.floor(process.uptime()),
        nodeVersion:          process.version,
        memoryMB:             Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        pendingBulk:          parseInt(q.pending) || 0,
        oldestPendingMinutes: q.oldest_minutes != null ? Math.floor(parseFloat(q.oldest_minutes)) : null
      });
    } finally {
      client.release();
    }
  });

  // ── GET /api/admin/users/:id/settings ────────────────────
  app.get('/api/admin/users/:id/settings', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const r = await client.query(
        'SELECT settings_json, email, display_name FROM desk_users WHERE id = $1',
        [req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
      const s = typeof r.rows[0].settings_json === 'string'
        ? JSON.parse(r.rows[0].settings_json || '{}')
        : (r.rows[0].settings_json || {});
      res.json({ success: true, settings: s, email: r.rows[0].email, name: r.rows[0].display_name });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/settings ───────────────────
  app.post('/api/admin/users/:id/settings', adminAuth, async (req, res) => {
    const allowed = ['dealerName','dealerCity','dealerPhone','salesName','googleReviewUrl','docFee','gst','apr','target'];
    const client = await pool.connect();
    try {
      const r = await client.query('SELECT settings_json FROM desk_users WHERE id = $1', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
      const existing = typeof r.rows[0].settings_json === 'string'
        ? JSON.parse(r.rows[0].settings_json || '{}')
        : (r.rows[0].settings_json || {});
      for (const key of allowed) {
        if (key in req.body) existing[key] = req.body[key];
      }
      await client.query('UPDATE desk_users SET settings_json = $1::jsonb WHERE id = $2', [JSON.stringify(existing), req.params.id]);
      res.json({ success: true, settings: existing });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // MULTI-USER TENANT + MEMBER ADMIN API (Phase 3)
  //
  // Tenant is resolved via owner_user_id (each existing desk_users row
  // owns exactly one tenant, established by the Phase 1 backfill). The
  // :userId param in these routes refers to the tenant OWNER's user id,
  // matching the identifier used throughout the existing admin panel.
  // ═══════════════════════════════════════════════════════════════════

  // ── GET /api/admin/tenant/:userId/members ─────────────────────────
  // Returns tenant header (id, tier, seats, dealership, owner) plus the
  // full member roster. Used by the admin UI when operator opens the
  // Members panel for a tenant.
  app.get('/api/admin/tenant/:userId/members', adminAuth, async (req, res) => {
    try {
      const ownerId = parseInt(req.params.userId, 10);
      if (!ownerId) return res.status(400).json({ success: false, error: 'Invalid user id' });
      const t = await pool.query(
        `SELECT id, tier, seats_allowed, dealership, owner_user_id, stripe_sub_id, created_at
           FROM desk_tenants WHERE owner_user_id = $1`,
        [ownerId]
      );
      if (!t.rows.length) {
        // Owner exists but no tenant row yet — rare edge case (race between
        // signup and boot backfill). Surface it instead of silently 404'ing.
        return res.status(404).json({ success: false, error: 'Tenant not found for this user — try again after next deploy.' });
      }
      const tenant  = t.rows[0];
      const members = await tenants.listMembers(tenant.id);
      const usage   = await tenants.getSeatUsage(tenant.id);
      res.json({ success: true, tenant, members, usage });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── POST /api/admin/tenant/:userId/tier ───────────────────────────
  // Body: { tier: 'single' | 'gold' }
  // Flips a tenant's tier and resets seats_allowed to the tier default
  // (1 for single, 10 for gold). Existing members are NOT auto-removed
  // when downgrading — an operator must remove them manually if the new
  // seat cap is exceeded. Used for manual comp / upgrade flows until the
  // Stripe webhook tier-sync is wired up.
  app.post('/api/admin/tenant/:userId/tier', adminAuth, async (req, res) => {
    try {
      const ownerId = parseInt(req.params.userId, 10);
      const { tier } = req.body || {};
      if (!ownerId) return res.status(400).json({ success: false, error: 'Invalid user id' });
      if (!tenants.VALID_TIERS.includes(tier)) {
        return res.status(400).json({ success: false, error: 'Invalid tier. Expected: ' + tenants.VALID_TIERS.join(' | ') });
      }
      const t = await pool.query(`SELECT id FROM desk_tenants WHERE owner_user_id = $1`, [ownerId]);
      if (!t.rows.length) return res.status(404).json({ success: false, error: 'Tenant not found' });
      await tenants.setTenantTier(t.rows[0].id, tier);
      await auditLog('set_tenant_tier', 'tenant', t.rows[0].id, { tier }, req);
      res.json({ success: true, tenantId: t.rows[0].id, tier });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── POST /api/admin/tenant/:userId/members ────────────────────────
  // Body: { email, name, role, crmMode? }
  // Invites a new user into this tenant. Creates the desk_users row
  // (with a placeholder bcrypt hash that CAN'T be logged in with), adds
  // a desk_members row with the chosen role/crm_mode, and issues a
  // 24h setup_tokens row so the admin can share `${BASE_URL}/setup?token=
  // xxx` with the invitee to set their password and get a working login.
  //
  // Enforces the tenant's seat cap via tenants.addMember.
  app.post('/api/admin/tenant/:userId/members', adminAuth, async (req, res) => {
    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');
    const ownerId = parseInt(req.params.userId, 10);
    const { email, name, role = 'rep', crmMode = 'pool_plus_own' } = req.body || {};
    if (!ownerId)         return res.status(400).json({ success: false, error: 'Invalid user id' });
    if (!email || !name)  return res.status(400).json({ success: false, error: 'email and name required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }
    if (!tenants.VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role. Expected: ' + tenants.VALID_ROLES.join(' | ') });
    }
    if (!tenants.VALID_CRM_MODES.includes(crmMode)) {
      return res.status(400).json({ success: false, error: 'Invalid crmMode' });
    }
    if (role === 'owner') {
      return res.status(400).json({ success: false, error: 'Cannot invite another owner — each tenant has exactly one' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Resolve tenant
      const tRow = await client.query(`SELECT id, dealership FROM desk_tenants WHERE owner_user_id = $1`, [ownerId]);
      if (!tRow.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Tenant not found' }); }
      const tenantId = tRow.rows[0].id;

      // Seat cap check (also double-checked inside tenants.addMember)
      const usage = await tenants.getSeatUsage(tenantId);
      if (usage.remaining <= 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: `Tenant has no seats remaining (${usage.used}/${usage.allowed})` });
      }

      const cleanEmail = email.trim().toLowerCase();

      // Look up or create desk_users row for this email
      let userId;
      const existing = await client.query('SELECT id FROM desk_users WHERE email = $1', [cleanEmail]);
      if (existing.rows.length) {
        userId = existing.rows[0].id;
        // Defensive: don't auto-merge a user that already belongs to a
        // different tenant's member set — admin has to resolve that
        // manually.
        const conflict = await client.query(
          `SELECT tenant_id FROM desk_members WHERE user_id = $1 AND active = TRUE AND tenant_id != $2`,
          [userId, tenantId]
        );
        if (conflict.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, error: 'That email is already active on another tenant.' });
        }
      } else {
        // Placeholder hash that can't be logged in with — user MUST
        // complete the setup flow to set a real password.
        const placeholder = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 12);
        const u = await client.query(
          `INSERT INTO desk_users (email, password_hash, display_name, role, subscription_status)
           VALUES ($1, $2, $3, 'rep', 'active')
           RETURNING id`,
          [cleanEmail, placeholder, name.trim()]
        );
        userId = u.rows[0].id;
      }

      // Wire up the desk_members row (tenants.addMember wraps its own
      // seat-cap check + UPSERT). Called outside the client transaction
      // because it uses the shared pool, but safe here since the row
      // tenant_id resolved above still holds (desk_tenants isn't mutated
      // in this txn).
      await tenants.addMember(tenantId, userId, role, crmMode);

      // Issue a 24h setup token so the admin can send the invitee a
      // setup link.
      const setupToken = crypto.randomBytes(32).toString('hex');
      await client.query(
        `INSERT INTO setup_tokens (token, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
        [setupToken, userId]
      );
      await client.query('COMMIT');

      const baseUrl = process.env.BASE_URL
        ? process.env.BASE_URL.replace(/\/$/, '')
        : 'https://app.firstfinancialcanada.com';
      const setupUrl = `${baseUrl}/setup?token=${setupToken}`;

      await auditLog('invite_member', 'tenant', tenantId, { userId, email: cleanEmail, role, crmMode }, req);
      res.json({ success: true, userId, tenantId, role, crmMode, setupUrl });
    } catch(e) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error('invite member error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/admin/users/:id/onboarding-repair ───────────────────
  // One-shot fixer for a paid customer whose onboarding is in a partial
  // state. Built 2026-04-27 after Mil at Hunt Chrysler entered the
  // dealership main line at checkout (so the welcome SMS went to the
  // wrong phone) and his account landed without a desk_tenants row
  // (Phase 6e gap, now patched at the webhook but pre-fix accounts
  // still need this).
  //
  // Body (all optional):
  //   phone:             new phone for platform_inquiries.phone (digits only or E.164)
  //   leadIntakeEmail:   sets desk_tenants.lead_intake_email
  //   tier:              'single' | 'gold' | 'platinum' — also resets seats_allowed
  //   generateFreshLink: default TRUE — invalidates live setup_tokens for this
  //                      owner and issues a new 24h one. Returned as setupUrl.
  //
  // Returns: { success, tenantId, tier, setupUrl?, invalidatedTokens,
  //            tenantBackfilled, phoneUpdated, intakeEmailUpdated }
  app.post('/api/admin/users/:id/onboarding-repair', adminAuth, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!userId) return res.status(400).json({ success: false, error: 'Invalid user id' });

    const { phone, leadIntakeEmail, tier, generateFreshLink = true } = req.body || {};
    if (tier !== undefined && !tenants.VALID_TIERS.includes(tier)) {
      return res.status(400).json({ success: false, error: 'Invalid tier. Expected: ' + tenants.VALID_TIERS.join(' | ') });
    }
    if (leadIntakeEmail !== undefined && leadIntakeEmail !== null && leadIntakeEmail !== '') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(leadIntakeEmail)) {
        return res.status(400).json({ success: false, error: 'Invalid leadIntakeEmail' });
      }
    }

    try {
      const u = await pool.query(`SELECT id, email, display_name, settings_json FROM desk_users WHERE id = $1`, [userId]);
      if (!u.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
      const userRow = u.rows[0];

      // Resolve dealership name for ensureOwnerTenant (used if we need to backfill)
      let dealership = '';
      try {
        const s = typeof userRow.settings_json === 'string' ? JSON.parse(userRow.settings_json || '{}') : (userRow.settings_json || {});
        dealership = s.dealerName || s.dealership || userRow.display_name || '';
      } catch { dealership = userRow.display_name || ''; }

      // Was a tenant present BEFORE we touched anything? (for response payload)
      const before = await pool.query(`SELECT id FROM desk_tenants WHERE owner_user_id = $1`, [userId]);
      const hadTenant = before.rows.length > 0;

      // Resolve target tier — body wins, else current, else 'single'
      let targetTier = tier;
      if (!targetTier) {
        if (hadTenant) {
          const t = await pool.query(`SELECT tier FROM desk_tenants WHERE owner_user_id = $1`, [userId]);
          targetTier = t.rows[0]?.tier || 'single';
        } else {
          targetTier = 'single';
        }
      }

      const { tenantId } = await tenants.ensureOwnerTenant(userId, dealership, targetTier);
      const tenantBackfilled = !hadTenant;

      // ── lead_intake_email ────────────────────────────────────────────
      let intakeEmailUpdated = false;
      if (leadIntakeEmail !== undefined && leadIntakeEmail !== null) {
        try {
          await pool.query(
            `UPDATE desk_tenants SET lead_intake_email = $1 WHERE id = $2`,
            [leadIntakeEmail || null, tenantId]
          );
          intakeEmailUpdated = true;
        } catch (e) {
          console.warn('lead_intake_email update skipped:', e.message);
        }
      }

      // ── platform_inquiries.phone ─────────────────────────────────────
      let phoneUpdated = false;
      if (phone) {
        const storedPhone = String(phone).replace(/^\+?1?/, '').replace(/\D/g, '');
        const r = await pool.query(
          `UPDATE platform_inquiries SET phone = $1 WHERE LOWER(email) = LOWER($2)`,
          [storedPhone, userRow.email]
        );
        phoneUpdated = r.rowCount > 0;
      }

      // ── Invalidate live setup_tokens (security) ──────────────────────
      let invalidatedTokens = 0;
      let setupUrl = null;
      if (generateFreshLink) {
        const expired = await pool.query(
          `UPDATE setup_tokens SET expires_at = NOW()
            WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
            RETURNING token`,
          [userId]
        );
        invalidatedTokens = expired.rowCount;

        const crypto = require('crypto');
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
          `INSERT INTO setup_tokens (token, user_id, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
          [token, userId]
        );
        const baseUrl = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : 'https://app.firstfinancialcanada.com';
        setupUrl = `${baseUrl}/setup?token=${token}`;
      }

      await auditLog('onboarding_repair', 'user', userId, {
        tier: targetTier, tenantBackfilled, phoneUpdated, intakeEmailUpdated, invalidatedTokens, freshLink: !!setupUrl,
      }, req);

      res.json({
        success: true,
        tenantId,
        tier: targetTier,
        setupUrl,
        invalidatedTokens,
        tenantBackfilled,
        phoneUpdated,
        intakeEmailUpdated,
      });
    } catch (e) {
      console.error('onboarding-repair error:', e);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── PATCH /api/admin/member/:memberId ─────────────────────────────
  // Body: { role?, crmMode?, sarahNumber?, active? }
  // Updates a single member's settings. Owner role can't be demoted via
  // this endpoint — ownership transfer is a separate flow (not yet
  // implemented; operator would do it via direct DB in an emergency).
  app.patch('/api/admin/member/:memberId', adminAuth, async (req, res) => {
    const memberId = parseInt(req.params.memberId, 10);
    if (!memberId) return res.status(400).json({ success: false, error: 'Invalid member id' });
    try {
      const m = await pool.query(`SELECT id, tenant_id, user_id, role FROM desk_members WHERE id = $1`, [memberId]);
      if (!m.rows.length) return res.status(404).json({ success: false, error: 'Member not found' });
      if (m.rows[0].role === 'owner' && req.body.role && req.body.role !== 'owner') {
        return res.status(400).json({ success: false, error: 'Cannot demote tenant owner via this endpoint' });
      }
      await tenants.updateMember(memberId, {
        role:        req.body.role,
        crmMode:     req.body.crmMode,
        sarahNumber: req.body.sarahNumber,
        active:      req.body.active,
      });
      await auditLog('update_member', 'member', memberId, req.body, req);
      res.json({ success: true });
    } catch(e) {
      res.status(400).json({ success: false, error: e.message || sanitizeError(e) });
    }
  });

  // ── DELETE /api/admin/member/:memberId ────────────────────────────
  // Soft-remove a member (sets active = FALSE). The desk_users row and
  // the member history are preserved. Owner role cannot be removed —
  // deleting the owner would orphan the tenant.
  app.delete('/api/admin/member/:memberId', adminAuth, async (req, res) => {
    const memberId = parseInt(req.params.memberId, 10);
    if (!memberId) return res.status(400).json({ success: false, error: 'Invalid member id' });
    try {
      const m = await pool.query(`SELECT id, tenant_id, user_id, role FROM desk_members WHERE id = $1`, [memberId]);
      if (!m.rows.length) return res.status(404).json({ success: false, error: 'Member not found' });
      if (m.rows[0].role === 'owner') {
        return res.status(400).json({ success: false, error: 'Cannot remove tenant owner. Delete the tenant instead.' });
      }
      await tenants.removeMember(memberId);
      await auditLog('remove_member', 'member', memberId, {}, req);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // LEAD INTAKE ADDRESS + ROUTING RULES (Build 4)
  // Per-tenant config for the email-forwarding lead ingestion built
  // in Builds 1-3. Operator sets the intake address (e.g.,
  // miltonchrysler@firstfinancialcanada.com) per tenant; manager
  // dashboard reads the address + manages routing rules from the
  // platform side (Phase 5 had per-route role gating; rules need
  // similar — they're added to the platform, not /admin, so any
  // logged-in manager can edit them via the UI in their tenant).
  // ═══════════════════════════════════════════════════════════════════

  // ── GET /api/admin/tenant/:userId/intake ──────────────────────────
  // Returns the tenant's lead_intake_email + a sample preview of the
  // setup instructions text the dealer copies into AutoTrader/Kijiji.
  app.get('/api/admin/tenant/:userId/intake', adminAuth, async (req, res) => {
    try {
      const ownerId = parseInt(req.params.userId, 10);
      if (!ownerId) return res.status(400).json({ success: false, error: 'Invalid user id' });
      const t = await pool.query(
        `SELECT id, lead_intake_email, dealership FROM desk_tenants
          WHERE owner_user_id = $1`,
        [ownerId]
      );
      if (!t.rows.length) return res.status(404).json({ success: false, error: 'Tenant not found' });
      const row = t.rows[0];
      // Recent intake activity (last 10) for quick health check
      const log = await pool.query(
        `SELECT id, message_id, intake_addr, sender_from, subject, source,
                status, error, processed_at
           FROM lead_intake_log
          WHERE tenant_id = $1
          ORDER BY processed_at DESC LIMIT 10`,
        [row.id]
      );
      res.json({
        success: true,
        tenantId: row.id,
        leadIntakeEmail: row.lead_intake_email || null,
        dealership: row.dealership,
        recentLog: log.rows,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── POST /api/admin/tenant/:userId/intake ─────────────────────────
  // Body: { email } — set or clear (null/empty) the tenant's intake address.
  // Validates uniqueness via the partial UNIQUE index on the column.
  app.post('/api/admin/tenant/:userId/intake', adminAuth, async (req, res) => {
    try {
      const ownerId = parseInt(req.params.userId, 10);
      if (!ownerId) return res.status(400).json({ success: false, error: 'Invalid user id' });
      let { email } = req.body || {};
      if (email != null) {
        email = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
          return res.status(400).json({ success: false, error: 'Invalid email address' });
        }
      } else {
        email = null;  // clear
      }
      const t = await pool.query(`SELECT id FROM desk_tenants WHERE owner_user_id = $1`, [ownerId]);
      if (!t.rows.length) return res.status(404).json({ success: false, error: 'Tenant not found' });
      try {
        await pool.query(
          `UPDATE desk_tenants SET lead_intake_email = $2 WHERE id = $1`,
          [t.rows[0].id, email]
        );
      } catch (e) {
        if (/unique/i.test(e.message)) {
          return res.status(409).json({ success: false, error: 'That intake address is already used by another tenant' });
        }
        throw e;
      }
      await auditLog('set_intake_email', 'tenant', t.rows[0].id, { email }, req);
      res.json({ success: true, leadIntakeEmail: email });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

};
