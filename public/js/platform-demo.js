// ═══════════════════════════════════════════════════════════
// DEMO MODE
// ═══════════════════════════════════════════════════════════
window.DEMO_MODE = false;

const DEMO_INVENTORY = [
  {stock:'MAG-1001',year:'2021',make:'Ford',model:'F-150',mileage:45000,price:38900,type:'Truck',condition:'Average',carfax:1,vin:'1FTFW1ET5MFA12345'},
  {stock:'MAG-1002',year:'2022',make:'Toyota',model:'RAV4',mileage:28000,price:34500,type:'SUV',condition:'Average',carfax:1,vin:'2T3P1RFV3NC123456'},
  {stock:'MAG-1003',year:'2020',make:'Honda',model:'Civic',mileage:52000,price:22900,type:'Car',condition:'Average',carfax:0,vin:'2HGFC2F69LH123456'},
  {stock:'MAG-1004',year:'2023',make:'Chevrolet',model:'Silverado',mileage:18000,price:51200,type:'Truck',condition:'Average',carfax:1,vin:'3GCUYDEDXNG123456'},
  {stock:'MAG-1005',year:'2021',make:'Hyundai',model:'Tucson',mileage:39000,price:27800,type:'SUV',condition:'Average',carfax:1,vin:'5NMS33AD3MH123456'},
  {stock:'MAG-1006',year:'2019',make:'Jeep',model:'Wrangler',mileage:67000,price:31500,type:'SUV',condition:'Average',carfax:0,vin:'1C4HJXDG5KW123456'},
];

const DEMO_CRM = [
  {id:'d1',name:'James Thornton',phone:'+14035550101',email:'jthornton@email.com',status:'engaged',score:680,income:6200,vehicle:'2022 Toyota RAV4',created_at:new Date(Date.now()-2*86400000).toISOString()},
  {id:'d2',name:'Sarah Mitchell',phone:'+14035550102',email:'smitchell@email.com',status:'active',score:720,income:7800,vehicle:'2021 Ford F-150',created_at:new Date(Date.now()-1*86400000).toISOString()},
  {id:'d3',name:'David Park',phone:'+14035550103',email:'dpark@email.com',status:'converted',score:760,income:9100,vehicle:'2023 Chevrolet Silverado',created_at:new Date(Date.now()-5*86400000).toISOString()},
  {id:'d4',name:'Lisa Chen',phone:'+14035550104',email:'lchen@email.com',status:'active',score:640,income:5400,vehicle:'2020 Honda Civic',created_at:new Date(Date.now()-3*86400000).toISOString()},
];

const DEMO_DEAL_LOG = [
  {id:'dl1',ts:new Date(Date.now()-1*86400000).toISOString(),vehicle:{stock:'MAG-1004',desc:'2023 Chevrolet Silverado'},customer:{name:'David Park'},financial:{price:51200,doc:998,apr:7.99,gst:5,finalDown:3000},products:{vscPrice:2400,gapPrice:895}},
  {id:'dl2',ts:new Date(Date.now()-3*86400000).toISOString(),vehicle:{stock:'MAG-1002',desc:'2022 Toyota RAV4'},customer:{name:'Maria Santos'},financial:{price:34500,doc:998,apr:8.49,gst:5,finalDown:2000},products:{vscPrice:1800,gapPrice:795}},
  {id:'dl3',ts:new Date(Date.now()-7*86400000).toISOString(),vehicle:{stock:'MAG-1001',desc:'2021 Ford F-150'},customer:{name:'Tyler Brooks'},financial:{price:38900,doc:998,apr:6.99,gst:5,finalDown:4000},products:{vscPrice:2100,gapPrice:895}},
];

function startDemo() {
  window.DEMO_MODE = true;

  // Wipe any real user data from localStorage first
  ['ffInventory','ffCRM','ffDealLog','ffSettings','ffScenarios','ffCurrentDeal','ffLenderRates'].forEach(k => localStorage.removeItem(k));

  // Inject demo data — mutate window.settings IN-PLACE so the `settings` alias in platform-main.js stays in sync
  window.ffInventory = DEMO_INVENTORY;
  window.inventory   = DEMO_INVENTORY;
  window.crmData     = DEMO_CRM;
  window.dealLog     = DEMO_DEAL_LOG;
  Object.assign(window.settings, {salesName:'Demo User', dealerName:'Maple Auto Group', docFee:998, gst:5, apr:8.99, target:30, logoUrl:''});
  if(typeof updateHeaderDealer === 'function') updateHeaderDealer();

  localStorage.setItem('ffInventory',   JSON.stringify(DEMO_INVENTORY));
  localStorage.setItem('ffCRM',         JSON.stringify(DEMO_CRM));
  localStorage.setItem('ffDealLog',     JSON.stringify(DEMO_DEAL_LOG));
  localStorage.setItem('ffSettings',    JSON.stringify(window.settings));
  localStorage.setItem('ffScenarios',   JSON.stringify([null,null,null]));

  // Show demo banner, hide login
  document.getElementById('ff-login-overlay').style.display = 'none';
  document.getElementById('demo-banner').style.display = 'block';

  // Load demo deal into desk
  setTimeout(() => {
    try {
      setVal('stockNum','MAG-1001');
      setVal('vehicleDesc','2021 Ford F-150 XLT');
      setVal('vin','1FTFW1ET5MFA12345');
      setVal('odometer','45000');
      setVal('sellingPrice','38900');
      setVal('docFee','998');
      setVal('apr','7.99');
      setVal('gstRate','5');
      setVal('custName','Sarah Mitchell');
      setVal('custPhone','+14035550102');
      setVal('creditScore','720');
      setVal('monthlyIncome','7800');
      setVal('vscPrice','2295');
      setVal('vscCost','895');
      setVal('gapPrice','895');
      setVal('gapCost','295');
      setVal('unitAcv','28000');
      setVal('recon','1200');
      setVal('lotPack','500');
      if(typeof calculate === 'function') calculate();
      if(typeof initInventory === 'function') initInventory();
      if(typeof refreshLenderCheckerDropdowns === 'function') refreshLenderCheckerDropdowns();
      if(typeof renderCRM === 'function') renderCRM();
      if(typeof refreshAllAnalytics === 'function') refreshAllAnalytics();
      if(typeof renderScenarios === 'function') renderScenarios();
      if(typeof updateHeaderDealer === 'function') updateHeaderDealer();
      lucide.createIcons();
      toast('Welcome to Maple Auto Group — Demo Mode 🚀');
    } catch(e) { console.warn('Demo setup:', e.message); }
  }, 400);
}

function exitDemo() {
  document.getElementById('demo-exit-modal').style.display = 'flex';
}

function _doExitDemo() {
  window.DEMO_MODE = false;
  document.getElementById('demo-banner').style.display = 'none';
  document.getElementById('demo-exit-modal').style.display = 'none';
  ['tour-tooltip','tour-spotlight','tour-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
  ['ffInventory','ffCRM','ffDealLog','ffSettings','ffScenarios','ffCurrentDeal','ffLenderRates']
    .forEach(k => localStorage.removeItem(k));
  location.replace('/platform');
}

// Block writes to Postgres in demo mode — patch apiFetch
const _origApiFetch = window.FF ? window.FF.apiFetch : null;
document.addEventListener('DOMContentLoaded', () => {
  if(window.FF) {
    const _real = window.FF.apiFetch.bind(window.FF);
    window.FF.apiFetch = function(path, opts) {
      if(!window.DEMO_MODE) return _real(path, opts);

      // Block all writes
      if(opts && ['PUT','POST','DELETE'].includes((opts.method||'').toUpperCase())) {
        console.log('[DEMO] Blocked write to:', path);
        return Promise.resolve({ ok:true, json: () => Promise.resolve({success:true}) });
      }

      // Block Sarah reads — return empty demo-safe data
      const SARAH_PATHS = ['/api/conversations', '/api/conversation/', '/api/dashboard',
        '/api/appointments', '/api/callbacks', '/api/qualified-leads',
        '/api/analytics', '/api/deals', '/api/voicemails', '/api/bulk-status'];
      if(SARAH_PATHS.some(p => path.startsWith(p))) {
        console.log('[DEMO] Blocked Sarah read:', path);
        if(path.startsWith('/api/conversations')) return Promise.resolve({ ok:true, json: () => Promise.resolve([]) });
        if(path.startsWith('/api/dashboard')) return Promise.resolve({ ok:true, json: () => Promise.resolve({stats:{totalCustomers:0,totalConversations:0,totalMessages:0,totalAppointments:0,totalCallbacks:0},recentAppointments:[],recentCallbacks:[]}) });
        return Promise.resolve({ ok:true, json: () => Promise.resolve({success:true, data:[], leads:[], voicemails:[], deals:[]}) });
      }

      return _real(path, opts);
    };
  }
});

// Also check URL param on load
// Also check URL param on load
if(new URLSearchParams(location.search).get('demo') === '1') {
  // DOMContentLoaded has already fired by the time this inline script runs — call directly
  setTimeout(startDemo, 300);
}

// ═══════════════════════════════════════════════════════════
// GUIDED TOUR
// ═══════════════════════════════════════════════════════════
const TOUR_STEPS = [
  {
    section: 'deal',
    target: '#section-deal .card:first-child',
    label: '01 — Deal Desk',
    title: 'Build Any Deal in Minutes',
    body: 'Structure a complete deal from scratch — selling price, trade, F&I products, down payment, and monthly payment across any term. Everything calculates instantly as you type.',
    diff: '💡 Most platforms make you bounce between 3 different tools. First Fin does it all in one screen.',
  },
  {
    section: 'deal',
    target: '.scenario-strip',
    label: '02 — Scenario Builder',
    title: 'A, B, C Scenarios — Instantly',
    body: 'Save up to 3 deal scenarios side by side. Show your customer options without losing your work. Swap between them in one click.',
    diff: '💡 Present options confidently without fumbling through spreadsheets or starting over.',
  },
  {
    section: 'lenders',
    target: '#section-lenders',
    label: '03 — Lender Engine',
    title: 'See Every Lender at Once',
    body: 'Run the deal through your full lender lineup instantly. Each lender shows eligibility, LTV, max advance, and approval likelihood based on the deal structure you built.',
    diff: '💡 No more guessing who to send to first. First Fin ranks your lenders so you submit right the first time.',
  },
  {
    section: 'compare',
    target: '#section-compare',
    label: '04 — Compare All',
    title: 'Full Lender Comparison in One Click',
    body: 'See every eligible lender ranked side by side — rates, max advance, payment, and profit. Pick the best deal for your customer and your store simultaneously.',
    diff: '💡 This view alone saves 45+ minutes per deal that dealers waste calling lenders one by one.',
  },
  {
    section: 'sarah',
    target: '#section-sarah',
    label: '05 — SARAH AI',
    title: 'AI That Follows Up So You Don\'t Have To',
    body: 'SARAH automatically texts your leads, handles replies intelligently, and books test drive appointments — 24 hours a day. Every conversation is tracked in a unified timeline.',
    diff: '💡 The average dealer loses 60% of internet leads to slow follow-up. SARAH responds in seconds.',
  },
  {
    section: 'inventory',
    target: '#section-inventory',
    label: '06 — Inventory',
    title: 'Your Lot, Always Up to Date',
    body: 'Sync your inventory directly from your lot management tool. Every vehicle feeds into the Deal Desk dropdown, the lender checker, and SARAH\'s lead matching automatically.',
    diff: '💡 One sync keeps your entire platform current — deal desk, lenders, and AI all see the same inventory.',
  },
  {
    section: 'analytics',
    target: '#section-analytics',
    label: '07 — Analytics',
    title: 'Know Your Numbers Cold',
    body: 'Track gross profit per deal, F&I penetration, monthly volume, and sales pace against your target. All your data in one dashboard — no exports, no spreadsheets.',
    diff: null,
  },
  {
    section: null,
    target: null,
    label: '08 — Why First Fin',
    title: 'One Platform. Every Tool You Need.',
    body: 'Deal Desk + F&I + Multi-Lender + AI Follow-Up + Inventory + Analytics — fully integrated, fully customizable, and built specifically for independent dealers. No bloated DMS. No per-module pricing. No IT department required.',
    diff: '🏆 Secure, cloud-hosted, and accessible from any device. Get your team up and running in under an hour.',
    contact: 'Ready to get started? Reach us at First@FirstFinancialCanada.com',
    final: true,
  },
];

let _tourStep = 0;

function startTour() {
  if(!window.DEMO_MODE) return;
  _tourStep = 0;
  _showTourStep();
}

function _showTourStep() {
  const step = TOUR_STEPS[_tourStep];
  if(!step) { tourSkip(); return; }

  // Navigate to section
  if(step.section) {
    const navBtn = document.querySelector(`button[onclick*="'${step.section}'"]`);
    if(navBtn) navBtn.click();
  }

  setTimeout(() => {
    const tooltip  = document.getElementById('tour-tooltip');
    const spotlight = document.getElementById('tour-spotlight');

    document.getElementById('tour-step-label').textContent = step.label;
    document.getElementById('tour-step-count').textContent = `${_tourStep+1} of ${TOUR_STEPS.length}`;
    document.getElementById('tour-title').textContent = step.title;
    document.getElementById('tour-body').textContent = step.body;

    const diffEl = document.getElementById('tour-differentiator');
    if(step.diff) { diffEl.style.display='block'; diffEl.textContent = step.diff; }
    else { diffEl.style.display='none'; }

    const contactEl = document.getElementById('tour-contact');
    if(step.contact) { contactEl.style.display='block'; }
    else { contactEl.style.display='none'; }

    document.getElementById('tour-prev').style.visibility = _tourStep === 0 ? 'hidden' : 'visible';
    const nextBtn = document.getElementById('tour-next');
    nextBtn.textContent = step.final ? '🚀 Get Started' : 'Next →';
    nextBtn.onclick = step.final ? tourGetStarted : tourNext;

    // Position spotlight on target
    const target = step.target ? document.querySelector(step.target) : null;
    if(target) {
      const r = target.getBoundingClientRect();
      const pad = 10;
      spotlight.style.cssText = `display:block;position:fixed;z-index:99999;pointer-events:none;
        left:${r.left-pad}px;top:${r.top-pad}px;
        width:${r.width+pad*2}px;height:${r.height+pad*2}px;
        box-shadow:0 0 0 9999px rgba(0,0,0,0.72);border-radius:12px;transition:all .35s ease;`;

      // Measure the actual rendered tooltip height instead of guessing 280px.
      // Show it off-screen first, measure, then move it into position.
      tooltip.style.cssText = `display:block;position:fixed;z-index:100000;width:340px;
        top:-9999px;left:-9999px;visibility:hidden;
        background:#0d1526;border:1px solid rgba(30,90,246,0.5);border-radius:14px;
        padding:24px;font-family:'Outfit',sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.6);`;
      const tipH = tooltip.offsetHeight || 320;
      const margin = 16;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Prefer below target, fall back to above
      let top = r.bottom + pad + margin;
      if (top + tipH > vh - margin) {
        // Try above
        top = r.top - pad - tipH - margin;
      }
      // Hard clamp — never go off top or bottom of viewport
      top = Math.max(margin, Math.min(top, vh - tipH - margin));

      // Horizontal: align to target left, clamp within viewport
      const left = Math.max(margin, Math.min(r.left, vw - 340 - margin));

      tooltip.style.cssText = `display:block;visibility:visible;position:fixed;z-index:100000;width:340px;
        top:${top}px;left:${left}px;
        background:#0d1526;border:1px solid rgba(30,90,246,0.5);border-radius:14px;
        padding:24px;font-family:'Outfit',sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.6);`;
    } else {
      // Final step — center
      spotlight.style.display = 'none';
      tooltip.style.cssText = `display:block;position:fixed;z-index:100000;width:340px;
        top:50%;left:50%;transform:translate(-50%,-50%);
        background:#0d1526;border:1px solid rgba(245,158,11,0.5);border-radius:14px;
        padding:28px;font-family:'Outfit',sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.8);`;
    }

    document.getElementById('tour-overlay').style.display = 'block';
    lucide.createIcons();
  }, step.section ? 350 : 50);
}

function tourNext() {
  const step = TOUR_STEPS[_tourStep];
  if(step && step.final) { tourSkip(); return; }
  _tourStep++;
  if(_tourStep >= TOUR_STEPS.length) { tourSkip(); return; }
  _showTourStep();
}

function tourPrev() {
  if(_tourStep === 0) return;
  _tourStep--;
  _showTourStep();
}

function tourSkip() {
  document.getElementById('tour-tooltip').style.display = 'none';
  document.getElementById('tour-spotlight').style.display = 'none';
  document.getElementById('tour-overlay').style.display = 'none';
}

function tourGetStarted() {
  tourSkip();
  // Navigate to Deal Desk and toast a welcome
  const dealBtn = document.querySelector("button[onclick*='deal']");
  if (dealBtn) dealBtn.click();
  setTimeout(() => {
    if (typeof toast === 'function') toast("You're in! Explore the demo freely — no data is saved.");
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }, 200);
}
