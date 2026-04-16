// platform-math.js — Pure financial math helpers (PMT, PV, BPMT).
//
// Extracted from platform-main.js as part of the monolith split.
// No DOM, no async, no app state mutation. Reads window._payFreq for
// frequency-aware calculations (BPMT, _pmtLabel).
//
// Public surface — all top-level declarations are script-scope globals
// accessible from every later <script> tag:
//   Functions: PMT, PV, BPMT, _pmtLabel
//   Constants: _freqLabels, _freqPeriods

// PMT: standard amortization (public formula, kept client-side for instant payment grid)
function PMT(rate,nper,pv){if(rate===0)return Math.abs(pv/nper);return Math.abs(pv*(rate*Math.pow(1+rate,nper))/(Math.pow(1+rate,nper)-1));}
// PV: kept as fallback only — primary calculation is server-side
function PV(rate,nper,pmt){if(rate===0)return pmt*nper;return pmt*((1-Math.pow(1+rate,-nper))/rate);}

// Payment frequency lookup tables
const _freqLabels = { monthly:'/mo', biweekly:'/bi-wk', semimonthly:'/semi', weekly:'/wk' };
const _freqPeriods = { monthly:12, biweekly:26, semimonthly:24, weekly:52 };

function BPMT(apr, months, fin){
  const ppy = _freqPeriods[window._payFreq] || 12;
  const r = apr/100/ppy;
  const n = Math.round(months * ppy/12);
  return PMT(r, n, fin);
}
function _pmtLabel(){ return _freqLabels[window._payFreq] || '/mo'; }
