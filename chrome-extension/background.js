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
  // Step 1: Client-side scrape via SCRAPE_LOCAL (no server relay — avoids deadlock)
  let clientResult = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      clientResult = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_LOCAL' });
      break;
    } catch (e) {
      if (attempt === 0) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 400));
        } catch (_) {}
      }
    }
  }

  // Step 2: If client got few photos, try server for better photos (cheerio parses raw HTML)
  if (clientResult?.result?.vehicles?.length) {
    const v = clientResult.result.vehicles[0];
    if ((v._photos?.length || 0) < 3) {
      try {
        const token = (await chrome.storage.local.get('token')).token;
        if (token) {
          const [{ result: capture }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({ html: document.documentElement.outerHTML, url: location.href })
          });
          if (capture?.html && capture.html.length > 500) {
            const resp = await fetch('https://app.firstfinancialcanada.com/api/desk/scrape-vdp', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
              body: JSON.stringify({ html: capture.html, url: capture.url })
            });
            if (resp.ok) {
              const data = await resp.json();
              if (data.ok && data.result?.vehicles?.[0]?._photos?.length > v._photos?.length) {
                v._photos = data.result.vehicles[0]._photos;
              }
            }
          }
        }
      } catch (e) {
        // Server failed — keep client photos, no harm done
      }
    }
  }

  if (clientResult) return clientResult;
  throw new Error('Could not scrape page');
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
    // Scroll through page to trigger lazy-loaded cards
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          let prev = 0;
          for (let r = 0; r < 15; r++) {
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise(w => setTimeout(w, 800));
            if (document.body.scrollHeight === prev) break;
            prev = document.body.scrollHeight;
          }
          window.scrollTo(0, 0);
        }
      });
      await new Promise(r => setTimeout(r, 500));
    } catch (_) {}
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
async function runBackgroundScan(links, pageLinks = [], cardVehicles = null, d2cSlugPages = 0, scanUrl = '') {
  activeScan = {
    status:  'running',
    total:   links.length,
    current: 0,
    vehicles: [],
    log: [{ cls: 'hi', text: `Found ${links.length} vehicles on page 1${pageLinks.length ? ` + ${pageLinks.length} more pages to collect` : (d2cSlugPages > 1 ? ` + ${d2cSlugPages - 1} more pages (button pagination)` : '')} — starting scan...` },
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

    // ── D2C slug URL pagination: click page buttons in background tab ──────
    if (d2cSlugPages > 1 && scanUrl) {
      const allLinks = [...links];
      const seenLinks = new Set(links);
      await chrome.tabs.update(bgTab.id, { url: scanUrl });
      await waitForTabLoad(bgTab.id);
      await new Promise(r => setTimeout(r, 2000));
      for (let p = 1; p < d2cSlugPages; p++) {
        activeScan.log.push({ cls: 'hi', text: `Collecting page ${p + 1} of ${d2cSlugPages} (clicking pagination)...` });
        broadcastProgress();
        // Click the pagination button for page p
        await chrome.scripting.executeScript({
          target: { tabId: bgTab.id },
          func: (pageIdx) => {
            const btn = document.querySelector(`.divPaginationBox[item-value="${pageIdx}"] button`);
            if (btn) btn.click();
          },
          args: [p]
        });
        await new Promise(r => setTimeout(r, 3000)); // Wait for AJAX
        // Scrape new VDP links
        const results = await chrome.scripting.executeScript({
          target: { tabId: bgTab.id },
          func: () => {
            const seen = new Set(); const out = [];
            const d2cRe = /-id\d+\.html/i;
            document.querySelectorAll('a[href]').forEach(a => {
              if (!seen.has(a.href) && d2cRe.test(a.href)) { seen.add(a.href); out.push(a.href); }
            });
            return out;
          }
        });
        const moreLinks = results?.[0]?.result || [];
        let added = 0;
        for (const l of moreLinks) {
          if (!seenLinks.has(l)) { seenLinks.add(l); allLinks.push(l); added++; }
        }
        activeScan.log.push({ cls: 'ok', text: `  Page ${p + 1}: found ${added} more vehicles` });
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
        const isD2C = /d2cmedia|renfrewchrysler|\.html\?|filterid/i.test(link);
        await new Promise(r => setTimeout(r, isD2C ? 3000 : 1500));
        const vResp = await scrapeTabBg(bgTab.id);

        if (vResp?.result?.vehicles?.length) {
          let v = vResp.result.vehicles[0];
          // If card data provided, use it for price/mileage/VIN — only take photos from VDP
          if (cardVehicles && cardVehicles[i]) {
            const card = cardVehicles[i];
            const vdpPhotos = v._photos || [];
            v = { ...card, _photos: vdpPhotos.length > (card._photos?.length || 0) ? vdpPhotos : (card._photos || []) };
          }
          if (isRealVehicle(v)) {
            activeScan.vehicles.push(v);
            const photoCount = v._photos?.length || 0;
            activeScan.log.push({ cls: 'ok',
              text: `[${i+1}/${links.length}] ✓ ${v.year} ${v.make} ${v.model} — ${(v.mileage||0).toLocaleString()} km · $${(v.price||0).toLocaleString()} · 📷${photoCount}` });
          } else {
            activeScan.log.push({ cls: '',
              text: `[${i+1}/${links.length}] ⏭ ${label} (skipped)` });
          }
        } else if (cardVehicles && cardVehicles[i]) {
          // VDP failed but card data exists — use card data
          const v = cardVehicles[i];
          activeScan.vehicles.push(v);
          const photoCount = v._photos?.length || 0;
          activeScan.log.push({ cls: 'ok',
            text: `[${i+1}/${links.length}] ✓ ${v.year} ${v.make} ${v.model} — ${(v.mileage||0).toLocaleString()} km · $${(v.price||0).toLocaleString()} · 📷${photoCount} (card)` });
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

  // ── Post-scan: ask server to detect shared dealer ad photos ────────────
  if (activeScan.status !== 'error' && activeScan.vehicles.length >= 2) {
    try {
      const token = (await chrome.storage.local.get('token')).token;
      if (token) {
        const d2cVehicles = activeScan.vehicles
          .filter(v => v._photos?.some(p => /d2cmedia\.ca|getedealer\.com/i.test(p)))
          .map(v => ({ photos: v._photos.filter(p => /d2cmedia\.ca|getedealer\.com/i.test(p)) }));
        if (d2cVehicles.length >= 2) {
          activeScan.log.push({ cls: 'hi', text: '🔍 Checking for dealer ad photos...' });
          broadcastProgress();
          const resp = await fetch('https://app.firstfinancialcanada.com/api/desk/filter-ad-photos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ vehicles: d2cVehicles })
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data.ok && data.adUrls?.length) {
              const adSet = new Set(data.adUrls);
              let totalRemoved = 0;
              for (const v of activeScan.vehicles) {
                if (!v._photos?.length) continue;
                const before = v._photos.length;
                v._photos = v._photos.filter(p => !adSet.has(p));
                totalRemoved += before - v._photos.length;
              }
              if (totalRemoved > 0) {
                activeScan.log.push({ cls: 'hi', text: `🧹 Removed ${totalRemoved} dealer ad photos across ${activeScan.vehicles.length} vehicles` });
              }
            }
          }
        }
      }
    } catch (e) {
      activeScan.log.push({ cls: '', text: `Ad filter skipped: ${e.message}` });
    }
  }

  if (activeScan.status !== 'error') activeScan.status = 'done';
  activeScan.log.push({ cls: activeScan.status === 'done' ? 'ok' : 'err',
    text: activeScan.status === 'done'
      ? `✅ ${activeScan.vehicles.length} vehicles ready to sync`
      : `Scan failed: ${activeScan.errorMsg}` });

  await persistState();
  broadcastProgress();
}

// ── Convertus deep photo enrichment ────────────────────────────────────────
// For each vehicle URL, opens a hidden tab, lets JS render, clicks the
// .button.view-photos lightbox, and scrapes the populated DOM for
// autotradercdn photo URLs. Runs in batches of CONCURRENCY tabs.
//
// Updates activeScan.vehicles[i]._photos as photos come in, so the popup
// can show progressive results. ~12-14s per vehicle; with 3 concurrent
// tabs, ~5-7 minutes for 79 vehicles.
async function runDeepPhotoEnrichment(vehicles) {
  const CONCURRENCY     = 2;     // hidden tabs in flight (down from 3 — more cf-friendly)
  const PER_TAB_TIMEOUT = 30000; // safety bail per tab
  const COOLDOWN_THRESHOLD = 3;  // 3 consecutive cf-blocks → pause workers
  const COOLDOWN_MS     = 30000; // 30s cooldown lets cf_clearance re-issue
  let enrichedCount = 0, failedCount = 0;
  let consecutiveBlocks = 0, cooldownActive = false;
  const cfBlockedQueue = []; // collected for retry pass at end
  const startTs = Date.now();

  // Mark progress in activeScan so popup can render a status bar
  activeScan.deepScan = { active: true, current: 0, total: vehicles.length, enriched: 0, failed: 0 };
  broadcastProgress();

  const queue = vehicles.slice(); // shallow copy; we'll pop items
  const workers = [];

  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        // Honor active cooldown — pause until the timer resets the flag
        while (cooldownActive) await new Promise(r => setTimeout(r, 1000));
        const v = queue.shift();
        if (!v || !v._url) continue;

        let tab = null;
        const tabTimeout = setTimeout(() => {
          if (tab) chrome.tabs.remove(tab.id).catch(() => {});
        }, PER_TAB_TIMEOUT);

        try {
          tab = await chrome.tabs.create({ url: v._url, active: false });
          await waitForTabLoad(tab.id, 14000);
          // Run the lightbox-extractor in the VDP tab
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
              await new Promise(r => setTimeout(r, 5000));
              const trigger = document.querySelector('.button.view-photos, div.button.view-photos');
              if (trigger) {
                const rect = trigger.getBoundingClientRect();
                const init = { bubbles: true, cancelable: true, view: window, button: 0,
                               clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 };
                try { trigger.dispatchEvent(new PointerEvent('pointerdown', init)); } catch(_){}
                try { trigger.dispatchEvent(new MouseEvent('mousedown', init)); } catch(_){}
                try { trigger.dispatchEvent(new PointerEvent('pointerup', init)); } catch(_){}
                try { trigger.dispatchEvent(new MouseEvent('mouseup', init)); } catch(_){}
                try { trigger.dispatchEvent(new MouseEvent('click', init)); } catch(_){}
                try { trigger.click(); } catch(_){}
                await new Promise(r => setTimeout(r, 4000));
              }
              const html = document.documentElement.outerHTML;
              const allUrls = html.match(/https?:\/\/[^\s"'<>)\\,]*autotradercdn[^\s"'<>)\\,]*\.(?:jpg|jpeg|png|webp)[^\s"'<>)\\,]*/gi) || [];
              const byUuid = new Map();
              for (const url of allUrls) {
                const uuidMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
                const key = uuidMatch ? uuidMatch[1] : url;
                const existing = byUuid.get(key);
                if (!existing) { byUuid.set(key, url); continue; }
                const sizeNew = parseInt(url.match(/-(\d+)x\d+/)?.[1] || '0');
                const sizeOld = parseInt(existing.match(/-(\d+)x\d+/)?.[1] || '0');
                if (sizeNew > sizeOld) byUuid.set(key, url);
              }
              const photos = [...byUuid.values()].filter(u =>
                !/badge|logo|favicon|sprite|placeholder|gubagoo|certified.*generic|car-fax-badge/i.test(u)
              );
              return photos.slice(0, 25);
            }
          });
          const newPhotos = results?.[0]?.result || [];

          // Detect Cloudflare challenge — page has no autotradercdn at all
          if (newPhotos.length === 0) {
            // Try one retry with a longer wait (cf clearance might issue mid-load)
            await new Promise(r => setTimeout(r, 5000));
            const retry = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const html = document.documentElement.outerHTML;
                const all = html.match(/https?:\/\/[^\s"'<>)\\,]*autotradercdn[^\s"'<>)\\,]*\.(?:jpg|jpeg|png|webp)[^\s"'<>)\\,]*/gi) || [];
                return [...new Set(all)].slice(0, 25);
              }
            });
            const retryPhotos = retry?.[0]?.result || [];
            if (retryPhotos.length > 0) {
              v._photos = retryPhotos;
              enrichedCount++;
              consecutiveBlocks = 0;
              activeScan.log.push({ cls: 'ok', text: `📷 ${v.year} ${v.make} ${v.model}: ${retryPhotos.length} photos (retry)` });
            } else {
              failedCount++;
              consecutiveBlocks++;
              cfBlockedQueue.push(v); // queue for the end-of-pass retry
              activeScan.log.push({ cls: '', text: `📷 ${v.year} ${v.make} ${v.model}: cf-blocked (will retry)` });
              // Cooldown trigger: too many blocks in a row → pause workers
              if (consecutiveBlocks >= COOLDOWN_THRESHOLD && !cooldownActive) {
                cooldownActive = true;
                activeScan.log.push({ cls: 'hi', text: `⏸ Cloudflare throttling — cooling down ${COOLDOWN_MS/1000}s before resuming` });
                broadcastProgress();
                setTimeout(() => {
                  cooldownActive = false;
                  consecutiveBlocks = 0;
                  activeScan.log.push({ cls: 'hi', text: `▶ Resuming deep photo scan` });
                  broadcastProgress();
                }, COOLDOWN_MS);
              }
            }
          } else {
            // Merge: new photos first, dedupe with existing card photo
            const merged = [];
            const seen   = new Set();
            for (const p of newPhotos.concat(v._photos || [])) {
              if (!p || seen.has(p)) continue;
              seen.add(p);
              merged.push(p);
              if (merged.length >= 25) break;
            }
            v._photos = merged;
            enrichedCount++;
            consecutiveBlocks = 0;
            activeScan.log.push({ cls: 'ok', text: `📷 ${v.year} ${v.make} ${v.model}: ${merged.length} photos` });
          }
        } catch (e) {
          failedCount++;
          activeScan.log.push({ cls: '', text: `📷 ${v.year || ''} ${v.make || ''} ${v.model || ''}: photo enrich failed (${e.message})` });
        } finally {
          clearTimeout(tabTimeout);
          if (tab) chrome.tabs.remove(tab.id).catch(() => {});
          activeScan.deepScan.current++;
          activeScan.deepScan.enriched = enrichedCount;
          activeScan.deepScan.failed   = failedCount;
          broadcastProgress();
          if (activeScan.deepScan.current % 5 === 0) await persistState();
        }
      }
    })());
  }

  await Promise.all(workers);

  // ── RETRY PASS: cf-blocked vehicles get one more shot at concurrency=1 ─
  // After 60s cooldown, walk through them slowly (5s gap each) so Cloudflare
  // sees a low-rate, human-paced burst. Typical recovery: 60-80% of the
  // initial cf-blocked vehicles get their full gallery on this pass.
  if (cfBlockedQueue.length > 0) {
    activeScan.log.push({ cls: 'hi', text: `🔁 Retry pass: ${cfBlockedQueue.length} cf-blocked vehicles, 60s cooldown then sequential...` });
    broadcastProgress();
    await new Promise(r => setTimeout(r, 60000)); // let Cloudflare forget us
    activeScan.log.push({ cls: 'hi', text: `▶ Retry pass starting` });
    broadcastProgress();

    let retriedOk = 0, retriedFail = 0;
    for (const v of cfBlockedQueue) {
      let tab = null;
      try {
        tab = await chrome.tabs.create({ url: v._url, active: false });
        await waitForTabLoad(tab.id, 14000);
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            await new Promise(r => setTimeout(r, 6000)); // longer wait on retry
            const trigger = document.querySelector('.button.view-photos, div.button.view-photos');
            if (trigger) {
              const rect = trigger.getBoundingClientRect();
              const init = { bubbles: true, cancelable: true, view: window, button: 0,
                             clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 };
              try { trigger.dispatchEvent(new PointerEvent('pointerdown', init)); } catch(_){}
              try { trigger.dispatchEvent(new MouseEvent('mousedown', init)); } catch(_){}
              try { trigger.dispatchEvent(new PointerEvent('pointerup', init)); } catch(_){}
              try { trigger.dispatchEvent(new MouseEvent('mouseup', init)); } catch(_){}
              try { trigger.dispatchEvent(new MouseEvent('click', init)); } catch(_){}
              try { trigger.click(); } catch(_){}
              await new Promise(r => setTimeout(r, 5000));
            }
            const html = document.documentElement.outerHTML;
            const all = html.match(/https?:\/\/[^\s"'<>)\\,]*autotradercdn[^\s"'<>)\\,]*\.(?:jpg|jpeg|png|webp)[^\s"'<>)\\,]*/gi) || [];
            const byUuid = new Map();
            for (const url of all) {
              const uuidMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
              const key = uuidMatch ? uuidMatch[1] : url;
              const existing = byUuid.get(key);
              if (!existing) { byUuid.set(key, url); continue; }
              const sN = parseInt(url.match(/-(\d+)x\d+/)?.[1] || '0');
              const sO = parseInt(existing.match(/-(\d+)x\d+/)?.[1] || '0');
              if (sN > sO) byUuid.set(key, url);
            }
            return [...byUuid.values()].filter(u =>
              !/badge|logo|favicon|sprite|placeholder|gubagoo|certified.*generic|car-fax-badge/i.test(u)
            ).slice(0, 25);
          }
        });
        const photos = results?.[0]?.result || [];
        if (photos.length > 1) {
          const merged = [];
          const seen   = new Set();
          for (const p of photos.concat(v._photos || [])) {
            if (!p || seen.has(p)) continue;
            seen.add(p); merged.push(p);
            if (merged.length >= 25) break;
          }
          v._photos = merged;
          enrichedCount++;
          failedCount = Math.max(0, failedCount - 1);
          retriedOk++;
          activeScan.log.push({ cls: 'ok', text: `🔁 ${v.year} ${v.make} ${v.model}: ${merged.length} photos (retry)` });
        } else {
          retriedFail++;
          activeScan.log.push({ cls: '', text: `🔁 ${v.year} ${v.make} ${v.model}: still cf-blocked, kept card photo` });
        }
      } catch (e) {
        retriedFail++;
      } finally {
        if (tab) chrome.tabs.remove(tab.id).catch(() => {});
        activeScan.deepScan.enriched = enrichedCount;
        activeScan.deepScan.failed   = failedCount;
        broadcastProgress();
        // 5-second pause between retries — gentle pace, Cloudflare-friendly
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    activeScan.log.push({ cls: 'hi', text: `🔁 Retry pass done: ${retriedOk} recovered, ${retriedFail} still card-only` });
  }

  const elapsed = Math.round((Date.now() - startTs) / 1000);
  activeScan.deepScan.active = false;
  activeScan.log.push({ cls: 'hi',
    text: `✅ Deep photo scan: ${enrichedCount}/${vehicles.length} enriched in ${elapsed}s${failedCount ? ` (${failedCount} kept card photo)` : ''}` });
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

  // Server-side scrape relay — content.js sends HTML, we forward to server
  if (msg.type === 'FF_SERVER_SCRAPE') {
    chrome.storage.local.get('token', (data) => {
      if (!data.token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
      fetch('https://app.firstfinancialcanada.com/api/desk/scrape-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + data.token },
        body: JSON.stringify({ html: msg.html, url: msg.url }),
        signal: controller.signal
      })
        .then(r => { clearTimeout(timeout); return r.json(); })
        .then(d => { sendResponse(d.ok ? { ok: true, result: d.result } : { ok: false }); })
        .catch(() => { clearTimeout(timeout); sendResponse({ ok: false }); });
    });
    return true;
  }

  if (msg.type === 'START_SCAN') {
    runBackgroundScan(msg.links, msg.pageLinks || [], msg.cardVehicles || null, msg.d2cSlugPages || 0, msg.scanUrl || '');
    sendResponse({ ok: true });
    return false;
  }

  // Convertus listing-cards path: popup already has 79 vehicles + 1 photo each.
  // Now we go deep — visit each VDP, click lightbox, scrape 24-26 photos.
  if (msg.type === 'START_DEEP_PHOTO_SCAN') {
    const vehicles = Array.isArray(msg.vehicles) ? msg.vehicles : [];
    if (vehicles.length === 0) { sendResponse({ ok: false, error: 'no vehicles' }); return false; }
    // Seed activeScan so popup can render progress
    activeScan = activeScan || { status: 'running', total: vehicles.length, current: 0, vehicles, log: [] };
    activeScan.vehicles = vehicles;
    activeScan.status   = 'running';
    activeScan.log = activeScan.log || [];
    activeScan.log.push({ cls: 'hi', text: `🔎 Deep photo scan starting — ${vehicles.length} VDPs, ~${Math.ceil(vehicles.length * 14 / 3 / 60)} min` });
    activeScan.log.push({ cls: 'hi', text: 'You can navigate away — scan runs in background.' });
    persistState();
    broadcastProgress();
    runDeepPhotoEnrichment(vehicles).catch(e => {
      activeScan.log.push({ cls: 'err', text: `❌ Deep scan crashed: ${e.message}` });
      activeScan.status = 'error';
      broadcastProgress();
    });
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

  // ── FB Auto-Fill: open (or reuse) Facebook tab, fetch photos, fill form ──
  if (msg.type === 'FB_AUTOFILL') {
    const senderTabId = _sender && _sender.tab && _sender.tab.id;
    // Respond fast so the content script's sendMessage callback doesn't
    // hang; actual work continues async and reports errors back via
    // chrome.tabs.sendMessage to the platform tab.
    sendResponse({ ok: true });

    (async () => {
      const reportError = (msgText) => {
        console.error('[FIRST-FIN] FB autofill error:', msgText);
        if (senderTabId) {
          chrome.tabs.sendMessage(senderTabId, {
            type: 'FB_AUTOFILL_ERROR',
            error: String(msgText).slice(0, 200)
          }).catch(() => {});
        }
      };
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

        // Reuse an existing FB create-vehicle tab if one is open — prevents
        // tab pileup and sidesteps a class of service-worker / popup-gesture
        // issues that caused subsequent chrome.tabs.create calls to fail
        // silently. Always reload + refocus for a clean form.
        let tab = null;
        let existing = [];
        try {
          existing = await chrome.tabs.query({ url: 'https://www.facebook.com/marketplace/create/vehicle*' });
        } catch {}
        if (existing && existing.length > 0) {
          tab = existing[0];
          try {
            await chrome.tabs.update(tab.id, { active: true, url: 'https://www.facebook.com/marketplace/create/vehicle' });
            if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
          } catch {
            tab = null;  // fall through to create
          }
        }
        if (!tab) {
          tab = await chrome.tabs.create({
            url: 'https://www.facebook.com/marketplace/create/vehicle',
            active: true
          });
        }
        const fbTabId = tab.id;

        // Wait for Facebook page to load
        await new Promise((resolve) => {
          function onUpdated(tabId, info) {
            if (tabId === fbTabId && info.status === 'complete') {
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
          target: { tabId: fbTabId },
          files: ['fb-autofill.js']
        });
        await new Promise(r => setTimeout(r, 500));
        await chrome.tabs.sendMessage(fbTabId, {
          type: 'FB_FILL_FORM',
          vehicle: msg.vehicle,
          photos: photoData
        });
      } catch (e) {
        reportError(e.message || e);
      }
    })();
    return false;
  }
});
