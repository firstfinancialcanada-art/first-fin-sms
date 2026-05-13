// lib/lead-silence-canary.js
//
// Tenant lead-silence detector. Catches the failure mode "a dealer's
// aggregators stopped delivering but nobody noticed for days" — the
// kind of bug that costs Mil real money and gets us a refund request
// and a churned account.
//
// Design intent (per Franco's directive — keep alerts cheap):
//   - Alert ONLY when a tenant who normally gets leads has gone silent.
//   - Never page on the baseline ("Mil hasn't gotten a lead today" only
//     fires if Mil HISTORICALLY gets leads on a typical day).
//   - One SMS per silent tenant per run. The cron schedules the run; we
//     don't loop or re-alert from inside the library.
//
// Inputs (all optional, sane defaults):
//   lookbackDays:    integer — how far back to compute the historical
//                    median daily lead count (default 30).
//   silenceHours:    integer — how many hours of zero leads counts as
//                    "silent right now" (default 24). The historical
//                    window excludes this trailing slice so the median
//                    isn't dragged toward zero on a slow day.
//   minHistoricalMedian: number — only alert if median ≥ this. Default 1
//                    (i.e., a tenant who averaged < 1 lead/day is too
//                    quiet to draw a conclusion from). Bump to 2 or 3
//                    for noisier tenants.
//   onlyActive:      boolean — restrict to tenants whose owner has an
//                    active subscription. Default true (don't page on
//                    canceled tenants).
//
// Returns: array of per-tenant rows with { tenantId, dealership, tier,
// historicalMedian, recentCount, isSilent, reason }. Caller decides what
// to do with isSilent=true (SMS, email, log, etc).
//
// Idempotent: pure read. No writes to DB. Safe to call from a cron job,
// from an admin endpoint, or from a one-shot script.

'use strict';

const { pool } = require('./db');

const DEFAULTS = {
  lookbackDays:        30,
  silenceHours:        24,
  minHistoricalMedian: 1,
  onlyActive:          true,
};

// Tiny median helper — sorted-array, no dependency.
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function checkTenantSilence(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { lookbackDays, silenceHours, minHistoricalMedian, onlyActive } = cfg;

  // Pull the tenants we care about. Owner subscription_status drives the
  // active filter — we don't want to spam Franco about a tenant that
  // canceled (and whose aggregators are intentionally turned off).
  const tenantRows = await pool.query(`
    SELECT t.id, t.dealership, t.tier, t.lead_intake_email, t.owner_user_id,
           u.email AS owner_email, u.subscription_status, u.notify_phone,
           u.suspended
      FROM desk_tenants t
      JOIN desk_users   u ON u.id = t.owner_user_id
     WHERE t.dealership IS NOT NULL
       ${onlyActive ? `AND u.subscription_status IN ('active','trialing','trial')
                       AND u.suspended IS NOT TRUE` : ''}
     ORDER BY t.id
  `);

  const results = [];
  for (const t of tenantRows.rows) {
    // Historical window: lookbackDays back to silenceHours ago.
    // Excludes the current silence window so a 24h dry-spell doesn't
    // pull the median to 0 and silence itself out of paging.
    const histRes = await pool.query(`
      SELECT DATE_TRUNC('day', processed_at) AS day, COUNT(*)::int AS n
        FROM lead_intake_log
       WHERE tenant_id = $1
         AND status = 'ok'
         AND processed_at > NOW() - ($2::int || ' days')::interval
         AND processed_at < NOW() - ($3::int || ' hours')::interval
       GROUP BY 1
    `, [t.id, lookbackDays, silenceHours]);

    // Pad with zero-days so the median reflects "typical" not just
    // "days when leads came in". A tenant who gets leads M-W-F but no
    // Sat/Sun should still alert if M-W-F goes dark.
    const dailyCounts = histRes.rows.map(r => r.n);
    const daysInWindow = lookbackDays - Math.ceil(silenceHours / 24);
    const zeroDaysPad  = Math.max(0, daysInWindow - dailyCounts.length);
    const paddedCounts = [...dailyCounts, ...Array(zeroDaysPad).fill(0)];
    const historicalMedian = median(paddedCounts);

    // Recent window: last silenceHours.
    const recRes = await pool.query(`
      SELECT COUNT(*)::int AS n
        FROM lead_intake_log
       WHERE tenant_id = $1
         AND status = 'ok'
         AND processed_at > NOW() - ($2::int || ' hours')::interval
    `, [t.id, silenceHours]);
    const recentCount = recRes.rows[0]?.n || 0;

    const isSilent = historicalMedian >= minHistoricalMedian && recentCount === 0;
    let reason = '';
    if (!isSilent) {
      if (recentCount > 0)                             reason = 'has recent leads';
      else if (historicalMedian < minHistoricalMedian) reason = 'baseline too low to alert';
      else                                             reason = 'ok';
    } else {
      reason = `median ${historicalMedian.toFixed(1)} leads/day vs 0 in last ${silenceHours}h`;
    }

    results.push({
      tenantId:          t.id,
      dealership:        t.dealership,
      tier:              t.tier,
      ownerEmail:        t.owner_email,
      ownerNotifyPhone:  t.notify_phone,
      historicalMedian,
      recentCount,
      isSilent,
      reason,
    });
  }

  return { config: cfg, tenants: results };
}

// Convenience: just the silent ones, sorted by historical median (loudest
// silences first — those are the ones costing real money).
async function getSilentTenants(opts = {}) {
  const all = await checkTenantSilence(opts);
  return {
    config: all.config,
    silentTenants: all.tenants
      .filter(t => t.isSilent)
      .sort((a, b) => b.historicalMedian - a.historicalMedian),
  };
}

module.exports = {
  checkTenantSilence,
  getSilentTenants,
};
