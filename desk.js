// ============================================================
// routes/desk.js — All Desk Platform API Routes
// Mounts under /api/desk/*
// ============================================================
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { generateAccessToken, generateRefreshToken, requireAuth, JWT_SECRET, REFRESH_TTL_DAYS } = require('../middleware/auth');

module.exports = function (app, pool) {

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

      // Check if email exists
      const existing = await client.query('SELECT id FROM desk_users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }

      const hash = await bcrypt.hash(password, 12);
      const result = await client.query(
        `INSERT INTO desk_users (email, password_hash, display_name, role, settings_json)
         VALUES ($1, $2, $3, 'owner', $4) RETURNING id, email, display_name, role`,
        [email.toLowerCase(), hash, name, JSON.stringify({ salesName: name, dealerName: 'My Dealership', docFee: 998, gst: 5, apr: 8.99, target: 30 })]
      );

      const user = result.rows[0];
      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);

      // Save refresh token hash
      const rtHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await client.query(
        `INSERT INTO desk_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days')`,
        [user.id, rtHash]
      );

      console.log('🆕 Desk user registered:', email);
      res.json({ success: true, accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.display_name, role: user.role } });
    } catch (e) {
      console.error('❌ Register error:', e.message);
      res.status(500).json({ success: false, error: e.message });
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

      const result = await client.query('SELECT * FROM desk_users WHERE email = $1', [email.toLowerCase()]);
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
        `INSERT INTO desk_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days')`,
        [user.id, rtHash]
      );

      console.log('🔑 Desk login:', email);
      res.json({ success: true, accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.display_name, role: user.role } });
    } catch (e) {
      console.error('❌ Login error:', e.message);
      res.status(500).json({ success: false, error: e.message });
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

      // Verify JWT
      let decoded;
      try { decoded = require('jsonwebtoken').verify(refreshToken, JWT_SECRET); }
      catch { return res.status(401).json({ success: false, error: 'Invalid refresh token' }); }

      // Check DB
      const rtHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const rt = await client.query(
        'SELECT * FROM desk_refresh_tokens WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()',
        [rtHash, decoded.userId]
      );
      if (rt.rows.length === 0) {
        return res.status(401).json({ success: false, error: 'Refresh token expired or revoked' });
      }

      // Delete old, issue new (rotation)
      await client.query('DELETE FROM desk_refresh_tokens WHERE token_hash = $1', [rtHash]);

      const user = await client.query('SELECT * FROM desk_users WHERE id = $1', [decoded.userId]);
      if (user.rows.length === 0) return res.status(401).json({ success: false, error: 'User not found' });

      const newAccess = generateAccessToken(user.rows[0]);
      const newRefresh = generateRefreshToken(user.rows[0]);
      const newHash = crypto.createHash('sha256').update(newRefresh).digest('hex');
      await client.query(
        `INSERT INTO desk_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TTL_DAYS} days')`,
        [decoded.userId, newHash]
      );

      res.json({ success: true, accessToken: newAccess, refreshToken: newRefresh });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ── GET ME ───────────────────────────────────────────────
  app.get('/api/desk/me', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT id, email, display_name, role, created_at, last_login FROM desk_users WHERE id = $1',
        [req.user.userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
      res.json({ success: true, user: result.rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ── LOGOUT ───────────────────────────────────────────────
  app.post('/api/desk/logout', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      // Delete all refresh tokens for this user
      await client.query('DELETE FROM desk_refresh_tokens WHERE user_id = $1', [req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SETTINGS (replaces ffSettings localStorage)
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/settings', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT settings_json FROM desk_users WHERE id = $1', [req.user.userId]);
      res.json({ success: true, settings: result.rows[0]?.settings_json || {} });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/settings', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { settings } = req.body;
      await client.query('UPDATE desk_users SET settings_json = $1 WHERE id = $2', [JSON.stringify(settings), req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // INVENTORY (replaces hardcoded const in HTML)
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/inventory', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT stock, year, make, model, mileage, price, condition, carfax, type, status FROM desk_inventory ORDER BY stock'
      );
      res.json({ success: true, inventory: result.rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/desk/inventory', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const v = req.body;
      const result = await client.query(
        `INSERT INTO desk_inventory (stock, year, make, model, mileage, price, condition, carfax, type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (stock) DO UPDATE SET year=$2, make=$3, model=$4, mileage=$5, price=$6, condition=$7, carfax=$8, type=$9, updated_at=NOW()
         RETURNING *`,
        [v.stock, v.year, v.make, v.model, v.mileage, v.price, v.condition || 'Average', v.carfax || 0, v.type]
      );
      res.json({ success: true, vehicle: result.rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // Bulk replace inventory (CSV import)
  app.put('/api/desk/inventory/bulk', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { vehicles } = req.body;
      if (!Array.isArray(vehicles)) return res.status(400).json({ success: false, error: 'vehicles[] required' });

      await client.query('BEGIN');
      // Mark all current as 'delisted', then upsert new
      await client.query("UPDATE desk_inventory SET status = 'delisted'");

      for (const v of vehicles) {
        await client.query(
          `INSERT INTO desk_inventory (stock, year, make, model, mileage, price, condition, carfax, type, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'available')
           ON CONFLICT (stock) DO UPDATE SET year=$2, make=$3, model=$4, mileage=$5, price=$6, condition=$7, carfax=$8, type=$9, status='available', updated_at=NOW()`,
          [v.stock, v.year, v.make, v.model, v.mileage, v.price, v.condition || 'Average', v.carfax || 0, v.type]
        );
      }
      await client.query('COMMIT');
      res.json({ success: true, count: vehicles.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/inventory/:stock', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_inventory WHERE stock = $1', [req.params.stock]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CRM (replaces ffCRM localStorage)
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
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // Bulk save entire CRM array (mirrors localStorage pattern)
  app.put('/api/desk/crm/bulk', requireAuth, async (req, res) => {
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
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/desk/crm', requireAuth, async (req, res) => {
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
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/crm/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_crm WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DEAL LOG (replaces ffDealLog localStorage)
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/deal-log', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT id, deal_data, created_at FROM desk_deal_log WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.userId]
      );
      // Return the deal_data array matching the frontend format
      const dealLog = result.rows.map(r => ({ ...r.deal_data, _dbId: r.id }));
      res.json({ success: true, dealLog });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // Bulk save entire deal log (mirrors localStorage pattern)
  app.put('/api/desk/deal-log/bulk', requireAuth, async (req, res) => {
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
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/desk/deal-log', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'INSERT INTO desk_deal_log (user_id, deal_data) VALUES ($1, $2) RETURNING id, created_at',
        [req.user.userId, JSON.stringify(req.body.deal)]
      );
      res.json({ success: true, id: result.rows[0].id });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/deal-log/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_deal_log WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LENDER RATE OVERRIDES (replaces ffLenderRates localStorage)
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
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/lender-rates', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { overrides } = req.body;
      await client.query(
        `INSERT INTO desk_lender_rates (user_id, overrides_json, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET overrides_json = $2, updated_at = NOW()`,
        [req.user.userId, JSON.stringify(overrides)]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/desk/lender-rates', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM desk_lender_rates WHERE user_id = $1', [req.user.userId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIOS / SAVE SLOTS (replaces ffScenarios localStorage)
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/scenarios', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT slot, deal_data, label, saved_at FROM desk_scenarios WHERE user_id = $1 ORDER BY slot',
        [req.user.userId]
      );
      // Build array of 3 slots
      const slots = [null, null, null];
      for (const row of result.rows) {
        slots[row.slot] = row.deal_data;
      }
      res.json({ success: true, scenarios: slots });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/desk/scenarios', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { scenarios } = req.body; // array of 3
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
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LOAD ALL — single endpoint to hydrate the frontend
  // ═══════════════════════════════════════════════════════════
  app.get('/api/desk/load-all', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const [settingsR, inventoryR, crmR, dealLogR, lenderR, scenariosR] = await Promise.all([
        client.query('SELECT settings_json FROM desk_users WHERE id = $1', [req.user.userId]),
        client.query("SELECT stock, year, make, model, mileage, price, condition, carfax, type FROM desk_inventory WHERE status = 'available' ORDER BY stock"),
        client.query('SELECT * FROM desk_crm WHERE user_id = $1 ORDER BY updated_at DESC', [req.user.userId]),
        client.query('SELECT id, deal_data, created_at FROM desk_deal_log WHERE user_id = $1 ORDER BY created_at DESC', [req.user.userId]),
        client.query('SELECT overrides_json FROM desk_lender_rates WHERE user_id = $1', [req.user.userId]),
        client.query('SELECT slot, deal_data FROM desk_scenarios WHERE user_id = $1 ORDER BY slot', [req.user.userId]),
      ]);

      // Build scenarios array
      const scenarioSlots = [null, null, null];
      for (const row of scenariosR.rows) scenarioSlots[row.slot] = row.deal_data;

      res.json({
        success: true,
        settings: settingsR.rows[0]?.settings_json || {},
        inventory: inventoryR.rows,
        crm: crmR.rows,
        dealLog: dealLogR.rows.map(r => ({ ...r.deal_data, _dbId: r.id })),
        lenderRates: lenderR.rows[0]?.overrides_json || {},
        scenarios: scenarioSlots
      });
    } catch (e) {
      console.error('❌ /api/desk/load-all error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  });

  console.log('✅ Desk API routes mounted on /api/desk/*');
};
