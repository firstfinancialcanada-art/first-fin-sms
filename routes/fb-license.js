/**
 * routes/fb-license.js
 * ====================
 * License + dealer settings for FB Poster.
 *
 * Bridge calls POST /api/fb-license/verify on startup.
 * Returns {ok, settings} — settings drive the bridge entirely.
 * Manage everything from admin panel → FB Poster Licenses section.
 *
 * Wire into server: app.use('/api/fb-license', require('./routes/fb-license'));
 */

const express = require('express');
const router  = express.Router();
const { pool } = require('../lib/db');
const crypto  = require('crypto');

// ── Helpers ───────────────────────────────────────────────────────────────────

const sanitizeError = err =>
  process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;

const normalizeUrl = url =>
  (url || '').toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/$/, '')
    .trim();

const generateKey = () =>
  'FF-' + crypto.randomBytes(12).toString('hex').toUpperCase();

const DEFAULT_BULLETS = [
  '✅ 100% financing available — all credit welcome',
  '✅ 90-day payment deferral',
  '✅ 50% first year payment reduction',
  '✅ 25% MORE money for your trade-in',
];

// ── DB setup (runs on startup, safe to repeat) ────────────────────────────────

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fb_licenses (
      id                   SERIAL PRIMARY KEY,
      license_key          TEXT UNIQUE NOT NULL,
      dealer_name          TEXT NOT NULL,
      dealer_city          TEXT NOT NULL DEFAULT 'Calgary, AB',
      dealer_phone         TEXT NOT NULL DEFAULT '',
      allowed_url          TEXT NOT NULL,
      price_markup         INTEGER NOT NULL DEFAULT 0,
      price_field          TEXT NOT NULL DEFAULT 'Price',
      description_bullets  JSONB NOT NULL DEFAULT '[]'::jsonb,
      column_map           JSONB NOT NULL DEFAULT '{}'::jsonb,
      status               TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','suspended','revoked')),
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      last_seen            TIMESTAMPTZ,
      last_ip              TEXT,
      check_count          INTEGER DEFAULT 0,
      notes                TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_fb_lic_key ON fb_licenses(license_key);
  `);
  // Migrate: add columns to existing tables without breaking them
  const migrations = [
    `ALTER TABLE fb_licenses ADD COLUMN IF NOT EXISTS dealer_city TEXT NOT NULL DEFAULT 'Calgary, AB'`,
    `ALTER TABLE fb_licenses ADD COLUMN IF NOT EXISTS dealer_phone TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE fb_licenses ADD COLUMN IF NOT EXISTS price_markup INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE fb_licenses ADD COLUMN IF NOT EXISTS price_field TEXT NOT NULL DEFAULT 'Price'`,
    `ALTER TABLE fb_licenses ADD COLUMN IF NOT EXISTS description_bullets JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE fb_licenses ADD COLUMN IF NOT EXISTS column_map JSONB NOT NULL DEFAULT '{}'::jsonb`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch(_) {}
  }
}
ensureSchema().catch(e => console.error('[fb-license] schema error:', e.message));

// ── PUBLIC: bridge verify (called on every bridge.py startup) ─────────────────

router.post('/verify', async (req, res) => {
  const { license_key, inventory_url } = req.body || {};

  if (!license_key) {
    return res.status(400).json({ ok: false, reason: 'No license key provided.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM fb_licenses WHERE license_key = $1', [license_key]
    );

    if (!rows.length) {
      return res.json({ ok: false,
        reason: 'License key not found. Contact First-Fin to activate.' });
    }

    const lic = rows[0];

    if (lic.status === 'revoked') {
      return res.json({ ok: false,
        reason: 'This license has been revoked. Contact First-Fin.' });
    }
    if (lic.status === 'suspended') {
      return res.json({ ok: false,
        reason: 'Access suspended. Contact First-Fin at 587-306-6133.' });
    }

    // URL check — domain of incoming must match allowed_url domain
    if (lic.allowed_url && inventory_url) {
      const allowedDomain  = normalizeUrl(lic.allowed_url).split('/')[0];
      const incomingDomain = normalizeUrl(inventory_url).split('/')[0];
      if (allowedDomain && incomingDomain && incomingDomain !== allowedDomain) {
        return res.json({ ok: false,
          reason: `License not valid for ${inventory_url}. Contact First-Fin to update your allowed URL.` });
      }
    }

    // Record activity
    await pool.query(
      `UPDATE fb_licenses
         SET last_seen = NOW(), last_ip = $1, check_count = check_count + 1
       WHERE license_key = $2`,
      [req.ip || req.headers['x-forwarded-for'] || '', license_key]
    );

    const bullets = (lic.description_bullets || []).length
      ? lic.description_bullets : DEFAULT_BULLETS;

    return res.json({
      ok:     true,
      dealer: lic.dealer_name,
      settings: {
        dealer_name:         lic.dealer_name,
        dealer_city:         lic.dealer_city         || 'Calgary, AB',
        dealer_phone:        lic.dealer_phone        || '',
        allowed_url:         lic.allowed_url,
        price_markup:        lic.price_markup         || 0,
        price_field:         lic.price_field          || 'Price',
        description_bullets: bullets,
        column_map:          lic.column_map           || {},
      },
    });

  } catch (err) {
    console.error('[fb-license] verify:', err.message);
    // Fail open on server error — don't lock dealers out of an outage
    return res.status(500).json({ ok: false, reason: sanitizeError(err) });
  }
});

// ── Admin middleware ───────────────────────────────────────────────────────────

const requireAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ── ADMIN: list ───────────────────────────────────────────────────────────────

router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, license_key, dealer_name, dealer_city, dealer_phone,
              allowed_url, price_markup, price_field,
              description_bullets, column_map,
              status, created_at, last_seen, last_ip, check_count, notes
       FROM fb_licenses ORDER BY created_at DESC`
    );
    res.json({ ok: true, licenses: rows });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ── ADMIN: create ─────────────────────────────────────────────────────────────

router.post('/admin/create', requireAdmin, async (req, res) => {
  const {
    dealer_name, dealer_city, dealer_phone,
    allowed_url, price_markup, price_field,
    description_bullets, column_map, notes
  } = req.body || {};

  if (!dealer_name || !allowed_url) {
    return res.status(400).json({ error: 'dealer_name and allowed_url required' });
  }

  try {
    const key    = generateKey();
    const { rows } = await pool.query(
      `INSERT INTO fb_licenses
         (license_key, dealer_name, dealer_city, dealer_phone,
          allowed_url, price_markup, price_field,
          description_bullets, column_map, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        key,
        dealer_name.trim(),
        (dealer_city  || 'Calgary, AB').trim(),
        (dealer_phone || '').trim(),
        normalizeUrl(allowed_url),
        parseInt(price_markup)  || 0,
        (price_field  || 'Price').trim(),
        JSON.stringify(description_bullets || DEFAULT_BULLETS),
        JSON.stringify(column_map || {}),
        (notes || '').trim(),
      ]
    );
    res.json({ ok: true, license: rows[0] });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ── ADMIN: update (settings + status in one PATCH) ───────────────────────────

router.patch('/admin/:id', requireAdmin, async (req, res) => {
  const {
    dealer_name, dealer_city, dealer_phone,
    allowed_url, price_markup, price_field,
    description_bullets, column_map, notes, status
  } = req.body || {};

  if (status && !['active','suspended','revoked'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE fb_licenses SET
         dealer_name         = COALESCE($1,  dealer_name),
         dealer_city         = COALESCE($2,  dealer_city),
         dealer_phone        = COALESCE($3,  dealer_phone),
         allowed_url         = COALESCE($4,  allowed_url),
         price_markup        = COALESCE($5,  price_markup),
         price_field         = COALESCE($6,  price_field),
         description_bullets = COALESCE($7,  description_bullets),
         column_map          = COALESCE($8,  column_map),
         notes               = COALESCE($9,  notes),
         status              = COALESCE($10, status)
       WHERE id = $11 RETURNING *`,
      [
        dealer_name  || null,
        dealer_city  || null,
        dealer_phone || null,
        allowed_url  ? normalizeUrl(allowed_url) : null,
        price_markup !== undefined ? parseInt(price_markup) : null,
        price_field  || null,
        description_bullets ? JSON.stringify(description_bullets) : null,
        column_map          ? JSON.stringify(column_map)          : null,
        notes !== undefined ? notes : null,
        status || null,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, license: rows[0] });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ── ADMIN: delete ─────────────────────────────────────────────────────────────

router.delete('/admin/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM fb_licenses WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

module.exports = router;
