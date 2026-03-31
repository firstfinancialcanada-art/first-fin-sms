// popup.js — FIRST-FIN Inventory Importer v2.2
'use strict';
console.log('[FIRST-FIN] popup.js loaded');

const API          = 'https://app.firstfinancialcanada.com';
const PLATFORM_URL = 'https://app.firstfinancialcanada.com/platform#inventory';
const FB_URL       = 'https://app.firstfinancialcanada.com/platform#dtsync';

// ── State ─────────────────────────────────────────────────────────────────
let scraped          = [];
let syncMode         = 'add';
let authToken        = null;
let currentTab       = null;
let currentSite      = { name: '', score: 0 };
let bgScanActive     = false;     // true while background.js is running a scan
let bgLogRendered    = 0;         // how many background log entries we've already shown

// ── Logo ──────────────────────────────────────────────────────────────────
function drawLogo() {
  const c = document.getElementById('logo');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = 48, H = 42, cx = W / 2, top = 4, bot = H - 4;
  function tri(ax,ay, bx,by, rx,ry, fill, stroke) {
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.lineTo(rx,ry); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  tri(cx-8,top, cx-24,bot, cx+3, bot, '#1e3a5f','#8090a8');
  tri(cx+8,top, cx-3, bot, cx+24,bot, '#6a7d94','#b8c8d8');
  ctx.save(); ctx.translate(cx, top-1); ctx.scale(0.55,0.55);
  const leaf=[[0,-18],[3,-12],[11,-10],[7,-5],[18,-2],[10,3],[9,8],[4,6],[3,14],[0,11],[-3,14],[-4,6],[-9,8],[-10,3],[-18,-2],[-7,-5],[-11,-10],[-3,-12]];
  ctx.beginPath(); ctx.moveTo(leaf[0][0],leaf[0][1]); leaf.forEach(([x,y])=>ctx.lineTo(x,y)); ctx.closePath();
  ctx.fillStyle='#c0392b'; ctx.fill(); ctx.strokeStyle='#8b1a14'; ctx.lineWidth=1; ctx.stroke();
  ctx.fillStyle='#c0392b'; ctx.fillRect(-2,14,4,7); ctx.restore();
}

// ── Utilities ─────────────────────────────────────────────────────────────
function ts() { return new Date().toTimeString().slice(0,8); }

function log(msg, cls='') {
  const box = document.getElementById('logBox');
  if (!box) return;
  box.classList.remove('hidden');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${ts()}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function showView(id) {
  ['viewLogin','viewMain','viewPreview','viewDone'].forEach(v =>
    document.getElementById(v).classList.add('hidden')
  );
  document.getElementById(id).classList.remove('hidden');
}

function setProgress(pct) {
  document.getElementById('progressWrap').classList.remove('hidden');
  document.getElementById('progressFill').style.width = pct + '%';
}
function resetProgress() {
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressWrap').classList.add('hidden');
}

function setSiteDot(state, label) {
  const dot = document.getElementById('siteDot');
  dot.className = 'site-dot' + (state==='ok' ? ' green' : state==='err' ? ' red' : '');
  document.getElementById('siteLabel').textContent = label;
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Sync mode ─────────────────────────────────────────────────────────────
const MODE_DESCS = {
  add:         'Add vehicles — skip any VINs already in your inventory',
  replace:     'Replace entire inventory with this scan',
  consolidate: 'Update existing VIN matches, add new ones, keep the rest'
};
function selectMode(mode) {
  syncMode = mode;
  ['Add','Replace','Consolidate'].forEach(m =>
    document.getElementById('mode'+m).classList.toggle('active', m.toLowerCase()===mode)
  );
  document.getElementById('modeDesc').textContent = MODE_DESCS[mode] || '';
}

// ── Auth ──────────────────────────────────────────────────────────────────
async function tryLogin(email, pw) {
  try {
    const r = await fetch(`${API}/api/desk/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password: pw })
    });
    let d;
    try { d = await r.json(); }
    catch (_) { return { ok: false, error: `Server error (HTTP ${r.status}) — try again` }; }

    const token = d.accessToken || d.token;
    if (r.ok && token) {
      authToken = token;
      const user = d.user || {};
      const name = user.name || user.display_name || email;
      await chrome.storage.local.set({ token, email, userName: name, userEmail: email });
      return { ok: true, name, email };
    }
    return { ok: false, error: d.error || d.message || `Login failed (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, error: 'Could not reach FIRST-FIN server. Check your internet connection.' };
  }
}

async function loadAuth() {
  try {
    const s = await chrome.storage.local.get(['token','email','userName','userEmail']);
    if (s.token) { authToken = s.token; return s; }
  } catch (_) {}
  return null;
}

async function logout() {
  // Cancel any in-progress background scan
  chrome.runtime.sendMessage({ type: 'CLEAR_SCAN' }).catch(() => {});
  bgScanActive  = false;
  bgLogRendered = 0;

  await chrome.storage.local.clear().catch(()=>{});
  authToken = null;
  scraped   = [];
  document.getElementById('loginEmail').value = '';
  document.getElementById('loginPw').value    = '';
  document.getElementById('btnLogout').classList.add('hidden');
  document.getElementById('userBadge').classList.add('hidden');
  document.getElementById('logBox').innerHTML = '';
  resetProgress();
  showView('viewLogin');
}

// ── Site detection ────────────────────────────────────────────────────────
function detectSite(url) {
  if (!url) return { name: 'Unknown page', score: 0 };
  const u = url.toLowerCase();
  if (u.includes('houseofcars.com'))  return { name: 'House of Cars',    score: 10 };
  if (u.includes('automaxx'))         return { name: 'Automaxx',          score: 9  };
  if (u.includes('universalford'))    return { name: 'Universal Ford',    score: 9  };
  if (u.includes('autotrader.ca'))    return { name: 'AutoTrader Canada', score: 8  };
  if (u.includes('kijiji.ca'))        return { name: 'Kijiji Autos',      score: 7  };
  if (u.includes('cargurus.com'))     return { name: 'CarGurus',          score: 7  };
  if (u.includes('/inventory') || u.includes('/vehicles') || u.includes('/used-'))
    return { name: 'Dealer Inventory Page', score: 6 };
  return { name: url.split('/')[2] || 'Current page', score: 3 };
}

// ── Tab helpers ───────────────────────────────────────────────────────────
function waitForTabLoad(tabId, timeoutMs=12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); return; }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 200);
      }
    });
  });
}

// Send SCRAPE message to content.js, auto-inject on first failure
async function scrapeTab(tabId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE' });
    } catch (e) {
      if (attempt === 0) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 400));
        } catch (_) {}
      } else {
        throw new Error('Could not communicate with page. Try refreshing the tab and scanning again.');
      }
    }
  }
}

// ── Background scan progress handler ─────────────────────────────────────
function handleBgScanProgress(state) {
  if (!state) return;

  const btn = document.getElementById('btnScan');

  // Append only new log entries (avoid duplicates on reconnect)
  const newEntries = (state.log || []).slice(bgLogRendered);
  newEntries.forEach(entry => log(entry.text, entry.cls || ''));
  bgLogRendered = (state.log || []).length;

  // Update progress bar
  const pct = state.total > 0 ? 20 + Math.round((state.current / state.total) * 72) : 5;
  setProgress(Math.min(pct, 98));

  if (state.status === 'running') {
    document.getElementById('scanLabel').textContent =
      `Scanning ${state.current}/${state.total}...`;
  }

  if (state.status === 'done') {
    bgScanActive  = false;
    bgLogRendered = 0;
    scraped = state.vehicles || [];
    chrome.runtime.sendMessage({ type: 'CLEAR_SCAN' }).catch(() => {});

    btn.disabled = false;
    document.getElementById('scanLabel').textContent = 'Scan This Page';

    if (scraped.length === 0) {
      setProgress(0);
      resetProgress();
      log('No valid vehicles were found — check the page and try again.', 'err');
      return;
    }
    setProgress(100);
    buildPreview(scraped);
    selectMode('add');
    showView('viewPreview');
  }

  if (state.status === 'error') {
    bgScanActive  = false;
    bgLogRendered = 0;
    chrome.runtime.sendMessage({ type: 'CLEAR_SCAN' }).catch(() => {});
    btn.disabled = false;
    document.getElementById('scanLabel').textContent = 'Scan This Page';
    resetProgress();
  }
}

// ── Preview builder ───────────────────────────────────────────────────────
function buildPreview(vehicles) {
  document.getElementById('previewCount').textContent = vehicles.length;
  const list = document.getElementById('vehicleList');
  list.innerHTML = '';
  vehicles.slice(0, 8).forEach(v => {
    const item = document.createElement('div');
    item.className = 'vehicle-item';
    const title  = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || v._title || 'Unknown Vehicle';
    const km     = v.mileage ? v.mileage.toLocaleString() + ' km' : '';
    const price  = v.price   ? '$' + Number(v.price).toLocaleString() : '';
    item.innerHTML =
      `<span class="vi-title">${title}</span>` +
      `<span class="vi-details">${[km,price].filter(Boolean).join(' · ')}</span>`;
    list.appendChild(item);
  });
  if (vehicles.length > 8) {
    const more = document.createElement('div');
    more.className = 'vehicle-more';
    more.textContent = `+ ${vehicles.length - 8} more vehicles`;
    list.appendChild(more);
  }
}

// ── Scan flow ─────────────────────────────────────────────────────────────
async function runScan() {
  if (!currentTab) { log('No active tab detected — try reopening the extension.', 'err'); return; }

  const btn = document.getElementById('btnScan');
  btn.disabled = true;
  document.getElementById('scanLabel').textContent = 'Scanning...';
  document.getElementById('logBox').innerHTML = '';
  document.getElementById('logBox').classList.add('hidden');
  setProgress(5);
  log('Scanning page for vehicles...', 'hi');

  try {
    const response = await scrapeTab(currentTab.id);
    if (!response || !response.ok) throw new Error(response?.error || 'Scraper returned no data');

    const result = response.result;
    setProgress(15);

    if (result.type === 'listing' && result.links?.length > 0) {
      // Delegate multi-VDP crawl to background.js so it survives popup close
      log(`Found ${result.links.length} vehicle pages — handing off to background...`, 'hi');
      bgScanActive  = true;
      bgLogRendered = 0;

      chrome.runtime.sendMessage({ type: 'START_SCAN', links: result.links })
        .catch(() => {
          bgScanActive = false;
          log('Could not start background scan — try again.', 'err');
          btn.disabled = false;
          document.getElementById('scanLabel').textContent = 'Scan This Page';
        });
      // UI updates come through the SCAN_PROGRESS listener
      return;

    } else if (result.vehicles?.length > 0) {
      scraped = result.vehicles.filter(isRealVehicle);
      setProgress(90);
      scraped.forEach(v =>
        log(`  ✓ ${v.year} ${v.make} ${v.model} — ${(v.mileage||0).toLocaleString()} km · $${(v.price||0).toLocaleString()}`, 'ok')
      );
    } else {
      throw new Error('No vehicles found on this page. Make sure you\'re on an inventory/listing page.');
    }

    if (scraped.length === 0) throw new Error('No valid vehicles were found — check the page and try again.');

    setProgress(100);
    log(`✅ ${scraped.length} vehicles ready to sync`, 'ok');
    buildPreview(scraped);
    selectMode('add');
    showView('viewPreview');
    btn.disabled = false;
    document.getElementById('scanLabel').textContent = 'Scan This Page';

  } catch (e) {
    log(`❌ ${e.message}`, 'err');
    btn.disabled = false;
    document.getElementById('scanLabel').textContent = 'Scan This Page';
    resetProgress();
  }
}

function isRealVehicle(v) {
  const junk = ['for sale in','under $','house of cars','inventory','alberta','calgary'];
  const tl   = (v._title || '').toLowerCase();
  return !junk.some(j => tl.includes(j)) && (v.year||0) >= 1950;
}

// ── Sync flow ─────────────────────────────────────────────────────────────
async function runSync() {
  if (!scraped.length) return;
  const btn = document.getElementById('btnSync');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⏳</span> Syncing...';

  try {
    const clean = scraped.map(v =>
      Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')))
    );
    const r = await fetch(`${API}/api/desk/inventory/sync`, {
      method:  'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
      body:    JSON.stringify({ mode: syncMode, vehicles: clean })
    });
    let d;
    try { d = await r.json(); } catch (_) { d = {}; }
    if (!r.ok || !d.success) throw new Error(d.error || `Server error (HTTP ${r.status})`);

    const parts = [];
    if (d.inserted) parts.push(`${d.inserted} added`);
    if (d.updated)  parts.push(`${d.updated} updated`);
    if (d.skipped)  parts.push(`${d.skipped} skipped`);
    document.getElementById('doneNum').textContent    = (d.inserted||0) + (d.updated||0);
    document.getElementById('doneDetail').textContent = parts.join(' · ') || `Mode: ${syncMode}`;
    showView('viewDone');

  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '<span>↑</span> Sync to FIRST-FIN';
    const old = document.getElementById('syncError');
    if (old) old.remove();
    const errEl = document.createElement('div');
    errEl.id = 'syncError';
    errEl.style.cssText = 'color:#e74c3c;font-size:11px;margin-top:8px;padding:8px 10px;background:rgba(231,76,60,.1);border-radius:5px;border:1px solid rgba(231,76,60,.3);';
    errEl.textContent = e.message;
    btn.insertAdjacentElement('afterend', errEl);
    setTimeout(() => errEl.remove(), 8000);
  }
}

// ── Event listeners (synchronous — wired before any await) ────────────────
function initListeners() {
  console.log('[FIRST-FIN] Attaching listeners');

  // ── Background scan progress (popup can close and reopen mid-scan)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SCAN_PROGRESS') {
      handleBgScanProgress(msg.state);
    }
  });

  // ── Login
  document.getElementById('btnLogin').addEventListener('click', async () => {
    console.log('[FIRST-FIN] Login button clicked');
    const email = document.getElementById('loginEmail').value.trim();
    const pw    = document.getElementById('loginPw').value;
    const errEl = document.getElementById('loginError');
    errEl.classList.add('hidden');
    errEl.textContent = '';

    if (!email || !pw) {
      showError('loginError', 'Please enter your email and password.');
      return;
    }

    const btn = document.getElementById('btnLogin');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin">⏳</span> Signing in...';

    try {
      const result = await tryLogin(email, pw);
      console.log('[FIRST-FIN] Login result:', result.ok, result.error || '');
      if (result.ok) {
        document.getElementById('userName').textContent  = result.name;
        document.getElementById('userEmail').textContent = result.email;
        document.getElementById('userBadge').classList.remove('hidden');
        document.getElementById('btnLogout').classList.remove('hidden');
        document.getElementById('pageDesc').textContent =
          currentSite.score >= 5
            ? `Ready to scan ${currentSite.name} inventory.`
            : 'Navigate to a dealer inventory page, then click Scan.';
        showView('viewMain');
      } else {
        showError('loginError', result.error);
        btn.disabled = false;
        btn.innerHTML = '<span>▶</span> Sign In to FIRST-FIN';
      }
    } catch (e) {
      showError('loginError', e.message || 'Unexpected error — please try again.');
      btn.disabled = false;
      btn.innerHTML = '<span>▶</span> Sign In to FIRST-FIN';
    }
  });

  document.getElementById('loginPw').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnLogin').click();
  });

  // ── Scan
  document.getElementById('btnScan').addEventListener('click', runScan);

  // ── Mode buttons
  document.getElementById('modeAdd').addEventListener('click',         () => selectMode('add'));
  document.getElementById('modeReplace').addEventListener('click',     () => selectMode('replace'));
  document.getElementById('modeConsolidate').addEventListener('click', () => selectMode('consolidate'));

  // ── Sync
  document.getElementById('btnSync').addEventListener('click', runSync);

  // ── Rescan
  document.getElementById('btnRescan').addEventListener('click', () => {
    scraped = [];
    document.getElementById('logBox').innerHTML = '';
    document.getElementById('logBox').classList.add('hidden');
    document.getElementById('scanLabel').textContent = 'Scan This Page';
    document.getElementById('btnScan').disabled = false;
    resetProgress();
    showView('viewMain');
  });

  // ── Done view
  document.getElementById('btnOpenPlatform').addEventListener('click', () =>
    chrome.tabs.create({ url: PLATFORM_URL })
  );
  document.getElementById('btnOpenFBPoster').addEventListener('click', () =>
    chrome.tabs.create({ url: FB_URL })
  );
  document.getElementById('btnScanAnother').addEventListener('click', () => {
    scraped = [];
    document.getElementById('logBox').innerHTML = '';
    document.getElementById('logBox').classList.add('hidden');
    document.getElementById('scanLabel').textContent = 'Scan This Page';
    document.getElementById('btnScan').disabled = false;
    resetProgress();
    showView('viewMain');
  });

  // ── Logout
  document.getElementById('btnLogout').addEventListener('click', logout);

  console.log('[FIRST-FIN] All listeners attached');
}

// ── Init: async setup (tab detection + saved auth + scan reconnect) ────────
async function initAsync() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab  = tab;
    currentSite = detectSite(tab?.url || '');
    if (currentSite.score >= 5) {
      setSiteDot('ok', `Inventory page: ${currentSite.name}`);
    } else {
      setSiteDot('', 'Navigate to a dealer inventory page');
    }
  } catch (e) {
    console.warn('[FIRST-FIN] tabs.query failed:', e.message);
    setSiteDot('', 'Could not detect current page');
  }

  try {
    const auth = await loadAuth();
    if (auth) {
      document.getElementById('userName').textContent  = auth.userName  || '';
      document.getElementById('userEmail').textContent = auth.userEmail || '';
      document.getElementById('userBadge').classList.remove('hidden');
      document.getElementById('btnLogout').classList.remove('hidden');
      document.getElementById('pageDesc').textContent =
        currentSite.score >= 5
          ? `Ready to scan ${currentSite.name} inventory.`
          : 'Navigate to a dealer inventory page, then click Scan.';
      showView('viewMain');
    } else {
      showView('viewLogin');
      return; // don't check scan state if not logged in
    }
  } catch (e) {
    console.warn('[FIRST-FIN] loadAuth failed:', e.message);
    showView('viewLogin');
    return;
  }

  // ── Reconnect to background scan if one was running when popup was closed ──
  try {
    const stored = await chrome.storage.local.get('activeScan');
    const state  = stored.activeScan;
    if (!state) return;

    if (state.status === 'running') {
      // Scan is still in progress — show the main view with progress
      showView('viewMain');
      bgScanActive  = true;
      bgLogRendered = 0;
      document.getElementById('btnScan').disabled = true;

      // Render all log entries accumulated so far
      (state.log || []).forEach(entry => log(entry.text, entry.cls || ''));
      bgLogRendered = (state.log || []).length;

      const pct = state.total > 0 ? 20 + Math.round((state.current / state.total) * 72) : 5;
      setProgress(Math.min(pct, 98));
      document.getElementById('scanLabel').textContent =
        `Scanning ${state.current}/${state.total}...`;

    } else if (state.status === 'done' && state.vehicles?.length > 0) {
      // Scan completed while popup was closed — go straight to preview
      scraped = state.vehicles;
      chrome.storage.local.remove('activeScan').catch(() => {});
      buildPreview(scraped);
      selectMode('add');
      showView('viewPreview');
    } else {
      // Error or empty result — clean up
      chrome.storage.local.remove('activeScan').catch(() => {});
    }
  } catch (e) {
    console.warn('[FIRST-FIN] scan reconnect check failed:', e.message);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  console.log('[FIRST-FIN] DOMContentLoaded fired');
  drawLogo();
  initListeners(); // sync — buttons are live before any network call
  initAsync();     // async — tab/auth/scan-reconnect, isolated so failures can't break buttons
});
