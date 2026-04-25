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

const { EXEMPT_EMAILS, TENANT_CAPS } = require('../lib/constants');
const { checkInventoryCap, checkCrmCap } = require('../lib/spend-cap');
const { resolveScope, buildCrmReadFilter, canMutateCrmRow, roleAtLeast } = require('../lib/tenant-scope');

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

  // userPayload — what we send to the client after login/register/refresh.
  // Async so we can include the user's tenant membership (Phase 4) — UI
  // uses memberRole + tier to gate manager-only buttons (Rates, Settings,
  // tenant admin) and to show the right dashboard variant.
  async function userPayload(row) {
    const settings = normalizeSettings(row.settings_json || {});
    const payload = {
      id: row.id,
      email: row.email,
      name: row.display_name,
      role: row.role,
      tenantBranding: buildTenantBrandingFromSettings(settings)
    };
    try {
      const tenantsModule = require('../lib/tenants');
      const m = await tenantsModule.getPrimaryMembership(row.id);
      if (m) {
        payload.tenantId   = m.tenantId;
        payload.memberRole = m.memberRole;   // 'owner' | 'manager' | 'rep'
        payload.crmMode    = m.crmMode;      // 'private' | 'pool_plus_own' | 'team_read'
        payload.tier       = m.tier;         // 'single' | 'gold'
        payload.dealership = m.dealership;
      }
    } catch { /* non-fatal — user just doesn't get role gating */ }
    return payload;
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
      const accessToken = await generateAccessToken(user);
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
        user: await userPayload(user)
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

      const accessToken = await generateAccessToken(user);
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
        user: await userPayload(user),
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

      const newAccess = await generateAccessToken(user.rows[0]);
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

  // ── SETUP TOKEN — one-time link for new-account password activation ───
  // Webhook creates a user with a random (never-revealed) password + inserts
  // a setup token. Buyer receives SMS with /setup?token=X link instead of
  // plaintext credentials. /api/desk/setup/verify checks validity without
  // consuming; /api/desk/setup/complete sets the chosen password, marks the
  // token consumed, and returns JWT access+refresh tokens for auto-login.
  ;(async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS setup_tokens (
          token       TEXT PRIMARY KEY,
          user_id     INTEGER NOT NULL REFERENCES desk_users(id) ON DELETE CASCADE,
          expires_at  TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_setup_user ON setup_tokens(user_id)`);
      console.log('✅ setup_tokens table ready');
    } catch (e) { console.error('⚠️ setup_tokens migration:', e.message); }
  })();

  // GET /api/desk/setup/verify?token=XXX — returns the associated email
  //   if the token is valid, unexpired, and unconsumed. No side effects.
  app.get('/api/desk/setup/verify', async (req, res) => {
    const token = String(req.query?.token || '');
    if (!token) return res.status(400).json({ success: false, error: 'Token required' });
    try {
      const { rows } = await pool.query(
        `SELECT u.email, t.expires_at, t.consumed_at
           FROM setup_tokens t JOIN desk_users u ON u.id = t.user_id
          WHERE t.token = $1`,
        [token]
      );
      if (!rows.length)            return res.status(404).json({ success: false, error: 'Setup link not found' });
      if (rows[0].consumed_at)     return res.status(410).json({ success: false, error: 'Setup link already used' });
      if (new Date(rows[0].expires_at) < new Date())
                                   return res.status(410).json({ success: false, error: 'Setup link expired' });
      res.json({ success: true, email: rows[0].email });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // POST /api/desk/setup/complete  body: { token, password }
  //   Validates token, hashes password, consumes token, issues access +
  //   refresh tokens so the client can redirect straight into /platform.
  app.post('/api/desk/setup/complete', async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: 'Token required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tok = await client.query(
        `SELECT t.user_id, t.expires_at, t.consumed_at, u.email, u.display_name, u.role
           FROM setup_tokens t JOIN desk_users u ON u.id = t.user_id
          WHERE t.token = $1 FOR UPDATE`,
        [token]
      );
      if (!tok.rows.length)          { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Setup link not found' }); }
      if (tok.rows[0].consumed_at)   { await client.query('ROLLBACK'); return res.status(410).json({ success: false, error: 'Setup link already used' }); }
      if (new Date(tok.rows[0].expires_at) < new Date())
                                     { await client.query('ROLLBACK'); return res.status(410).json({ success: false, error: 'Setup link expired' }); }

      const uid      = tok.rows[0].user_id;
      const passHash = await bcrypt.hash(password, 12);

      // Clear onboardingPending + tempPassword from settings_json (in case an
      // earlier flow stored it); keep all other settings.
      await client.query(
        `UPDATE desk_users
            SET password_hash  = $1,
                settings_json  = COALESCE(settings_json, '{}'::jsonb)
                                 - 'tempPassword' - 'onboardingPending'
          WHERE id = $2`,
        [passHash, uid]
      );
      await client.query(
        `UPDATE setup_tokens SET consumed_at = NOW() WHERE token = $1`,
        [token]
      );

      // Issue auth tokens so the client can jump straight to /platform
      const userRow   = { id: uid, email: tok.rows[0].email, display_name: tok.rows[0].display_name, role: tok.rows[0].role };
      const accessTok  = await generateAccessToken(userRow);
      const refreshTok = generateRefreshToken(userRow);
      const rtHash     = crypto.createHash('sha256').update(refreshTok).digest('hex');
      await client.query(
        `INSERT INTO desk_refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days')`,
        [uid, rtHash]
      );
      await client.query('COMMIT');
      res.json({ success: true, accessToken: accessTok, refreshToken: refreshTok });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
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
      // ON CONFLICT treats this as upsert — only count-check if it's a true insert.
      const v = req.body;
      const existing = await client.query(
        'SELECT 1 FROM desk_inventory WHERE user_id = $1 AND stock = $2',
        [req.user.userId, v.stock]
      );
      if (!existing.rows.length) {
        const cap = await checkInventoryCap(req.user.userId);
        if (!cap.ok) {
          return res.status(402).json({
            success: false, code: 'CAPACITY_EXCEEDED', kind: 'inventory',
            error: `Inventory limit reached (${cap.count}/${cap.cap}). Remove vehicles or upgrade tier.`,
            count: cap.count, cap: cap.cap,
          });
        }
      }
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

      // Bulk replaces all existing inventory — check incoming size against cap.
      // Exempt users bypass; checkInventoryCap handles that.
      if (vehicles.length > TENANT_CAPS.inventoryMax) {
        const cap = await checkInventoryCap(req.user.userId);
        if (!cap.exempt) {
          return res.status(402).json({
            success: false, code: 'CAPACITY_EXCEEDED', kind: 'inventory',
            error: `Inventory upload exceeds limit (${vehicles.length} > ${TENANT_CAPS.inventoryMax}). Trim the file or upgrade tier.`,
            count: vehicles.length, cap: TENANT_CAPS.inventoryMax,
          });
        }
      }

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
        // Batch VIN lookup — get all existing VINs in one query
        const incomingVins = vehicles.map(v => v.vin?.toUpperCase()).filter(Boolean);
        const existingVins = new Set();
        if (incomingVins.length) {
          const { rows } = await client.query(
            'SELECT vin FROM desk_inventory WHERE user_id=$1 AND vin = ANY($2)',
            [userId, incomingVins]
          );
          rows.forEach(r => existingVins.add(r.vin));
        }
        // Also get existing stocks
        const incomingStocks = vehicles.map(v => makeStock(v));
        const existingStocks = new Set();
        if (incomingStocks.length) {
          const { rows } = await client.query(
            'SELECT stock FROM desk_inventory WHERE user_id=$1 AND stock = ANY($2)',
            [userId, incomingStocks]
          );
          rows.forEach(r => existingStocks.add(r.stock));
        }
        for (const v of vehicles) {
          const vin = v.vin?.toUpperCase();
          const stock = makeStock(v);
          if (vin && existingVins.has(vin)) { skipped++; continue; }
          if (existingStocks.has(stock)) { skipped++; continue; }
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
      // Phase 5 tenant scoping: filter by tenant_id (shared across team)
      // and apply per-rep visibility based on memberRole + crm_mode.
      // Solo tenants are owners with team_read → see all their tenant's
      // rows, identical to pre-Phase-5 behavior. Reps on Gold tenants
      // see own + pool (or whatever their crm_mode dictates).
      const scope = await resolveScope(req);
      if (!scope) {
        // Shouldn't happen post-Phase-1 backfill, but guard for safety
        return res.status(401).json({ success: false, error: 'No tenant membership found' });
      }
      const { where, params } = buildCrmReadFilter(scope, 'desk_crm');
      const result = await client.query(
        `SELECT * FROM desk_crm WHERE ${where} ORDER BY updated_at DESC`,
        params
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
      // Manager+ only: bulk replace wipes the whole tenant CRM. Reps
      // shouldn't be able to nuke teammates' work.
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Bulk CRM replace requires manager role' });
      }

      const { crm } = req.body;
      if (!Array.isArray(crm)) return res.status(400).json({ success: false, error: 'crm[] required' });

      // Bulk replaces all existing CRM — check incoming size against cap.
      if (crm.length > TENANT_CAPS.crmMax) {
        const cap = await checkCrmCap(req.user.userId, 0);
        if (!cap.exempt) {
          return res.status(402).json({
            success: false, code: 'CAPACITY_EXCEEDED', kind: 'crm',
            error: `CRM upload exceeds limit (${crm.length} > ${TENANT_CAPS.crmMax}). Trim the file or upgrade tier.`,
            count: crm.length, cap: TENANT_CAPS.crmMax,
          });
        }
      }

      await client.query('BEGIN');
      // Wipe by tenant — covers all members' rows, not just the caller's
      await client.query('DELETE FROM desk_crm WHERE tenant_id = $1', [scope.tenantId]);

      for (const c of crm) {
        await client.query(
          `INSERT INTO desk_crm (user_id, tenant_id, assigned_rep_id, name, phone, email, beacon, income, obligations, status, source, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [req.user.userId, scope.tenantId, null,  // bulk imports start unassigned (pool)
           c.name, c.phone, c.email, c.beacon, c.income, c.obligations, c.status || 'Lead', c.source, c.notes]
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
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });

      const cap = await checkCrmCap(req.user.userId, 1);
      if (!cap.ok) {
        return res.status(402).json({
          success: false, code: 'CAPACITY_EXCEEDED', kind: 'crm',
          error: `CRM limit reached (${cap.count}/${cap.cap}). Remove contacts or upgrade tier.`,
          count: cap.count, cap: cap.cap,
        });
      }
      const c = req.body;
      // Auto-assign to creator: a rep adding a lead "owns" it. Manager
      // can reassign later. Owner adds also default to assigned-to-self
      // — they can re-route via PATCH /assigned_rep_id if needed.
      const result = await client.query(
        `INSERT INTO desk_crm (user_id, tenant_id, assigned_rep_id, name, phone, email, beacon, income, obligations, status, source, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.user.userId, scope.tenantId, req.user.userId,
         c.name, c.phone, c.email, c.beacon, c.income, c.obligations, c.status || 'Lead', c.source, c.notes]
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
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });

      // Permission check: fetch the row + verify same tenant + role/owner
      const row = await client.query(
        'SELECT id, tenant_id, assigned_rep_id FROM desk_crm WHERE id = $1',
        [req.params.id]
      );
      if (!row.rows.length) return res.status(404).json({ success: false, error: 'CRM entry not found' });
      if (!canMutateCrmRow(scope, row.rows[0])) {
        return res.status(403).json({ success: false, error: 'You cannot modify this lead' });
      }

      // assigned_rep_id is mutable but only by managers+ (rep can't
      // poach a lead away from a teammate, only claim from pool which
      // happens automatically when an unassigned row is touched).
      const ALLOWED = ['status','phone','email','source','notes','name','beacon',
                        'income','obligations','vehicle_interest','budget_range',
                        'follow_up_date','follow_up_note','last_contact'];
      if (roleAtLeast(scope, 'manager')) ALLOWED.push('assigned_rep_id');

      const sets = ['updated_at = NOW()'];
      const vals = [];
      let idx = 1;
      for (const field of ALLOWED) {
        if (req.body[field] !== undefined) {
          sets.push(`${field} = $${idx++}`);
          vals.push(req.body[field] === '' ? null : req.body[field]);
        }
      }
      // Auto-claim from pool: if a rep PATCHes an unassigned row they
      // implicitly claim it (matches buildCrmReadFilter's pool semantics).
      if (!roleAtLeast(scope, 'manager') && row.rows[0].assigned_rep_id == null) {
        sets.push(`assigned_rep_id = $${idx++}`);
        vals.push(req.user.userId);
      }
      vals.push(req.params.id, scope.tenantId);
      await client.query(
        `UPDATE desk_crm SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx}`,
        vals
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── SYNC SARAH → CRM (pull qualified leads into CRM) ─────────
  // Manager+ only: this scans the whole tenant's SARAH conversations and
  // creates pool leads for new customer phones. New rows land unassigned
  // so reps can claim them via the pool semantics in buildCrmReadFilter.
  app.post('/api/desk/crm/sync-sarah', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Sync requires manager role' });
      }

      // Pull conversations across the tenant (not just one user)
      const convs = await client.query(`
        SELECT customer_phone, customer_name, vehicle_type, budget, budget_amount, status, updated_at
        FROM conversations
        WHERE tenant_id = $1 AND customer_phone IS NOT NULL
          AND (vehicle_type IS NOT NULL OR budget IS NOT NULL OR customer_name IS NOT NULL)
        ORDER BY updated_at DESC
      `, [scope.tenantId]);

      let created = 0, updated = 0;
      for (const c of convs.rows) {
        const phone = c.customer_phone;
        // Check if already in CRM (by tenant + phone)
        const existing = await client.query(
          'SELECT id, notes, vehicle_interest, budget_range FROM desk_crm WHERE tenant_id = $1 AND phone = $2',
          [scope.tenantId, phone]
        );
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          const updates = {};
          if (!row.vehicle_interest && c.vehicle_type) updates.vehicle_interest = c.vehicle_type;
          if (!row.budget_range && c.budget) updates.budget_range = c.budget;
          if (Object.keys(updates).length > 0) {
            updates.last_contact = c.updated_at;
            const SAFE_FIELDS = new Set(['vehicle_interest','budget_range','last_contact']);
            const safeUpdates = Object.entries(updates).filter(([k]) => SAFE_FIELDS.has(k));
            const sets = safeUpdates.map(([k], i) => `${k} = $${i+1}`);
            const vals = safeUpdates.map(([,v]) => v);
            vals.push(existing.rows[0].id);
            await client.query(`UPDATE desk_crm SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
            updated++;
          }
        } else {
          // New row lands unassigned (pool) — any rep can claim it
          await client.query(
            `INSERT INTO desk_crm (user_id, tenant_id, assigned_rep_id, name, phone, vehicle_interest, budget_range, status, source, last_contact)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, 'Lead', 'SARAH', $7)`,
            [req.user.userId, scope.tenantId, c.customer_name || '', phone, c.vehicle_type, c.budget, c.updated_at]
          );
          created++;
        }
      }
      res.json({ success: true, created, updated, total: convs.rows.length });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/crm/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });

      const row = await client.query(
        'SELECT id, tenant_id, assigned_rep_id FROM desk_crm WHERE id = $1',
        [req.params.id]
      );
      if (!row.rows.length) return res.status(404).json({ success: false, error: 'CRM entry not found' });
      if (!canMutateCrmRow(scope, row.rows[0])) {
        return res.status(403).json({ success: false, error: 'You cannot delete this lead' });
      }
      await client.query('DELETE FROM desk_crm WHERE id = $1 AND tenant_id = $2', [req.params.id, scope.tenantId]);
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
      // All tenant members read the SAME rate sheet — managers set it,
      // reps consume it. Take the most recently updated row in case
      // there are leftovers from before tenant_id backfill.
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      const result = await client.query(
        `SELECT overrides_json FROM desk_lender_rates
          WHERE tenant_id = $1
          ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [scope.tenantId]
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
      // Manager+ only — reps shouldn't be able to change the lender rates
      // their team uses for Compare All.
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Editing rates requires manager role' });
      }

      const { overrides } = req.body;
      // Replace all rows for this tenant with one canonical row owned by
      // the writer. Avoids needing a UNIQUE(tenant_id) constraint while
      // keeping reads simple (latest row by tenant).
      await client.query('BEGIN');
      await client.query('DELETE FROM desk_lender_rates WHERE tenant_id = $1', [scope.tenantId]);
      await client.query(
        `INSERT INTO desk_lender_rates (user_id, tenant_id, overrides_json, updated_at)
         VALUES ($1, $2, $3, NOW())`,
        [req.user.userId, scope.tenantId, JSON.stringify(overrides || {})]
      );
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/lender-rates', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Resetting rates requires manager role' });
      }
      await client.query('DELETE FROM desk_lender_rates WHERE tenant_id = $1', [scope.tenantId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TEAM DASHBOARD (Phase 5 — manager+ only)
  // Returns per-rep activity for the current tenant: each member's
  // CRM count, deals logged, last login, etc. Used by the Team tab
  // in the platform's Analytics view.
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/team-stats', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Team dashboard requires manager role' });
      }
      // One row per active member of this tenant with their stats
      const result = await client.query(`
        SELECT
          m.id           AS member_id,
          m.user_id,
          m.role,
          m.crm_mode,
          u.email,
          u.display_name,
          u.last_login,
          COALESCE(c.assigned_count,    0) AS assigned_leads,
          COALESCE(c.created_count,     0) AS created_leads,
          COALESCE(d.deal_count_30d,    0) AS deals_30d,
          COALESCE(d.deal_count_total,  0) AS deals_total
        FROM desk_members m
        JOIN desk_users   u ON u.id = m.user_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE assigned_rep_id = m.user_id) AS assigned_count,
            COUNT(*) FILTER (WHERE user_id         = m.user_id) AS created_count
          FROM desk_crm WHERE tenant_id = $1
        ) c ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS deal_count_30d,
            COUNT(*) AS deal_count_total
          FROM desk_deal_log WHERE user_id = m.user_id
        ) d ON true
        WHERE m.tenant_id = $1 AND m.active = TRUE
        ORDER BY (CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END),
                 m.invited_at ASC
      `, [scope.tenantId]);

      // Tenant-level totals for the dashboard header
      const totals = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM desk_crm WHERE tenant_id = $1) AS crm_total,
          (SELECT COUNT(*) FROM desk_crm WHERE tenant_id = $1 AND assigned_rep_id IS NULL) AS crm_pool,
          (SELECT COUNT(*) FROM desk_inventory WHERE tenant_id = $1) AS inventory_total
      `, [scope.tenantId]);

      res.json({
        success: true,
        members: result.rows,
        totals: totals.rows[0] || {},
      });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LEAD ROUTING RULES (manager+ only — Build 4)
  // Manager UI in the platform's Team tab calls these to configure
  // how new ADF leads from email intake auto-distribute to reps.
  // Backend engine lives in lib/lead-routing.js (Build 3).
  // ═══════════════════════════════════════════════════════════
  const leadRouting = require('../lib/lead-routing');

  app.get('/api/desk/routing-rules', requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Routing rules require manager role' });
      }
      const rules = await leadRouting.listRules(scope.tenantId, true);   // include disabled
      const reps  = await leadRouting.listActiveReps(scope.tenantId);
      // Also surface lead_intake_email so the UI can display the address
      const t = await pool.query(`SELECT lead_intake_email FROM desk_tenants WHERE id = $1`, [scope.tenantId]);
      res.json({
        success: true,
        rules,
        reps,
        leadIntakeEmail: t.rows[0]?.lead_intake_email || null,
        ruleTypes: leadRouting.VALID_RULE_TYPES,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  app.post('/api/desk/routing-rules', requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Manager role required' });
      }
      const { ruleType, priority, sources, repIds, label, enabled } = req.body || {};
      if (!leadRouting.VALID_RULE_TYPES.includes(ruleType)) {
        return res.status(400).json({ success: false, error: 'Invalid rule_type' });
      }
      const rule = await leadRouting.createRule(scope.tenantId, {
        ruleType,
        priority: priority != null ? parseInt(priority, 10) : 100,
        sources:  Array.isArray(sources) && sources.length ? sources : null,
        repIds:   Array.isArray(repIds)  && repIds.length  ? repIds.map(n => parseInt(n, 10)).filter(Boolean) : null,
        label:    label || null,
        enabled:  enabled !== false,
      });
      res.json({ success: true, rule });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || sanitizeError(e) });
    }
  });

  app.patch('/api/desk/routing-rules/:id', requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Manager role required' });
      }
      // Verify the rule belongs to this tenant — prevents cross-tenant edits
      const r = await pool.query(`SELECT tenant_id FROM lead_routing_rules WHERE id = $1`, [req.params.id]);
      if (!r.rows.length || r.rows[0].tenant_id !== scope.tenantId) {
        return res.status(404).json({ success: false, error: 'Rule not found' });
      }
      await leadRouting.updateRule(parseInt(req.params.id, 10), req.body || {});
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || sanitizeError(e) });
    }
  });

  app.delete('/api/desk/routing-rules/:id', requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.status(401).json({ success: false, error: 'No tenant membership' });
      if (!roleAtLeast(scope, 'manager')) {
        return res.status(403).json({ success: false, error: 'Manager role required' });
      }
      const r = await pool.query(`SELECT tenant_id FROM lead_routing_rules WHERE id = $1`, [req.params.id]);
      if (!r.rows.length || r.rows[0].tenant_id !== scope.tenantId) {
        return res.status(404).json({ success: false, error: 'Rule not found' });
      }
      await leadRouting.deleteRule(parseInt(req.params.id, 10));
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
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
  // SCRAPE PAGE — server-side HTML parsing (proprietary, not exposed to client)
  // Extension sends raw HTML, server does all parsing. IP stays on server.
  // ═══════════════════════════════════════════════════════════
  const scraper = require('../lib/scraper');

  app.post('/api/desk/scrape-page', requireAuth, requireBilling, async (req, res) => {
    try {
      const { html, url } = req.body;
      if (!html || !url) return res.status(400).json({ success: false, error: 'html and url required' });
      const result = await scraper.scrapePageHtml(html, url);
      res.json({ ok: true, result });
    } catch (e) {
      console.error('❌ /api/desk/scrape-page error:', e.message);
      res.status(500).json({ ok: false, error: 'Server scrape error' });
    }
  });

  app.post('/api/desk/scrape-vdp', requireAuth, requireBilling, (req, res) => {
    try {
      const { html, url } = req.body;
      if (!html || !url) return res.status(400).json({ success: false, error: 'html and url required' });
      const vehicle = scraper.parseVdpDetailHtml(html, url);
      res.json({ ok: true, result: { type: 'detail', vehicles: [vehicle] } });
    } catch (e) {
      console.error('❌ /api/desk/scrape-vdp error:', e.message);
      res.status(500).json({ ok: false, error: 'Server VDP parse error' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // OCR PHOTOS — detect wholesale-source dealer signage
  // Input: { urls: [photoUrl, ...] } — typically one vehicle's gallery.
  // Output: { kept: [...clean urls...], rejected: [{ url, matched, text }...] }
  // Used by FB Poster to filter out photos with visible dealer branding
  // before retail reposting. Fail-open: OCR errors keep the photo.
  // ═══════════════════════════════════════════════════════════
  const photoOcr = require('../lib/photo-ocr');

  app.post('/api/desk/ocr-photos', requireAuth, requireBilling, async (req, res) => {
    try {
      const { urls } = req.body;
      if (!Array.isArray(urls)) return res.status(400).json({ ok: false, error: 'urls array required' });
      if (urls.length === 0) return res.json({ ok: true, result: { kept: [], rejected: [] } });
      // Cap at 30 photos per request — protects against runaway OCR batches
      const capped = urls.slice(0, 30);
      const result = await photoOcr.classifyVehiclePhotos(capped);
      res.json({ ok: true, result });
    } catch (e) {
      console.error('❌ /api/desk/ocr-photos error:', e.message);
      res.status(500).json({ ok: false, error: 'OCR failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // FILTER-AD-PHOTOS — detect shared dealer marketing images
  // Receives all vehicles' d2cmedia photo URLs, hashes first 1000 bytes,
  // returns URLs that appear on 2+ vehicles (dealer ads, not vehicle photos).
  // ═══════════════════════════════════════════════════════════
  const crypto = require('crypto');

  app.post('/api/desk/filter-ad-photos', requireAuth, async (req, res) => {
    try {
      // vehicles: [{photos: [url, url, ...]}]
      const { vehicles } = req.body;
      if (!vehicles?.length) return res.json({ ok: true, adUrls: [] });

      // Hash first 1000 bytes of each d2cmedia photo
      const hashToVehicles = new Map(); // hash -> Set of vehicle indices
      const hashToUrls = new Map();     // hash -> [urls]

      for (let vi = 0; vi < vehicles.length; vi++) {
        const photos = (vehicles[vi].photos || []).filter(p => /d2cmedia\.ca|getedealer\.com/i.test(p));
        for (const url of photos) {
          try {
            const resp = await fetch(url, { headers: { Range: 'bytes=0-999' } });
            if (!resp.ok && resp.status !== 206) continue;
            const buf = Buffer.from(await resp.arrayBuffer());
            const data = buf.length > 1000 ? buf.slice(0, 1000) : buf;
            if (data.length < 100) continue;
            const hash = crypto.createHash('sha256').update(data).digest('hex');
            if (!hashToVehicles.has(hash)) { hashToVehicles.set(hash, new Set()); hashToUrls.set(hash, []); }
            hashToVehicles.get(hash).add(vi);
            hashToUrls.get(hash).push(url);
          } catch { /* skip failed fetches */ }
        }
      }

      // Any hash on 2+ vehicles = dealer ad
      const adUrlSet = new Set();
      for (const [hash, vSet] of hashToVehicles) {
        if (vSet.size >= 2) {
          for (const url of hashToUrls.get(hash)) adUrlSet.add(url);
        }
      }

      // Position-based detection: if photo position N is an ad on 40%+ of vehicles, flag it on all.
      // Catches custom-per-vehicle ads (e.g., recondition cards) at consistent positions.
      const posRe = /d2cmedia\.ca\/[^/]+\/\d+\/\d+\/(\d+)\//i;
      const posAdCount = {};  // position -> count of vehicles where it's an ad
      const posTotal = {};    // position -> count of vehicles that have this position
      const posUrlsByVehicle = {}; // position -> [{vi, url}]
      for (let vi = 0; vi < vehicles.length; vi++) {
        const photos = (vehicles[vi].photos || []).filter(p => /d2cmedia\.ca|getedealer\.com/i.test(p));
        for (const url of photos) {
          const pm = url.match(posRe);
          if (!pm) continue;
          const pos = pm[1];
          posTotal[pos] = (posTotal[pos] || 0) + 1;
          if (!posUrlsByVehicle[pos]) posUrlsByVehicle[pos] = [];
          posUrlsByVehicle[pos].push({ vi, url });
          if (adUrlSet.has(url)) posAdCount[pos] = (posAdCount[pos] || 0) + 1;
        }
      }
      // Flag positions where 30%+ are ads and at least 2 vehicles confirm it
      for (const [pos, adCount] of Object.entries(posAdCount)) {
        const total = posTotal[pos] || 0;
        if (adCount >= 2 && adCount / total >= 0.3) {
          for (const { url } of posUrlsByVehicle[pos]) adUrlSet.add(url);
        }
      }

      const adUrls = [...adUrlSet];
      console.log(`🔍 filter-ad-photos: ${vehicles.length} vehicles, ${hashToVehicles.size} unique hashes, ${adUrls.length} ad URLs found`);
      res.json({ ok: true, adUrls, count: adUrls.length });
    } catch (e) {
      console.error('❌ /api/desk/filter-ad-photos error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
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
