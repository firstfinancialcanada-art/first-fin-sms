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
//   grace      the card failed and Stripe is retrying. Still fully usable on
//              purpose — this is the window where a reminder gets them to fix
//              it — and it counts down to a hard date.
//   readonly   lapsed, cancelled, trial run out, or grace run out. They can
//              still read their own data; every write is refused.
'use strict';

// Stripe subscription statuses that mean "a payment is failing", as opposed
// to "this subscription is over". These get the grace window; the rest don't.
const PAYMENT_FAILING = ['past_due', 'unpaid', 'incomplete'];

// How long a failing payment stays usable. Stripe's own default dunning runs
// about two weeks; this is deliberately shorter than that, so the account
// locks while Stripe is still trying rather than after it has given up.
const GRACE_DAYS = 7;

// Show the countdown banner once the flip is this close.
const WARN_WITHIN_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

function _days(from, to) {
  return Math.max(0, Math.ceil((to - from) / DAY));
}

/**
 * @param user  { email, subscription_status, trial_ends_at, suspended,
 *                billing_grace_until }
 * @param opts  { exempt:boolean, now?:Date }
 * @returns {{
 *   state:'suspended'|'full'|'grace'|'readonly',
 *   canWrite:boolean,
 *   reason:string,
 *   lockAt:Date|null,      // when write access ends; null = not scheduled
 *   daysLeft:number|null,  // whole days until lockAt
 *   warn:boolean,          // client should show the countdown banner
 *   needsGraceStamp:boolean // caller should record when grace began
 * }}
 */
function decide(user, opts = {}) {
  const now    = opts.now instanceof Date ? opts.now : new Date();
  const exempt = !!opts.exempt;
  const status = (user && user.subscription_status) || null;

  const out = (state, reason, extra = {}) => ({
    state,
    canWrite: state === 'full' || state === 'grace',
    reason,
    lockAt: null,
    daysLeft: null,
    warn: false,
    needsGraceStamp: false,
    ...extra,
  });

  // Suspended outranks everything, exempt included.
  if (user && user.suspended) return out('suspended', 'suspended');

  if (exempt) return out('full', 'exempt');

  if (status === 'active') return out('full', 'active');

  // Trial — no status at all counts as a trial, that's the column default.
  if (!status || status === 'trial') {
    const ends = user && user.trial_ends_at ? new Date(user.trial_ends_at) : null;
    if (ends && now < ends) {
      const d = _days(now, ends);
      return out('full', 'trial', { lockAt: ends, daysLeft: d, warn: d <= WARN_WITHIN_DAYS });
    }
    return out('readonly', 'trial_expired');
  }

  // A payment is failing. Usable until the grace date, then readonly.
  if (PAYMENT_FAILING.includes(status)) {
    const until = user && user.billing_grace_until ? new Date(user.billing_grace_until) : null;
    if (!until) {
      // First time we've seen this account failing — start the clock now and
      // tell the caller to write it down, so the window can't restart itself
      // on every request.
      const end = new Date(now.getTime() + GRACE_DAYS * DAY);
      return out('grace', 'payment_failed', {
        lockAt: end, daysLeft: GRACE_DAYS, warn: true, needsGraceStamp: true,
      });
    }
    if (now < until) {
      return out('grace', 'payment_failed', {
        lockAt: until, daysLeft: _days(now, until), warn: true,
      });
    }
    return out('readonly', 'payment_failed');
  }

  // lapsed, cancelled, incomplete_expired, paused, anything unrecognised.
  return out('readonly', status);
}

module.exports = { decide, PAYMENT_FAILING, GRACE_DAYS, WARN_WITHIN_DAYS };
