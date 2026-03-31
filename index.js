const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');
const path    = require('path');
require('dotenv').config();

// ── Inline rate limiter (no external dep) ─────────────────────────
function makeRateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    if (count > max) {
      const body = message || { success: false, error: 'Too many requests' };
      return res.status(429).json(body);
    }
    next();
  };
}

// ── Core setup ────────────────────────────────────────────────────
const app          = express();
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
createBulkMessagesTable();
const { startBulkProcessor } = makeBulkProcessor(twilioClient);
startBulkProcessor();

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

// ── L1: Periodic refresh token cleanup (every 6 hours) ──────────
setInterval(async () => {
  try {
    const result = await pool.query('DELETE FROM desk_refresh_tokens WHERE expires_at < NOW()');
    if (result.rowCount > 0) console.log(`🧹 Purged ${result.rowCount} expired refresh tokens`);
  } catch(e) { console.error('Refresh token cleanup error:', e.message); }
}, 6 * 60 * 60 * 1000).unref();

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`✅ FIRST-FIN PLATFORM v1.0 — Port ${PORT}`);
  console.log(`🌐 Open: http://localhost:${PORT}`);
});
