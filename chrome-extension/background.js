// background.js — FIRST-FIN Inventory Importer v2.0
'use strict';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[FIRST-FIN] Extension installed/updated, reason:', reason);
});

// Keep service worker responsive — handle pings from popup during long scrapes
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
});
