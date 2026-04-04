// content.js — FIRST-FIN Inventory Importer v2.6
// Server-side scraping — all parsing logic on server behind auth.
'use strict';
if (window.__FIRSTFIN_LOADED) { /* already injected */ } else {
window.__FIRSTFIN_LOADED = true;

// ── Bridge relay (for platform page) ─────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.type !== 'FF_BRIDGE_FETCH') return;
  const { id, url, method, body } = event.data;
  chrome.runtime.sendMessage({ type: 'FF_BRIDGE_FETCH', url, method, body }, (resp) => {
    window.postMessage({ type: 'FF_BRIDGE_RESP', id, ...(resp || { ok: false, error: 'no response' }) }, '*');
  });
});

// ── SCRAPE handler (server-only) ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SCRAPE') return false;
  try {
    const html = document.documentElement.outerHTML;
    const url = location.href;
    if (html.length < 500) { sendResponse({ ok: false, error: 'Page too small' }); return false; }
    chrome.runtime.sendMessage({ type: 'FF_SERVER_SCRAPE', html, url }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok || !resp?.result) {
        sendResponse({ ok: false, error: 'Could not scrape — check connection and try again.' });
        return;
      }
      sendResponse({ ok: true, result: resp.result });
    });
  } catch (e) { sendResponse({ ok: false, error: e.message }); return false; }
  return true;
});

// ── FB Auto-Fill relay ───────────────────────────────────────────────────
if (location.hostname === 'app.firstfinancialcanada.com') {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'FIRSTFIN_FB_AUTOFILL') {
      chrome.runtime.sendMessage({ type: 'FB_AUTOFILL', vehicle: event.data.vehicle });
    }
  });
}

} // end guard
