// ============================================================
// middleware/spend-cap.js — Per-tenant capacity / spend guards
// Usage:
//   const { makeCapacityGuard, makeSmsGuard, makeVoiceGuard } = require('./spend-cap');
//   app.post('/api/desk/inventory', requireAuth, requireBilling,
//            makeCapacityGuard('inventory'), handler);
//
// All guards fail open on DB errors — we don't want a monitoring outage
// to break the platform. The hard enforcement is at lib/spend-cap.js
// helpers called inside handlers for the dynamic cases (SARAH replies,
// bulk processor loops, etc.).
// ============================================================
'use strict';

const {
  checkSpend, checkInventoryCap, checkCrmCap,
  estimateSmsCost, estimateVoiceCost,
} = require('../lib/spend-cap');

// ── 402 response shapes (consistent so client can route to modal) ───────
function respondSpendExceeded(res, usage, needCents, kind) {
  return res.status(402).json({
    success: false,
    code:    'SPEND_CAP_EXCEEDED',
    kind,
    error:   `Monthly Twilio spend cap reached. Top up overage balance to continue sending.`,
    usage,
    needCents,
  });
}
function respondCapacityExceeded(res, kind, count, cap) {
  return res.status(402).json({
    success: false,
    code:    'CAPACITY_EXCEEDED',
    kind,
    error:   `${kind} limit reached (${count}/${cap}). Upgrade tier or remove items.`,
    count, cap,
  });
}

// ── Inventory / CRM row-count guard ─────────────────────────────────────
// `kind` is 'inventory' or 'crm'. For CRM bulk imports, the guard checks
// count + incoming size (req.body.contacts.length) to reject the whole
// batch up front rather than halfway through.
function makeCapacityGuard(kind) {
  return async function capacityGuard(req, res, next) {
    if (!req.user?.userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    try {
      let check;
      if (kind === 'inventory') {
        check = await checkInventoryCap(req.user.userId);
      } else if (kind === 'crm') {
        const adding = Array.isArray(req.body?.contacts) ? req.body.contacts.length : 1;
        check = await checkCrmCap(req.user.userId, adding);
      } else {
        return next();
      }
      if (!check.ok) {
        return respondCapacityExceeded(res, kind, check.count, check.cap);
      }
      req.capacityCheck = check;
      next();
    } catch (e) {
      console.error(`[spend-cap] ${kind} guard error:`, e.message);
      next(); // fail-open — never block legit traffic on monitoring failure
    }
  };
}

// ── SMS guard for endpoints where message text is in req.body ──────────
// Accepts a custom extractor for non-standard body shapes.
function makeSmsGuard(getMessage) {
  const extractor = getMessage || (req => req.body?.message || req.body?.body || '');
  return async function smsGuard(req, res, next) {
    if (!req.user?.userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    try {
      const text = extractor(req);
      const cost = estimateSmsCost(text);
      const r = await checkSpend(req.user.userId, cost);
      if (!r.ok) return respondSpendExceeded(res, r.usage, r.needCents, 'sms');
      req.spendCheck = r;
      next();
    } catch (e) {
      console.error('[spend-cap] SMS guard error:', e.message);
      next();
    }
  };
}

// ── Voice guard (estimate default 3 min per call) ──────────────────────
function makeVoiceGuard(estimatedMinutes = 3) {
  return async function voiceGuard(req, res, next) {
    if (!req.user?.userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    try {
      const cost = estimateVoiceCost(estimatedMinutes);
      const r = await checkSpend(req.user.userId, cost);
      if (!r.ok) return respondSpendExceeded(res, r.usage, r.needCents, 'voice');
      req.spendCheck = r;
      next();
    } catch (e) {
      console.error('[spend-cap] voice guard error:', e.message);
      next();
    }
  };
}

module.exports = { makeCapacityGuard, makeSmsGuard, makeVoiceGuard, respondSpendExceeded, respondCapacityExceeded };
