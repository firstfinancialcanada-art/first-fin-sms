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
// The $225/mo subscription budget covers ~$18.50 of Twilio per tenant.
// Inventory + CRM caps sized for franchise-scale dealers (Hunt Chrysler
// has ~247 vehicles, big Chrysler/Stellantis lots can exceed 500). Bumped
// from 500 -> 1000 in Phase 6 to handle Gold-tier full inventory imports
// (new + used + certified pre-owned in one tenant).
// TODO v1.4: split into per-tier caps (single=500, gold=1000, enterprise=2500)
// once we have multiple gold customers stressing the limit.
const TENANT_CAPS = {
  smsVoiceCombinedCents: 1850, // $18.50/mo Twilio budget inside the $225 sub
  inventoryMax:          1000, // max vehicles per tenant (Gold-tier sized)
  crmMax:                1000, // max CRM contacts per tenant (Gold-tier sized)
  softWarnPct:           80,   // emit warning at 80% of cap (UI banner)
};

// Conservative Twilio cost estimates (rounded up to integer cents).
// Actual Twilio price from status callbacks will reconcile over time.
// Canadian outbound rates approx Apr 2026: SMS $0.0079, voice $0.013/min.
const TWILIO_COST_ESTIMATE = {
  smsSegmentCents:         1, // ~$0.0079 outbound, ceil to 1¢
  voiceMinuteCents:        2, // ~$0.013 outbound, ceil to 2¢
  incomingSmsSegmentCents: 1, // inbound roughly $0.0079
};

module.exports = { EXEMPT_EMAILS, LENDER_FEES, TENANT_CAPS, TWILIO_COST_ESTIMATE };
