// ── Phone Utilities ───────────────────────────────────────────────
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10 && digits[0] >= '2') return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1') && digits[1] >= '2') return '+' + digits;
  return null;
}

function formatPretty(input) {
  const e164 = normalizePhone(input);
  if (!e164) return String(input || '');
  const ten = e164.slice(2);
  return '+1 (' + ten.slice(0,3) + ') ' + ten.slice(3,6) + '-' + ten.slice(6);
}

function formatE164Display(input) {
  return normalizePhone(input) || String(input || '');
}

// Legacy aliases
function formatPhone(phone) { return formatPretty(phone); }
function toE164NorthAmerica(input) { return normalizePhone(input) || ''; }

// ── API response helpers ──────────────────────────────────────────
function errorResponse(message) {
  return { success: false, error: message };
}
function successResponse(data = {}) {
  return { success: true, ...data };
}

// ── Business hours ────────────────────────────────────────────────
function isBusinessHours() {
  const tz    = process.env.BUSINESS_TIMEZONE || 'America/Edmonton';
  const start = parseInt(process.env.BUSINESS_HOURS_START) || 9;
  const end   = parseInt(process.env.BUSINESS_HOURS_END)   || 18;
  const now   = new Date();
  const hour  = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  const day   = now.toLocaleString('en-US', { timeZone: tz, weekday: 'long' });
  const isWeekday = !['Saturday','Sunday'].includes(day);
  return isWeekday && hour >= start && hour < end;
}

// ── TwiML safe string ─────────────────────────────────────────────
function twimlSafe(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Owner notification via SMS ────────────────────────────────────
function makeNotifyOwner(twilioClient) {
  return async function notifyOwner(message) {
    const to = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;
    if (!to) {
      console.log('⚠️  FORWARD_PHONE not set — notification skipped');
      return false;
    }
    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to
      });
      console.log('📱 Owner notified:', message.substring(0, 60) + '...');
      return true;
    } catch(e) {
      console.error('❌ Owner notification failed:', e.message);
      return false;
    }
  };
}

// ── Twilio webhook signature validation ────────────────────────
// Middleware that validates inbound Twilio requests are genuine.
// Requires TWILIO_AUTH_TOKEN and BASE_URL env vars.
function makeTwilioWebhookValidator() {
  return function validateTwilioWebhook(req, res, next) {
    // Skip validation in dev/test if explicitly opted out
    if (process.env.SKIP_TWILIO_VALIDATION === 'true') return next();

    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const baseUrl   = process.env.BASE_URL;
    if (!authToken || !baseUrl) {
      console.warn('⚠️ Twilio validation skipped — TWILIO_AUTH_TOKEN or BASE_URL not set');
      return next();
    }

    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
      console.warn('⚠️ Twilio webhook missing x-twilio-signature header');
      return res.status(403).type('text/xml').send('<Response></Response>');
    }

    try {
      const twilio = require('twilio');
      const url = baseUrl + req.originalUrl;
      const isValid = twilio.validateRequest(authToken, signature, url, req.body || {});
      if (!isValid) {
        console.warn('⚠️ Twilio webhook signature INVALID for:', req.originalUrl);
        return res.status(403).type('text/xml').send('<Response></Response>');
      }
      next();
    } catch(e) {
      console.error('❌ Twilio validation error:', e.message);
      // Fail closed — reject if we can't validate
      return res.status(403).type('text/xml').send('<Response></Response>');
    }
  };
}

// ── Error sanitization (L3) ────────────────────────────────────
// Never expose raw DB/system error messages to API clients.
// Always logs the real error server-side; returns generic in production.
function sanitizeError(e) {
  const msg = (e && e.message) ? e.message : String(e);
  if (process.env.NODE_ENV !== 'production') return msg;
  return 'Internal server error';
}


module.exports = {
  normalizePhone,
  formatPretty,
  formatE164Display,
  formatPhone,
  toE164NorthAmerica,
  errorResponse,
  successResponse,
  isBusinessHours,
  twimlSafe,
  makeNotifyOwner,
  makeTwilioWebhookValidator,
  sanitizeError
};

