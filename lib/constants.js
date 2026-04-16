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

module.exports = { EXEMPT_EMAILS, LENDER_FEES };
