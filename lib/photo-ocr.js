// lib/photo-ocr.js — Detect dealer signage in vehicle photos
//
// Uses tesseract.js to OCR vehicle photos and detect wholesale-source
// branding (e.g., SmartBuy Auto Ltd sign visible on their building in
// background). Photos with detected signage are flagged so the FB
// Poster queue can hide them before retail reposting. Photos are never
// modified — we just classify each URL as clean or sign-detected.
//
// No storage: rejected photo URLs stay pointing at the source dealer's
// Supabase bucket. Retail dealer can toggle "show hidden" in the UI
// to review and restore any over-filtered photos.
'use strict';

const { createWorker } = require('tesseract.js');

// ── Signage patterns to detect ──────────────────────────────────────────
// List of (label, regex) pairs. Add more dealers here as we onboard them.
// Patterns are intentionally loose to catch common Tesseract misreads
// ("SMARTBIJY", "SMARTBUV" etc. instead of "SMARTBUY").
const SIGN_PATTERNS = [
  { label: 'smartbuy', re: /\bSMART\s*B[UVIJ]\w{0,2}\b/i },    // SMARTBUY / SMART BUY / SMARTBUV
  { label: 'smartbuy', re: /\bSMARTB[UVIJ]\w{0,3}\b/i },       // one-word variants
  { label: 'auto_ltd', re: /\bAUTO\s*[LI]T[DO]\b/i },          // AUTO LTD (LTO, ITO misreads)
];

// ── Worker pool (lazy-initialized, cached across requests) ──────────────
// Tesseract.js workers are expensive to create (~15MB WASM + traineddata).
// We initialize one worker on first use and reuse it. Concurrency is
// serialized inside the worker, so callers should run N URLs in parallel
// by awaiting Promise.all of per-URL recognize() calls — tesseract.js
// internally queues them.
let _workerPromise = null;

async function _getWorker() {
  if (!_workerPromise) {
    _workerPromise = (async () => {
      const w = await createWorker('eng', 1, { logger: () => {} });
      return w;
    })();
  }
  return _workerPromise;
}

// ── Fetch image buffer with timeout ─────────────────────────────────────
async function _fetchImageBuffer(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf;
  } finally {
    clearTimeout(t);
  }
}

// ── Match OCR text against dealer sign patterns ─────────────────────────
function _detectSign(ocrText) {
  const text = (ocrText || '').toUpperCase();
  if (text.length < 3) return null;
  for (const { label, re } of SIGN_PATTERNS) {
    const m = text.match(re);
    if (m) return { label, matched: m[0] };
  }
  return null;
}

// ── Classify a single photo URL ─────────────────────────────────────────
// Returns { url, hasSign, matched?, text?, error? }.
// On fetch/OCR failure, hasSign=false (fail-open — don't falsely reject
// photos due to transient network or OCR errors).
async function classifyPhoto(url) {
  try {
    const buf = await _fetchImageBuffer(url);
    const worker = await _getWorker();
    const { data } = await worker.recognize(buf);
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

// ── Classify a batch of photo URLs for one vehicle ──────────────────────
// Returns { kept: [urls...], rejected: [{ url, matched, text }...] }.
//
// Fallback rule: if ALL photos are flagged, we keep the FIRST one as a
// last-resort so the vehicle still has at least one listing photo.
// Caller can still see the rejected list for review.
async function classifyVehiclePhotos(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { kept: [], rejected: [] };
  }
  const results = await Promise.all(urls.map(classifyPhoto));
  const kept = [];
  const rejected = [];
  for (const r of results) {
    if (r.hasSign) {
      rejected.push({ url: r.url, matched: r.matched, text: r.text });
    } else {
      kept.push(r.url);
    }
  }
  // Last-resort fallback: every photo had the sign. Promote the first
  // back to kept so the vehicle still has something to display.
  if (kept.length === 0 && rejected.length > 0) {
    const first = rejected.shift();
    kept.push(first.url);
  }
  return { kept, rejected };
}

// ── Shut down worker pool (call on graceful server shutdown) ────────────
async function shutdown() {
  if (_workerPromise) {
    try {
      const w = await _workerPromise;
      await w.terminate();
    } catch {}
    _workerPromise = null;
  }
}

module.exports = { classifyPhoto, classifyVehiclePhotos, shutdown };
