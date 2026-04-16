// ============================================================
// public/js/api-client.js — FIRST-FIN Cloud Sync Client
// ============================================================

(function () {
  'use strict';

  const API_BASE = '';
  let _accessToken = sessionStorage.getItem('ff_access') || null;
  let _refreshToken = sessionStorage.getItem('ff_refresh') || null;
  let _user = null;
  let _syncTimers = {};

  // If the login overlay is visible on load, session is stale — clear it
  document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('ff-login-overlay');
    if (overlay && overlay.style.display !== 'none') {
      sessionStorage.removeItem('ff_access');
      sessionStorage.removeItem('ff_refresh');
      _accessToken = null;
      _refreshToken = null;
    }
  });

  // ── Spend-cap / capacity modal (shown on HTTP 402) ──────────────
  let _capModalShownAt = 0;
  function _showCapModal(payload) {
    if (Date.now() - _capModalShownAt < 3000) return;  // debounce
    _capModalShownAt = Date.now();

    const isSpend = payload.code === 'SPEND_CAP_EXCEEDED';
    const usage   = payload.usage || {};
    const totalDollars = ((usage.totalSpendCents || 0) / 100).toFixed(2);
    const capDollars   = ((usage.capCents || 0) / 100).toFixed(2);
    const needDollars  = ((payload.needCents || 0) / 100).toFixed(2);

    let title, body, cta;
    if (isSpend) {
      title = 'Monthly Twilio cap reached';
      body  = `Your plan covers $${capDollars}/mo in SMS + voice. You've used $${totalDollars}. ` +
              `This send needs about $${needDollars} more — top up overage to continue, or wait for the monthly reset.`;
      cta   = 'Contact us to top up';
    } else if (payload.code === 'CAPACITY_EXCEEDED') {
      const kind = payload.kind === 'inventory' ? 'vehicles' : 'CRM contacts';
      title = kind.charAt(0).toUpperCase() + kind.slice(1) + ' limit reached';
      body  = `You've hit the ${payload.cap} ${kind} limit on your current plan (${payload.count} used). ` +
              `Remove some to free space, or contact us to upgrade.`;
      cta   = 'Contact us to upgrade';
    } else {
      return;
    }

    let overlay = document.getElementById('ff-cap-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ff-cap-modal';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif;';
      const card = document.createElement('div');
      card.style.cssText = 'background:#fff;border-radius:12px;max-width:440px;width:100%;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,0.3);';
      const h = document.createElement('div'); h.id = 'ff-cap-title';
      h.style.cssText = 'font-size:20px;font-weight:700;margin-bottom:12px;color:#111;';
      const b = document.createElement('div'); b.id = 'ff-cap-body';
      b.style.cssText = 'font-size:14px;line-height:1.5;color:#444;margin-bottom:20px;';
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
      const close = document.createElement('button');
      close.textContent = 'Close';
      close.style.cssText = 'padding:10px 18px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;font-weight:600;';
      close.onclick = () => overlay.remove();
      const ctaBtn = document.createElement('a'); ctaBtn.id = 'ff-cap-cta';
      ctaBtn.href = 'mailto:support@firstfinancialcanada.com';
      ctaBtn.style.cssText = 'padding:10px 18px;background:#f59e0b;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;';
      bar.appendChild(close); bar.appendChild(ctaBtn);
      card.appendChild(h); card.appendChild(b); card.appendChild(bar);
      overlay.appendChild(card);
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
      document.body.appendChild(overlay);
    }
    document.getElementById('ff-cap-title').textContent = title;
    document.getElementById('ff-cap-body').textContent  = body;
    document.getElementById('ff-cap-cta').textContent   = cta;
  }

  // ── FETCH WITH AUTH ─────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (_accessToken) headers['Authorization'] = 'Bearer ' + _accessToken;
    let res = await fetch(API_BASE + path, { ...opts, headers });
    if (res.status === 401 && _refreshToken) {
      const refreshed = await _tryRefresh();
      if (refreshed) {
        headers['Authorization'] = 'Bearer ' + _accessToken;
        res = await fetch(API_BASE + path, { ...opts, headers });
      }
    }
    if (res.status === 402) {
      try {
        const cloned = res.clone();
        const data   = await cloned.json();
        if (data && (data.code === 'SPEND_CAP_EXCEEDED' || data.code === 'CAPACITY_EXCEEDED')) {
          _showCapModal(data);
        }
      } catch {}
    }
    return res;
  }

  let _isRefreshing = false;
  let _refreshQueue  = [];

  async function _tryRefresh() {
    // If a refresh is already in flight, queue this caller and wait
    if (_isRefreshing) {
      return new Promise(resolve => _refreshQueue.push(resolve));
    }
    _isRefreshing = true;
    try {
      const res = await fetch(API_BASE + '/api/desk/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: _refreshToken })
      });
      if (!res.ok) { _logout(); _refreshQueue.forEach(r => r(false)); _refreshQueue = []; return false; }
      const data = await res.json();
      _accessToken = data.accessToken;
      _refreshToken = data.refreshToken;
      sessionStorage.setItem('ff_access', _accessToken);
      sessionStorage.setItem('ff_refresh', _refreshToken);
      _refreshQueue.forEach(r => r(true));
      _refreshQueue = [];
      return true;
    } catch {
      _logout();
      _refreshQueue.forEach(r => r(false));
      _refreshQueue = [];
      return false;
    } finally {
      _isRefreshing = false;
    }
  }

  function _logout() {
    _accessToken = null;
    _refreshToken = null;
    _user = null;
    sessionStorage.removeItem('ff_access');
    sessionStorage.removeItem('ff_refresh');
    // Clear ALL unscoped localStorage keys — previous user's branding/data must not
    // bleed into the next login session or into demo mode.
    ['ffSettings','ffCRM','ffDealLog','ffInventory','ffLenderRates','ffScenarios','ffCurrentDeal']
      .forEach(k => _origRemoveItem(k));
    // Reset settings object IN-PLACE so the `settings` alias in platform-main.js picks it up.
    // Replacing window.settings with a new object would orphan the alias.
    if (window.settings) {
      Object.assign(window.settings, {salesName:'',dealerName:'',docFee:998,gst:5,apr:8.99,target:30,logoUrl:''});
      if (typeof updateHeaderDealer === 'function') updateHeaderDealer();
    }
    _showLogin();
  }

  // ── LOGIN / REGISTER ───────────────────────────────────
  async function login(email, password) {
    const res = await fetch(API_BASE + '/api/desk/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Login failed');
    _accessToken = data.accessToken;
    _refreshToken = data.refreshToken;
    _user = data.user;
    if (data.billing) sessionStorage.setItem('ff_billing', JSON.stringify(data.billing));
    sessionStorage.setItem('ff_access', _accessToken);
    sessionStorage.setItem('ff_refresh', _refreshToken);
    return data;
  }

  async function register(email, password, name) {
    const res = await fetch(API_BASE + '/api/desk/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Registration failed');
    _accessToken = data.accessToken;
    _refreshToken = data.refreshToken;
    _user = data.user;
    if (data.billing) sessionStorage.setItem('ff_billing', JSON.stringify(data.billing));
    sessionStorage.setItem('ff_access', _accessToken);
    sessionStorage.setItem('ff_refresh', _refreshToken);
    return data;
  }

  // ── LOAD ALL DATA FROM API ─────────────────────────────
  async function loadAllData() {
    const res = await apiFetch('/api/desk/load-all');
    if (!res.ok) throw new Error('Failed to load data');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Load failed');

    // ── INVENTORY — single clean block, no conflicts ─────
    if (Array.isArray(data.inventory)) {
      // Always set ffInventory as fresh reference
      window.ffInventory = data.inventory;

      // If UI pre-declared window.inventory as reactive array, mutate in-place
      // Otherwise just assign it
      if (Array.isArray(window.inventory)) {
        window.inventory.length = 0;
        data.inventory.forEach(v => window.inventory.push(v));
      } else {
        window.inventory = [...data.inventory];
      }

      _rawSet('ffInventory', JSON.stringify(data.inventory));
      console.log(`📦 Loaded ${data.inventory.length} vehicles from desk_inventory.`);
    }

    // ── ALL OTHER DATA ───────────────────────────────────
    _rawSet('ffSettings',    JSON.stringify(data.settings    || {}));
    _rawSet('ffCRM',         JSON.stringify(data.crm         || []));
    _rawSet('ffDealLog',     JSON.stringify(data.dealLog     || []));
    _rawSet('ffLenderRates', JSON.stringify(data.lenderRates || {}));
    _origSetItem('ffLenderRates', JSON.stringify(data.lenderRates || {}));
    _rawSet('ffScenarios',   JSON.stringify(data.scenarios   || [null, null, null]));
    if (data.currentDeal) {
      _rawSet('ffCurrentDeal', JSON.stringify(data.currentDeal));
    }

    if (typeof window.settings !== 'undefined') {
      const s = data.settings || {};
      Object.assign(window.settings, {
        salesName: '', dealerName: '', docFee: 998, gst: 5, apr: 8.99, target: 30,
        ...s
      });
      // Expose tenant branding for deterministic header rendering
      if (_user) {
        _user.tenantBranding = {
          dealerName: window.settings.dealerName || '',
          logoUrl:    window.settings.logoUrl    || ''
        };
        if (data.user && data.user.features) _user.features = data.user.features;
      }
      // Apply immediately to deal desk fields
      if (typeof setVal === 'function') {
        setVal('docFee',  window.settings.docFee);
        setVal('gstRate', window.settings.gst);
        setVal('apr',     window.settings.apr);
      }
      if (typeof updateHeaderDealer === 'function') updateHeaderDealer();
    }
    if (typeof window.crmData !== 'undefined') {
      window.crmData.length = 0;
      (data.crm || []).forEach(c => window.crmData.push(c));
    }
    if (typeof window.dealLog !== 'undefined') {
      window.dealLog.length = 0;
      (data.dealLog || []).forEach(d => window.dealLog.push(d));
    }
    if (typeof window.scenarios !== 'undefined') {
      const sc = data.scenarios || [null, null, null];
      window.scenarios[0] = sc[0];
      window.scenarios[1] = sc[1];
      window.scenarios[2] = sc[2];
    }

    return data;
  }

  // ── SYNC FUNCTIONS ───────────────────────────────────────
  function _debouncedSync(key, fn, delay) {
    if (_syncTimers[key]) clearTimeout(_syncTimers[key]);
    _syncTimers[key] = setTimeout(fn, delay || 1500);
  }
  function syncSettings(val) {
    _debouncedSync('settings', async () => {
      try { await apiFetch('/api/desk/settings', { method: 'PUT', body: JSON.stringify({ settings: JSON.parse(val) }) }); }
      catch (e) { console.warn('⚠️ Settings sync failed:', e.message); }
    });
  }
  function syncCRM(val) {
    _debouncedSync('crm', async () => {
      try { await apiFetch('/api/desk/crm/bulk', { method: 'PUT', body: JSON.stringify({ crm: JSON.parse(val) }) }); }
      catch (e) { console.warn('⚠️ CRM sync failed:', e.message); }
    });
  }
  function syncDealLog(val) {
    _debouncedSync('dealLog', async () => {
      try { await apiFetch('/api/desk/deal-log/bulk', { method: 'PUT', body: JSON.stringify({ dealLog: JSON.parse(val) }) }); }
      catch (e) { console.warn('⚠️ DealLog sync failed:', e.message); }
    });
  }
  function syncLenderRates(val) {
    _debouncedSync('lenders', async () => {
      try { await apiFetch('/api/desk/lender-rates', { method: 'PUT', body: JSON.stringify({ overrides: JSON.parse(val) }) }); }
      catch (e) { console.warn('⚠️ Lender sync failed:', e.message); }
    });
  }
  function syncCurrentDeal(val) {
    _debouncedSync('currentDeal', async () => {
      try { await apiFetch('/api/desk/current-deal', { method: 'PUT', body: JSON.stringify({ deal: JSON.parse(val) }) }); }
      catch (e) { console.warn('⚠️ CurrentDeal sync failed:', e.message); }
    });
  }
  function syncScenarios(val) {
    _debouncedSync('scenarios', async () => {
      try { await apiFetch('/api/desk/scenarios', { method: 'PUT', body: JSON.stringify({ scenarios: JSON.parse(val) }) }); }
      catch (e) { console.warn('⚠️ Scenarios sync failed:', e.message); }
    });
  }

  // ── LOCALSTORAGE SHIM ────────────────────────────────────
  const _origSetItem    = localStorage.setItem.bind(localStorage);
  const _origRemoveItem = localStorage.removeItem.bind(localStorage);

  function scopeKey(k) {
    const scope = (_user && _user.email) ? _user.email.toLowerCase() : 'anon';
    return `${scope}::${k}`;
  }

  // Write ONLY to the scoped key — never pollute the shared unscoped key.
  // platform-main.js no longer reads from unscoped ffSettings at startup.
  function _rawSet(k, v) { _origSetItem(scopeKey(k), v); }

  const SYNC_MAP = {
    'ffSettings':     syncSettings,
    'ffCRM':          syncCRM,
    'ffDealLog':      syncDealLog,
    'ffLenderRates':  syncLenderRates,
    'ffScenarios':    syncScenarios,
    'ffCurrentDeal':  syncCurrentDeal,
  };

  localStorage.setItem = function (key, value) {
    _origSetItem(key, value);
    if (SYNC_MAP[key] && _accessToken && !window.DEMO_MODE) SYNC_MAP[key](value);
  };
  localStorage.removeItem = function (key) {
    _origRemoveItem(key);
    if (key === 'ffLenderRates' && _accessToken && !window.DEMO_MODE)
      apiFetch('/api/desk/lender-rates', { method: 'DELETE' }).catch(() => {});
  };

  // ── LOGIN UI ─────────────────────────────────────────────
  function _showLogin() {
    const el = document.getElementById('ff-login-overlay');
    if (el) el.style.display = 'flex';
  }
  function _hideLogin() {
    const el = document.getElementById('ff-login-overlay');
    if (el) el.style.display = 'none';
    // Always kill demo mode on a real login
    window.DEMO_MODE = false;
    const banner = document.getElementById('demo-banner');
    if (banner) banner.style.display = 'none';
    // Kill watermark if it was showing from a demo session
    const wm = document.getElementById('demo-watermark');
    if (wm) wm.style.display = 'none';
    // Strip ?demo=1 from URL so next page load doesn't re-trigger demo mode
    if (new URLSearchParams(location.search).get('demo') === '1') {
      const clean = location.pathname;
      window.history.replaceState({}, document.title, clean);
    }
  }
  function _showLoginError(msg) {
    const el = document.getElementById('ff-login-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function _clearLoginError() {
    const el = document.getElementById('ff-login-error');
    if (el) el.style.display = 'none';
  }

  // ── POST-LOGIN RENDER ────────────────────────────────────
  function _triggerRenders() {
    try {
      // Check billing status and show banner / enforce readonly
      if (typeof checkBillingBanner === 'function') {
        try { checkBillingBanner(getBilling()); } catch(e) {}
      }
      // Apply feature gating to nav tabs (run now + delayed to override any late UI resets)
      if (typeof applyFeatureGating === 'function') {
        const _feats = _user ? (_user.features || {}) : {};
        try { applyFeatureGating(_feats); } catch(e) {}
        setTimeout(() => { try { applyFeatureGating(_feats); } catch(e) {} }, 500);
        setTimeout(() => { try { applyFeatureGating(_feats); } catch(e) {} }, 2000);
      }
      console.log('🔄 Syncing UI with PostgreSQL data...');
      const inv = window.ffInventory || window.inventory || [];

      // 1. Master inventory table
      if (typeof renderInventory === 'function' && inv.length) {
        renderInventory(inv);
      }

      // 2. Stock # dropdown — populate options (leave native onchange="loadVehicleFromStock()" intact)
      const stockDropdown   = document.getElementById('stockNum');
      const compareDropdown = document.getElementById('compareStock');

      if (stockDropdown && inv.length) {
        stockDropdown.innerHTML = '<option value="">— Select Stock # —</option>';
        inv.forEach(car => {
          stockDropdown.add(new Option(
            `${car.stock} — ${car.year} ${car.make} ${car.model} ($${Number(car.price||0).toLocaleString()})`,
            car.stock
          ));
        });
        // DO NOT override stockDropdown.onchange — the HTML already has
        // onchange="loadVehicleFromStock()" which calls sendToDeal(stock)
        // and that function correctly sets all Deal Desk fields.
      }

      if (compareDropdown && inv.length) {
        compareDropdown.innerHTML = '<option value="">— Choose a vehicle —</option>';
        inv.forEach(car => {
          compareDropdown.add(new Option(
            `${car.stock} — ${car.year} ${car.make} ${car.model} ($${Number(car.price||0).toLocaleString()})`, car.stock
          ));
        });
      }

      // 3. Lender "Vehicle Approval Checker" dropdowns (chk-stock-${lid})
      //    initLenderPanels() builds these at page load when inventory was empty.
      //    Now repopulate every lender's checker dropdown with cloud data.
      if (typeof lenders === 'object' && inv.length) {
        Object.keys(lenders).forEach(lid => {
          const sel = document.getElementById('chk-stock-' + lid);
          if (!sel) return;
          sel.innerHTML = '<option value="">— Select a vehicle —</option>';
          inv.forEach(v => {
            const price = Number(v.price || 0).toLocaleString();
            sel.add(new Option(
              `${v.stock} — ${v.year} ${v.make} ${v.model} ($${price})`, v.stock
            ));
          });
        });
        console.log(`🏦 Populated ${Object.keys(lenders).length} lender checker dropdowns`);
      }

      // 3. Call initInventory if it exists (for any extra setup it does)
      if (typeof initInventory === 'function') initInventory();

      // 4. Other modules
      if (typeof renderCRM             === 'function') renderCRM();
      if (typeof refreshAllAnalytics   === 'function') refreshAllAnalytics();
      if (typeof applyLenderRateOverrides === 'function') applyLenderRateOverrides();
      if (typeof loadTenantRates       === 'function') loadTenantRates().then(() => {
        if (typeof buildLenderRateEditor === 'function') buildLenderRateEditor();
      });
      if (typeof renderScenarios       === 'function') renderScenarios();

      // 5. Restore active deal if one was saved
      if (typeof loadDeal === 'function' && localStorage.getItem('ffCurrentDeal')) {
        loadDeal();
        console.log('📋 Active deal restored from cloud');
      }

      // 6. Update header with dealer name from settings
      if (typeof updateHeaderDealer === 'function') updateHeaderDealer();

      console.log(`✅ UI sync complete — ${inv.length} vehicles loaded.`);

      // Fire onboarding wizard check — runs after server settings are fully
      // loaded into window.settings, so twilioNumber reflects actual DB value
      if (typeof wizCheckAndShow === 'function') wizCheckAndShow();

      // Navigate to URL hash section (e.g. #fbposter from extension "Go to FB Poster" button)
      const hashTarget = location.hash.replace('#', '').toLowerCase();
      if (hashTarget && typeof showSection === 'function') {
        const validSections = ['deal','inventory','crm','analytics','compare','settings','fbposter','dtsync','sarah'];
        if (validSections.includes(hashTarget)) {
          const btn = document.getElementById('nav-' + hashTarget);
          setTimeout(() => showSection(hashTarget, btn || null), 100);
        }
      }
    } catch (e) {
      console.warn('⚠️ UI Sync Error:', e.message);
    }
  }

  // ── INIT ─────────────────────────────────────────────────
  async function _init() {
    // When arriving via ?demo=1, skip auto-login entirely.
    // Without this, _triggerRenders fires ~300ms after loadAllData()
    // and overwrites the demo data that startDemo() just loaded.
    if (new URLSearchParams(location.search).get('demo') === '1') {
      sessionStorage.removeItem('ff_access');
      sessionStorage.removeItem('ff_refresh');
      _accessToken = null;
      _refreshToken = null;
      _showLogin();
      return;
    }
    if (_accessToken) {
      _hideLogin(); // always let user in if token exists
      try {
        await loadAllData();
        setTimeout(_triggerRenders, 300);
        console.log('✅ Cloud data loaded (resumed session)');
      } catch (e) {
        console.warn('⚠️ Session data load failed:', e.message);
        setTimeout(_triggerRenders, 300);
        setTimeout(() => {
          if (typeof toast === 'function')
            toast('⚠️ Connection issue — some data may not be current. Refresh to retry.');
        }, 500);
      }
      return;
    }
    _showLogin();
  }

  // ── EXPOSE TO WINDOW ─────────────────────────────────────
  function getBilling() {
    try { return JSON.parse(sessionStorage.getItem('ff_billing') || 'null'); } catch(e) { return null; }
  }

  window.FF = {
    login, register, loadAllData, logout: _logout,
    get user()      { return _user; },
    getBilling,
    get isLoggedIn() { return !!_accessToken; },
    apiFetch,

    async handleLogin(e) {
      e.preventDefault();
      _clearLoginError();
      const email    = document.getElementById('ff-login-email').value.trim();
      const password = document.getElementById('ff-login-password').value;
      const btn      = document.getElementById('ff-login-btn');
      if (!email || !password) return _showLoginError('Enter email and password');
      btn.disabled = true; btn.textContent = 'Signing in...';
      try {
        await login(email, password);
        _hideLogin(); // hide login first — never block on data load
        try {
          await loadAllData();
          setTimeout(_triggerRenders, 300);
          console.log('✅ Cloud data loaded');
        } catch (dataErr) {
          console.warn('⚠️ Data load failed but login succeeded:', dataErr.message);
          setTimeout(_triggerRenders, 300);
        }
      } catch (err) {
        _showLoginError(err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Sign In';
      }
    },

    async handleRegister(e) {
      e.preventDefault();
      _clearLoginError();
      const name     = document.getElementById('ff-reg-name').value.trim();
      const email    = document.getElementById('ff-reg-email').value.trim();
      const password = document.getElementById('ff-reg-password').value;
      const btn      = document.getElementById('ff-reg-btn');
      if (!name || !email || !password) return _showLoginError('All fields required');
      if (password.length < 6) return _showLoginError('Password must be 6+ characters');
      btn.disabled = true; btn.textContent = 'Creating account...';
      try {
        await register(email, password, name);
        _hideLogin();

        // Snapshot existing localStorage data BEFORE loadAllData overwrites it
        const existingInventory  = JSON.parse(localStorage.getItem('ffInventory')  || 'null');
        const existingCRM        = JSON.parse(localStorage.getItem('ffCRM')        || 'null');
        const existingDealLog    = JSON.parse(localStorage.getItem('ffDealLog')    || 'null');
        const existingSettings   = JSON.parse(localStorage.getItem('ffSettings')   || 'null');
        const existingLenders    = JSON.parse(localStorage.getItem('ffLenderRates')|| 'null');
        const existingScenarios  = JSON.parse(localStorage.getItem('ffScenarios')  || 'null');
        const existingCurrentDeal= JSON.parse(localStorage.getItem('ffCurrentDeal')|| 'null');

        try {
          await loadAllData();
          setTimeout(_triggerRenders, 300);
        } catch (dataErr) {
          console.warn('⚠️ Data load failed after register:', dataErr.message);
          setTimeout(_triggerRenders, 300);
        }

        // If Postgres came back empty, push existing localStorage data up
        const hasLocal = existingInventory?.length || existingCRM?.length || existingDealLog?.length;
        if (hasLocal) {
          console.log('📤 Migrating existing local data to Postgres...');
          try {
            if (existingInventory?.length)
              await apiFetch('/api/desk/inventory/bulk', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ vehicles: existingInventory }) });
            if (existingCRM?.length)
              await apiFetch('/api/desk/crm/bulk',       { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ crm: existingCRM }) });
            if (existingDealLog?.length)
              await apiFetch('/api/desk/deal-log/bulk',  { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dealLog: existingDealLog }) });
            if (existingSettings)
              await apiFetch('/api/desk/settings',       { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ settings: existingSettings }) });
            if (existingLenders)
              await apiFetch('/api/desk/lender-rates',   { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ overrides: existingLenders }) });
            if (existingScenarios)
              await apiFetch('/api/desk/scenarios',      { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ scenarios: existingScenarios }) });
            if (existingCurrentDeal)
              await apiFetch('/api/desk/current-deal',   { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ deal: existingCurrentDeal }) });
            console.log('✅ Local data migrated to Postgres successfully');
            if (typeof toast === 'function') toast('✅ Account created — your data has been saved to the cloud!');
          } catch (migErr) {
            console.warn('⚠️ Migration partially failed:', migErr.message);
          }
        } else {
          if (typeof toast === 'function') toast('✅ Account created!');
        }

        console.log('✅ Account created + cloud data loaded');
      } catch (err) {
        _showLoginError(err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Create Account';
      }
    },

    toggleAuthMode() {
      const loginForm = document.getElementById('ff-login-form');
      const regForm   = document.getElementById('ff-reg-form');
      const isLogin   = loginForm.style.display !== 'none';
      loginForm.style.display = isLogin ? 'none'  : 'block';
      regForm.style.display   = isLogin ? 'block' : 'none';
      _clearLoginError();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
