// lib/photo-ocr.js — Detect dealer signage in vehicle photos
//
// Wholesale galleries are shot on the supplier's lot, so their sign turns up
// in the background of some photos. Reposting one of those at retail sends
// the buyer to the wholesaler. This classifies each photo URL as clean or
// sign-detected; photos are never modified, and the FB Poster hides the
// flagged ones (the operator can still toggle them back).
//
// How it reads a sign (measured 2026-09-23 against SmartBuy's live gallery):
// running OCR over a whole 2560x1920 lot photo returns noise — 0 of 6 photos
// flagged in 34s each, including a rear shot with SMARTBUY AUTO LTD plainly
// on the shop door. The same sign inside a 420x320 crop reads in 0.2s. So
// each photo is walked in overlapping full-resolution tiles. Downscaling
// first was tried and abandoned: at 1200-1600px wide the sign stops being
// legible at all, so the speed came at the cost of the whole feature.
//
// Speed comes from three things instead: a pool of workers running tiles in
// parallel, scanning only the top of the frame (a building sign is never on
// the ground), and a cache so any given photo is read once, ever.
// 6 photos: 194s before, ~58s now, same detection.
'use strict';

const { createWorker, createScheduler } = require('tesseract.js');
const { safeFetch } = require('./url-guard'); // SSRF-guarded image fetch
const { pool } = require('./db');

// sharp is only used to read image dimensions for PNG/WebP. It is optional:
// if the native build is unavailable the JPEG header parser below covers the
// galleries we actually scan, and anything unreadable falls back to
// whole-image OCR.
let _sharp = null;
try { _sharp = require('sharp'); } catch { /* optional */ }

// ── Signage patterns to detect ─────────────────────────────────────────
// List of (label, regex) pairs. Add more dealers here as we onboard them.
// Patterns are intentionally loose to catch common Tesseract misreads
// ("SMARTBIJY", "SMARTBUV" etc. instead of "SMARTBUY").
const SIGN_PATTERNS = [
  { label: 'smartbuy', re: /\bSMART\s*B[UVIJ]\w{0,2}\b/i },    // SMARTBUY / SMART BUY / SMARTBUV
  { label: 'smartbuy', re: /\bSMARTB[UVIJ]\w{0,3}\b/i },       // one-word variants
  { label: 'auto_ltd', re: /\bAUTO\s*[LI]T[DO]\b/i },          // AUTO LTD (LTO, ITO misreads)
];

// Tiles are read in parallel by this many workers. Each holds its own WASM
// copy (~15MB), so this trades memory for wall-clock.
const WORKERS = Math.max(1, Math.min(4, parseInt(process.env.OCR_WORKERS || '3', 10)));
const TILE = 460;          // the size a sign reads at reliably
const TILE_OVERLAP = 0.25; // so a sign on a tile edge still lands whole in a neighbour
const SCAN_BAND = 0.65;    // fraction of image height searched, from the top

// ── Worker pool (lazy, cached across requests) ─────────────────────────
let _schedulerPromise = null;

async function _getScheduler() {
  if (!_schedulerPromise) {
    _schedulerPromise = (async () => {
      const scheduler = createScheduler();
      for (let i = 0; i < WORKERS; i++) {
        scheduler.addWorker(await createWorker('eng', 1, { logger: () => {} }));
      }
      return scheduler;
    })();
  }
  return _schedulerPromise;
}

// ── Cache ──────────────────────────────────────────────────────────────
// Photo URLs are immutable (each upload gets its own path), so a verdict is
// good forever. Without this, every visit to a vehicle in the poster re-read
// its whole gallery.
let _cacheReady = null;
function _ensureCache() {
  if (!_cacheReady) {
    _cacheReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS photo_sign_checks (
          url        TEXT PRIMARY KEY,
          has_sign   BOOLEAN NOT NULL,
          matched    TEXT,
          checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Operator decisions. Kept apart from the OCR verdicts above because
      // they are a different kind of fact: OCR says what it could read, this
      // says what a human decided, and the human always wins. hidden=false is
      // stored too — that is "I looked, the scan was wrong, keep it".
      await pool.query(`
        CREATE TABLE IF NOT EXISTS photo_hides (
          tenant_id  INTEGER NOT NULL,
          url        TEXT    NOT NULL,
          hidden     BOOLEAN NOT NULL,
          user_id    INTEGER,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, url)
        )
      `);
      // Cover-ups. Hiding a whole photo because a supplier's sign appears in
      // the corner throws away the shot — on SmartBuy's galleries the sign
      // turns up at the edge of the rear 3/4 and side angles, which are the
      // ones that sell the car. A box over the sign keeps the photo.
      //
      // Coordinates are fractions of width/height, not pixels, so the same
      // box holds whatever size the image is served at.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS photo_edits (
          tenant_id  INTEGER NOT NULL,
          url        TEXT    NOT NULL,
          boxes      JSONB   NOT NULL,
          user_id    INTEGER,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, url)
        )
      `);
    })().catch(e => { console.error('❌ photo sign tables:', e.message); });
  }
  return _cacheReady;
}

// ── Operator photo decisions ───────────────────────────────────────────
// Scoped per tenant: two dealers can carry the same wholesale unit and
// disagree about a photo.
async function getHides(tenantId, urls) {
  const hidden = new Set(), kept = new Set();
  if (!tenantId || !urls || !urls.length) return { hidden, kept };
  try {
    await _ensureCache();
    const { rows } = await pool.query(
      'SELECT url, hidden FROM photo_hides WHERE tenant_id = $1 AND url = ANY($2)',
      [tenantId, urls]
    );
    for (const r of rows) (r.hidden ? hidden : kept).add(r.url);
  } catch (e) {
    console.warn('⚠️ photo hides read failed:', e.message);   // fall back to OCR alone
  }
  return { hidden, kept };
}

// ── Cover-up boxes ─────────────────────────────────────────────────────
// boxes: [{ x, y, w, h }] with every value 0..1, relative to the image.
function _sanitizeBoxes(boxes) {
  if (!Array.isArray(boxes)) return [];
  const clamp = n => Math.min(1, Math.max(0, Number(n)));
  return boxes
    .map(b => ({ x: clamp(b && b.x), y: clamp(b && b.y), w: clamp(b && b.w), h: clamp(b && b.h) }))
    .filter(b => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0.002 && b.h > 0.002)
    .slice(0, 12);                       // a dozen is already more than any photo needs
}

async function getEdits(tenantId, urls) {
  const out = new Map();
  if (!tenantId || !urls || !urls.length) return out;
  try {
    await _ensureCache();
    const { rows } = await pool.query(
      'SELECT url, boxes FROM photo_edits WHERE tenant_id = $1 AND url = ANY($2)',
      [tenantId, urls]
    );
    for (const r of rows) out.set(r.url, r.boxes || []);
  } catch (e) {
    console.warn('⚠️ photo edits read failed:', e.message);
  }
  return out;
}

async function setEdits(tenantId, url, boxes, userId) {
  if (!tenantId || !url) throw new Error('tenantId and url required');
  const clean = _sanitizeBoxes(boxes);
  await _ensureCache();
  if (!clean.length) {
    await pool.query('DELETE FROM photo_edits WHERE tenant_id = $1 AND url = $2', [tenantId, url]);
    return [];
  }
  await pool.query(
    `INSERT INTO photo_edits (tenant_id, url, boxes, user_id)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (tenant_id, url)
     DO UPDATE SET boxes = EXCLUDED.boxes, user_id = EXCLUDED.user_id, updated_at = NOW()`,
    [tenantId, url, JSON.stringify(clean), userId || null]
  );
  return clean;
}

async function setHide(tenantId, url, hidden, userId) {
  if (!tenantId || !url) throw new Error('tenantId and url required');
  await _ensureCache();
  await pool.query(
    `INSERT INTO photo_hides (tenant_id, url, hidden, user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, url)
     DO UPDATE SET hidden = EXCLUDED.hidden, user_id = EXCLUDED.user_id, updated_at = NOW()`,
    [tenantId, url, !!hidden, userId || null]
  );
}

async function _readCache(urls) {
  const out = new Map();
  try {
    await _ensureCache();
    const { rows } = await pool.query(
      'SELECT url, has_sign, matched FROM photo_sign_checks WHERE url = ANY($1)', [urls]
    );
    for (const r of rows) out.set(r.url, { url: r.url, hasSign: r.has_sign, matched: r.matched, cached: true });
  } catch (e) {
    console.warn('⚠️ photo sign cache read failed:', e.message);   // fall through to OCR
  }
  return out;
}

async function _writeCache(results) {
  if (!results.length) return;
  try {
    await _ensureCache();
    await pool.query(
      `INSERT INTO photo_sign_checks (url, has_sign, matched)
       SELECT * FROM UNNEST($1::text[], $2::boolean[], $3::text[])
       ON CONFLICT (url) DO NOTHING`,
      [results.map(r => r.url), results.map(r => !!r.hasSign), results.map(r => r.matched || null)]
    );
  } catch (e) {
    console.warn('⚠️ photo sign cache write failed:', e.message);   // not worth failing the scan
  }
}

// ── Fetch image buffer with timeout ────────────────────────────────────
async function _fetchImageBuffer(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await safeFetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf;
  } finally {
    clearTimeout(t);
  }
}

// ── Image dimensions ───────────────────────────────────────────────────
// Reads the JPEG SOFn marker; sharp covers other formats when it's around.
// Null means "unknown", and the caller falls back to whole-image OCR.
function _jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15, skipping DHT (C4), JPGA (C8) and DAC (CC)
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

async function _imageSize(buf) {
  const jpeg = _jpegSize(buf);
  if (jpeg) return jpeg;
  if (_sharp) {
    try {
      const m = await _sharp(buf).metadata();
      if (m.width && m.height) return { width: m.width, height: m.height };
    } catch { /* fall through */ }
  }
  return null;
}

// ── Tiles to scan ──────────────────────────────────────────────────────
function _tiles(width, height) {
  const step = Math.round(TILE * (1 - TILE_OVERLAP));
  const maxY = Math.round(height * SCAN_BAND);
  const out = [];
  for (let top = 0; top < maxY; top += step) {
    for (let left = 0; left < width; left += step) {
      const w = Math.min(TILE, width - left);
      const h = Math.min(TILE, height - top);
      if (w >= 120 && h >= 120) out.push({ left, top, width: w, height: h });
    }
  }
  return out;
}

// ── Match OCR text against dealer sign patterns ────────────────────────
function _detectSign(ocrText) {
  const text = (ocrText || '').toUpperCase();
  if (text.length < 3) return null;
  for (const { label, re } of SIGN_PATTERNS) {
    const m = text.match(re);
    if (m) return { label, matched: m[0] };
  }
  return null;
}

// ── Classify a single photo URL ────────────────────────────────────────
// Returns { url, hasSign, matched?, text?, error? }.
// On fetch/OCR failure, hasSign=false (fail-open — don't falsely reject
// photos due to transient network or OCR errors).
async function classifyPhoto(url) {
  try {
    const buf = await _fetchImageBuffer(url);
    const size = await _imageSize(buf);
    const scheduler = await _getScheduler();

    if (size && size.width > 900 && size.height > 700) {
      const rects = _tiles(size.width, size.height);
      // Run a batch per pass so a hit can stop the rest — most photos are
      // clean and pay the full cost, but a flagged one exits early.
      const batchSize = WORKERS * 2;
      for (let i = 0; i < rects.length; i += batchSize) {
        const batch = rects.slice(i, i + batchSize);
        const texts = await Promise.all(batch.map(rectangle =>
          scheduler.addJob('recognize', buf, { rectangle })
            .then(r => (r && r.data && r.data.text) || '')
            .catch(() => '')            // one bad tile must not sink the photo
        ));
        for (const text of texts) {
          const sign = _detectSign(text);
          if (sign) return { url, hasSign: true, matched: sign.matched, text: text.trim().slice(0, 120) };
        }
      }
      return { url, hasSign: false, text: '' };
    }

    // Small image: one pass over the whole thing.
    const { data } = await scheduler.addJob('recognize', buf);
    const sign = _detectSign(data.text);
    return {
      url,
      hasSign: !!sign,
      matched: sign?.matched || null,
      text:    (data.text || '').trim().slice(0, 120),
    };
  } catch (e) {
    return { url, hasSign: false, error: String(e.message || e).slice(0, 100) };
  }
}

// ── Classify a batch of photo URLs for one vehicle ─────────────────────
// Returns { kept: [urls...], rejected: [{ url, matched, text }...] }.
//
// opts.tenantId — apply that tenant's saved photo decisions (always wins
//                 over OCR, in both directions).
// opts.scan     — false skips OCR entirely and only applies saved decisions.
//                 Used for a dealer's own photos: nothing to detect, but a
//                 photo the operator hid by hand must stay hidden.
//
// Fallback rule: if ALL photos are flagged, we keep the FIRST one as a
// last-resort so the vehicle still has at least one listing photo.
// Caller can still see the rejected list for review.
async function classifyVehiclePhotos(urls, opts = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { kept: [], rejected: [] };
  }
  const { tenantId = null, scan = true } = opts;

  const manual = await getHides(tenantId, urls);

  let cached = new Map(), scanned = [];
  if (scan) {
    cached = await _readCache(urls);
    // A photo the operator already ruled on needs no OCR — their answer wins
    // either way, so reading it would only burn time.
    const toScan = urls.filter(u => !cached.has(u) && !manual.hidden.has(u) && !manual.kept.has(u));
    for (const url of toScan) {
      scanned.push(await classifyPhoto(url));   // scheduler already parallelises tiles
    }
    await _writeCache(scanned.filter(r => !r.error));
    if (cached.size) console.log(`🔍 photo signage: ${cached.size} cached, ${scanned.length} scanned`);
  }

  const byUrl = new Map(scanned.map(r => [r.url, r]));
  const kept = [];
  const rejected = [];
  for (const url of urls) {
    if (manual.hidden.has(url)) { rejected.push({ url, matched: 'manual', manual: true }); continue; }
    if (manual.kept.has(url))   { kept.push(url); continue; }
    const r = cached.get(url) || byUrl.get(url) || { url, hasSign: false };
    if (r.hasSign) rejected.push({ url: r.url, matched: r.matched, text: r.text });
    else kept.push(url);
  }

  // Last-resort fallback: every photo had the sign. Promote the first back to
  // kept so the vehicle still has something to display. Only ever promotes an
  // OCR rejection — if the operator hid every photo by hand, they meant it.
  if (kept.length === 0 && rejected.length > 0) {
    const i = rejected.findIndex(r => !r.manual);
    if (i >= 0) kept.push(rejected.splice(i, 1)[0].url);
  }
  return { kept, rejected };
}

// ── Shut down worker pool (call on graceful server shutdown) ───────────
async function shutdown() {
  if (_schedulerPromise) {
    try {
      const s = await _schedulerPromise;
      await s.terminate();
    } catch {}
    _schedulerPromise = null;
  }
}

module.exports = { classifyPhoto, classifyVehiclePhotos, getHides, setHide, getEdits, setEdits, shutdown };
