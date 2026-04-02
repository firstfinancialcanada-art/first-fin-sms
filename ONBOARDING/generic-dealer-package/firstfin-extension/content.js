// content.js — FIRST-FIN Inventory Importer v3.0 (Thin Shell)
// Captures page HTML and handles pagination clicks. All parsing logic is server-side.
'use strict';
if (window.__FIRSTFIN_LOADED) { /* already injected — skip duplicate */ } else {
window.__FIRSTFIN_LOADED = true;

// ── Bridge relay (for platform page — bypasses Chrome PNA restrictions) ───
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.type !== 'FF_BRIDGE_FETCH') return;
  const { id, url, method, body } = event.data;
  chrome.runtime.sendMessage({ type: 'FF_BRIDGE_FETCH', url, method, body }, (resp) => {
    window.postMessage({ type: 'FF_BRIDGE_RESP', id, ...(resp || { ok: false, error: 'no response' }) }, '*');
  });
});

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Capture page HTML — server does all parsing
  if (msg.type === 'CAPTURE_HTML') {
    sendResponse({ html: document.documentElement.outerHTML, url: location.href });
    return false;
  }

  // Legacy SCRAPE — redirect to CAPTURE_HTML for backward compat during transition
  if (msg.type === 'SCRAPE') {
    sendResponse({ html: document.documentElement.outerHTML, url: location.href, legacy: true });
    return false;
  }

  // Click pagination elements (must happen in real DOM — can't do server-side)
  if (msg.type === 'CLICK_PAGINATION') {
    const { strategy, page } = msg;

    // Vehica Vue pagination
    if (strategy === 'vehica') {
      const pageDiv = [...document.querySelectorAll('.vehica-pagination__page')].find(d => d.textContent.trim() === String(page));
      if (pageDiv) { pageDiv.click(); }
      else {
        const arrow = document.querySelector('.vehica-pagination__arrow--right');
        if (arrow) arrow.click();
      }
      sendResponse({ ok: true });
      return false;
    }

    // D2C pagination (button click — triggers page navigation)
    if (strategy === 'd2c') {
      const nextBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Next') ||
        [...document.querySelectorAll('.divPaginationBox:not(.selected) button')][0];
      if (nextBtn) nextBtn.click();
      sendResponse({ ok: true });
      return false;
    }

    // Algolia "Load more" infinite scroll
    if (strategy === 'algolia') {
      const btn = document.querySelector('.ais-InfiniteHits-loadMore:not([disabled]), [class*="load-more"]:not([disabled]), [class*="loadmore"]:not([disabled])');
      if (btn && !btn.disabled) { btn.click(); sendResponse({ ok: true }); }
      else { sendResponse({ ok: false, done: true }); }
      return false;
    }

    sendResponse({ ok: false, error: 'Unknown pagination strategy' });
    return false;
  }

  return false;
});

// ── FB Auto-Fill relay (only on the FIRST-FIN platform) ──────────────────
if (location.hostname === 'app.firstfinancialcanada.com') {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'FIRSTFIN_FB_AUTOFILL') {
      chrome.runtime.sendMessage({
        type: 'FB_AUTOFILL',
        vehicle: event.data.vehicle
      });
    }
  });
}

} // end __FIRSTFIN_LOADED guard
