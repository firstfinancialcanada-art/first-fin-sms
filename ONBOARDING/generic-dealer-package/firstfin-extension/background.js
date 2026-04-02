// background.js — FIRST-FIN Inventory Importer v3.0
// Handles long-running multi-VDP scans. All parsing is server-side.
'use strict';

const API = 'https://app.firstfinancialcanada.com';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[FIRST-FIN] Extension installed/updated, reason:', reason);
  chrome.storage.local.remove('activeScan').catch(() => {});
});

// ── Scan state ────────────────────────────────────────────────────────────
let activeScan = null;

// ── Helpers ───────────────────────────────────────────────────────────────
function waitForTabLoad(tabId, timeoutMs = 14000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs);
    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 200);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 200);
      }
    }).catch(() => { clearTimeout(timer); resolve(); });
  });
}

function isRealVehicle(v) {
  const junk = ['for sale in', 'under $', 'house of cars', 'inventory'];
  const tl = (v._title || '').toLowerCase();
  return !junk.some(j => tl.includes(j)) && (v.year || 0) >= 1950;
}

// ── Get auth token from storage ──────────────────────────────────────────
async function getAuthToken() {
  const data = await chrome.storage.local.get(['token']);
  return data.token || null;
}

// ── Capture HTML from a tab ──────────────────────────────────────────────
async function captureTabHtml(tabId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_HTML' });
      if (result?.html) return result;
    } catch (e) {
      if (attempt === 0) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 400));
        } catch (_) {}
      }
    }
  }
  // Fallback: inject script directly to capture HTML
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ html: document.documentElement.outerHTML, url: location.href })
  });
  return results?.[0]?.result || null;
}

// ── Send HTML to server for parsing ──────────────────────────────────────
async function serverScrape(html, url) {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated');
  const resp = await fetch(`${API}/api/desk/scrape-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ html, url })
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Server scrape failed');
  return data;
}

async function serverScrapeVdp(html, url) {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated');
  const resp = await fetch(`${API}/api/desk/scrape-vdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ html, url })
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Server VDP parse failed');
  return data;
}

// ── Scrape a tab via server (replaces old scrapeTabBg) ───────────────────
async function scrapeTabBg(tabId) {
  const capture = await captureTabHtml(tabId);
  if (!capture?.html) throw new Error('Could not capture page HTML');
  return await serverScrapeVdp(capture.html, capture.url);
}

function broadcastProgress() {
  chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', state: activeScan }).catch(() => {});
}

async function persistState() {
  await chrome.storage.local.set({ activeScan }).catch(() => {});
}

// ── Collect VDP links from a pagination page ─────────────────────────────
async function collectVdpLinksFromPage(tabId, pageUrl) {
  try {
    await chrome.tabs.update(tabId, { url: pageUrl });
    await waitForTabLoad(tabId);
    await new Promise(r => setTimeout(r, 3000));

    // Capture HTML and send to server for link extraction
    const capture = await captureTabHtml(tabId);
    if (capture?.html) {
      try {
        const data = await serverScrape(capture.html, capture.url);
        if (data.result?.type === 'listing' && data.result.links?.length) {
          return data.result.links;
        }
      } catch (_) {}
    }

    // Fallback: retry with more wait time for AJAX content
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      const capture2 = await captureTabHtml(tabId);
      if (capture2?.html) {
        try {
          const data = await serverScrape(capture2.html, capture2.url);
          if (data.result?.type === 'listing' && data.result.links?.length) {
            return data.result.links;
          }
        } catch (_) {}
      }
    }
    return [];
  } catch { return []; }
}

// ── Main background scan ─────────────────────────────────────────────────
async function runBackgroundScan(links, pageLinks = []) {
  activeScan = {
    status: 'running', total: links.length, current: 0, vehicles: [],
    log: [
      { cls: 'hi', text: `Found ${links.length} vehicles on page 1${pageLinks.length ? ` + ${pageLinks.length} more pages to collect` : ''} — starting scan...` },
      { cls: 'hi', text: 'You can navigate away — scan runs in background.' }
    ]
  };
  await persistState();
  broadcastProgress();

  let bgTab = null;
  try {
    bgTab = await chrome.tabs.create({ url: links[0], active: false });

    // Collect VDP links from additional pages
    if (pageLinks.length > 0) {
      const allLinks = [...links];
      const seenLinks = new Set(links);
      for (let pi = 0; pi < pageLinks.length; pi++) {
        activeScan.log.push({ cls: 'hi', text: `Collecting page ${pi + 2} of ${pageLinks.length + 1}...` });
        broadcastProgress();
        const moreLinks = await collectVdpLinksFromPage(bgTab.id, pageLinks[pi]);
        let added = 0;
        for (const l of moreLinks) {
          if (!seenLinks.has(l)) { seenLinks.add(l); allLinks.push(l); added++; }
        }
        activeScan.log.push({ cls: 'ok', text: `  Page ${pi + 2}: found ${added} more vehicles` });
        broadcastProgress();
      }
      links = allLinks;
      activeScan.total = links.length;
      activeScan.log.push({ cls: 'hi', text: `Total: ${links.length} vehicles across all pages — scanning each...` });
      broadcastProgress();
      await persistState();
    }

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      activeScan.current = i + 1;
      const label = link.split('/').filter(Boolean).pop()?.slice(0, 45) || link;

      try {
        await chrome.tabs.update(bgTab.id, { url: link });
        await waitForTabLoad(bgTab.id);
        await new Promise(r => setTimeout(r, 1500));

        const vResp = await scrapeTabBg(bgTab.id);

        if (vResp?.result?.vehicles?.length) {
          const v = vResp.result.vehicles[0];
          if (isRealVehicle(v)) {
            activeScan.vehicles.push(v);
            const photoCount = v._photos?.length || 0;
            activeScan.log.push({ cls: 'ok',
              text: `[${i+1}/${links.length}] ✓ ${v.year} ${v.make} ${v.model} — ${(v.mileage||0).toLocaleString()} km · $${(v.price||0).toLocaleString()} · 📷${photoCount}` });
          } else {
            activeScan.log.push({ cls: '', text: `[${i+1}/${links.length}] ⏭ ${label} (skipped)` });
          }
        } else {
          activeScan.log.push({ cls: '', text: `[${i+1}/${links.length}] ⏭ ${label} (no data)` });
        }
      } catch (e) {
        activeScan.log.push({ cls: 'err', text: `[${i+1}/${links.length}] ⚠ ${label}: ${e.message}` });
      }

      broadcastProgress();
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

// ── Message listener ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') { sendResponse({ ok: true }); return false; }

  if (msg.type === 'FF_BRIDGE_FETCH') {
    const opts = { method: msg.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (msg.body) opts.body = JSON.stringify(msg.body);
    fetch(msg.url, opts)
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'START_SCAN') {
    runBackgroundScan(msg.links, msg.pageLinks || []);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'GET_SCAN_STATE') {
    sendResponse(activeScan);
    return false;
  }

  // Store auth token for background use
  if (msg.type === 'STORE_AUTH') {
    chrome.storage.local.set({ authToken: msg.token }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // FB Autofill relay
  if (msg.type === 'FB_AUTOFILL') {
    handleFbAutofill(msg.vehicle);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ── FB Autofill handler ──────────────────────────────────────────────────
async function handleFbAutofill(vehicle) {
  if (!vehicle) return;
  const [tab] = await chrome.tabs.query({ url: 'https://www.facebook.com/*', active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fb-autofill.js'] });
    await new Promise(r => setTimeout(r, 300));
    await chrome.tabs.sendMessage(tab.id, { type: 'FF_FB_FILL', vehicle });
  } catch (e) {
    console.error('[FIRST-FIN] FB autofill error:', e.message);
  }
}
