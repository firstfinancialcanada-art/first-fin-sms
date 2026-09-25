// lib/billing-state.js — the one place that decides what an account may do
//
// This used to live in two places: middleware/billing.js decided whether to
// allow a write, and routes/stripe.js getBillingStatus decided what to tell
// the client. Two copies of the same rules drift, and the client was never
// shown the answer anyway, so a lapsed account just found that buttons
// quietly did nothing. Both now call decide() and get the same verdict.
//
// The states, in the order they are checked:
//
//   suspended  nothing works. Set by an admin, and it outranks everything —
//              including exempt, which used to short-circuit above it and so
//              made an account impossible to switch off.
//   full       active subscription, or a trial with time on it, or exempt.
//              Inside the last week before money is due, `warn` is set so the
//              client can count down to it.
//   readonly   payment failed, lapsed, cancelled, or the trial ran out. They
//              can still read their own data; every write is refused.
//
// The reminder deliberately runs BEFORE the due date, not after a failure.
// A first pass gave a failed card seven more days of full access, which
// rewards the miss instead of preventing it (Franco, 2026-09-25: "the
// reminder is for the lead up to the day the payment is due"). A failed
// payment now locks, and the warning that should have stopped it arrives
// while the card can still be fixed.
'use strict';

// Stripe subscription statuses that mean a payment is not going through.
const PAYMENT_FAILING = ['past_due', 'unpaid', 'incomplete'];

// Start reminding this many days before money is due — trial ending or
// subscription renewing, same window for both.
const WARN_WITHIN_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

function _days(from, to) {
  return Math.max(0, Math.ceil((to - from) / DAY));
}

/**
 * @param user  { email, subscription_status, trial_ends_at, suspended,
 *                current_period_end }
 * @param opts  { exempt:boolean, now?:Date }
 * @returns {{
 *   state:'suspended'|'full'|'readonly',
 *   canWrite:boolean,
 *   reason:string,
 *   kind:'renewal'|'trial_end'|null,  // what the countdown is counting down TO
 *   dueAt:Date|null,                  // when money is next due
 *   daysLeft:number|null,
 *   warn:boolean                      // client should show the countdown
 * }}
 */
function decide(user, opts = {}) {
  const now    = opts.now instanceof Date ? opts.now : new Date();
  const exempt = !!opts.exempt;
  const status = (user && user.subscription_status) || null;

  const out = (state, reason, extra = {}) => ({
    state,
    canWrite: state === 'full',
    reason,
    kind: null,
    dueAt: null,
    daysLeft: null,
    warn: false,
    ...extra,
  });

  // Suspended outranks everything, exempt included.
  if (user && user.suspended) return out('suspended', 'suspended');

  if (exempt) return out('full', 'exempt');

  // A payment is not going through. No cushion — but they were warned in the
  // week before it was taken, which is the point.
  if (PAYMENT_FAILING.includes(status)) return out('readonly', 'payment_failed');

  if (status === 'active') {
    // Renewal reminder. current_period_end comes from Stripe; if we don't
    // have it yet there is simply nothing to count down to.
    const due = user && user.current_period_end ? new Date(user.current_period_end) : null;
    if (due && due > now) {
      const d = _days(now, due);
      if (d <= WARN_WITHIN_DAYS) {
        return out('full', 'active', { kind: 'renewal', dueAt: due, daysLeft: d, warn: true });
      }
      return out('full', 'active', { kind: 'renewal', dueAt: due, daysLeft: d });
    }
    return out('full', 'active');
  }

  // Trial — no status at all counts as a trial, that's the column default.
  if (!status || status === 'trial') {
    const ends = user && user.trial_ends_at ? new Date(user.trial_ends_at) : null;
    if (ends && now < ends) {
      const d = _days(now, ends);
      return out('full', 'trial', {
        kind: 'trial_end', dueAt: ends, daysLeft: d, warn: d <= WARN_WITHIN_DAYS,
      });
    }
    return out('readonly', 'trial_expired');
  }

  // lapsed, cancelled, incomplete_expired, paused, anything unrecognised.
  return out('readonly', status);
}

module.exports = { decide, PAYMENT_FAILING, WARN_WITHIN_DAYS };
