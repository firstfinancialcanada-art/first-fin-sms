// public/js/billing-gate.js — tells the user where their subscription stands
//
// The server has always refused writes from a lapsed account, but nothing
// ever said so: the 402 handler in api-client.js only had a modal for the
// spend cap, so BILLING_REQUIRED fell through and buttons just quietly did
// nothing. There was also no warning on the way there — an account went from
// working to silently broken on the day it flipped.
//
// Two surfaces, driven by GET /api/billing/status (same rules the server
// enforces, from lib/billing-state.js):
//
//   banner   shown while `warn` is set — the last week before money is due,
//            either a renewal or the end of a trial. It counts down to the
//            charge, NOT to a lockout: the point is to stop the payment
//            failing, not to soften the landing afterwards.
//   overlay  shown when the account can no longer write. Deliberately
//            dismissable to a read-only view: Franco's ask was "accessible
//            but not usable", so they can still look up a customer or read
//            their inventory. Every write still fails server-side and brings
//            the overlay straight back.
(function () {
  'use strict';

  var POLL_MS   = 10 * 60 * 1000;   // re-check every 10 minutes
  var state     = null;
  var dismissed = false;            // read-only browsing, this page load only

  function $(id) { return document.getElementById(id); }

  function money() {
    // Reason -> what the person actually needs to do about it.
    var r = (state && state.reason) || '';
    if (r === 'payment_failed') return {
      title: 'Your last payment didn’t go through',
      body:  'Update your card and everything switches straight back on — nothing has been lost.',
      cta:   'Update payment method',
      portal: true,
    };
    if (r === 'trial_expired' || r === 'trial') return {
      title: 'Your trial has ended',
      body:  'Pick a plan to keep your deal desk, inventory and Sarah running.',
      cta:   'Choose a plan',
      portal: false,
    };
    if (r === 'cancelled') return {
      title: 'Your subscription was cancelled',
      body:  'Your data is all still here. Start a plan to pick up where you left off.',
      cta:   'Reactivate',
      portal: false,
    };
    if (r === 'suspended') return {
      title: 'This account is on hold',
      body:  'Get in touch and we’ll sort it out.',
      cta:   null,
      portal: false,
    };
    return {
      title: 'A subscription is needed to make changes',
      body:  'You can still read everything here.',
      cta:   'View plans',
      portal: false,
    };
  }

  async function openBilling(usePortal) {
    try {
      if (usePortal) {
        var r = await FF.apiFetch('/api/billing/portal', { method: 'POST' });
        var d = await r.json();
        if (d && d.url) { window.location.href = d.url; return; }
      }
    } catch (e) { /* fall through to the pricing page */ }
    window.location.href = '/#pricing';
  }

  // ── Countdown banner ────────────────────────────────────────────────
  function renderBanner() {
    var el = $('ff-bill-banner');
    var show = state && state.warn && state.canWrite;
    if (!show) { if (el) el.remove(); return; }

    if (!el) {
      el = document.createElement('div');
      el.id = 'ff-bill-banner';
      document.body.appendChild(el);
    }
    var trial = state.kind === 'trial_end';
    var d = state.daysLeft;
    var when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + d + ' days';
    var msg = trial
      ? 'Your trial ends ' + when + '. Add a payment method to keep going.'
      : 'Your subscription renews ' + when + '.';
    // Only the last couple of days go red; a week out is information, not alarm.
    var urgent = d <= 2;

    el.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99998;display:flex;gap:12px;' +
      'align-items:center;justify-content:center;flex-wrap:wrap;padding:9px 16px;' +
      'font-family:Outfit,system-ui,sans-serif;font-size:13px;font-weight:600;' +
      'color:#111;background:' + (urgent ? '#fca5a5' : '#fcd34d') + ';' +
      'box-shadow:0 1px 6px rgba(0,0,0,.25);';
    el.innerHTML = '';

    var t = document.createElement('span');
    t.textContent = msg;
    el.appendChild(t);

    var b = document.createElement('button');
    b.textContent = trial ? 'Choose a plan' : 'Manage billing';
    b.style.cssText =
      'padding:5px 12px;border-radius:5px;border:0;cursor:pointer;' +
      'font-family:inherit;font-size:12px;font-weight:700;color:#fff;background:#111;';
    b.onclick = function () { openBilling(!trial); };
    el.appendChild(b);
  }

  // ── Lock overlay ────────────────────────────────────────────────────
  function renderOverlay() {
    var el = $('ff-bill-lock');
    var show = state && !state.canWrite && !dismissed;
    if (!show) { if (el) el.remove(); return; }
    if (el) return;                       // already up, don't rebuild under them

    var copy = money();
    el = document.createElement('div');
    el.id = 'ff-bill-lock';
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;padding:20px;background:rgba(6,10,20,.82);' +
      'backdrop-filter:blur(3px);font-family:Outfit,system-ui,sans-serif;';

    var card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:#12182a;border:1px solid #2b3550;' +
      'border-radius:12px;padding:26px;text-align:center;color:#e6ebf5;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.5);';

    var h = document.createElement('div');
    h.textContent = copy.title;
    h.style.cssText = 'font-size:19px;font-weight:800;margin-bottom:9px;';
    card.appendChild(h);

    var p = document.createElement('div');
    p.textContent = copy.body;
    p.style.cssText = 'font-size:13.5px;line-height:1.55;color:#9fb0cc;margin-bottom:20px;';
    card.appendChild(p);

    if (copy.cta) {
      var b = document.createElement('button');
      b.textContent = copy.cta;
      b.style.cssText =
        'width:100%;padding:11px;border-radius:7px;border:0;cursor:pointer;' +
        'font-family:inherit;font-size:14px;font-weight:700;color:#fff;' +
        'background:#1e5af6;margin-bottom:12px;';
      b.onclick = function () { openBilling(copy.portal); };
      card.appendChild(b);
    }

    var v = document.createElement('button');
    v.textContent = 'Keep looking around (read-only)';
    v.style.cssText =
      'background:none;border:0;cursor:pointer;font-family:inherit;font-size:12px;' +
      'font-weight:600;color:#7f90ad;text-decoration:underline;';
    v.onclick = function () { dismissed = true; renderOverlay(); };
    card.appendChild(v);

    el.appendChild(card);
    document.body.appendChild(el);
  }

  function render() { renderBanner(); renderOverlay(); }

  // ── Called by api-client.js when the server refuses a write ─────────
  // The poll can be up to ten minutes stale, and the moment someone is told
  // "no" is the moment to explain why.
  function lock(reason) {
    state = state || {};
    state.canWrite = false;
    state.warn     = false;
    if (reason) state.reason = reason;
    dismissed = false;
    render();
  }

  async function check() {
    if (window.DEMO_MODE) return;
    if (!window.FF || !FF.isLoggedIn || !FF.isLoggedIn()) return;
    try {
      var r = await FF.apiFetch('/api/billing/status');
      if (!r.ok) return;
      var d = await r.json();
      if (!d || d.success === false) return;
      if (d.exempt) { state = null; render(); return; }
      state = d;
      render();
    } catch (e) { /* offline or mid-refresh — try again next tick */ }
  }

  window.FFBilling = { check: check, lock: lock };

  document.addEventListener('DOMContentLoaded', function () {
    check();
    setInterval(check, POLL_MS);
  });
})();
