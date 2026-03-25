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
        <g transform="translate(${cx + tileW/2}, ${cy + tileH/2}) rotate(${angle})" opacity="0.055">
          <image href="${DEMO_LOGO_B64}" x="-18" y="-22" width="36" height="36"/>
          <text x="22" y="-6"
            font-family="'Bebas Neue', 'Outfit', sans-serif"
            font-size="15" font-weight="900" fill="white"
            letter-spacing="3">FIRST-FIN</text>
          <text x="22" y="10"
            font-family="'Outfit', sans-serif"
            font-size="9.5" font-weight="700" fill="white"
            letter-spacing="2" opacity="0.85">DEMO MODE</text>
          <text x="22" y="22"
            font-family="'DM Mono', monospace"
            font-size="7.5" fill="white"
            letter-spacing="1" opacity="0.6">firstfinancialcanada.com</text>
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
