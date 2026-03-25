// ═══════════════════════════════════════════════════════
// FIRST-FIN DEALER PLATFORM v1.0
// Unified: Dealer Desk + AutoLend + CRM + Analytics
// ═══════════════════════════════════════════════════════
window.inventory = []; 
window.ffInventory = [];
// ── APPLY APPROVAL ──────────────────────────────────────

// Opens the approval modal pre-filled with estimated lender data
function openApprovalModal(lenderNameEnc, estRate, estTerm, estAtf, ltvPct, beacon, stockEnc, bookVal) {
  const lenderName = decodeURIComponent(lenderNameEnc);
  const stock      = decodeURIComponent(stockEnc);

  // Store context for confirmApproval()
  window._approvalCtx = { lenderName, estRate, estTerm, estAtf, ltvPct, beacon, stock, bookVal };

  // Pre-fill modal fields with estimated values
  setVal('appLender',    lenderName);
  setVal('appApprovedAtf',  estAtf  || '');
  setVal('appApprovedRate', estRate || '');
  setVal('appApprovedTerm', estTerm || 72);
  setVal('appApprovedDown', '');
  setVal('appStip',     '');
  setVal('appStock',    stock);
  setVal('appCustName', getVal('custName'));

  // Live-calculate payment preview as user types
  _updateApprovalPreview();

  document.getElementById('appLenderDisplay').textContent = lenderName;
  openModal('approvalModal');
}

function _updateApprovalPreview() {
  const atf  = parseFloat(document.getElementById('appApprovedAtf')?.value)  || 0;
  const rate = parseFloat(document.getElementById('appApprovedRate')?.value) || 0;
  const term = parseFloat(document.getElementById('appApprovedTerm')?.value) || 72;
  const down = parseFloat(document.getElementById('appApprovedDown')?.value) || 0;
  const el   = document.getElementById('appPaymentPreview');
  if (!el) return;
  if (atf <= 0 || rate <= 0 || term <= 0) { el.textContent = '—'; return; }
  const financed = Math.max(0, atf - down);
  const pmt = PMT(rate / 100 / 12, term, -financed);
  el.textContent = $f(pmt) + '/mo';
  // Also show reserve preview
  const contractRate = parseFloat(getVal('contractRate')) || rate;
  const buyRate      = rate;
  const split        = parseFloat(getVal('bankSplit')) || 75;
  const reserveEl    = document.getElementById('appReservePreview');
  if (reserveEl) {
    const spread  = contractRate - buyRate;
    const reserve = spread > 0 ? ((atf - down) * (spread / 100) * (term / 12)) * (split / 100) : 0;
    reserveEl.textContent = reserve > 0 ? $i(reserve) + ' est. reserve' : '';
  }
}

// Called when dealer clicks "Apply to Deal Desk"
async function confirmApproval() {
  const ctx        = window._approvalCtx || {};
  const approvedAtf  = parseFloat(getVal('appApprovedAtf'))  || 0;
  const approvedRate = parseFloat(getVal('appApprovedRate')) || 0;
  const approvedTerm = parseInt(getVal('appApprovedTerm'))   || 72;
  const approvedDown = parseFloat(getVal('appApprovedDown')) || 0;
  const stip         = getVal('appStip').trim();
  const custName     = getVal('appCustName').trim();
  const outcome      = getVal('appOutcome') || 'approved';

  if (!approvedAtf || !approvedRate) {
    toast('Enter approved ATF and rate to continue');
    return;
  }

  // ── Apply to deal desk ──────────────────────────────────
  applyApproved(approvedAtf, approvedRate, approvedTerm, approvedDown);

  // ── Log to deal_outcomes ────────────────────────────────
  try {
    const d       = getDealData();
    const v       = window.inventory?.find(x => x.stock === ctx.stock) || {};
    await FF.apiFetch('/api/desk/outcomes/log-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lenderKey:       ctx.lenderName,
        outcome,
        beacon:          ctx.beacon    || parseFloat(getVal('compareBeacon')) || null,
        ltvPct:          ctx.ltvPct    || null,
        vehicleYear:     v.year        || null,
        vehicleMileage:  v.mileage     || null,
        vehiclePrice:    v.price       || null,
        bookValue:       ctx.bookVal   || v.book_value || null,
        amountToFinance: approvedAtf,
        term:            approvedTerm,
        approvedRate,
        approvedTerm,
        approvedAmount:  approvedAtf,
        stipulations:    stip          || null,
        customerName:    custName      || null,
        stock:           ctx.stock     || null
      })
    });
    console.log('✅ Approval logged to deal_outcomes');
  } catch(e) {
    console.warn('Outcome log failed (non-critical):', e.message);
  }

  closeModal('approvalModal');
  showSection('deal');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.id === 'nav-deal' || b.getAttribute('onclick')?.includes("'deal'"));
  });
  toast('✓ Approval applied — deal desk updated with final numbers');
}

// Rewrites deal desk fields with actual approved numbers and recalculates
function applyApproved(approvedAtf, approvedRate, approvedTerm, approvedDown) {
  // Work backwards from approved ATF to find required down payment
  // ATF = OTD - down  →  down = OTD - ATF
  const price   = parseFloat(getVal('sellingPrice')) || 0;
  const doc     = parseFloat(getVal('docFee'))       || 0;
  const tAllow  = parseFloat(getVal('tradeAllow'))   || 0;
  const tPayoff = parseFloat(getVal('tradePayoff'))  || 0;
  const gst     = parseFloat(getVal('gstRate'))      || 5;
  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst / 100);
  const otd      = price + doc - netTrade + gstAmt;

  // If caller provided explicit down use it, otherwise derive from ATF
  const derivedDown = approvedDown > 0 ? approvedDown : Math.max(0, otd - approvedAtf);

  setVal('apr',         approvedRate);
  setVal('contractRate', approvedRate);   // sync reserve panel
  setVal('reserveTerm',  approvedTerm);   // sync reserve panel
  setVal('finalDown',    derivedDown);

  // Flash the updated fields so dealer sees what changed
  ['apr','finalDown','contractRate'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = 'background .3s';
    el.style.background = 'rgba(16,185,129,.25)';
    setTimeout(() => { el.style.background = ''; }, 1800);
  });

  calculate();
  calculateReserve();
}

// ── SETTINGS ──────────────────────────────────────────
window.settings = JSON.parse(localStorage.getItem('ffSettings') || '{}');
window.settings = {salesName:'',dealerName:'',docFee:998,gst:5,apr:8.99,target:30,...window.settings};
let settings = window.settings; // alias so existing code still works
let dealLog = [];
let crmData  = [];


// ── LENDER DATA ─────────────────────────────────────────
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

// ── LENDER FEES (added to ATF before LTV calc) ─────────
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

// ── MATH HELPERS ──────────────────────────────────────
function PMT(rate,nper,pv){if(rate===0)return Math.abs(pv/nper);return Math.abs(pv*(rate*Math.pow(1+rate,nper))/(Math.pow(1+rate,nper)-1));}
function PV(rate,nper,pmt){if(rate===0)return pmt*nper;return pmt*((1-Math.pow(1+rate,-nper))/rate);}

// ── BI-WEEKLY MODE ────────────────────────────────────────────────
window._biweekly = false;
function toggleBiweekly(el){
  window._biweekly = el.checked;
  // Sync all toggles
  document.querySelectorAll('.bw-toggle').forEach(t=>{ t.checked = window._biweekly; });
  calculate();
  updateRateComparison();
}
// BPMT: calculates payment based on current mode (monthly or bi-weekly)
function BPMT(apr, months, fin){
  if(window._biweekly){
    const r = apr/100/26;
    const n = Math.round(months * 26/12);
    return PMT(r, n, fin);
  }
  return PMT(apr/100/12, months, fin);
}
function _pmtLabel(){ return window._biweekly ? '/bi-wk' : '/mo'; }
function _biweeklyToggleHTML(id){
  return `<label style="display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;color:var(--muted);cursor:pointer;user-select:none;">
    <input type="checkbox" class="bw-toggle" id="${id}" onchange="toggleBiweekly(this)" ${window._biweekly?'checked':''} style="width:14px;height:14px;cursor:pointer;accent-color:var(--primary);">
    <span style="letter-spacing:.5px;text-transform:uppercase;">Bi-Weekly Payments</span>
  </label>`;
}
const $f = n => '$'+Number(n).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2});
const $i = n => '$'+Math.round(n).toLocaleString('en-CA');

// ── NAVIGATION ────────────────────────────────────────
function showSection(id, btn){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('section-'+id).classList.add('active');
  if(btn) btn.classList.add('active');
  if(id==='analytics') refreshAllAnalytics();
  // Pre-populate Compare All from Deal Desk whenever tab opens
  if(id==='compare') {
    setTimeout(() => restoreCompareSession(), 60);
    setTimeout(() => syncCompareFromDeal(false), 120); // false = don't overwrite restored values
  }
  setTimeout(refreshIcons, 50);
}

// ── INVENTORY INIT (Cloud & Database Version) ─────────
function initInventory(){
  const sel = document.getElementById('stockNum');
  const cmpSel = document.getElementById('compareStock');
  
  // Use the cloud-synced variable primarily, fallback to window.inventory
  const data = window.ffInventory || window.inventory || [];

  if (!sel || !cmpSel) return;
  
  // RACE CONDITION FIX: If dropdowns already populated by _triggerRenders(), skip clearing
  // This prevents api-client's _triggerRenders() from populating, then initInventory() clearing them
  const alreadyPopulated = sel.options.length > 1;
  
  if (alreadyPopulated && data.length > 0) {
    // Dropdowns already have vehicles - just ensure table and lender checkers are updated
    renderInventory(data);
    refreshLenderCheckerDropdowns();
    return;
  }
  
  // 1. Clear dropdowns (only if not already populated)
  sel.innerHTML = '<option value="">— Select Stock # —</option>';
  cmpSel.innerHTML = '<option value="">— Choose a vehicle —</option>';

  if (data.length === 0) {
    console.log('ℹ️ Inventory is empty or still loading...');
    return;
  }

  // 2. Populate dropdowns with DB data
  data.forEach(v => {
    const priceFormatted = Number(v.price || 0).toLocaleString();
    const label = `${v.stock} — ${v.year} ${v.make} ${v.model} ($${priceFormatted})`;
    
    const opt1 = document.createElement('option');
    opt1.value = v.stock;
    opt1.textContent = label;
    sel.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = v.stock;
    opt2.textContent = label;
    cmpSel.appendChild(opt2);
  });

  // 3. Update the main inventory tab table
  renderInventory(data);
  
  // 4. Refresh lender checker dropdowns (they're built at DOMContentLoaded before inventory loads)
  refreshLenderCheckerDropdowns();
}

// ── REFRESH LENDER CHECKER DROPDOWNS ─────────────────
// Called after inventory loads to populate vehicle dropdowns in Lenders section
// Exposed globally so demo mode and other scripts can call it
function refreshLenderCheckerDropdowns(){
  const data = window.ffInventory || window.inventory || [];
  if(data.length === 0) return;
  
  // Build options HTML once
  const optionsHTML = '<option value="">— Select a vehicle —</option>' + 
    data.map(v => {
      const price = Number(v.price || 0).toLocaleString();
      return `<option value="${v.stock}">${v.stock} — ${v.year} ${v.make} ${v.model} ($${price})</option>`;
    }).join('');
  
  // Update all lender checker dropdowns
  Object.keys(lenders).forEach(lid => {
    const sel = document.getElementById(`chk-stock-${lid}`);
    if(sel){
      sel.innerHTML = optionsHTML;
    }
  });
  
  console.log(`✅ Lender checker dropdowns refreshed with ${data.length} vehicles`);
}
window.refreshLenderCheckerDropdowns = refreshLenderCheckerDropdowns;

// ── BOOK VALUE INLINE EDIT ────────────────────────────────────────
async function editBookValue(stock, currentVal, event) {
  event.stopPropagation();
  const cell = event.currentTarget;
  const oldText = cell.innerHTML;

  // Replace cell content with input
  const input = document.createElement('input');
  input.type = 'number';
  input.value = currentVal || '';
  input.placeholder = 'e.g. 28000';
  input.style.cssText = 'width:90px;background:var(--surface);border:1px solid var(--amber);border-radius:4px;color:var(--text);padding:4px 6px;font-size:11px;font-family:Outfit,sans-serif;';
  cell.innerHTML = '';
  cell.appendChild(input);
  input.focus();
  input.select();

  async function save() {
    const newVal = parseFloat(input.value);
    if (isNaN(newVal) || newVal < 0) { cell.innerHTML = oldText; return; }
    try {
      const res = await FF.apiFetch(`/api/desk/inventory/${encodeURIComponent(stock)}/book-value`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_value: newVal })
      });
      const data = await res.json();
      if (data.success) {
        // Update local inventory array
        const inv = window.ffInventory || window.inventory || [];
        const v = inv.find(x => x.stock === stock);
        if (v) v.book_value = newVal;
        cell.innerHTML = newVal > 0 ? `<span style="cursor:pointer;color:var(--green);" title="Click to edit book value">$${newVal.toLocaleString()}</span>` : `<span style="cursor:pointer;color:var(--muted);" title="Click to edit book value">—</span>`;
        toast(`Book value updated: ${stock}`);
      } else {
        cell.innerHTML = oldText;
        toast('Update failed');
      }
    } catch(e) { cell.innerHTML = oldText; toast('Update failed'); }
  }

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { cell.innerHTML = oldText; }
  });
}

function renderInventory(list){
  const countEl = document.getElementById('invCount');
  const tbody = document.getElementById('inventoryBody');
  if (countEl) countEl.textContent = `${list.length} vehicles`;
  if (!tbody) return;

  tbody.innerHTML = list.map(v => `
    <tr onclick="sendToDeal('${v.stock}')">
      <td><strong style="color:var(--amber);">${v.stock}</strong></td>
      <td>${v.year}</td>
      <td>${v.make}</td>
      <td>${v.model}</td>
      <td style="color:var(--muted);">${v.type || ''}</td>
      <td>${Number(v.mileage).toLocaleString()} km</td>
      <td><strong style="color:var(--green);">$${Number(v.price).toLocaleString()}</strong></td>
      <td style="cursor:pointer;font-size:11px;" onclick="editBookValue('${v.stock}',${v.book_value||0},event)" title="Click to edit book value">
        ${v.book_value&&v.book_value>0
          ? `<span style="color:var(--green);">$${Number(v.book_value).toLocaleString()}</span>`
          : `<span style="color:var(--muted);">—</span>`}
        <span style="font-size:9px;color:var(--muted);margin-left:3px;">✏</span>
      </td>
      <td><span class="badge badge-${String(v.condition).toLowerCase()}">${v.condition}</span></td>
      <td><button class="btn btn-primary btn-sm" onclick="event.stopPropagation();sendToDeal('${v.stock}')"><i data-lucide="arrow-right" class="ico-sm"></i>Use in Deal</button></td>
    </tr>`).join('');
}

// ── SYNC INVENTORY FROM LOCAL BRIDGE ─────────────────────────────
async function syncInventory(){
  const BRIDGE_URL = 'http://localhost:5800';
  const btn = document.getElementById('invSyncBtn');
  if(btn){ btn.disabled=true; btn.innerHTML='<i data-lucide="loader" class="ico-sm"></i>Syncing...'; lucide.createIcons(); }

  try {
    // 1. Check bridge is running
    let pingOk = false;
    try {
      const ping = await fetch(BRIDGE_URL+'/api/system/status', {signal:AbortSignal.timeout(3000)});
      pingOk = ping.ok;
    } catch(e){ pingOk = false; }

    if(!pingOk){
      toast('⚠️ Bridge not running — start bridge.py first');
      return;
    }

    // 2. Fetch vehicles from bridge
    toast('Fetching inventory from bridge...');
    const res = await fetch(BRIDGE_URL+'/api/inventory', {signal:AbortSignal.timeout(15000)});
    const data = await res.json();
    if(!data.ok || !data.vehicles?.length){
      toast('No vehicles found in bridge inventory');
      return;
    }

    // 3. Map bridge fields → desk_inventory schema
    const vehicles = data.vehicles.map(v => {
      const raw = v.raw || v;
      const titleParts = (raw['Title'] || raw['title'] || '').split(' ');
      const year  = raw['Year']  || raw['year']  || (titleParts[0]||'');
      const make  = raw['Make']  || raw['make']  || (titleParts[1]||'');
      const model = raw['Model'] || raw['model'] || (titleParts.slice(2).join(' ')||'');
      const stock = raw['Stock #'] || raw['stock'] || v.stock || '';
      const price = v.price || 0;
      const mileage = v.mileage || 0;
      const vin   = raw['VIN']  || raw['vin']  || v.vin  || null;
      const type  = raw['Body Style'] || raw['body_style'] || v.body_style || 'Car';
      const cond  = raw['Condition'] || raw['condition'] || 'Average';

      return { stock, year, make, model, mileage, price, condition: cond, carfax: 0, type, vin };
    }).filter(v => v.stock && v.year);

    if(!vehicles.length){
      toast('Could not map vehicle data — check bridge output');
      return;
    }

    // 4. Push to Postgres via desk API
    toast(`Syncing ${vehicles.length} vehicles to platform...`);
    const pushRes = await FF.apiFetch('/api/desk/inventory/bulk', {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({vehicles})
    });
    const pushData = await pushRes.json();
    if(!pushData.success) throw new Error(pushData.error || 'Push failed');

    // 5. Reload inventory in UI
    window.ffInventory = vehicles;
    window.inventory   = vehicles;
    localStorage.setItem('ffInventory', JSON.stringify(vehicles));
    initInventory();

    // Refresh dropdowns
    if(window.FF && typeof FF.loadAllData === 'function'){
      await FF.loadAllData();
    }

    toast(`✅ Synced ${vehicles.length} vehicles to Deal Desk!`);

  } catch(e){
    toast('Sync failed: '+e.message);
    console.error('Inventory sync error:', e);
  } finally {
    if(btn){ btn.disabled=false; btn.innerHTML='<i data-lucide="refresh-cw" class="ico-sm"></i>Sync Inventory'; lucide.createIcons(); }
  }
}

function filterInventory(){
  const q = document.getElementById('invSearch').value.toLowerCase();
  const dataSource = window.ffInventory || window.inventory || []; //
  
  const filtered = dataSource.filter(v =>
    v.stock.toLowerCase().includes(q) || 
    v.make.toLowerCase().includes(q) ||
    v.model.toLowerCase().includes(q) || 
    String(v.year).includes(q) ||
    String(v.price).includes(q) || 
    v.condition.toLowerCase().includes(q)
  );
  renderInventory(filtered);
}

// ── DEAL WIZARD NAVIGATION ────────────────────────────
let currentWizStep = 0;
const WIZ_STEPS = 5;

function goWizStep(n) {
  if (n < 0 || n >= WIZ_STEPS) return;

  // Mark previous steps as done
  const dots = document.querySelectorAll('.wiz-dot-wrap');
  dots.forEach((d, i) => {
    d.classList.remove('active', 'done');
    if (i < n) d.classList.add('done');
    if (i === n) d.classList.add('active');
  });

  // Show/hide step panels
  for (let i = 0; i < WIZ_STEPS; i++) {
    const panel = document.getElementById('wizStep' + i);
    if (panel) {
      panel.classList.remove('active');
      if (i === n) panel.classList.add('active');
    }
  }

  currentWizStep = n;

  // Scroll to top of deal section
  const section = document.getElementById('section-deal');
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Recalculate when entering payment/review steps
  if (n >= 3) calculate();
}

function updateWizBanners(otd, down, finance, pay72) {
  const fmt = v => '$' + Math.round(v).toLocaleString();
  // Step 4 banner
  const w1 = document.getElementById('wizOtd');
  const w2 = document.getElementById('wizDown');
  const w3 = document.getElementById('wizFinance');
  const w4 = document.getElementById('wizPay72');
  if (w1) w1.textContent = fmt(otd);
  if (w2) w2.textContent = fmt(down);
  if (w3) w3.textContent = fmt(finance);
  if (w4) w4.textContent = $f(pay72);
  // Step 5 banner (duplicate IDs with _2 suffix)
  const w5 = document.getElementById('wizOtd2');
  const w6 = document.getElementById('wizDown2');
  const w7 = document.getElementById('wizFinance2');
  const w8 = document.getElementById('wizPay72_2');
  if (w5) w5.textContent = fmt(otd);
  if (w6) w6.textContent = fmt(down);
  if (w7) w7.textContent = fmt(finance);
  if (w8) w8.textContent = $f(pay72);
}

function sendToDeal(stock){
  const data = window.ffInventory || window.inventory || [];
  const v = data.find(x => x.stock === stock);
  
  if(!v) return;

  // Sync DB values to Deal Desk inputs
  document.getElementById('stockNum').value = stock;
  document.getElementById('vehicleDesc').value = `${v.year} ${v.make} ${v.model}`;
  document.getElementById('vehicleType').value = v.type || '';
  document.getElementById('odometer').value = v.mileage;
  document.getElementById('condition').value = v.condition || 'Average';
  document.getElementById('vin').value = v.vin || '';
  document.getElementById('sellingPrice').value = v.price;
  document.getElementById('docFee').value = settings.docFee;
  
  calculate();
  showSection('deal', document.querySelector('.nav-btn'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const dealBtn = document.querySelector('button[onclick*="\'deal\'"]');
  if(dealBtn) dealBtn.classList.add('active');
  goWizStep(1); // Vehicle filled — advance to Customer step
  
  toast('Loaded: ' + v.year + ' ' + v.make + ' ' + v.model);
}

function loadVehicleFromStock(){
  const stock = document.getElementById('stockNum').value;
  if(stock) sendToDeal(stock);
}
function calculate(){
  const price  = parseFloat(document.getElementById('sellingPrice').value)||0;
  const doc    = parseFloat(document.getElementById('docFee').value)||0;
  const tAllow = parseFloat(document.getElementById('tradeAllow').value)||0;
  const tPayoff= parseFloat(document.getElementById('tradePayoff').value)||0;
  const apr    = parseFloat(document.getElementById('apr').value)||0;
  const gst    = parseFloat(document.getElementById('gstRate').value)||5;

  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst/100);
  const otd      = price + doc - netTrade + gstAmt;

  const finalDown = parseFloat(document.getElementById('finalDown').value)||0;

  document.getElementById('gstAmount').value = $f(gstAmt);
  document.getElementById('totalOTD').textContent = $f(otd);

  // Update final down / finance amount summary boxes
  const finAmt = Math.max(0, otd - finalDown);
  const fdEl = document.getElementById('finalDownDisplay');
  const faEl = document.getElementById('financeAmountDisplay');
  if(fdEl) fdEl.textContent = '$' + finalDown.toLocaleString();
  if(faEl) faEl.textContent = '$' + Math.round(finAmt).toLocaleString();

  const mr = apr/100/12;
  const downs = [0,2000,5000];
  const terms = [48,60,72,84];
  let html = '';

  // Update table headers to reflect monthly vs bi-weekly
  const pmtLbl = window._biweekly ? 'Bi-Wkly' : 'Monthly';
  const thEl = document.querySelector('.payment-table thead tr');
  if(thEl) thEl.innerHTML = `<th>Down Payment</th><th>48 ${pmtLbl}</th><th>60 ${pmtLbl}</th><th>72 ${pmtLbl}</th><th>84 ${pmtLbl}</th>`;

  // Inject biweekly toggle above payment table
  let toggleWrap = document.getElementById('bw-toggle-wrap-grid');
  if(!toggleWrap){
    toggleWrap = document.createElement('div');
    toggleWrap.id = 'bw-toggle-wrap-grid';
    const tableWrap = document.querySelector('.payment-wrap');
    if(tableWrap) tableWrap.parentNode.insertBefore(toggleWrap, tableWrap);
  }
  toggleWrap.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">${_biweeklyToggleHTML('bw-toggle-grid')}</div>`;

  // Highlight the row matching finalDown if it matches one of the preset rows
  downs.forEach(down=>{
    const isChosen = finalDown > 0 && Math.abs(down - finalDown) < 1;
    html += `<tr${isChosen?' style="background:rgba(245,158,11,.08);"':''}>`;
    html += `<td><strong style="color:var(--text);">$${down.toLocaleString()}</strong></td>`;
    terms.forEach(t=>{
      const fin = Math.max(0, otd - down);
      const pmt = fin > 0 ? BPMT(apr,t,fin) : 0;
      html += `<td class="payment-val">${$f(pmt)}</td>`;
    });
    html += '</tr>';
  });
  // Final down row — shows chosen deal structure payment
  if(finalDown > 0 && ![0,2000,5000].includes(finalDown)){
    html += `<tr style="background:rgba(245,158,11,.1);outline:1px solid rgba(245,158,11,.3);">`;
    html += `<td><strong style="color:var(--amber);">$${finalDown.toLocaleString()} ★</strong></td>`;
    [48,60,72,84].forEach(t=>{
      const fin = Math.max(0, otd - finalDown);
      const pmt = BPMT(apr,t,fin);
      html += `<td class="payment-val" style="color:var(--amber);font-weight:800;">${$f(pmt)}</td>`;
    });
    html += '</tr>';
  }
  html += `<tr>
    <td><input type="number" id="customDown" placeholder="Custom $" style="width:100%;padding:7px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-weight:700;text-align:center;" oninput="calcCustom()"></td>
    <td class="payment-val" id="c48">—</td><td class="payment-val" id="c60">—</td>
    <td class="payment-val" id="c72">—</td><td class="payment-val" id="c84">—</td>
  </tr>`;
  document.getElementById('paymentGrid').innerHTML = html;

  const vsc = parseFloat(document.getElementById('vscPrice').value)||0;
  const gap = parseFloat(document.getElementById('gapPrice').value)||0;
  const tw  = parseFloat(document.getElementById('twPrice').value)||0;
  const wa  = parseFloat(document.getElementById('waPrice').value)||0;

  const b72 = BPMT(apr,72,otd);
  const bwPeriods = window._biweekly ? Math.round(72*26/12) : 72;
  const lbl = _pmtLabel();
  document.getElementById('basePayment72').textContent = $f(b72);
  document.getElementById('withGap').textContent = $f(b72+(gap/bwPeriods));
  document.getElementById('withGapVsc').textContent = $f(b72+(gap/bwPeriods)+(vsc/bwPeriods));
  document.getElementById('withAllProtection').textContent = $f(b72+(gap/bwPeriods)+(vsc/bwPeriods)+(tw/bwPeriods));
  document.getElementById('fullProtection').textContent = $f(b72+(gap/bwPeriods)+(vsc/bwPeriods)+(tw/bwPeriods)+(wa/bwPeriods));

  document.getElementById('vscImpact').textContent = '+'+$f(vsc/bwPeriods)+lbl;
  document.getElementById('gapImpact').textContent = '+'+$f(gap/bwPeriods)+lbl;
  document.getElementById('twImpact').textContent  = '+'+$f(tw/bwPeriods)+lbl;
  document.getElementById('waImpact').textContent  = '+'+$f(wa/bwPeriods)+lbl;

  // Update F&I section label to show current payment mode
  const fi72Label = document.querySelector('#wizStep3 .wiz-section-title + div .insight-label, #wizStep3 [style*="Monthly Payment"]');
  const fi72Header = document.querySelector('#wizStep3 div[style*="72 Months"]');
  if(fi72Header) fi72Header.textContent = `Payment @ 72 ${window._biweekly?'Bi-Weekly':'Months'}`;

  calculateProfit();
  calculateReserve();
  calculateSubprime();
  calculatePTI();

  // Update wizard live banners (steps 4 & 5)
  updateWizBanners(otd, finalDown, finAmt, BPMT(apr,72,finAmt));
}

function calcCustom(){
  const down = parseFloat(document.getElementById('customDown').value)||0;
  const price  = parseFloat(document.getElementById('sellingPrice').value)||0;
  const doc    = parseFloat(document.getElementById('docFee').value)||0;
  const tAllow = parseFloat(document.getElementById('tradeAllow').value)||0;
  const tPayoff= parseFloat(document.getElementById('tradePayoff').value)||0;
  const apr    = parseFloat(document.getElementById('apr').value)||0;
  const gst    = parseFloat(document.getElementById('gstRate').value)||5;
  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst/100);
  const otd      = price + doc - netTrade + gstAmt;
  const fin = otd - down;
  [48,60,72,84].forEach(t=>{
    const el = document.getElementById('c'+t);
    if(el) el.textContent = fin>0?$f(BPMT(apr,t,fin)):'—';
  });
}

function calculateProfit(){
  const price = parseFloat(document.getElementById('sellingPrice').value)||0;
  const acv   = parseFloat(document.getElementById('unitAcv').value)||0;
  const recon = parseFloat(document.getElementById('recon').value)||0;
  const pack  = parseFloat(document.getElementById('lotPack').value)||0;
  const totalCost = acv+recon+pack;
  const front = price - totalCost;
  const vscP = (parseFloat(document.getElementById('vscPrice').value)||0)-(parseFloat(document.getElementById('vscCost').value)||0);
  const gapP = (parseFloat(document.getElementById('gapPrice').value)||0)-(parseFloat(document.getElementById('gapCost').value)||0);
  const twP  = (parseFloat(document.getElementById('twPrice').value)||0)-(parseFloat(document.getElementById('twCost').value)||0);
  const waP  = (parseFloat(document.getElementById('waPrice').value)||0)-(parseFloat(document.getElementById('waCost').value)||0);
  const total = front+vscP+gapP+twP+waP+500;
  document.getElementById('totalCost').textContent  = $i(totalCost);
  document.getElementById('frontGross').textContent = $i(front);
  document.getElementById('vscProfit').textContent  = $i(vscP);
  document.getElementById('gapProfit').textContent  = $i(gapP);
  document.getElementById('twProfit').textContent   = $i(twP);
  document.getElementById('waProfit').textContent   = $i(waP);
  document.getElementById('totalGross').textContent = 'TOTAL GROSS: '+$i(total);
  document.getElementById('fePercent').textContent  = total?((front/total)*100).toFixed(1)+'%':'0%';
  document.getElementById('bePercent').textContent  = total?(((total-front)/total)*100).toFixed(1)+'%':'0%';
  document.getElementById('pvr').textContent        = $i(total);
}

function calculateReserve(){
  const contract = parseFloat(document.getElementById('contractRate').value)||0;
  const buy      = parseFloat(document.getElementById('buyRate').value)||0;
  const split    = parseFloat(document.getElementById('bankSplit').value)||75;
  const term     = parseFloat(document.getElementById('reserveTerm').value)||72;
  const price    = parseFloat(document.getElementById('sellingPrice').value)||0;
  const spread   = contract - buy;
  const reserve  = (price*(spread/100)*(term/12))*(split/100);
  document.getElementById('rateSpread').textContent   = spread.toFixed(2)+'%';
  document.getElementById('reserveProfit').textContent= $i(reserve);
}

function calculateSubprime(){
  const advance = parseFloat(document.getElementById('subAdvance').value)||0;
  const nada    = parseFloat(document.getElementById('subNada').value)||0;
  const ltv     = nada>0?((advance/nada)*100).toFixed(1)+'%':'N/A';
  document.getElementById('dealLTV').textContent = ltv;
}

function calculatePTI(){
  const income   = parseFloat(document.getElementById('monthlyIncome').value)||0;
  const existing = parseFloat(document.getElementById('existingPayments').value)||0;
  const ptiLimit = parseFloat(document.getElementById('ptiLimit').value)||20;
  const price    = parseFloat(document.getElementById('sellingPrice').value)||0;
  const doc      = parseFloat(document.getElementById('docFee').value)||0;
  const tAllow   = parseFloat(document.getElementById('tradeAllow').value)||0;
  const tPayoff  = parseFloat(document.getElementById('tradePayoff').value)||0;
  const apr      = parseFloat(document.getElementById('apr').value)||0;
  const gst      = parseFloat(document.getElementById('gstRate').value)||5;
  // Use actual deal term from reserve term field if available, else 72
  const termEl   = document.getElementById('reserveTerm');
  const term     = termEl ? (parseInt(termEl.value)||72) : 72;
  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst/100);
  const otd      = price + doc - netTrade + gstAmt;
  const finalDown = parseFloat(document.getElementById('finalDown')?.value)||0;
  const financed  = Math.max(0, otd - finalDown);
  const mr        = apr > 0 ? apr/100/12 : 0;
  const payment   = financed > 0 ? (mr > 0 ? PMT(mr, term, -financed) : (financed / term)) : 0;
  const totalPayments = payment + existing;
  const pti = income > 0 ? ((payment / income) * 100) : 0;
  const dti = income > 0 ? ((totalPayments / income) * 100) : 0;
  document.getElementById('ptiResult').textContent = pti.toFixed(1)+'%';
  const ptiStatus = pti <= ptiLimit ? 'PASS' : 'EXCEEDS LIMIT';
  document.getElementById('ptiStatus').textContent = ptiStatus;
  document.getElementById('ptiStatus').style.color = pti <= ptiLimit ? 'var(--green)' : 'var(--red)';
  // DTI display (if element exists)
  const dtiEl = document.getElementById('dtiResult');
  if(dtiEl){ dtiEl.textContent = dti.toFixed(1)+'%'; dtiEl.style.color = dti<=44 ? 'var(--green)':'var(--red)'; }
  const dtiStatusEl = document.getElementById('dtiStatus');
  if(dtiStatusEl){ dtiStatusEl.textContent = dti<=44 ? 'PASS':'EXCEEDS 44%'; dtiStatusEl.style.color = dti<=44?'var(--green)':'var(--red)'; }
  syncCompareFromDeal();
}

function assessRisk(){
  const score = parseInt(document.getElementById('creditScore').value)||0;
  const risk = document.getElementById('refiRisk');
  const resStatus = document.getElementById('reserveStatus');
  if(score>=750){risk.textContent='LOW';risk.style.color='var(--green)';resStatus.textContent='SECURE';resStatus.style.color='var(--green)';}
  else if(score>=700){risk.textContent='MODERATE';risk.style.color='var(--amber)';resStatus.textContent='WATCH';resStatus.style.color='var(--amber)';}
  else if(score>=650){risk.textContent='ELEVATED';risk.style.color='var(--amber)';resStatus.textContent='AT RISK';resStatus.style.color='var(--amber)';}
  else{risk.textContent='HIGH';risk.style.color='var(--red)';resStatus.textContent='CHARGEBACKS';resStatus.style.color='var(--red)';}
  syncCompareFromDeal();
}

function calculateTrade(){
  const acv   = parseFloat(document.getElementById('acv').value)||0;
  const adj   = parseFloat(document.getElementById('conditionAdj').value)||0;
  const safety= parseFloat(document.getElementById('safetyInspect').value)||0;
  const recon = parseFloat(document.getElementById('reconditionCost').value)||0;
  const totalRecon = safety+recon+adj;
  const adjACV = acv-totalRecon;
  const tAllow  = parseFloat(document.getElementById('tradeAllow').value)||0;
  const tPayoff = parseFloat(document.getElementById('tradePayoff').value)||0;
  const equity  = tAllow-tPayoff;
  document.getElementById('totalRecon').value = $f(totalRecon);
  document.getElementById('adjustedACV').value= $f(adjACV);
  document.getElementById('tradeEquity').value= $f(equity);
  document.getElementById('tradeEquity').style.color= equity>=0?'var(--green)':'var(--red)';
}

// ── MANAGER TABS ──────────────────────────────────────
function showMgrTab(id,btn){
  document.querySelectorAll('.mgr-content').forEach(c=>c.classList.remove('active'));
  document.querySelectorAll('.mgr-tab').forEach(b=>b.classList.remove('active'));
  document.getElementById('mgr-'+id).classList.add('active');
  if(btn) btn.classList.add('active');
}

// ── QUICK TOOLS ───────────────────────────────────────
function quickCalc(){
  const a=parseFloat(document.getElementById('toolAmount').value)||0;
  const r=parseFloat(document.getElementById('toolRate').value)||0;
  const t=parseInt(document.getElementById('toolTerm').value)||72;
  document.getElementById('quickResult').textContent = $f(PMT(r/100/12,t,-a))+' / month';
}
function reverseCalc(){
  const pmt=parseFloat(document.getElementById('revPayment').value)||0;
  const r=parseFloat(document.getElementById('revRate').value)||0;
  const t=parseInt(document.getElementById('revTerm').value)||72;
  document.getElementById('reverseResult').textContent = 'Max: '+$f(PV(r/100/12,t,pmt));
}
function calcMargin(){
  const cost=parseFloat(document.getElementById('mCost').value)||0;
  const sell=parseFloat(document.getElementById('mSell').value)||0;
  const profit=sell-cost;
  const pct=sell>0?((profit/sell)*100).toFixed(1):0;
  document.getElementById('marginResult').textContent = $i(profit)+' profit — '+pct+'%';
}

// ── BRIDGE: DEAL DESK → COMPARE ───────────────────────
function bridgeToCompare(){
  const stock = document.getElementById('stockNum').value;
  if(!stock){toast('Select a vehicle stock number first');return;}
  const down    = parseFloat(document.getElementById('tradeAllow').value)||0;
  const fees    = parseFloat(document.getElementById('docFee').value)||0;
  const beacon  = getVal('creditScore');
  const income  = getVal('monthlyIncome');
  const existing= getVal('existingPayments');
  // Pull term from reserveTerm selector if it exists, else default 72
  const termEl  = document.getElementById('reserveTerm') || document.getElementById('compareTerm');
  const term    = termEl ? (parseInt(termEl.value) || 72) : 72;
  document.getElementById('compareStock').value = stock;
  document.getElementById('compareDown').value  = down;
  document.getElementById('compareFees').value  = fees;
  if(beacon  && document.getElementById('compareBeacon'))  document.getElementById('compareBeacon').value  = beacon;
  if(income  && document.getElementById('compareIncome'))  document.getElementById('compareIncome').value  = income;
  if(existing && document.getElementById('compareExisting')) document.getElementById('compareExisting').value = existing;
  if(document.getElementById('compareTerm')) document.getElementById('compareTerm').value = term;
  showSection('compare', document.querySelectorAll('.nav-btn')[3]);
  runComparison();
  toast('✅ Deal loaded into Compare Engine');
}

// ── LENDER SECTION INIT ───────────────────────────────
function initLenderPanels(){
  const container = document.getElementById('lender-panels');
  Object.entries(lenders).forEach(([lid,l])=>{
    const warnNote = !l.hard?`<div class="warning-box">ℹ️ ${l.name} uses a credit profile-based approval. Mileage and Carfax limits may vary based on full application review.</div>`:'';
    const html = `
    <div id="lq-${lid}" class="lcontent ${lid==='autocapital'?'active':''}">
      <div class="lender-header-box">
        <div class="lender-name-big">${l.name}</div>
        <div class="lender-contact-row">
          <div><span>${l.phone}</span></div>
          <div><span>${l.web}</span></div>
          <div>Max LTV: <span>${l.maxLTV}%</span></div>
          ${l.maxMileage?`<div>Max Mileage: <span>${l.maxMileage.toLocaleString()} km</span></div>`:''}
          ${l.maxCarfax?`<div>Max Carfax: <span>$${l.maxCarfax.toLocaleString()}</span></div>`:''}
        </div>
      </div>
      ${warnNote}
      <table class="programs-table">
        <thead><tr><th>Program / Tier</th><th>Rate</th><th>Min FICO</th><th>Min Year</th><th>Max Mileage</th><th>Max Carfax</th><th>Max LTV</th></tr></thead>
        <tbody>${l.programs.map(p=>`<tr><td><strong>${p.tier}</strong></td><td style="color:var(--amber);">${p.rate}</td><td>${p.fico}</td><td>${p.minYear}</td><td>${p.maxMile}</td><td>${p.maxCfx}</td><td>${p.maxLtv}</td></tr>`).join('')}</tbody>
      </table>
      <div class="checker-box">
        <div class="checker-title"><i data-lucide="search" class="ico"></i>Vehicle Approval Checker</div>
        <div class="fgroup">
          <label>Select Vehicle</label>
          <select id="chk-stock-${lid}" onchange="checkLenderApproval('${lid}')" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:9px 12px;width:100%;font-family:'Outfit',sans-serif;">
            <option value="">— Select a vehicle —</option>
            ${inventory.map(v=>`<option value="${v.stock}">${v.stock} — ${v.year} ${v.make} ${v.model} ($${v.price.toLocaleString()})</option>`).join('')}
          </select>
        </div>
        <div id="chk-results-${lid}"></div>
        <div id="chk-ltv-${lid}" style="display:none;">
          <div class="ltv-result-box" style="margin-top:14px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:12px;color:var(--amber);"><i data-lucide="percent" class="ico-sm"></i>LTV Calculator</div>
            <div class="three-col">
              <div class="fgroup"><label>Down Payment ($)</label><input type="number" id="ltv-down-${lid}" value="0" oninput="calcLTV('${lid}')"></div>
              <div class="fgroup"><label>Trade-in ($)</label><input type="number" id="ltv-trade-${lid}" value="0" oninput="calcLTV('${lid}')"></div>
              <div class="fgroup"><label>Add-ons ($)</label><input type="number" id="ltv-fees-${lid}" value="0" oninput="calcLTV('${lid}')"></div>
            </div>
            <div id="ltv-out-${lid}"></div>
          </div>
        </div>
      </div>
    </div>`;
    container.innerHTML += html;
  });

  // Quick Ref panel
  container.innerHTML += `
  <div id="lq-quickref" class="lcontent">
    <div class="card-title" style="margin-bottom:16px;"><i data-lucide="book-open" class="ico"></i>Quick Reference — All Lenders</div>
    <div class="warning-box">CIBC & RBC use rate-based programs without hard mileage/Carfax limits. WS Leasing is a lease program. Data verified January 2026.</div>
    <div class="table-wrap"><table class="qr-table">
      <thead><tr><th>Lender</th><th>Best For</th><th>Min Year</th><th>Max Mileage</th><th>Max Carfax</th><th>Max LTV</th><th>Rate Range</th><th>Phone</th></tr></thead>
      <tbody>
        <tr><td><strong>AutoCapital</strong></td><td>Subprime/Bad Credit</td><td>2015</td><td>195,000 km</td><td>$7,500</td><td>175%</td><td>13.49%–23.49%</td><td>855-646-0534</td></tr>
        <tr><td><strong>CIBC</strong></td><td>Prime/Good Credit</td><td>2015</td><td>Credit-based</td><td>Credit-based</td><td>96%</td><td>6.36%–9.49%</td><td>1-855-598-1856</td></tr>
        <tr><td><strong>EdenPark</strong></td><td>Flexible/Subprime</td><td>2015</td><td>180,000 km</td><td>$7,500</td><td>140%</td><td>11.99%–23.99%</td><td>1-855-366-8667</td></tr>
        <tr><td><strong>Iceberg</strong></td><td>Deep Subprime</td><td>2012</td><td>180,000 km</td><td>$6,500</td><td>140%</td><td>12.99%–31.99%</td><td>855-694-0960</td></tr>
        <tr><td><strong>NorthLake</strong></td><td>No FICO Min</td><td>2003</td><td>300,000 km</td><td>$7,500</td><td>140%</td><td>10.99%–22.99%</td><td>1-888-652-5320</td></tr>
        <tr><td><strong>Prefera</strong></td><td>Standard Credit</td><td>2015</td><td>200,000 km</td><td>$5,000</td><td>170%</td><td>16.95%–30.95%</td><td>1-844-734-3577</td></tr>
        <tr><td><strong>RBC</strong></td><td>Prime/Excellent</td><td>2015</td><td>Credit-based</td><td>Credit-based</td><td>96%</td><td>5.79%–9.99%</td><td>1-888-529-6999</td></tr>
        <tr><td><strong>Santander</strong></td><td>Mid-range Credit</td><td>2015</td><td>160,000 km</td><td>$6,000</td><td>150%</td><td>9.99%–29.99%</td><td>1-888-222-4227</td></tr>
        <tr><td><strong>SDA</strong></td><td>Deep Subprime</td><td>2012</td><td>250,000 km</td><td>$8,000</td><td>135%</td><td>15.99%–24.99%</td><td>1-800-731-2345</td></tr>
        <tr><td><strong>Servus CU</strong></td><td>Local/Member</td><td>2015</td><td>180,000 km</td><td>$5,000</td><td>100%</td><td>6.50%–14.99%</td><td>1-877-378-8728</td></tr>
        <tr><td><strong>WS Leasing</strong></td><td>Lease Program</td><td>2018</td><td>120,000 km</td><td>$3,000</td><td>100%</td><td>7.99%–16.99%</td><td>1-888-975-3273</td></tr>
      </tbody>
    </table></div>
  </div>`;
}

// ── DYNAMIC EXTRA LENDER PANELS ──────────────────────────────────
// Called after loadTenantRates() — adds panels for uploaded unknown lenders
function initExtraLenderPanels(){
  const extra = window._extraLenders || {};
  if(!Object.keys(extra).length) return;

  const container  = document.getElementById('lender-panels');
  const tabStrip   = document.querySelector('.lender-tabs');
  if(!container || !tabStrip) return;

  // Remove existing extra panels so we don't duplicate on reload
  document.querySelectorAll('.lcontent.extra-lender').forEach(el => el.remove());
  document.querySelectorAll('.ltab.extra-ltab').forEach(el => el.remove());

  const inv = window.ffInventory || window.inventory || [];

  Object.entries(extra).forEach(([lid, lenderData]) => {
    const panelId  = `lq-extra-${lid}`;
    const tiers    = lenderData.tiers || [];
    const dispName = lenderData.name || lid.replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());

    // Build rate table rows from DB tiers
    const tierRows = tiers.map(t => `
      <tr>
        <td><strong>${t.tier}</strong></td>
        <td style="color:var(--amber);">${t.rate}%</td>
        <td>${t.minFico === 0 ? 'No Min' : t.minFico}${t.maxFico >= 9999 ? '+' : '–'+t.maxFico}</td>
        <td>${t.minYear || 2015}</td>
        <td>${t.maxMileage ? t.maxMileage.toLocaleString()+' km' : '—'}</td>
        <td>${t.maxCarfax ? '$'+t.maxCarfax.toLocaleString() : '—'}</td>
        <td>${t.maxLTV || 140}%</td>
      </tr>`).join('');

    const maxLTV     = tiers.length ? Math.max(...tiers.map(t=>t.maxLTV||140)) : 140;
    const maxMileage = tiers.length ? Math.max(...tiers.map(t=>t.maxMileage||200000)) : 200000;
    const maxCarfax  = tiers.length ? Math.max(...tiers.map(t=>t.maxCarfax||7500)) : 7500;
    const minRate    = tiers.length ? Math.min(...tiers.map(t=>t.rate||99)) : 0;
    const maxRate    = tiers.length ? Math.max(...tiers.map(t=>t.rate||0)) : 0;

    // Stock options for approval checker
    const stockOpts = inv.map(v =>
      `<option value="${v.stock}">${v.stock} — ${v.year} ${v.make} ${v.model} ($${(v.price||0).toLocaleString()})</option>`
    ).join('');

    const panel = `
    <div id="${panelId}" class="lcontent extra-lender">
      <div class="lender-header-box">
        <div class="lender-name-big">${dispName}</div>
        <div style="font-size:10px;background:rgba(6,182,212,.12);color:#06b6d4;border:1px solid rgba(6,182,212,.3);border-radius:4px;padding:2px 8px;display:inline-block;margin-bottom:8px;font-weight:700;letter-spacing:1px;">CUSTOM RATE SHEET</div>
        <div class="lender-contact-row">
          <div>Max LTV: <span>${maxLTV}%</span></div>
          <div>Max Mileage: <span>${maxMileage.toLocaleString()} km</span></div>
          <div>Max Carfax: <span>$${maxCarfax.toLocaleString()}</span></div>
        </div>
      </div>
      <table class="programs-table">
        <thead><tr><th>Tier</th><th>Rate</th><th>Beacon</th><th>Min Year</th><th>Max Mileage</th><th>Max Carfax</th><th>Max LTV</th></tr></thead>
        <tbody>${tierRows}</tbody>
      </table>
      <div class="checker-box">
        <div class="checker-title"><i data-lucide="search" class="ico"></i>Vehicle Approval Checker</div>
        <div class="fgroup">
          <label>Select Vehicle</label>
          <select id="chk-stock-extra-${lid}" onchange="checkExtraLenderApproval('${lid}')"
            style="background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:9px 12px;width:100%;font-family:'Outfit',sans-serif;">
            <option value="">— Select a vehicle —</option>
            ${stockOpts}
          </select>
        </div>
        <div id="chk-results-extra-${lid}"></div>
      </div>
    </div>`;

    container.innerHTML += panel;

    // Add tab button before Quick Ref
    const quickRefBtn = tabStrip.querySelector('.ltab[onclick*="quickref"]');
    const btn = document.createElement('button');
    btn.className = 'ltab extra-ltab';
    btn.setAttribute('onclick', `showLenderTab('${panelId}',this)`);
    btn.textContent = dispName.split(' ')[0]; // First word as short label
    if(quickRefBtn) tabStrip.insertBefore(btn, quickRefBtn);
    else tabStrip.appendChild(btn);
  });

  lucide.createIcons();
}

// ── Approval checker for extra lenders ───────────────────────────
function checkExtraLenderApproval(lid){
  const extra = window._extraLenders || {};
  const lenderData = extra[lid];
  if(!lenderData) return;
  const stock  = document.getElementById(`chk-stock-extra-${lid}`)?.value;
  const resDiv = document.getElementById(`chk-results-extra-${lid}`);
  if(!stock || !resDiv) return;
  const inv = window.ffInventory || window.inventory || [];
  const v = inv.find(x => x.stock === stock);
  if(!v){ resDiv.innerHTML = ''; return; }
  const curYear = new Date().getFullYear();
  const tiers   = lenderData.tiers || [];
  let html = '<div class="v-details-grid">';
  ['Year','Mileage','Price','Carfax'].forEach((k,i) => {
    const vals = [v.year, (v.mileage||0).toLocaleString()+' km', '$'+(v.price||0).toLocaleString(), '$'+(v.carfax||0).toLocaleString()];
    html += `<div class="vd-item"><div class="vd-label">${k}</div><div class="vd-value">${vals[i]}</div></div>`;
  });
  html += '</div>';
  // Check each tier
  tiers.forEach(t => {
    const yearOk = v.year >= (t.minYear||2015);
    const mileOk = (v.mileage||0) <= (t.maxMileage||999999);
    const cfxOk  = (v.carfax||0)  <= (t.maxCarfax||999999);
    const ageOk  = (curYear - v.year) + 6 <= 14;
    const pass   = yearOk && mileOk && cfxOk && ageOk;
    html += `<div class="val-row">
      <div><div class="val-req">${t.tier} — ${t.rate}%</div>
      <div class="val-sub">Beacon ${t.minFico === 0 ? 'No Min' : t.minFico+'+'}  · LTV ${t.maxLTV||140}%</div></div>
      <span class="status-pill ${pass?'pill-pass':'pill-fail'}">${pass?'✓ ELIGIBLE':'✗ INELIGIBLE'}</span>
    </div>`;
  });
  resDiv.innerHTML = html;
}

function showLenderTab(id, btn){
  document.querySelectorAll('.lcontent').forEach(c=>c.classList.remove('active'));
  document.querySelectorAll('.ltab').forEach(b=>b.classList.remove('active'));
  const panel = document.getElementById(id);
  if(panel) panel.classList.add('active');
  if(btn) btn.classList.add('active');
}

// ── APPROVAL CHECKER ──────────────────────────────────
function checkLenderApproval(lid){
  const stock = document.getElementById(`chk-stock-${lid}`).value;
  const resDiv = document.getElementById(`chk-results-${lid}`);
  const ltvDiv = document.getElementById(`chk-ltv-${lid}`);
  if(!stock){resDiv.innerHTML='';ltvDiv.style.display='none';return;}
  
  // Use correct inventory reference
  const inv = window.ffInventory || window.inventory || [];
  const v = inv.find(x=>x.stock===stock);
  
  // Handle missing vehicle
  if(!v){
    resDiv.innerHTML = `<div class="decision-box decision-rejected">⚠ Vehicle "${stock}" not found in inventory</div>`;
    ltvDiv.style.display='none';
    return;
  }
  
  const l = lenders[lid];
  const vHTML = `<div class="v-details-grid">
    <div class="vd-item"><div class="vd-label">Stock #</div><div class="vd-value" style="color:var(--amber);">${v.stock}</div></div>
    <div class="vd-item"><div class="vd-label">Year</div><div class="vd-value">${v.year}</div></div>
    <div class="vd-item"><div class="vd-label">Make</div><div class="vd-value">${v.make}</div></div>
    <div class="vd-item"><div class="vd-label">Model</div><div class="vd-value">${v.model}</div></div>
    <div class="vd-item"><div class="vd-label">Mileage</div><div class="vd-value">${(v.mileage||0).toLocaleString()} km</div></div>
    <div class="vd-item"><div class="vd-label">Price</div><div class="vd-value" style="color:var(--green);">$${(v.price||0).toLocaleString()}</div></div>
    <div class="vd-item"><div class="vd-label">Carfax</div><div class="vd-value">$${(v.carfax||0).toLocaleString()}</div></div>
    <div class="vd-item"><div class="vd-label">Condition</div><div class="vd-value">${v.condition||'—'}</div></div>
  </div>`;

  if(l.hard){
    const yearOk  = v.year    >= l.minYear;
    const mileOk  = l.maxMileage ? (v.mileage||0) <= l.maxMileage : true;
    const cfxOk   = l.maxCarfax  ? (v.carfax||0)  <= l.maxCarfax  : true;
    const approved = yearOk && mileOk && cfxOk;
    const decClass = approved?'decision-approved':'decision-rejected';
    const decText  = approved?'VEHICLE ELIGIBLE':'NOT ELIGIBLE';
    resDiv.innerHTML = vHTML+`
      <div class="val-row"><div><div class="val-req">Min Year Required</div><div class="val-sub">Requires ${l.minYear} — Vehicle is ${v.year}</div></div><span class="status-pill ${yearOk?'pill-pass':'pill-fail'}">${yearOk?'✓ PASS':'✗ FAIL'}</span></div>
      <div class="val-row"><div><div class="val-req">Max Mileage</div><div class="val-sub">Limit ${l.maxMileage?l.maxMileage.toLocaleString():'N/A'} km — Vehicle ${(v.mileage||0).toLocaleString()} km</div></div><span class="status-pill ${mileOk?'pill-pass':'pill-fail'}">${mileOk?'✓ PASS':'✗ FAIL'}</span></div>
      <div class="val-row"><div><div class="val-req">Max Carfax Damage</div><div class="val-sub">Limit ${l.maxCarfax?'$'+l.maxCarfax.toLocaleString():'N/A'} — Vehicle $${(v.carfax||0).toLocaleString()}</div></div><span class="status-pill ${cfxOk?'pill-pass':'pill-fail'}">${cfxOk?'✓ PASS':'✗ FAIL'}</span></div>
      <div class="decision-box ${decClass}">${decText}</div>`;
    ltvDiv.style.display = approved?'block':'none';
    if(approved){
      document.getElementById(`ltv-down-${lid}`).value=0;
      document.getElementById(`ltv-trade-${lid}`).value=0;
      document.getElementById(`ltv-fees-${lid}`).value=0;
      calcLTV(lid);
    }
  } else {
    resDiv.innerHTML = vHTML+`
      <div class="val-row"><div><div class="val-req">Approval Method</div><div class="val-sub">Full credit profile review required</div></div><span class="status-pill pill-na">Credit-Based</span></div>
      <div class="decision-box decision-credit">ℹ️ APPROVAL BASED ON FULL CREDIT PROFILE</div>`;
    ltvDiv.style.display = 'block';
    document.getElementById(`ltv-down-${lid}`).value=0;
    document.getElementById(`ltv-trade-${lid}`).value=0;
    document.getElementById(`ltv-fees-${lid}`).value=0;
    calcLTV(lid);
  }
}

function calcLTV(lid){
  const stock = document.getElementById(`chk-stock-${lid}`).value;
  if(!stock) return;
  const inv  = window.ffInventory || window.inventory || [];
  const v    = inv.find(x=>x.stock===stock);
  if(!v) return; // Vehicle not found
  const l    = lenders[lid];
  const down = parseFloat(document.getElementById(`ltv-down-${lid}`).value)||0;
  const trade= parseFloat(document.getElementById(`ltv-trade-${lid}`).value)||0;
  const fees = parseFloat(document.getElementById(`ltv-fees-${lid}`).value)||0;
  const price = v.price || 0;
  const totalCost = price + fees;
  const finance   = totalCost - down - trade;
  const bookVal   = v.bookValue || v.book_value || price; // Use book value for LTV, fallback to price
  const ltvPct    = bookVal > 0 ? (finance/bookVal)*100 : 0;
  const maxLoan   = (bookVal*l.maxLTV)/100;
  const ok        = ltvPct <= l.maxLTV;
  const barW      = Math.min((ltvPct/l.maxLTV)*100,100);
  const barClass  = ltvPct<=l.maxLTV*0.8?'ltv-ok':ltvPct<=l.maxLTV?'ltv-warn':'ltv-over';
  document.getElementById(`ltv-out-${lid}`).innerHTML = `
    <div class="cline"><span class="cl-label">Vehicle Price</span><span class="cl-value">${$f(price)}</span></div>
    <div class="cline"><span class="cl-label">Add-ons/Fees</span><span class="cl-value">+${$f(fees)}</span></div>
    <div class="cline"><span class="cl-label">Down Payment</span><span class="cl-value">-${$f(down)}</span></div>
    <div class="cline"><span class="cl-label">Trade-in</span><span class="cl-value">-${$f(trade)}</span></div>
    <div class="cline" style="border-top:2px solid var(--border2);margin-top:6px;padding-top:10px;"><span class="cl-label" style="font-size:15px;">Amount to Finance</span><span class="cl-value" style="font-size:16px;color:var(--amber);">${$f(finance)}</span></div>
    <div class="cline"><span class="cl-label">Your LTV</span><span class="cl-value" style="color:${ok?'var(--green)':'var(--red)'};">${ltvPct.toFixed(2)}% ${ok?'✓':'!'}</span></div>
    <div class="cline"><span class="cl-label">Max Loan Amount</span><span class="cl-value" style="color:var(--green);">${$f(maxLoan)}</span></div>
    <div class="ltv-bar-wrap"><div class="ltv-bar ${barClass}" style="width:${barW}%"></div></div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px;"><span>0%</span><span style="color:${ok?'var(--green)':'var(--red)'};font-weight:700;">${ltvPct.toFixed(1)}% of ${l.maxLTV}% max</span><span>${l.maxLTV}%</span></div>
    <div class="decision-box ${ok?'decision-approved':'decision-rejected'}" style="margin-top:10px;">${ok?'LTV WITHIN LIMITS':'LTV EXCEEDED — Increase down or reduce advance'}</div>`;
}

// ── COMPARE ALL LENDERS ENGINE ─────────────────────────
// ── COMPARE ENGINE: WILL THE LENDER BUY THIS CLIENT + CAR? ────────────────
// Loaded tenant rate sheets override hardcoded lender defaults
window._tenantRates = null; // populated by loadTenantRates() on page load

async function loadTenantRates(){
  try {
    if(!window.FF || !FF.isLoggedIn) return;
    const res  = await FF.apiFetch('/api/lenders/rates');
    const data = await res.json();
    if(data.success && data.hasCustomRates){
      window._tenantRates = {};
      data.rates.forEach(r => {
        const lid = r.lender_name;
        if(!window._tenantRates[lid]) window._tenantRates[lid] = [];
        window._tenantRates[lid].push(r);
      });
      console.log('%cTenant rate sheets loaded','color:#f59e0b;font-size:11px;',
        Object.keys(window._tenantRates).map(k=>k+':'+window._tenantRates[k].length+'tiers').join(' | '));
    }
    // Extra lenders: DB lenders not in the hardcoded lenders object
    // These get their own dynamic cards in Compare All
    if(data.success && data.extraLenders && Object.keys(data.extraLenders).length > 0){
      window._extraLenders = data.extraLenders;
      console.log('%cExtra lenders loaded','color:#06b6d4;font-size:11px;',
        Object.keys(data.extraLenders).join(', '));
    } else {
      window._extraLenders = {};
    }
    // Build dynamic panels now that _extraLenders is ready
    if(typeof initExtraLenderPanels === 'function') initExtraLenderPanels();
  } catch(e){
    window._extraLenders = {};
    /* silently fall back to hardcoded */
  }
}

// Returns the best qualifying program for a lender + beacon score
// Merges tenant DB rates over hardcoded defaults
function getQualifyingProgram(lid, beacon){
  const defaultFee = LENDER_FEES[lid] || 0;
  
  // Try tenant custom rates first
  if(window._tenantRates && window._tenantRates[lid] && window._tenantRates[lid].length){
    const rows = window._tenantRates[lid]
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
  return null;
}

function runComparison(){
  const stock   = document.getElementById('compareStock').value;
  const down    = parseFloat(document.getElementById('compareDown').value)||0;
  const trade   = parseFloat(document.getElementById('compareTrade').value)||0;
  const fees    = parseFloat(document.getElementById('compareFees').value)||0;
  const beacon  = parseInt(document.getElementById('compareBeacon')?.value)||0;
  const income  = parseFloat(document.getElementById('compareIncome')?.value)||0;
  const term    = parseInt(document.getElementById('compareTerm')?.value)||72;
  const existing= parseFloat(document.getElementById('compareExisting')?.value)||0;
  const ph      = document.getElementById('comparePlaceholder');
  const res     = document.getElementById('compareResults');
  const vCard   = document.getElementById('compareVehicleCard');
  if(!stock){ph.style.display='block';res.style.display='none';vCard.style.display='none';return;}
  const src = window.ffInventory || window.inventory || [];
  const v = src.find(x=>x.stock===stock);
  if(!v) return;
  const curYear = new Date().getFullYear();
  ph.style.display='none'; vCard.style.display='block'; res.style.display='block';
  const simEl = document.getElementById('beaconSimulator');
  if(simEl) simEl.style.display = 'block';

  vCard.innerHTML = `
    <div style="font-size:10px;opacity:.6;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;">Selected Vehicle</div>
    <div style="font-size:20px;font-weight:800;margin-bottom:12px;">${v.year} ${v.make} ${v.model}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;">
      ${[['Stock',v.stock],['Mileage',(v.mileage||0).toLocaleString()+' km'],['Price','$'+(v.price||0).toLocaleString()],['Carfax','$'+(v.carfax||0).toLocaleString()],['Type',v.type||'—']].map(([k,val])=>`<div style="background:rgba(255,255,255,.08);border-radius:6px;padding:8px;"><div style="font-size:10px;opacity:.6;text-transform:uppercase;margin-bottom:4px;">${k}</div><div style="font-weight:700;">${val}</div></div>`).join('')}
    </div>`;

  // Read BK/proposal flag and book value override from UI
  const hasBK        = document.getElementById('compareBK')?.checked || false;
  const bookValOver  = parseFloat(document.getElementById('compareBookVal')?.value) || 0;
  const coBeacon     = parseInt(document.getElementById('compareCoBeacon')?.value)  || 0;
  const coIncome     = parseFloat(document.getElementById('compareCoIncome')?.value) || 0;
  const combinedIncome = income + coIncome;
  // Effective beacon: lenders use primary beacon for tier matching
  // but some use lower of two — dealer can toggle via co-app beacon field
  const hasCoApp = coIncome > 0 || coBeacon > 0;
  // Override income used in evaluateLender with combined income
  // evaluateLender reads `income` from closure — reassign here
  // We store original for display purposes
  const primaryIncome = income;

  // Contract rate for gross/reserve calc
  const contractRate = parseFloat(document.getElementById('compareContractRate')?.value) || 0;

  // Save compare session to localStorage
  try {
    localStorage.setItem('ffCompareSession', JSON.stringify({
      stock, down, trade, fees, term, beacon,
      income, existing, contractRate,
      bookVal: document.getElementById('compareBookVal')?.value || '',
      condition: document.getElementById('compareCondition')?.value || '',
      coBeacon: document.getElementById('compareCoBeacon')?.value || '',
      coIncome: document.getElementById('compareCoIncome')?.value || '',
      bk: document.getElementById('compareBK')?.checked || false,
      gstEnabled: document.getElementById('compareGst')?.checked || false,
      savedAt: Date.now()
    }));
  } catch(e){}

  // GST setting — read from compare toggle or fall back to dealer settings
  const compareGstEl  = document.getElementById('compareGst');
  const gstEnabled    = compareGstEl ? compareGstEl.checked : false;
  const gstRate       = gstEnabled ? (parseFloat(document.getElementById('gstRate')?.value) || settings.gst || 5) : 0;

  // ── Core per-lender evaluator — shared by hardcoded and extra lenders ──────
  function evaluateLender(lid, l, prog) {
    const income = combinedIncome; // use combined primary + co-app income for PTI/DTI
    const lenderFee  = prog ? (prog.fee || 0) : 0;
    // GST-correct ATF: tax applies to (price + fees - trade), then subtract down and add lender fee
    const taxableBase = v.price + fees - trade;
    const gstAmt      = taxableBase * (gstRate / 100);
    const atf         = taxableBase + gstAmt + lenderFee - down;
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
    const condOverride = document.getElementById('compareCondition')?.value || '';
    const cond       = (condOverride || v.condition || 'Average').toLowerCase();
    const condMult   = (cond === 'rough' || cond === 'very rough') ? 0.90 : 1.0;
    const maxMile    = Math.floor(rawMaxMile * condMult);

    const yearOk     = v.year >= minYear;
    const mileOk     = (v.mileage||0) <= maxMile;
    const cfxOk      = (v.carfax||0)  <= maxCfx;
    const incomeOk   = lMinIncome === 0 || income === 0 || income >= lMinIncome;

    // ── Term optimization: try 48/60/72/84 ───────────────────────────────────
    const ALL_TERMS   = [48, 60, 72, 84];
    const buyRate     = prog && prog.rate > 0 ? prog.rate : 8.99;
    const termResults = {};

    ALL_TERMS.forEach(t => {
      const ageAtPayoff = (curYear - v.year) + (t / 12);
      const ageOkT      = ageAtPayoff <= 14;
      const pmt         = atf > 0 ? BPMT(buyRate, t, atf) : 0;
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

    // Best term = shortest that passes all gates (least interest risk for lender)
    // Optimal term = longest that passes (lowest payment for customer)
    const passingTerms = ALL_TERMS.filter(t => termResults[t].passes);
    const bestTerm     = passingTerms.length ? passingTerms[0]      : term; // shortest
    const optimalTerm  = passingTerms.length ? passingTerms[passingTerms.length-1] : term; // longest

    // Use selected term for primary display, best term as recommendation
    const selResult    = termResults[term] || termResults[72];
    const payment      = selResult.payment;
    const ptiPct       = selResult.ptiPct;
    const dtiPct       = selResult.dtiPct;
    const ptiOk        = selResult.ptiOk;
    const dtiOk        = selResult.dtiOk;
    const payOk        = selResult.payOk;
    const vehicleAgeAtPayoff = selResult.ageAtPayoff;
    const ageOk        = selResult.ageOk;

    // ── Gross estimate ────────────────────────────────────────────────────────
    // Flat dealer reserve (already in lenderFee for display lenders, 0 here as it's in ATF)
    // Rate spread reserve: if contract rate entered, estimate additional gross
    const flatReserve  = prog ? (prog.fee || lenderFee || 0) : lenderFee;
    let spreadReserve  = 0;
    let totalGross     = flatReserve;
    if (contractRate > 0 && contractRate > buyRate) {
      const spread = contractRate - buyRate;
      // Approximate: spread * ATF * term factor (simplified actuarial)
      spreadReserve = Math.round((spread / 100 / 12) * atf * optimalTerm * 0.82);
      totalGross    = flatReserve + spreadReserve;
    }

    // ── Structuring tips — min down for EVERY failure type ──────────
    let structureTip = null;
    const structureTips = []; // collect all applicable tips

    // LTV fail: add down
    if (!ltvOk && downNeeded > 0) {
      const fixedPmt = BPMT(buyRate, optimalTerm, atf - downNeeded);
      structureTips.push(`Add $${downNeeded.toLocaleString()} down → LTV passes (${$f(fixedPmt)}/mo at ${optimalTerm}mo)`);
    }

    // PTI fail: try 84mo first, then calculate min down
    if (income > 0 && !ptiOk) {
      if (termResults[84] && termResults[84].ptiOk && ltvOk) {
        structureTips.push(`Extend to 84mo → PTI drops to ${termResults[84].ptiPct.toFixed(1)}% (${$f(termResults[84].payment)}/mo) ✓`);
      } else if (ltvOk) {
        // Calc min down so payment * lMaxPti/100 * income passes — solve for atf
        // payment = BPMT(rate, term, atf) <= income * lMaxPti / 100
        // target_payment = income * lMaxPti / 100
        const targetPmt = income * lMaxPti / 100;
        const mr = buyRate / 100 / 12;
        const maxAtfForPti = mr > 0
          ? targetPmt * (Math.pow(1+mr, optimalTerm) - 1) / (mr * Math.pow(1+mr, optimalTerm))
          : targetPmt * optimalTerm;
        const downForPti = Math.ceil(atf - maxAtfForPti);
        if (downForPti > 0) structureTips.push(`Add $${downForPti.toLocaleString()} down → PTI within ${lMaxPti}% at ${optimalTerm}mo`);
      }
    }

    // Pay call fail: try 84mo, then calc min down
    if (income > 0 && lMaxPay && !payOk) {
      if (termResults[84] && termResults[84].payOk && ltvOk) {
        structureTips.push(`Extend to 84mo → payment ${$f(termResults[84].payment)}/mo within pay call ✓`);
      } else if (ltvOk) {
        const mr = buyRate / 100 / 12;
        const maxAtfForPay = mr > 0
          ? lMaxPay * (Math.pow(1+mr, optimalTerm) - 1) / (mr * Math.pow(1+mr, optimalTerm))
          : lMaxPay * optimalTerm;
        const downForPay = Math.ceil(atf - maxAtfForPay);
        if (downForPay > 0) structureTips.push(`Add $${downForPay.toLocaleString()} down → payment within $${lMaxPay}/mo pay call`);
      }
    }

    // DTI fail: same approach
    if (income > 0 && !dtiOk && ltvOk) {
      const targetDtiPmt = (income * lMaxDti / 100) - existing;
      if (targetDtiPmt > 0) {
        const mr = buyRate / 100 / 12;
        const maxAtfForDti = mr > 0
          ? targetDtiPmt * (Math.pow(1+mr, optimalTerm) - 1) / (mr * Math.pow(1+mr, optimalTerm))
          : targetDtiPmt * optimalTerm;
        const downForDti = Math.ceil(atf - maxAtfForDti);
        if (downForDti > 0) structureTips.push(`Add $${downForDti.toLocaleString()} down → DTI within ${lMaxDti}%`);
      }
    }

    // Income fail: show what income is needed
    if (!incomeOk && lMinIncome > 0 && income > 0) {
      structureTips.push(`Income $${income.toLocaleString()} below min $${lMinIncome.toLocaleString()} — co-applicant could bridge gap`);
    }

    structureTip = structureTips.length ? structureTips[0] : null; // primary tip
    const allStructureTips = structureTips; // full list for display

    // Co-app tip: if primary fails PTI but combined passes, flag it
    let coAppTip = null;
    if (hasCoApp && primaryIncome > 0 && !ptiOk) {
      const primaryPti = payment > 0 ? (payment / primaryIncome) * 100 : 0;
      if (primaryPti > lMaxPti && ptiPct <= lMaxPti) {
        coAppTip = `Co-app income required — primary PTI ${primaryPti.toFixed(1)}% exceeds ${lMaxPti}%, combined ${ptiPct.toFixed(1)}% ✓`;
      }
    }

    return {
      lid, l, prog, atf, ltvPct, maxLTV, ltvOk, maxLoan, bookVal, downNeeded,
      yearOk, mileOk, cfxOk, ageOk, minYear, maxMile, maxCfx,
      payment, ptiPct, dtiPct, ptiOk, dtiOk, payOk, incomeOk,
      lMaxPti, lMaxDti, lMinIncome, lMaxPay,
      term, bestTerm, optimalTerm, termResults, passingTerms,
      flatReserve, spreadReserve, totalGross, contractRate, buyRate,
      beacon, income, primaryIncome, coIncome, hasCoApp, existing, lenderFee, hasBK,
      vehicleAgeAtPayoff, v, cond, structureTip, allStructureTips, coAppTip
    };
  }

  const eligible=[], ineligible=[];

  Object.entries(lenders).forEach(([lid, l])=>{
    const prog = getQualifyingProgram(lid, beacon);
    const r    = evaluateLender(lid, l, prog);

    const vehiclePass = r.yearOk && r.mileOk && r.cfxOk && r.ageOk;
    const dealPass    = r.ltvOk && r.ptiOk && r.dtiOk && r.payOk && r.incomeOk;
    const hasBeacon   = beacon > 0;
    const beaconPass  = !hasBeacon || prog !== null;
    r.type        = l.hard ? 'hard' : 'credit';
    r.vehiclePass = vehiclePass;
    r.dealPass    = dealPass;
    r.beaconPass  = beaconPass;

    // A lender is eligible if vehicle passes AND beacon passes AND
    // either no income entered OR all deal gates pass
    if(l.hard){
      r.approved = vehiclePass && beaconPass && (income === 0 || dealPass) && r.ltvOk;
    } else {
      r.approved = beaconPass && (income === 0 || dealPass) && r.ltvOk;
    }
    (r.approved ? eligible : ineligible).push(r);
  });

  // ── Extra dynamic lenders (uploaded PDFs not in hardcoded list) ──
  const extraLenders = window._extraLenders || {};
  Object.entries(extraLenders).forEach(([lid, lenderData]) => {
    const tiers = lenderData.tiers || [];
    if (!tiers.length) return;

    // Find best qualifying tier by beacon score
    let prog = null;
    if (beacon > 0) {
      const matching = tiers.filter(t => beacon >= t.minFico && beacon <= t.maxFico);
      if (matching.length) {
        const best = matching.sort((a,b) => a.rate - b.rate)[0];
        prog = { tier: best.tier, rate: best.rate, maxLTV: best.maxLTV,
                 minYear: best.minYear, maxMileage: best.maxMileage,
                 maxCarfax: best.maxCarfax, fee: best.fee, isCustom: true };
      }
    } else {
      const sorted = [...tiers].sort((a,b) => a.rate - b.rate);
      if (sorted.length) prog = { ...sorted[0], isEstimate: true, isCustom: true };
    }

    const l = {
      name: lenderData.name, phone: '', web: '', hard: true,
      maxPti: 20, maxDti: 44, minIncome: 0, maxPayment: null,
      minYear:    Math.min(...tiers.map(t => t.minYear    || 2015)),
      maxMileage: Math.max(...tiers.map(t => t.maxMileage || 200000)),
      maxCarfax:  Math.max(...tiers.map(t => t.maxCarfax  || 7500)),
      maxLTV:     Math.max(...tiers.map(t => t.maxLTV     || 140)),
      programs: tiers.map(t => ({ tier: t.tier, rate: String(t.rate),
                                   fico: `${t.minFico}-${t.maxFico === 9999 ? '∞' : t.maxFico}` }))
    };

    const r    = evaluateLender(lid, l, prog);
    r.type        = 'hard';
    r.vehiclePass = r.yearOk && r.mileOk && r.cfxOk && r.ageOk;
    r.dealPass    = r.ltvOk && r.ptiOk && r.dtiOk && r.payOk && r.incomeOk;
    r.beaconPass  = beacon === 0 || prog !== null;
    r.approved    = r.vehiclePass && r.beaconPass && (income === 0 || r.dealPass) && r.ltvOk;
    (r.approved ? eligible : ineligible).push(r);
  });

  // ── Sort eligible: by priority score (rate + gross potential + passing terms) ─
  eligible.sort((a, b) => {
    const rA = a.prog ? a.prog.rate : 99;
    const rB = b.prog ? b.prog.rate : 99;
    // Secondary sort: more passing terms = more flexible lender
    const ptA = a.passingTerms ? a.passingTerms.length : 0;
    const ptB = b.passingTerms ? b.passingTerms.length : 0;
    // Primary: lowest rate, tiebreak: more term flexibility
    if (Math.abs(rA - rB) > 0.5) return rA - rB;
    return ptB - ptA;
  });

  // ── Best deal summary ─────────────────────────────────────────────────────
  let bestLabel = '', bestPayLabel = '', bestGrossLabel = '';
  if (eligible.length) {
    const bestRate = eligible.find(r => r.prog && r.prog.rate > 0);
    if (bestRate) {
      const optPmt = bestRate.termResults[bestRate.optimalTerm]?.payment || bestRate.payment;
      bestLabel = `<div class="sum-pill sum-amber">★ ${bestRate.prog.rate}% @ ${bestRate.l.name.split(' ')[0]}</div>`;
      bestPayLabel = `<div class="sum-pill" style="background:rgba(16,185,129,.15);color:var(--green);border:1px solid rgba(16,185,129,.3);">⬇ ${$f(optPmt)}/mo (${bestRate.optimalTerm}mo)</div>`;
    }
    // Best gross (if contract rate entered)
    const grossLenders = eligible.filter(r => r.totalGross > 0);
    if (grossLenders.length) {
      const bestGross = grossLenders.sort((a,b) => b.totalGross - a.totalGross)[0];
      bestGrossLabel = `<div class="sum-pill" style="background:rgba(245,158,11,.15);color:var(--amber);border:1px solid rgba(245,158,11,.3);">$ Est. Gross: ${$f(bestGross.totalGross)} @ ${bestGross.l.name.split(' ')[0]}</div>`;
    }
  }

  const beaconNote = beacon > 0
    ? `<div class="sum-pill sum-blue">Beacon: ${beacon}</div>`
    : `<div class="sum-pill" style="background:rgba(245,158,11,.15);color:var(--amber);border:1px solid rgba(245,158,11,.3);">⚠ Enter Beacon for exact tiers</div>`;
  const incNote = income > 0
    ? `<div class="sum-pill sum-blue">PTI/DTI Active</div>`
    : `<div class="sum-pill" style="background:rgba(100,100,100,.15);color:var(--muted);border:1px solid var(--border);">Enter income for PTI/DTI check</div>`;
  const taxBase = v.price + fees - trade;
  const atfVal  = taxBase * (1 + gstRate/100) - down;

  document.getElementById('compareSummaryBar').innerHTML = `
    <div class="sum-pill sum-green">${eligible.length} Will Buy</div>
    <div class="sum-pill sum-red">${ineligible.length} Declined</div>
    <div class="sum-pill sum-blue">ATF: ${$f(atfVal)}</div>
    ${bestLabel}${bestPayLabel}${bestGrossLabel}${beaconNote}${incNote}`;

  document.getElementById('eligibleCount').textContent = eligible.length;
  document.getElementById('compareEligible').innerHTML = eligible.map(r=>buildLenderCard(r,v,false)).join('');
  const inelLabel = document.getElementById('ineligibleLabel');
  if(ineligible.length > 0){
    inelLabel.style.display='flex';
    document.getElementById('ineligibleCount').textContent = ineligible.length;
    document.getElementById('compareIneligible').innerHTML = ineligible.map(r=>buildLenderCard(r,v,true)).join('');
  } else {
    inelLabel.style.display='none';
    document.getElementById('compareIneligible').innerHTML='';
  }

  // Inject approval probabilities
  if (window.ProbabilityDisplay) {
    setTimeout(() => window.ProbabilityDisplay.injectProbabilities(), 150);
  }
  // Render submission tracker (shows existing submissions for this deal)
  setTimeout(renderSubmissionTracker, 100);
  // Beacon range simulator
  setTimeout(runBeaconSimulator, 120);
}

function buildLenderCard(r, v, isIneligible){
  const l    = r.l;
  const prog = r.prog;
  const curYear = new Date().getFullYear();

  if(isIneligible){
    const reasons = [];
    if(!r.yearOk)       reasons.push(`Year ${v.year} below min ${r.minYear}`);
    if(!r.mileOk)       reasons.push(`Mileage ${(v.mileage||0).toLocaleString()} km > max ${(r.maxMile||0).toLocaleString()} km${r.cond&&r.cond!=='average'?' ('+r.cond+' condition)':''}`);
    if(!r.cfxOk)        reasons.push(`Carfax $${(v.carfax||0).toLocaleString()} > max $${(r.maxCfx||0).toLocaleString()}`);
    if(r.ageOk===false) reasons.push(`Age at payoff ${r.vehicleAgeAtPayoff.toFixed(1)} yrs exceeds 14 yr limit`);
    if(!r.beaconPass)   reasons.push(`Beacon ${r.beacon} — no qualifying tier`);
    if(!r.ltvOk)        reasons.push(`LTV ${r.ltvPct.toFixed(1)}% exceeds ${r.maxLTV}% max — need $${(r.downNeeded||0).toLocaleString()} more down`);
    if(r.ptiOk===false) reasons.push(`PTI ${r.ptiPct.toFixed(1)}% exceeds ${r.lMaxPti}% limit`);
    if(r.dtiOk===false) reasons.push(`DTI ${r.dtiPct.toFixed(1)}% exceeds ${r.lMaxDti}% limit`);
    if(r.payOk===false) reasons.push(`Payment ${$f(r.payment)} exceeds max ${$f(r.lMaxPay)} for this lender`);
    if(r.incomeOk===false) reasons.push(`Income $${(r.income||0).toLocaleString()} below min $${(r.lMinIncome||0).toLocaleString()}/mo`);
    const rateRange = l.programs ? l.programs.map(p=>p.rate).join(' / ') : '—';
    // Show "what would it take" tip if only LTV fails
    const fixTip = (r.allStructureTips && r.allStructureTips.length)
      ? `<div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:6px;padding:8px 10px;margin-top:8px;font-size:11px;color:var(--amber);font-weight:600;">
           ${r.allStructureTips.map((t,i) => `<div style="${i>0?'margin-top:5px;padding-top:5px;border-top:1px solid rgba(245,158,11,.2);':''}">💡 ${t}</div>`).join('')}
         </div>`
      : '';
    return `<div class="lender-card ineligible">
      <div class="lc-header ineligible"><span class="lc-name">${l.name}</span><span class="lc-check" style="color:var(--red);">✗</span></div>
      <div class="lc-body">
        ${reasons.map(rs=>`<div class="fail-reason">${rs}</div>`).join('')}
        ${fixTip}
        <div class="lc-row" style="margin-top:8px;"><span class="lc-lbl">Rate Range</span><span class="lc-val">${rateRange}</span></div>
      </div></div>`;
  }

  const isCredit = r.type === 'credit';
  const barW     = Math.min((r.ltvPct / r.maxLTV) * 100, 100);
  const barClass = r.ltvPct <= r.maxLTV*0.8 ? 'ltv-ok' : r.ltvPct <= r.maxLTV ? 'ltv-warn' : 'ltv-over';
  const ageWarn  = r.vehicleAgeAtPayoff > 12;

  const tierBadge = prog
    ? `<div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:5px;padding:5px 10px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;"><span style="font-size:11px;font-weight:700;color:var(--green);">${prog.tier}${prog.isCustom?' ★':''}</span><span style="font-size:13px;font-weight:800;color:var(--green);">${prog.rate}%${prog.isEstimate?' (est.)':''}</span></div>`
    : `<div style="background:rgba(30,90,246,.1);border:1px solid rgba(30,90,246,.25);border-radius:5px;padding:5px 10px;margin-bottom:10px;font-size:11px;color:var(--primary);">${r.beacon > 0 ? 'No matching tier for beacon '+r.beacon : 'Enter beacon score to match tier'}</div>`;
  // ── Multi-term payment grid ────────────────────────────────────────
  const ALL_TERMS_CARD = [48, 60, 72, 84];
  const termGrid = r.termResults ? `
    <div style="margin:8px 0 10px;">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:700;">Payment by Term</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;">
        ${ALL_TERMS_CARD.map(t => {
          const tr = r.termResults[t];
          if (!tr) return '';
          const isSelected = t === r.term;
          const isOptimal  = t === r.optimalTerm;
          const isBest     = t === r.bestTerm;
          const passes     = tr.passes;
          const bg = passes
            ? (isOptimal ? 'rgba(16,185,129,.25)' : 'rgba(16,185,129,.1)')
            : 'rgba(239,68,68,.08)';
          const border = isOptimal ? '1px solid rgba(16,185,129,.6)' : passes ? '1px solid rgba(16,185,129,.25)' : '1px solid rgba(239,68,68,.2)';
          const badge = isOptimal ? '<div style="font-size:8px;color:var(--green);font-weight:800;margin-bottom:2px;">OPTIMAL</div>'
                      : isBest    ? '<div style="font-size:8px;color:var(--amber);font-weight:800;margin-bottom:2px;">SHORTEST</div>'
                      : isSelected? '<div style="font-size:8px;color:var(--muted);margin-bottom:2px;">SELECTED</div>' : '<div style="margin-bottom:10px;"></div>';
          return `<div style="background:${bg};border:${border};border-radius:6px;padding:6px 4px;text-align:center;">
            ${badge}
            <div style="font-size:11px;font-weight:800;color:${passes?'var(--green)':'var(--muted)'};">${$f(tr.payment)}</div>
            <div style="font-size:9px;color:var(--muted);">${t}mo</div>
            <div style="font-size:9px;margin-top:2px;">${passes?'<span style="color:var(--green);">✓</span>':'<span style="color:var(--red);">✗</span>'}</div>
          </div>`;
        }).join('')}
      </div>
      ${r.optimalTerm !== r.term ? `<div style="font-size:10px;color:var(--green);margin-top:5px;font-weight:600;">💡 Optimal: ${r.optimalTerm}mo at ${$f(r.termResults[r.optimalTerm]?.payment)}/mo</div>` : ''}
    </div>` : '';

  // Gross display
  const grossRow = r.flatReserve > 0 || r.spreadReserve > 0
    ? `<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:6px;padding:8px 10px;margin:8px 0;">
         <div style="font-size:10px;color:var(--amber);font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Est. Gross</div>
         ${r.flatReserve > 0 ? `<div style="display:flex;justify-content:space-between;font-size:11px;"><span style="color:var(--muted);">Flat Reserve</span><span style="font-weight:700;">${$f(r.flatReserve)}</span></div>` : ''}
         ${r.spreadReserve > 0 ? `<div style="display:flex;justify-content:space-between;font-size:11px;"><span style="color:var(--muted);">Rate Spread (est.)</span><span style="font-weight:700;">${$f(r.spreadReserve)}</span></div>` : ''}
         <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:800;border-top:1px solid rgba(245,158,11,.2);margin-top:4px;padding-top:4px;"><span style="color:var(--amber);">Total Est. Gross</span><span style="color:var(--amber);">${$f(r.totalGross)}</span></div>
         ${r.spreadReserve > 0 ? `<div style="font-size:9px;color:var(--muted);margin-top:3px;">Rate spread at ${r.contractRate}% contract vs ${r.buyRate}% buy — estimate only</div>` : ''}
       </div>` : '';

  const paymentRow = ''; // replaced by termGrid above
  const coAppBadge = r.hasCoApp && r.coIncome > 0
    ? `<div style="font-size:10px;background:rgba(6,182,212,.12);color:#06b6d4;border:1px solid rgba(6,182,212,.3);border-radius:4px;padding:3px 8px;margin-bottom:6px;font-weight:700;">
         CO-APP INCOME INCLUDED — Primary $${(r.primaryIncome||0).toLocaleString()} + Co-app $${(r.coIncome||0).toLocaleString()} = $${(r.income||0).toLocaleString()}/mo
       </div>` : '';
  const coAppTipRow = r.coAppTip
    ? `<div style="background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.25);border-radius:5px;padding:6px 10px;font-size:11px;color:#06b6d4;font-weight:600;margin-bottom:6px;">ℹ️ ${r.coAppTip}</div>` : '';
  const ptiRow = r.income > 0
    ? `${coAppBadge}${coAppTipRow}<div class="lc-row"><span class="lc-lbl">PTI (max ${r.lMaxPti}%)</span><span class="lc-val ${r.ptiOk?'green':'red'}">${r.ptiPct.toFixed(1)}% ${r.ptiOk?'✓ PASS':'✗ HIGH'}</span></div>
       <div class="lc-row"><span class="lc-lbl">DTI (max ${r.lMaxDti}%)</span><span class="lc-val ${r.dtiOk?'green':'red'}">${r.dtiPct.toFixed(1)}% ${r.dtiOk?'✓ PASS':'✗ HIGH'}</span></div>
       ${r.lMinIncome>0?`<div class="lc-row"><span class="lc-lbl">Min Income</span><span class="lc-val ${r.incomeOk?'green':'red'}">$${(r.income||0).toLocaleString()} ${r.incomeOk?'✓':'✗ Need $'+r.lMinIncome.toLocaleString()}</span></div>`:''}
       ${r.lMaxPay?`<div class="lc-row"><span class="lc-lbl">Max Pay Call</span><span class="lc-val ${r.payOk?'green':'red'}">${$f(r.payment)} ${r.payOk?'✓':'✗ Limit '+$f(r.lMaxPay)}</span></div>`:''}`
    : `<div class="lc-row" style="opacity:.5;"><span class="lc-lbl">PTI/DTI/Income</span><span class="lc-val" style="font-size:10px;">Enter income above</span></div>`;
  const ageRow = ageWarn
    ? `<div class="lc-row" style="background:rgba(245,158,11,.08);border-radius:4px;padding:4px 6px;"><span class="lc-lbl" style="color:var(--amber);">⚠ Age at Payoff</span><span class="lc-val" style="color:var(--amber);">${r.vehicleAgeAtPayoff.toFixed(1)} yrs</span></div>` : '';
  const feeRow = r.lenderFee > 0
    ? `<div class="lc-row" style="opacity:.7;"><span class="lc-lbl">Lender Fee (incl.)</span><span class="lc-val">${$f(r.lenderFee)}</span></div>` : '';
  const customBadge = (prog && prog.isCustom)
    ? `<span style="font-size:9px;background:rgba(245,158,11,.2);color:var(--amber);border-radius:3px;padding:2px 5px;margin-left:6px;letter-spacing:.5px;">CUSTOM RATES</span>` : '';

  // Encode lender data for the approval modal
  const _lname = encodeURIComponent(l.name);
  const _rate  = r.prog ? r.prog.rate : 0;
  const _term  = r.term || 72;
  const _atf   = Math.round(r.atf);
  const _ltv   = r.ltvPct.toFixed(1);
  const _bcn   = r.beacon || 0;
  const _stock = encodeURIComponent(v.stock || '');
  const _book  = Math.round(r.bookVal || 0);

  return `<div class="lender-card ${isCredit?'credit-based':''}">
    <div class="lc-header ${isCredit?'credit':'eligible'}"><span class="lc-name">${l.name}${customBadge}</span><span class="lc-check">${isCredit?'ℹ️':'✓'}</span></div>
    <div class="lc-body">
      ${isCredit?`<div style="font-size:11px;background:rgba(30,90,246,.15);color:var(--primary);padding:5px 10px;border-radius:5px;margin-bottom:8px;font-weight:700;">Credit Profile Decision — Full Application Required</div>`:''}
      ${tierBadge}${termGrid}${grossRow}${ptiRow}${ageRow}
      <div class="lc-row"><span class="lc-lbl">LTV (incl. fees)</span><span class="lc-val ${r.ltvOk?'green':'red'}">${r.ltvPct.toFixed(1)}% / ${r.maxLTV}% max ${r.ltvOk?'✓':'!'}</span></div>
      <div class="lc-row"><span class="lc-lbl">Max Loan</span><span class="lc-val green">${$f(r.maxLoan)}</span></div>
      <div class="lc-row"><span class="lc-lbl">ATF (w/ lender fee)</span><span class="lc-val">${$f(r.atf)}</span></div>
      ${feeRow}
      <div class="ltv-bar-wrap"><div class="ltv-bar ${barClass}" style="width:${barW}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:10px;margin-top:3px;color:var(--muted);"><span>0%</span><span style="color:${r.ltvOk?'var(--green)':'var(--red)'};">${r.ltvPct.toFixed(1)}% / ${r.maxLTV}%</span><span>${r.maxLTV}%</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;">
        <button onclick="openApprovalModal('${_lname}',${_rate},${_term},${_atf},${_ltv},${_bcn},'${_stock}',${_book})"
          style="padding:9px 6px;background:linear-gradient(135deg,rgba(16,185,129,.15),rgba(16,185,129,.08));border:1px solid rgba(16,185,129,.4);border-radius:7px;color:var(--green);font-weight:800;font-size:11px;letter-spacing:.3px;cursor:pointer;transition:all .2s;"
          onmouseover="this.style.background='rgba(16,185,129,.25)'"
          onmouseout="this.style.background='linear-gradient(135deg,rgba(16,185,129,.15),rgba(16,185,129,.08))'">
          ✓ APPLY APPROVAL
        </button>
        <button onclick="copyDealPackage('${_lname}')"
          style="padding:9px 6px;background:rgba(30,90,246,.1);border:1px solid rgba(30,90,246,.3);border-radius:7px;color:var(--primary);font-weight:800;font-size:11px;letter-spacing:.3px;cursor:pointer;transition:all .2s;"
          onmouseover="this.style.background='rgba(30,90,246,.2)'"
          onmouseout="this.style.background='rgba(30,90,246,.1)'"
          title="Copy formatted deal summary for lender submission">
          📋 COPY PACKAGE
        </button>
        <button onclick="logSubmission('${l.name}')"
          style="padding:9px 6px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);border-radius:7px;color:var(--amber);font-weight:800;font-size:11px;letter-spacing:.3px;cursor:pointer;transition:all .2s;grid-column:1/-1;"
          onmouseover="this.style.background='rgba(245,158,11,.2)'"
          onmouseout="this.style.background='rgba(245,158,11,.1)'"
          title="Log this lender submission in the tracker">
          📤 LOG SUBMISSION
        </button>
      </div>
    </div></div>`;
}
// ── SAVE / LOAD ───────────────────────────────────────
function getVal(id){const e=document.getElementById(id);return e?e.value:'';}
function setVal(id,v){const e=document.getElementById(id);if(e&&v!=null)e.value=v;}
function getDealData(){
  return {
    ts:new Date().toISOString(),
    vehicle:{stock:getVal('stockNum'),desc:getVal('vehicleDesc'),vin:getVal('vin'),km:getVal('odometer'),condition:getVal('condition'),type:getVal('vehicleType')},
    financial:{price:getVal('sellingPrice'),finalDown:getVal('finalDown')||'0',doc:getVal('docFee'),tAllow:getVal('tradeAllow'),tPayoff:getVal('tradePayoff'),apr:getVal('apr'),gst:getVal('gstRate')},
    products:{vscPrice:getVal('vscPrice'),vscCost:getVal('vscCost'),gapPrice:getVal('gapPrice'),gapCost:getVal('gapCost'),twPrice:getVal('twPrice'),twCost:getVal('twCost'),waPrice:getVal('waPrice'),waCost:getVal('waCost')},
    customer:{name:getVal('custName'),phone:getVal('custPhone'),email:getVal('custEmail'),beacon:getVal('creditScore'),income:getVal('monthlyIncome')},
    costs:{acv:getVal('unitAcv'),recon:getVal('recon'),pack:getVal('lotPack')}
  };
}
function saveDeal(){
  const d = getDealData();
  localStorage.setItem('ffCurrentDeal',JSON.stringify(d));
  toast('Deal saved');
  return d;
}
function loadDeal(){
  const s = localStorage.getItem('ffCurrentDeal');
  if(!s){toast('No saved deal');return;}
  const d = JSON.parse(s);
  const v = d.vehicle||{};const f = d.financial||{};const p = d.products||{};const c = d.customer||{};const co = d.costs||{};
  setVal('stockNum',v.stock);setVal('vehicleDesc',v.desc);setVal('vin',v.vin);setVal('odometer',v.km);setVal('condition',v.condition);setVal('vehicleType',v.type);
  setVal('sellingPrice',f.price);setVal('docFee',f.doc);setVal('tradeAllow',f.tAllow);setVal('tradePayoff',f.tPayoff);setVal('apr',f.apr);setVal('gstRate',f.gst);
  setVal('vscPrice',p.vscPrice);setVal('vscCost',p.vscCost);setVal('gapPrice',p.gapPrice);setVal('gapCost',p.gapCost);setVal('twPrice',p.twPrice);setVal('twCost',p.twCost);setVal('waPrice',p.waPrice);setVal('waCost',p.waCost);
  setVal('custName',c.name);setVal('custPhone',c.phone);setVal('custEmail',c.email);setVal('creditScore',c.beacon);setVal('monthlyIncome',c.income);
  setVal('unitAcv',co.acv);setVal('recon',co.recon);setVal('lotPack',co.pack);
  calculate();toast('Deal loaded');
}

// ── EMAIL ──────────────────────────────────────────────
function generateEmail(){
  const d = getDealData();const v=d.vehicle;const f=d.financial;const p=d.products;const c=d.customer;
  const person = getVal('salesName')||settings.salesName;
  const dealer = getVal('dealerName')||settings.dealerName;
  const price=parseFloat(f.price)||0,doc=parseFloat(f.doc)||0,tAllow=parseFloat(f.tAllow)||0,tPayoff=parseFloat(f.tPayoff)||0;
  const apr=parseFloat(f.apr)||6.99,gst=parseFloat(f.gst)||5;
  const netTrade=tAllow-tPayoff;
  const gstAmt=(price+doc-netTrade)*(gst/100);
  const otd=price+doc-netTrade+gstAmt;
  const vsc=parseFloat(p.vscPrice)||0,gap=parseFloat(p.gapPrice)||0,tw=parseFloat(p.twPrice)||0,wa=parseFloat(p.waPrice)||0;
  const pmt72=$f(BPMT(apr,72,otd+vsc+gap+tw+wa));
  const pmt84=$f(BPMT(apr,84,otd+vsc+gap+tw+wa));
  const email = `Subject: Your ${v.desc} Quote — ${dealer}

Dear ${c.name||'Valued Customer'},

Thank you for your visit to ${dealer}! Here is a summary of your personalized vehicle quote:

VEHICLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${v.desc}${v.stock?' | Stock #'+v.stock:''}${v.km?' | '+parseInt(v.km).toLocaleString()+' km':''}

FINANCING SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Selling Price:        ${$f(price)}
Documentation Fee:    ${$f(doc)}
${netTrade!==0?`Trade Equity:         ${$f(netTrade)}\n`:''}GST (${gst}%):${' '.repeat(Math.max(1,14-String(gst).length))}${$f(gstAmt)}
Total Out-the-Door:   ${$f(otd)}

PROTECTION PACKAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${vsc>0?`Vehicle Service Contract: ${$f(vsc)}\n`:''}${gap>0?`GAP Insurance:            ${$f(gap)}\n`:''}${tw>0?`Tire & Wheel Protection:  ${$f(tw)}\n`:''}${wa>0?`Wear Appearance:          ${$f(wa)}\n`:''}
ESTIMATED PAYMENTS @ ${apr}% APR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
72 Month:   ${pmt72} / month
84 Month:   ${pmt84} / month

This quote is valid for 7 days. Ready to move forward? Reply to this email or call us directly.

Warmly,
${person}
${dealer}

─────────────────────────────────────
*Payments are estimates. Actual rate and terms subject to credit approval. GST included. Additional fees may apply.*`;
  document.getElementById('emailPreview').textContent = email;
}

function copyText(id){
  const txt = document.getElementById(id).textContent;
  navigator.clipboard.writeText(txt).then(()=>toast('Copied to clipboard'));
}

// ── LENDER APPROVAL PARSER — DealerTrack Edition ──────────────────

// PDF file handlers
function handleApprovalDrop(e){
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--border2)';
  e.currentTarget.style.background  = '';
  const file = e.dataTransfer.files[0];
  if(file && file.type === 'application/pdf') loadApprovalPDF(file);
  else toast('Please drop a PDF file');
}
function handleApprovalFile(e){
  const file = e.target.files[0];
  if(file) loadApprovalPDF(file);
}

async function loadApprovalPDF(file){
  const nameEl = document.getElementById('pdfFileName');
  const textEl = document.getElementById('lenderText');
  if(nameEl) nameEl.textContent = '⏳ Reading ' + file.name + '...';
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for(let i = 1; i <= pdf.numPages; i++){
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map(item => item.str).join(' ') + '\n';
    }
    textEl.value = fullText;
    if(nameEl) nameEl.textContent = file.name + ' loaded — click Parse';
    toast('PDF loaded — click Parse Document');
  } catch(e){
    if(nameEl) nameEl.textContent = 'Could not read PDF';
    toast('PDF read error: ' + e.message);
    console.error('PDF parse error:', e);
  }
}

function parseLender(){
  const txt    = document.getElementById('lenderText').value;
  const resDiv = document.getElementById('lenderParseResults');
  if(!txt.trim()){
    resDiv.innerHTML = '<div class="warning-box">Drop a PDF or paste approval text first.</div>';
    return;
  }

  // ── DealerTrack-specific extraction ────────────────────────────
  const p = {};

  // Status — the most important field
  const statusM = txt.match(/this deal.{0,10}status is\s+([A-Z ]+?)(?:\s{2,}|Deal #|$)/i);
  if(statusM) p.status = statusM[1].trim();

  // Customer name
  const custM = txt.match(/Customer Name[:\s]+([A-Z][A-Z\s\-]+?)(?:Co-Applicant|Last Modified|\n|  )/i);
  if(custM) p.customerName = custM[1].trim();

  // Lender
  const lenderM = txt.match(/Lender[:\s]+([A-Za-z][A-Za-z\s&,]+?)(?:Lender Reference|Status|\n|  )/i)
                || txt.match(/Lender:\s*([A-Za-z][A-Za-z\s&,]+)/i);
  if(lenderM) p.lender = lenderM[1].replace(/Contract Type.*$/i,'').trim();

  // Lender reference
  const refM = txt.match(/Lender Reference #[:\s]+(\d+)/i);
  if(refM) p.lenderRef = refM[1];

  // Amount financed
  const amtM = txt.match(/Amount\s*Financed[:\s]*\$?([\d,]+\.?\d*)/i);
  if(amtM) p.amountFinanced = amtM[1].replace(/,/g,'');

  // Rate
  const rateM = txt.match(/Annual Interest Rate[:\s]*(\d+\.?\d*)/i)
              || txt.match(/rate as low as\s*(\d+\.?\d*)%/i)
              || txt.match(/(?:rate|apr)[:\s]*(\d+\.?\d*)%/i);
  if(rateM) p.rate = rateM[1];

  // Term
  const termM = txt.match(/Term of Borrowing[:\s]*(\d+)/i)
              || txt.match(/(?:term)[:\s]*(\d+)\s*(?:month|mo)/i);
  if(termM) p.term = termM[1];

  // Payment
  const pmtM = txt.match(/Installment Payment[:\s]*\$?([\d,]+\.?\d*)/i)
             || txt.match(/Max(?:imum)?\s*[Pp]ayment[:\s]*\$?([\d,]+)/i);
  if(pmtM) p.payment = pmtM[1].replace(/,/g,'');

  // Payment frequency
  const freqM = txt.match(/Payment Frequency[:\s]*(Bi-Weekly|Monthly|Weekly|Bi-weekly)/i);
  if(freqM) p.payFreq = freqM[1];

  // Down payment
  const downM = txt.match(/Down Payment[:\s]*\$?([\d,]+\.?\d*)/i);
  if(downM) p.downPayment = downM[1].replace(/,/g,'');

  // LTV
  const ltvM = txt.match(/(\d+)%\s*max\s*LTV/i) || txt.match(/LTV[:\s]*(\d+)%/i);
  if(ltvM) p.ltv = ltvM[1];

  // Tier
  const tierM = txt.match(/Tier\s*(\d+)/i);
  if(tierM) p.tier = tierM[1];

  // VIN
  const vinM = txt.match(/VIN#[:\s]*([A-HJ-NPR-Z0-9]{17})/i);
  if(vinM) p.vin = vinM[1];

  // Vehicle model
  const modelM = txt.match(/Model[:\s]*(20\d{2}[^\n]+?)(?:VIN|Odometer|  |\n)/i);
  if(modelM) p.vehicle = modelM[1].trim();

  // Key conditions — grab the deal-specific conditions block
  const condM = txt.match(/DEAL SPECIFIC CONDITIONS[^*]*(.*?)(?:\*{3,}\s*STANDARD|$)/is);
  if(condM) {
    const rawCond = condM[1].replace(/\d{4}-\d{2}-\d{2}.*?\n/g,'').trim();
    p.conditions = rawCond.substring(0, 400).trim();
  }

  // ── Render results ────────────────────────────────────────────
  const statusColor = {
    'APPROVED':             { bg:'rgba(16,185,129,.12)', border:'rgba(16,185,129,.3)', text:'var(--green)',  icon:'' },
    'CONDITIONAL APPROVAL': { bg:'rgba(245,158,11,.1)',  border:'rgba(245,158,11,.3)', text:'var(--amber)', icon:'' },
    'DECLINED':             { bg:'rgba(239,68,68,.1)',   border:'rgba(239,68,68,.3)',  text:'var(--red)',   icon:'' }
  };
  const sc = statusColor[p.status] || { bg:'rgba(30,90,246,.08)', border:'var(--border2)', text:'var(--primary)', icon:'' };

  const row = (label, val, color='') =>
    val ? `<div class="cline"><span class="cl-label">${label}</span><span class="cl-value" ${color?`style="color:${color}"`:''}>${val}</span></div>` : '';

  let html = `<div style="background:${sc.bg};border:2px solid ${sc.border};border-radius:10px;padding:18px;">`;

  // Status banner
  html += `<div style="font-size:15px;font-weight:800;color:${sc.text};margin-bottom:14px;letter-spacing:.5px;">${sc.icon} ${p.status || 'PARSED'}</div>`;

  // Core fields
  if(p.lender)       html += row('Lender', p.lender);
  if(p.customerName) html += row('Customer', p.customerName);
  if(p.lenderRef)    html += row('Lender Ref #', p.lenderRef);
  if(p.vehicle)      html += row('Vehicle', p.vehicle);
  if(p.vin)          html += row('VIN', `<span style="font-family:monospace;">${p.vin}</span>`);

  html += `<div style="border-top:1px solid ${sc.border};margin:10px 0;"></div>`;

  if(p.amountFinanced) html += row('Amount Financed', `$${parseFloat(p.amountFinanced).toLocaleString('en-CA',{minimumFractionDigits:2})}`, 'var(--green)');
  if(p.rate)           html += row('Interest Rate', `${p.rate}%`, 'var(--amber)');
  if(p.term)           html += row('Term', `${p.term} months`);
  if(p.payment)        html += row('Approved Payment', `$${parseFloat(p.payment).toLocaleString()} / ${p.payFreq||'month'}`, 'var(--primary)');
  if(p.downPayment)    html += row('Down Payment', `$${parseFloat(p.downPayment).toLocaleString()}`);
  if(p.ltv)            html += row('Max LTV', `${p.ltv}%`);
  if(p.tier)           html += row('Tier', `Tier ${p.tier}`);

  // Conditions block
  if(p.conditions){
    html += `<div style="margin-top:12px;background:rgba(0,0,0,.15);border-radius:6px;padding:10px;">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:6px;">Deal Conditions</div>
      <div style="font-size:11px;color:var(--text);line-height:1.6;white-space:pre-wrap;">${escapeHtml(p.conditions)}</div>
    </div>`;
  }

  if(p.status !== 'DECLINED'){
    html += `<button class="btn btn-primary btn-full" style="margin-top:14px;" onclick='applyParsed(${JSON.stringify(p)})'>Apply to Deal Desk</button>`;
  }

  html += `</div>`;
  resDiv.innerHTML = html;
  toast(p.status === 'APPROVED' ? 'Approved' : p.status === 'DECLINED' ? 'Declined' : 'Conditional');
}

function applyParsed(p){
  if(p.rate)           setVal('apr', p.rate);
  if(p.term)           setVal('term', p.term);
  if(p.customerName)   setVal('custName', p.customerName);
  if(p.downPayment)    setVal('finalDown', p.downPayment);
  if(p.vin)            setVal('vin', p.vin);
  if(p.vehicle)        setVal('vehicleDesc', p.vehicle);
  calculate();
  closeModal('lenderParserModal');
  showSection('deal');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.id === 'nav-deal' || b.getAttribute('onclick')?.includes("'deal'"));
  });
  toast('Approval applied to Deal Desk');
}

// ── APPLY APPROVAL ──────────────────────────────────────

// Opens the approval modal pre-filled with estimated lender data
function openApprovalModal(lenderNameEnc, estRate, estTerm, estAtf, ltvPct, beacon, stockEnc, bookVal) {
  const lenderName = decodeURIComponent(lenderNameEnc);
  const stock      = decodeURIComponent(stockEnc);

  // Store context for confirmApproval()
  window._approvalCtx = { lenderName, estRate, estTerm, estAtf, ltvPct, beacon, stock, bookVal };

  // Pre-fill modal fields with estimated values
  setVal('appLender',    lenderName);
  setVal('appApprovedAtf',  estAtf  || '');
  setVal('appApprovedRate', estRate || '');
  setVal('appApprovedTerm', estTerm || 72);
  setVal('appApprovedDown', '');
  setVal('appStip',     '');
  setVal('appStock',    stock);
  setVal('appCustName', getVal('custName'));

  // Live-calculate payment preview as user types
  _updateApprovalPreview();

  document.getElementById('appLenderDisplay').textContent = lenderName;
  openModal('approvalModal');
}

function _updateApprovalPreview() {
  const atf  = parseFloat(document.getElementById('appApprovedAtf')?.value)  || 0;
  const rate = parseFloat(document.getElementById('appApprovedRate')?.value) || 0;
  const term = parseFloat(document.getElementById('appApprovedTerm')?.value) || 72;
  const down = parseFloat(document.getElementById('appApprovedDown')?.value) || 0;
  const el   = document.getElementById('appPaymentPreview');
  if (!el) return;
  if (atf <= 0 || rate <= 0 || term <= 0) { el.textContent = '—'; return; }
  const financed = Math.max(0, atf - down);
  const pmt = PMT(rate / 100 / 12, term, -financed);
  el.textContent = $f(pmt) + '/mo';
  // Also show reserve preview
  const contractRate = parseFloat(getVal('contractRate')) || rate;
  const buyRate      = rate;
  const split        = parseFloat(getVal('bankSplit')) || 75;
  const reserveEl    = document.getElementById('appReservePreview');
  if (reserveEl) {
    const spread  = contractRate - buyRate;
    const reserve = spread > 0 ? ((atf - down) * (spread / 100) * (term / 12)) * (split / 100) : 0;
    reserveEl.textContent = reserve > 0 ? $i(reserve) + ' est. reserve' : '';
  }
}

// Called when dealer clicks "Apply to Deal Desk"
async function confirmApproval() {
  const ctx        = window._approvalCtx || {};
  const approvedAtf  = parseFloat(getVal('appApprovedAtf'))  || 0;
  const approvedRate = parseFloat(getVal('appApprovedRate')) || 0;
  const approvedTerm = parseInt(getVal('appApprovedTerm'))   || 72;
  const approvedDown = parseFloat(getVal('appApprovedDown')) || 0;
  const stip         = getVal('appStip').trim();
  const custName     = getVal('appCustName').trim();
  const outcome      = getVal('appOutcome') || 'approved';

  if (!approvedAtf || !approvedRate) {
    toast('Enter approved ATF and rate to continue');
    return;
  }

  // ── Apply to deal desk ──────────────────────────────────
  applyApproved(approvedAtf, approvedRate, approvedTerm, approvedDown);

  // ── Log to deal_outcomes ────────────────────────────────
  try {
    const d       = getDealData();
    const v       = window.inventory?.find(x => x.stock === ctx.stock) || {};
    await FF.apiFetch('/api/desk/outcomes/log-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lenderKey:       ctx.lenderName,
        outcome,
        beacon:          ctx.beacon    || parseFloat(getVal('compareBeacon')) || null,
        ltvPct:          ctx.ltvPct    || null,
        vehicleYear:     v.year        || null,
        vehicleMileage:  v.mileage     || null,
        vehiclePrice:    v.price       || null,
        bookValue:       ctx.bookVal   || v.book_value || null,
        amountToFinance: approvedAtf,
        term:            approvedTerm,
        approvedRate,
        approvedTerm,
        approvedAmount:  approvedAtf,
        stipulations:    stip          || null,
        customerName:    custName      || null,
        stock:           ctx.stock     || null
      })
    });
    console.log('✅ Approval logged to deal_outcomes');
  } catch(e) {
    console.warn('Outcome log failed (non-critical):', e.message);
  }

  closeModal('approvalModal');
  showSection('deal');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.id === 'nav-deal' || b.getAttribute('onclick')?.includes("'deal'"));
  });
  toast('✓ Approval applied — deal desk updated with final numbers');
}

// Rewrites deal desk fields with actual approved numbers and recalculates
function applyApproved(approvedAtf, approvedRate, approvedTerm, approvedDown) {
  // Work backwards from approved ATF to find required down payment
  // ATF = OTD - down  →  down = OTD - ATF
  const price   = parseFloat(getVal('sellingPrice')) || 0;
  const doc     = parseFloat(getVal('docFee'))       || 0;
  const tAllow  = parseFloat(getVal('tradeAllow'))   || 0;
  const tPayoff = parseFloat(getVal('tradePayoff'))  || 0;
  const gst     = parseFloat(getVal('gstRate'))      || 5;
  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst / 100);
  const otd      = price + doc - netTrade + gstAmt;

  // If caller provided explicit down use it, otherwise derive from ATF
  const derivedDown = approvedDown > 0 ? approvedDown : Math.max(0, otd - approvedAtf);

  setVal('apr',         approvedRate);
  setVal('contractRate', approvedRate);   // sync reserve panel
  setVal('reserveTerm',  approvedTerm);   // sync reserve panel
  setVal('finalDown',    derivedDown);

  // Flash the updated fields so dealer sees what changed
  ['apr','finalDown','contractRate'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = 'background .3s';
    el.style.background = 'rgba(16,185,129,.25)';
    setTimeout(() => { el.style.background = ''; }, 1800);
  });

  calculate();
  calculateReserve();
}

// ── SETTINGS ──────────────────────────────────────────
const DEFAULT_LOGO_SRC = "data:image/png;base64,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";
function openSettingsModal(){
  setVal('setPerson',  settings.salesName  || '');
  setVal('setDealer',  settings.dealerName || '');
  setVal('setLogoUrl', settings.logoUrl    || '');
  setVal('setDocFee',  settings.docFee);
  setVal('setGST',     settings.gst);
  setVal('setAPR',     settings.apr);
  setVal('setTarget',  settings.target);
  if(settings.logoUrl){ const el=document.getElementById('logo-preview'); if(el){el.src=settings.logoUrl;el.style.display='block';} }
  setVal('setDealerCity',   settings.dealerCity   || '');
  setVal('setTwilioNumber',   settings.twilioNumber   || '');
  setVal('setNotifyPhone',    settings.notifyPhone    || '');
  setVal('setGoogleReviewUrl', settings.googleReviewUrl || '');
  openModal('settingsModal');
}
function updateHeaderDealer(){
  const name = settings.dealerName || '';
  const el = document.getElementById('header-dealer-name');
  if(el) el.textContent = name ? name.toUpperCase() : 'PLATFORM v1.0';
  // Logo
  const logoEl = document.getElementById('header-logo');
  if(logoEl){
    const src = settings.logoUrl || DEFAULT_LOGO_SRC;
    logoEl.src = src;
    logoEl.style.display = 'block';
  }
  // Presentation overlay logo
  const presLogoEl = document.getElementById('pres-logo');
  if(presLogoEl){
    const src = settings.logoUrl || DEFAULT_LOGO_SRC;
    presLogoEl.src = src;
    presLogoEl.style.display = 'block';
  }
}
function previewLogo(url){
  const el = document.getElementById('logo-preview');
  if(!el) return;
  if(url){ el.src=url; el.style.display='block'; }
  else{ el.style.display='none'; }
}
async function saveSettings(){
  // 1. Read from form inputs
  settings.salesName = getVal('setPerson') || settings.salesName;
  settings.dealerName= getVal('setDealer') || settings.dealerName;
  settings.logoUrl   = getVal('setLogoUrl') || '';
  settings.docFee    = parseFloat(getVal('setDocFee'))  || settings.docFee;
  settings.gst       = parseFloat(getVal('setGST'))     || settings.gst;
  settings.apr       = parseFloat(getVal('setAPR'))     || settings.apr;
  settings.target    = parseInt(getVal('setTarget'))    || settings.target;
  settings.dealerCity   = (getVal('setDealerCity')   || '').trim();
  settings.twilioNumber    = (getVal('setTwilioNumber')    || '').trim();
  settings.notifyPhone     = (getVal('setNotifyPhone')     || '').trim();
  settings.googleReviewUrl = (getVal('setGoogleReviewUrl') || '').trim();

  // 2. Apply locally immediately
  setVal('docFee', settings.docFee);
  setVal('gstRate', settings.gst);
  setVal('apr', settings.apr);
  document.getElementById('targetInput').value = settings.target;
  updateHeaderDealer();
  calculate();

  // 3. Save to Postgres directly — not via the debounced localStorage interceptor.
  //    Without this, a page refresh within 1500ms of clicking Save silently loses changes.
  const btn = document.getElementById('saveSettingsBtn');
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    if (window.FF && typeof window.FF.apiFetch === 'function') {
      const res = await window.FF.apiFetch('/api/desk/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed');
    } else {
      localStorage.setItem('ffSettings', JSON.stringify(settings));
    }
    closeModal('settingsModal');
    toast('Settings saved!');
  } catch (e) {
    console.error('❌ Settings save failed:', e.message);
    toast('⚠️ Settings could not be saved — check your connection and try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// ── CRM ───────────────────────────────────────────────
async function loadCRM(){
  if(!window.FF||!FF.isLoggedIn)return;
  // One-time migration: push any localStorage CRM data to DB then clear it
  const local=JSON.parse(localStorage.getItem('ffCRM')||'[]');
  if(local.length){
    try{
      for(const c of local){
        await FF.apiFetch('/api/desk/crm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          name:c.name,phone:c.phone||'',email:c.email||'',
          beacon:c.beacon||'',status:c.status||'Lead',
          source:c.vehicle||'',notes:c.stock||''
        })});
      }
      localStorage.removeItem('ffCRM');
      toast('CRM migrated to cloud ☁️');
    }catch(e){console.warn('CRM migration error:',e);}
  }
  try{
    const res=await FF.apiFetch('/api/desk/crm').then(r=>r.json());
    if(res.success){
      crmData=res.crm.map(r=>({
        id:r.id,
        date:r.created_at?new Date(r.created_at).toLocaleDateString('en-CA'):'—',
        name:r.name,phone:r.phone||'',email:r.email||'',
        vehicle:r.source||'Not specified',stock:r.notes||'',
        beacon:r.beacon||'',status:r.status||'Lead'
      }));
      renderCRM();
    }
  }catch(e){console.error('CRM load error:',e);}
}
async function addToCRM(){
  const d=getDealData();const c=d.customer;const v=d.vehicle;
  if(!c.name){toast('Enter customer name first');return;}
  try{
    const res=await FF.apiFetch('/api/desk/crm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      name:c.name,phone:c.phone||'',email:c.email||'',
      beacon:c.beacon||'',status:'Lead',
      source:`${v.desc}`.trim()||'Not specified',notes:v.stock||''
    })}).then(r=>r.json());
    if(res.success){
      crmData.unshift({id:res.entry.id,date:new Date().toLocaleDateString('en-CA'),name:c.name,phone:c.phone||'',email:c.email||'',vehicle:`${v.desc}`.trim()||'Not specified',stock:v.stock||'',beacon:c.beacon||'',status:'Lead'});
      toast('Added to CRM');
    }
  }catch(e){toast('CRM save failed');}
}
async function promptAddCRM(){
  const name=prompt('Customer Name:');if(!name)return;
  const phone=prompt('Phone:')||'';const email=prompt('Email:')||'';
  try{
    const res=await FF.apiFetch('/api/desk/crm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      name,phone,email,status:'Lead',source:'Not specified',notes:''
    })}).then(r=>r.json());
    if(res.success){
      crmData.unshift({id:res.entry.id,date:new Date().toLocaleDateString('en-CA'),name,phone,email,vehicle:'Not specified',stock:'',beacon:'',status:'Lead'});
      renderCRM();toast('Customer added');
    }
  }catch(e){toast('CRM save failed');}
}
function renderCRM(){
  const container=document.getElementById('crmContainer');
  if(!crmData.length){container.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);">No customers in CRM yet.</div>';return;}
  container.innerHTML=`<table class="data-table"><thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Email</th><th>Vehicle</th><th>Beacon</th><th>Status</th><th>Action</th></tr></thead><tbody>
  ${crmData.map(c=>`<tr>
    <td>${c.date}</td><td><strong>${c.name}</strong></td><td>${c.phone||'—'}</td><td>${c.email||'—'}</td>
    <td>${c.vehicle}${c.stock?' ('+c.stock+')':''}</td><td>${c.beacon||'—'}</td>
    <td><select class="crm-status" onchange="updateCRM(${c.id},this.value)" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:4px 8px;font-family:'Outfit',sans-serif;">
      ${['Lead','Contacted','Test Drive','Negotiating','Sold','Lost'].map(s=>`<option ${c.status===s?'selected':''}>${s}</option>`).join('')}
    </select></td>
    <td><button class="btn btn-danger btn-sm" onclick="deleteCRM(${c.id})">Del</button></td>
  </tr>`).join('')}
  </tbody></table>`;
}
async function updateCRM(id,status){
  const c=crmData.find(x=>x.id===id);if(c)c.status=status;
  try{await FF.apiFetch('/api/desk/crm/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});}
  catch(e){console.error('CRM update failed:',e);}
}
async function deleteCRM(id){
  if(!confirm('Delete?'))return;
  try{
    await FF.apiFetch('/api/desk/crm/'+id,{method:'DELETE'});
    crmData=crmData.filter(c=>c.id!==id);renderCRM();
  }catch(e){toast('Delete failed');}
}

// ── DEAL LOG ──────────────────────────────────────────
// ── LENDER SUBMISSION TRACKER ────────────────────────────────────
function _submissionKey(){
  const stock  = document.getElementById('compareStock')?.value || 'unknown';
  const beacon = document.getElementById('compareBeacon')?.value || '0';
  return `ffSub_${stock}_${beacon}`;
}

function getSubmissions(){
  try { return JSON.parse(localStorage.getItem(_submissionKey()) || '[]'); }
  catch(e){ return []; }
}

function saveSubmissions(subs){
  localStorage.setItem(_submissionKey(), JSON.stringify(subs));
}

function logSubmission(lenderName){
  const subs = getSubmissions();
  const existing = subs.find(s => s.lender === lenderName);
  if(existing){
    toast(`${lenderName} already logged — update status in tracker`);
    renderSubmissionTracker();
    return;
  }
  subs.push({
    lender: lenderName,
    date: new Date().toLocaleDateString('en-CA'),
    time: new Date().toLocaleTimeString('en-CA', {hour:'2-digit',minute:'2-digit'}),
    status: 'Pending',
    notes: ''
  });
  saveSubmissions(subs);
  toast(`Logged: ${lenderName} — Pending`);
  renderSubmissionTracker();
}

function updateSubmissionStatus(lenderName, status){
  const subs = getSubmissions();
  const s = subs.find(x => x.lender === lenderName);
  if(s){ s.status = status; s.updatedAt = new Date().toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'}); }
  saveSubmissions(subs);
  renderSubmissionTracker();
}

function updateSubmissionNotes(lenderName, notes){
  const subs = getSubmissions();
  const s = subs.find(x => x.lender === lenderName);
  if(s) s.notes = notes;
  saveSubmissions(subs);
}

function deleteSubmission(lenderName){
  const subs = getSubmissions().filter(s => s.lender !== lenderName);
  saveSubmissions(subs);
  renderSubmissionTracker();
}

function renderSubmissionTracker(){
  const el = document.getElementById('submissionTracker');
  if(!el) return;
  const subs = getSubmissions();
  if(!subs.length){ el.innerHTML = ''; el.style.display='none'; return; }

  const statusColors = {
    'Pending':  { bg:'rgba(245,158,11,.12)',  color:'var(--amber)',  border:'rgba(245,158,11,.3)'  },
    'Approved': { bg:'rgba(16,185,129,.12)',  color:'var(--green)',  border:'rgba(16,185,129,.3)'  },
    'Counter':  { bg:'rgba(30,90,246,.12)',   color:'var(--primary)',border:'rgba(30,90,246,.3)'   },
    'Declined': { bg:'rgba(239,68,68,.1)',    color:'var(--red)',    border:'rgba(239,68,68,.3)'   },
  };

  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:8px;">
      <span style="width:8px;height:8px;background:var(--amber);border-radius:50%;display:inline-block;"></span>
      Credit App Submissions (${subs.length})
    </div>
    ${subs.map(s => {
      const sc = statusColors[s.status] || statusColors['Pending'];
      return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:800;font-size:13px;">${s.lender}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px;">Submitted ${s.date} ${s.time}${s.updatedAt?' · Updated '+s.updatedAt:''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            ${['Pending','Approved','Counter','Declined'].map(st => {
              const active = s.status === st;
              return `<button onclick="updateSubmissionStatus('${s.lender.replace(/'/g,"\\'")}','${st}')"
                style="padding:4px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;transition:all .15s;
                  background:${active ? sc.bg : 'transparent'};
                  color:${active ? sc.color : 'var(--muted)'};
                  border:1px solid ${active ? sc.border : 'var(--border)'};">
                ${st}
              </button>`;
            }).join('')}
            <button onclick="deleteSubmission('${s.lender.replace(/'/g,"\\'")}') "
              style="padding:4px 8px;border-radius:5px;font-size:10px;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--muted);">✕</button>
          </div>
        </div>
        <input type="text" placeholder="Notes (counter offer, conditions, etc.)" value="${s.notes||''}"
          oninput="updateSubmissionNotes('${s.lender.replace(/'/g,"\\'")}',this.value)"
          style="width:100%;margin-top:8px;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:6px 10px;font-size:11px;color:var(--text);font-family:'Outfit',sans-serif;box-sizing:border-box;">
      </div>`;
    }).join('')}`;
}

async function logDeal(){
  const d=getDealData();
  const now=new Date();
  const p=d.products;
  const pvr=(parseFloat(p.vscPrice)||0)+(parseFloat(p.gapPrice)||0)+(parseFloat(p.twPrice)||0)+(parseFloat(p.waPrice)||0);
  d.loggedAt=now.toLocaleDateString('en-CA');d.loggedTime=now.toLocaleTimeString('en-CA');
  d.loggedMonth=now.getMonth();d.loggedYear=now.getFullYear();d.loggedDay=now.toDateString();
  d.id=Date.now();d.pvr=pvr;

  // Store both monthly and biweekly payments
  const _apr = parseFloat(d.finance?.apr)||0;
  const _term = parseFloat(d.finance?.termMonths)||72;
  const _fin = parseFloat(d.finance?.financeAmount)||0;
  if(_apr && _term && _fin){
    d.monthlyPayment = PMT(_apr/100/12, _term, _fin);
    d.biweeklyPayment = PMT(_apr/100/26, Math.round(_term*26/12), _fin);
  }
  try{
    const res=await FF.apiFetch('/api/desk/deal-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deal:d})}).then(r=>r.json());
    if(res.success){d._dbId=res.id;}
  }catch(e){console.error('Deal log save failed:',e);}
  dealLog.unshift(d);
  toast('Deal logged');
  refreshAllAnalytics();
  renderScenarios();
}
function renderDealLog(){
  const c=document.getElementById('dealLogContainer');
  if(!dealLog.length){c.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);">No deals logged yet. Use the LOG THIS DEAL button from the Deal Desk.</div>';return;}
  c.innerHTML=`<table class="data-table"><thead><tr><th>Date</th><th>Vehicle</th><th>Stock #</th><th>Products</th><th>PVR</th><th>Actions</th></tr></thead><tbody>
  ${dealLog.slice(0,100).map(d=>{
    const v=d.vehicle||{};const p=d.products||{};
    const prods=[];
    if(parseFloat(p.vscPrice||0)>0)prods.push('VSC');
    if(parseFloat(p.gapPrice||0)>0)prods.push('GAP');
    if(parseFloat(p.twPrice||0)>0)prods.push('T&W');
    if(parseFloat(p.waPrice||0)>0)prods.push('WA');
    const delId=d._dbId||d.id;
    return `<tr>
      <td>${d.loggedAt||'?'}<br><small style="color:var(--muted);">${d.loggedTime||''}</small></td>
      <td><strong>${v.desc||''}</strong></td>
      <td style="color:var(--amber);">${v.stock||'—'}</td>
      <td>${prods.join(', ')||'<span style="color:var(--muted);">None</span>'}</td>
      <td><strong style="color:var(--green);">$${(d.pvr||0).toLocaleString()}</strong></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteLog('${delId}',${!!d._dbId})">Del</button></td>
    </tr>`;
  }).join('')}
  </tbody></table>`;
}
async function deleteLog(id,isDbId){
  if(!confirm('Delete?'))return;
  if(isDbId){
    try{await FF.apiFetch('/api/desk/deal-log/'+id,{method:'DELETE'});}
    catch(e){console.error('Deal delete failed:',e);}
    dealLog=dealLog.filter(d=>d._dbId!=id);
  }else{
    dealLog=dealLog.filter(d=>d.id!=id);
  }
  refreshAllAnalytics();
}
async function clearAllDeals(){
  if(!confirm('Clear ALL '+dealLog.length+' logged deals?'))return;
  try{
    await FF.apiFetch('/api/desk/deal-log/bulk',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({dealLog:[]})});
  }catch(e){console.error('Clear deals failed:',e);}
  dealLog=[];refreshAllAnalytics();toast('Cleared');
}

async function loadDealLog(){
  if(!window.FF||!FF.isLoggedIn)return;
  // One-time migration from localStorage
  const local=JSON.parse(localStorage.getItem('ffDealLog')||'[]');
  if(local.length){
    try{
      await FF.apiFetch('/api/desk/deal-log/bulk',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({dealLog:local})});
      localStorage.removeItem('ffDealLog');
      toast('Deal log migrated to cloud ☁️');
    }catch(e){console.warn('Deal log migration error:',e);}
  }
  try{
    const res=await FF.apiFetch('/api/desk/deal-log').then(r=>r.json());
    if(res.success){dealLog=res.dealLog;renderDealLog();refreshAllAnalytics();}
  }catch(e){console.error('Deal log load error:',e);}
}

function refreshAllAnalytics(){
  renderDealLog();loadCRM();
  const now=new Date();const today=now.toDateString();const m=now.getMonth();const y=now.getFullYear();
  const sw=new Date(now);sw.setDate(now.getDate()-now.getDay());sw.setHours(0,0,0,0);
  let td=0,wk=0,mo=0,vscN=0,gapN=0,twN=0,waN=0,totPVR=0;
  dealLog.forEach(d=>{
    if(d.loggedDay===today)td++;
    if(new Date(d.ts)>=sw)wk++;
    if(d.loggedMonth===m&&d.loggedYear===y)mo++;
    const p=d.products||{};
    if(parseFloat(p.vscPrice||0)>0)vscN++;
    if(parseFloat(p.gapPrice||0)>0)gapN++;
    if(parseFloat(p.twPrice||0)>0)twN++;
    if(parseFloat(p.waPrice||0)>0)waN++;
    totPVR+=(d.pvr||0);
  });
  const tot=dealLog.length;
  ['statTotal','statMonth','statWeek','statToday'].forEach((id,i)=>document.getElementById(id).textContent=[tot,mo,wk,td][i]);
  const pct=n=>tot?((n/tot)*100).toFixed(1)+'%':'0%';
  document.getElementById('penVSC').textContent=pct(vscN);document.getElementById('penVSCn').textContent=`${vscN} of ${tot}`;
  document.getElementById('penGAP').textContent=pct(gapN);document.getElementById('penGAPn').textContent=`${gapN} of ${tot}`;
  document.getElementById('penTW').textContent=pct(twN);document.getElementById('penTWn').textContent=`${twN} of ${tot}`;
  document.getElementById('penWA').textContent=pct(waN);document.getElementById('penWAn').textContent=`${waN} of ${tot}`;
  document.getElementById('avgPVR').textContent=tot?$i(totPVR/tot):'$0';
  document.getElementById('totalBackend').textContent=$i(totPVR);
  updateTarget(mo);
}

function showAnalyticsTab(id,btn){
  document.querySelectorAll('#section-analytics .mgr-content').forEach(c=>c.classList.remove('active'));
  document.querySelectorAll('#section-analytics .mgr-tab').forEach(b=>b.classList.remove('active'));
  document.getElementById('atab-'+id).classList.add('active');
  if(btn)btn.classList.add('active');
}

function updateTarget(dealsThisMonth){
  const target=parseInt(document.getElementById('targetInput').value)||settings.target;
  const now=new Date();
  if(dealsThisMonth===undefined){
    const m=now.getMonth(),y=now.getFullYear();
    dealsThisMonth=dealLog.filter(d=>d.loggedMonth===m&&d.loggedYear===y).length;
  }
  const pct=target?((dealsThisMonth/target)*100).toFixed(1)+'%':'0%';
  const daysInMonth=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const dayOfMonth=now.getDate();
  const daysLeft=daysInMonth-dayOfMonth;
  const needed=Math.max(0,target-dealsThisMonth);
  const neededPD=daysLeft>0?(needed/daysLeft).toFixed(1):0;
  const expected=(dayOfMonth/daysInMonth)*target;
  let pace='—';
  if(dealsThisMonth>=target)pace='Hit!';
  else if(dealsThisMonth>=expected*1.1)pace='Ahead';
  else if(dealsThisMonth>=expected*0.9)pace='On Track';
  else pace='Behind';
  document.getElementById('tDeals').textContent=dealsThisMonth;
  document.getElementById('tTarget').textContent=target;
  document.getElementById('tPct').textContent=pct;
  document.getElementById('tPace').textContent=pace;
  document.getElementById('tDaysLeft').textContent=daysLeft;
  document.getElementById('tNeedPerDay').textContent=neededPD;
}

// ── CSV IMPORT (Updated for Cloud & Sync) ──────────────
function importCSV(){
  const txt=document.getElementById('csvText').value.trim();
  if(!txt){toast('Paste CSV content first');return;}
  const lines=txt.split('\n');
  if(lines.length<2){toast('Need at least header + 1 data row');return;}
  const headers=lines[0].split(',').map(h=>h.trim().toLowerCase());
  const idx=k=>headers.indexOf(k);
  const imported=[];
  
  for(let i=1;i<lines.length;i++){
    if(!lines[i].trim())continue;
    const cols=lines[i].split(',').map(c=>c.trim());
    imported.push({
      stock:cols[idx('stock')]||'',
      year:parseInt(cols[idx('year')])||0,
      make:cols[idx('make')]||'',
      model:cols[idx('model')]||'',
      mileage:parseInt(cols[idx('mileage')])||0,
      price:parseFloat(cols[idx('price')])||0,
      condition:cols[idx('condition')]||'Average',
      carfax:parseFloat(cols[idx('carfax')])||0,
      type:cols[idx('type')]||'',
      book_value:parseFloat(cols[idx('book_value')]||cols[idx('book value')]||cols[idx('bookvalue')])||0
    });
  }
  
  if(!imported.length){toast('No valid rows found');return;}

  // 1. Update the new global variables
  window.inventory = imported;
  window.ffInventory = imported;

  // 2. Immediately rebuild dropdowns and the inventory table
  initInventory(); 

  // 3. Sync imported inventory to the cloud (desk_inventory table)
  if(window.FF && FF.isLoggedIn) {
    FF.apiFetch('/api/desk/inventory/bulk',{
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({vehicles:imported})
    }).catch(e => console.error("Cloud sync failed:", e));
  }
  
  closeModal('csvImportModal');
  toast(` Imported ${imported.length} vehicles!`);
}

// ── EXPORT ────────────────────────────────────────────
function exportJSON(type){
  const data=type==='deals'?dealLog:crmData;
  const name=`firstfin-${type}-${new Date().toISOString().split('T')[0]}.json`;
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported');
}

// ── MODALS ────────────────────────────────────────────
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
function closeModalOutside(e,id){if(e.target===document.getElementById(id))closeModal(id);}

// ── DARK / LIGHT MODE ─────────────────────────────────
function toggleDarkMode(){
  const isLight = document.body.classList.toggle('light-mode');
  const btn = document.getElementById('darkModeBtn');
  btn.textContent = isLight ? 'Dark' : 'Light';
  localStorage.setItem('ffTheme', isLight ? 'light' : 'dark');
  toast(isLight ? 'Switched to Light Mode' : 'Switched to Dark Mode');
}

// ── TOAST ─────────────────────────────────────────────
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}

// ── KEYBOARD SHORTCUTS ────────────────────────────────
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)){
    if(e.key==='s'){e.preventDefault();saveDeal();}
    if(e.key==='l'){e.preventDefault();loadDeal();}
    if(e.key==='p'){e.preventDefault();window.print();}
  }
});


// ═══════════════════════════════════════════════════════════════════
// SARAH AI — ALL DASHBOARD FUNCTIONS (same-origin, no config needed)
// ═══════════════════════════════════════════════════════════════════

// ── Session admin token (prompted once, remembered in-session) ────
let _adminToken = null;
function getAdminToken(){
  if(_adminToken) return _adminToken;
  const t = prompt('Admin Token Required\nEnter your ADMIN_TOKEN:','');
  if(!t||!t.trim()){ toast('Cancelled'); return null; }
  _adminToken = t.trim(); return _adminToken;
}
function clearAdminToken(){ _adminToken = null; }

async function adminFetch(url, options={}){
  const token = getAdminToken();
  if(!token) return null;
  // Use POST with token in body (GET routes were converted to POST for security)
  const method = options.method || 'POST';
  const body   = JSON.stringify({ token, ...(options.body ? JSON.parse(options.body) : {}) });
  const res = await fetch(url, {
    ...options,
    method,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body
  });
  if(res.status===403){ clearAdminToken(); toast('Wrong token'); return null; }
  return await res.json();
}

// ── Tab switcher ──────────────────────────────────────────────────
function showSarahTab(id, btn){
  document.querySelectorAll('#section-sarah .mgr-content').forEach(c=>c.classList.remove('active'));
  document.querySelectorAll('#section-sarah .mgr-tab').forEach(b=>b.classList.remove('active'));
  document.getElementById('stab-'+id).classList.add('active');
  if(btn) btn.classList.add('active');
}

// ── Load all dashboard data ───────────────────────────────────────
let allConversations = [];

async function loadSarahDashboard(){
  try {
    // Stats
    const stats = await FF.apiFetch('/api/dashboard').then(r=>r.json());
    document.getElementById('ss-customers').textContent     = stats.stats.totalCustomers;
    document.getElementById('ss-conversations').textContent = stats.stats.totalConversations;
    document.getElementById('ss-messages').textContent      = stats.stats.totalMessages;
    document.getElementById('ss-appointments').textContent  = stats.stats.totalAppointments;
    document.getElementById('ss-callbacks').textContent     = stats.stats.totalCallbacks;

    // Analytics
    try {
      const an = await FF.apiFetch('/api/analytics').then(r=>r.json());
      if(!an.error){
        document.getElementById('sa-convRate').textContent   = an.conversionRate + '%';
        document.getElementById('sa-convDetail').textContent = an.totalConverted + ' of ' + an.totalConversations + ' convs';
        document.getElementById('sa-respRate').textContent   = an.responseRate + '%';
        document.getElementById('sa-respDetail').textContent = an.totalResponded + ' customers replied';
        document.getElementById('sa-avgMsg').textContent     = an.avgMessages;
        document.getElementById('sa-weekConv').textContent   = an.weekConversations;
        document.getElementById('sa-weekDetail').textContent = an.weekConverted + ' converted this week';

        const topV = an.topVehicles.length
          ? an.topVehicles.map((v,i)=>`<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);"><span>${i+1}. ${v.vehicle_type||'Unknown'}</span><span style="color:var(--primary);font-weight:700;">${v.count}</span></div>`).join('')
          : '<div style="padding:8px;color:var(--muted);">No data yet</div>';
        document.getElementById('sa-topVehicles').innerHTML = topV;

        const bdist = an.budgetDist.length
          ? an.budgetDist.map(b=>`<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);"><span>${b.budget}</span><span style="color:var(--green);font-weight:700;">${b.count}</span></div>`).join('')
          : '<div style="padding:8px;color:var(--muted);">No data yet</div>';
        document.getElementById('sa-budgetDist').innerHTML = bdist;
      }
    } catch(e){ console.warn('Analytics load error', e); }

    // Conversations
    allConversations = await FF.apiFetch('/api/conversations').then(r=>r.json());
    renderConversations(allConversations);

    // Appointments
    renderAppointments(stats.recentAppointments || []);

    // Callbacks
    renderCallbacks(stats.recentCallbacks || []);

    toast('Sarah data refreshed');
    setTimeout(refreshIcons, 100);
  } catch(e){
    console.error('Sarah load error:', e);
    toast('Could not load Sarah data: ' + e.message);
  }
}

// ── Conversations ─────────────────────────────────────────────────
function filterConversations(){
  const q      = (document.getElementById('convSearch')?.value||'').toLowerCase();
  const status = document.getElementById('convStatusFilter')?.value||'all';
  const filtered = allConversations.filter(c=>{
    if(status!=='all' && c.status !== status) return false;
    if(q){
      const hay = [(c.customer_phone||''),(c.customer_name||'')].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
  renderConversations(filtered);
}

function renderConversations(convs){
  const el = document.getElementById('conversationList');
  if(!el) return;
  if(!convs.length){ el.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);">No conversations found.</div>'; return; }
  el.innerHTML = convs.map(c=>{
    const cleanPhone = (c.customer_phone||'').replace(/[^0-9]/g,'');
    const statusBadge = `<span class="conv-badge badge-${c.status||'active'}">${c.status||'active'}</span>`;
    const vehicle = c.vehicle_type ? `${c.vehicle_type}` : '';
    const budget  = c.budget       ? ` · ${c.budget}`    : '';
    const msgs    = c.message_count? ` · ${c.message_count} msgs` : '';
    // Show voice activity indicator if last message was a call/voicemail
    const lastMsg = c.last_message || '';
    const hasVoice = lastMsg.startsWith('[Call')||lastMsg.startsWith('[VM')||lastMsg.startsWith('[Missed');
    const voiceTag = hasVoice ? ` · ${lastMsg.split('|')[0].trim()}` : '';
    return `<div class="conv-item" id="convitem-${cleanPhone}">
      <div class="conv-header" onclick="toggleConversation('${c.customer_phone}','${cleanPhone}')">
        <div class="conv-avatar">${(c.customer_name||'?')[0].toUpperCase()}</div>
        <div class="conv-info">
          <div class="conv-name">${c.customer_name||'Unknown'} ${statusBadge}</div>
          <div class="conv-phone">${c.customer_phone||''}</div>
          <div class="conv-meta">${vehicle}${budget}${msgs}${voiceTag} · Stage: ${c.stage||'—'}</div>
        </div>
        <div class="conv-right">
          <span class="conv-time">${c.updated_at?new Date(c.updated_at).toLocaleDateString():''}</span>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();loadConvToDeskCRM('${c.customer_phone}','${c.customer_name||''}','${c.vehicle_type||''}')">→ Desk</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:rgba(239,68,68,.3);" onclick="event.stopPropagation();deleteConversation('${c.customer_phone}')">✕</button>
          </div>
        </div>
      </div>
      <div class="conv-thread" id="thread-${cleanPhone}"></div>
    </div>`;
  }).join('');
}

async function toggleConversation(phone, cleanPhone){
  const thread = document.getElementById('thread-'+cleanPhone);
  if(!thread) return;
  if(thread.classList.contains('open')){ thread.classList.remove('open'); return; }
  thread.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:12px;">Loading...</div>';
  thread.classList.add('open');
  try {
    const data = await FF.apiFetch('/api/conversation/'+encodeURIComponent(phone)).then(r=>r.json());
    if(data.error||!data.messages?.length){ thread.innerHTML='<div style="padding:10px;color:var(--muted);font-size:12px;">No messages yet.</div>'; return; }
    const inputId = 'ri-'+cleanPhone, btnId = 'rb-'+cleanPhone;
    thread.innerHTML = data.messages.map(m=>`
      <div class="msg-bubble ${m.role}">
        <div class="msg-role">${m.role==='user'?'Customer':'Sarah AI'}</div>
        <div style="color:var(--text);line-height:1.5;white-space:pre-wrap;">${escapeHtml(m.content)}</div>
        <div class="msg-time">${new Date(m.created_at).toLocaleString()}</div>
      </div>`).join('') +
      `<div class="reply-bar">
        <input type="text" class="reply-input-field" id="${inputId}" placeholder="Reply to this customer..." onkeypress="if(event.key==='Enter'){event.preventDefault();sendThreadReply('${phone}','${inputId}','${btnId}');}">
        <button class="btn btn-primary" id="${btnId}" onclick="sendThreadReply('${phone}','${inputId}','${btnId}')">Send</button>
      </div>`;
    thread.scrollTop = thread.scrollHeight;
  } catch(e){ thread.innerHTML='<div style="padding:10px;color:var(--red);font-size:12px;">Error loading messages</div>'; }
}

async function sendThreadReply(phone, inputId, btnId){
  const input = document.getElementById(inputId);
  const btn   = document.getElementById(btnId);
  const msg   = input?.value?.trim();
  if(!msg) return;
  btn.disabled=true; btn.textContent='...';
  try {
    const res = await FF.apiFetch('/api/manual-reply',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({phone,message:msg})
    }).then(r=>r.json());
    if(res.success){ input.value=''; toast('Reply sent'); }
    else toast(res.error);
  } catch(e){ toast(e.message); }
  btn.disabled=false; btn.textContent='Send';
}

async function deleteConversation(phone){
  if(!confirm('Delete this entire conversation? This cannot be undone.')) return;
  try {
    const res = await FF.apiFetch('/api/conversation/'+encodeURIComponent(phone),{method:'DELETE'}).then(r=>r.json());
    if(res.success){ toast('Conversation deleted'); loadSarahDashboard(); }
    else toast(res.error);
  } catch(e){ toast(e.message); }
}

function loadConvToDeskCRM(phone, name, vehicle){
  setVal('custName', name||'');
  setVal('custPhone', phone.replace('+1',''));
  if(vehicle) setVal('vehicleDesc', vehicle);
  showSection('deal');
  toast((name||phone)+' loaded into Deal Desk');
}

// ── Appointments ──────────────────────────────────────────────────
function renderAppointments(apts){
  const el = document.getElementById('appointmentsList');
  if(!el) return;
  if(!apts.length){ el.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);">No appointments yet.</div>'; return; }
  el.innerHTML = apts.map(a=>`
    <div class="appt-card">
      <div class="appt-top" onclick="document.getElementById('aptd-${a.id}').classList.toggle('open')">
        <div>
          <div class="appt-name">${escapeHtml(a.customer_name||'Unknown')} — ${escapeHtml(a.datetime||'TBD')}</div>
          <div class="appt-vehicle">${escapeHtml(a.vehicle_type||'—')} · ${a.customer_phone}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();loadConvToDeskCRM('${a.customer_phone}','${escapeHtml(a.customer_name||'')}','${escapeHtml(a.vehicle_type||'')}')">→ Desk</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:rgba(239,68,68,.3);" onclick="event.stopPropagation();deleteAppointment(${a.id})">✕</button>
        </div>
      </div>
      <div class="appt-detail" id="aptd-${a.id}">
        <span class="detail-label">Name:</span> <span class="detail-val">${escapeHtml(a.customer_name||'—')}</span> &nbsp;·&nbsp;
        <span class="detail-label">Phone:</span> <span class="detail-val">${a.customer_phone}</span><br>
        <span class="detail-label">Vehicle:</span> <span class="detail-val">${escapeHtml(a.vehicle_type||'—')}</span> &nbsp;·&nbsp;
        <span class="detail-label">Budget:</span> <span class="detail-val">${escapeHtml(a.budget||'—')}${a.budget_amount?' ($'+parseInt(a.budget_amount).toLocaleString()+')':''}</span><br>
        <span class="detail-label">Date/Time:</span> <span class="detail-val">${escapeHtml(a.datetime||'—')}</span><br>
        <span class="detail-label">Booked:</span> <span class="detail-val">${new Date(a.created_at).toLocaleString()}</span>
      </div>
    </div>`).join('');
}

async function deleteAppointment(id){
  if(!confirm('Delete this appointment?')) return;
  const res = await FF.apiFetch('/api/appointment/'+id,{method:'DELETE'}).then(r=>r.json());
  if(res.success){ toast('Deleted'); loadSarahDashboard(); }
  else toast(res.error);
}

// ── Callbacks ─────────────────────────────────────────────────────
function renderCallbacks(cbs){
  const el = document.getElementById('callbacksList');
  if(!el) return;
  if(!cbs.length){ el.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);">No callback requests yet.</div>'; return; }
  el.innerHTML = cbs.map(c=>`
    <div class="appt-card" style="border-left:3px solid var(--amber);">
      <div class="appt-top" onclick="document.getElementById('cbd-${c.id}').classList.toggle('open')">
        <div>
          <div class="appt-name">${escapeHtml(c.customer_name||'Unknown')} — ${escapeHtml(c.datetime||'Anytime')}</div>
          <div class="appt-vehicle" style="color:var(--amber);">${escapeHtml(c.vehicle_type||'—')} · ${c.customer_phone}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();loadConvToDeskCRM('${c.customer_phone}','${escapeHtml(c.customer_name||'')}','${escapeHtml(c.vehicle_type||'')}')">→ Desk</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:rgba(239,68,68,.3);" onclick="event.stopPropagation();deleteCallback(${c.id})">✕</button>
        </div>
      </div>
      <div class="appt-detail" id="cbd-${c.id}">
        <span class="detail-label">Name:</span> <span class="detail-val">${escapeHtml(c.customer_name||'—')}</span> &nbsp;·&nbsp;
        <span class="detail-label">Phone:</span> <span class="detail-val">${c.customer_phone}</span><br>
        <span class="detail-label">Vehicle:</span> <span class="detail-val">${escapeHtml(c.vehicle_type||'—')}</span> &nbsp;·&nbsp;
        <span class="detail-label">Budget:</span> <span class="detail-val">${escapeHtml(c.budget||'—')}</span><br>
        <span class="detail-label">Preferred Time:</span> <span class="detail-val">${escapeHtml(c.datetime||'—')}</span>
      </div>
    </div>`).join('');
}

async function deleteCallback(id){
  if(!confirm('Delete this callback request?')) return;
  const res = await FF.apiFetch('/api/callback/'+id,{method:'DELETE'}).then(r=>r.json());
  if(res.success){ toast('Deleted'); loadSarahDashboard(); }
  else toast(res.error);
}

// ── Launch SMS ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  const lm = document.getElementById('launchMessage');
  if(lm) lm.addEventListener('input',()=>{ const cc=document.getElementById('launchCharCount'); if(cc) cc.textContent=lm.value.length+' characters'; });
});

function formatPhoneInput(el){
  let d = el.value.replace(/[^0-9]/g,'');
  if(d.startsWith('1')) d=d.slice(1);
  d = d.slice(0,10);
  let out='';
  if(d.length>0) out='('+d.slice(0,3);
  if(d.length>=4) out+=') '+d.slice(3,6);
  if(d.length>=7) out+='-'+d.slice(6,10);
  el.value=out;
}

function phoneInputToE164(input){
  const d = input.replace(/[^0-9]/g,'');
  if(d.length===10) return '+1'+d;
  if(d.length===11&&d.startsWith('1')) return '+'+d;
  return null;
}

async function sendLaunchSMS(){
  const phone = phoneInputToE164(document.getElementById('launchPhone')?.value||'');
  const msg   = document.getElementById('launchMessage')?.value?.trim();
  const btn   = document.getElementById('launchSendBtn');
  const res   = document.getElementById('launchResult');
  if(!phone){ toast('Invalid phone number'); return; }
  if(!msg){ toast('Enter a message'); return; }
  btn.disabled=true; btn.textContent='⏳ Sending...';
  res.style.display='none';
  try {
    const data = await FF.apiFetch('/api/start-sms',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({phone,message:msg})
    }).then(r=>r.json());
    if(data.success){
      res.style.cssText='display:block;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:6px;padding:10px;font-size:12px;color:var(--green);';
      res.textContent='SMS sent to '+phone;
      document.getElementById('launchPhone').value='';
    } else throw new Error(data.error||'Failed');
  } catch(e){
    res.style.cssText='display:block;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:10px;font-size:12px;color:var(--red);';
    res.textContent=e.message;
  }
  btn.disabled=false; btn.textContent='Send Message';
}

async function sendManualReplyForm(){
  const phone = phoneInputToE164(document.getElementById('replyPhone')?.value||'');
  const msg   = document.getElementById('replyMessage')?.value?.trim();
  const res   = document.getElementById('replyResult');
  if(!phone){ toast('Invalid phone number'); return; }
  if(!msg){ toast('Enter a message'); return; }
  try {
    const data = await FF.apiFetch('/api/manual-reply',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({phone,message:msg})
    }).then(r=>r.json());
    if(data.success){
      res.style.cssText='display:block;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:6px;padding:10px;font-size:12px;color:var(--green);';
      res.textContent='Reply sent to '+phone;
      document.getElementById('replyMessage').value='';
    } else throw new Error(data.error||'Failed');
  } catch(e){
    res.style.cssText='display:block;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:10px;font-size:12px;color:var(--red);';
    res.textContent=e.message;
  }
}

// ── Bulk SMS ──────────────────────────────────────────────────────
let parsedContacts = [];

function handleDragOver(e){ e.preventDefault(); document.getElementById('bulkDropZone').classList.add('drag-over'); }
function handleDragLeave(){ document.getElementById('bulkDropZone').classList.remove('drag-over'); }
function handleFileDrop(e){
  e.preventDefault();
  handleDragLeave();
  const file = e.dataTransfer.files[0];
  if(file) parseCSVFile(file);
}
function handleFileSelect(e){ const file = e.target.files[0]; if(file) parseCSVFile(file); }

function parseCSVFile(file){
  const reader = new FileReader();
  reader.onload = e => {
    const lines = e.target.result.split('\n');
    const contacts=[], errors=[], seen=new Set();
    const BLACKLIST=['2899688778','12899688778'];
    let start=0;
    if(lines[0]&&lines[0].toLowerCase().includes('name')) start=1;
    for(let i=start;i<lines.length;i++){
      const line=lines[i].trim(); if(!line) continue;
      const parts=line.split(',');
      if(parts.length<2){ errors.push('Row '+(i+1)+': Missing data'); continue; }
      const name=parts[0].trim().replace(/"/g,'');
      const raw=parts[1].trim().replace(/"/g,'');
      const d=raw.replace(/[^0-9]/g,'');
      let phone=d;
      if(d.length===10) phone='+1'+d;
      else if(d.length===11&&d.startsWith('1')) phone='+'+d;
      if(!phone.startsWith('+1')||phone.length!==12){ errors.push('Row '+(i+1)+': Invalid phone'); continue; }
      if(BLACKLIST.some(b=>phone.includes(b))){ errors.push('Row '+(i+1)+': Blacklisted'); continue; }
      if(seen.has(phone)){ errors.push('Row '+(i+1)+': Duplicate'); continue; }
      seen.add(phone); contacts.push({name,phone});
    }
    if(!contacts.length){ toast('No valid contacts in file'); return; }
    parsedContacts=contacts;
    const preview=document.getElementById('contactPreview');
    const countEl=document.getElementById('contactCountDisplay');
    const listEl=document.getElementById('contactList');
    const errEl=document.getElementById('csvErrors');
    if(countEl) countEl.textContent=contacts.length+' valid contacts loaded';
    if(listEl) listEl.innerHTML=contacts.slice(0,8).map(c=>'<div style="padding:2px 0;font-size:11px;">✓ '+escapeHtml(c.name)+' — '+c.phone+'</div>').join('')+(contacts.length>8?'<div style="font-size:11px;color:var(--muted);">...and '+(contacts.length-8)+' more</div>':'');
    if(errEl) errEl.innerHTML=errors.length?'<div style="font-size:11px;color:var(--amber);margin-top:6px;">'+errors.length+' skipped</div>':'';
    if(preview) preview.style.display='block';
    document.getElementById('campaignForm').style.display='block';
    toast(contacts.length+' contacts ready');
  };
  reader.readAsText(file);
}

async function launchBulkCampaign(){
  const name = document.getElementById('campaignName')?.value?.trim();
  const tmpl = document.getElementById('messageTemplate')?.value?.trim();
  if(!name){ toast('Enter a campaign name'); return; }
  if(!tmpl){ toast('Enter a message template'); return; }
  if(!tmpl.includes('{name}')){ toast('Template must include {name}'); return; }
  if(!parsedContacts.length){ toast('Upload a CSV first'); return; }
  if(!confirm('Launch "'+name+'" to '+parsedContacts.length+' contacts?')) return;
  try {
    const res = await FF.apiFetch('/api/bulk-sms/create-campaign',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({campaignName:name,messageTemplate:tmpl,contacts:parsedContacts})
    }).then(r=>r.json());
    if(res.success){
      document.getElementById('campaignForm').style.display='none';
      document.getElementById('progressTracker').style.display='block';
      toast('Launched! '+res.messageCount+' messages (~'+res.estimatedTime+' min)');
      trackBulkProgress(name);
    } else toast(res.error);
  } catch(e){ toast(e.message); }
}

let _progressTimer=null;
function trackBulkProgress(name){
  updateBulkProgress(name);
  if(_progressTimer) clearInterval(_progressTimer);
  _progressTimer=setInterval(()=>updateBulkProgress(name),3000);
}

async function updateBulkProgress(name){
  try {
    const s = await FF.apiFetch('/api/bulk-sms/campaign/'+encodeURIComponent(name)).then(r=>r.json());
    document.getElementById('sentCount').textContent    = s.sent;
    document.getElementById('pendingCount').textContent = s.pending;
    document.getElementById('failedCount').textContent  = s.failed;
    const pct = s.total>0?Math.round((parseInt(s.sent)/parseInt(s.total))*100):0;
    document.getElementById('progressBar').style.width  = pct+'%';
    const done = parseInt(s.pending)===0;
    document.getElementById('progressText').textContent = done?'Complete! '+s.sent+' sent':'Sending... ('+s.sent+'/'+s.total+')';
    if(done&&_progressTimer){ clearInterval(_progressTimer); _progressTimer=null; }
  } catch(e){ console.error('Progress error',e); }
}

async function checkBulkStatus(){
  try {
    const d = await FF.apiFetch('/api/bulk-status').then(r=>r.json());
    const display=document.getElementById('bulkStatusDisplay');
    const running = d.processorRunning;
    const paused  = d.paused;
    let html = '<div style="font-size:13px;font-weight:700;margin-bottom:10px;">Processor: ';
    html += running?(paused?'<span style="color:var(--amber);">PAUSED</span>':'<span style="color:var(--green);">RUNNING</span>'):'<span style="color:var(--red);">STOPPED</span>';
    html += '</div>';
    if(d.stats?.length){
      d.stats.forEach(s=>{
        const em = s.status==='sent'?'Sent':s.status==='failed'?'Failed':s.status==='cancelled'?'Cancelled':'Pending';
        html+=`<div style="font-size:12px;padding:4px 0;">${em} <strong>${s.status.toUpperCase()}</strong>: ${s.count}</div>`;
      });
    } else { html+='<div style="font-size:12px;color:var(--green);">✓ Queue empty</div>'; }
    display.innerHTML=html; display.style.display='block';
  } catch(e){ toast(e.message); }
}

async function pauseBulkSMS(){
  const d=await adminFetch('/api/bulk-sms/pause'); if(!d) return;
  if(d.success){ toast('Bulk SMS paused'); checkBulkStatus(); } else toast(d.error);
}
async function resumeBulkSMS(){
  const d=await adminFetch('/api/bulk-sms/resume'); if(!d) return;
  if(d.success){ toast('Bulk SMS resumed'); checkBulkStatus(); } else toast(d.error);
}
async function nuclearClear(event){
  if(!confirm('CANCEL ALL OUTGOING SMS?\n\n\u2022 Cancel every queued/sending Twilio message\n\u2022 Wipe all pending bulk messages\n\nEverything auto-resumes after flush. Proceed?')) return;
  const btn=event?.target?.closest('button');
  if(btn){btn.disabled=true;btn.textContent='Flushing...';}
  try{
    const d=await adminFetch('/api/nuclear-clear');
    if(!d) return;
    alert('FLUSH COMPLETE \u2014 systems resumed.\n\n'
      +'Twilio queued: '+d.twilioQueued+'\n'
      +'Twilio sending: '+d.twilioSending+'\n'
      +'Bulk wiped: '+d.bulkCancelled);
    loadSarahDashboard();
  }catch(e){alert('Failed: '+e.message);}
  finally{if(btn){btn.disabled=false;btn.innerHTML='<i data-lucide="zap-off" class="ico-sm"></i> CANCEL ALL SMS';if(window.lucide)lucide.createIcons();}}
}

async function emergencyStopBulk(){
  if(!confirm('EMERGENCY STOP — Cancel ALL pending messages?')) return;
  const d=await adminFetch('/api/emergency-stop-bulk'); if(!d) return;
  if(d.success){ toast('Emergency stop! '+d.cancelled+' messages cancelled'); checkBulkStatus(); }
}
async function stopMyBulkSMS(){
  if(!confirm('Cancel all your pending outgoing bulk messages?\n\nMessages already sent will not be recalled. Proceed?')) return;
  try{
    const d = await FF.apiFetch('/api/bulk-sms/stop-mine',{method:'POST'}).then(r=>r.json());
    if(d.success){ toast('✓ '+d.cancelled+' pending messages cancelled'); checkBulkStatus(); }
    else toast(d.error||'Failed');
  }catch(e){ toast('Failed: '+e.message); }
}
async function wipeBulkMessages(){
  if(!confirm('Wipe ALL bulk messages from queue? This cannot be undone.')) return;
  const d=await adminFetch('/api/wipe-bulk'); if(!d) return;
  if(d.success){ toast('Queue wiped ('+d.wiped+' messages)'); checkBulkStatus(); }
}

// ── Voice (uses Sarah's new voice API routes) ─────────────────────
async function sendVoiceDrop(){
  const phone        = phoneInputToE164(document.getElementById('vd_phone')?.value||'');
  const customerName = document.getElementById('vd_name')?.value||'there';
  const message      = document.getElementById('vd_message')?.value||'';
  const res          = document.getElementById('voiceDropResult');
  if(!phone){ toast('Invalid phone'); return; }
  try {
    const d = await FF.apiFetch('/api/voice/drop-v2',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({phone,customerName,message})
    }).then(r=>r.json());
    if(d.success){
      res.style.cssText='display:block;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:6px;padding:10px;font-size:12px;color:var(--green);';
      res.textContent='Drop sent! Natural pacing active. Call SID: '+d.callSid;
    } else throw new Error(d.error||'Failed');
  } catch(e){
    res.style.cssText='display:block;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:10px;font-size:12px;color:var(--red);';
    res.textContent=e.message;
  }
}

function updateVCCount(){
  const s=(document.getElementById('vc_status')||{}).value||'Lead';
  const count=crmData.filter(c=>c.phone&&(s==='all'||c.status===s)).length;
  const el=document.getElementById('vcTargetCount');
  if(el) el.textContent=count+' CRM contacts will receive this call';
}

async function sendVoiceCampaign(){
  const message = document.getElementById('vc_message')?.value;
  const status  = (document.getElementById('vc_status')||{}).value||'Lead';
  const contacts= crmData.filter(c=>c.phone&&(status==='all'||c.status===status)).map(c=>({name:c.name||'there',phone:c.phone}));
  if(!contacts.length){ toast('No CRM contacts match that filter'); return; }
  if(!message){ toast('Enter a message script'); return; }
  if(!confirm('Send voice drops to '+contacts.length+' contacts?')) return;
  try {
    const d = await FF.apiFetch('/api/voice/campaign',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contacts,message,delaySeconds:10})
    }).then(r=>r.json());
    if(d.success) toast('Voice campaign launched — '+d.scheduled+' calls queued!');
    else toast(d.error);
  } catch(e){ toast(e.message); }
}

// ── Exports ───────────────────────────────────────────────────────
async function exportData(type){
  try {
    const res = await FF.apiFetch('/api/export/'+type);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = type+'_'+new Date().toISOString().split('T')[0]+'.csv';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  } catch(e){ toast('Export failed'); }
}

// ── Deal funded → follow-up SMS  (called from logDeal) ────────────
async function sendDealFundedFollowup(phone, customerName, vehicleDesc){
  if(!phone) return;
  try {
    await FF.apiFetch('/api/deal-funded',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({phone,customerName,vehicleDesc,dealership:settings.dealerName||''})
    });
    console.log('Deal follow-up SMS triggered for',phone);
  } catch(e){ console.warn('Follow-up SMS failed (non-critical):', e.message); }
}

// ── HTML escape helper ────────────────────────────────────────────
function escapeHtml(str){
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Auto-refresh Sarah every 30 seconds when on Sarah tab
setInterval(()=>{
  if(document.getElementById('section-sarah')?.classList.contains('active')){
    loadSarahDashboard();
  }
}, 30000);



// ── Unified timeline message renderer ────────────────────────────
function renderTimelineMessage(m) {
  const content = m.content || '';
  const time    = m.created_at ? new Date(m.created_at).toLocaleString() : '';

  // ── Voice events — special pills ─────────────────────────────
  if (content.startsWith('[Call') || content.startsWith('[VM') || content.startsWith('[Missed')) {
    let icon = 'call', label = '', color = 'var(--primary)', bg = 'rgba(30,90,246,.08)', border = 'rgba(30,90,246,.2)';

    if (content.includes('VOICEMAIL')) {
      icon = 'vm'; color = 'var(--amber)'; bg = 'rgba(245,158,11,.08)'; border = 'rgba(245,158,11,.2)';
      // Extract transcript if present
      const txMatch = content.match(/transcript:\s*"(.+)"$/s);
      const durMatch = content.match(/duration:(\d+s)/);
      label = (durMatch ? durMatch[1] + ' voicemail' : 'Voicemail');
      const tx = txMatch ? txMatch[1] : null;
      return `<div style="display:flex;justify-content:center;margin:8px 0;">
        <div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:8px 14px;max-width:90%;text-align:center;">
          <div style="font-size:11px;font-weight:700;color:${color};">${icon} ${label}</div>
          ${tx ? `<div style="font-size:11px;color:var(--text);margin-top:4px;font-style:italic;">"${escapeHtml(tx.substring(0,120))}${tx.length>120?'...':''}"</div>` : ''}
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${time}</div>
        </div>
      </div>`;
    }

    if (content.includes('VOICE_DROP')) {
      icon = 'missed'; color = '#8b5cf6'; bg = 'rgba(139,92,246,.08)'; border = 'rgba(139,92,246,.2)';
      label = content.includes('CALLBACK') ? 'Called back — connected' : 'Voicemail drop sent';
    } else if (content.includes('CALL_INBOUND')) {
      const statusMatch = content.match(/status:(\w+)/);
      const status = statusMatch ? statusMatch[1] : 'inbound';
      const durMatch = content.match(/duration:(\d+s)/);
      const statusLabels = {
        connecting: 'Called in — forwarded to you',
        voicemail_requested: 'Called in — went to voicemail',
        text_back_requested: 'Called in — requested text back',
        completed: 'Call completed' + (durMatch ? ' ' + durMatch[1] : ''),
        'no-answer': 'Called — no answer',
        busy: 'Called — line busy',
        failed: 'Call failed'
      };
      label = statusLabels[status] || 'Inbound call';
    } else if (content.includes('CALL_COMPLETE')) {
      const statusMatch = content.match(/status:(.+)$/);
      label = 'Call ended — ' + (statusMatch ? statusMatch[1] : '');
    }

    return `<div style="display:flex;justify-content:center;margin:8px 0;">
      <div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:7px 16px;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:${color};">${icon} ${label}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">${time}</div>
      </div>
    </div>`;
  }

  // ── Regular SMS message ───────────────────────────────────────
  const isUser = m.role === 'user';
  return `<div class="msg-bubble ${m.role}">
    <div class="msg-role">${isUser ? 'Customer' : 'Sarah AI'}</div>
    <div style="color:var(--text);line-height:1.5;white-space:pre-wrap;">${escapeHtml(content)}</div>
    <div class="msg-time">${time}</div>
  </div>`;
}

// ── Voicemails ────────────────────────────────────────────────────
async function loadVoicemails(){
  const el = document.getElementById('voicemailsList');
  if(!el) return;
  el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);">Loading...</div>';
  try {
    const data  = await FF.apiFetch('/api/voicemails').then(r=>r.json());
    if(!data.success) throw new Error(data.error);
    if(!data.voicemails.length){
      el.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);">No voicemails yet. Once your Twilio number is configured for inbound calls, voicemails will appear here.</div>';
      return;
    }
    el.innerHTML = data.voicemails.map(v => {
      const caller  = (v.caller_phone||'').replace('+1','');
      const date    = v.created_at ? new Date(v.created_at).toLocaleString() : '—';
      const dur     = v.duration   ? v.duration+'s' : '—';
      const hasRec  = v.recording_url && v.recording_url.length > 10;
      const hasTx   = v.transcript  && v.transcript.length > 3;
      return `<div class="appt-card" style="border-left:3px solid var(--primary);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:700;font-size:13px;">${caller} <span style="color:var(--muted);font-weight:400;font-size:11px;">${date} · ${dur}</span></div>
            ${hasTx
              ? `<div style="font-size:12px;color:var(--text);margin-top:6px;line-height:1.5;background:var(--surface2);padding:10px;border-radius:6px;border-left:3px solid var(--amber);">"${escapeHtml(v.transcript)}"</div>`
              : '<div style="font-size:11px;color:var(--muted);margin-top:4px;">⏳ Transcript pending...</div>'
            }
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;">
            ${hasRec ? `<a href="${v.recording_url}" target="_blank" class="btn btn-primary btn-sm">▶ Listen</a>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="loadConvToDeskCRM('+1${caller}','','')">→ Desk</button>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch(e){
    el.innerHTML = '<div style="padding:20px;color:var(--red);">' + +e.message+'</div>';
  }
}


// ── Mobile hamburger menu ─────────────────────────────────────────
function toggleMobileMenu(){
  const menu    = document.getElementById('mobileMenu');
  const overlay = document.getElementById('mobileOverlay');
  const btn     = document.getElementById('hamburgerBtn');
  const isOpen  = menu.classList.contains('open');
  if(isOpen){ closeMobileMenu(); }
  else {
    menu.classList.add('open');
    overlay.classList.add('open');
    btn.classList.add('open');
    document.body.style.overflow = 'hidden'; // prevent scroll behind
  }
}

function closeMobileMenu(){
  document.getElementById('mobileMenu')?.classList.remove('open');
  document.getElementById('mobileOverlay')?.classList.remove('open');
  document.getElementById('hamburgerBtn')?.classList.remove('open');
  document.body.style.overflow = '';
}

function mobileNav(section){
  closeMobileMenu();
  showSection(section);
  // Scroll to top so you see the section from the start
  window.scrollTo({top:0, behavior:'smooth'});
  // Update active state in mobile menu
  document.querySelectorAll('.mobile-nav-btn').forEach(b=>{
    b.classList.remove('active');
    if(b.getAttribute('onclick')?.includes("'"+section+"'")) b.classList.add('active');
  });
}

// Close menu on ESC key
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') closeMobileMenu();
});

// ── INIT ─────────────────────────────────────────────
// ── LENDER DEAL PACKAGE ──────────────────────────────────────────
function copyDealPackage(lenderName) {
  const d       = getDealData();
  const v       = d.vehicle;
  const f       = d.financial;
  const c       = d.customer;
  const price   = parseFloat(f.price)     || 0;
  const doc     = parseFloat(f.doc)       || 0;
  const tAllow  = parseFloat(f.tAllow)    || 0;
  const tPayoff = parseFloat(f.tPayoff)   || 0;
  const gst     = parseFloat(f.gst)       || 5;
  const down    = parseFloat(f.finalDown) || 0;
  const apr     = parseFloat(f.apr)       || 0;
  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst / 100);
  const otd      = price + doc - netTrade + gstAmt;
  const atf      = Math.max(0, otd - down);

  const vsc = parseFloat(document.getElementById('vscPrice')?.value) || 0;
  const gap = parseFloat(document.getElementById('gapPrice')?.value) || 0;
  const beacon = parseFloat(document.getElementById('creditScore')?.value) || 0;
  const income = parseFloat(document.getElementById('monthlyIncome')?.value) || 0;

  const lender = lenderName ? `Submitting To:      ${lenderName}` : '';

  const pkg = [
    '═══════════════════════════════════════════',
    `  DEAL SUBMISSION — ${(settings.dealerName || 'Dealer').toUpperCase()}`,
    `  ${new Date().toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`,
    '═══════════════════════════════════════════',
    '',
    '── VEHICLE ─────────────────────────────────',
    `Description:        ${v.desc || '—'}`,
    `Stock #:            ${v.stock || '—'}`,
    `VIN (last 8):       ${v.vin || '—'}`,
    `Odometer:           ${v.km ? parseInt(v.km).toLocaleString() + ' km' : '—'}`,
    `Condition:          ${v.condition || '—'}`,
    '',
    '── CUSTOMER ────────────────────────────────',
    `Name:               ${c.name || '—'}`,
    `Phone:              ${c.phone || '—'}`,
    `Email:              ${c.email || '—'}`,
    beacon > 0 ? `Beacon Score:       ${beacon}` : null,
    income > 0 ? `Monthly Income:     $${income.toLocaleString()}` : null,
    '',
    '── DEAL STRUCTURE ──────────────────────────',
    `Selling Price:      $${price.toLocaleString('en-CA', {minimumFractionDigits:2})}`,
    doc > 0 ? `Doc Fee:            $${doc.toLocaleString('en-CA', {minimumFractionDigits:2})}` : null,
    tAllow > 0 ? `Trade Allowance:    $${tAllow.toLocaleString('en-CA', {minimumFractionDigits:2})}` : null,
    tPayoff > 0 ? `Trade Payoff:       $${tPayoff.toLocaleString('en-CA', {minimumFractionDigits:2})}` : null,
    `GST (${gst}%):          $${gstAmt.toLocaleString('en-CA', {minimumFractionDigits:2})}`,
    `Total OTD:          $${otd.toLocaleString('en-CA', {minimumFractionDigits:2})}`,
    `Down Payment:       $${down.toLocaleString('en-CA', {minimumFractionDigits:2})}`,
    `Amount to Finance:  $${atf.toLocaleString('en-CA', {minimumFractionDigits:2})}`,
    vsc > 0 ? `VSC:                $${vsc.toLocaleString('en-CA', {minimumFractionDigits:2})}` : null,
    gap > 0 ? `GAP:                $${gap.toLocaleString('en-CA', {minimumFractionDigits:2})}` : null,
    '',
    '── REQUESTED TERMS ─────────────────────────',
    `Rate Requested:     ${apr}%`,
    lender,
    '',
    '═══════════════════════════════════════════',
    `  Submitted by: ${settings.salesName || settings.dealerName || '—'}`,
    '═══════════════════════════════════════════',
  ].filter(l => l !== null).join('\n');

  navigator.clipboard.writeText(pkg).then(() => {
    toast(`✓ Deal package copied${lenderName ? ' for ' + lenderName : ''} — paste into your lender portal`);
  }).catch(() => {
    // Fallback for browsers that block clipboard
    const ta = document.createElement('textarea');
    ta.value = pkg;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(`✓ Deal package copied${lenderName ? ' for ' + lenderName : ''}`);
  });
}

// ── BILLING ENFORCEMENT ──────────────────────────────────────────
function checkBillingBanner(billing) {
  if (!billing) return;

  // Remove existing banner
  const existing = document.getElementById('billingBanner');
  if (existing) existing.remove();

  const access   = billing.access;
  const reason   = billing.reason;
  const daysLeft = billing.daysLeft;

  // Full access — ensure desk blur is cleared
  if (access === 'full' && reason === 'active') { _removeDeskBlur(); return; }
  if (access === 'full' && reason === 'exempt') { _removeDeskBlur(); return; }
  if (access === 'full' && reason === 'trial')  { _removeDeskBlur(); }

  const banner = document.createElement('div');
  banner.id = 'billingBanner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:700;';

  if (access === 'readonly') {
    // Expired or lapsed — lock write operations
    banner.style.background = 'linear-gradient(90deg,#dc2626,#991b1b)';
    banner.style.color = '#fff';
    const msg = reason === 'trial_expired'
      ? '⚠️ Your free trial has ended — upgrade to continue using FIRST-FIN'
      : '⚠️ Your subscription is inactive — please renew to restore access';
    banner.innerHTML = `
      <span>${msg}</span>
      <button onclick="showSection('settings');closeModal && closeModal('billingBanner');"
        style="background:#fff;color:#dc2626;border:none;border-radius:6px;padding:6px 16px;font-weight:800;cursor:pointer;margin-left:16px;white-space:nowrap;">
        Upgrade Now
      </button>`;
    document.body.appendChild(banner);
    _enforceReadonly();
    _applyDeskBlur();

  } else if (access === 'full' && reason === 'trial' && daysLeft <= 3) {
    // Trial ending soon — warning banner, no lockout
    banner.style.background = 'linear-gradient(90deg,#d97706,#92400e)';
    banner.style.color = '#fff';
    banner.innerHTML = `
      <span>⏳ Trial ends in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong> — upgrade to keep full access</span>
      <button onclick="banner.remove ? banner.remove() : banner.parentNode.removeChild(banner)"
        style="background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:5px 12px;font-weight:700;cursor:pointer;margin-left:16px;">
        Dismiss
      </button>`;
    document.body.appendChild(banner);
  }
}

function _applyDeskBlur() {
  const BLUR_IDS = [
    'paymentGrid', 'totalOTD', 'finalDownDisplay', 'financeAmountDisplay',
    'basePayment72', 'withGap', 'withGapVsc', 'withAllProtection', 'fullProtection',
    'reserveProfit', 'rateSpread', 'frontGross', 'backGross', 'totalGross',
    'dealPvr', 'dealLTV', 'ptiResult', 'dtiResult',
    'compareEligible', 'compareIneligible', 'compareSummaryBar'
  ];
  BLUR_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.filter = 'blur(6px)';
    el.style.userSelect = 'none';
    el.style.pointerEvents = 'none';
  });
  if (!document.getElementById('deskBlurOverlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'deskBlurOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:500;background:rgba(0,0,0,0.55);display:flex;flex-direction:column;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    overlay.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:40px 48px;text-align:center;max-width:420px;box-shadow:0 24px 80px rgba(0,0,0,.5);">
        <div style="font-size:36px;margin-bottom:12px;">🔒</div>
        <div style="font-size:20px;font-weight:900;color:var(--text);margin-bottom:8px;">Deal Desk Locked</div>
        <div style="font-size:14px;color:var(--muted);line-height:1.6;margin-bottom:24px;">
          Your trial has ended. Upgrade to unlock deal desking, payment grids, lender comparison, and all platform features.
        </div>
        <button onclick="showSection('settings')"
          style="background:var(--primary);color:#fff;border:none;border-radius:8px;padding:12px 32px;font-weight:800;font-size:14px;cursor:pointer;width:100%;">
          Upgrade Now →
        </button>
      </div>`;
    document.body.appendChild(overlay);
  }
}

function _removeDeskBlur() {
  ['paymentGrid','totalOTD','finalDownDisplay','financeAmountDisplay',
   'basePayment72','withGap','withGapVsc','withAllProtection','fullProtection',
   'reserveProfit','rateSpread','frontGross','backGross','totalGross',
   'dealPvr','dealLTV','ptiResult','dtiResult','compareEligible','compareIneligible','compareSummaryBar'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.filter = '';
    el.style.userSelect = '';
    el.style.pointerEvents = '';
  });
  const ov = document.getElementById('deskBlurOverlay');
  if (ov) ov.remove();
}

function _enforceReadonly() {
  // Disable all write-action buttons that would mutate data
  const WRITE_SELECTORS = [
    '#saveDealBtn', '#logDealBtn', '#sendSmsBtn',
    '#bulkSmsSubmit', '#launchVoiceBtn', '#voiceCampaignBtn',
    'button[onclick*="saveDeal"]', 'button[onclick*="logDeal"]',
    'button[onclick*="createCampaign"]', 'button[onclick*="sendVoiceDrop"]',
    'button[onclick*="sendBulk"]', 'button[onclick*="uploadInventory"]',
    'button[onclick*="importCSV"]'
  ];
  WRITE_SELECTORS.forEach(sel => {
    document.querySelectorAll(sel).forEach(btn => {
      btn.disabled = true;
      btn.title = 'Upgrade required';
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    });
  });
  // Override FF.apiFetch for write methods to show upgrade prompt
  const _origFetch = window.FF && window.FF.apiFetch;
  if (_origFetch && !window._readonlyEnforced) {
    window._readonlyEnforced = true;
    window.FF.apiFetch = function(url, opts) {
      const method = (opts && opts.method || 'GET').toUpperCase();
      const WRITE_PATHS = ['/api/deals', '/api/bulk-sms', '/api/voice/drop', '/api/voice/campaign'];
      if (method !== 'GET' && WRITE_PATHS.some(p => url.includes(p))) {
        toast('⚠️ Upgrade required to perform this action');
        return Promise.reject(new Error('readonly'));
      }
      return _origFetch.call(this, url, opts);
    };
  }
}

// ── CHANGE PASSWORD UI HANDLER ────────────────────────────────
async function changePassword() {
  const cur = getVal('pwCurrent');
  const n1  = getVal('pwNew');
  const n2  = getVal('pwConfirm');
  const btn = document.getElementById('pwChangeBtn');
  const msg = document.getElementById('pwChangeMsg');

  if (!cur || !n1 || !n2) { msg.style.color='var(--red)'; msg.textContent='All fields required.'; return; }
  if (n1 !== n2)           { msg.style.color='var(--red)'; msg.textContent='New passwords do not match.'; return; }
  if (n1.length < 6)       { msg.style.color='var(--red)'; msg.textContent='Password must be at least 6 characters.'; return; }
  if (cur === n1)          { msg.style.color='var(--red)'; msg.textContent='New password must differ from current.'; return; }

  btn.disabled = true;
  btn.textContent = 'Updating...';
  msg.textContent = '';

  try {
    const d = await FF.apiFetch('/api/desk/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: cur, newPassword: n1 })
    }).then(r => r.json());

    if (d.success) {
      msg.style.color = 'var(--green)';
      msg.textContent = '✓ Password updated. You will be logged out in 3 seconds.';
      setVal('pwCurrent', ''); setVal('pwNew', ''); setVal('pwConfirm', '');
      setTimeout(() => { FF.logout(); location.reload(); }, 3000);
    } else {
      msg.style.color = 'var(--red)';
      msg.textContent = d.error || 'Failed to update password.';
    }
  } catch(e) {
    msg.style.color = 'var(--red)';
    msg.textContent = 'Request failed. Try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Password';
  }
}

document.addEventListener('DOMContentLoaded',()=>{
  applyLenderRateOverrides();
  loadTenantRates(); // load tenant custom rate sheets from DB
  // initInventory(); ← api-client.js calls this after cloud data loads
  initLenderPanels();
  // Restore theme
  if(localStorage.getItem('ffTheme')==='light'){
    document.body.classList.add('light-mode');
    document.getElementById('darkModeBtn').textContent = 'Dark';
  }
  // Apply settings defaults
  setVal('docFee',settings.docFee);
  setVal('gstRate',settings.gst);
  setVal('apr',settings.apr);
  setVal('targetInput',settings.target);
  // Populate settings modal
  setVal('setPerson',settings.salesName);
  setVal('setDealer',settings.dealerName);
  setVal('setLogoUrl', settings.logoUrl||'');
  if(settings.logoUrl){ const el=document.getElementById('logo-preview'); if(el){el.src=settings.logoUrl;el.style.display='block';} }
  setVal('setDocFee',settings.docFee);
  setVal('setGST',settings.gst);
  setVal('setAPR',settings.apr);
  setVal('setTarget',settings.target);
  setVal('setTwilioNumber',   settings.twilioNumber   || '');
  setVal('setNotifyPhone',    settings.notifyPhone    || '');
  setVal('setGoogleReviewUrl', settings.googleReviewUrl || '');
  // Update header with dealer name
  if(typeof updateHeaderDealer === 'function') updateHeaderDealer();
  calculate();
  loadDealLog();
  // wizCheckAndShow is called by api-client.js _triggerRenders after server
  // settings are fully loaded — no need to poll or guess timing here
console.log('%cFIRST-FIN DEALER PLATFORM v1.0 LOADED','background:#1e5af6;color:white;padding:10px 20px;font-size:14px;font-weight:bold;border-radius:5px;');

// Initialize Lucide icons on page load and provide refresh function for dynamic content
if (typeof lucide !== 'undefined') {
  lucide.createIcons();
  window.refreshIcons = () => { try { lucide.createIcons(); } catch(e){} };
  // Auto-refresh icons periodically for first 10 seconds (catches dynamic renders)
  let _iconTick = 0;
  const _iconInterval = setInterval(() => {
    refreshIcons();
    if (++_iconTick >= 20) clearInterval(_iconInterval);
  }, 500);
} else {
  window.refreshIcons = () => {};
}
console.log('%cInventory: pending cloud sync | Lenders: '+Object.keys(lenders).length,'color:#f59e0b;font-size:12px;');
});

// ═══════════════════════════════════════════════════════════════
// v1.1 ADDITIONS: Presentation, Beacon Badges, Trade Carry,
//                 Scenarios, Rate Compare, Commission, Print,
//                 Lender Rate Editor
// ═══════════════════════════════════════════════════════════════

// ── LENDER RATE EDITOR ───────────────────────────────────────
// Load any locally-saved overrides on top of defaults
function applyLenderRateOverrides(){
  const saved = JSON.parse(localStorage.getItem('ffLenderRates') || '{}');
  Object.entries(saved).forEach(([lid, overrides]) => {
    if(lenders[lid]) Object.assign(lenders[lid], overrides);
  });
}

function buildLenderRateEditor(){
  const grid = document.getElementById('lenderRateEditorGrid');
  grid.innerHTML = '';
  Object.entries(lenders).forEach(([lid, l]) => {
    const hasCustom = window._tenantRates && window._tenantRates[lid] && window._tenantRates[lid].length;
    const customTiers = hasCustom ? window._tenantRates[lid] : [];
    const accentColor = hasCustom ? 'var(--green)' : 'var(--primary)';
    const accentAlpha = hasCustom ? 'rgba(16,185,129,.12)' : 'rgba(30,90,246,.08)';
    const accentBorder = hasCustom ? 'rgba(16,185,129,.3)' : 'rgba(30,90,246,.2)';
    grid.innerHTML += `
    <div id="lre-card-${lid}" style="
      background:var(--surface);
      border:1px solid ${accentBorder};
      border-top:3px solid ${accentColor};
      border-radius:10px;
      padding:16px;
      display:flex;
      flex-direction:column;
      gap:10px;
      transition:border-color .2s;
    ">
      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:2px;color:${accentColor};">${l.name}</div>
        ${hasCustom
          ? `<span style="font-size:9px;background:rgba(16,185,129,.15);color:var(--green);border:1px solid rgba(16,185,129,.3);border-radius:20px;padding:3px 9px;font-weight:700;letter-spacing:.5px;">★ CUSTOM — ${customTiers.length} TIERS</span>`
          : `<span style="font-size:9px;background:rgba(30,90,246,.1);color:var(--primary);border:1px solid rgba(30,90,246,.2);border-radius:20px;padding:3px 9px;font-weight:600;letter-spacing:.5px;">PLATFORM DEFAULTS</span>`}
      </div>

      <!-- Custom tiers display -->
      ${hasCustom ? `
      <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.18);border-radius:7px;padding:10px;">
        <div style="font-size:9px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:var(--green);margin-bottom:7px;">Active Rate Tiers</div>
        ${customTiers.map(t=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(16,185,129,.1);">
            <span style="font-size:11px;color:var(--text);font-weight:600;">${t.tier_name}</span>
            <span style="font-size:11px;color:var(--green);font-weight:800;">${t.buy_rate}%
              <span style="color:var(--muted);font-weight:400;"> · ${t.min_fico}–${t.max_fico===9999?'∞':t.max_fico} · ${t.max_ltv}% LTV</span>
            </span>
          </div>`).join('')}
      </div>` : ''}

      <!-- PDF Upload zone -->
      <div style="background:var(--surface2);border:1px dashed var(--border);border-radius:7px;padding:12px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;"><i data-lucide="file-text" class="ico-sm"></i>Upload PDF Rate Sheet</div>
        <input type="file" id="pdf-${lid}" accept=".pdf" style="display:none;" onchange="updateFileLabel('${lid}')">
        <div style="display:flex;gap:8px;align-items:center;">
          <div onclick="document.getElementById('pdf-${lid}').click()" style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:11px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:6px;transition:border-color .2s;" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
            <i data-lucide="paperclip" class="ico-sm"></i>
            <span id="pdf-label-${lid}">Choose PDF file...</span>
          </div>
          <button class="btn btn-primary btn-sm" onclick="uploadRateSheet('${lid}')" style="white-space:nowrap;">
            <i data-lucide="upload" class="ico-sm"></i>Parse
          </button>
        </div>
        <div id="upload-status-${lid}" style="font-size:11px;margin-top:6px;min-height:16px;"></div>
      </div>

      <!-- Manual entry (hidden) -->
      <div id="manual-entry-${lid}" style="display:none;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:7px;padding:12px;">
        <div style="font-size:10px;font-weight:800;color:var(--amber);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Manual Rate Entry</div>
        <div id="manual-tiers-${lid}"></div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-ghost btn-sm" onclick="addManualTier('${lid}')">+ Add Tier</button>
          <button class="btn btn-amber btn-sm" onclick="saveManualRates('${lid}')">Save Rates</button>
        </div>
      </div>

      <!-- Vehicle limits -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;display:block;margin-bottom:4px;">Min Year</label>
          <input type="number" id="lre_${lid}_minYear" value="${l.minYear}" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:12px;font-family:'Outfit',sans-serif;">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;display:block;margin-bottom:4px;">Max LTV (%)</label>
          <input type="number" id="lre_${lid}_maxLTV" value="${l.maxLTV}" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:12px;font-family:'Outfit',sans-serif;">
        </div>
        ${l.hard ? `
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;display:block;margin-bottom:4px;">Max Mileage (km)</label>
          <input type="number" id="lre_${lid}_maxMileage" value="${l.maxMileage||''}" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:12px;font-family:'Outfit',sans-serif;">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;display:block;margin-bottom:4px;">Max Carfax ($)</label>
          <input type="number" id="lre_${lid}_maxCarfax" value="${l.maxCarfax||''}" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:12px;font-family:'Outfit',sans-serif;">
        </div>` : `<div style="grid-column:1/-1;font-size:11px;color:var(--muted);font-style:italic;">Credit-based lender — no hard vehicle limits</div>`}
      </div>

      <!-- Reset button if custom -->
      ${hasCustom ? `
      <button class="btn btn-sm" onclick="resetLenderSheet('${lid}')" style="width:100%;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);color:var(--red);font-size:11px;padding:7px;">
        <i data-lucide="rotate-ccw" class="ico-sm"></i>Reset to Platform Defaults
      </button>` : ''}
    </div>`;
  });
  // ── Extra lenders (uploaded by this tenant, not in hardcoded list) ──
  const extra = window._extraLenders || {};
  Object.entries(extra).forEach(([lid, lenderData]) => {
    const tiers    = lenderData.tiers || [];
    const dispName = lenderData.name || lid.replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const tierRows = tiers.map(t =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(6,182,212,.1);">
         <span style="font-size:11px;color:var(--text);font-weight:600;">${t.tier}</span>
         <span style="font-size:11px;color:#06b6d4;font-weight:800;">${t.rate}%
           <span style="color:var(--muted);font-weight:400;"> · ${t.minFico === 0 ? 'No Min' : t.minFico}–${t.maxFico >= 9999 ? '∞' : t.maxFico} · ${t.maxLTV}% LTV</span>
         </span>
       </div>`
    ).join('');

    grid.innerHTML += `
    <div id="lre-card-extra-${lid}" style="
      background:var(--surface);
      border:1px solid rgba(6,182,212,.3);
      border-top:3px solid #06b6d4;
      border-radius:10px;
      padding:16px;
      display:flex;
      flex-direction:column;
      gap:10px;
    ">
      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:2px;color:#06b6d4;">${dispName}</div>
        <span style="font-size:9px;background:rgba(6,182,212,.12);color:#06b6d4;border:1px solid rgba(6,182,212,.3);border-radius:20px;padding:3px 9px;font-weight:700;letter-spacing:.5px;">
          ★ CUSTOM — ${tiers.length} TIERS
        </span>
      </div>

      <!-- Current tiers -->
      ${tiers.length ? `
      <div style="background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.18);border-radius:7px;padding:10px;">
        <div style="font-size:9px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#06b6d4;margin-bottom:7px;">Active Rate Tiers</div>
        ${tierRows}
      </div>` : ''}

      <!-- PDF Re-upload -->
      <div style="background:var(--surface2);border:1px dashed var(--border);border-radius:7px;padding:12px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Upload Updated Rate Sheet</div>
        <input type="file" id="pdf-extra-${lid}" accept=".pdf" style="display:none;" onchange="updateExtraFileLabel('${lid}')">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
          <div onclick="document.getElementById('pdf-extra-${lid}').click()"
            style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:11px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:6px;"
            onmouseover="this.style.borderColor='#06b6d4'" onmouseout="this.style.borderColor='var(--border)'">
            <i data-lucide="paperclip" class="ico-sm"></i>
            <span id="pdf-extra-label-${lid}">Choose PDF file...</span>
          </div>
          <button onclick="uploadExtraRateSheet('${lid}')"
            style="padding:7px 14px;background:rgba(6,182,212,.15);border:1px solid rgba(6,182,212,.4);border-radius:6px;color:#06b6d4;font-weight:700;font-size:11px;cursor:pointer;white-space:nowrap;">
            Upload PDF
          </button>
        </div>
        <div id="upload-status-extra-${lid}" style="font-size:11px;min-height:18px;"></div>
      </div>

      <!-- Manual tier entry -->
      <div>
        <button onclick="toggleExtraManual('${lid}')"
          style="width:100%;padding:8px;background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);border-radius:6px;color:#06b6d4;font-weight:700;font-size:11px;cursor:pointer;margin-bottom:6px;">
          ✏ Edit / Add Tiers Manually
        </button>
        <div id="extra-manual-${lid}" style="display:none;">
          <div id="extra-manual-tiers-${lid}"></div>
          <button onclick="addExtraManualTier('${lid}')"
            style="width:100%;padding:6px;background:transparent;border:1px dashed var(--border);border-radius:5px;color:var(--muted);font-size:11px;cursor:pointer;margin-top:4px;">
            + Add Tier
          </button>
          <button onclick="saveExtraManualRates('${lid}')"
            style="width:100%;padding:8px;background:rgba(6,182,212,.15);border:1px solid rgba(6,182,212,.4);border-radius:6px;color:#06b6d4;font-weight:700;font-size:11px;cursor:pointer;margin-top:6px;">
            Save Tiers
          </button>
        </div>
      </div>

      <!-- Delete this lender -->
      <button onclick="deleteExtraLender('${lid}','${dispName}')"
        style="width:100%;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);color:var(--red);font-size:11px;padding:7px;border-radius:6px;cursor:pointer;font-weight:700;">
        <i data-lucide="trash-2" class="ico-sm"></i> Remove Lender
      </button>
    </div>`;
  });

  // Add an "Add New Lender" card at the end
  grid.innerHTML += `
  <div style="
    background:var(--surface2);
    border:2px dashed var(--border);
    border-radius:10px;
    padding:24px 16px;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    gap:12px;
    min-height:200px;
  ">
    <i data-lucide="plus-circle" style="width:32px;height:32px;color:var(--muted);"></i>
    <div style="font-size:13px;font-weight:700;color:var(--muted);">Add New Lender</div>
    <div style="font-size:11px;color:var(--muted);text-align:center;">Upload a PDF rate sheet or enter tiers manually for any lender not listed above</div>
    <input type="text" id="newLenderNameInput" placeholder="Lender name (e.g. ABC Finance)"
      style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 12px;font-size:12px;font-family:'Outfit',sans-serif;text-align:center;">
    <div style="display:flex;gap:8px;width:100%;">
      <div onclick="document.getElementById('newLenderPdfInput').click()"
        style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:11px;color:var(--muted);cursor:pointer;text-align:center;"
        onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
        📎 Choose PDF
      </div>
      <button onclick="uploadNewLender()"
        style="padding:7px 14px;background:rgba(30,90,246,.15);border:1px solid rgba(30,90,246,.4);border-radius:6px;color:var(--primary);font-weight:700;font-size:11px;cursor:pointer;">
        Upload
      </button>
    </div>
    <input type="file" id="newLenderPdfInput" accept=".pdf" style="display:none;" onchange="document.querySelector('#newLenderNameInput').placeholder=this.files[0]?.name||'Lender name'">
    <div id="newLenderStatus" style="font-size:11px;min-height:16px;"></div>
    <button onclick="showNewLenderManual()"
      style="font-size:11px;color:var(--muted);background:transparent;border:none;cursor:pointer;text-decoration:underline;">
      or enter tiers manually instead
    </button>
    <div id="newLenderManual" style="display:none;width:100%;">
      <div id="newLenderManualTiers"></div>
      <button onclick="addNewLenderManualTier()"
        style="width:100%;padding:6px;background:transparent;border:1px dashed var(--border);border-radius:5px;color:var(--muted);font-size:11px;cursor:pointer;margin-top:4px;">
        + Add Tier
      </button>
      <button onclick="saveNewLenderManual()"
        style="width:100%;margin-top:6px;padding:8px;background:rgba(30,90,246,.15);border:1px solid rgba(30,90,246,.4);border-radius:6px;color:var(--primary);font-weight:700;font-size:11px;cursor:pointer;">
        Save New Lender
      </button>
    </div>
  </div>`;

  setTimeout(refreshIcons, 50);
}

function updateFileLabel(lid){
  const file = document.getElementById('pdf-'+lid)?.files[0];
  const label = document.getElementById('pdf-label-'+lid);
  if(label && file) label.textContent = file.name;
}

// ── Extra lender helper functions ─────────────────────────────────

function updateExtraFileLabel(lid){
  const file = document.getElementById(`pdf-extra-${lid}`)?.files[0];
  const label = document.getElementById(`pdf-extra-label-${lid}`);
  if(label && file) label.textContent = file.name;
}

async function uploadExtraRateSheet(lid){
  const fileInput = document.getElementById(`pdf-extra-${lid}`);
  const statusEl  = document.getElementById(`upload-status-extra-${lid}`);
  if(!fileInput?.files.length){ toast('Select a PDF first'); return; }
  const formData = new FormData();
  formData.append('sheet', fileInput.files[0]);
  formData.append('lenderName', lid);
  statusEl.innerHTML = '<span style="color:var(--muted);">⏳ Parsing PDF...</span>';
  try {
    const res  = await FF.apiFetch('/api/lenders/upload-sheet', { method:'POST', body: formData });
    const data = await res.json();
    if(data.success){
      statusEl.innerHTML = `<span style="color:var(--green);">✅ ${data.count} tiers updated</span>`;
      await loadTenantRates();
      buildLenderRateEditor();
      toast(`✅ ${lid.toUpperCase()} rates updated`);
    } else {
      statusEl.innerHTML = `<span style="color:var(--red);">✗ ${data.error}</span>`;
    }
  } catch(e){
    statusEl.innerHTML = `<span style="color:var(--red);">✗ Upload failed</span>`;
  }
}

function toggleExtraManual(lid){
  const el = document.getElementById(`extra-manual-${lid}`);
  if(!el) return;
  const visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : 'block';
  if(!visible && !document.getElementById(`extra-manual-tiers-${lid}`)?.children.length){
    addExtraManualTier(lid);
  }
}

let _extraManualCounts = {};
function addExtraManualTier(lid){
  const container = document.getElementById(`extra-manual-tiers-${lid}`);
  if(!container) return;
  if(!_extraManualCounts[lid]) _extraManualCounts[lid] = 0;
  const n = ++_extraManualCounts[lid];
  container.innerHTML += `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;">
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:6px;font-size:11px;">
        <div><label style="color:var(--muted);">Tier Name</label><input type="text" id="em-tier-${lid}-${n}" placeholder="Tier 1" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Rate %</label><input type="number" id="em-rate-${lid}-${n}" step="0.01" placeholder="13.49" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Min FICO</label><input type="number" id="em-minfico-${lid}-${n}" placeholder="620" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Max FICO</label><input type="number" id="em-maxfico-${lid}-${n}" placeholder="679" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Max LTV%</label><input type="number" id="em-ltv-${lid}-${n}" placeholder="140" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
      </div>
    </div>`;
}

async function saveExtraManualRates(lid){
  const count = _extraManualCounts[lid] || 0;
  if(!count){ toast('Add at least one tier'); return; }
  const tiers = [];
  for(let i=1; i<=count; i++){
    const tier    = document.getElementById(`em-tier-${lid}-${i}`)?.value;
    const rate    = parseFloat(document.getElementById(`em-rate-${lid}-${i}`)?.value);
    const minFico = parseInt(document.getElementById(`em-minfico-${lid}-${i}`)?.value) || 0;
    const maxFico = parseInt(document.getElementById(`em-maxfico-${lid}-${i}`)?.value) || 9999;
    const maxLTV  = parseInt(document.getElementById(`em-ltv-${lid}-${i}`)?.value)   || 140;
    if(!tier || isNaN(rate)) continue;
    tiers.push({ tier, rate, minFico, maxFico, maxLTV });
  }
  if(!tiers.length){ toast('Fill in at least one complete tier'); return; }
  try {
    const res  = await FF.apiFetch('/api/lenders/manual-rates', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ lenderName: lid, tiers })
    });
    const data = await res.json();
    if(data.success){
      await loadTenantRates();
      buildLenderRateEditor();
      toast(`✅ ${lid.toUpperCase()} — ${tiers.length} tiers saved`);
    } else { toast('Save failed: ' + data.error); }
  } catch(e){ toast('Save failed'); }
}

async function deleteExtraLender(lid, name){
  if(!confirm(`Remove ${name} from your lender list? This cannot be undone.`)) return;
  try {
    const res  = await FF.apiFetch(`/api/lenders/rates/${encodeURIComponent(lid)}`, { method: 'DELETE' });
    const data = await res.json();
    if(data.success){
      await loadTenantRates();
      buildLenderRateEditor();
      initExtraLenderPanels();
      toast(`${name} removed`);
    } else { toast('Remove failed'); }
  } catch(e){ toast('Remove failed'); }
}

// ── Add New Lender functions ──────────────────────────────────────

async function uploadNewLender(){
  const nameEl   = document.getElementById('newLenderNameInput');
  const fileInput = document.getElementById('newLenderPdfInput');
  const statusEl  = document.getElementById('newLenderStatus');
  const name = (nameEl?.value || '').trim();
  if(!name){ toast('Enter a lender name first'); nameEl?.focus(); return; }
  if(!fileInput?.files.length){ toast('Select a PDF file'); return; }
  const lid = name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const formData = new FormData();
  formData.append('sheet', fileInput.files[0]);
  formData.append('lenderName', lid);
  statusEl.innerHTML = '<span style="color:var(--muted);">⏳ Parsing PDF...</span>';
  try {
    const res  = await FF.apiFetch('/api/lenders/upload-sheet', { method:'POST', body: formData });
    const data = await res.json();
    if(data.success){
      statusEl.innerHTML = `<span style="color:var(--green);">✅ ${data.count} tiers loaded for ${name}</span>`;
      nameEl.value = '';
      fileInput.value = '';
      await loadTenantRates();
      buildLenderRateEditor();
      initExtraLenderPanels();
      toast(`✅ ${name} added — ${data.count} tiers`);
    } else if(data.fallback){
      statusEl.innerHTML = `<span style="color:var(--amber);">⚠ Couldn't auto-parse — enter tiers manually</span>`;
      showNewLenderManual();
    } else {
      statusEl.innerHTML = `<span style="color:var(--red);">✗ ${data.error}</span>`;
    }
  } catch(e){
    statusEl.innerHTML = `<span style="color:var(--red);">✗ Upload failed</span>`;
  }
}

let _newLenderManualCount = 0;
function showNewLenderManual(){
  const el = document.getElementById('newLenderManual');
  if(el) el.style.display = 'block';
  if(!_newLenderManualCount) addNewLenderManualTier();
}

function addNewLenderManualTier(){
  const container = document.getElementById('newLenderManualTiers');
  if(!container) return;
  const n = ++_newLenderManualCount;
  container.innerHTML += `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;">
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:6px;font-size:11px;">
        <div><label style="color:var(--muted);">Tier Name</label><input type="text" id="nl-tier-${n}" placeholder="Tier 1" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Rate %</label><input type="number" id="nl-rate-${n}" step="0.01" placeholder="13.49" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Min FICO</label><input type="number" id="nl-minfico-${n}" placeholder="620" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Max FICO</label><input type="number" id="nl-maxfico-${n}" placeholder="679" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Max LTV%</label><input type="number" id="nl-ltv-${n}" placeholder="140" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
      </div>
    </div>`;
}

async function saveNewLenderManual(){
  const nameEl = document.getElementById('newLenderNameInput');
  const name   = (nameEl?.value || '').trim();
  if(!name){ toast('Enter a lender name'); nameEl?.focus(); return; }
  const lid = name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const tiers = [];
  for(let i=1; i<=_newLenderManualCount; i++){
    const tier    = document.getElementById(`nl-tier-${i}`)?.value;
    const rate    = parseFloat(document.getElementById(`nl-rate-${i}`)?.value);
    const minFico = parseInt(document.getElementById(`nl-minfico-${i}`)?.value) || 0;
    const maxFico = parseInt(document.getElementById(`nl-maxfico-${i}`)?.value) || 9999;
    const maxLTV  = parseInt(document.getElementById(`nl-ltv-${i}`)?.value)   || 140;
    if(!tier || isNaN(rate)) continue;
    tiers.push({ tier, rate, minFico, maxFico, maxLTV });
  }
  if(!tiers.length){ toast('Add at least one complete tier'); return; }
  try {
    const res  = await FF.apiFetch('/api/lenders/manual-rates', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ lenderName: lid, tiers })
    });
    const data = await res.json();
    if(data.success){
      nameEl.value = '';
      _newLenderManualCount = 0;
      await loadTenantRates();
      buildLenderRateEditor();
      initExtraLenderPanels();
      toast(`✅ ${name} added — ${tiers.length} tiers`);
    } else { toast('Save failed: ' + data.error); }
  } catch(e){ toast('Save failed'); }
}

async function uploadRateSheet(lid){
  const fileInput = document.getElementById(`pdf-${lid}`);
  const statusEl  = document.getElementById(`upload-status-${lid}`);
  if(!fileInput.files.length){ toast('Select a PDF first'); return; }
  const formData = new FormData();
  formData.append('sheet', fileInput.files[0]);
  formData.append('lenderName', lid);
  statusEl.innerHTML = '<span style="color:var(--muted);">⏳ Parsing PDF...</span>';
  try {
    const res  = await FF.apiFetch('/api/lenders/upload-sheet', { method:'POST', body: formData });
    const data = await res.json();
    if(data.success){
      statusEl.innerHTML = `<span style="color:var(--green);">✅ Parsed ${data.count} tiers for ${data.lender.toUpperCase()}</span>`;
      await loadTenantRates();
      buildLenderRateEditor();
      toast(`✅ ${data.lender.toUpperCase()} rates updated — ${data.count} tiers loaded`);
    } else if(data.fallback){
      statusEl.innerHTML = `<span style="color:var(--amber);">⚠ ${data.error}</span>`;
      document.getElementById(`manual-entry-${lid}`).style.display = 'block';
      addManualTier(lid);
    } else {
      statusEl.innerHTML = `<span style="color:var(--red);">✗ ${data.error}</span>`;
    }
  } catch(e){
    statusEl.innerHTML = `<span style="color:var(--red);">✗ Upload failed: ${e.message}</span>`;
  }
}

let _manualTierCounts = {};
function addManualTier(lid){
  const container = document.getElementById(`manual-tiers-${lid}`);
  if(!container) return;
  if(!_manualTierCounts[lid]) _manualTierCounts[lid] = 0;
  const n = ++_manualTierCounts[lid];
  container.innerHTML += `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;" id="mtier-${lid}-${n}">
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:6px;font-size:11px;">
        <div><label style="color:var(--muted);">Tier Name</label><input type="text" id="mt-tier-${lid}-${n}" placeholder="e.g. Tier 1" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Rate %</label><input type="number" id="mt-rate-${lid}-${n}" step="0.01" placeholder="13.49" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Min FICO</label><input type="number" id="mt-minfico-${lid}-${n}" placeholder="620" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Max FICO</label><input type="number" id="mt-maxfico-${lid}-${n}" placeholder="679" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
        <div><label style="color:var(--muted);">Max LTV%</label><input type="number" id="mt-ltv-${lid}-${n}" placeholder="140" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px;"></div>
      </div>
    </div>`;
}

async function saveManualRates(lid){
  const count = _manualTierCounts[lid] || 0;
  if(!count){ toast('Add at least one tier first'); return; }
  const tiers = [];
  for(let n=1; n<=count; n++){
    const tierEl = document.getElementById(`mt-tier-${lid}-${n}`);
    if(!tierEl) continue;
    const rate = parseFloat(document.getElementById(`mt-rate-${lid}-${n}`)?.value);
    if(!rate) continue;
    // Validate rate bounds
    if(rate < 0.01 || rate > 50){
      toast(`⚠ Tier ${n}: Rate must be between 0.01% and 50%`);
      return;
    }
    const minFico = parseInt(document.getElementById(`mt-minfico-${lid}-${n}`)?.value)||0;
    const maxFico = parseInt(document.getElementById(`mt-maxfico-${lid}-${n}`)?.value)||9999;
    const maxLTV = parseInt(document.getElementById(`mt-ltv-${lid}-${n}`)?.value)||140;
    // Validate FICO range
    if(minFico > maxFico){
      toast(`⚠ Tier ${n}: Min FICO cannot exceed Max FICO`);
      return;
    }
    // Validate LTV
    if(maxLTV < 50 || maxLTV > 250){
      toast(`⚠ Tier ${n}: Max LTV should be between 50% and 250%`);
      return;
    }
    tiers.push({
      tier:    document.getElementById(`mt-tier-${lid}-${n}`).value || `Tier ${n}`,
      rate,
      minFico,
      maxFico,
      maxLTV
    });
  }
  if(!tiers.length){ toast('No valid tiers found'); return; }
  try {
    const res  = await FF.apiFetch('/api/lenders/manual-rates', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ lenderName: lid, tiers })
    });
    const data = await res.json();
    if(data.success){
      await loadTenantRates();
      buildLenderRateEditor();
      toast(`✅ ${lid.toUpperCase()} — ${tiers.length} manual tiers saved`);
    } else {
      toast('Save failed: ' + data.error);
    }
  } catch(e){ toast('Error: ' + e.message); }
}

async function resetLenderSheet(lid){
  if(!confirm(`Reset ${lid.toUpperCase()} to platform defaults? This removes your custom rates.`)) return;
  try {
    const res  = await FF.apiFetch(`/api/lenders/rates/${lid}`, { method: 'DELETE' });
    const data = await res.json();
    if(data.success){
      await loadTenantRates();
      buildLenderRateEditor();
      toast(`${lid.toUpperCase()} reset to platform defaults`);
    }
  } catch(e){ toast('Error: ' + e.message); }
}

function saveLenderRates(){
  const overrides = {};
  Object.keys(lenders).forEach(lid => {
    const o = {};
    const minYr = document.getElementById(`lre_${lid}_minYear`);
    const maxLTV = document.getElementById(`lre_${lid}_maxLTV`);
    const maxMile = document.getElementById(`lre_${lid}_maxMileage`);
    const maxCfx = document.getElementById(`lre_${lid}_maxCarfax`);
    if(minYr) { o.minYear = parseInt(minYr.value)||lenders[lid].minYear; lenders[lid].minYear = o.minYear; }
    if(maxLTV) { o.maxLTV = parseInt(maxLTV.value)||lenders[lid].maxLTV; lenders[lid].maxLTV = o.maxLTV; }
    if(maxMile) { o.maxMileage = parseInt(maxMile.value)||lenders[lid].maxMileage; lenders[lid].maxMileage = o.maxMileage; }
    if(maxCfx) { o.maxCarfax = parseInt(maxCfx.value)||lenders[lid].maxCarfax; lenders[lid].maxCarfax = o.maxCarfax; }
    overrides[lid] = o;
  });
  localStorage.setItem('ffLenderRates', JSON.stringify(overrides));
  closeModal('lenderRateModal');
  toast('Lender rates saved');
}

function resetLenderRates(){
  if(!confirm('Reset all lender rates to defaults?')) return;
  localStorage.removeItem('ffLenderRates');
  location.reload();
}

// ── PRESENTATION MODE ─────────────────────────────────────────
function openPresentation(){
  const desc  = getVal('vehicleDesc') || 'Your Vehicle';
  const stock = getVal('stockNum');
  const km    = getVal('odometer');
  const type  = getVal('vehicleType');
  const apr   = parseFloat(getVal('apr'))||0;
  const dealer= settings.dealerName || 'YOUR DEALERSHIP';

  const price    = parseFloat(getVal('sellingPrice'))||0;
  const doc      = parseFloat(getVal('docFee'))||0;
  const tAllow   = parseFloat(getVal('tradeAllow'))||0;
  const tPayoff  = parseFloat(getVal('tradePayoff'))||0;
  const gst      = parseFloat(getVal('gstRate'))||5;
  const vsc      = parseFloat(getVal('vscPrice'))||0;
  const gap      = parseFloat(getVal('gapPrice'))||0;
  const tw       = parseFloat(getVal('twPrice'))||0;
  const wa       = parseFloat(getVal('waPrice'))||0;
  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst/100);
  const otd      = price + doc - netTrade + gstAmt;
  const products = vsc + gap + tw + wa;
  const finance  = otd + products;
  const mr       = apr / 100 / 12;

  document.getElementById('presDealer').textContent = dealer.toUpperCase();
  document.getElementById('presVehicle').textContent = desc.toUpperCase();
  const subParts = [];
  if(stock) subParts.push('Stock #' + stock);
  if(km)    subParts.push(parseInt(km).toLocaleString() + ' km');
  if(type)  subParts.push(type);
  document.getElementById('presSub').textContent = subParts.join('  ·  ') || 'Professional Financing Available';

  const downs = [
    {label:'No Money Down', down: 0},
    {label:'$2,000 Down',   down: 2000},
    {label:'$5,000 Down',   down: 5000},
  ];
  const terms = [60, 72, 84];

  // Show 72 month no-money-down as featured card, others around it
  const finalDown = parseFloat(document.getElementById('finalDown')?.value)||0;
  let cardsHTML = '';
  const featured_term = 72;

  // Biweekly toggle for presentation
  const presToggleBar = `<div style="display:flex;justify-content:center;margin-bottom:20px;">${_biweeklyToggleHTML('bw-toggle-pres')}</div>`;
  let presToggleWrap = document.getElementById('bw-toggle-wrap-pres');
  if(!presToggleWrap){
    presToggleWrap = document.createElement('div');
    presToggleWrap.id = 'bw-toggle-wrap-pres';
    const ladder = document.getElementById('presPaymentLadder');
    if(ladder) ladder.parentNode.insertBefore(presToggleWrap, ladder);
  }
  presToggleWrap.innerHTML = presToggleBar;

  [60, 72, 84].forEach(term => {
    const fin = Math.max(0, finance - finalDown);
    const pmt = BPMT(apr, term, fin);
    const featured = term === featured_term;
    const termLabel = window._biweekly ? `${Math.round(term*26/12)} BI-WEEKLY` : `${term} MONTHS`;
    const pmtFreq = window._biweekly ? '/bi-weekly' : '/month';
    cardsHTML += `
    <div class="pres-pmt-card ${featured?'featured':''}">
      <div class="pres-term">${termLabel}</div>
      <div class="pres-amount">${$f(pmt)}</div>
      <div class="pres-monthly">${pmtFreq}</div>
      ${finalDown>0?`<div class="pres-down-note">$${finalDown.toLocaleString()} down</div>`:'<div class="pres-obo">No money down</div>'}
    </div>`;
  });

  document.getElementById('presPaymentLadder').innerHTML = cardsHTML;
  document.getElementById('presentationOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closePresentation(){
  document.getElementById('presentationOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ESC to close presentation
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') closePresentation();
});

// ── BEACON LENDER MATCH BADGES ────────────────────────────────
function runBeaconMatch(){
  const beacon = parseInt(getVal('creditScore')) || 0;
  const stock  = getVal('stockNum');
  const row    = document.getElementById('beaconLenderRow');
  const badges = document.getElementById('beaconBadges');

  if(!beacon){ toast('Enter a Beacon score first'); return; }
  if(!stock){  toast('Select a vehicle first'); return; }

  const src = window.ffInventory || window.inventory || [];
  const v = src.find(x => x.stock === stock);
  row.style.display = 'block';
  badges.innerHTML = '';

  Object.entries(lenders).forEach(([lid, l]) => {
    const prog = getQualifyingProgram(lid, beacon);
    let label, cls;
    const shortName = l.name.split(' ')[0];

    if(!l.hard){
      // Credit-based — just show if beacon is in reasonable range
      if(beacon >= 700)     { label = shortName + ' ✓'; cls = 'bln-green'; }
      else if(beacon >= 650){ label = shortName + ' ~'; cls = 'bln-amber'; }
      else                  { label = shortName + ' ✕'; cls = 'bln-red'; }
    } else {
      const vehicleOk = v && (v.year >= l.minYear) &&
        (l.maxMileage ? (v.mileage||0) <= l.maxMileage : true) &&
        (l.maxCarfax  ? (v.carfax||0)  <= l.maxCarfax  : true);
      if(!vehicleOk){ label = shortName + ' ✕ Vehicle'; cls = 'bln-red'; }
      else if(!prog){ label = shortName + ' ✕ Score'; cls = 'bln-red'; }
      else {
        const rate = prog.rate;
        label = `${shortName} ✓ ${rate}%${prog.isCustom ? '★' : ''}`;
        cls   = rate < 15 ? 'bln-green' : rate < 22 ? 'bln-amber' : 'bln-red';
      }
    }
    badges.innerHTML += `<span class="bln-badge ${cls}" title="${l.name}">${label}</span>`;
  });
}

// ── LIVE SYNC: Deal Desk → Compare All (full pre-population) ────
function syncCompareFromDeal(forceAll){
  const compareActive = document.getElementById('section-compare')?.classList.contains('active');
  let changed = false;

  function syncEl(id, val, force){
    if(!val) return;
    const el = document.getElementById(id);
    if(el && (force || el.value === '' || el.value === '0')){
      el.value = val; changed = true;
    }
  }

  // Customer fields — always sync if deal desk has values
  const beacon   = getVal('creditScore');
  const income   = getVal('monthlyIncome');
  const existing = getVal('existingPayments');
  const bEl = document.getElementById('compareBeacon');
  const iEl = document.getElementById('compareIncome');
  const eEl = document.getElementById('compareExisting');
  if(bEl && beacon   && bEl.value !== beacon)   { bEl.value = beacon;   changed = true; }
  if(iEl && income   && iEl.value !== income)   { iEl.value = income;   changed = true; }
  if(eEl && existing && eEl.value !== existing) { eEl.value = existing; changed = true; }

  // Vehicle + deal structure — sync on tab open (forceAll) or if fields empty
  if(forceAll || compareActive){
    // Stock
    const stock = getVal('stockNum');
    const stockSel = document.getElementById('compareStock');
    if(stockSel && stock){
      // Set compareStock to match deal desk stock
      for(let i=0;i<stockSel.options.length;i++){
        if(stockSel.options[i].value === stock){ stockSel.selectedIndex = i; changed = true; break; }
      }
    }

    // Down payment = finalDown from deal desk
    const down = getVal('finalDown') || '0';
    syncEl('compareDown', down, forceAll);

    // Net trade equity = allowance - payoff
    const tAllow  = parseFloat(getVal('tradeAllow'))  || 0;
    const tPayoff = parseFloat(getVal('tradePayoff')) || 0;
    const netTrade = Math.max(0, tAllow - tPayoff);
    if(netTrade > 0) syncEl('compareTrade', String(netTrade), forceAll);

    // Fees = doc fee
    const docFee = getVal('docFee');
    syncEl('compareFees', docFee, forceAll);

    // Contract rate from reserve panel
    const cRate = getVal('contractRate');
    syncEl('compareContractRate', cRate, forceAll);

    // Book value from inventory if vehicle selected
    const inv = window.ffInventory || window.inventory || [];
    const v = inv.find(x => x.stock === stock);
    if(v){
      if(v.book_value && v.book_value > 0) syncEl('compareBookVal', String(v.book_value), forceAll);
      // Condition
      const condSel = document.getElementById('compareCondition');
      if(condSel && v.condition && forceAll) { condSel.value = v.condition.toLowerCase(); changed = true; }
    }
  }

  if(changed && (compareActive || forceAll)){
    runComparison();
  }
}

// Also auto-run on beacon score change
const origAssessRisk = assessRisk;
assessRisk = function(){
  origAssessRisk();
  const beacon = parseInt(getVal('creditScore')) || 0;
  const stock  = getVal('stockNum');
  if(beacon >= 300 && stock) runBeaconMatch();
};

// ── TRADE EQUITY AUTO-CARRY ───────────────────────────────────
function carryTradeEquity(){
  const acv     = parseFloat(getVal('acv')) || 0;
  const adj     = parseFloat(getVal('conditionAdj')) || 0;
  const safety  = parseFloat(getVal('safetyInspect')) || 0;
  const recon   = parseFloat(getVal('reconditionCost')) || 0;
  const tPayoff = parseFloat(getVal('tradePayoff')) || 0;
  const adjustedACV = acv - (adj + safety + recon);
  // Set trade allowance to adjusted ACV and payoff stays as-is
  document.getElementById('tradeAllow').value = Math.max(0, adjustedACV).toFixed(0);
  calculateTrade();
  calculate();
  toast('Trade ACV applied to Deal Structure');
}

// ── DEAL SCENARIOS A / B / C ─────────────────────────────────
let scenarios = JSON.parse(localStorage.getItem('ffScenarios') || '[null,null,null]');

function renderScenarios(){
  scenarios.forEach((sc, i) => {
    const card    = document.getElementById('sc' + i);
    const dataEl  = document.getElementById('sc' + i + 'data');
    const badge   = document.getElementById('sc' + i + 'badge');
    const labelEl = document.getElementById('sc' + i + 'label');
    if(sc){
      const v = sc.vehicle || {};
      const f = sc.financial || {};
      const p = sc.products  || {};
      const vsc = parseFloat(p.vscPrice)||0, gap = parseFloat(p.gapPrice)||0,
            tw  = parseFloat(p.twPrice)||0,  wa  = parseFloat(p.waPrice)||0;
      const price   = parseFloat(f.price)||0;
      const apr_val = parseFloat(f.apr)||0;
      const doc_val = parseFloat(f.doc)||0;
      const tA      = parseFloat(f.tAllow)||0;
      const tP      = parseFloat(f.tPayoff)||0;
      const gst_v   = parseFloat(f.gst)||5;
      const netTr   = tA - tP;
      const gstA    = (price + doc_val - netTr) * (gst_v/100);
      const otd     = price + doc_val - netTr + gstA;
      const products= vsc + gap + tw + wa;
      const pmt72   = BPMT(apr_val, 72, otd + products);
      const prods   = [vsc?'VSC':'',gap?'GAP':'',tw?'T&W':'',wa?'WA':''].filter(Boolean);
      if(sc.label) labelEl.value = sc.label;
      dataEl.innerHTML = `<span class="sc-payment">${$f(pmt72)}<span style="font-size:12px;font-weight:400;">/mo</span></span>
        <strong>${v.desc||'—'}</strong><br>
        Price: ${$f(price)} · APR: ${apr_val}%<br>
        ${prods.length?'Products: '+prods.join(', '):'No F&I products'}`;
      dataEl.style.fontStyle = 'normal';
      badge.textContent = '✓ Saved';
      badge.style.color = 'var(--green)';
      card.classList.add('has-data');
    } else {
      dataEl.innerHTML = 'No deal saved yet.';
      dataEl.style.fontStyle = 'italic';
      badge.textContent = 'Empty';
      badge.style.color = 'var(--muted)';
      card.classList.remove('has-data');
    }
  });
}

function saveScenario(i){
  const d = getDealData();
  d.label = document.getElementById('sc' + i + 'label').value;
  scenarios[i] = d;
  localStorage.setItem('ffScenarios', JSON.stringify(scenarios));
  renderScenarios();
  toast(`Scenario ${['A','B','C'][i]} saved!`);
}

function loadScenario(i){
  if(!scenarios[i]){ toast('No scenario saved in this slot'); return; }
  localStorage.setItem('ffCurrentDeal', JSON.stringify(scenarios[i]));
  loadDeal();
  toast(`Scenario ${['A','B','C'][i]} loaded!`);
}

function clearScenario(i){
  if(!confirm('Clear this scenario?')) return;
  scenarios[i] = null;
  localStorage.setItem('ffScenarios', JSON.stringify(scenarios));
  renderScenarios();
  toast('✕ Cleared');
}

// ── RATE COMPARISON ───────────────────────────────────────────
function updateRateComparison(){
  const price    = parseFloat(getVal('sellingPrice'))||0;
  const doc      = parseFloat(getVal('docFee'))||0;
  const tAllow   = parseFloat(getVal('tradeAllow'))||0;
  const tPayoff  = parseFloat(getVal('tradePayoff'))||0;
  const gst      = parseFloat(getVal('gstRate'))||5;
  const vsc      = parseFloat(getVal('vscPrice'))||0;
  const gap      = parseFloat(getVal('gapPrice'))||0;
  const tw       = parseFloat(getVal('twPrice'))||0;
  const wa       = parseFloat(getVal('waPrice'))||0;
  const buyRate  = parseFloat(document.getElementById('rc_buy')?.value)||0;
  const conRate  = parseFloat(document.getElementById('rc_contract')?.value)||0;
  const maxRate  = parseFloat(document.getElementById('rc_max')?.value)||0;
  const tbody    = document.getElementById('rateCompareBody');
  if(!tbody || !price) return;

  const netTrade = tAllow - tPayoff;
  const gstAmt   = (price + doc - netTrade) * (gst/100);
  const otd      = price + doc - netTrade + gstAmt + vsc + gap + tw + wa;

  const terms = [48, 60, 72, 84];
  let html = '';

  // Inject biweekly toggle above rate comparison table
  let rcToggleWrap = document.getElementById('bw-toggle-wrap-rc');
  if(!rcToggleWrap){
    rcToggleWrap = document.createElement('div');
    rcToggleWrap.id = 'bw-toggle-wrap-rc';
    tbody.parentNode.parentNode.insertBefore(rcToggleWrap, tbody.parentNode);
  }
  rcToggleWrap.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">${_biweeklyToggleHTML('bw-toggle-rc')}</div>`;

  const pmtSuffix = window._biweekly ? '/bi-wk' : '/mo';
  terms.forEach(t => {
    const pBuy = BPMT(buyRate, t, otd);
    const pCon = BPMT(conRate, t, otd);
    const pMax = BPMT(maxRate, t, otd);
    const reservePerPeriod = pCon - pBuy;
    const tLabel = window._biweekly ? `${Math.round(t*26/12)} bi-wk` : `${t} mo`;
    html += `<tr>
      <td><strong>${tLabel}</strong></td>
      <td class="rc-buy">${$f(pBuy)}</td>
      <td class="rc-contract">${$f(pCon)}</td>
      <td class="rc-max">${$f(pMax)}</td>
      <td style="color:var(--green);">+${$f(reservePerPeriod)}</td>
    </tr>`;
  });
  tbody.innerHTML = html;
}

// ── COMMISSION CALCULATOR ─────────────────────────────────────
function calcCommission(){
  // Pull live profit values from the DOM output fields
  const frontText = document.getElementById('frontGross')?.textContent || '$0';
  const frontGross = parseFloat(frontText.replace(/[$,]/g,'')) || 0;

  const vscP = parseFloat(document.getElementById('vscProfit')?.textContent) || 0;
  const gapP = parseFloat(document.getElementById('gapProfit')?.textContent) || 0;
  const twP  = parseFloat(document.getElementById('twProfit')?.textContent)  || 0;
  const waP  = parseFloat(document.getElementById('waProfit')?.textContent)  || 0;
  const backGross = vscP + gapP + twP + waP + 500; // +$500 reserve

  const frontPct = parseFloat(getVal('commFrontPct')) / 100 || 0;
  const backPct  = parseFloat(getVal('commBackPct'))  / 100 || 0;
  const flat     = parseFloat(getVal('commFlat'))     || 0;

  const frontComm = Math.max(0, frontGross) * frontPct;
  const backComm  = Math.max(0, backGross)  * backPct;
  const total     = frontComm + backComm + flat;

  document.getElementById('commTotal').textContent = $f(total);
  document.getElementById('commBreakdown').innerHTML =
    `Front (${(frontPct*100).toFixed(0)}% of ${$i(frontGross)}): <strong style="color:var(--text);">${$f(frontComm)}</strong><br>` +
    `Back (${(backPct*100).toFixed(0)}% of ${$i(backGross)}): <strong style="color:var(--text);">${$f(backComm)}</strong>` +
    (flat ? `<br>Flat/Bonus: <strong style="color:var(--text);">${$f(flat)}</strong>` : '');
}

// ── PRINT WORKSHEET ───────────────────────────────────────────
function printWorksheet(){
  // Populate the hidden printWorksheet div
  const v = getVal('vehicleDesc'), stock = getVal('stockNum'), vin = getVal('vin');
  const km = getVal('odometer'), cond = getVal('condition');
  const name = getVal('custName'), phone = getVal('custPhone'), email = getVal('custEmail');
  const price = parseFloat(getVal('sellingPrice'))||0;
  const doc   = parseFloat(getVal('docFee'))||0;
  const tA    = parseFloat(getVal('tradeAllow'))||0;
  const tP    = parseFloat(getVal('tradePayoff'))||0;
  const apr   = parseFloat(getVal('apr'))||0;
  const gst   = parseFloat(getVal('gstRate'))||5;
  const vsc   = parseFloat(getVal('vscPrice'))||0;
  const gap   = parseFloat(getVal('gapPrice'))||0;
  const tw    = parseFloat(getVal('twPrice'))||0;
  const wa    = parseFloat(getVal('waPrice'))||0;
  const netTr = tA - tP;
  const gstA  = (price + doc - netTr) * (gst/100);
  const otd   = price + doc - netTr + gstA;
  const mr    = apr/100/12;

  const setTxt = (id, val) => { const e = document.getElementById(id); if(e) e.textContent = val; };
  setTxt('pw-dealer-name', settings.dealerName || 'YOUR DEALERSHIP');
  setTxt('pw-date', new Date().toLocaleDateString('en-CA', {weekday:'long',year:'numeric',month:'long',day:'numeric'}));
  setTxt('pw-desc', v || '—'); setTxt('pw-stock', stock || '—'); setTxt('pw-vin', vin || '—');
  setTxt('pw-km', km ? parseInt(km).toLocaleString()+' km' : '—'); setTxt('pw-cond', cond || '—');
  setTxt('pw-name', name || '—'); setTxt('pw-phone', phone || '—'); setTxt('pw-email', email || '—');
  setTxt('pw-price', $f(price)); setTxt('pw-doc', $f(doc));
  setTxt('pw-trade', $f(tA)); setTxt('pw-payoff', $f(tP));
  setTxt('pw-gst', $f(gstA) + ' (' + gst + '%)'); setTxt('pw-apr', apr + '%');
  setTxt('pw-otd', $f(otd));
  setTxt('pw-vsc', vsc > 0 ? $f(vsc) : '— Not selected');
  setTxt('pw-gap', gap > 0 ? $f(gap) : '— Not selected');
  setTxt('pw-tw',  tw  > 0 ? $f(tw)  : '— Not selected');
  setTxt('pw-wa',  wa  > 0 ? $f(wa)  : '— Not selected');

  // Build print payment grid
  const downs = [0, 2000, 5000];
  const terms = [48, 60, 72, 84];
  const pwPmtLbl = window._biweekly ? 'Bi-Wkly' : 'Months';
  let pgHTML = '<div class="pw-payment-grid">';
  // Header row
  pgHTML += '<div class="pw-pg-cell header">Down</div>';
  terms.forEach(t => pgHTML += `<div class="pw-pg-cell header">${t} ${pwPmtLbl}</div>`);
  // Payment rows
  downs.forEach(d => {
    pgHTML += `<div class="pw-pg-cell"><strong>$${d.toLocaleString()}</strong></div>`;
    terms.forEach(t => {
      const fin = otd + vsc + gap + tw + wa - d;
      const pmt = BPMT(apr, t, fin);
      pgHTML += `<div class="pw-pg-cell payment">${$f(pmt)}</div>`;
    });
  });
  pgHTML += '</div>';
  document.getElementById('pw-payment-grid').innerHTML = pgHTML;

  window.print();
  toast('Printing worksheet...');
}


// ── RESTORE COMPARE SESSION ──────────────────────────────────────
function restoreCompareSession(){
  try {
    const s = JSON.parse(localStorage.getItem('ffCompareSession') || 'null');
    if(!s) return;
    // Only restore if saved within 24hrs
    if(Date.now() - (s.savedAt||0) > 86400000) return;
    // Verify stock still exists in inventory
    const inv = window.ffInventory || window.inventory || [];
    if(s.stock && !inv.find(x => x.stock === s.stock)) return;

    const set = (id, val) => { const e=document.getElementById(id); if(e&&val!==undefined&&val!=='') e.value=val; };
    const chk = (id, val) => { const e=document.getElementById(id); if(e) e.checked=val; };
    const sel = (id, val) => {
      const e=document.getElementById(id); if(!e||!val) return;
      for(let i=0;i<e.options.length;i++) if(e.options[i].value===val){e.selectedIndex=i;break;}
    };

    sel('compareStock', s.stock);
    set('compareDown', s.down);
    set('compareTrade', s.trade);
    set('compareFees', s.fees);
    sel('compareTerm', s.term);
    set('compareBeacon', s.beacon);
    set('compareIncome', s.income);
    set('compareExisting', s.existing);
    set('compareContractRate', s.contractRate);
    set('compareBookVal', s.bookVal);
    sel('compareCondition', s.condition);
    set('compareCoBeacon', s.coBeacon);
    set('compareCoIncome', s.coIncome);
    chk('compareBK', s.bk);
    if(s.gstEnabled !== undefined) chk('compareGst', s.gstEnabled);

    if(s.stock) setTimeout(runComparison, 200);
  } catch(e){}
}

// ── BEACON RANGE SIMULATOR ────────────────────────────────────────
function runBeaconSimulator(){
  const el = document.getElementById('beaconSimulator');
  if(!el) return;

  const stock    = document.getElementById('compareStock')?.value || '';
  const inv      = window.ffInventory || window.inventory || [];
  const v        = inv.find(x => x.stock === stock);
  if(!v){ el.innerHTML = ''; return; }

  const down     = parseFloat(document.getElementById('compareDown')?.value)    || 0;
  const trade    = parseFloat(document.getElementById('compareTrade')?.value)   || 0;
  const fees     = parseFloat(document.getElementById('compareFees')?.value)    || 0;
  const income   = parseFloat(document.getElementById('compareIncome')?.value)  || 0;
  const existing = parseFloat(document.getElementById('compareExisting')?.value)|| 0;
  const term     = parseInt(document.getElementById('compareTerm')?.value)      || 72;
  const bookValOver = parseFloat(document.getElementById('compareBookVal')?.value) || 0;
  const coIncome = parseFloat(document.getElementById('compareCoIncome')?.value)|| 0;
  const combinedInc = income + coIncome;
  const contractRate = parseFloat(document.getElementById('compareContractRate')?.value) || 0;
  const curYear  = new Date().getFullYear();

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

  const results = BEACON_RANGES.map(range => {
    const testBeacon = range.min === 0 ? 0 : range.min + 10;
    let approved = 0, bestRate = 99;
    Object.entries(lenders).forEach(([lid, l]) => {
      const prog = getQualifyingProgram(lid, testBeacon);
      if(!prog) return;
      const lenderFee = prog.fee || 0;
      const atf = v.price + fees + lenderFee - down - trade;
      const bookVal = bookValOver > 0 ? bookValOver : (v.book_value || v.bookValue || v.price);
      const maxLTV = prog.maxLTV || l.maxLTV;
      const ltvPct = (atf / bookVal) * 100;
      if(ltvPct > maxLTV) return;
      const minYear = prog.minYear || l.minYear;
      if(v.year < minYear) return;
      const maxMile = prog.maxMileage || l.maxMileage || 999999;
      if((v.mileage||0) > maxMile) return;
      const maxCfx = prog.maxCarfax || l.maxCarfax || 999999;
      if((v.carfax||0) > maxCfx) return;
      const ageAtPayoff = (curYear - v.year) + (term/12);
      if(ageAtPayoff > 14) return;
      const lMaxPti = l.maxPti || 20;
      if(combinedInc > 0 && prog.rate > 0){
        const pmt = BPMT(prog.rate, term, atf);
        const pti = (pmt / combinedInc) * 100;
        if(pti > lMaxPti) return;
      }
      approved++;
      if(prog.rate < bestRate) bestRate = prog.rate;
    });
    return { ...range, approved, bestRate: bestRate < 99 ? bestRate : null };
  });

  const maxApproved = Math.max(...results.map(r => r.approved), 1);
  const currentBeacon = parseInt(document.getElementById('compareBeacon')?.value) || 0;

  el.innerHTML = `
    <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;">
      <span>📊 Beacon Range Simulator</span>
      <span style="font-size:10px;font-weight:400;color:var(--muted);">How many lenders approve at each beacon score?</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(${results.length},1fr);gap:3px;align-items:end;height:80px;">
      ${results.map(r => {
        const pct   = r.approved > 0 ? Math.max(15, Math.round((r.approved / maxApproved) * 100)) : 4;
        const isNow = currentBeacon >= r.min && currentBeacon <= r.max;
        const col   = r.approved === 0 ? 'rgba(239,68,68,.4)'
                    : r.approved <= 2  ? 'rgba(245,158,11,.6)'
                    : r.approved <= 5  ? 'rgba(16,185,129,.5)'
                    :                    'rgba(16,185,129,.85)';
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
          <div style="font-size:9px;color:${r.approved>0?'var(--green)':'var(--muted)'};">${r.approved>0?r.approved:''}</div>
          <div style="width:100%;height:${pct}%;background:${col};border-radius:3px 3px 0 0;${isNow?'outline:2px solid var(--amber);':''};transition:height .3s;"></div>
        </div>`;
      }).join('')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(${results.length},1fr);gap:3px;margin-top:3px;">
      ${results.map(r => {
        const isNow = currentBeacon >= r.min && currentBeacon <= r.max;
        return `<div style="font-size:8px;text-align:center;color:${isNow?'var(--amber)':'var(--muted)'};font-weight:${isNow?800:400};">${r.label}</div>`;
      }).join('')}
    </div>
    ${results.some(r => r.bestRate) ? `<div style="font-size:10px;color:var(--muted);margin-top:8px;">Best rate by range: ${results.filter(r=>r.bestRate).map(r=>`<span style="color:var(--green);font-weight:700;">${r.label}: ${r.bestRate}%</span>`).join(' · ')}</div>` : ''}`;
}
// ── PRINT COMPARISON ─────────────────────────────────────────────
function printComparison(){
  const el = document.getElementById('printComparisonDiv');
  if(!el){ console.warn('printComparisonDiv not found'); return; }

  const stock  = document.getElementById('compareStock')?.value || '';
  const inv    = window.ffInventory || window.inventory || [];
  const v      = inv.find(x => x.stock === stock);
  const beacon = document.getElementById('compareBeacon')?.value || '';
  const income = document.getElementById('compareIncome')?.value || '';
  const down   = document.getElementById('compareDown')?.value || '0';
  const term   = document.getElementById('compareTerm')?.value || '72';
  const coInc  = document.getElementById('compareCoIncome')?.value || '';

  const vDesc = v ? `${v.year} ${v.make} ${v.model}` : stock;
  const vInfo = v ? `${(v.mileage||0).toLocaleString()} km · $${(v.price||0).toLocaleString()} · ${v.condition||''}` : '';
  const today = new Date().toLocaleDateString('en-CA',{weekday:'short',year:'numeric',month:'short',day:'numeric'});

  // Collect eligible and ineligible results from rendered cards
  const eligEl   = document.getElementById('compareEligible');
  const inelEl   = document.getElementById('compareIneligible');
  const summaryEl= document.getElementById('compareSummaryBar');

  el.innerHTML = `
    <div class="cpr-header">
      <div class="cpr-logo">${settings.dealerName || 'FIRST-FIN'}</div>
      <div class="cpr-title">LENDER COMPARISON</div>
      <div class="cpr-sub">${today} · Beacon: ${beacon||'—'} · Income: ${income?'$'+parseInt(income).toLocaleString()+'/mo':'—'}${coInc?' + Co-app $'+parseInt(coInc).toLocaleString():''}</div>
    </div>
    <div class="cpr-vehicle">
      <strong>${vDesc}</strong>${vInfo?' · '+vInfo:''}
      <span class="cpr-pill">Down: $${parseInt(down||0).toLocaleString()}</span>
      <span class="cpr-pill">Term: ${term}mo</span>
    </div>
    <div class="cpr-summary">${summaryEl ? summaryEl.innerHTML : ''}</div>
    <div class="cpr-section-title cpr-green">✓ ELIGIBLE LENDERS</div>
    <div class="cpr-cards">${eligEl ? eligEl.innerHTML : '<em>None</em>'}</div>
    <div class="cpr-section-title cpr-red" style="margin-top:16px;">✗ INELIGIBLE LENDERS</div>
    <div class="cpr-cards">${inelEl ? inelEl.innerHTML : '<em>None</em>'}</div>
    <div class="cpr-footer">Generated by FIRST-FIN · ${today} · For dealer use only. Estimates subject to lender approval.</div>`;

  // Trigger print
  document.body.classList.add('print-comparison');
  window.print();
  setTimeout(() => document.body.classList.remove('print-comparison'), 500);
  toast('Printing comparison...');
}

// ── HOOK calculate() to also update Rate Comparison ──────────
const _origCalculate = calculate;
calculate = function(){
  _origCalculate();
  updateRateComparison();
  calcCommission();
};


// ── ONBOARDING WIZARD ────────────────────────────────────────────
let _wizSelectedNumber = '';

function wizCheckAndShow() {
  // Never fire in demo mode
  if (window.DEMO_MODE) return;
  // Never fire if not properly logged in
  if (!window.FF || !FF.isLoggedIn) return;
  // Never fire if user has explicitly dismissed (skipped) this session
  if (sessionStorage.getItem('ff_wiz_skipped')) return;
  // Never fire if user has ever completed setup
  if (localStorage.getItem('ff_wiz_done')) return;
  // Only fire if Twilio number is genuinely missing
  if (settings.twilioNumber) {
    // Has a number — mark done so we never check again
    localStorage.setItem('ff_wiz_done', '1');
    return;
  }
  // Show wizard
  document.getElementById('wiz-salesName').value  = settings.salesName  || '';
  document.getElementById('wiz-dealerName').value = settings.dealerName || '';
  wizGoTo(1);
  document.getElementById('sarah-wizard').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function wizOpen() {
  document.getElementById('wiz-salesName').value  = settings.salesName  || '';
  document.getElementById('wiz-dealerName').value = settings.dealerName || '';
  wizGoTo(1);
  document.getElementById('sarah-wizard').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function wizClose() {
  document.getElementById('sarah-wizard').style.display = 'none';
  document.body.style.overflow = '';
}

function wizSkip() {
  // Remember skip for this session so wizard doesn't re-fire on navigation
  sessionStorage.setItem('ff_wiz_skipped', '1');
  wizClose();
  if (!settings.twilioNumber) {
    document.getElementById('sarah-setup-banner').style.display = 'block';
  }
}

function wizGoTo(step) {
  [1, 2, 3, 'done'].forEach(s => {
    const p = document.getElementById('wiz-panel-' + s);
    if (p) p.style.display = (s == step) ? 'block' : 'none';
  });
  [1, 2, 3].forEach(s => {
    const el = document.getElementById('wstep-' + s);
    const ln = document.getElementById('wline-' + s);
    if (el) el.className = 'ob-step' + (s < step ? ' done' : s == step ? ' active' : '');
    if (ln) ln.className = 'ob-line' + (s < step ? ' done' : '');
  });
}

function wizNext(step) {
  if (step === 1) {
    const name   = document.getElementById('wiz-salesName').value.trim();
    const dealer = document.getElementById('wiz-dealerName').value.trim();
    settings.salesName  = name   || settings.salesName;
    settings.dealerName = dealer || settings.dealerName;
    if (window.FF && FF.isLoggedIn) {
      FF.apiFetch('/api/desk/settings', { method: 'PUT', body: JSON.stringify({ settings }) })
        .then(r => r.json())
        .then(d => { if (d.tenantBranding && typeof updateHeaderDealer === 'function') updateHeaderDealer(); })
        .catch(() => {});
    }
  }
  wizGoTo(step + 1);
}

async function wizSearchNumbers() {
  const ac  = document.getElementById('wiz-areaCode').value.trim();
  const btn = document.getElementById('wiz-search-btn');
  const list = document.getElementById('wiz-numbers-list');
  if (ac.length !== 3) {
    list.innerHTML = '<div style="color:#ef4444;font-size:12px;font-family:\'DM Mono\',monospace;">Enter a 3-digit area code</div>';
    return;
  }
  btn.textContent = 'Searching...';
  btn.disabled = true;
  list.innerHTML = '<div style="color:#64748b;font-size:12px;font-family:\'DM Mono\',monospace;padding:8px 0;">Searching available numbers...</div>';
  _wizSelectedNumber = '';
  document.getElementById('wiz-selected-number').style.display = 'none';
  const provBtn = document.getElementById('wiz-provision-btn');
  provBtn.disabled = true;
  provBtn.style.cssText = 'width:100%;padding:13px;background:rgba(30,90,246,.1);border:1px solid rgba(30,90,246,.2);border-radius:8px;color:#475569;font-family:Outfit,sans-serif;font-size:14px;font-weight:700;cursor:not-allowed;';

  try {
    const res  = await FF.apiFetch('/api/desk/twilio/available-numbers?areaCode=' + ac);
    const data = await res.json();
    if (!data.success) {
      list.innerHTML = `<div style="color:#ef4444;font-size:12px;">${data.error}</div>`;
      return;
    }
    if (!data.numbers.length) {
      list.innerHTML = '<div style="color:#64748b;font-size:12px;font-family:\'DM Mono\',monospace;">No numbers found — try a different area code.</div>';
      return;
    }
    list.innerHTML = data.fallback
      ? `<div style="color:#f59e0b;font-size:11px;font-family:'DM Mono',monospace;margin-bottom:8px;">${data.message}</div>`
      : '';
    data.numbers.forEach(n => {
      const div = document.createElement('div');
      div.className = 'ob-number-option';
      div.innerHTML = `<span style="font-family:'DM Mono',monospace;font-size:15px;color:#e2e8f0;letter-spacing:2px;">${n.friendly}</span><span style="font-size:11px;color:#64748b;">${n.region || ''}</span>`;
      div.onclick = () => {
        document.querySelectorAll('.ob-number-option').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        _wizSelectedNumber = n.number;
        document.getElementById('wiz-selected-display').textContent = n.friendly;
        document.getElementById('wiz-selected-number').style.display = 'block';
        provBtn.disabled = false;
        provBtn.style.cssText = 'width:100%;padding:13px;background:linear-gradient(135deg,#1e5af6,#2d6cff);border:none;border-radius:8px;color:#fff;font-family:Outfit,sans-serif;font-size:14px;font-weight:700;letter-spacing:.5px;cursor:pointer;transition:all .2s;';
      };
      list.appendChild(div);
    });
  } catch(e) {
    list.innerHTML = '<div style="color:#ef4444;font-size:12px;">Network error — try again</div>';
  } finally {
    btn.textContent = 'Search Numbers';
    btn.disabled = false;
  }
}

async function wizProvisionNumber() {
  if (!_wizSelectedNumber) return;
  const btn = document.getElementById('wiz-provision-btn');
  btn.textContent = 'Claiming number...';
  btn.disabled = true;
  try {
    const res  = await FF.apiFetch('/api/desk/twilio/provision-number', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: _wizSelectedNumber })
    });
    const data = await res.json();
    if (!data.success) {
      btn.textContent = data.error || 'Failed — try another number';
      btn.disabled = false;
      return;
    }
    settings.twilioNumber = data.phoneNumber;
    setVal('setTwilioNumber', data.phoneNumber);
    wizGoTo(3);
  } catch(e) {
    btn.textContent = 'Network error — try again';
    btn.disabled = false;
  }
}

async function wizFinish() {
  const notify = document.getElementById('wiz-notifyPhone').value.trim();
  const errEl  = document.getElementById('wiz-step3-err');
  errEl.style.display = 'none';
  // Allow empty (optional) or valid +1XXXXXXXXXX format
  const cleaned = notify.replace(/[\s\-\(\)]/g, '');
  if (notify && !/^\+1\d{10}$/.test(cleaned)) {
    errEl.textContent = 'Use format +14031234567 or leave blank';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('wiz-finish-btn');
  btn.textContent = 'Saving...';
  btn.disabled = true;
  if (notify) {
    settings.notifyPhone = cleaned;
    setVal('setNotifyPhone', cleaned);
  }
  try {
    if (window.FF && FF.isLoggedIn) {
      const res  = await FF.apiFetch('/api/desk/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed');
    }
    document.getElementById('sarah-setup-banner').style.display = 'none';
    localStorage.setItem('ff_wiz_done', '1');
    sessionStorage.removeItem('ff_wiz_skipped');
    wizGoTo('done');
  } catch(e) {
    errEl.textContent = e.message || 'Save failed — try again';
    errEl.style.display = 'block';
    btn.textContent = 'Finish Setup →';
    btn.disabled = false;
  }
}
