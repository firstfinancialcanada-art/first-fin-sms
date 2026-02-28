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
    return res;
  }

  async function _tryRefresh() {
    try {
      const res = await fetch(API_BASE + '/api/desk/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: _refreshToken })
      });
      if (!res.ok) { _logout(); return false; }
      const data = await res.json();
      _accessToken = data.accessToken;
      _refreshToken = data.refreshToken;
      sessionStorage.setItem('ff_access', _accessToken);
      sessionStorage.setItem('ff_refresh', _refreshToken);
      return true;
    } catch {
      _logout();
      return false;
    }
  }

  function _logout() {
    _accessToken = null;
    _refreshToken = null;
    _user = null;
    sessionStorage.removeItem('ff_access');
    sessionStorage.removeItem('ff_refresh');
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
    _rawSet('ffScenarios',   JSON.stringify(data.scenarios   || [null, null, null]));

    if (typeof window.settings !== 'undefined') {
      const s = data.settings || {};
      Object.assign(window.settings, {
        salesName: 'Franco Fannin', dealerName: 'Automaxx',
        docFee: 998, gst: 5, apr: 8.99, target: 30, ...s
      });
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
  function syncScenarios(val) {
    _debouncedSync('scenarios', async () => {
      try { await apiFetch('/api/desk/scenarios', { method: 'PUT', body: JSON.stringify({ scenarios: JSON.parse(val) }) }); }
      catch (e) { console.warn('⚠️ Scenarios sync failed:', e.message); }
    });
  }

  // ── LOCALSTORAGE SHIM ────────────────────────────────────
  const _origSetItem    = localStorage.setItem.bind(localStorage);
  const _origRemoveItem = localStorage.removeItem.bind(localStorage);
  function _rawSet(k, v) { _origSetItem(k, v); }

  const SYNC_MAP = {
    'ffSettings':    syncSettings,
    'ffCRM':         syncCRM,
    'ffDealLog':     syncDealLog,
    'ffLenderRates': syncLenderRates,
    'ffScenarios':   syncScenarios,
  };

  localStorage.setItem = function (key, value) {
    _origSetItem(key, value);
    if (SYNC_MAP[key] && _accessToken) SYNC_MAP[key](value);
  };
  localStorage.removeItem = function (key) {
    _origRemoveItem(key);
    if (key === 'ffLenderRates' && _accessToken)
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
      if (typeof buildLenderRateEditor === 'function') buildLenderRateEditor();
      if (typeof renderScenarios       === 'function') renderScenarios();

      console.log(`✅ UI sync complete — ${inv.length} vehicles loaded.`);
    } catch (e) {
      console.warn('⚠️ UI Sync Error:', e.message);
    }
  }

  // ── INIT ─────────────────────────────────────────────────
  async function _init() {
    if (_accessToken) {
      try {
        await loadAllData();
        _hideLogin();
        setTimeout(_triggerRenders, 300);
        console.log('✅ Cloud data loaded (resumed session)');
        return;
      } catch {
        _accessToken = null;
        sessionStorage.removeItem('ff_access');
      }
    }
    _showLogin();
  }

  // ── EXPOSE TO WINDOW ─────────────────────────────────────
  window.FF = {
    login, register, loadAllData, logout: _logout,
    get user()      { return _user; },
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
        await loadAllData();
        _hideLogin();
        setTimeout(_triggerRenders, 300);
        console.log('✅ Cloud data loaded');
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
        await loadAllData();
        _hideLogin();
        setTimeout(_triggerRenders, 300);
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
