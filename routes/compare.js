// routes/compare.js
// ═══════════════════════════════════════════════════════════════════════════
// FIRST-FIN COMPARE ALL ENGINE — SERVER-SIDE
// All lender criteria, approval logic, and tier matching live here only.
// The client receives results (pass/fail, payments, tips) — never the rules.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function compareRoutes(app, { requireAuth }) {
  const { pool } = require('../lib/db');

  // ── Standard financial math ─────────────────────────────────────────────
  function PMT(rate, nper, pv) {
    if (rate === 0) return Math.abs(pv / nper);
    return Math.abs(pv * (rate * Math.pow(1 + rate, nper)) / (Math.pow(1 + rate, nper) - 1));
  }
  function BPMT(apr, months, fin, biweekly) {
    if (biweekly) {
      const r = apr / 100 / 26;
      const n = Math.round(months * 26 / 12);
      return PMT(r, n, fin);
    }
    return PMT(apr / 100 / 12, months, fin);
  }

  // ── Proprietary lender data ─────────────────────────────────────────────
  const lenders = {
  autocapital:{name:"AUTOCAPITAL CANADA",phone:"855-646-0534",web:"autocapitalcanada.ca",minYear:2015,maxMileage:195000,maxCarfax:7500,maxLTV:175,hard:true,maxPti:20,maxDti:44,minIncome:1800,maxPayment:null,
    programs:[
      {tier:"Tier 1 — Prime",rate:"13.49%",fico:"680+",minYear:2025,maxMile:"Unlimited",maxCfx:"$0",maxLtv:"175%"},
      {tier:"Tier 2 — Standard",rate:"14.49%",fico:"620–679",minYear:2024,maxMile:"Unlimited",maxCfx:"$2,500",maxLtv:"175%"},
      {tier:"Tier 3 — Good",rate:"15.99%",fico:"590–619",minYear:2023,maxMile:"195,000",maxCfx:"$5,000",maxLtv:"165%"},
      {tier:"Tier 4 — Fair",rate:"17.99%",fico:"560–589",minYear:2022,maxMile:"195,000",maxCfx:"$5,000",maxLtv:"165%"},
      {tier:"Tier 5 — Poor",rate:"21.49%",fico:"540–559",minYear:2020,maxMile:"195,000",maxCfx:"$7,500",maxLtv:"150%"},
      {tier:"Tier 6 — Subprime",rate:"23.49%",fico:"<540",minYear:2015,maxMile:"195,000",maxCfx:"$7,500",maxLtv:"150%"}
    ]},
  cibc:{name:"CIBC AUTO FINANCE",phone:"1-855-598-1856",web:"cibc.com/auto",minYear:2015,maxMileage:null,maxCarfax:null,maxLTV:96,hard:false,maxPti:null,maxDti:null,minIncome:null,maxPayment:null,
    programs:[
      {tier:"Chequing Acct Program",rate:"6.36%",fico:"N/A",minYear:2019,maxMile:"Credit-based",maxCfx:"Credit-based",maxLtv:"96%"},
      {tier:"2023–2026 Vehicles",rate:"7.29%–9.49%",fico:"Various",minYear:2023,maxMile:"Credit-based",maxCfx:"Credit-based",maxLtv:"96%"},
      {tier:"2018–2022 Vehicles",rate:"7.29%–9.49%",fico:"Various",minYear:2018,maxMile:"Credit-based",maxCfx:"Credit-based",maxLtv:"84%"},
      {tier:"Newcomers Program",rate:"Varies",fico:"No history",minYear:2015,maxMile:"Credit-based",maxCfx:"Credit-based",maxLtv:"96%"}
    ]},
  edenpark:{name:"EDENPARK",phone:"1-855-366-8667",web:"edenparkfinancial.ca",minYear:2015,maxMileage:180000,maxCarfax:7500,maxLTV:140,hard:true,maxPti:20,maxDti:44,minIncome:1800,maxPayment:null,
    programs:[
      {tier:"Tier A",rate:"11.99%",fico:"640+",minYear:2020,maxMile:"180,000",maxCfx:"$5,000",maxLtv:"140%"},
      {tier:"Tier B",rate:"15.99%",fico:"600–639",minYear:2017,maxMile:"180,000",maxCfx:"$7,500",maxLtv:"135%"},
      {tier:"Tier C",rate:"19.99%",fico:"560–599",minYear:2016,maxMile:"180,000",maxCfx:"$7,500",maxLtv:"130%"},
      {tier:"Tier D",rate:"23.99%",fico:"<560",minYear:2015,maxMile:"170,000",maxCfx:"$7,500",maxLtv:"125%"}
    ]},
  iceberg:{name:"ICEBERG FINANCE",phone:"855-694.0960",web:"icebergfinance.ca",minYear:2012,maxMileage:180000,maxCarfax:6500,maxLTV:140,hard:true,maxPti:17,maxDti:44,minIncome:1750,maxPayment:825,
    programs:[
      {tier:"Tier 1",rate:"12.99%",fico:"640+",minYear:2018,maxMile:"150,000",maxCfx:"$3,000",maxLtv:"140%"},
      {tier:"Tier 2",rate:"17.99%",fico:"600–639",minYear:2015,maxMile:"170,000",maxCfx:"$5,000",maxLtv:"135%"},
      {tier:"Tier 3",rate:"22.99%",fico:"560–599",minYear:2013,maxMile:"180,000",maxCfx:"$6,500",maxLtv:"130%"},
      {tier:"Tier 4",rate:"31.99%",fico:"<560",minYear:2012,maxMile:"180,000",maxCfx:"$6,500",maxLtv:"125%"}
    ]},
  northlake:{name:"NORTHLAKE FINANCIAL",phone:"1-888-652-5320",web:"northlakefinancial.ca",minYear:2003,maxMileage:300000,maxCarfax:7500,maxLTV:140,hard:true,maxPti:17,maxDti:44,minIncome:1800,maxPayment:930,
    programs:[
      {tier:"Standard",rate:"10.99%–16.99%",fico:"No min",minYear:2015,maxMile:"200,000",maxCfx:"$5,000",maxLtv:"140%"},
      {tier:"Extended",rate:"17.99%–22.99%",fico:"No min",minYear:2003,maxMile:"300,000",maxCfx:"$7,500",maxLtv:"130%"}
    ]},
  prefera:{name:"PREFERA FINANCE",phone:"1-844-734-3577",web:"preferafinance.ca",minYear:2015,maxMileage:200000,maxCarfax:5000,maxLTV:170,hard:true,maxPti:20,maxDti:44,minIncome:1800,maxPayment:null,
    programs:[
      {tier:"Tier A",rate:"16.95%",fico:"620+",minYear:2018,maxMile:"150,000",maxCfx:"$2,500",maxLtv:"170%"},
      {tier:"Tier B",rate:"21.95%",fico:"580–619",minYear:2016,maxMile:"175,000",maxCfx:"$3,500",maxLtv:"160%"},
      {tier:"Tier C",rate:"25.95%",fico:"550–579",minYear:2015,maxMile:"200,000",maxCfx:"$5,000",maxLtv:"150%"},
      {tier:"Tier D",rate:"30.95%",fico:"<550",minYear:2015,maxMile:"200,000",maxCfx:"$5,000",maxLtv:"140%"}
    ]},
  rbc:{name:"RBC AUTO FINANCE",phone:"1-888-529-6999",web:"rbcautofinance.ca",minYear:2015,maxMileage:null,maxCarfax:null,maxLTV:96,hard:false,maxPti:null,maxDti:null,minIncome:null,maxPayment:null,
    programs:[
      {tier:"Prime Program",rate:"5.79%–7.99%",fico:"720+",minYear:2019,maxMile:"Credit-based",maxCfx:"Credit-based",maxLtv:"96%"},
      {tier:"Standard Program",rate:"7.99%–9.99%",fico:"650–719",minYear:2015,maxMile:"Credit-based",maxCfx:"Credit-based",maxLtv:"90%"}
    ]},
  santander:{name:"SANTANDER CONSUMER",phone:"1-888-222-4227",web:"santanderconsumerusa.com",minYear:2015,maxMileage:160000,maxCarfax:6000,maxLTV:150,hard:true,maxPti:20,maxDti:44,minIncome:1800,maxPayment:null,
    programs:[
      {tier:"Tier 1",rate:"9.99%–14.99%",fico:"650+",minYear:2018,maxMile:"120,000",maxCfx:"$3,000",maxLtv:"150%"},
      {tier:"Tier 2",rate:"15.99%–21.99%",fico:"600–649",minYear:2016,maxMile:"140,000",maxCfx:"$4,500",maxLtv:"140%"},
      {tier:"Tier 3",rate:"22.99%–29.99%",fico:"<600",minYear:2015,maxMile:"160,000",maxCfx:"$6,000",maxLtv:"130%"}
    ]},
  sda:{name:"SDA FINANCE",phone:"1-800-731-2345",web:"sdafinance.ca",minYear:2012,maxMileage:250000,maxCarfax:8000,maxLTV:135,hard:true,maxPti:20,maxDti:44,minIncome:1800,maxPayment:null,
    programs:[
      {tier:"Standard",rate:"15.99%–24.99%",fico:"No min",minYear:2012,maxMile:"250,000",maxCfx:"$8,000",maxLtv:"135%"}
    ]},
  servus:{name:"SERVUS CREDIT UNION",phone:"1-877-378-8728",web:"servus.ca",minYear:2015,maxMileage:180000,maxCarfax:5000,maxLTV:100,hard:true,maxPti:null,maxDti:null,minIncome:null,maxPayment:null,
    programs:[
      {tier:"Prime",rate:"6.50%–8.99%",fico:"700+",minYear:2018,maxMile:"150,000",maxCfx:"$3,000",maxLtv:"100%"},
      {tier:"Near Prime",rate:"9.99%–14.99%",fico:"640–699",minYear:2015,maxMile:"180,000",maxCfx:"$5,000",maxLtv:"95%"}
    ]},
  iauto:{name:"iA AUTO FINANCE",phone:"1-855-378-5626",web:"ia.ca",minYear:2015,maxMileage:180000,maxCarfax:7500,maxLTV:140,hard:true,maxPti:20,maxDti:44,minIncome:1800,maxPayment:1000,
    programs:[
      {tier:'6th Gear',fico:'700+',   rate:'11.49', maxLtv:140, minYear:2015},
      {tier:'5th Gear',fico:'650-699',rate:'15.49', maxLtv:140, minYear:2015},
      {tier:'4th Gear',fico:'600-649',rate:'20.49', maxLtv:135, minYear:2015},
      {tier:'3rd Gear',fico:'560-599',rate:'25.49', maxLtv:125, minYear:2015},
      {tier:'2nd Gear',fico:'520-559',rate:'29.99', maxLtv:125, minYear:2015},
      {tier:'1st Gear',fico:'<520',   rate:'29.99', maxLtv:110, minYear:2015},
    ]},
  wsleasing:{name:"WS LEASING",phone:"1-888-975-3273",web:"wsleasing.ca",minYear:2018,maxMileage:120000,maxCarfax:3000,maxLTV:100,hard:true,maxPti:null,maxDti:null,minIncome:null,maxPayment:null,
    programs:[
      {tier:"Lease Program A",rate:"7.99%–11.99%",fico:"680+",minYear:2020,maxMile:"100,000",maxCfx:"$2,000",maxLtv:"100%"},
      {tier:"Lease Program B",rate:"12.99%–16.99%",fico:"640–679",minYear:2018,maxMile:"120,000",maxCfx:"$3,000",maxLtv:"95%"}
    ]}
};


  const LENDER_FEES = {
  autocapital: 895,
  cibc: 0,
  edenpark: 695,
  iceberg: 695,
  northlake: 695,
  prefera: 695,
  rbc: 0,
  santander: 595,
  sda: 995,
  servus: 0,
  wsleasing: 0,
  iauto: 699
};


  // ── Proprietary tier-matching logic ────────────────────────────────────
  function getQualifyingProgram(lid, beacon){
  const defaultFee = LENDER_FEES[lid] || 0;
  
  // Try tenant custom rates first
  if(tenantRates && tenantRates[lid] && tenantRates[lid].length){
    const rows = tenantRates[lid]
      .filter(r => beacon === 0 || (beacon >= (r.min_fico||0) && beacon <= (r.max_fico||9999)))
      .sort((a,b) => parseFloat(a.buy_rate) - parseFloat(b.buy_rate));
    if(rows.length){
      const r = rows[0];
      return {
        tier: r.tier_name, rate: parseFloat(r.buy_rate),
        minFico: r.min_fico||0, maxLTV: r.max_ltv||140,
        minYear: r.min_year||2015, maxMileage: r.max_mileage||200000,
        maxCarfax: r.max_carfax||9999, fee: parseFloat(r.lender_fee) || defaultFee,
        isCustom: true
      };
    }
  }
  // Fall back to hardcoded programs[]
  const l = lenders[lid];
  if(!l) return null;
  if(beacon === 0){
    const prog = l.programs[l.programs.length-1]; // show lowest tier as estimate
    return { tier: prog.tier, rate: parseFloat(prog.rate), isEstimate: true,
             minFico: 0, maxLTV: l.maxLTV, minYear: l.minYear,
             maxMileage: l.maxMileage||999999, maxCarfax: l.maxCarfax||999999, fee: defaultFee };
  }
  // Match beacon against program FICO strings like "680+", "620–679", "<540"
  for(const prog of l.programs){
    const ficoStr = prog.fico || '';
    if(ficoStr === 'N/A' || ficoStr === 'No min' || /credit.based/i.test(ficoStr)){
      return { tier: prog.tier, rate: parseFloat(prog.rate)||0, minFico: 0,
               maxLTV: parseInt(prog.maxLtv)||l.maxLTV, minYear: parseInt(prog.minYear)||l.minYear,
               maxMileage: l.maxMileage||999999, maxCarfax: l.maxCarfax||999999, fee: defaultFee };
    }
    const plusM = ficoStr.match(/^(\d+)\+$/);
    if(plusM && beacon >= parseInt(plusM[1])){
      return { tier: prog.tier, rate: parseFloat(prog.rate), minFico: parseInt(plusM[1]),
               maxLTV: parseInt(prog.maxLtv)||l.maxLTV, minYear: parseInt(prog.minYear)||l.minYear,
               maxMileage: l.maxMileage||999999, maxCarfax: l.maxCarfax||999999, fee: defaultFee };
    }
    const rangeM = ficoStr.match(/^(\d+)[–\-](\d+)$/);
    if(rangeM && beacon >= parseInt(rangeM[1]) && beacon <= parseInt(rangeM[2])){
      return { tier: prog.tier, rate: parseFloat(prog.rate), minFico: parseInt(rangeM[1]),
               maxLTV: parseInt(prog.maxLtv)||l.maxLTV, minYear: parseInt(prog.minYear)||l.minYear,
               maxMileage: l.maxMileage||999999, maxCarfax: l.maxCarfax||999999, fee: defaultFee };
    }
    const ltM = ficoStr.match(/^<(\d+)$/);
    if(ltM && beacon < parseInt(ltM[1])){
      return { tier: prog.tier, rate: parseFloat(prog.rate), minFico: 0,
               maxLTV: parseInt(prog.maxLtv)||l.maxLTV, minYear: parseInt(prog.minYear)||l.minYear,
               maxMileage: l.maxMileage||999999, maxCarfax: l.maxCarfax||999999, fee: defaultFee };
    }
    // Range with rate range like "9.99%–14.99%" — use lower end
    if(ficoStr && /\d{3}/.test(ficoStr)){
      const rateNum = parseFloat(prog.rate);
      if(!isNaN(rateNum) && beacon > 0){
        return { tier: prog.tier, rate: rateNum, minFico: 0,
                 maxLTV: parseInt(prog.maxLtv)||l.maxLTV, minYear: parseInt(prog.minYear)||l.minYear,
                 maxMileage: l.maxMileage||999999, maxCarfax: l.maxCarfax||999999, fee: defaultFee };
      }
    }
  }
  // Credit-based lenders (hard:false — CIBC, RBC, etc.) don't use FICO tiers.
  // They underwrite on full credit profile outside the platform.
  // Return a synthetic pass so Compare All shows them; LTV/income gates filter.
  const lenderObj = lenders[lid];
  if (lenderObj && !lenderObj.hard) {
    const firstRate = lenderObj.programs?.length
      ? parseFloat(String(lenderObj.programs[0].rate).split('–')[0].replace('%','')) || 7.99
      : 7.99;
    return {
      tier: 'Credit Profile',
      rate: isNaN(firstRate) ? 7.99 : firstRate,
      maxLTV: lenderObj.maxLTV || 96,
      minYear: lenderObj.minYear || 2015,
      maxMileage: lenderObj.maxMileage || 999999,
      maxCarfax: lenderObj.maxCarfax || 999999,
      fee: 0,
      isCreditBased: true,
    };
  }

  return null;
}


  // ── Proprietary approval engine ─────────────────────────────────────────
  // evaluateLender refactored to take all deal params explicitly
  function evaluateLender(lid, l, prog, params) {
    const {
      combinedIncome, primaryIncome, coIncome, hasCoApp, existing,
      v, curYear, term, bookValOver, condOverride, contractRate,
      gstRate, hasBK, fees, down, trade, biweekly
    } = params;

    const income     = combinedIncome;
    const lenderFee  = prog ? (prog.fee || 0) : 0;
    const taxableBase = v.price + fees - trade;
    const gstAmt     = taxableBase * (gstRate / 100);
    const atf        = taxableBase + gstAmt + lenderFee - down;
    const bookVal    = bookValOver > 0 ? bookValOver : (v.book_value || v.bookValue || v.price);
    const maxLTV     = prog ? prog.maxLTV : l.maxLTV;
    const ltvPct     = (atf / bookVal) * 100;
    const ltvOk      = ltvPct <= maxLTV;
    const maxLoan    = (bookVal * maxLTV) / 100;
    const downNeeded = ltvOk ? 0 : Math.ceil(atf - maxLoan);

    const lMaxPti    = l.maxPti    || 20;
    const lMaxDti    = l.maxDti    || 44;
    const lMinIncome = l.minIncome || 0;
    const lMaxPay    = l.maxPayment || null;

    const minYear    = prog ? (prog.minYear    || l.minYear)    : l.minYear;
    const rawMaxMile = prog ? (prog.maxMileage || l.maxMileage  || 999999) : (l.maxMileage || 999999);
    const maxCfx     = prog ? (prog.maxCarfax  || l.maxCarfax   || 999999) : (l.maxCarfax  || 999999);
    const cond       = ((condOverride || v.condition || 'Average')).toLowerCase();
    const condMult   = (cond === 'rough' || cond === 'very rough') ? 0.90 : 1.0;
    const maxMile    = Math.floor(rawMaxMile * condMult);

    const yearOk     = v.year >= minYear;
    const mileOk     = (v.mileage || 0) <= maxMile;
    const cfxOk      = (v.carfax  || 0) <= maxCfx;
    const incomeOk   = lMinIncome === 0 || income === 0 || income >= lMinIncome;

    const ALL_TERMS   = [48, 60, 72, 84];
    const buyRate     = prog && prog.rate > 0 ? prog.rate : 8.99;
    const termResults = {};

    ALL_TERMS.forEach(t => {
      const ageAtPayoff = (curYear - v.year) + (t / 12);
      const ageOkT      = ageAtPayoff <= 14;
      const pmt         = atf > 0 ? BPMT(buyRate, t, atf, biweekly) : 0;
      let ptiOkT = true, dtiOkT = true, payOkT = true;
      let ptiPctT = 0, dtiPctT = 0;
      if (income > 0 && pmt > 0) {
        ptiPctT = (pmt / income) * 100;
        dtiPctT = ((pmt + existing) / income) * 100;
        ptiOkT  = ptiPctT <= lMaxPti;
        dtiOkT  = dtiPctT <= lMaxDti;
        payOkT  = lMaxPay === null || pmt <= lMaxPay;
      }
      const passes = ageOkT && ltvOk && incomeOk &&
                     (income === 0 || (ptiOkT && dtiOkT && payOkT));
      termResults[t] = { term: t, payment: pmt, ageAtPayoff, ageOk: ageOkT,
                         ptiOk: ptiOkT, dtiOk: dtiOkT, payOk: payOkT,
                         ptiPct: ptiPctT, dtiPct: dtiPctT, passes };
    });

    const passingTerms = ALL_TERMS.filter(t => termResults[t].passes);
    const bestTerm     = passingTerms.length ? passingTerms[0]                          : term;
    const optimalTerm  = passingTerms.length ? passingTerms[passingTerms.length - 1]    : term;
    const selResult    = termResults[term] || termResults[72];
    const payment      = selResult.payment;
    const ptiPct       = selResult.ptiPct;
    const dtiPct       = selResult.dtiPct;
    const ptiOk        = selResult.ptiOk;
    const dtiOk        = selResult.dtiOk;
    const payOk        = selResult.payOk;
    const ageOk        = selResult.ageOk;
    const vehicleAgeAtPayoff = selResult.ageAtPayoff;

    let spreadReserve = 0, totalGross = 0;
    const flatReserve = prog ? (prog.fee || lenderFee || 0) : lenderFee;
    totalGross = flatReserve;
    if (contractRate > 0 && contractRate > buyRate) {
      const spread = contractRate - buyRate;
      spreadReserve = Math.round((spread / 100 / 12) * atf * optimalTerm * 0.82);
      totalGross    = flatReserve + spreadReserve;
    }

    const structureTips = [];
    if (!ltvOk && downNeeded > 0) {
      const fixedPmt = BPMT(buyRate, optimalTerm, atf - downNeeded, biweekly);
      structureTips.push(`Add $${downNeeded.toLocaleString()} down → LTV passes (${fixedPmt.toFixed(2)}/mo at ${optimalTerm}mo)`);
    }
    if (income > 0 && !ptiOk) {
      if (termResults[84] && termResults[84].ptiOk && ltvOk) {
        structureTips.push(`Extend to 84mo → PTI drops to ${termResults[84].ptiPct.toFixed(1)}% (${termResults[84].payment.toFixed(2)}/mo) ✓`);
      } else if (ltvOk) {
        const targetPmt = income * lMaxPti / 100;
        const mr = buyRate / 100 / 12;
        const maxAtfForPti = mr > 0 ? targetPmt * (Math.pow(1+mr, optimalTerm) - 1) / (mr * Math.pow(1+mr, optimalTerm)) : targetPmt * optimalTerm;
        const downForPti = Math.ceil(atf - maxAtfForPti);
        if (downForPti > 0) structureTips.push(`Add $${downForPti.toLocaleString()} down → PTI within ${lMaxPti}% at ${optimalTerm}mo`);
      }
    }
    if (income > 0 && lMaxPay && !payOk) {
      if (termResults[84] && termResults[84].payOk && ltvOk) {
        structureTips.push(`Extend to 84mo → payment $${termResults[84].payment.toFixed(2)}/mo within pay call ✓`);
      } else if (ltvOk) {
        const mr = buyRate / 100 / 12;
        const maxAtfForPay = mr > 0 ? lMaxPay * (Math.pow(1+mr, optimalTerm) - 1) / (mr * Math.pow(1+mr, optimalTerm)) : lMaxPay * optimalTerm;
        const downForPay = Math.ceil(atf - maxAtfForPay);
        if (downForPay > 0) structureTips.push(`Add $${downForPay.toLocaleString()} down → payment within $${lMaxPay}/mo pay call`);
      }
    }
    if (income > 0 && !dtiOk && ltvOk) {
      const targetDtiPmt = (income * lMaxDti / 100) - existing;
      if (targetDtiPmt > 0) {
        const mr = buyRate / 100 / 12;
        const maxAtfForDti = mr > 0 ? targetDtiPmt * (Math.pow(1+mr, optimalTerm) - 1) / (mr * Math.pow(1+mr, optimalTerm)) : targetDtiPmt * optimalTerm;
        const downForDti = Math.ceil(atf - maxAtfForDti);
        if (downForDti > 0) structureTips.push(`Add $${downForDti.toLocaleString()} down → TDSR within ${lMaxDti}%`);
      }
    }
    if (!incomeOk && lMinIncome > 0 && income > 0) {
      structureTips.push(`Income $${income.toLocaleString()} below min $${lMinIncome.toLocaleString()} — co-applicant could bridge gap`);
    }

    let coAppTip = null;
    if (hasCoApp && primaryIncome > 0 && !ptiOk) {
      const primaryPti = payment > 0 ? (payment / primaryIncome) * 100 : 0;
      if (primaryPti > lMaxPti && ptiPct <= lMaxPti) {
        coAppTip = `Co-app income required — primary PTI ${primaryPti.toFixed(1)}% exceeds ${lMaxPti}%, combined ${ptiPct.toFixed(1)}% ✓`;
      }
    }

    return {
      lid, prog, atf, ltvPct, maxLTV, ltvOk, maxLoan, bookVal, downNeeded,
      yearOk, mileOk, cfxOk, ageOk, minYear, maxMile, maxCfx,
      payment, ptiPct, dtiPct, ptiOk, dtiOk, payOk, incomeOk,
      lMaxPti, lMaxDti, lMinIncome, lMaxPay,
      term, bestTerm, optimalTerm, termResults, passingTerms,
      flatReserve, spreadReserve, totalGross, contractRate, buyRate,
      beacon: params.beacon, income, primaryIncome, coIncome, hasCoApp, existing,
      lenderFee, hasBK, vehicleAgeAtPayoff, cond,
      structureTip: structureTips[0] || null,
      allStructureTips: structureTips, coAppTip,
      // Display info (client needs these to render cards)
      lName: l.name, lPhone: l.phone, lWeb: l.web, lHard: l.hard
    };
  }

  // ── GET lender display info for panels ──────────────────────────────────
  // Returns only name/phone/web/display fields — no criteria
  app.get('/api/lenders/display', requireAuth, (req, res) => {
    const display = {};
    Object.entries(lenders).forEach(([lid, l]) => {
      display[lid] = {
        name: l.name, phone: l.phone, web: l.web, hard: l.hard,
        minYear: l.minYear, maxMileage: l.maxMileage, maxCarfax: l.maxCarfax, maxLTV: l.maxLTV
      };
    });
    res.json(display);
  });

  // ── POST /api/compare-all ───────────────────────────────────────────────
  app.post('/api/compare-all', requireAuth, async (req, res) => {
    try {
      const uid = req.user.userId;
      const {
        stock, down = 0, trade = 0, fees = 0, beacon = 0,
        income = 0, term = 72, existing = 0, bookVal = 0,
        coBeacon = 0, coIncome = 0, hasBK = false,
        gstEnabled = false, gstRate: gstRateIn = 5, contractRate = 0,
        condOverride = '', biweekly = false
      } = req.body;

      if (!stock) return res.status(400).json({ success: false, error: 'Stock required' });

      // Fetch vehicle from DB (tenant-scoped)
      const client = await pool.connect();
      let v, tenantRates = {};
      try {
        const vRes = await client.query(
          `SELECT year, make, model, mileage, price, type, condition, stock, carfax,
                  book_value, vin FROM desk_inventory WHERE stock = $1 AND user_id = $2`,
          [stock, uid]
        );
        if (!vRes.rows.length) return res.status(404).json({ success: false, error: 'Vehicle not found' });
        v = vRes.rows[0];

        // Fetch tenant custom rates
        const ratesRes = await client.query(
          `SELECT lender_id, tier_name, min_fico, max_fico, buy_rate, max_ltv,
                  min_year, max_mileage, max_carfax, lender_fee
           FROM lender_rate_sheets WHERE user_id = $1`, [uid]
        );
        ratesRes.rows.forEach(r => {
          if (!tenantRates[r.lender_id]) tenantRates[r.lender_id] = [];
          tenantRates[r.lender_id].push(r);
        });
      } finally { client.release(); }

      const curYear         = new Date().getFullYear();
      const gstRate         = gstEnabled ? (parseFloat(gstRateIn) || 5) : 0;
      const combinedIncome  = income + coIncome;
      const primaryIncome   = income;
      const hasCoApp        = coIncome > 0 || coBeacon > 0;

      const params = {
        combinedIncome, primaryIncome, coIncome, hasCoApp, existing: parseFloat(existing)||0,
        v, curYear, term: parseInt(term)||72, bookValOver: parseFloat(bookVal)||0,
        condOverride, contractRate: parseFloat(contractRate)||0,
        gstRate, hasBK, fees: parseFloat(fees)||0,
        down: parseFloat(down)||0, trade: parseFloat(trade)||0,
        beacon: parseInt(beacon)||0, biweekly: !!biweekly
      };

      const eligible = [], ineligible = [];

      Object.entries(lenders).forEach(([lid, l]) => {
        if (req.body.hiddenLenders && req.body.hiddenLenders.includes(lid)) return;
        const prog = getQualifyingProgram(lid, params.beacon, tenantRates);
        const r    = evaluateLender(lid, l, prog, params);

        const vehiclePass = r.yearOk && r.mileOk && r.cfxOk && r.ageOk;
        const dealPass    = r.ltvOk && r.ptiOk && r.dtiOk && r.payOk && r.incomeOk;
        const beaconPass  = !params.beacon || prog !== null;
        r.type        = l.hard ? 'hard' : 'credit';
        r.vehiclePass = vehiclePass;
        r.dealPass    = dealPass;
        r.beaconPass  = beaconPass;
        r.approved    = l.hard
          ? vehiclePass && beaconPass && (income === 0 || dealPass) && r.ltvOk
          : beaconPass && (income === 0 || dealPass) && r.ltvOk;

        (r.approved ? eligible : ineligible).push(r);
      });

      // Sort eligible: lowest rate, then most term flexibility
      eligible.sort((a, b) => {
        const rA = a.prog ? a.prog.rate : 99;
        const rB = b.prog ? b.prog.rate : 99;
        const ptA = a.passingTerms ? a.passingTerms.length : 0;
        const ptB = b.passingTerms ? b.passingTerms.length : 0;
        if (Math.abs(rA - rB) > 0.5) return rA - rB;
        return ptB - ptA;
      });

      res.json({ success: true, eligible, ineligible, vehicle: v });
    } catch (e) {
      console.error('❌ /api/compare-all error:', e.message);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ── POST /api/beacon-match ──────────────────────────────────────────────
  app.post('/api/beacon-match', requireAuth, async (req, res) => {
    try {
      const uid = req.user.userId;
      const { stock, beacon = 0, income = 0, down = 0, trade = 0,
               fees = 0, gstEnabled = false, gstRate: gstIn = 5 } = req.body;
      if (!beacon) return res.status(400).json({ success: false, error: 'Beacon required' });
      if (!stock)  return res.status(400).json({ success: false, error: 'Stock required' });

      const client = await pool.connect();
      let v, tenantRates = {};
      try {
        const vRes = await client.query(
          `SELECT year, make, model, mileage, price, type, condition, stock, carfax,
                  book_value FROM desk_inventory WHERE stock = $1 AND user_id = $2`,
          [stock, uid]
        );
        if (!vRes.rows.length) return res.status(404).json({ success: false, error: 'Vehicle not found' });
        v = vRes.rows[0];
        const ratesRes = await client.query(
          `SELECT lender_id, tier_name, min_fico, max_fico, buy_rate, max_ltv,
                  min_year, max_mileage, max_carfax, lender_fee
           FROM lender_rate_sheets WHERE user_id = $1`, [uid]
        );
        ratesRes.rows.forEach(r => {
          if (!tenantRates[r.lender_id]) tenantRates[r.lender_id] = [];
          tenantRates[r.lender_id].push(r);
        });
      } finally { client.release(); }

      const profileMin = {
    cibc: 680, rbc: 700, servus: 640, wsleasing: 680,
    santander: 600, iauto: 500, autocapital: 540,
    prefera: 520, northlake: 0, edenpark: 500, iceberg: 500, sda: 0,
  };
  const profileMax = {
    cibc: 850, rbc: 850, servus: 850, wsleasing: 850,
    santander: 719, iauto: 850, autocapital: 719,
    prefera: 679, northlake: 699, edenpark: 679, iceberg: 679, sda: 659,
  };

      const badges = [];
      Object.entries(lenders).forEach(([lid, l]) => {
        const prog = getQualifyingProgram(lid, beacon, tenantRates);
        const shortName = l.name.split(' ')[0];
        const pMin = profileMin[lid] ?? 0;
        const pMax = profileMax[lid] ?? 850;
        const inProfile = beacon >= pMin && beacon <= pMax;
        let label, cls;

        if (!l.hard) {
          label = beacon >= (pMin || 680) ? `${shortName} ✓` : `${shortName} ✗`;
          cls   = beacon >= (pMin || 680) ? 'badge-green' : 'badge-red';
        } else if (!inProfile) {
          label = `${shortName} ✗`;
          cls   = 'badge-red';
        } else if (prog) {
          label = `${shortName} — ${prog.rate}%`;
          cls   = beacon >= 680 ? 'badge-green' : beacon >= 600 ? 'badge-amber' : 'badge-orange';
        } else {
          label = `${shortName} ✗`;
          cls   = 'badge-red';
        }
        badges.push({ lid, label, cls, rate: prog ? prog.rate : null });
      });

      res.json({ success: true, badges });
    } catch (e) {
      console.error('❌ /api/beacon-match error:', e.message);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ── POST /api/beacon-simulator ──────────────────────────────────────────
  app.post('/api/beacon-simulator', requireAuth, async (req, res) => {
    try {
      const uid = req.user.userId;
      const { stock, down = 0, trade = 0, fees = 0,
               gstEnabled = false, gstRate: gstIn = 5 } = req.body;
      if (!stock) return res.status(400).json({ success: false, error: 'Stock required' });

      const client = await pool.connect();
      let v, tenantRates = {};
      try {
        const vRes = await client.query(
          `SELECT year, make, model, mileage, price, type, condition, stock, carfax,
                  book_value FROM desk_inventory WHERE stock = $1 AND user_id = $2`,
          [stock, uid]
        );
        if (!vRes.rows.length) return res.status(404).json({ success: false, error: 'Vehicle not found' });
        v = vRes.rows[0];
        const ratesRes = await client.query(
          `SELECT lender_id, tier_name, min_fico, max_fico, buy_rate, max_ltv,
                  min_year, max_mileage, max_carfax, lender_fee
           FROM lender_rate_sheets WHERE user_id = $1`, [uid]
        );
        ratesRes.rows.forEach(r => {
          if (!tenantRates[r.lender_id]) tenantRates[r.lender_id] = [];
          tenantRates[r.lender_id].push(r);
        });
      } finally { client.release(); }

      const gstRate = gstEnabled ? (parseFloat(gstIn) || 5) : 0;
      const taxable = v.price + parseFloat(fees) - parseFloat(trade);
      const gstAmt  = taxable * (gstRate / 100);
      const otd     = taxable + gstAmt;

      const BEACON_RANGES = [
    { label: '<500',  min: 0,   max: 499  },
    { label: '500',   min: 500, max: 539  },
    { label: '540',   min: 540, max: 559  },
    { label: '560',   min: 560, max: 579  },
    { label: '580',   min: 580, max: 599  },
    { label: '600',   min: 600, max: 619  },
    { label: '620',   min: 620, max: 639  },
    { label: '640',   min: 640, max: 659  },
    { label: '660',   min: 660, max: 679  },
    { label: '680',   min: 680, max: 699  },
    { label: '700',   min: 700, max: 719  },
    { label: '720',   min: 720, max: 749  },
    { label: '750+',  min: 750, max: 9999 },
  ];


      const rows = BEACON_RANGES.map(range => {
        const testBeacon = range.min === 0 ? 0 : range.min + 10;
        let approved = 0, bestRate = 99;
        Object.entries(lenders).forEach(([lid, l]) => {
          const prog = getQualifyingProgram(lid, testBeacon, tenantRates);
          if (!prog) return;
          const lenderFee = prog.fee || LENDER_FEES[lid] || 0;
          const atf = otd + lenderFee - parseFloat(down);
          const bookVal = v.book_value || v.price;
          const maxLTV  = prog.maxLTV || l.maxLTV;
          const ltvPct  = (atf / bookVal) * 100;
          if (ltvPct > maxLTV) return;
          const pmt = atf > 0 ? BPMT(prog.rate, 72, atf, false) : 0;
          if (pmt > 0) { approved++; if (prog.rate < bestRate) bestRate = prog.rate; }
        });
        return { label: range.label, approved, bestRate: approved > 0 ? bestRate : null };
      });

      res.json({ success: true, rows });
    } catch (e) {
      console.error('❌ /api/beacon-simulator error:', e.message);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

};
