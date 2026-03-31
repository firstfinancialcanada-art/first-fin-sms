// background.js — FIRST-FIN Inventory Importer v2.1
// Handles long-running multi-VDP scans so the popup can close without losing progress.
'use strict';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[FIRST-FIN] Extension installed/updated, reason:', reason);
});

// ── Scan state ────────────────────────────────────────────────────────────
let activeScan = null;

// ── Helpers ───────────────────────────────────────────────────────────────
function waitForTabLoad(tabId, timeoutMs = 14000) {
  return new Promise(resolve => {
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

    // Race condition fix — check if already loaded
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 200);
      }
    });
  });
}

function isRealVehicle(v) {
  const junk = ['for sale in', 'under $', 'house of cars', 'inventory', 'alberta', 'calgary'];
  const tl   = (v._title || '').toLowerCase();
  return !junk.some(j => tl.includes(j)) && (v.year || 0) >= 1950;
}

async function scrapeTabBg(tabId) {
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
        throw new Error('Could not scrape page');
      }
    }
  }
}

function broadcastProgress() {
  chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', state: activeScan }).catch(() => {});
}

async function persistState() {
  await chrome.storage.local.set({ activeScan }).catch(() => {});
}

// ── Main background scan ───────────────────────────────────────────────────
async function runBackgroundScan(links) {
  activeScan = {
    status:  'running',
    total:   links.length,
    current: 0,
    vehicles: [],
    log: [{ cls: 'hi', text: `Found ${links.length} vehicle pages — scanning each...` },
          { cls: 'hi', text: 'You can navigate away — scan runs in background.' }]
  };
  await persistState();
  broadcastProgress();

  let bgTab = null;
  try {
    bgTab = await chrome.tabs.create({ url: links[0], active: false });

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      activeScan.current = i + 1;
      const label = link.split('/').filter(Boolean).pop()?.slice(0, 45) || link;

      try {
        await chrome.tabs.update(bgTab.id, { url: link });
        await waitForTabLoad(bgTab.id);
        const vResp = await scrapeTabBg(bgTab.id);

        if (vResp?.result?.vehicles?.length) {
          const v = vResp.result.vehicles[0];
          if (isRealVehicle(v)) {
            activeScan.vehicles.push(v);
            activeScan.log.push({ cls: 'ok',
              text: `[${i+1}/${links.length}] ✓ ${v.year} ${v.make} ${v.model} — ${(v.mileage||0).toLocaleString()} km · $${(v.price||0).toLocaleString()}` });
          } else {
            activeScan.log.push({ cls: '',
              text: `[${i+1}/${links.length}] ⏭ ${label} (skipped)` });
          }
        } else {
          activeScan.log.push({ cls: '',
            text: `[${i+1}/${links.length}] ⏭ ${label} (no data)` });
        }
      } catch (e) {
        activeScan.log.push({ cls: 'err',
          text: `[${i+1}/${links.length}] ⚠ ${label}: ${e.message}` });
      }

      broadcastProgress();
      // Persist every 5 vehicles so reopen works even mid-scan
      if (i % 5 === 0) await persistState();
    }
  } catch (e) {
    activeScan.status = 'error';
    activeScan.errorMsg = e.message;
    activeScan.log.push({ cls: 'err', text: `❌ ${e.message}` });
  }

  if (bgTab) chrome.tabs.remove(bgTab.id).catch(() => {});
  if (activeScan.status !== 'error') activeScan.status = 'done';
  activeScan.log.push({ cls: activeScan.status === 'done' ? 'ok' : 'err',
    text: activeScan.status === 'done'
      ? `✅ ${activeScan.vehicles.length} vehicles ready to sync`
      : `Scan failed: ${activeScan.errorMsg}` });

  await persistState();
  broadcastProgress();
}

// ── Message listener ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'START_SCAN') {
    runBackgroundScan(msg.links); // fire-and-forget; progress via SCAN_PROGRESS broadcasts
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'GET_SCAN_STATE') {
    sendResponse(activeScan);
    return false;
  }

  if (msg.type === 'CLEAR_SCAN') {
    activeScan = null;
    chrome.storage.local.remove('activeScan').catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
});
