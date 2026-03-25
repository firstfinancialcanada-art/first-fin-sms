// ═══════════════════════════════════════════════════════════
// DEMO MODE
// ═══════════════════════════════════════════════════════════
window.DEMO_MODE = false;

const DEMO_INVENTORY = [
  {stock:'MAG-1001',year:'2021',make:'Ford',model:'F-150',mileage:45000,price:38900,type:'Truck',condition:'Clean',carfax:1,vin:'1FTFW1ET5MFA12345',book_value:33065},
  {stock:'MAG-1002',year:'2022',make:'Toyota',model:'RAV4',mileage:28000,price:34500,type:'SUV',condition:'Clean',carfax:1,vin:'2T3P1RFV3NC123456',book_value:29325},
  {stock:'MAG-1003',year:'2020',make:'Honda',model:'Civic',mileage:52000,price:22900,type:'Car',condition:'Average',carfax:0,vin:'2HGFC2F69LH123456',book_value:18320},
  {stock:'MAG-1004',year:'2023',make:'Chevrolet',model:'Silverado',mileage:18000,price:51200,type:'Truck',condition:'Extra Clean',carfax:1,vin:'3GCUYDEDXNG123456',book_value:45500},
  {stock:'MAG-1005',year:'2021',make:'Hyundai',model:'Tucson',mileage:39000,price:27800,type:'SUV',condition:'Average',carfax:1,vin:'5NMS33AD3MH123456',book_value:22240},
  {stock:'MAG-1006',year:'2019',make:'Jeep',model:'Wrangler',mileage:67000,price:31500,type:'SUV',condition:'Average',carfax:0,vin:'1C4HJXDG5KW123456',book_value:25800},
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


// ═══════════════════════════════════════════════════════════
// DEMO WATERMARK
// ═══════════════════════════════════════════════════════════
const DEMO_LOGO_B64 = 'data:image/png;base64,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';

function _buildWatermarkSVG() {
  const svg = document.getElementById('demo-wm-svg');
  if (!svg) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);

  // Tile parameters
  const tileW = 340;
  const tileH = 180;
  const angle = -28; // degrees
  const cols  = Math.ceil(vw / tileW) + 4;
  const rows  = Math.ceil(vh / tileH) + 4;

  let tiles = '';
  for (let r = -2; r < rows; r++) {
    for (let c = -2; c < cols; c++) {
      const cx = c * tileW + (r % 2) * (tileW / 2);
      const cy = r * tileH;
      tiles += `
        <g transform="translate(${cx + tileW/2}, ${cy + tileH/2}) rotate(${angle})" opacity="0.07">
          <image href="${DEMO_LOGO_B64}" x="-28" y="-28" width="52" height="52"/>
          <text x="30" y="-8"
            font-family="'Bebas Neue', 'Outfit', sans-serif"
            font-size="16" font-weight="900" fill="white"
            letter-spacing="3.5">FIRST-FIN</text>
          <text x="30" y="9"
            font-family="'Outfit', sans-serif"
            font-size="9" font-weight="700" fill="white"
            letter-spacing="2.5" opacity="0.9">DEMO MODE</text>
          <text x="30" y="23"
            font-family="'DM Mono', monospace"
            font-size="7" fill="white"
            letter-spacing="1.2" opacity="0.6">firstfinancialcanada.com</text>
        </g>`;
    }
  }
  svg.innerHTML = tiles;
}

function _showDemoWatermark() {
  const el = document.getElementById('demo-watermark');
  if (!el) return;
  el.style.display = 'block';
  _buildWatermarkSVG();
}

function _hideDemoWatermark() {
  const el = document.getElementById('demo-watermark');
  if (el) el.style.display = 'none';
}

// Rebuild on resize so tiles always cover the viewport
window.addEventListener('resize', () => {
  if (window.DEMO_MODE) _buildWatermarkSVG();
});

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

  // Show demo banner, hide login, show watermark
  document.getElementById('ff-login-overlay').style.display = 'none';
  document.getElementById('demo-banner').style.display = 'block';
  _showDemoWatermark();

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
      // Pre-populate Compare All inputs with demo F-150 data
      try {
        const setC = (id,val) => { const e=document.getElementById(id); if(e) e.value=val; };
        setC('compareBeacon','720');
        setC('compareIncome','7800');
        setC('compareDown','3000');
        setC('compareFees','998');
        setC('compareContractRate','8.99');
        // Stock dropdown needs inventory loaded first — defer
        setTimeout(() => {
          const stockEl = document.getElementById('compareStock');
          if(stockEl && stockEl.options.length > 1) {
            for(let i=0;i<stockEl.options.length;i++){
              if(stockEl.options[i].value==='MAG-1001'){stockEl.selectedIndex=i;break;}
            }
          }
        }, 600);
      } catch(e) {}
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
  _hideDemoWatermark();
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
    title: '12 Lenders. One Screen. Zero Guesswork.',
    body: 'Upload any lender PDF rate sheet and the engine parses it automatically — or add tiers manually. Every lender runs per-lender PTI, DTI, LTV, mileage, and year gates against the actual deal. Add custom lenders: the engine handles them identically.',
    diff: '💡 No more rate sheet binders on your desk. One upload and your whole lineup is live — for every dealer on the platform independently.',
  },
  {
    section: 'compare',
    target: '#section-compare',
    label: '04 — Compare All',
    title: 'Full Lender Comparison in One Click',
    body: 'Every eligible lender ranked by rate with payment-by-term grids, PTI/DTI pass/fail, LTV bar, and estimated gross — simultaneously. Declined lenders show the exact dollar amount of down payment needed to flip them to approved. Add a co-applicant, toggle GST, simulate any beacon score.',
    diff: '💡 The beacon range simulator shows how many lenders approve at every credit band — a game-changer for credit coaching conversations.',
    autoRun: true,
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
    // Auto-run Compare All with demo data when that step is active
    if(step.autoRun && step.section === 'compare') {
      try {
        const v = DEMO_INVENTORY[0]; // F-150 MAG-1001
        const stockEl = document.getElementById('compareStock');
        if(stockEl) {
          // Find and select the demo stock
          for(let i=0;i<stockEl.options.length;i++){
            if(stockEl.options[i].value === v.stock){stockEl.selectedIndex=i;break;}
          }
        }
        const setC = (id,val) => { const e=document.getElementById(id); if(e) e.value=val; };
        setC('compareBeacon','720');
        setC('compareIncome','7800');
        setC('compareDown','3000');
        setC('compareFees','998');
        setC('compareTerm','72');
        setC('compareContractRate','8.99');
        if(typeof runComparison === 'function') setTimeout(runComparison, 200);
      } catch(e) { console.warn('Demo compare auto-run:', e.message); }
    }

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
