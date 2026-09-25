// ============================================================
// middleware/billing.js — Subscription enforcement for write routes
// Usage: const { makeBillingGuard } = require('./billing');
//        const requireBilling = makeBillingGuard(pool);
//
// The rules live in lib/billing-state.js, shared with /api/billing/status so
// that what the client is told and what the server enforces cannot drift.
// ============================================================

const { EXEMPT_EMAILS } = require('../lib/constants');
const { decide } = require('../lib/billing-state');

function makeBillingGuard(pool) {
  return async function requireBilling(req, res, next) {
    // requireAuth must run first — req.user must exist
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Exemption is applied inside decide(), AFTER the suspend check. It used
    // to short-circuit here on the email in the JWT, which meant an exempt
    // account could not be suspended or cancelled by any means — this guard
    // returned before it ever read the row. Exempt means "don't charge them",
    // never "can't be shut off".
    try {
      const result = await pool.query(
        `SELECT email, subscription_status, trial_ends_at, suspended, billing_grace_until
           FROM desk_users WHERE id = $1`,
        [req.user.userId]
      );

      if (!result.rows.length) {
        return res.status(403).json({ success: false, error: 'Account not found', code: 'BILLING_REQUIRED' });
      }

      const user   = result.rows[0];
      const exempt = EXEMPT_EMAILS.includes((user.email || '').toLowerCase());
      const v      = decide(user, { exempt });

      // First request after a payment started failing: record when the grace
      // window began, or it would restart on every request and never expire.
      if (v.needsGraceStamp && v.lockAt) {
        pool.query(
          'UPDATE desk_users SET billing_grace_until = $1 WHERE id = $2 AND billing_grace_until IS NULL',
          [v.lockAt, req.user.userId]
        ).catch(e => console.warn('⚠️ grace stamp failed:', e.message));
      }

      if (v.state === 'suspended') {
        return res.status(403).json({
          success: false, error: 'Account suspended — contact support', code: 'SUSPENDED',
        });
      }

      if (v.canWrite) return next();

      return res.status(402).json({
        success: false,
        error: 'Subscription required to perform this action',
        code: 'BILLING_REQUIRED',
        reason: v.reason,
      });

    } catch (e) {
      console.error('❌ billing middleware error:', e.message);
      // Fail closed — block access if billing check errors
      return res.status(503).json({ success: false, error: 'Billing check unavailable — please retry' });
    }
  };
}

module.exports = { makeBillingGuard };
