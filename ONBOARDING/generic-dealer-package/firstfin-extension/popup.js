// popup.js — FIRST-FIN Inventory Importer v2.2
'use strict';
console.log('[FIRST-FIN] popup.js loaded');

const API          = 'https://app.firstfinancialcanada.com';
const PLATFORM_URL = 'https://app.firstfinancialcanada.com/platform#inventory';
const FB_URL       = 'https://app.firstfinancialcanada.com/platform#fbposter';

// ── State ─────────────────────────────────────────────────────────────────
let scraped          = [];
let syncMode         = 'add';
let authToken        = null;
let refreshToken     = null;
let currentTab       = null;
let currentSite      = { name: '', score: 0 };
let bgScanActive     = false;     // true while background.js is running a scan
let bgLogRendered    = 0;         // how many background log entries we've already shown

// ── Logo ──────────────────────────────────────────────────────────────────
// Logo is rendered via <img src="icons/logo.png"> in popup.html
function drawLogo() {}

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
      refreshToken = d.refreshToken || null;
      const user = d.user || {};
      const name = user.name || user.display_name || email;
      const dealerName = user.tenantBranding?.dealerName || '';
      await chrome.storage.local.set({ token, refreshToken: refreshToken, email, userName: name, userEmail: email, dealerName });
      return { ok: true, name, email, dealerName };
    }
    return { ok: false, error: d.error || d.message || `Login failed (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, error: 'Could not reach FIRST-FIN server. Check your internet connection.' };
  }
}

async function loadAuth() {
  try {
    const s = await chrome.storage.local.get(['token','refreshToken','email','userName','userEmail','dealerName']);
    if (s.token) { authToken = s.token; refreshToken = s.refreshToken || null; return s; }
  } catch (_) {}
  return null;
}

// Auto-refresh access token using refresh token
async function refreshAccessToken() {
  if (!refreshToken) return false;
  try {
    const r = await fetch(`${API}/api/desk/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    const d = await r.json();
    if (r.ok && d.accessToken) {
      authToken = d.accessToken;
      if (d.refreshToken) refreshToken = d.refreshToken;
      await chrome.storage.local.set({ token: authToken, refreshToken });
      console.log('[FIRST-FIN] Token refreshed successfully');
      return true;
    }
  } catch (e) {
    console.warn('[FIRST-FIN] Token refresh failed:', e.message);
  }
  return false;
}

// Authenticated fetch with auto-refresh on 401
async function authFetch(path, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers['Authorization'] = `Bearer ${authToken}`;
  let r = await fetch(`${API}${path}`, opts);
  if (r.status === 401) {
    if (refreshToken) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        opts.headers['Authorization'] = `Bearer ${authToken}`;
        r = await fetch(`${API}${path}`, opts);
      } else {
        // Refresh failed — force re-login but keep scan data
        showView('viewLogin');
        throw new Error('Session expired — please sign in again. Your scan data is saved.');
      }
    } else {
      // No refresh token (old login) — force re-login but keep scan data
      showView('viewLogin');
      throw new Error('Session expired — please sign in again. Your scan data is saved.');
    }
  }
  return r;
}

async function logout() {
  // Cancel any in-progress background scan
  chrome.runtime.sendMessage({ type: 'CLEAR_SCAN' }).catch(() => {});
  bgScanActive  = false;
  bgLogRendered = 0;

  await chrome.storage.local.remove(['token','refreshToken','email','userName','userEmail','dealerName']).catch(()=>{});
  authToken = null;
  refreshToken = null;
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
    // Don't clear scan from storage here — keep it until sync completes

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

  // Clear any stale scan data from previous runs
  scraped = [];
  bgScanActive = false;
  chrome.storage.local.remove('activeScan').catch(() => {});
  chrome.runtime.sendMessage({ type: 'CLEAR_SCAN' }).catch(() => {});

  const btn = document.getElementById('btnScan');
  btn.disabled = true;
  document.getElementById('scanLabel').textContent = 'Checking...';
  document.getElementById('logBox').innerHTML = '';
  document.getElementById('logBox').classList.add('hidden');
  setProgress(5);

  try {
    // ── Domain lock check ─────────────────────────────────────
    if (authToken && currentTab?.url) {
      try {
        const lockResp = await authFetch('/api/desk/scrape-domain');
        const lockData = await lockResp.json();
        if (lockData.locked && lockData.scrape_domain) {
          const pageHost = new URL(currentTab.url).hostname.replace(/^www\./, '').toLowerCase();
          const allowed = lockData.scrape_domain.replace(/^www\./, '').toLowerCase();
          if (pageHost !== allowed) {
            throw new Error(`Scraper is locked to ${lockData.scrape_domain}. You are on ${pageHost}. Contact First-Fin to change.`);
          }
          log(`Domain verified: ${pageHost}`, 'ok');
        }
      } catch(lockErr) {
        if (lockErr.message.includes('locked to')) throw lockErr;
        // If domain check fails (network etc), allow scan to proceed
      }
    }

    document.getElementById('scanLabel').textContent = 'Scanning...';
    setProgress(8);
    log('Scanning page for vehicles...', 'hi');

    let response = await scrapeTab(currentTab.id);
    if (!response || !response.ok) throw new Error(response?.error || 'Scraper returned no data');

    let result = response.result;

    // Retry for AJAX-rendered pages (Algolia, etc.) — if very few results, wait and re-scrape
    if ((!result.links || result.links.length < 3) && (!result.vehicles || result.vehicles.length < 3)) {
      for (let retry = 0; retry < 3; retry++) {
        log('Waiting for page to finish loading...', '');
        await new Promise(r => setTimeout(r, 2500));
        response = await scrapeTab(currentTab.id);
        if (response?.ok) result = response.result;
        const count = (result.links?.length || 0) + (result.vehicles?.length || 0);
        if (count >= 3) break;
      }
    }

    setProgress(15);

    if (result.type === 'listing' && result.links?.length > 0) {
      let allLinks = result.links;
      let pageLinks = result.pageLinks || [];

      // Vehica (WordPress theme) — pagination is Vue-rendered, background tab can't see it.
      // Collect all VDP links by clicking through pages in the foreground tab.
      if (result.vehicaPagination) {
        log(`Found ${allLinks.length} vehicles on page 1 — collecting ${result.vehicaPagination} more pages...`, 'hi');
        setProgress(18);
        try {
          const collected = await chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            func: async (totalPages) => {
              const VDP_RE = /\/(inventory\/((Used|New)-)?|vehicle-details\/|vehicle\/|vehicles\/|demos\/|used\/|new\/inventory\/)\d{4}[-\/]/i;
              const allLinks = new Set();
              // Collect from current page
              document.querySelectorAll('a[href]').forEach(a => { if (VDP_RE.test(a.href)) allLinks.add(a.href); });
              // Click through remaining pages using the right arrow (handles sliding window pagination)
              for (let p = 2; p <= totalPages; p++) {
                // Try direct page number first, then fall back to right arrow
                let pageDiv = [...document.querySelectorAll('.vehica-pagination__page')].find(d => d.textContent.trim() === String(p));
                if (!pageDiv) {
                  // Page number not visible — use right arrow to advance
                  pageDiv = document.querySelector('.vehica-pagination__arrow--right');
                }
                if (!pageDiv) break;
                pageDiv.click();
                await new Promise(r => setTimeout(r, 2500));
                document.querySelectorAll('a[href]').forEach(a => { if (VDP_RE.test(a.href)) allLinks.add(a.href); });
              }
              return [...allLinks];
            },
            args: [result.vehicaPagination]
          });
          const vehicaLinks = collected?.[0]?.result || [];
          if (vehicaLinks.length > allLinks.length) {
            log(`Collected ${vehicaLinks.length} vehicles across ${result.vehicaPagination} pages`, 'ok');
            allLinks = vehicaLinks;
          }
          pageLinks = []; // All links collected — no need for background pagination crawl
        } catch (e) {
          log(`Could not collect all pages: ${e.message}`, 'err');
        }
      }

      // "Load more" / infinite scroll (Algolia, etc.) — click button in foreground until all loaded
      if (result.hasLoadMore) {
        log(`Found ${allLinks.length} vehicles — clicking "Load more" to get all...`, 'hi');
        setProgress(18);
        try {
          const collected = await chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            func: async () => {
              const VDP_RE = /\/(inventory\/((Used|New)-)?|vehicle-details\/|vehicle\/|vehicles\/|demos\/|used\/|new\/inventory\/)\d{4}[-\/]/i;
              // Click "load more" repeatedly until button disappears or no new links
              for (let i = 0; i < 50; i++) {
                const btn = document.querySelector('.ais-InfiniteHits-loadMore:not([disabled]), [class*="load-more"]:not([disabled]), [class*="loadmore"]:not([disabled])');
                if (!btn || btn.disabled) break;
                btn.click();
                await new Promise(r => setTimeout(r, 2000));
              }
              // Collect all VDP links
              const allLinks = new Set();
              document.querySelectorAll('a[href]').forEach(a => { if (VDP_RE.test(a.href)) allLinks.add(a.href); });
              return [...allLinks];
            }
          });
          const loadedLinks = collected?.[0]?.result || [];
          if (loadedLinks.length > allLinks.length) {
            log(`Loaded ${loadedLinks.length} vehicles total (was ${allLinks.length})`, 'ok');
            allLinks = loadedLinks;
          }
          pageLinks = [];
        } catch (e) {
          log(`Could not load all: ${e.message}`, 'err');
        }
      }

      // Delegate multi-VDP crawl to background.js so it survives popup close
      log(`Found ${allLinks.length} vehicle pages — handing off to background...`, 'hi');
      bgScanActive  = true;
      bgLogRendered = 0;

      chrome.runtime.sendMessage({ type: 'START_SCAN', links: allLinks, pageLinks, cardVehicles: result.cardVehicles || null })
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

    // Persist scan results so they survive popup close/reopen
    chrome.storage.local.set({ activeScan: { status: 'done', vehicles: scraped, total: scraped.length, current: scraped.length, log: [] } }).catch(() => {});

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
  const junk = ['for sale in','under $','house of cars','inventory','alberta','calgary','wholesale'];
  const tl   = (v._title || '').toLowerCase();
  if (junk.some(j => tl.includes(j))) return false;
  if ((v.year||0) < 1990 || (v.year||0) > new Date().getFullYear() + 2) return false;
  if (v.make === 'Used' || v.make === 'New') return false;
  if (/^GEN\d+$/i.test(v.stock) && !v.make) return false;
  return true;
}

// ── Sync flow ─────────────────────────────────────────────────────────────
async function runSync() {
  if (!scraped.length) return;
  const btn = document.getElementById('btnSync');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⏳</span> Syncing...';

  try {
    const clean = scraped.map(v => {
      const obj = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));
      // Include photos (stored as _photos by the scraper)
      if (v._photos && v._photos.length) obj.photos = v._photos.slice(0, 10);
      return obj;
    });
    const r = await authFetch('/api/desk/inventory/sync', {
      method:  'POST',
      headers: { 'Content-Type':'application/json' },
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
    chrome.storage.local.remove('activeScan').catch(() => {}); // safe to clear — sync complete
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
        const db = document.getElementById('dealerBadge');
        if (db && result.dealerName) db.textContent = result.dealerName;
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
    bgScanActive = false;
    chrome.storage.local.remove('activeScan').catch(() => {});
    chrome.runtime.sendMessage({ type: 'CLEAR_SCAN' }).catch(() => {});
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
      const db = document.getElementById('dealerBadge');
      if (db && auth.dealerName) db.textContent = auth.dealerName;
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
      // Keep activeScan in storage until sync completes so closing popup doesn't lose results
      scraped = state.vehicles;
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
