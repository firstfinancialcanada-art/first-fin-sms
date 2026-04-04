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

// ── Multi-frequency payment calculator ──────────────────────────────────
// frequency: 'monthly' | 'biweekly' | 'semimonthly' | 'weekly'
const FREQ_CONFIG = {
  monthly:     { periodsPerYear: 12 },
  biweekly:    { periodsPerYear: 26 },
  semimonthly: { periodsPerYear: 24 },
  weekly:      { periodsPerYear: 52 },
};

function BPMT(apr, months, fin, freqOrBiweekly) {
  // Backwards compatible: boolean true = biweekly
  let freq = 'monthly';
  if (freqOrBiweekly === true) freq = 'biweekly';
  else if (typeof freqOrBiweekly === 'string' && FREQ_CONFIG[freqOrBiweekly]) freq = freqOrBiweekly;

  const { periodsPerYear } = FREQ_CONFIG[freq];
  const r = apr / 100 / periodsPerYear;
  const n = Math.round(months * periodsPerYear / 12);
  return PMT(r, n, fin);
}

function getPaymentPeriods(months, freq) {
  const f = FREQ_CONFIG[freq] || FREQ_CONFIG.monthly;
  return Math.round(months * f.periodsPerYear / 12);
}

// ── Full deal calculation ────────────────────────────────────────────────
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
  const frequency   = (p.frequency && FREQ_CONFIG[p.frequency]) ? p.frequency : (p.biweekly ? 'biweekly' : 'monthly');

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

  // ── Trade Equity / Negative Equity Rollover ────────────────────────────
  const tradeEquity = tradeAllow - tradePayoff;  // positive = equity, negative = underwater
  const rolledNegativeEquity = Math.max(0, tradePayoff - tradeAllow); // amount rolled into new loan

  // ── OTD (Out-The-Door) ─────────────────────────────────────────────────
  const netTrade = tradeAllow - tradePayoff;
  const taxableBase = Math.max(0, price + doc - Math.max(0, netTrade)); // can't deduct negative equity from tax base
  const gstAmount = taxableBase * (gst / 100);
  const otd = price + doc + gstAmount - Math.max(0, netTrade); // net trade reduces OTD only if positive equity
  const baseFinanced = Math.max(0, otd - down);
  const financed = baseFinanced + rolledNegativeEquity; // negative equity adds to loan

  // ── Payment (selected frequency) ───────────────────────────────────────
  const payment = financed > 0 ? BPMT(apr, term, financed, frequency) : 0;
  const periods = getPaymentPeriods(term, frequency);
  const totalInterest = financed > 0 ? round2((payment * periods) - financed) : 0;

  // ── All-frequency payment comparison ──────────────────────────────────
  const paymentGrid = {};
  for (const [freq, cfg] of Object.entries(FREQ_CONFIG)) {
    const pmt = financed > 0 ? BPMT(apr, term, financed, freq) : 0;
    const per = getPaymentPeriods(term, freq);
    paymentGrid[freq] = {
      payment: round2(pmt),
      periods: per,
      totalCost: round2(pmt * per),
      totalInterest: round2((pmt * per) - financed),
    };
  }

  // ── LTV (Loan-to-Value) — both clean and effective ─────────────────────
  const cleanLtv = bookValue > 0 ? round2((baseFinanced / bookValue) * 100) : 0;
  const effectiveLtv = bookValue > 0 ? round2((financed / bookValue) * 100) : 0;
  const ltv = effectiveLtv; // effective LTV is the real number lenders care about

  // ── PTI / DTI (TDSR) ──────────────────────────────────────────────────
  // Always use monthly payment for ratio calculation (lender standard)
  const monthlyPmt = financed > 0 ? BPMT(apr, term, financed, 'monthly') : 0;
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

  // ── Reserve (spread × ATF × term × dealer share) ──────────────────────
  const rateSpread = Math.max(0, contractRate - buyRate);
  const spreadReserve = rateSpread > 0
    ? Math.round((rateSpread / 100 / 12) * financed * term * (bankSplit / 100))
    : 0;

  // ── Per-Product Profit Breakdown ──────────────────────────────────────
  const totalCost = acv + recon + lotPack;
  const vehicleMargin = price - totalCost;

  const frontEnd = {
    vehicleMargin: Math.round(vehicleMargin),
    docFee: Math.round(doc),
    totalFront: Math.round(vehicleMargin + doc),
  };

  const productGross = (pr, co) => {
    const gross = pr - co;
    return { price: round2(pr), cost: round2(co), gross: Math.round(gross), marginPct: pr > 0 ? round2((gross / pr) * 100) : 0 };
  };

  const backEnd = {
    vsc: productGross(vscPrice, vscCost),
    gap: productGross(gapPrice, gapCost),
    tw:  productGross(twPrice, twCost),
    wa:  productGross(waPrice, waCost),
    reserve: { spread: round2(rateSpread), amount: spreadReserve },
    totalBack: Math.round((vscPrice - vscCost) + (gapPrice - gapCost) + (twPrice - twCost) + (waPrice - waCost) + spreadReserve),
  };

  const totalGross = frontEnd.totalFront + backEnd.totalBack;
  const costToMarket = price > 0 ? round2((totalCost / price) * 100) : 0;

  // Deal grade: A ($3k+), B ($2-3k), C ($1-2k), D (<$1k)
  let dealGrade;
  if (totalGross >= 3000) dealGrade = 'A';
  else if (totalGross >= 2000) dealGrade = 'B';
  else if (totalGross >= 1000) dealGrade = 'C';
  else dealGrade = 'D';

  const dealTotal = {
    totalGross: Math.round(totalGross),
    grossPerUnit: Math.round(totalGross), // PVR
    frontPct: totalGross > 0 ? round2((frontEnd.totalFront / totalGross) * 100) : 0,
    backPct: totalGross > 0 ? round2((backEnd.totalBack / totalGross) * 100) : 0,
    costToMarket,
    dealGrade,
  };

  // Legacy flat fields (backwards compatible)
  const frontGross = vehicleMargin;
  const vscGross = vscPrice - vscCost;
  const gapGross = gapPrice - gapCost;
  const twGross  = twPrice  - twCost;
  const waGross  = waPrice  - waCost;
  const fePercent = totalGross > 0 ? round2((frontGross / totalGross) * 100) : 0;
  const bePercent = totalGross > 0 ? round2(((totalGross - frontGross) / totalGross) * 100) : 0;

  // ── Trade Analysis ─────────────────────────────────────────────────────
  const totalReconCost = safety + recon + condAdj;
  const adjustedAcv = acv - totalReconCost;

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
    // Negative equity
    tradeEquity: round2(tradeEquity), rolledNegativeEquity: round2(rolledNegativeEquity),
    baseFinanced: round2(baseFinanced),
    // Payment
    payment: round2(payment), periods, frequency, totalInterest,
    paymentGrid,
    // LTV (clean vs effective)
    ltv, cleanLtv, effectiveLtv,
    // Ratios
    pti, dti, ptiPass, dtiPass,
    // Risk
    riskLevel, reserveStatus, beacon,
    // Reserve
    rateSpread: round2(rateSpread), spreadReserve,
    // Structured profit breakdown
    frontEnd, backEnd, dealTotal,
    // Legacy flat fields (backwards compatible)
    frontGross: Math.round(frontGross), vscGross: Math.round(vscGross),
    gapGross: Math.round(gapGross), twGross: Math.round(twGross),
    waGross: Math.round(waGross), totalGross: Math.round(totalGross),
    fePercent, bePercent,
    // Trade
    adjustedAcv: round2(adjustedAcv), totalReconCost: round2(totalReconCost),
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

module.exports = { PMT, PV, BPMT, calculateDeal, quickCalc, reverseCalc, calcMargin, FREQ_CONFIG };
