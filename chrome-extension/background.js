// background.js — FIRST-FIN Inventory Importer v2.1
// Handles long-running multi-VDP scans so the popup can close without losing progress.
'use strict';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[FIRST-FIN] Extension installed/updated, reason:', reason);
  // Clear stale scan data on install/update/reload
  chrome.storage.local.remove('activeScan').catch(() => {});
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
  const junk = ['for sale in', 'under $', 'house of cars', 'inventory'];
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

// ── Collect VDP links from a pagination page ───────────────────────────────
async function collectVdpLinksFromPage(tabId, pageUrl) {
  try {
    await chrome.tabs.update(tabId, { url: pageUrl });
    await waitForTabLoad(tabId);
    // Extra wait for Vue/AJAX-rendered pages (Vehica, etc.) to load content
    await new Promise(r => setTimeout(r, 3000));
    const resp = await scrapeTabBg(tabId);
    if (resp?.result?.type === 'listing' && resp.result.links?.length) {
      return resp.result.links;
    }
    // Fallback: inject and grab links directly, with retry for AJAX content
    for (let attempt = 0; attempt < 3; attempt++) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const seen = new Set(); const out = [];
          // D2C-specific: links with -idNNN.html (most reliable for D2C pages)
          const d2cRe = /-id\d+\.html/i;
          const vdpRe = /\/(inventory\/(Used|New)-|vehicle-details\/|vehicle\/|vehicles\/|demos\/|used\/|new\/inventory\/)\d{4}[-\/]/i;
          document.querySelectorAll('a[href]').forEach(a => {
            if (!seen.has(a.href) && (d2cRe.test(a.href) || vdpRe.test(a.href))) {
              // For D2C: skip category pages (no -id suffix)
              if (/(demos|used|new\/inventory)\/\d{4}-/i.test(a.href) && !d2cRe.test(a.href)) return;
              seen.add(a.href); out.push(a.href);
            }
          });
          return out;
        }
      });
      const links = results?.[0]?.result || [];
      if (links.length > 0) return links;
      // Wait and retry — AJAX content may still be loading
      await new Promise(r => setTimeout(r, 2000));
    }
    return [];
  } catch { return []; }
}

// ── Main background scan ───────────────────────────────────────────────────
async function runBackgroundScan(links, pageLinks = []) {
  activeScan = {
    status:  'running',
    total:   links.length,
    current: 0,
    vehicles: [],
    log: [{ cls: 'hi', text: `Found ${links.length} vehicles on page 1${pageLinks.length ? ` + ${pageLinks.length} more pages to collect` : ''} — starting scan...` },
          { cls: 'hi', text: 'You can navigate away — scan runs in background.' }]
  };
  await persistState();
  broadcastProgress();

  let bgTab = null;
  try {
    bgTab = await chrome.tabs.create({ url: links[0], active: false });

    // ── If there are more pages, collect all their VDP links first ─────────
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
        // Extra wait for lazy-loaded gallery images to render
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

  // Bridge relay — platform page can't fetch http://localhost from HTTPS (Chrome PNA policy)
  // The background service worker has no such restriction
  if (msg.type === 'FF_BRIDGE_FETCH') {
    const opts = { method: msg.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (msg.body) opts.body = JSON.stringify(msg.body);
    fetch(msg.url, opts)
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'START_SCAN') {
    runBackgroundScan(msg.links, msg.pageLinks || []); // fire-and-forget; progress via SCAN_PROGRESS broadcasts
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

  // ── FB Auto-Fill: open Facebook tab, fetch photos, fill form + upload ──
  if (msg.type === 'FB_AUTOFILL') {
    (async () => {
      try {
        // Fetch photos as base64 in the background (no CORS issues here)
        const photoData = [];
        const photoUrls = msg.vehicle.photos || [];
        if (photoUrls.length > 0) {
          console.log(`[FIRST-FIN] Fetching ${photoUrls.length} photos...`);
          for (let i = 0; i < Math.min(photoUrls.length, 10); i++) {
            try {
              const resp = await fetch(photoUrls[i]);
              if (!resp.ok) continue;
              const blob = await resp.blob();
              const buffer = await blob.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let b = 0; b < bytes.length; b++) binary += String.fromCharCode(bytes[b]);
              const base64 = 'data:' + (blob.type || 'image/jpeg') + ';base64,' + btoa(binary);
              photoData.push({ base64, type: blob.type || 'image/jpeg', name: `photo_${i+1}.jpg` });
            } catch (e) {
              console.warn(`[FIRST-FIN] Photo ${i+1} fetch failed:`, e.message);
            }
          }
          console.log(`[FIRST-FIN] Fetched ${photoData.length}/${photoUrls.length} photos`);
        }

        const tab = await chrome.tabs.create({
          url: 'https://www.facebook.com/marketplace/create/vehicle',
          active: true
        });
        // Wait for Facebook page to load
        await new Promise((resolve) => {
          function onUpdated(tabId, info) {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          }
          chrome.tabs.onUpdated.addListener(onUpdated);
          setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 20000);
        });
        // Extra wait for Facebook React to hydrate
        await new Promise(r => setTimeout(r, 3000));
        // Inject the auto-fill script
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['fb-autofill.js']
        });
        await new Promise(r => setTimeout(r, 500));
        await chrome.tabs.sendMessage(tab.id, {
          type: 'FB_FILL_FORM',
          vehicle: msg.vehicle,
          photos: photoData
        });
      } catch (e) {
        console.error('[FIRST-FIN] FB autofill error:', e);
      }
    })();
    sendResponse({ ok: true });
    return false;
  }
});
