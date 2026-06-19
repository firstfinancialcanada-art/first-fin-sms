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
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_TOKEN'];
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
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: false, // CSP would break inline scripts in platform.html
    crossOriginEmbedderPolicy: false
  }));
  console.log('✅ Helmet security headers enabled');
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

app.use(express.json({ limit: '10mb' }));        // 10mb — handles inventory sync with photos + base64 logo uploads
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
const { createOptOutTable } = require('./lib/db');
createBulkMessagesTable();
createOptOutTable();
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
