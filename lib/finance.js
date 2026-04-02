// lib/finance.js — Proprietary financial calculations (SERVER-SIDE ONLY)
// All deal math lives here. Client never sees these formulas.
'use strict';

// ── Standard amortization payment ────────────────────────────────────────
// PMT = PV × [r(1+r)^n] / [(1+r)^n - 1]
function PMT(rate, nper, pv) {
  if (rate === 0) return Math.abs(pv / nper);
  return Math.abs(pv * (rate * Math.pow(1 + rate, nper)) / (Math.pow(1 + rate, nper) - 1));
}

// ── Present value (reverse: how much can you borrow at this payment?) ────
function PV(rate, nper, pmt) {
  if (rate === 0) return Math.abs(pmt * nper);
  return Math.abs(pmt * (1 - Math.pow(1 + rate, -nper)) / rate);
}

// ── Bi-weekly or monthly payment ─────────────────────────────────────────
function BPMT(apr, months, fin, biweekly) {
  if (biweekly) {
    const r = apr / 100 / 26;
    const n = Math.round(months * 26 / 12);
    return PMT(r, n, fin);
  }
  return PMT(apr / 100 / 12, months, fin);
}

// ── Full deal calculation ────────────────────────────────────────────────
// Takes raw deal inputs, returns all computed fields.
// This is the single source of truth for all financial math.
function calculateDeal(params) {
  const p = params || {};

  // ── Inputs with defaults ───────────────────────────────────────────────
  const price       = parseFloat(p.price)       || 0;
  const doc         = parseFloat(p.doc)         || 0;
  const gst         = parseFloat(p.gst)         || 5;   // Alberta default
  const tradeAllow  = parseFloat(p.tradeAllow)  || 0;
  const tradePayoff = parseFloat(p.tradePayoff) || 0;
  const down        = parseFloat(p.down)        || 0;
  const apr         = parseFloat(p.apr)         || 0;
  const term        = parseInt(p.term)          || 72;
  const biweekly    = !!p.biweekly;

  const income      = parseFloat(p.income)          || 0;
  const existing    = parseFloat(p.existingPayments) || 0;
  const ptiLimit    = parseFloat(p.ptiLimit)         || 20;

  const bookValue   = parseFloat(p.bookValue)    || 0;
  const contractRate= parseFloat(p.contractRate) || 0;
  const buyRate     = parseFloat(p.buyRate)      || 0;
  const bankSplit   = parseFloat(p.bankSplit)    || 75;
  const beacon      = parseInt(p.beacon)         || 0;

  const vscPrice = parseFloat(p.vscPrice) || 0;
  const vscCost  = parseFloat(p.vscCost)  || 0;
  const gapPrice = parseFloat(p.gapPrice) || 0;
  const gapCost  = parseFloat(p.gapCost)  || 0;
  const twPrice  = parseFloat(p.twPrice)  || 0;
  const twCost   = parseFloat(p.twCost)   || 0;
  const waPrice  = parseFloat(p.waPrice)  || 0;
  const waCost   = parseFloat(p.waCost)   || 0;

  const acv      = parseFloat(p.acv)      || 0;
  const recon    = parseFloat(p.recon)    || 0;
  const lotPack  = parseFloat(p.lotPack)  || 0;
  const condAdj  = parseFloat(p.condAdj)  || 0;
  const safety   = parseFloat(p.safety)   || 0;

  // ── OTD (Out-The-Door) ─────────────────────────────────────────────────
  const netTrade = tradeAllow - tradePayoff;
  const taxableBase = price + doc - netTrade;
  const gstAmount = taxableBase * (gst / 100);
  const otd = taxableBase + gstAmount;
  const financed = Math.max(0, otd - down);

  // ── Payment ────────────────────────────────────────────────────────────
  const payment = financed > 0 ? BPMT(apr, term, financed, biweekly) : 0;
  const periods = biweekly ? Math.round(term * 26 / 12) : term;

  // ── LTV (Loan-to-Value) ────────────────────────────────────────────────
  const ltv = bookValue > 0 ? round2((financed / bookValue) * 100) : 0;

  // ── PTI / DTI (TDSR) ──────────────────────────────────────────────────
  // Monthly payment for ratio calculation (even if display is bi-weekly)
  const monthlyPmt = financed > 0 ? BPMT(apr, term, financed, false) : 0;
  const pti = income > 0 ? round2((monthlyPmt / income) * 100) : 0;
  const dti = income > 0 ? round2(((monthlyPmt + existing) / income) * 100) : 0;
  const ptiPass = pti <= ptiLimit;
  const dtiPass = dti <= 44;

  // ── Risk Assessment ────────────────────────────────────────────────────
  let riskLevel, reserveStatus;
  if (beacon >= 750)      { riskLevel = 'LOW';      reserveStatus = 'SECURE'; }
  else if (beacon >= 700) { riskLevel = 'MODERATE';  reserveStatus = 'WATCH'; }
  else if (beacon >= 650) { riskLevel = 'ELEVATED';  reserveStatus = 'AT RISK'; }
  else                    { riskLevel = 'HIGH';      reserveStatus = 'CHARGEBACKS'; }

  // ── Reserve (FIXED: uses ATF not price, applies 0.82 lender factor) ───
  const rateSpread = Math.max(0, contractRate - buyRate);
  // Canadian standard: dealer gets ~82% of spread reserve, lender retains 18%
  const spreadReserve = rateSpread > 0
    ? Math.round((rateSpread / 100 / 12) * financed * term * (bankSplit / 100))
    : 0;

  // ── Profit ─────────────────────────────────────────────────────────────
  const totalCost = acv + recon + lotPack;
  const frontGross = price - totalCost;
  const vscGross = vscPrice - vscCost;
  const gapGross = gapPrice - gapCost;
  const twGross  = twPrice  - twCost;
  const waGross  = waPrice  - waCost;
  const totalGross = frontGross + vscGross + gapGross + twGross + waGross + spreadReserve;
  const fePercent = totalGross > 0 ? round2((frontGross / totalGross) * 100) : 0;
  const bePercent = totalGross > 0 ? round2(((totalGross - frontGross) / totalGross) * 100) : 0;

  // ── Trade ──────────────────────────────────────────────────────────────
  const totalReconCost = safety + recon + condAdj;
  const adjustedAcv = acv - totalReconCost;
  const tradeEquity = tradeAllow - tradePayoff;

  // ── F&I Payment Impact ─────────────────────────────────────────────────
  const basePmt = payment;
  const fiPayments = {
    base:           round2(basePmt),
    withGap:        round2(basePmt + gapPrice / periods),
    withGapVsc:     round2(basePmt + gapPrice / periods + vscPrice / periods),
    withAll:        round2(basePmt + gapPrice / periods + vscPrice / periods + twPrice / periods),
    fullProtection: round2(basePmt + gapPrice / periods + vscPrice / periods + twPrice / periods + waPrice / periods),
    vscImpact:      round2(vscPrice / periods),
    gapImpact:      round2(gapPrice / periods),
    twImpact:       round2(twPrice / periods),
    waImpact:       round2(waPrice / periods),
  };

  return {
    // OTD
    otd: round2(otd), gstAmount: round2(gstAmount), financed: round2(financed),
    netTrade: round2(netTrade), taxableBase: round2(taxableBase),
    // Payment
    payment: round2(payment), periods,
    // Ratios
    ltv, pti, dti, ptiPass, dtiPass,
    // Risk
    riskLevel, reserveStatus, beacon,
    // Reserve
    rateSpread: round2(rateSpread), spreadReserve,
    // Profit
    frontGross: Math.round(frontGross), vscGross: Math.round(vscGross),
    gapGross: Math.round(gapGross), twGross: Math.round(twGross),
    waGross: Math.round(waGross), totalGross: Math.round(totalGross),
    fePercent, bePercent,
    // Trade
    tradeEquity: round2(tradeEquity), adjustedAcv: round2(adjustedAcv),
    totalReconCost: round2(totalReconCost),
    // F&I
    fiPayments,
  };
}

// ── Quick calc (simple payment from amount/rate/term) ────────────────────
function quickCalc(amount, apr, term) {
  return round2(PMT(apr / 100 / 12, term, amount));
}

// ── Reverse calc (max loan from payment/rate/term) ───────────────────────
function reverseCalc(payment, apr, term) {
  return round2(PV(apr / 100 / 12, term, payment));
}

// ── Margin calc ──────────────────────────────────────────────────────────
function calcMargin(cost, sell) {
  const profit = sell - cost;
  const pct = sell > 0 ? round2((profit / sell) * 100) : 0;
  return { profit: Math.round(profit), percent: pct };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { PMT, PV, BPMT, calculateDeal, quickCalc, reverseCalc, calcMargin };
