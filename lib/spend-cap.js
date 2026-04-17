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
      CREATE TABLE IF NOT EXISTS tenant_spend_events (
        sid             TEXT PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        kind            TEXT NOT NULL,
        estimated_cents INTEGER NOT NULL,
        actual_cents    INTEGER,
        reconciled_at   TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_spend_events_user
        ON tenant_spend_events(user_id, created_at);
    `);
    console.log('✅ tenant_usage + tenant_spend_events tables ready');
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
  const exempt = await isExempt(userId);
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
    exempt,
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

// ── Record a spend event for later reconciliation ─────────────────────
// Stores the per-send estimate keyed by Twilio SID so a later status
// callback can compute actual-vs-estimate delta and adjust usage.
async function recordSpendEvent(sid, userId, kind, estimatedCents) {
  if (!sid || !userId || !(estimatedCents > 0)) return;
  try {
    await pool.query(
      `INSERT INTO tenant_spend_events (sid, user_id, kind, estimated_cents)
       VALUES ($1, $2, $3, $4) ON CONFLICT (sid) DO NOTHING`,
      [sid, userId, kind, estimatedCents]
    );
  } catch (e) {
    // Table may not exist yet during first boot — swallow.
  }
}

// ── Reconcile estimate against actual cost from Twilio status callback ─
// Idempotent: if already reconciled, no-op. Applies the delta atomically.
async function reconcileSpend(sid, actualCents) {
  if (!sid || !Number.isFinite(actualCents) || actualCents < 0) return;
  try {
    const { rows } = await pool.query(
      `SELECT user_id, kind, estimated_cents, reconciled_at
         FROM tenant_spend_events WHERE sid = $1`,
      [sid]
    );
    if (!rows.length || rows[0].reconciled_at) return;
    const row   = rows[0];
    const delta = actualCents - (row.estimated_cents || 0);
    if (delta !== 0) {
      const field = row.kind === 'sms' ? 'sms_spend_cents' : 'voice_spend_cents';
      await pool.query(
        `UPDATE tenant_usage
            SET ${field} = GREATEST(0, ${field} + $2), last_updated = NOW()
          WHERE user_id = $1`,
        [row.user_id, delta]
      );
    }
    await pool.query(
      `UPDATE tenant_spend_events SET actual_cents = $2, reconciled_at = NOW() WHERE sid = $1`,
      [sid, actualCents]
    );
  } catch (e) {
    console.error('[spend-cap] reconcile error:', e.message);
  }
}

// ── Guarded SMS send — check cap, send via Twilio, record usage + event ─
// Auto-wires the statusCallback URL so Twilio reports final delivery status
// and Price back to /api/sms-status, enabling cost reconciliation.
async function guardedSmsSend(twilioClient, userId, params) {
  const body = params.body || '';
  const cost = estimateSmsCost(body);
  const cap  = await checkSpend(userId, cost);
  if (!cap.ok) {
    return { ok: false, reason: cap.reason, usage: cap.usage, needCents: cap.needCents };
  }
  try {
    const finalParams = { ...params };
    if (process.env.BASE_URL && !finalParams.statusCallback) {
      finalParams.statusCallback = process.env.BASE_URL + '/api/sms-status';
    }
    const msg = await twilioClient.messages.create(finalParams);
    await recordSpend(userId, 'sms', cost);
    if (msg.sid) await recordSpendEvent(msg.sid, userId, 'sms', cost);
    return { ok: true, sid: msg.sid, usage: cap.usage };
  } catch (err) {
    return { ok: false, reason: 'TWILIO_ERROR', error: err };
  }
}

// ── Guarded voice call — same pattern, auto-wires /api/voice-status ────
async function guardedVoiceCall(twilioClient, userId, params, estMinutes = 3) {
  const cost = estimateVoiceCost(estMinutes);
  const cap  = await checkSpend(userId, cost);
  if (!cap.ok) {
    return { ok: false, reason: cap.reason, usage: cap.usage, needCents: cap.needCents };
  }
  try {
    const finalParams = { ...params };
    if (process.env.BASE_URL && !finalParams.statusCallback) {
      finalParams.statusCallback       = process.env.BASE_URL + '/api/voice-status';
      finalParams.statusCallbackMethod = 'POST';
      finalParams.statusCallbackEvent  = ['completed'];
    }
    const call = await twilioClient.calls.create(finalParams);
    await recordSpend(userId, 'voice', cost);
    if (call.sid) await recordSpendEvent(call.sid, userId, 'voice', cost);
    return { ok: true, sid: call.sid, usage: cap.usage };
  } catch (err) {
    return { ok: false, reason: 'TWILIO_ERROR', error: err };
  }
}

module.exports = {
  getUsage,
  checkSpend,
  recordSpend,
  recordSpendEvent,
  reconcileSpend,
  estimateSmsCost,
  estimateVoiceCost,
  checkInventoryCap,
  checkCrmCap,
  addOverage,
  guardedSmsSend,
  guardedVoiceCall,
};
