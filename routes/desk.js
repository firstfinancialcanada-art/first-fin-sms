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

// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}
module.exports = function (app, pool, twilioClient, requireBilling) {

  // ── Fix legacy single-column stock constraint (breaks multi-tenancy) ────
  ;(async () => {
    try {
      // Old DB had UNIQUE(stock) globally — must be (user_id, stock) for multi-tenant
      await pool.query(`ALTER TABLE desk_inventory DROP CONSTRAINT IF EXISTS desk_inventory_stock_unique`);
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'desk_inventory_user_stock_unique'
              AND conrelid = 'desk_inventory'::regclass
          ) THEN
            ALTER TABLE desk_inventory ADD CONSTRAINT desk_inventory_user_stock_unique UNIQUE (user_id, stock);
          END IF;
        END $$
      `);
      console.log('✅ desk_inventory constraint: (user_id, stock) multi-tenant ready');
    } catch(e) { console.error('⚠️ inventory constraint migration:', e.message); }
  })();

  // ── Feature telemetry table ───────────────────────────────────────
  ;(async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS feature_events (
          id         BIGSERIAL PRIMARY KEY,
          user_id    INTEGER REFERENCES desk_users(id) ON DELETE CASCADE,
          feature    VARCHAR(80) NOT NULL,
          action     VARCHAR(80),
          meta       JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_fe_user ON feature_events(user_id, created_at DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_fe_feature ON feature_events(feature, created_at DESC)`);
      await pool.query(`ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_du_last_active ON desk_users(last_active DESC NULLS LAST)`);
      console.log('✅ feature_events + last_active ready');
    } catch(e) { console.error('⚠️ telemetry migration:', e.message); }
  })();

  // ── Telemetry helper — fire-and-forget, never blocks route ────────
  async function trackFeature(userId, feature, action, meta) {
    if (!userId) return;
    try {
      await Promise.all([
        pool.query(
          `INSERT INTO feature_events (user_id, feature, action, meta) VALUES ($1,$2,$3,$4)`,
          [userId, feature, action || 'used', JSON.stringify(meta || {})]
        ),
        pool.query(`UPDATE desk_users SET last_active = NOW() WHERE id = $1`, [userId])
      ]);
    } catch(e) {}
  }

  // ── requireAuth wrapper that also tracks last_active ─────────────
  function requireAuthTracked(req, res, next) {
    const origNext = next;
    requireAuth(req, res, () => {
      // Fire and forget — update last_active on every authenticated request
      if (req.user?.userId) {
        pool.query(`UPDATE desk_users SET last_active = NOW() WHERE id = $1`, [req.user.userId])
          .catch(() => {});
      }
      origNext();
    });
  }

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
    notifyPhone: '',    // owner's cell for Sarah appointment/callback alerts
    googleReviewUrl: '' // sent to customer after deal funded
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

      // Exempt accounts get full access, everyone else starts as pending (must subscribe)
      const isExempt = EXEMPT_EMAILS.includes(cleanEmail);
      const subStatus = isExempt ? 'active' : 'pending';
      const trialEndsAt = null; // No free trial — paid subscription required per Terms of Service

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
  app.get('/api/desk/me', requireAuthTracked, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query(`ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'`).catch(() => {});

      const result = await client.query(
        `SELECT id, email, display_name, role, created_at, last_login, settings_json,
                subscription_status, trial_ends_at, features
         FROM desk_users WHERE id = $1`,
        [req.user.userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

      const row = result.rows[0];
      const exempt = EXEMPT_EMAILS.includes(row.email);
      const billing = getBillingStatus(row, exempt);

      // Resolve feature flags — exempt users and legacy active accounts get all features
      const rawFeatures = (typeof row.features === 'string' ? JSON.parse(row.features || '{}') : row.features) || {};
      const isLegacy = exempt || (Object.keys(rawFeatures).length === 0 && row.subscription_status === 'active');
      const features = isLegacy
        ? { sarah: true, dt_sync: true, fb_poster: true }
        : rawFeatures;

      res.json({
        success: true,
        user: {
          id: row.id,
          email: row.email,
          name: row.display_name,
          role: row.role,
          created_at: row.created_at,
          last_login: row.last_login,
          tenantBranding: buildTenantBrandingFromSettings(row.settings_json),
          features
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
  // ── FIRST-LOGIN PASSWORD SET (onboarding only — no current password required) ──────────
  app.post('/api/desk/set-password', requireAuth, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const client = await pool.connect();
    try {
      // Only allow if onboardingPending is set in settings
      const userRow = await client.query(
        'SELECT settings_json FROM desk_users WHERE id = $1', [req.user.userId]
      );
      const s = userRow.rows[0]?.settings_json || {};
      const parsed = typeof s === 'string' ? JSON.parse(s) : s;
      if (!parsed.onboardingPending) {
        return res.status(403).json({ success: false, error: 'Use change-password instead' });
      }
      const hash = await bcrypt.hash(newPassword, 12);
      await client.query(
        'UPDATE desk_users SET password_hash = $1 WHERE id = $2',
        [hash, req.user.userId]
      );
      console.log('✅ Onboarding password set for user', req.user.userId);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
  });

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
  app.get('/api/desk/settings', requireAuthTracked, async (req, res) => {
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
        trackFeature(req.user.userId, 'settings', 'saved');
        // Invalidate tenant cache if exposed
        if (app.locals.invalidateTenantCache) app.locals.invalidateTenantCache(req.user.userId);
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

  // ── GET scrape domain lock (extension calls this before scraping) ─────
  app.get('/api/desk/scrape-domain', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT scrape_domain FROM desk_users WHERE id = $1', [req.user.userId]);
      const domain = result.rows[0]?.scrape_domain || null;
      res.json({ success: true, scrape_domain: domain, locked: !!domain });
    } catch(e) {
      res.json({ success: true, scrape_domain: null, locked: false });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // INVENTORY
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/inventory', requireAuthTracked, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT stock, year, make, model, mileage, price, condition, carfax, type, status, vin, color, trim, cost, book_value, fb_status, fb_posted_date, photos FROM desk_inventory WHERE user_id = $1 ORDER BY stock',
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
        `INSERT INTO desk_inventory (user_id, stock, year, make, model, mileage, price, condition, carfax, type, vin, book_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (user_id, stock) DO UPDATE SET year=$3, make=$4, model=$5, mileage=$6, price=$7, condition=$8, carfax=$9, type=$10, vin=$11, book_value=$12, updated_at=NOW()
         RETURNING *`,
        [req.user.userId, v.stock, v.year, v.make, v.model, v.mileage, v.price, v.condition || 'Average', v.carfax || 0, v.type, v.vin || null, v.book_value || 0]
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
      await client.query("DELETE FROM desk_inventory WHERE user_id = $1", [req.user.userId]);

      for (const v of vehicles) {
        await client.query(
          `INSERT INTO desk_inventory (user_id, stock, year, make, model, mileage, price, condition, carfax, type, vin, book_value, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'available')
           ON CONFLICT (user_id, stock) DO UPDATE SET year=$3, make=$4, model=$5, mileage=$6, price=$7, condition=$8, carfax=$9, type=$10, vin=$11, book_value=$12, status='available', updated_at=NOW()`,
          [req.user.userId, v.stock, v.year, v.make, v.model, v.mileage, v.price, v.condition || 'Average', v.carfax || 0, v.type, v.vin || null, v.book_value || 0]
        );
      }

      await client.query('COMMIT');
      trackFeature(req.user.userId, 'inventory', 'bulk_upload', { count: vehicles.length });
      res.json({ success: true, count: vehicles.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── PATCH condition on a single vehicle ─────────────────────────
  app.patch('/api/desk/inventory/:stock/condition', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const VALID = ['Extra Clean', 'Clean', 'Average', 'Rough', 'Very Rough'];
      const condition = req.body.condition;
      if (!VALID.includes(condition)) {
        return res.status(400).json({ success: false, error: 'Invalid condition value' });
      }
      const result = await client.query(
        `UPDATE desk_inventory SET condition = $1, updated_at = NOW()
         WHERE stock = $2 AND user_id = $3 RETURNING stock, condition`,
        [condition, req.params.stock, req.user.userId]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Vehicle not found' });
      }
      res.json({ success: true, stock: result.rows[0].stock, condition: result.rows[0].condition });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── PATCH book value on a single vehicle ────────────────────────
  app.patch('/api/desk/inventory/:stock/book-value', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const bookValue = parseFloat(req.body.book_value);
      if (isNaN(bookValue) || bookValue < 0) {
        return res.status(400).json({ success: false, error: 'Invalid book value' });
      }
      const result = await client.query(
        `UPDATE desk_inventory SET book_value = $1, updated_at = NOW()
         WHERE stock = $2 AND user_id = $3 RETURNING stock, book_value`,
        [bookValue, req.params.stock, req.user.userId]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Vehicle not found' });
      }
      // Update in-memory inventory on next load — no cache to clear
      res.json({ success: true, stock: result.rows[0].stock, book_value: result.rows[0].book_value });
    } catch (e) {
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

  // ── PATCH fb posting status on a single vehicle ─────────────────
  app.patch('/api/desk/inventory/:stock/fb-status', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const VALID = ['pending', 'posted', 'skipped'];
      const status = req.body.status;
      if (!VALID.includes(status)) {
        return res.status(400).json({ success: false, error: 'status must be pending, posted, or skipped' });
      }
      const dateClause = status === 'posted' ? 'fb_posted_date = CURRENT_DATE,' : status === 'pending' ? 'fb_posted_date = NULL,' : '';
      const result = await client.query(
        `UPDATE desk_inventory SET fb_status = $1, ${dateClause} updated_at = NOW()
         WHERE stock = $2 AND user_id = $3 RETURNING stock, fb_status, fb_posted_date`,
        [status, req.params.stock, req.user.userId]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Vehicle not found' });
      }
      res.json({ success: true, ...result.rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── EXTENSION: inventory sync (add | replace | consolidate) ─────
  // POST /api/desk/inventory/sync
  // Body: { mode: 'add'|'replace'|'consolidate', vehicles: [...] }
  app.post('/api/desk/inventory/sync', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { mode, vehicles } = req.body;
      if (!['add', 'replace', 'consolidate'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'mode must be add | replace | consolidate' });
      }
      if (!Array.isArray(vehicles) || vehicles.length === 0) {
        return res.status(400).json({ success: false, error: 'vehicles array is required' });
      }

      const userId = req.user.userId;
      let inserted = 0, updated = 0, skipped = 0;
      let stockCounter = 0;

      function makeStock(v) {
        if (v.stock) return String(v.stock).toUpperCase().slice(0, 20);
        if (v.vin)   return v.vin.slice(-8).toUpperCase();
        stockCounter++;
        return ('IMP' + Date.now() + stockCounter).slice(0, 20);
      }

      function insertParams(v) {
        return [
          userId,
          makeStock(v),
          v.year        || 2020,
          (v.make   || '').slice(0, 50),
          (v.model  || '').slice(0, 80),
          v.mileage     || 0,
          v.price       || 0,
          v.condition   || 'Average',
          v.carfax      || 0,
          v.type        || 'Used',
          (v.vin    || '').slice(0, 17).toUpperCase() || null,
          v.book_value  || 0,
          (v.color  || '').slice(0, 30),
          (v.trim   || '').slice(0, 80),
          JSON.stringify(Array.isArray(v.photos) ? v.photos.slice(0, 10) : [])
        ];
      }

      await client.query('BEGIN');

      if (mode === 'replace') {
        await client.query("DELETE FROM desk_inventory WHERE user_id=$1", [userId]);
        for (const v of vehicles) {
          await client.query(
            `INSERT INTO desk_inventory
               (user_id,stock,year,make,model,mileage,price,condition,carfax,type,vin,book_value,color,trim,photos,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'available')
             ON CONFLICT (user_id,stock) DO UPDATE SET
               year=$3,make=$4,model=$5,mileage=$6,price=$7,condition=$8,carfax=$9,
               type=$10,vin=$11,book_value=$12,color=$13,trim=$14,photos=$15,
               status='available',updated_at=NOW()`,
            insertParams(v)
          );
          inserted++;
        }

      } else if (mode === 'add') {
        for (const v of vehicles) {
          if (v.vin) {
            const { rows } = await client.query(
              'SELECT id FROM desk_inventory WHERE user_id=$1 AND vin=$2 LIMIT 1',
              [userId, v.vin.toUpperCase()]
            );
            if (rows.length) { skipped++; continue; }
          }
          await client.query(
            `INSERT INTO desk_inventory
               (user_id,stock,year,make,model,mileage,price,condition,carfax,type,vin,book_value,color,trim,photos,status)
             Values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'available')
             ON CONFLICT (user_id,stock) DO NOTHING`,
            insertParams(v)
          );
          inserted++;
        }

      } else { // consolidate
        for (const v of vehicles) {
          if (v.vin) {
            const { rows } = await client.query(
              'SELECT id FROM desk_inventory WHERE user_id=$1 AND vin=$2 LIMIT 1',
              [userId, v.vin.toUpperCase()]
            );
            if (rows.length) {
              await client.query(
                `UPDATE desk_inventory SET
                   year=$3,make=$4,model=$5,mileage=$6,price=$7,condition=$8,
                   type=$9,book_value=$10,color=$11,trim=$12,photos=$13,
                   status='available',updated_at=NOW()
                 WHERE user_id=$1 AND vin=$2`,
                [userId, v.vin.toUpperCase(),
                 v.year||2020, (v.make||'').slice(0,50), (v.model||'').slice(0,80),
                 v.mileage||0, v.price||0, v.condition||'Average',
                 v.type||'Used', v.book_value||0,
                 (v.color||'').slice(0,30), (v.trim||'').slice(0,80),
                 JSON.stringify(Array.isArray(v.photos) ? v.photos.slice(0,10) : [])]
              );
              updated++;
              continue;
            }
          }
          await client.query(
            `INSERT INTO desk_inventory
               (user_id,stock,year,make,model,mileage,price,condition,carfax,type,vin,book_value,color,trim,photos,status)
             Values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'available')
             ON CONFLICT (user_id,stock) DO NOTHING`,
            insertParams(v)
          );
          inserted++;
        }
      }

      await client.query('COMMIT');
      trackFeature(userId, 'inventory', 'extension_sync', { mode, total: vehicles.length });
      console.log(`📦 inventory/sync [${mode}] user=${userId} inserted=${inserted} updated=${updated} skipped=${skipped}`);
      res.json({ success: true, mode, inserted, updated, skipped });

    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CRM
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/crm', requireAuthTracked, async (req, res) => {
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
      const { status, phone, email, source, notes, name, beacon } = req.body;
      const sets = ['updated_at = NOW()'];
      const vals = [];
      let idx = 1;
      if (status !== undefined) { sets.push(`status = $${idx++}`); vals.push(status); }
      if (phone !== undefined)  { sets.push(`phone = $${idx++}`); vals.push(phone); }
      if (email !== undefined)  { sets.push(`email = $${idx++}`); vals.push(email); }
      if (source !== undefined) { sets.push(`source = $${idx++}`); vals.push(source); }
      if (notes !== undefined)  { sets.push(`notes = $${idx++}`); vals.push(notes); }
      if (name !== undefined)   { sets.push(`name = $${idx++}`); vals.push(name); }
      if (beacon !== undefined) { sets.push(`beacon = $${idx++}`); vals.push(beacon); }
      vals.push(req.params.id, req.user.userId);
      await client.query(
        `UPDATE desk_crm SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        vals
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
      trackFeature(req.user.userId, 'deal_desk', 'deal_logged');

      // ── Deal-funded customer SMS ─────────────────────────────
      // Fire async — non-blocking, never fails the log
      (async () => {
        try {
          const deal = req.body.deal || {};
          const custPhone = deal.customer?.phone || deal.customerPhone || '';
          const custName  = (deal.customer?.name || deal.customerName || '').split(' ')[0] || 'there';
          const vehicleDesc = deal.vehicle?.desc || deal.vehicleDesc || 'your new vehicle';
          if (!custPhone) return;

          // Get dealer settings for review URL and Twilio number
          const settingsRow = await client.query(
            'SELECT settings_json, twilio_number FROM desk_users WHERE id = $1',
            [req.user.userId]
          );
          if (!settingsRow.rows.length) return;
          const settings = normalizeSettings(settingsRow.rows[0].settings_json || {});
          const fromNumber = settingsRow.rows[0].twilio_number || process.env.TWILIO_PHONE_NUMBER;
          const reviewUrl  = settings.googleReviewUrl || '';
          const dealerName = settings.dealerName || 'us';

          if (!fromNumber) return;

          const reviewLine = reviewUrl
            ? `\n\nIf you have a moment, we'd love a quick review: ${reviewUrl}`
            : '';
          const smsBody = `Congrats ${custName} on your ${vehicleDesc}! 🎉 It was a pleasure working with you at ${dealerName}. Enjoy the ride!${reviewLine}`;

          await twilioClient.messages.create({
            body: smsBody,
            from: fromNumber,
            to: custPhone.replace(/\D/g, '').replace(/^(\d{10})$/, '+1$1').replace(/^1(\d{10})$/, '+1$1')
          });
          console.log('✅ Deal-funded SMS sent to', custPhone);
        } catch(e) {
          console.error('⚠️ Deal-funded SMS failed:', e.message);
        }
      })();
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
  // ── FEATURE TELEMETRY API (dealer's own) ────────────────────────
  app.get('/api/desk/feature-events', requireAuth, async (req, res) => {
    const userId = req.user.userId;
    try {
      const { rows } = await pool.query(`
        SELECT feature, action, COUNT(*) as count, MAX(created_at) as last_used
        FROM feature_events
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY feature, action ORDER BY count DESC
      `, [userId]);
      res.json({ success: true, events: rows });
    } catch(e) { res.status(500).json({ success: false, error: sanitizeError(e) }); }
  });

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
        client.query('SELECT settings_json, email, display_name, role, id, COALESCE(features, \'{}\'::jsonb) AS features, subscription_status FROM desk_users WHERE id = $1', [req.user.userId]),
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
      const rawFeatures = (typeof u.features === 'string' ? JSON.parse(u.features || '{}') : u.features) || {};
      const isLegacy = EXEMPT_EMAILS.includes(u.email) || (Object.keys(rawFeatures).length === 0 && u.subscription_status === 'active');
      const user = {
        id: u.id,
        email: u.email,
        name: u.display_name,
        role: u.role,
        tenantBranding: buildTenantBrandingFromSettings(settings),
        features: isLegacy ? { sarah: true, dt_sync: true, fb_poster: true } : rawFeatures
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

  // ═══════════════════════════════════════════════════════════
  // CALCULATE — server-side deal math (proprietary, not exposed to client)
  // ═══════════════════════════════════════════════════════════
  const finance = require('../lib/finance');

  app.post('/api/desk/calculate', requireAuth, (req, res) => {
    try {
      const { action } = req.body;

      if (action === 'deal-summary') {
        const result = finance.calculateDeal(req.body);
        return res.json({ success: true, ...result });
      }

      if (action === 'quick-calc') {
        const { amount, apr, term } = req.body;
        const payment = finance.quickCalc(parseFloat(amount) || 0, parseFloat(apr) || 0, parseInt(term) || 72);
        return res.json({ success: true, payment });
      }

      if (action === 'reverse-calc') {
        const { payment, apr, term } = req.body;
        const maxLoan = finance.reverseCalc(parseFloat(payment) || 0, parseFloat(apr) || 0, parseInt(term) || 72);
        return res.json({ success: true, maxLoan });
      }

      if (action === 'margin') {
        const { cost, sell } = req.body;
        const result = finance.calcMargin(parseFloat(cost) || 0, parseFloat(sell) || 0);
        return res.json({ success: true, ...result });
      }

      return res.status(400).json({ success: false, error: 'Unknown action. Use: deal-summary, quick-calc, reverse-calc, margin' });
    } catch (e) {
      console.error('❌ /api/desk/calculate error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
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
  // 'pending' = registered but not yet subscribed — block writes immediately
  if (status === 'pending') {
    return { access: 'readonly', reason: 'subscription_required' };
  }
  if (!status || status === 'trial') {
    if (trialEnd && now < trialEnd) {
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
      return { access: 'full', reason: 'trial', daysLeft, trialEnd };
    }
    return { access: 'readonly', reason: 'trial_expired' };
  }
  return { access: 'readonly', reason: status };
}
