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
// CURRENCY: All Twilio numbers below are USD (Twilio bills in USD even
// though we charge subscribers in CAD). Conversion at typical FX rate
// 1 USD = 1.35 CAD (Apr 2026): $18.50 USD ≈ $25 CAD of Twilio cost.
// The $225 CAD/mo subscription gives us ~$167 CAD ($124 USD) of revenue
// after Stripe fees + margin allocation; $18.50 USD goes to Twilio
// budget, the rest covers infra + LLM + margin.
//
// Inventory + CRM caps sized for franchise-scale dealers (Hunt Chrysler
// has ~247 vehicles, big Chrysler/Stellantis lots can exceed 500). Bumped
// from 500 -> 1000 in Phase 6 to handle Gold-tier full inventory imports
// (new + used + certified pre-owned in one tenant).
// TODO v1.4: split into per-tier caps (single=500, gold=1000, enterprise=2500)
// once we have multiple gold customers stressing the limit.
const TENANT_CAPS = {
  smsVoiceCombinedCents: 1850, // $18.50 USD/mo Twilio budget (~$25 CAD at 1.35 FX)
  inventoryMax:          1000, // max vehicles per tenant (Gold-tier sized)
  crmMax:                1000, // max CRM contacts per tenant (Gold-tier sized)
  softWarnPct:           80,   // emit warning at 80% of cap (UI banner)
};

// Twilio cost estimates in USD cents — used to debit the per-tenant
// budget BEFORE Twilio's status-callback reconciles the actual amount.
//
// MARGIN-PROTECTION STRATEGY: every estimate is INTENTIONALLY INFLATED
// above the highest real-world Twilio rate. The buffer covers ALL of
// our per-tenant hidden costs, not just Twilio surprises. Specifically:
//
//   1. Twilio carrier-passthrough surcharges (10DLC, FtEU, mobile fees)
//      that fluctuate month-to-month with no advance notice
//   2. Failed-message fees ($0.001 each) and retry attempts on dropped
//      delivery — these can stack up on bad numbers
//   3. A2P 10DLC ongoing brand/campaign fees billed monthly to our
//      Twilio account (amortized across the subscriber base)
//   4. Anthropic LLM cost for Sarah's reasoning on each message
//      (~$0.005-$0.02 per Sarah turn, depending on context size)
//   5. FX fluctuation — we charge CAD, pay USD; CAD weakening even 5%
//      eats into margin if we don't pre-buffer
//   6. Stripe processing fees on top-up purchases (2.9% + 30¢ per
//      transaction — small but real)
//
// 2026 industry pricing data (USD, real Twilio costs):
//   - Outbound SMS:  base $0.0083 + carrier passthrough $0.003-$0.005
//                    = $0.011-$0.013 per segment ACTUAL
//                    Charge 3¢ → 130-170% buffer (also covers MMS spillover)
//   - Outbound voice: $0.014/min local, $0.022/min toll-free
//                    Charge 3¢ → 36-115% buffer (matches toll-free worst case)
//   - Inbound SMS:   $0.0083/segment + carrier passthrough
//                    Charge 2¢ → 60-140% buffer (inbound charges less reliably)
//
// At cap (1850 cents = $18.50 USD displayed), real all-in cost for
// that tenant including LLM + Twilio + amortized fixed costs typically
// runs $10-14 USD — leaves $4.50-8.50 USD margin per tenant per month
// over and above the cap, even on the heaviest-usage tenants.
//
// Per-tenant FIXED costs we absorb (not part of the cap, paid from
// our subscription margin not the messaging budget):
//   - Twilio number rent: $1.15/mo local, $2.15/mo toll-free
//   - A2P 10DLC brand/campaign fee: shared, amortized to ~$0.30/tenant/mo
//   - Postgres storage: ~$0.0015/tenant/mo at 1000 vehicles + 25 photos
//   - Total fixed: ~$1.50-2.50 USD per tenant per month
const TWILIO_COST_ESTIMATE = {
  smsSegmentCents:         3, // real $0.011-$0.013 + LLM + buffer for hidden costs
  voiceMinuteCents:        3, // real $0.014-$0.022 + buffer for toll-free + hidden
  incomingSmsSegmentCents: 2, // real $0.0085 + carrier fee + LLM + buffer
};

module.exports = { EXEMPT_EMAILS, LENDER_FEES, TENANT_CAPS, TWILIO_COST_ESTIMATE };
