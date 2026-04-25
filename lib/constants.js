// ============================================================
// lib/constants.js — Shared constants across the platform
// ============================================================

// Accounts that bypass billing and are always active
const EXEMPT_EMAILS = process.env.EXEMPT_EMAILS
  ? process.env.EXEMPT_EMAILS.split(',').map(e => e.trim().toLowerCase())
  : ['kevlarkarz@gmail.com', 'fintest@fintest.com'];

// Default lender fees (added to ATF before LTV calc). Tenant custom rates
// may override per-tier via lender_rate_sheets.lender_fee. Single source
// of truth — consumed by routes/compare.js and routes/lenders.js.
const LENDER_FEES = {
  autocapital: 895,
  cibc:        0,
  edenpark:    695,
  iceberg:     695,
  northlake:   695,
  prefera:     695,
  rbc:         0,
  santander:   595,
  sda:         995,
  servus:      0,
  wsleasing:   0,
  iauto:       699,
};

// Per-tenant monthly spend caps. Hitting 100% triggers a hard lock on
// outbound SMS/voice and new inventory/CRM additions; overage can be
// pre-purchased via Stripe top-up to tenant_usage.overage_balance_cents.
// EXEMPT_EMAILS bypass these caps (treated as unlimited).
//
// CURRENCY MODEL:
//   - We charge subscribers in CAD via Stripe
//   - Twilio bills us in USD from a separate USD float account
//   - The cap below (1850 cents = $18.50) is denominated in CAD — that's
//     the per-tenant messaging allowance customers internally "spend"
//     against (though customers never see the dollar number, just a meter)
//   - Per-message rates in TWILIO_COST_ESTIMATE are intentionally inflated
//     so a tenant burns their CAD allowance BEFORE the real USD Twilio
//     invoice catches up — the spread is our buffer + profit
//
// SUBSCRIPTION ECONOMICS PER TIER (Apr 2026):
//
//   Solo tier ($225 CAD/mo, single user):
//     Gross subscription:                    $225 CAD
//     Less $18.50 CAD messaging allowance:   -$18.50
//     Less Stripe fee (2.9% + $0.30):        -$7
//     = Cash to us before messaging margin:  ~$200 CAD/mo
//     + Margin on actual messaging usage     +$5-10 CAD (typical)
//     + Margin on top-up purchases           varies
//
//   Gold tier ($525 CAD/mo, up to 10 seats):
//     Gross subscription:                    $525 CAD
//     Less $18.50 CAD messaging allowance:   -$18.50
//     Less Stripe fee (2.9% + $0.30):        -$15
//     = Cash to us before messaging margin:  ~$492 CAD/mo
//     + Margin on actual messaging usage     +$5-10 CAD (typical)
//     + Margin on top-up purchases           varies
//
// Both tiers share the SAME $18.50 CAD allowance because messaging cost
// is per-tenant-volume, not per-seat. Gold tier's higher revenue covers
// more seats + multi-user admin overhead, NOT more messaging capacity.
//
// At 5  active Gold tenants = ~$2,500 CAD/mo recurring (~$30K  CAD/yr)
// At 50 active Gold tenants = ~$25K   CAD/mo recurring (~$300K CAD/yr)
//
// Inventory + CRM caps sized for franchise-scale dealers (Hunt Chrysler
// has ~247 vehicles, big Chrysler/Stellantis lots can exceed 500). Bumped
// from 500 -> 1000 in Phase 6 to handle Gold-tier full inventory imports
// (new + used + certified pre-owned in one tenant).
const TENANT_CAPS = {
  smsVoiceCombinedCents: 1850, // $18.50 CAD allowance per tenant per month (both tiers)
  inventoryMax:          1000, // max vehicles per tenant (Gold-tier sized)
  crmMax:                1000, // max CRM contacts per tenant (Gold-tier sized)
  softWarnPct:           80,   // emit warning at 80% of cap (UI banner)
};

// Per-message rates that debit the tenant's CAD allowance (1850 cents
// = $18.50 CAD) as messages flow through. Each value is in CAD cents.
//
// INFLATION STRATEGY:
// These rates are INTENTIONALLY HIGHER than the real Twilio cost in
// USD. Two reasons:
//
//   1. The customer's allowance is denominated in CAD, but Twilio bills
//      us in USD. By inflating the per-message rates, the customer hits
//      their CAD cap BEFORE we accumulate enough real Twilio spend to
//      eat into the $18.50 CAD we allocated from their subscription.
//      The gap = our buffer to cover the actual USD Twilio invoice.
//
//   2. Hidden costs we absorb that aren't on Twilio's per-message bill:
//      - Anthropic LLM cost for Sarah's reasoning (~$0.005-$0.02/turn)
//      - A2P 10DLC ongoing brand/campaign fees (amortized)
//      - FX fluctuation when CAD weakens against USD
//      - Failed-message retry charges, carrier passthrough surcharges
//      - Stripe fee on any top-up the customer buys later
//
// Whatever's left after covering the real USD bill + hidden costs falls
// to profit. Most months a tenant doesn't hit their cap at all → that
// $18.50 CAD allocation is largely retained as margin.
//
// Reference (USD, real Twilio costs Apr 2026):
//   - Outbound SMS:  $0.011-$0.013/seg actual.   Charge 3¢ CAD → buffer.
//   - Outbound voice: $0.014-$0.022/min actual.  Charge 3¢ CAD → buffer.
//   - Inbound SMS:   $0.0085/seg actual.         Charge 2¢ CAD → buffer.
//
// Per-tenant FIXED costs paid out of subscription margin, NOT this cap:
//   - Twilio number rent: $1.15-2.15 USD/mo per number
//   - Postgres storage: trivial (~$0.0015/tenant/mo at 1000 vehicles)
//   - Other infra: negligible per-tenant
const TWILIO_COST_ESTIMATE = {
  smsSegmentCents:         3, // CAD cents debited per outbound SMS segment
  voiceMinuteCents:        3, // CAD cents debited per voice minute
  incomingSmsSegmentCents: 2, // CAD cents debited per inbound SMS segment
};

module.exports = { EXEMPT_EMAILS, LENDER_FEES, TENANT_CAPS, TWILIO_COST_ESTIMATE };
