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

// ── Message templates ─────────────────────────────────────────────
// Voice drops, voice campaigns and bulk SMS all let the user write a script
// with placeholders. {name} has always been substituted. {dealer} has NOT —
// it shipped in the default voice-drop script and nothing anywhere replaced
// it, so the literal text "{dealer}" was read out to customers: "Hi Dave,
// this is calling from open brace dealer close brace."
//
// The other half of the problem was the opposite: populateVoiceTemplates
// baked the dealership name into the textarea as plain text, so a store that
// later renamed itself kept announcing the old name forever, with nothing to
// notice — it's an outbound blast nobody re-reads.
//
// One vocabulary, substituted at send time, from the tenant's own settings.
// Aliases are accepted because people guess: {dealer}, {dealership}, {store}.
const TEMPLATE_PLACEHOLDER_HINT = '{name}, {dealership}, {city}';

function fillTemplate(text, { name, dealership, city } = {}) {
  return String(text == null ? '' : text)
    .replace(/\{\s*(?:name|first_?name|customer)\s*\}/gi, name || 'there')
    .replace(/\{\s*(?:dealer|dealership|dealer_?name|store)\s*\}/gi, dealership || 'the dealership')
    // A tenant with no city set would otherwise leave "we are in." mid
    // sentence. Same fallback getJerryResponse already uses for dealerCity,
    // so the two don't disagree about what a blank city sounds like.
    .replace(/\{\s*(?:city|dealer_?city|location)\s*\}/gi, city || 'our location')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

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

module.exports = {
  normalizePhone,
  fillTemplate,
  TEMPLATE_PLACEHOLDER_HINT,
  formatPretty,
  formatE164Display,
  formatPhone,
  toE164NorthAmerica,
  errorResponse,
  successResponse,
  isBusinessHours,
  twimlSafe,
  makeNotifyOwner,
  makeTwilioWebhookValidator
};

