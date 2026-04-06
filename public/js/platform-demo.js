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
  {id:'d1',name:'James Thornton',phone:'+14035550101',email:'jthornton@email.com',status:'Test Drive',score:680,income:6200,vehicle:'2022 Toyota RAV4',date:'2024-01-14',beacon:680,stock:'MAG-1002',created_at:new Date(Date.now()-2*86400000).toISOString()},
  {id:'d2',name:'Sarah Mitchell',phone:'+14035550102',email:'smitchell@email.com',status:'Negotiating',score:720,income:7800,vehicle:'2021 Ford F-150',date:'2024-01-15',beacon:720,stock:'MAG-1001',created_at:new Date(Date.now()-1*86400000).toISOString()},
  {id:'d3',name:'David Park',phone:'+14035550103',email:'dpark@email.com',status:'Sold',score:760,income:9100,vehicle:'2023 Chevrolet Silverado',date:'2024-01-10',beacon:760,stock:'MAG-1004',created_at:new Date(Date.now()-5*86400000).toISOString()},
  {id:'d4',name:'Lisa Chen',phone:'+14035550104',email:'lchen@email.com',status:'Contacted',score:640,income:5400,vehicle:'2020 Honda Civic',date:'2024-01-13',beacon:640,stock:'MAG-1003',created_at:new Date(Date.now()-3*86400000).toISOString()},
  {id:'d5',name:'Marcus Williams',phone:'+14035550105',email:'mwilliams@email.com',status:'Lead',score:695,income:6800,vehicle:'2021 Hyundai Tucson',date:'2024-01-16',beacon:695,stock:'MAG-1005',created_at:new Date(Date.now()-86400000/2).toISOString()},
  {id:'d6',name:'Rachel Torres',phone:'+14035550106',email:'rtorres@email.com',status:'Test Drive',score:740,income:8200,vehicle:'2019 Jeep Wrangler',date:'2024-01-12',beacon:740,stock:'MAG-1006',created_at:new Date(Date.now()-4*86400000).toISOString()},
  {id:'d7',name:'Kevin OBrien',phone:'+14035550107',email:'kobrien@email.com',status:'Sold',score:780,income:10500,vehicle:'2023 Chevrolet Silverado',date:'2024-01-09',beacon:780,stock:'MAG-1004',created_at:new Date(Date.now()-6*86400000).toISOString()},
  {id:'d8',name:'Priya Sharma',phone:'+14035550108',email:'psharma@email.com',status:'Contacted',score:660,income:5900,vehicle:'2022 Toyota RAV4',date:'2024-01-11',beacon:660,stock:'MAG-1002',created_at:new Date(Date.now()-4*86400000+3600000).toISOString()},
  {id:'d9',name:'Amanda Cole',phone:'+14035550109',email:'acole@email.com',status:'Sold',score:710,income:7200,vehicle:'2020 Honda Civic Sport',date:'2024-01-08',beacon:710,stock:'MAG-1003',created_at:new Date(Date.now()-5*86400000).toISOString()},
  {id:'d10',name:'Derek Haines',phone:'+14035550110',email:'dhaines@email.com',status:'Negotiating',score:690,income:6500,vehicle:'2021 Ford F-150 XLT',date:'2024-01-15',beacon:690,stock:'MAG-1001',created_at:new Date(Date.now()-1*86400000).toISOString()},
  {id:'d11',name:'Jason Firth',phone:'+14035550111',email:'jfirth@email.com',status:'Test Drive',score:650,income:5800,vehicle:'2021 Hyundai Tucson',date:'2024-01-14',beacon:650,stock:'MAG-1005',created_at:new Date(Date.now()-2*86400000).toISOString()},
  {id:'d12',name:'Samira Youssef',phone:'+14035550112',email:'syoussef@email.com',status:'Lead',score:735,income:8900,vehicle:'2019 Jeep Wrangler',date:'2024-01-16',beacon:735,stock:'MAG-1006',created_at:new Date(Date.now()-0.5*86400000).toISOString()},
];

const DEMO_DEAL_LOG = [
  {id:'dl1',ts:new Date(Date.now()-0.5*86400000).toISOString(),vehicle:{stock:'MAG-1004',desc:'2023 Chevrolet Silverado'},customer:{name:'David Park'},financial:{price:51200,doc:998,apr:7.99,gst:5,finalDown:3000},products:{vscPrice:2400,gapPrice:895}},
  {id:'dl2',ts:new Date(Date.now()-1*86400000).toISOString(),vehicle:{stock:'MAG-1002',desc:'2022 Toyota RAV4'},customer:{name:'Maria Santos'},financial:{price:34500,doc:998,apr:8.49,gst:5,finalDown:2000},products:{vscPrice:1800,gapPrice:795}},
  {id:'dl3',ts:new Date(Date.now()-2*86400000).toISOString(),vehicle:{stock:'MAG-1001',desc:'2021 Ford F-150'},customer:{name:'Tyler Brooks'},financial:{price:38900,doc:998,apr:6.99,gst:5,finalDown:4000},products:{vscPrice:2100,gapPrice:895}},
  {id:'dl4',ts:new Date(Date.now()-3*86400000).toISOString(),vehicle:{stock:'MAG-1005',desc:'2021 Hyundai Tucson'},customer:{name:'Jason Firth'},financial:{price:27800,doc:998,apr:9.49,gst:5,finalDown:1000},products:{vscPrice:1695,gapPrice:795,twPrice:495}},
  {id:'dl5',ts:new Date(Date.now()-4*86400000).toISOString(),vehicle:{stock:'MAG-1004',desc:'2023 Chevrolet Silverado'},customer:{name:'Kevin OBrien'},financial:{price:51200,doc:998,apr:7.49,gst:5,finalDown:5000},products:{vscPrice:2500,gapPrice:895,twPrice:595}},
  {id:'dl6',ts:new Date(Date.now()-5*86400000).toISOString(),vehicle:{stock:'MAG-1003',desc:'2020 Honda Civic Sport'},customer:{name:'Amanda Cole'},financial:{price:22900,doc:998,apr:7.99,gst:5,finalDown:2500},products:{vscPrice:1495,gapPrice:695}},
  {id:'dl7',ts:new Date(Date.now()-6*86400000).toISOString(),vehicle:{stock:'MAG-1006',desc:'2019 Jeep Wrangler'},customer:{name:'Rachel Torres'},financial:{price:31500,doc:998,apr:8.99,gst:5,finalDown:1500},products:{vscPrice:1995,gapPrice:795}},
  {id:'dl8',ts:new Date(Date.now()-7*86400000).toISOString(),vehicle:{stock:'MAG-1001',desc:'2021 Ford F-150 XLT'},customer:{name:'Derek Haines'},financial:{price:38900,doc:998,apr:8.49,gst:5,finalDown:3500},products:{vscPrice:2295,gapPrice:895,twPrice:595,waPrice:395}},
  {id:'dl9',ts:new Date(Date.now()-9*86400000).toISOString(),vehicle:{stock:'MAG-1002',desc:'2022 Toyota RAV4 LE'},customer:{name:'Priya Sharma'},financial:{price:34500,doc:998,apr:7.99,gst:5,finalDown:4000},products:{vscPrice:1800,gapPrice:795}},
  {id:'dl10',ts:new Date(Date.now()-11*86400000).toISOString(),vehicle:{stock:'MAG-1005',desc:'2021 Hyundai Tucson'},customer:{name:'Chris Nolan'},financial:{price:27800,doc:998,apr:8.99,gst:5,finalDown:0},products:{gapPrice:795}},
  {id:'dl11',ts:new Date(Date.now()-13*86400000).toISOString(),vehicle:{stock:'MAG-1003',desc:'2020 Honda Civic Sport'},customer:{name:'Tina Belmont'},financial:{price:22900,doc:998,apr:9.49,gst:5,finalDown:1000},products:{vscPrice:1495,gapPrice:695,twPrice:395}},
  {id:'dl12',ts:new Date(Date.now()-15*86400000).toISOString(),vehicle:{stock:'MAG-1004',desc:'2023 Chevrolet Silverado'},customer:{name:'Ryan Michaels'},financial:{price:51200,doc:998,apr:7.49,gst:5,finalDown:6000},products:{vscPrice:2500,gapPrice:895}},
  {id:'dl13',ts:new Date(Date.now()-18*86400000).toISOString(),vehicle:{stock:'MAG-1006',desc:'2019 Jeep Wrangler'},customer:{name:'Samira Youssef'},financial:{price:31500,doc:998,apr:8.49,gst:5,finalDown:2000},products:{vscPrice:1995,gapPrice:795,twPrice:495}},
  {id:'dl14',ts:new Date(Date.now()-21*86400000).toISOString(),vehicle:{stock:'MAG-1001',desc:'2021 Ford F-150 XLT'},customer:{name:'Ben Harper'},financial:{price:38900,doc:998,apr:7.99,gst:5,finalDown:5000},products:{vscPrice:2100,gapPrice:895}},
  {id:'dl15',ts:new Date(Date.now()-24*86400000).toISOString(),vehicle:{stock:'MAG-1002',desc:'2022 Toyota RAV4 LE'},customer:{name:'Nicole Fraser'},financial:{price:34500,doc:998,apr:8.99,gst:5,finalDown:3000},products:{vscPrice:1800,gapPrice:795,waPrice:295}},
  {id:'dl16',ts:new Date(Date.now()-27*86400000).toISOString(),vehicle:{stock:'MAG-1005',desc:'2021 Hyundai Tucson'},customer:{name:'Omar Khalid'},financial:{price:27800,doc:998,apr:7.49,gst:5,finalDown:2000},products:{vscPrice:1695,gapPrice:795}},
  {id:'dl17',ts:new Date(Date.now()-29*86400000).toISOString(),vehicle:{stock:'MAG-1003',desc:'2020 Honda Civic Sport'},customer:{name:'Laura Chen'},financial:{price:22900,doc:998,apr:8.49,gst:5,finalDown:1500},products:{vscPrice:1495}},
  {id:'dl18',ts:new Date(Date.now()-30*86400000).toISOString(),vehicle:{stock:'MAG-1004',desc:'2023 Chevrolet Silverado'},customer:{name:'Greg Parsons'},financial:{price:51200,doc:998,apr:7.99,gst:5,finalDown:4000},products:{vscPrice:2500,gapPrice:895,twPrice:595,waPrice:395}},
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

  // Detect light mode — use dark ink on light bg, light ink on dark bg
  const isLight = document.body.classList.contains('light-mode');
  const ink      = isLight ? '#0f172a' : 'white';
  // Slightly higher opacity in light mode so it\'s actually visible
  const tileOpacity = isLight ? '0.12' : '0.08';

  const tileW = 340;
  const tileH = 180;
  const angle = -28;
  const cols  = Math.ceil(vw / tileW) + 4;
  const rows  = Math.ceil(vh / tileH) + 4;

  let tiles = '';
  for (let r = -2; r < rows; r++) {
    for (let c = -2; c < cols; c++) {
      const cx = c * tileW + (r % 2) * (tileW / 2);
      const cy = r * tileH;
      tiles += `
        <g transform="translate(${cx + tileW/2}, ${cy + tileH/2}) rotate(${angle})" opacity="${tileOpacity}">
          <image href="${DEMO_LOGO_B64}" x="-28" y="-28" width="52" height="52"/>
          <text x="30" y="-8"
            font-family="'Bebas Neue', 'Outfit', sans-serif"
            font-size="16" font-weight="900" fill="${ink}"
            letter-spacing="3.5">FIRST-FIN</text>
          <text x="30" y="9"
            font-family="'Outfit', sans-serif"
            font-size="9" font-weight="700" fill="${ink}"
            letter-spacing="2.5" opacity="0.9">DEMO MODE</text>
          <text x="30" y="23"
            font-family="'DM Mono', monospace"
            font-size="7" fill="${ink}"
            letter-spacing="1.2" opacity="0.7">firstfinancialcanada.com</text>
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

// Rebuild if light-mode class is applied to body after watermark is shown
// (covers the case where saved theme preference is applied after DOMContentLoaded)
const _wmThemeObserver = new MutationObserver(() => {
  if (window.DEMO_MODE) _buildWatermarkSVG();
});
_wmThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

function startDemo() {
  window.DEMO_MODE = true;

  // Wipe any real user data from localStorage first
  ['ffInventory','ffCRM','ffDealLog','ffSettings','ffScenarios','ffCurrentDeal','ffLenderRates'].forEach(k => localStorage.removeItem(k));

  // Inject demo data — mutate window.settings IN-PLACE so the `settings` alias in platform-main.js stays in sync
  window.ffInventory = DEMO_INVENTORY;
  window.inventory   = DEMO_INVENTORY;
  window.crmData     = DEMO_CRM.map(c => ({
    ...c,
    date:    c.date    || new Date(c.created_at).toLocaleDateString('en-CA'),
    beacon:  c.beacon  || c.score || '—',
    vehicle: c.vehicle || '—',
    stock:   c.stock   || '',
  }));
  // Hydrate deal log with computed fields that renderDealLog/refreshAllAnalytics expect
  window.dealLog     = DEMO_DEAL_LOG.map(d => {
    const ts = new Date(d.ts);
    const p = d.products || {};
    const pvr = (parseFloat(p.vscPrice)||0) + (parseFloat(p.gapPrice)||0) + (parseFloat(p.twPrice)||0) + (parseFloat(p.waPrice)||0);
    return { ...d, loggedAt: ts.toLocaleDateString('en-CA'), loggedTime: ts.toLocaleTimeString('en-CA'),
      loggedMonth: ts.getMonth(), loggedYear: ts.getFullYear(), loggedDay: ts.toDateString(), pvr };
  });
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
      // Apply demo field constraints and lock manager tools
      setTimeout(demoApplyConstraints, 100);
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
      if(typeof loadSarahDashboard === 'function') setTimeout(loadSarahDashboard, 200);
      if(typeof refreshAllAnalytics === 'function') refreshAllAnalytics();
      if(typeof renderScenarios === 'function') renderScenarios();
      if(typeof updateHeaderDealer === 'function') updateHeaderDealer();
      lucide.createIcons();
      toast('Welcome to Maple Auto Group — Demo Mode 🚀');
    } catch(e) { console.warn('Demo setup:', e.message); }
  }, 400);
}


// ═══════════════════════════════════════════════════════════
// DEMO FIELD CONSTRAINTS
// ═══════════════════════════════════════════════════════════

// Baseline values set when demo starts — constraints are relative to these
const DEMO_BASELINE = {
  apr:               7.99,
  odometer:          45000,
  creditScore:       720,
  monthlyIncome:     7800,
  existingPayments:  1800,
  tradeAllow:        8500,
  tradePayoff:       6200,
  acv:               8000,
  vscPrice:          500,
  gapPrice:          500,
  twPrice:           500,
  waPrice:           500,
  compareBeacon:     720,
  compareIncome:     7800,
  compareDown:       3000,
  contractRate:      8.99,
  compareContractRate: 8.99,
};

const DEMO_LIMITS = {
  apr:               0.25,
  odometer:          100,
  creditScore:       20,
  monthlyIncome:     200,
  existingPayments:  100,
  tradeAllow:        200,
  tradePayoff:       200,
  acv:               200,
  vscPrice:          15,
  gapPrice:          15,
  twPrice:           15,
  waPrice:           15,
  compareBeacon:     20,
  compareIncome:     200,
  compareDown:       200,
  contractRate:      0.25,
  compareContractRate: 0.25,
};

// Fields that are completely locked (no adjustment allowed) in demo mode
const DEMO_LOCKED_FIELDS = [
  'sellingPrice','docFee','gstRate','finalDown',
  'unitAcv','recon','lotPack','vscCost','gapCost','twCost','waCost',
  'contractRate','buyRate','bankSplit','reserveTerm',
  'compareFees','compareTerm',
];

// Manager sections locked entirely (show upgrade prompt instead)
const DEMO_LOCKED_MGR_TABS = ['profit','reserve','subprime','tools','commission'];

let _demoUpgradeShown = false;

function demoBumpCheck(fieldId) {
  if (!window.DEMO_MODE) return;
  const baseline = DEMO_BASELINE[fieldId];
  const limit    = DEMO_LIMITS[fieldId];
  if (baseline === undefined) return;

  const el  = document.getElementById(fieldId);
  if (!el) return;
  const val = parseFloat(el.value);
  if (isNaN(val)) return;

  const min = parseFloat((baseline - limit).toFixed(2));
  const max = parseFloat((baseline + limit).toFixed(2));

  if (val < min) { el.value = min; showDemoUpgradePopup(); return; }
  if (val > max) { el.value = max; showDemoUpgradePopup(); return; }
}

function showDemoUpgradePopup() {
  if (_demoUpgradeShown) return;
  _demoUpgradeShown = true;
  const pop = document.getElementById('demo-upgrade-popup');
  if (pop) {
    pop.classList.add('show');
    clearTimeout(pop._t);
    pop._t = setTimeout(() => {
      pop.classList.remove('show');
      _demoUpgradeShown = false;
    }, 4000);
  }
}

function demoBumpAndCalc(fieldId) {
  demoBumpCheck(fieldId);
  if (typeof calculate === 'function') calculate();
}

function demoLockField(fieldId) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  el.readOnly  = true;
  el.style.opacity = '0.5';
  el.style.cursor  = 'not-allowed';
  el.title     = 'Locked in demo mode — upgrade to adjust';
  el.addEventListener('focus', showDemoUpgradePopup);
}

function demoApplyConstraints() {
  if (!window.DEMO_MODE) return;

  // Apply baseline values for constrained fields
  Object.entries(DEMO_BASELINE).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && !DEMO_LOCKED_FIELDS.includes(id)) el.value = val;
  });

  // Lock completely locked fields
  DEMO_LOCKED_FIELDS.forEach(demoLockField);

  // Wire constrained inputs
  Object.keys(DEMO_LIMITS).forEach(id => {
    const el = document.getElementById(id);
    if (!el || DEMO_LOCKED_FIELDS.includes(id)) return;
    el.addEventListener('change', () => demoBumpAndCalc(id));
    el.addEventListener('blur',   () => demoBumpAndCalc(id));
    // For number inputs, also on input (with debounce so they can type)
    if (el.type === 'number') {
      let _t;
      el.addEventListener('input', () => {
        clearTimeout(_t);
        _t = setTimeout(() => demoBumpCheck(id), 800);
      });
    }
  });

  // Lock F&I sold checkboxes — can check/uncheck but not adjust beyond limit
  // (limits already handled by vscPrice etc)

  if (typeof calculate === 'function') calculate();
}

// Intercept showMgrTab to block locked manager sections
const _origShowMgrTab = window.showMgrTab;
document.addEventListener('DOMContentLoaded', () => {
  // Override showMgrTab after platform-main.js defines it
  const _patchMgr = () => {
    if (typeof showMgrTab === 'function' && showMgrTab !== _patchedShowMgrTab) {
      window._realShowMgrTab = showMgrTab;
      window.showMgrTab = _patchedShowMgrTab;
    }
  };
  setTimeout(_patchMgr, 600);
});

function _patchedShowMgrTab(id, btn) {
  if (window.DEMO_MODE && DEMO_LOCKED_MGR_TABS.includes(id)) {
    showDemoUpgradePopup();
    // Still show the tab visually but overlay it
    if (typeof window._realShowMgrTab === 'function') window._realShowMgrTab(id, btn);
    // Overlay the locked content
    setTimeout(() => {
      const panel = document.getElementById('mgr-' + id);
      if (panel && !panel.querySelector('.demo-mgr-lock')) {
        const lock = document.createElement('div');
        lock.className = 'demo-mgr-lock';
        lock.innerHTML = `<div style="text-align:center;padding:20px;">
          <div style="font-size:22px;margin-bottom:8px;">🔒</div>
          <div style="font-size:13px;font-weight:700;color:var(--amber);margin-bottom:4px;">Available for Paid Members</div>
          <div style="font-size:11px;color:var(--muted);">Manager tools are locked in demo mode.</div>
        </div>`;
        lock.style.cssText = 'position:absolute;inset:0;background:rgba(5,10,25,.85);backdrop-filter:blur(2px);border-radius:8px;display:flex;align-items:center;justify-content:center;z-index:10;';
        panel.style.position = 'relative';
        panel.appendChild(lock);
      }
    }, 50);
    return;
  }
  if (typeof window._realShowMgrTab === 'function') window._realShowMgrTab(id, btn);
  else {
    // Fallback: inline original logic
    document.querySelectorAll('.mgr-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.mgr-tab').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById('mgr-' + id);
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
  }
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

      // ── Demo mock for Compare All engine ──────────────────────────────────────
      if(opts && (opts.method||'').toUpperCase() === 'POST' && path === '/api/compare-all') {
        console.log('[DEMO] Mocking /api/compare-all response');
        const body = JSON.parse(opts.body || '{}');
        const inv  = window.ffInventory || window.DEMO_INVENTORY || [];
        const v    = inv.find(x => x.stock === body.stock) || inv[0] || {};

        const curYear = new Date().getFullYear();
        const gst     = body.gstEnabled ? (body.gstRate || 5) : 0;
        const taxable = (v.price||34500) + (body.fees||0) - (body.trade||0);
        const atf     = taxable * (1 + gst/100) - (body.down||0);
        const book    = v.book_value || v.price || 29325;
        const ltvPct  = (atf / book) * 100;

        function PMT(r,n,pv){ if(r===0) return Math.abs(pv/n); return Math.abs(pv*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1)); }
        function BPMT(apr,mo,fin){ return PMT(apr/100/12,mo,fin); }

        const term    = body.term || 72;
        const income  = (body.income||0) + (body.coIncome||0);
        const existing = body.existing || 0;
        const beacon  = body.beacon || 0;

        // Build realistic demo lender results
        const demoLenders = [
          { lid:'santander', lName:'SANTANDER CONSUMER', lPhone:'1-888-222-4227', lWeb:'santanderconsumerusa.com', lHard:true, minYear:2015, maxMile:160000, maxCfx:6000,
            prog:{ tier:'Tier 1', rate:9.99, maxLTV:150, fee:595 }, maxLTV:150, lMaxPti:20, lMaxDti:44, lMinIncome:1800, lMaxPay:null },
          { lid:'northlake', lName:'NORTHLAKE FINANCIAL', lPhone:'1-888-652-5320', lWeb:'northlakefinancial.ca', lHard:true, minYear:2003, maxMile:300000, maxCfx:7500,
            prog:{ tier:'Standard', rate:10.99, maxLTV:140, fee:695 }, maxLTV:140, lMaxPti:17, lMaxDti:44, lMinIncome:1800, lMaxPay:930 },
          { lid:'edenpark',  lName:'EDENPARK', lPhone:'1-855-366-8667', lWeb:'edenparkfinancial.ca', lHard:true, minYear:2015, maxMile:180000, maxCfx:7500,
            prog:{ tier:'Tier A', rate:11.99, maxLTV:140, fee:695 }, maxLTV:140, lMaxPti:20, lMaxDti:44, lMinIncome:1800, lMaxPay:null },
          { lid:'iauto',     lName:'iA AUTO FINANCE', lPhone:'1-855-378-5626', lWeb:'ia.ca', lHard:true, minYear:2015, maxMile:180000, maxCfx:7500,
            prog:{ tier:'Tier 1', rate:12.49, maxLTV:140, fee:699 }, maxLTV:140, lMaxPti:20, lMaxDti:44, lMinIncome:1800, lMaxPay:1000 },
          { lid:'prefera',   lName:'PREFERA FINANCE', lPhone:'1-844-734-3577', lWeb:'preferafinance.ca', lHard:true, minYear:2015, maxMile:200000, maxCfx:5000,
            prog:{ tier:'Tier A', rate:16.95, maxLTV:170, fee:695 }, maxLTV:170, lMaxPti:20, lMaxDti:44, lMinIncome:1800, lMaxPay:null },
          { lid:'sda',       lName:'SDA FINANCE', lPhone:'1-800-731-2345', lWeb:'sdafinance.ca', lHard:true, minYear:2012, maxMile:250000, maxCfx:8000,
            prog:{ tier:'Standard', rate:17.99, maxLTV:135, fee:995 }, maxLTV:135, lMaxPti:20, lMaxDti:44, lMinIncome:1800, lMaxPay:null },
        ];
        const demoIneligible = [
          { lid:'autocapital', lName:'AUTOCAPITAL CANADA', lPhone:'855-646-0534', lWeb:'autocapitalcanada.ca', lHard:true,
            prog:null, yearOk:false, mileOk:true, cfxOk:true, ageOk:true, ltvOk:true, ptiOk:true, dtiOk:true, payOk:true, incomeOk:true,
            minYear:2025, approved:false, vehiclePass:false, dealPass:true, beaconPass:true, type:'hard',
            ltvPct:ltvPct, maxLTV:175, atf, payment:0, ptiPct:0, dtiPct:0, lMaxPti:20, lMaxDti:44, lMinIncome:1800, lMaxPay:null,
            structureTip:null, allStructureTips:[], coAppTip:null,
            termResults:{}, passingTerms:[], term, bestTerm:term, optimalTerm:term, flatReserve:895, spreadReserve:0, totalGross:895 },
          { lid:'cibc', lName:'CIBC AUTO FINANCE', lPhone:'1-855-598-1856', lWeb:'cibc.com/auto', lHard:false,
            prog:null, yearOk:true, mileOk:true, cfxOk:true, ageOk:true, ltvOk:false, ptiOk:true, dtiOk:true, payOk:true, incomeOk:true,
            minYear:2015, approved:false, vehiclePass:true, dealPass:false, beaconPass:true, type:'credit',
            ltvPct:ltvPct, maxLTV:96, atf, payment:0, ptiPct:0, dtiPct:0, lMaxPti:null, lMaxDti:null, lMinIncome:null, lMaxPay:null,
            downNeeded:Math.ceil(atf - book*0.96),
            structureTip:`Add $${Math.ceil(atf-book*0.96).toLocaleString()} down → LTV passes`,
            allStructureTips:[`Add $${Math.ceil(atf-book*0.96).toLocaleString()} down → LTV passes`],
            coAppTip:null, termResults:{}, passingTerms:[], term, bestTerm:term, optimalTerm:term, flatReserve:0, spreadReserve:0, totalGross:0 },
        ];

        const eligible = demoLenders.map(l => {
          const rate    = l.prog.rate;
          const lFee    = l.prog.fee || 0;
          const lAtf    = atf + lFee;
          const ltvOk   = (lAtf / book) * 100 <= l.maxLTV;
          const ALL_TERMS = [48,60,72,84];
          const termResults = {};
          let passingTerms = [];
          ALL_TERMS.forEach(t => {
            const pmt = BPMT(rate, t, lAtf);
            const ageOk = (curYear - parseInt(v.year||2022)) + t/12 <= 14;
            const ptiOk = income === 0 || (pmt/income*100) <= l.lMaxPti;
            const dtiOk = income === 0 || ((pmt+existing)/income*100) <= l.lMaxDti;
            const payOk = !l.lMaxPay || pmt <= l.lMaxPay;
            const passes = ageOk && ltvOk && (income===0||(ptiOk&&dtiOk&&payOk));
            if(passes) passingTerms.push(t);
            termResults[t] = { term:t, payment:pmt, ageOk, ptiOk, dtiOk, payOk, passes,
              ptiPct: income>0?pmt/income*100:0, dtiPct: income>0?(pmt+existing)/income*100:0 };
          });
          const optTerm  = passingTerms.length ? passingTerms[passingTerms.length-1] : term;
          const bestTerm = passingTerms.length ? passingTerms[0] : term;
          const selRes   = termResults[term] || termResults[72];
          return { ...l, atf:lAtf, ltvPct:(lAtf/book*100), ltvOk, maxLoan:book*l.maxLTV/100,
            bookVal:book, downNeeded:0, yearOk:true, mileOk:true, cfxOk:true, ageOk:true,
            payment:selRes.payment, ptiPct:selRes.ptiPct, dtiPct:selRes.dtiPct,
            ptiOk:selRes.ptiOk, dtiOk:selRes.dtiOk, payOk:selRes.payOk, incomeOk:true,
            approved:true, vehiclePass:true, dealPass:true, beaconPass:true, type:'hard',
            term, bestTerm, optimalTerm:optTerm, termResults, passingTerms,
            flatReserve:lFee, spreadReserve:0, totalGross:lFee,
            contractRate:body.contractRate||0, buyRate:rate, beacon, income,
            primaryIncome:body.income||0, coIncome:body.coIncome||0, hasCoApp:false, existing,
            lenderFee:lFee, hasBK:false, vehicleAgeAtPayoff:(curYear-parseInt(v.year||2022))+term/12,
            cond:(v.condition||'clean').toLowerCase(),
            structureTip:null, allStructureTips:[], coAppTip:null,
            minYear:l.minYear, maxMile:l.maxMile, maxCfx:l.maxCfx };
        });

        return Promise.resolve({ ok:true, json: () => Promise.resolve({
          success:true, vehicle: v, eligible, ineligible: demoIneligible
        })});
      }

      // ── Demo mock for beacon-match ────────────────────────────────────────
      if(opts && (opts.method||'').toUpperCase() === 'POST' && path === '/api/beacon-match') {
        const body   = JSON.parse(opts.body || '{}');
        const beacon = body.beacon || 0;
        const badges = [
          { lid:'santander',  label: beacon>=600  ? 'SANTANDER — 9.99%'  : 'SANTANDER ✗',  cls: beacon>=600  ? 'badge-green'  : 'badge-red'  },
          { lid:'northlake',  label: beacon>=0    ? 'NORTHLAKE — 10.99%' : 'NORTHLAKE ✗',  cls: beacon>=0    ? 'badge-amber'  : 'badge-red'  },
          { lid:'edenpark',   label: beacon>=500  ? 'EDENPARK — 11.99%'  : 'EDENPARK ✗',   cls: beacon>=500  ? 'badge-amber'  : 'badge-red'  },
          { lid:'iauto',      label: beacon>=500  ? 'iA — 12.49%'        : 'iA ✗',          cls: beacon>=500  ? 'badge-amber'  : 'badge-red'  },
          { lid:'cibc',       label: beacon>=680  ? 'CIBC ✓'             : 'CIBC ✗',        cls: beacon>=680  ? 'badge-green'  : 'badge-red'  },
          { lid:'rbc',        label: beacon>=700  ? 'RBC ✓'              : 'RBC ✗',         cls: beacon>=700  ? 'badge-green'  : 'badge-red'  },
          { lid:'prefera',    label: beacon>=520  ? 'PREFERA — 16.95%'   : 'PREFERA ✗',    cls: beacon>=520  ? 'badge-orange' : 'badge-red'  },
          { lid:'sda',        label: 'SDA — 17.99%', cls: 'badge-orange' },
        ];
        return Promise.resolve({ ok:true, json: () => Promise.resolve({ success:true, badges }) });
      }

      // ── Demo mock for beacon-simulator ───────────────────────────────────
      if(opts && (opts.method||'').toUpperCase() === 'POST' && path === '/api/beacon-simulator') {
        const rows = [
          { label:'<500', approved:2, bestRate:17.99 },
          { label:'500',  approved:4, bestRate:16.95 },
          { label:'540',  approved:5, bestRate:12.49 },
          { label:'560',  approved:5, bestRate:12.49 },
          { label:'580',  approved:5, bestRate:12.49 },
          { label:'600',  approved:6, bestRate:9.99  },
          { label:'620',  approved:6, bestRate:9.99  },
          { label:'640',  approved:6, bestRate:9.99  },
          { label:'660',  approved:6, bestRate:9.99  },
          { label:'680',  approved:8, bestRate:9.99  },
          { label:'700',  approved:8, bestRate:9.99  },
          { label:'720',  approved:8, bestRate:9.99  },
          { label:'750+', approved:8, bestRate:9.99  },
        ];
        return Promise.resolve({ ok:true, json: () => Promise.resolve({ success:true, rows }) });
      }

      // Block all other writes
      if(opts && ['PUT','POST','DELETE'].includes((opts.method||'').toUpperCase())) {
        console.log('[DEMO] Blocked write to:', path);
        return Promise.resolve({ ok:true, json: () => Promise.resolve({success:true}) });
      }

      // Return rich demo data for Sarah reads
      const SARAH_PATHS = ['/api/conversations', '/api/conversation/', '/api/dashboard',
        '/api/appointments', '/api/callbacks', '/api/qualified-leads',
        '/api/analytics', '/api/deals', '/api/voicemails', '/api/bulk-status'];
      if(SARAH_PATHS.some(p => path.startsWith(p))) {
        console.log('[DEMO] Sarah demo response:', path);

        // ── Dashboard stats ──────────────────────────────────────────────────
        if(path.startsWith('/api/dashboard')) {
          return Promise.resolve({ ok:true, json: () => Promise.resolve({
            stats:{totalCustomers:8,totalConversations:11,totalMessages:74,totalAppointments:3,totalCallbacks:2},
            recentAppointments:[
              {id:101,customer_name:'James Thornton',customer_phone:'+14035550101',vehicle_type:'SUV — $25,000–$35,000',budget:'$25,000–$35,000',budget_amount:30000,datetime:'Saturday Jan 20 @ 11:00 AM',created_at:new Date(Date.now()-2*86400000).toISOString()},
              {id:102,customer_name:'Rachel Torres',customer_phone:'+14035550106',vehicle_type:'SUV — $30,000–$40,000',budget:'$30,000–$40,000',budget_amount:35000,datetime:'Monday Jan 22 @ 2:00 PM',created_at:new Date(Date.now()-4*86400000).toISOString()},
              {id:103,customer_name:'Marcus Williams',customer_phone:'+14035550105',vehicle_type:'Truck — $35,000–$45,000',budget:'$35,000–$45,000',budget_amount:40000,datetime:'Tuesday Jan 23 @ 10:30 AM',created_at:new Date(Date.now()-86400000/2).toISOString()},
            ],
            recentCallbacks:[
              {id:201,customer_name:'Priya Sharma',customer_phone:'+14035550108',vehicle_type:'SUV',budget:'$30,000–$35,000',datetime:'Weekday afternoons',created_at:new Date(Date.now()-1*86400000).toISOString()},
              {id:202,customer_name:'Lisa Chen',customer_phone:'+14035550104',vehicle_type:'Car — compact',budget:'$20,000–$25,000',datetime:'Anytime',created_at:new Date(Date.now()-3*86400000).toISOString()},
            ]
          })});
        }

        // ── Analytics ────────────────────────────────────────────────────────
        if(path.startsWith('/api/analytics')) {
          return Promise.resolve({ ok:true, json: () => Promise.resolve({
            conversionRate: 36,
            totalConverted: 4,
            totalEngaged:   3,
            totalStopped:   1,
            totalConversations: 11,
            responseRate: 82,
            totalResponded: 9,
            avgMessages: 6.7,
            weekConversations: 4,
            weekConverted: 2,
            topVehicles:[
              {vehicle_type:'Truck', count:4},
              {vehicle_type:'SUV',   count:5},
              {vehicle_type:'Car',   count:2},
            ],
            budgetDist:[
              {budget:'$20,000–$30,000', count:3},
              {budget:'$30,000–$40,000', count:5},
              {budget:'$40,000–$55,000', count:3},
            ],
            stageFunnel:[
              {stage:'greeting',    count:2},
              {stage:'budget',      count:3},
              {stage:'appointment', count:2},
              {stage:'datetime',    count:1},
              {stage:'confirmed',   count:3},
            ],
            weeklyTrend:[
              {week_start:'2026-02-02T00:00:00Z', conversations:3, converted:1},
              {week_start:'2026-02-09T00:00:00Z', conversations:5, converted:2},
              {week_start:'2026-02-16T00:00:00Z', conversations:4, converted:1},
              {week_start:'2026-02-23T00:00:00Z', conversations:7, converted:3},
              {week_start:'2026-03-02T00:00:00Z', conversations:6, converted:2},
              {week_start:'2026-03-09T00:00:00Z', conversations:8, converted:4},
              {week_start:'2026-03-16T00:00:00Z', conversations:5, converted:2},
              {week_start:'2026-03-23T00:00:00Z', conversations:4, converted:2},
            ],
            dealStats:{
              totalDeals:18, monthDeals:6, weekDeals:3, todayDeals:1,
              vscCount:12, gapCount:14, twCount:8, waCount:6,
              avgBackend:'1450', avgPvr:'1820',
            },
            dealVehicleTypes:[
              {type:'Truck', count:8},
              {type:'SUV',   count:6},
              {type:'Car',   count:4},
            ]
          })});
        }

        // ── Full conversation list ────────────────────────────────────────────
        if(path === '/api/conversations' || path.startsWith('/api/conversations')) {
          const DEMO_CONVS = [
            {customer_phone:'+14035550101',customer_name:'James Thornton',status:'converted',stage:'Appointment Set',vehicle_type:'SUV',budget:'$25,000–$35,000',message_count:8,last_message:'Sounds great, see you Saturday!',updated_at:new Date(Date.now()-2*86400000).toISOString()},
            {customer_phone:'+14035550102',customer_name:'Sarah Mitchell',status:'engaged',stage:'Negotiating',vehicle_type:'Truck',budget:'$35,000–$45,000',message_count:11,last_message:'What\'s the best you can do on payments?',updated_at:new Date(Date.now()-3600000).toISOString()},
            {customer_phone:'+14035550103',customer_name:'David Park',status:'converted',stage:'Deal Funded',vehicle_type:'Truck',budget:'$45,000–$55,000',message_count:7,last_message:'Thanks so much — love the truck!',updated_at:new Date(Date.now()-5*86400000).toISOString()},
            {customer_phone:'+14035550104',customer_name:'Lisa Chen',status:'engaged',stage:'Interested',vehicle_type:'Car',budget:'$20,000–$25,000',message_count:5,last_message:'Do you have anything in red?',updated_at:new Date(Date.now()-3*86400000).toISOString()},
            {customer_phone:'+14035550105',customer_name:'Marcus Williams',status:'converted',stage:'Appointment Set',vehicle_type:'Truck',budget:'$35,000–$45,000',message_count:9,last_message:'Tuesday at 10:30 works perfectly',updated_at:new Date(Date.now()-86400000/2).toISOString()},
            {customer_phone:'+14035550106',customer_name:'Rachel Torres',status:'converted',stage:'Test Drive Done',vehicle_type:'SUV',budget:'$30,000–$40,000',message_count:6,last_message:'The Wrangler was amazing — can we talk numbers?',updated_at:new Date(Date.now()-4*86400000).toISOString()},
            {customer_phone:'+14035550107',customer_name:'Kevin OBrien',status:'converted',stage:'Deal Funded',vehicle_type:'Truck',budget:'$45,000+',message_count:5,last_message:'Just got home — what a beast!',updated_at:new Date(Date.now()-6*86400000).toISOString()},
            {customer_phone:'+14035550108',customer_name:'Priya Sharma',status:'engaged',stage:'Callback Requested',vehicle_type:'SUV',budget:'$30,000–$35,000',message_count:4,last_message:'Call me anytime after 2pm',updated_at:new Date(Date.now()-1*86400000).toISOString()},
            {customer_phone:'+14035550109',customer_name:'Tyler Brooks',status:'converted',stage:'Deal Funded',vehicle_type:'Truck',budget:'$35,000–$45,000',message_count:10,last_message:'Appreciate you working with us on the F-150',updated_at:new Date(Date.now()-7*86400000).toISOString()},
            {customer_phone:'+14035550110',customer_name:'Angela Moore',status:'active',stage:'Initial Contact',vehicle_type:'SUV',budget:'$25,000–$35,000',message_count:3,last_message:'Yes still looking, what do you have?',updated_at:new Date(Date.now()-86400000*0.25).toISOString()},
            {customer_phone:'+14035550111',customer_name:'Daniel Kim',status:'lost',stage:'No Response',vehicle_type:'Car',budget:'$20,000–$28,000',message_count:2,last_message:'',updated_at:new Date(Date.now()-8*86400000).toISOString()},
          ];
          return Promise.resolve({ ok:true, json: () => Promise.resolve(DEMO_CONVS) });
        }

        // ── Individual conversation thread ───────────────────────────────────
        if(path.startsWith('/api/conversation/')) {
          const phone = decodeURIComponent(path.split('/api/conversation/')[1]);
          const THREADS = {
            '+14035550101': [
              {role:'user',content:'Hey, saw your ad — do you have any RAV4s?',created_at:new Date(Date.now()-2*86400000-3600000*3).toISOString()},
              {role:'assistant',content:"Hi James! Yes, we have a 2022 Toyota RAV4 in stock — clean Carfax, only 28,000 km. What\'s most important for you in your next vehicle?",created_at:new Date(Date.now()-2*86400000-3600000*2.8).toISOString()},
              {role:'user',content:'Budget around 30k, need AWD, have a trade',created_at:new Date(Date.now()-2*86400000-3600000*2).toISOString()},
              {role:'assistant',content:"Perfect — AWD is standard on the RAV4. We can absolutely work with a trade-in. Would this Saturday at 11am work for a test drive? We\'ll do a full appraisal on your trade while you\'re here.",created_at:new Date(Date.now()-2*86400000-3600000*1.8).toISOString()},
              {role:'user',content:'Saturday works. What do I need to bring?',created_at:new Date(Date.now()-2*86400000-3600000).toISOString()},
              {role:'assistant',content:"Just your driver's licence and your trade-in vehicle. We\'ll handle everything else. See you Saturday at 11! 🙌",created_at:new Date(Date.now()-2*86400000-1800000).toISOString()},
              {role:'user',content:'Sounds great, see you Saturday!',created_at:new Date(Date.now()-2*86400000).toISOString()},
            ],
            '+14035550102': [
              {role:'user',content:'Looking for an F-150, saw your inventory',created_at:new Date(Date.now()-86400000*1.5).toISOString()},
              {role:'assistant',content:"Hi Sarah! Great choice — we have a 2021 Ford F-150 XLT, 45,000 km, clean unit. Are you financing or paying cash?",created_at:new Date(Date.now()-86400000*1.5+900000).toISOString()},
              {role:'user',content:'Financing. Credit is pretty good, around 720',created_at:new Date(Date.now()-86400000*1.4).toISOString()},
              {role:'assistant',content:"With a 720 beacon you\'re looking at some great rates — likely 7-8% range. Want to come in for a test drive and we can run the numbers together?",created_at:new Date(Date.now()-86400000*1.4+600000).toISOString()},
              {role:'user',content:'What about payments on 72 months with 3k down?',created_at:new Date(Date.now()-3600000*4).toISOString()},
              {role:'assistant',content:"Rough estimate around $620–650/month depending on exact rate. Our finance manager can sharpen that up with your actual approval. Want to book a time?",created_at:new Date(Date.now()-3600000*3.5).toISOString()},
              {role:'user',content:'What\'s the best you can do on payments?',created_at:new Date(Date.now()-3600000).toISOString()},
            ],
            '+14035550110': [
              {role:'user',content:'Still have SUVs available?',created_at:new Date(Date.now()-3600000*5).toISOString()},
              {role:'assistant',content:"Hi Angela! Yes, we have several — RAV4, Tucson, Wrangler. What\'s your budget range?",created_at:new Date(Date.now()-3600000*4.8).toISOString()},
              {role:'user',content:'Yes still looking, what do you have?',created_at:new Date(Date.now()-3600000*1).toISOString()},
            ],
          };
          const msgs = THREADS[phone] || [{role:'user',content:'Hi, interested in a vehicle',created_at:new Date(Date.now()-86400000).toISOString()},{role:'assistant',content:"Hi there! Thanks for reaching out. What kind of vehicle are you looking for?",created_at:new Date(Date.now()-86400000+600000).toISOString()}];
          return Promise.resolve({ ok:true, json: () => Promise.resolve({messages: msgs}) });
        }

        // ── Qualified leads ──────────────────────────────────────────────────
        if(path.startsWith('/api/qualified-leads')) {
          return Promise.resolve({ ok:true, json: () => Promise.resolve([
            {customer_phone:'+14035550102',customer_name:'Sarah Mitchell',vehicle_type:'Truck',budget:'$35,000–$45,000',income:'$7,800/mo'},
            {customer_phone:'+14035550101',customer_name:'James Thornton',vehicle_type:'SUV',budget:'$25,000–$35,000',income:'$6,200/mo'},
            {customer_phone:'+14035550106',customer_name:'Rachel Torres',vehicle_type:'SUV',budget:'$30,000–$40,000',income:'$8,200/mo'},
          ]) });
        }

        // ── Voicemails ───────────────────────────────────────────────────────
        if(path.startsWith('/api/voicemails')) {
          return Promise.resolve({ ok:true, json: () => Promise.resolve([
            {id:1,customer_phone:'+14035550108',customer_name:'Priya Sharma',transcription:'Hi, this is Priya. I saw your message about the RAV4. Can someone call me back after 2pm? Thanks.',duration:14,created_at:new Date(Date.now()-1*86400000).toISOString()},
            {id:2,customer_phone:'+14035550104',customer_name:'Lisa Chen',transcription:"Hey, it\'s Lisa. Just following up — do you have the Civic in any other colours? Looking for red or blue if possible.",duration:18,created_at:new Date(Date.now()-2*86400000).toISOString()},
          ]) });
        }

        // Fallback for any other Sarah paths
        return Promise.resolve({ ok:true, json: () => Promise.resolve({success:true, data:[], leads:[], deals:[]}) });
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
