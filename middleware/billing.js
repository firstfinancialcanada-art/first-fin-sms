// ============================================================
// middleware/billing.js — Subscription enforcement for write routes
// Usage: const { makeBillingGuard } = require('./billing');
//        const requireBilling = makeBillingGuard(pool);
// ============================================================

const { EXEMPT_EMAILS } = require('../lib/constants');

function makeBillingGuard(pool) {
  return async function requireBilling(req, res, next) {
    // requireAuth must run first — req.user must exist
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Exempt accounts always pass
    if (req.user.email && EXEMPT_EMAILS.includes(req.user.email.toLowerCase())) {
      return next();
    }

    try {
      const result = await pool.query(
        'SELECT email, subscription_status, trial_ends_at, suspended FROM desk_users WHERE id = $1',
        [req.user.userId]
      );

      if (!result.rows.length) {
        return res.status(403).json({ success: false, error: 'Account not found', code: 'BILLING_REQUIRED' });
      }

      const user   = result.rows[0];

      // Suspended accounts are fully blocked
      if (user.suspended) {
        return res.status(403).json({ success: false, error: 'Account suspended — contact support', code: 'SUSPENDED' });
      }

      const exempt = EXEMPT_EMAILS.includes((user.email || '').toLowerCase());
      if (exempt) return next();

      const status   = user.subscription_status;
      const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
      const now      = new Date();

      // Active subscription — allow
      if (status === 'active') return next();

      // Valid trial — allow
      if ((!status || status === 'trial') && trialEnd && now < trialEnd) return next();

      // Everything else — readonly, block writes
      const reason = status === 'lapsed' ? 'lapsed'
        : (!status || status === 'trial') ? 'trial_expired'
        : status;

      return res.status(402).json({
        success: false,
        error: 'Subscription required to perform this action',
        code: 'BILLING_REQUIRED',
        reason
      });

    } catch (e) {
      console.error('❌ billing middleware error:', e.message);
      // Fail closed — block access if billing check errors
      return res.status(503).json({ success: false, error: 'Billing check unavailable — please retry' });
    }
  };
}

module.exports = { makeBillingGuard };
