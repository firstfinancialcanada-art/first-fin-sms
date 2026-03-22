// ============================================================
// routes/desk.js — All Desk Platform API Routes
// Mounts under /api/desk/*
// ============================================================
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  generateAccessToken,
  generateRefreshToken,
  requireAuth,
  JWT_SECRET,
  REFRESH_TTL_DAYS
} = require('../middleware/auth');

const { EXEMPT_EMAILS } = require('../lib/constants');
const { sanitizeError } = require('../lib/helpers');
const TRIAL_DAYS = 3;

module.exports = function (app, pool, twilioClient, requireBilling) {
  // ── Helpers ────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    salesName: '',
    dealerName: 'My Dealership',
    dealerCity: '',     // shown in SARAH appointment confirmation messages
    logoUrl: '',
    docFee: 998,
    gst: 5,
    apr: 8.99,
    target: 30,
    twilioNumber: '',   // tenant's Twilio phone number (e.g. +14031234567)
    notifyPhone: ''     // owner's cell for Sarah appointment/callback alerts
  };

  function normalizeSettings(raw) {
    let s = raw;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch(e) { s = {}; } }
    if (!s || typeof s !== 'object') s = {};
    return { ...DEFAULT_SETTINGS, ...s };
  }

  function buildTenantBrandingFromSettings(settingsJson) {
    const s = normalizeSettings(settingsJson);
    return {
      dealerName: s.dealerName || 'My Dealership',
      logoUrl: s.logoUrl || ''
    };
  }

  function userPayload(row) {
    const settings = normalizeSettings(row.settings_json || {});
    return {
      id: row.id,
      email: row.email,
      name: row.display_name,
      role: row.role,
      tenantBranding: buildTenantBrandingFromSettings(settings)
    };
  }

  // ── REGISTER ─────────────────────────────────────────────
  app.post('/api/desk/register', async (req, res) => {
    const client = await pool.connect();
    try {
      const { email, password, name } = req.body;
      if (!email || !password || !name) {
        return res.status(400).json({ success: false, error: 'email, password, and name required' });
      }
      if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
      }

      // Ensure billing columns exist
      await client.query(`
        ALTER TABLE desk_users
          ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial',
          ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT
      `).catch(() => {});

      const cleanEmail = String(email).toLowerCase().trim();

      // Check if email exists
      const existing = await client.query('SELECT id FROM desk_users WHERE email = $1', [cleanEmail]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }

      const hash = await bcrypt.hash(password, 12);
      const initialSettings = {
        ...DEFAULT_SETTINGS,
        salesName: name,
        dealerName: 'My Dealership'
      };

      // Exempt accounts get full access, everyone else gets 3-day trial
      const isExempt = EXEMPT_EMAILS.includes(cleanEmail);
      const subStatus = isExempt ? 'active' : 'trial';
      const trialEndsAt = isExempt ? null : new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

      const result = await client.query(
        `INSERT INTO desk_users (email, password_hash, display_name, role, settings_json, subscription_status, trial_ends_at)
         VALUES ($1, $2, $3, 'owner', $4, $5, $6)
         RETURNING id, email, display_name, role, settings_json, subscription_status, trial_ends_at`,
        [cleanEmail, hash, name, JSON.stringify(initialSettings), subStatus, trialEndsAt]
      );

      const user = result.rows[0];
      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);

      // Save refresh token hash
      const rtHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await client.query(
        `INSERT INTO desk_refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days')`,
        [user.id, rtHash]
      );

      console.log('🆕 Desk user registered:', cleanEmail);
      res.json({
        success: true,
        accessToken,
        refreshToken,
        user: userPayload(user)
      });
    } catch (e) {
      console.error('❌ Register error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── LOGIN ────────────────────────────────────────────────
  app.post('/api/desk/login', async (req, res) => {
    const client = await pool.connect();
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'email and password required' });
      }

      const cleanEmail = String(email).toLowerCase().trim();
      const result = await client.query('SELECT * FROM desk_users WHERE email = $1', [cleanEmail]);

      if (result.rows.length === 0) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      // Update last login
      await client.query('UPDATE desk_users SET last_login = NOW() WHERE id = $1', [user.id]);

      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);

      const rtHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await client.query(
        `INSERT INTO desk_refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days')`,
        [user.id, rtHash]
      );

      console.log('🔑 Desk login:', cleanEmail);

      // Build billing status
      const exempt = EXEMPT_EMAILS.includes(cleanEmail);
      const billing = getBillingStatus(user, exempt);

      res.json({
        success: true,
        accessToken,
        refreshToken,
        user: userPayload(user),
        billing
      });
    } catch (e) {
      console.error('❌ Login error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── REFRESH TOKEN ────────────────────────────────────────
  app.post('/api/desk/refresh', async (req, res) => {
    const client = await pool.connect();
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ success: false, error: 'refreshToken required' });

      let decoded;
      try {
        decoded = jwt.verify(refreshToken, JWT_SECRET);
      } catch {
        return res.status(401).json({ success: false, error: 'Invalid refresh token' });
      }

      const rtHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const rt = await client.query(
        `SELECT * FROM desk_refresh_tokens
         WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()`,
        [rtHash, decoded.userId]
      );

      if (rt.rows.length === 0) {
        return res.status(401).json({ success: false, error: 'Refresh token expired or revoked' });
      }

      // Rotate
      await client.query('DELETE FROM desk_refresh_tokens WHERE token_hash = $1', [rtHash]);

      const user = await client.query('SELECT * FROM desk_users WHERE id = $1', [decoded.userId]);
      if (user.rows.length === 0) return res.status(401).json({ success: false, error: 'User not found' });

      const newAccess = generateAccessToken(user.rows[0]);
      const newRefresh = generateRefreshToken(user.rows[0]);
      const newHash = crypto.createHash('sha256').update(newRefresh).digest('hex');

      await client.query(
        `INSERT INTO desk_refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days')`,
        [decoded.userId, newHash]
      );

      res.json({ success: true, accessToken: newAccess, refreshToken: newRefresh });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── GET ME ───────────────────────────────────────────────
  app.get('/api/desk/me', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, email, display_name, role, created_at, last_login, settings_json,
                subscription_status, trial_ends_at
         FROM desk_users WHERE id = $1`,
        [req.user.userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

      const row = result.rows[0];
      const exempt = EXEMPT_EMAILS.includes(row.email);
      const billing = getBillingStatus(row, exempt);

      res.json({
        success: true,
        user: {
          id: row.id,
          email: row.email,
          name: row.display_name,
          role: row.role,
          created_at: row.created_at,
          last_login: row.last_login,
          tenantBranding: buildTenantBrandingFromSettings(row.settings_json)
        },
        billing
      });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── LOGOUT ───────────────────────────────────────────────
  app.post('/api/desk/logout', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_refresh_tokens WHERE user_id = $1', [req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── CHANGE PASSWORD ─────────────────────────────────────
  app.post('/api/desk/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current password and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
    }
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT password_hash FROM desk_users WHERE id = $1', [req.user.userId]);
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
      if (!valid) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' });
      }
      const hash = await bcrypt.hash(newPassword, 12);
      await client.query('UPDATE desk_users SET password_hash = $1 WHERE id = $2', [hash, req.user.userId]);
      // Invalidate all refresh tokens so other sessions must re-auth
      await client.query('DELETE FROM desk_refresh_tokens WHERE user_id = $1', [req.user.userId]);
      console.log('🔑 Password changed for userId:', req.user.userId);
      res.json({ success: true, message: 'Password changed successfully' });
    } catch (e) {
      console.error('❌ Change password error:', e.message);
      res.status(500).json({ success: false, error: 'Failed to change password' });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/settings', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT settings_json FROM desk_users WHERE id = $1', [req.user.userId]);
      res.json({ success: true, settings: normalizeSettings(result.rows[0]?.settings_json || {}) });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/settings', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { settings } = req.body;
      const normalized = normalizeSettings(settings || {});

      // Ensure twilio_number column exists (safe to run repeatedly)
      await client.query(`ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS twilio_number TEXT`).catch(() => {});

      // Save settings_json AND sync twilio_number column (used by webhook routing)
      const twilioNum = normalized.twilioNumber ? normalized.twilioNumber.trim() : null;
      const result = await client.query(
        'UPDATE desk_users SET settings_json = $1::jsonb, twilio_number = $2 WHERE id = $3',
        [JSON.stringify(normalized), twilioNum, req.user.userId]
      );
      if (result.rowCount === 0) {
        console.error('⚠️ settings UPDATE matched 0 rows for userId:', req.user.userId);
      } else {
        console.log('✅ settings saved for userId:', req.user.userId, normalized.dealerName, twilioNum ? `| Twilio: ${twilioNum}` : '');
      }
      res.json({ success: true, tenantBranding: buildTenantBrandingFromSettings(normalized) });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TWILIO NUMBER PROVISIONING
  // ═══════════════════════════════════════════════════════════

  // Search available local numbers by area code
  app.get('/api/desk/twilio/available-numbers', requireAuth, async (req, res) => {
    if (!twilioClient) return res.status(503).json({ success: false, error: 'Twilio not configured on server' });
    const areaCode = (req.query.areaCode || '').replace(/\D/g, '').slice(0, 3);
    if (!areaCode || areaCode.length !== 3) {
      return res.status(400).json({ success: false, error: 'Provide a 3-digit area code' });
    }
    try {
      const numbers = await twilioClient.availablePhoneNumbers('CA')
        .local.list({ areaCode, limit: 10, smsEnabled: true, voiceEnabled: true });
      if (!numbers.length) {
        // Fallback: try without area code restriction
        const fallback = await twilioClient.availablePhoneNumbers('CA')
          .local.list({ limit: 10, smsEnabled: true, voiceEnabled: true });
        return res.json({
          success: true,
          numbers: fallback.map(n => ({ number: n.phoneNumber, friendly: n.friendlyName, region: n.region })),
          fallback: true,
          message: `No numbers found for area code ${areaCode} — showing other available Canadian numbers`
        });
      }
      res.json({
        success: true,
        numbers: numbers.map(n => ({ number: n.phoneNumber, friendly: n.friendlyName, region: n.region })),
        fallback: false
      });
    } catch(e) {
      console.error('Twilio number search error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // Purchase a number and assign it to this tenant
  app.post('/api/desk/twilio/provision-number', requireAuth, requireBilling, async (req, res) => {
    if (!twilioClient) return res.status(503).json({ success: false, error: 'Twilio not configured on server' });
    const { phoneNumber } = req.body;
    if (!phoneNumber || !phoneNumber.startsWith('+1')) {
      return res.status(400).json({ success: false, error: 'Valid +1 Canadian/US number required' });
    }
    const client = await pool.connect();
    try {
      // Check this number isn't already assigned to another tenant
      const existing = await client.query(
        'SELECT id, email FROM desk_users WHERE twilio_number = $1', [phoneNumber]
      );
      if (existing.rows.length > 0 && existing.rows[0].id !== req.user.userId) {
        return res.status(409).json({ success: false, error: 'This number is already assigned to another account' });
      }

      // Purchase the number on the master Twilio account
      const baseUrl = process.env.BASE_URL || '';
      const purchased = await twilioClient.incomingPhoneNumbers.create({
        phoneNumber,
        smsUrl:   `${baseUrl}/api/sms-webhook`,
        voiceUrl: `${baseUrl}/api/voice/inbound`,
        friendlyName: `FIRST-FIN tenant:${req.user.userId}`
      });

      // Save to settings_json AND twilio_number column
      const settingsRow = await client.query('SELECT settings_json FROM desk_users WHERE id = $1', [req.user.userId]);
      const current = settingsRow.rows[0]?.settings_json;
      const s = typeof current === 'string' ? JSON.parse(current) : (current || {});
      s.twilioNumber = phoneNumber;
      await client.query(
        'UPDATE desk_users SET settings_json = $1::jsonb, twilio_number = $2 WHERE id = $3',
        [JSON.stringify(s), phoneNumber, req.user.userId]
      );

      console.log(`✅ Twilio number provisioned: ${phoneNumber} → tenant ${req.user.userId} (SID: ${purchased.sid})`);
      res.json({ success: true, phoneNumber, sid: purchased.sid });
    } catch(e) {
      console.error('Twilio provision error:', e.message);
      // Twilio error 21422 = number unavailable (someone else grabbed it)
      if (e.code === 21422 || e.message?.includes('not available')) {
        return res.status(409).json({ success: false, error: 'This number was just taken — please search again and pick another.' });
      }
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // INVENTORY
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/inventory', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT stock, year, make, model, mileage, price, condition, carfax, type, status, vin, color, trim, cost FROM desk_inventory WHERE user_id = $1 ORDER BY stock',
        [req.user.userId]
      );
      res.json({ success: true, inventory: result.rows });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.post('/api/desk/inventory', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const v = req.body;
      const result = await client.query(
        `INSERT INTO desk_inventory (user_id, stock, year, make, model, mileage, price, condition, carfax, type, vin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, stock) DO UPDATE SET year=$3, make=$4, model=$5, mileage=$6, price=$7, condition=$8, carfax=$9, type=$10, vin=$11, updated_at=NOW()
         RETURNING *`,
        [req.user.userId, v.stock, v.year, v.make, v.model, v.mileage, v.price, v.condition || 'Average', v.carfax || 0, v.type, v.vin || null]
      );
      res.json({ success: true, vehicle: result.rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/inventory/bulk', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { vehicles } = req.body;
      if (!Array.isArray(vehicles)) return res.status(400).json({ success: false, error: 'vehicles[] required' });

      await client.query('BEGIN');
      await client.query("UPDATE desk_inventory SET status = 'delisted' WHERE user_id = $1", [req.user.userId]);

      for (const v of vehicles) {
        await client.query(
          `INSERT INTO desk_inventory (user_id, stock, year, make, model, mileage, price, condition, carfax, type, vin, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'available')
           ON CONFLICT (user_id, stock) DO UPDATE SET year=$3, make=$4, model=$5, mileage=$6, price=$7, condition=$8, carfax=$9, type=$10, vin=$11, status='available', updated_at=NOW()`,
          [req.user.userId, v.stock, v.year, v.make, v.model, v.mileage, v.price, v.condition || 'Average', v.carfax || 0, v.type, v.vin || null]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true, count: vehicles.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/inventory/:stock', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_inventory WHERE stock = $1 AND user_id = $2', [req.params.stock, req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CRM
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/crm', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM desk_crm WHERE user_id = $1 ORDER BY updated_at DESC',
        [req.user.userId]
      );
      res.json({ success: true, crm: result.rows });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/crm/bulk', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { crm } = req.body;
      if (!Array.isArray(crm)) return res.status(400).json({ success: false, error: 'crm[] required' });

      await client.query('BEGIN');
      await client.query('DELETE FROM desk_crm WHERE user_id = $1', [req.user.userId]);

      for (const c of crm) {
        await client.query(
          `INSERT INTO desk_crm (user_id, name, phone, email, beacon, income, obligations, status, source, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.user.userId, c.name, c.phone, c.email, c.beacon, c.income, c.obligations, c.status || 'Lead', c.source, c.notes]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true, count: crm.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.post('/api/desk/crm', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const c = req.body;
      const result = await client.query(
        `INSERT INTO desk_crm (user_id, name, phone, email, beacon, income, obligations, status, source, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.userId, c.name, c.phone, c.email, c.beacon, c.income, c.obligations, c.status || 'Lead', c.source, c.notes]
      );
      res.json({ success: true, entry: result.rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.patch('/api/desk/crm/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { status } = req.body;
      await client.query(
        'UPDATE desk_crm SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [status, req.params.id, req.user.userId]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/crm/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_crm WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DEAL LOG
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/deal-log', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT id, deal_data, created_at FROM desk_deal_log WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.userId]
      );
      const dealLog = result.rows.map(r => ({ ...r.deal_data, _dbId: r.id }));
      res.json({ success: true, dealLog });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/deal-log/bulk', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { dealLog } = req.body;
      if (!Array.isArray(dealLog)) return res.status(400).json({ success: false, error: 'dealLog[] required' });

      await client.query('BEGIN');
      await client.query('DELETE FROM desk_deal_log WHERE user_id = $1', [req.user.userId]);

      for (const deal of dealLog) {
        await client.query(
          'INSERT INTO desk_deal_log (user_id, deal_data) VALUES ($1, $2)',
          [req.user.userId, JSON.stringify(deal)]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true, count: dealLog.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.post('/api/desk/deal-log', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'INSERT INTO desk_deal_log (user_id, deal_data) VALUES ($1, $2) RETURNING id, created_at',
        [req.user.userId, JSON.stringify(req.body.deal)]
      );
      res.json({ success: true, id: result.rows[0].id });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/deal-log/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_deal_log WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LENDER RATE OVERRIDES
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/lender-rates', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT overrides_json FROM desk_lender_rates WHERE user_id = $1',
        [req.user.userId]
      );
      res.json({ success: true, overrides: result.rows[0]?.overrides_json || {} });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/lender-rates', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { overrides } = req.body;
      await client.query(
        `INSERT INTO desk_lender_rates (user_id, overrides_json, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET overrides_json = $2, updated_at = NOW()`,
        [req.user.userId, JSON.stringify(overrides || {})]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/lender-rates', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_lender_rates WHERE user_id = $1', [req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIOS / SAVE SLOTS
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/scenarios', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT slot, deal_data, label, saved_at FROM desk_scenarios WHERE user_id = $1 ORDER BY slot',
        [req.user.userId]
      );
      const slots = [null, null, null];
      for (const row of result.rows) slots[row.slot] = row.deal_data;
      res.json({ success: true, scenarios: slots });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/scenarios', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { scenarios } = req.body;
      if (!Array.isArray(scenarios) || scenarios.length !== 3) {
        return res.status(400).json({ success: false, error: 'scenarios must be array of 3' });
      }

      await client.query('BEGIN');
      await client.query('DELETE FROM desk_scenarios WHERE user_id = $1', [req.user.userId]);

      for (let i = 0; i < 3; i++) {
        if (scenarios[i] !== null) {
          await client.query(
            'INSERT INTO desk_scenarios (user_id, slot, deal_data, label) VALUES ($1, $2, $3, $4)',
            [req.user.userId, i, JSON.stringify(scenarios[i]), scenarios[i]?.label || `Slot ${i + 1}`]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── CURRENT DEAL ──────────────────────────────────────────
  app.get('/api/desk/current-deal', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT deal_data FROM desk_current_deal WHERE user_id = $1',
        [req.user.userId]
      );
      res.json({ success: true, deal: result.rows[0]?.deal_data || null });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/current-deal', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { deal } = req.body;
      await client.query(
        `INSERT INTO desk_current_deal (user_id, deal_data)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET deal_data = $2, saved_at = NOW()`,
        [req.user.userId, JSON.stringify(deal)]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LOAD ALL — single endpoint to hydrate frontend
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/load-all', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const [
        settingsR,
        inventoryR,
        crmR,
        dealLogR,
        lenderR,
        scenariosR
      ] = await Promise.all([
        client.query('SELECT settings_json, email, display_name, role, id FROM desk_users WHERE id = $1', [req.user.userId]),
        client.query("SELECT stock, year, make, model, mileage, price, book_value, condition, carfax, type, status, vin, color, trim, cost FROM desk_inventory WHERE user_id = $1 AND status IN ('available', 'wholesale') ORDER BY stock", [req.user.userId]),
        client.query('SELECT * FROM desk_crm WHERE user_id = $1 ORDER BY updated_at DESC', [req.user.userId]),
        client.query('SELECT id, deal_data, created_at FROM desk_deal_log WHERE user_id = $1 ORDER BY created_at DESC', [req.user.userId]),
        client.query('SELECT overrides_json FROM desk_lender_rates WHERE user_id = $1', [req.user.userId]),
        client.query('SELECT slot, deal_data FROM desk_scenarios WHERE user_id = $1 ORDER BY slot', [req.user.userId])
      ]);

      let currentDealR = { rows: [] };
      try {
        currentDealR = await client.query('SELECT deal_data FROM desk_current_deal WHERE user_id = $1', [req.user.userId]);
      } catch (e) {
        console.warn('⚠️ desk_current_deal not available:', e.message);
      }

      const scenarioSlots = [null, null, null];
      for (const row of scenariosR.rows) scenarioSlots[row.slot] = row.deal_data;

      const u = settingsR.rows[0] || {};
      const settings = normalizeSettings(u.settings_json || {});
      const user = {
        id: u.id,
        email: u.email,
        name: u.display_name,
        role: u.role,
        tenantBranding: buildTenantBrandingFromSettings(settings)
      };

      res.json({
        success: true,
        user,
        settings,
        inventory: inventoryR.rows,
        crm: crmR.rows,
        dealLog: dealLogR.rows.map(r => ({ ...r.deal_data, _dbId: r.id })),
        lenderRates: lenderR.rows[0]?.overrides_json || {},
        scenarios: scenarioSlots,
        currentDeal: currentDealR.rows[0]?.deal_data || null
      });
    } catch (e) {
      console.error('❌ /api/desk/load-all error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  console.log('✅ Desk API routes mounted on /api/desk/*');  // ── Auto-create fintest account if missing ────────────────
  (async () => {
    const client = await pool.connect();
    try {
      await client.query(`
        ALTER TABLE desk_users
          ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial',
          ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT
      `).catch(() => {});

      const existing = await client.query("SELECT id FROM desk_users WHERE email = 'fintest@fintest.com'");
      if (existing.rows.length === 0) {
      const fintestPw = process.env.FINTEST_PASSWORD || 'changeme-set-FINTEST_PASSWORD';
        const hash = await bcrypt.hash(fintestPw, 12);
        await client.query(
          `INSERT INTO desk_users (email, password_hash, display_name, role, settings_json, subscription_status)
           VALUES ('fintest@fintest.com', $1, 'Fin Test', 'owner', $2, 'active')`,
          [hash, JSON.stringify({ salesName: 'Fin Test', dealerName: 'Fin Test Auto', docFee: 998, gst: 5, apr: 8.99, target: 30 })]
        );
        console.log('✅ fintest account created');
      }
    } catch(e) {
      console.error('fintest setup error:', e.message);
    } finally {
      client.release();
    }
  })();
};

// ── Billing status helper (shared with stripe.js) ────────────────
function getBillingStatus(user, exempt) {
  if (exempt) return { access: 'full', reason: 'exempt' };
  const status = user.subscription_status;
  const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
  const now = new Date();
  if (status === 'active') return { access: 'full', reason: 'active' };
  if (status === 'lapsed') return { access: 'readonly', reason: 'lapsed' };
  if (!status || status === 'trial') {
    if (trialEnd && now < trialEnd) {
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
      return { access: 'full', reason: 'trial', daysLeft, trialEnd };
    }
    return { access: 'readonly', reason: 'trial_expired' };
  }
  return { access: 'readonly', reason: status };
}
