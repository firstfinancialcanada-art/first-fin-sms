const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');
const path    = require('path');
require('dotenv').config();

// ── Environment validation ───────────────────────────────────────
// ADMIN_TOKEN is REQUIRED: several admin routes gate with a bare
// `token !== process.env.ADMIN_TOKEN`, which fails OPEN (grants access to a
// request with no token) if the env var is ever undefined. Requiring it at
// boot makes that impossible at runtime. Security audit 2026-06-18.
// TWILIO_AUTH_TOKEN and BASE_URL are required for the same reason as
// ADMIN_TOKEN: validateTwilio (lib/helpers.js) skips signature checking when
// either is missing, so losing one would let anyone POST forged inbound SMS
// and drive Sarah's replies and bookings.
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_TOKEN', 'TWILIO_AUTH_TOKEN', 'BASE_URL'];
const WARN_ENV = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'STRIPE_SECRET_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ FATAL: Missing required env var: ${key}`); process.exit(1); }
}
for (const key of WARN_ENV) {
  if (!process.env[key]) console.warn(`⚠️ Missing env var: ${key} — some features will be disabled`);
}

// ── Inline rate limiter (no external dep) ─────────────────────────
// Per-key fixed window with INDEPENDENT expiry per key (not a global
// Map.clear(), which let a burst sail through right after each reset).
// Keys on req.ip only — with `trust proxy` set below, req.ip is the real
// client IP from Railway's proxy and is NOT client-spoofable. (The old
// x-forwarded-for fallback let an attacker rotate the header to defeat the
// login/register throttle entirely.) Security audit 2026-06-18.
function makeRateLimit({ windowMs, max, message }) {
  const hits = new Map(); // key -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + windowMs }; hits.set(key, rec); }
    rec.count++;
    if (rec.count > max) {
      const body = message || { success: false, error: 'Too many requests' };
      return res.status(429).json(body);
    }
    next();
  };
}

// ── Core setup ────────────────────────────────────────────────────
const app          = express();
// Railway runs the app behind one proxy hop. Trust exactly one proxy so
// req.ip resolves to the real client IP (from X-Forwarded-For) for rate
// limiting + abuse logging, without trusting client-supplied XFF beyond it.
app.set('trust proxy', 1);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT         = process.env.PORT || 3000;
const HOST         = '0.0.0.0';

// ── Security headers ─────────────────────────────────────────────
// Audit item M2. CSP was off entirely because platform.html carries 16 inline
// <script> blocks and 354 inline handlers (onclick/oninput/onchange) — a strict
// script-src means refactoring every one of those on a live system, which is
// not a change to make in a hurry.
//
// Off entirely was still the wrong answer. The directives that actually stop
// the ugliest attacks cost nothing here: object-src 'none' kills plugin-based
// XSS, base-uri 'self' blocks <base> injection redirecting every relative URL,
// frame-ancestors stops clickjacking, and form-action stops an injected form
// posting credentials to someone else's server. Those are enforced now, with
// script-src still permitting inline so nothing breaks.
//
// The stricter policy — same thing without 'unsafe-inline' — ships alongside
// in Report-Only, so the inline handlers get counted rather than guessed at,
// and there's a measured path to full enforcement.
//
// Two things deliberately NOT here:
//   - upgrade-insecure-requests: the Deal Desk and FB Poster talk to local
//     bridges on http://localhost:5001 and :5800. Browsers are supposed to
//     exempt localhost as a trustworthy origin, but "supposed to" is not worth
//     betting a customer's sync on.
//   - a tight img-src: vehicle photos come from whatever CDN the dealer's site
//     uses (homenetiol, cdn-convertus, autoscout24, and more with every new
//     tenant). https: is the honest bound.
const CSP_SHARED = {
  'default-src':     ["'self'"],
  'base-uri':        ["'self'"],
  'object-src':      ["'none'"],
  'frame-ancestors': ["'self'"],
  'form-action':     ["'self'"],
  'style-src':       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src':        ["'self'", 'data:', 'https://fonts.gstatic.com'],
  'img-src':         ["'self'", 'data:', 'blob:', 'https:'],
  // lucide (unpkg), pdf.js (cdnjs), xlsx (sheetjs)
  'script-src-elem': ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://cdn.sheetjs.com'],
  'worker-src':      ["'self'", 'blob:', 'https://cdnjs.cloudflare.com'],
  'connect-src':     ["'self'", 'http://localhost:5001', 'http://localhost:5800'],
  'frame-src':       ["'self'"],
};

function cspString(directives) {
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: false,   // set manually below — two policies, one enforced
    crossOriginEmbedderPolicy: false
  }));

  const enforced = cspString({
    ...CSP_SHARED,
    'script-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://cdn.sheetjs.com'],
  });
  // Same policy minus 'unsafe-inline' — what we're working toward.
  const reportOnly = cspString({
    ...CSP_SHARED,
    'script-src':      ["'self'", 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://cdn.sheetjs.com'],
    'script-src-elem': ["'self'", 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://cdn.sheetjs.com'],
    'report-uri':      ['/api/csp-report'],
  });

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', enforced);
    res.setHeader('Content-Security-Policy-Report-Only', reportOnly);
    next();
  });
  console.log('✅ Helmet security headers enabled (CSP enforced + strict policy in report-only)');
} catch(e) {
  console.warn('⚠️ helmet not installed — run: npm install helmet');
}

// ── CORS — locked to known origins ───────────────────────────────
const ALLOWED_ORIGINS = [
  'https://firstfin.up.railway.app',
  'https://app.firstfinancialcanada.com',
  'http://localhost:3000',
  'http://localhost:5001'
];
// Paths that receive server-to-server callbacks (Twilio, Stripe) — no browser Origin header
const WEBHOOK_PATHS = ['/api/sms-webhook', '/api/voice/', '/api/stripe/webhook', '/api/request-access'];
app.use(cors({
  origin: function(origin, callback) {
    // Allow missing origin only for webhook/server-to-server requests
    // (Twilio callbacks, Stripe webhooks, curl — these never send Origin)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Allow Chrome extension popups — Origin is chrome-extension://<id>
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    callback(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true
}));
// ── Stripe webhook needs raw body BEFORE express.json() ──────────
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Keep the raw bytes for the Meta lead webhook: its X-Hub-Signature-256 is
// an HMAC over exactly what was sent, and re-serializing the parsed body
// changes it (key order, spacing) so the check would always fail.
app.use(express.json({
  limit: '10mb',                                  // handles inventory sync with photos + base64 logo uploads
  verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/meta-leads')) req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── CSP violation reports (report-only policy above) ──────────────
// Every inline onclick in platform.html violates the strict policy, so this
// would happily write thousands of identical lines a day. It aggregates by
// directive + blocked URI instead and prints a rolling summary at most once a
// minute — enough to see what still needs refactoring, cheap enough to leave
// on. Browsers post these as application/csp-report, which express.json does
// not parse by default.
const _cspCounts = new Map();
let _cspLastLog = 0;
app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/json'], limit: '64kb' }), (req, res) => {
  res.sendStatus(204);   // fire-and-forget: never make the browser wait
  try {
    const r = (req.body && (req.body['csp-report'] || req.body)) || {};
    const key = `${r['effective-directive'] || r['violated-directive'] || '?'} ← ${String(r['blocked-uri'] || '?').slice(0, 80)}`;
    _cspCounts.set(key, (_cspCounts.get(key) || 0) + 1);
    const now = Date.now();
    if (now - _cspLastLog > 60000) {
      _cspLastLog = now;
      const top = [..._cspCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log('🛡️ CSP report-only violations (top ' + top.length + ' of ' + _cspCounts.size + '):');
      for (const [k, n] of top) console.log(`   ${n}× ${k}`);
    }
  } catch (e) { /* a malformed report must never take the process down */ }
});

// ── Rate limiting ─────────────────────────────────────────────────
// Login — 10 attempts per 15 min per IP
app.use('/api/desk/login', makeRateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, error: 'Too many login attempts — try again in 15 minutes.' }
}));
// Register — 5 attempts per hour per IP
app.use('/api/desk/register', makeRateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { success: false, error: 'Too many registration attempts — try again in an hour.' }
}));
// Change password — 5 attempts per 15 min per IP
app.use('/api/desk/change-password', makeRateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { success: false, error: 'Too many password change attempts — try again in 15 minutes.' }
}));
// General API — 200 req per min per IP
app.use('/api/', makeRateLimit({
  windowMs: 60 * 1000, max: 200,
  message: { success: false, error: 'Too many requests — slow down.' }
}));
// Twilio webhooks — 60 per min
app.use('/api/sms-webhook', makeRateLimit({ windowMs: 60 * 1000, max: 60 }));
app.use('/api/voice',   makeRateLimit({ windowMs: 60 * 1000, max: 60 }));

// ── Static files & page routes ────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/platform', (req, res) => res.sendFile(path.join(__dirname, 'public', 'platform.html')));
app.get('/setup',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/welcome',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));
app.get('/extension-install', (req, res) => res.sendFile(path.join(__dirname, 'public', 'extension-install.html')));
app.get('/privacy-extension', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy-extension.html')));
// Invoices are NOT web-served — they live in invoice-templates/ (outside
// public/) and render to PDF locally. Serving them as unauthenticated static
// HTML exposed tenant billing PII + our HST# (security audit 2026-05-29, M1).
// The operator page is served only through the gated /admin route
// (routes/admin-dashboard.js) — never straight off disk.
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────
const deskRoutes      = require('./routes/desk');
const { requireAuth } = require('./middleware/auth');
const { makeBillingGuard } = require('./middleware/billing');

// ── Shared helpers ────────────────────────────────────────────────
const { makeNotifyOwner } = require('./lib/helpers');
const notifyOwner         = makeNotifyOwner(twilioClient);

// ── Bulk SMS processor ────────────────────────────────────────────
const { createBulkMessagesTable, makeBulkProcessor } = require('./lib/bulk');
const { createOptOutTable, addOptOut } = require('./lib/db');
createBulkMessagesTable();
// This number asked never to be contacted. It used to be a blacklist inside
// the public platform-main.js, which published a private person's number
// and only guarded CSV imports. On the global opt-out list it's enforced for
// bulk, Sarah and everything else that checks isOptedOut().
createOptOutTable().then(() => addOptOut('+12899688778', 'manual_block'));
const { startBulkProcessor } = makeBulkProcessor(twilioClient);
startBulkProcessor();

// ── Multi-user tenants/members (Phase 1 foundation) ─────────────────
// Idempotent: creates desk_tenants + desk_members tables and backfills
// every existing desk_users row as a single-seat tenant-of-one. No
// existing routes or queries change in this phase. See
// project_firstfin_multiuser_plan.md memory for the full roadmap.
require('./lib/tenants');

// ── Lead intake (Build 2 — ADF email ingestion) ─────────────────────
// Polls the configured Gmail (LEADS_IMAP_USER/PASS env vars), parses
// ADF XML from lead-provider emails (AutoTrader / Kijiji / CCC / TAQ),
// creates CRM rows scoped by the tenant's lead_intake_email address.
// No-op if env vars unset. See project_hunt_chrysler_deal.md.
const leadIntake = require('./lib/lead-intake');
leadIntake.startPolling();

// ── Route modules ─────────────────────────────────────────────────
const requireBilling = makeBillingGuard(require('./lib/db').pool);
const deps = { twilioClient, requireAuth, requireBilling, notifyOwner };

require('./routes/admin')(app,     deps);
require('./routes/sarah')(app,     deps);
require('./routes/analytics')(app, deps);
require('./routes/bulk-sms')(app,  deps);
require('./routes/deals')(app,     deps);
require('./routes/voice')(app,     deps);

// ── Desk auth + cloud sync routes ─────────────────────────────────
deskRoutes(app, require('./lib/db').pool, twilioClient, requireBilling);

// ── Admin dashboard ───────────────────────────────────────────────
require('./routes/admin-dashboard')(app, { twilioClient });

// ── Stripe billing ────────────────────────────────────────────────
require('./routes/stripe')(app, { requireAuth });

// ── Lender rate sheets ────────────────────────────────────────────
require('./routes/lenders')(app, require('./lib/db').pool, requireBilling);

// ── Approval probability (intelligence layer) ────────────────────
const pool = require('./lib/db').pool;
require('./routes/probability')(app, pool, requireAuth, requireBilling);  // User-facing: read-only probabilities
require('./routes/outcomes-admin')(app, pool);                 // Admin: log/manage outcomes
// FB-license route retired — the per-device licensing model is gone; the
// extension now gates entirely on /api/desk auth + requireBilling. Unmounted
// to drop dead auth surface (security audit 2026-05-29, L3).
// app.use('/api/fb-license', require('./routes/fb-license'));
// Meta lead-ads webhook — SaaS prospects (selling the system to dealers),
// deliberately separate from desk_crm, which is car buyers per tenant.
require('./routes/meta-leads')(app, { twilioClient });
require('./routes/compare')(app, { requireAuth, requireBilling }); // Compare All engine (server-side)
require('./routes/tenant-usage')(app, { requireAuth });            // Per-tenant spend + capacity usage

// ── L1: Periodic refresh token cleanup (every 6 hours) ──────────
setInterval(async () => {
  try {
    const result = await pool.query('DELETE FROM desk_refresh_tokens WHERE expires_at < NOW()');
    if (result.rowCount > 0) console.log(`🧹 Purged ${result.rowCount} expired refresh tokens`);
  } catch(e) { console.error('Refresh token cleanup error:', e.message); }
}, 6 * 60 * 60 * 1000).unref();

// ── Graceful shutdown ────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n⚠️ ${signal} received — shutting down gracefully...`);
  if (state.bulkSmsProcessor) { clearInterval(state.bulkSmsProcessor); state.bulkSmsProcessor = null; }
  pool.end().then(() => { console.log('✅ DB pool closed'); process.exit(0); }).catch(() => process.exit(1));
  setTimeout(() => { console.error('❌ Forced shutdown after 10s'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Crash visibility ─────────────────────────────────────────────
// A replace-mode inventory sync was killing the whole process — the
// request 502'd instantly and every other request died with it until
// Railway restarted us ~4s later. Node exits silently on an unhandled
// rejection, so nothing said why. Log the stack before we go, and keep
// the process alive for a rejection (an unhandled rejection is a bug to
// fix, not a reason to drop every other user's request).
process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
  // An uncaught exception can leave state inconsistent — exit and let
  // Railway restart, but only after the reason is on the record.
  setTimeout(() => process.exit(1), 250);
});

// ── Global error handler (terminal middleware) ──────────────────
// Catches any uncaught error from routes/middleware and returns a generic
// 500. Without this, Express's default handler leaks the full stack trace
// to the client unless NODE_ENV==='production'. Logs server-side for
// debugging. Security audit 2026-06-18.
app.use((err, req, res, next) => {
  console.error('❌ Unhandled route error:', (err && err.stack) ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'An unexpected error occurred.' });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`✅ FIRST-FIN PLATFORM v1.0 — Port ${PORT}`);
  console.log(`🌐 Open: http://localhost:${PORT}`);
});
