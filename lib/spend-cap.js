// ============================================================
// lib/spend-cap.js — Per-tenant spend-cap tracking & enforcement
//
// Tracks monthly Twilio SMS/voice spend per user and hard cap at
// TENANT_CAPS.smsVoiceCombinedCents. Cap-exceeded outbound actions
// can draw against tenant_usage.overage_balance_cents (pay-per-use
// top-up purchased via Stripe). Inventory & CRM counts are checked
// against hard row-count limits.
//
// Rollover is lazy — compared on every check, so no cron required.
// ============================================================
'use strict';

const { pool } = require('./db');
const { TENANT_CAPS, TWILIO_COST_ESTIMATE, EXEMPT_EMAILS } = require('./constants');

// Initialize schema on first require (idempotent).
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_usage (
        user_id               INTEGER PRIMARY KEY REFERENCES desk_users(id) ON DELETE CASCADE,
        period_start          DATE NOT NULL DEFAULT CURRENT_DATE,
        sms_spend_cents       INTEGER NOT NULL DEFAULT 0,
        voice_spend_cents     INTEGER NOT NULL DEFAULT 0,
        overage_balance_cents INTEGER NOT NULL DEFAULT 0,
        last_updated          TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ tenant_usage table ready');
  } catch (e) {
    console.error('❌ tenant_usage migration:', e.message);
  }
})();

// ── Exempt checks (skip caps entirely for platform admins / test accounts) ──
async function isExempt(userId) {
  try {
    const { rows } = await pool.query('SELECT email FROM desk_users WHERE id = $1', [userId]);
    if (!rows.length) return false;
    return EXEMPT_EMAILS.includes((rows[0].email || '').toLowerCase());
  } catch { return false; }
}

// ── Usage row: ensure exists + lazy monthly rollover ────────────────────
// Rollover rule: if today's (YYYY-MM) != period_start's (YYYY-MM), reset
// sms_spend_cents and voice_spend_cents to 0, update period_start = today.
// Overage balance persists across periods (it's pre-purchased capacity).
async function ensureUsageRow(userId) {
  await pool.query(
    `INSERT INTO tenant_usage (user_id, period_start)
     VALUES ($1, CURRENT_DATE)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  // Rollover check via SQL (atomic)
  await pool.query(
    `UPDATE tenant_usage
        SET sms_spend_cents   = 0,
            voice_spend_cents = 0,
            period_start      = CURRENT_DATE,
            last_updated      = NOW()
      WHERE user_id = $1
        AND DATE_TRUNC('month', period_start) <> DATE_TRUNC('month', CURRENT_DATE)`,
    [userId]
  );
}

// ── Read full usage snapshot ────────────────────────────────────────────
async function getUsage(userId) {
  await ensureUsageRow(userId);
  const { rows } = await pool.query(
    `SELECT period_start, sms_spend_cents, voice_spend_cents, overage_balance_cents
       FROM tenant_usage WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0] || { sms_spend_cents: 0, voice_spend_cents: 0, overage_balance_cents: 0 };
  const spendCents   = (row.sms_spend_cents || 0) + (row.voice_spend_cents || 0);
  const capCents     = TENANT_CAPS.smsVoiceCombinedCents;
  const pct          = Math.min(100, Math.round((spendCents / capCents) * 100));
  return {
    periodStart:        row.period_start,
    smsSpendCents:      row.sms_spend_cents || 0,
    voiceSpendCents:    row.voice_spend_cents || 0,
    totalSpendCents:    spendCents,
    capCents,
    pct,
    softWarn:           pct >= TENANT_CAPS.softWarnPct && pct < 100,
    capExceeded:        spendCents >= capCents,
    overageBalanceCents: row.overage_balance_cents || 0,
  };
}

// ── Estimate cost helpers ───────────────────────────────────────────────
function estimateSmsCost(messageText) {
  const text = String(messageText || '');
  // GSM-7 single segment = 160 chars, UCS-2 = 70 chars. We're conservative
  // and assume GSM-7; dealers rarely use emoji in outbound.
  const segments = Math.max(1, Math.ceil(text.length / 160));
  return segments * TWILIO_COST_ESTIMATE.smsSegmentCents;
}
function estimateVoiceCost(estimatedMinutes) {
  const m = Math.max(1, Math.ceil(estimatedMinutes || 1));
  return m * TWILIO_COST_ESTIMATE.voiceMinuteCents;
}

// ── Check before an outbound spend action ───────────────────────────────
// Returns { ok, reason, usage } — reason is null when ok=true.
// If cap exceeded but overage_balance_cents covers the estimate, still ok=true.
async function checkSpend(userId, estimatedCents) {
  if (await isExempt(userId)) {
    return { ok: true, reason: null, usage: null, exempt: true };
  }
  const usage = await getUsage(userId);
  const projectedSpend = usage.totalSpendCents + estimatedCents;
  if (projectedSpend <= usage.capCents) {
    return { ok: true, reason: null, usage };
  }
  // Over cap — can we draw from overage balance?
  const overflowNeeded = projectedSpend - usage.capCents;
  if (usage.overageBalanceCents >= overflowNeeded) {
    return { ok: true, reason: 'OVERAGE_USED', usage };
  }
  return {
    ok: false,
    reason: 'SPEND_CAP_EXCEEDED',
    usage,
    needCents: overflowNeeded - usage.overageBalanceCents,
  };
}

// ── Record usage after outbound action (estimated or actual) ────────────
// If over base cap, the overflow draws from overage_balance_cents.
async function recordSpend(userId, kind, cents) {
  if (cents <= 0) return;
  if (await isExempt(userId)) return;
  await ensureUsageRow(userId);
  const field = kind === 'sms' ? 'sms_spend_cents'
              : kind === 'voice' ? 'voice_spend_cents'
              : null;
  if (!field) throw new Error(`Unknown spend kind: ${kind}`);
  // Atomic update: increment spend; if overage needed, drain overage_balance.
  await pool.query(
    `UPDATE tenant_usage
        SET ${field}             = ${field} + $2,
            overage_balance_cents = GREATEST(0, overage_balance_cents
                                              - GREATEST(0, (sms_spend_cents + voice_spend_cents + $2) - $3)),
            last_updated          = NOW()
      WHERE user_id = $1`,
    [userId, cents, TENANT_CAPS.smsVoiceCombinedCents]
  );
}

// ── Row-count caps (inventory, CRM) ─────────────────────────────────────
async function checkInventoryCap(userId) {
  if (await isExempt(userId)) {
    return { ok: true, count: 0, cap: TENANT_CAPS.inventoryMax, exempt: true };
  }
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM desk_inventory WHERE user_id = $1',
    [userId]
  );
  const count = rows[0]?.c || 0;
  const cap = TENANT_CAPS.inventoryMax;
  return {
    ok: count < cap,
    count, cap,
    pct: Math.min(100, Math.round((count / cap) * 100)),
    softWarn: count >= (cap * TENANT_CAPS.softWarnPct / 100) && count < cap,
  };
}

async function checkCrmCap(userId, addingCount = 1) {
  if (await isExempt(userId)) {
    return { ok: true, count: 0, cap: TENANT_CAPS.crmMax, exempt: true };
  }
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM desk_crm WHERE user_id = $1',
    [userId]
  );
  const count = rows[0]?.c || 0;
  const cap = TENANT_CAPS.crmMax;
  return {
    ok: (count + addingCount) <= cap,
    count, cap,
    pct: Math.min(100, Math.round((count / cap) * 100)),
    softWarn: count >= (cap * TENANT_CAPS.softWarnPct / 100) && count < cap,
  };
}

// ── Top-up overage balance (called from Stripe webhook or admin grant) ──
async function addOverage(userId, cents) {
  if (cents <= 0) return;
  await ensureUsageRow(userId);
  await pool.query(
    `UPDATE tenant_usage
        SET overage_balance_cents = overage_balance_cents + $2,
            last_updated          = NOW()
      WHERE user_id = $1`,
    [userId, cents]
  );
}

// ── Guarded SMS send — check cap, send via Twilio, record usage ────────
// Returns { ok: true, sid } on success.
// Returns { ok: false, reason, usage, needCents } if cap blocks.
// Returns { ok: false, reason: 'TWILIO_ERROR', error } if Twilio fails.
// Caller decides how to surface blocked sends (HTTP 402 for UI-initiated,
// silent drop + log for webhook-triggered like SARAH auto-replies).
async function guardedSmsSend(twilioClient, userId, params) {
  const body = params.body || '';
  const cost = estimateSmsCost(body);
  const cap  = await checkSpend(userId, cost);
  if (!cap.ok) {
    return { ok: false, reason: cap.reason, usage: cap.usage, needCents: cap.needCents };
  }
  try {
    const msg = await twilioClient.messages.create(params);
    await recordSpend(userId, 'sms', cost);
    return { ok: true, sid: msg.sid, usage: cap.usage };
  } catch (err) {
    return { ok: false, reason: 'TWILIO_ERROR', error: err };
  }
}

// ── Guarded voice call — same pattern ──────────────────────────────────
async function guardedVoiceCall(twilioClient, userId, params, estMinutes = 3) {
  const cost = estimateVoiceCost(estMinutes);
  const cap  = await checkSpend(userId, cost);
  if (!cap.ok) {
    return { ok: false, reason: cap.reason, usage: cap.usage, needCents: cap.needCents };
  }
  try {
    const call = await twilioClient.calls.create(params);
    await recordSpend(userId, 'voice', cost);
    return { ok: true, sid: call.sid, usage: cap.usage };
  } catch (err) {
    return { ok: false, reason: 'TWILIO_ERROR', error: err };
  }
}

module.exports = {
  getUsage,
  checkSpend,
  recordSpend,
  estimateSmsCost,
  estimateVoiceCost,
  checkInventoryCap,
  checkCrmCap,
  addOverage,
  guardedSmsSend,
  guardedVoiceCall,
};
