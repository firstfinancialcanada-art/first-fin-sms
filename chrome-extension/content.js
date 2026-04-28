// content.js — FIRST-FIN Inventory Importer v2.8.8
// Injected into dealer pages. Responds to SCRAPE messages from the popup.
'use strict';
// Version-tagged guard: when content.js is updated, the old guard tag won't match
// the new one, so the new code re-initializes (overrides the old listeners).
// IMPORTANT: bump this string whenever content.js changes meaningfully.
const __FF_VERSION = 'v2.8.8-spec-regex-tolerant-2026-04-27';
if (window.__FIRSTFIN_VERSION === __FF_VERSION) { /* already injected this exact version — skip */ } else {
window.__FIRSTFIN_VERSION = __FF_VERSION;
window.__FIRSTFIN_LOADED  = true;

// ── Bridge relay (for platform page — bypasses Chrome PNA restrictions) ───
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.type !== 'FF_BRIDGE_FETCH') return;
  const { id, url, method, body } = event.data;
  chrome.runtime.sendMessage({ type: 'FF_BRIDGE_FETCH', url, method, body }, (resp) => {
    window.postMessage({ type: 'FF_BRIDGE_RESP', id, ...(resp || { ok: false, error: 'no response' }) }, '*');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────
function clean(t)      { return (t || '').replace(/\s+/g, ' ').trim(); }
function parsePrice(t) {
  const s = (t || '').replace(/,/g, '');
  // Require 4+ digit prices — skips monthly/weekly payment fragments like "$32/mo"
  const m = s.match(/\$\s*(\d{4,6})(?!\d)/);
  if (m) return parseInt(m[1]);
  // Fallback: any number but must be >= 1000
  const m2 = s.match(/\$?\s*(\d+)/);
  const v = m2 ? parseInt(m2[1]) : 0;
  return v >= 1000 ? v : 0;
}
function parseYear(t) {
  const m = (t || '').match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0]) : null;
}
// Makes that should stay ALL-CAPS
const MAKE_UPCASE = new Set(['BMW','GMC','VW','RAM','KIA','MINI','BYD','GWM','CDJR','INFINITI']);
function normMake(s) {
  const cleaned = s.replace(/_/g, ' ').replace(/-/g, ' ').trim();
  const up = cleaned.toUpperCase();
  if (MAKE_UPCASE.has(up)) return up;
  return cleaned.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '').join(' ');
}
function titleWord(s) {
  return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
const COLOR_WORDS = ['white','black','silver','grey','gray','red','blue','green','gold',
  'brown','beige','orange','yellow','purple','tan','maroon','burgundy','navy','charcoal',
  'champagne','pearl','bronze','copper','cream','ivory','teal','pink','magnetic','ceramic',
  'midnight','glacier','obsidian','wolf','mineral'];
function parseColor(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  const labeled = t.match(/(?:ext(?:erior)?|colour|color)[.:\s]+([a-z ]+)/i);
  if (labeled) {
    const found = COLOR_WORDS.find(c => labeled[1].includes(c));
    if (found) return found[0].toUpperCase() + found.slice(1);
  }
  for (const c of COLOR_WORDS) {
    if (new RegExp(`\\b${c}\\b`).test(t)) return c[0].toUpperCase() + c.slice(1);
  }
  return '';
}
function parseMileage(t) {
  // Match "Kilometres: 293,874" or "Kilometers: 150000" (label before value)
  const labeled = (t || '').match(/(?:kilometres?|kilometers?|odometer|mileage)[:\s]+([0-9,]{3,7})/i);
  if (labeled) { const v = parseInt(labeled[1].replace(/,/g, '')); if (v >= 500 && v <= 400000) return v; }
  const m = (t || '').replace(/,/g, '').match(/([\d]+)\s*k(?:m|ilometers?|ilometres?)?/i);
  if (m) { const v = parseInt(m[1]); return v > 350000 ? 0 : v; }
  // Also handle plain km numbers like "89000 km"
  const m2 = (t || '').replace(/,/g, '').match(/([\d]+)\s*km/i);
  if (m2) { const v = parseInt(m2[1]); return v > 350000 ? 0 : v; }
  return 0;
}
function parseFromSlug(url) {
  // Convertus/Stellantis: /vehicles/YEAR/MAKE/MODEL/CITY/PROV/ID/
  const pathSegs = (url || '').replace(/\?.*/, '').split('/').filter(Boolean);
  const vehIdx = pathSegs.indexOf('vehicles');
  if (vehIdx >= 0 && pathSegs[vehIdx + 1] && /^\d{4}$/.test(pathSegs[vehIdx + 1])) {
    return {
      year:  parseInt(pathSegs[vehIdx + 1]) || 0,
      make:  normMake(pathSegs[vehIdx + 2] || ''),
      model: titleWord(pathSegs[vehIdx + 3] || ''),
      trim:  ''
    };
  }
  let slug   = pathSegs.pop() || '';
  // Strip .html extension and D2C Media ID suffix (e.g., -id13273287.html)
  slug = slug.replace(/\.html?$/i, '').replace(/-id\d+$/i, '');
  // Decode URL-encoded chars: + → space, %20 → space, _ → space
  const decoded = slug.replace(/\+/g, ' ').replace(/%20/g, ' ').replace(/_/g, ' ');
  const s      = decoded.replace(/^(used|new|pre-?owned)[- ]/i, '');
  const parts  = s.split(/[-]/).filter(Boolean);
  const result = {};
  if (parts[0] && /^\d{4}$/.test(parts[0].trim()))
    { result.year = parseInt(parts.shift()); }
  if (parts.length && /^[A-HJ-NPR-Z0-9]{17}$/i.test(parts[parts.length - 1].trim()))
    { result.vin = parts.pop().trim().toUpperCase(); }

  // Rejoin parts that form known hyphenated models (F-150, CX-5, etc.)
  // After splitting by -, "F" and "150" are separate parts. Detect and rejoin.
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i].trim(), b = parts[i+1].trim();
    // Pattern: single letter + number (F-150, F-250, F-350, X-5, V-60, etc.)
    if (/^[A-Z]$/i.test(a) && /^\d{1,3}\b/.test(b)) {
      parts[i] = a + '-' + b;
      parts.splice(i+1, 1);
    }
    // Pattern: 2 letter + number (CX-5, CX-30, CX-50, CX-90, MX-5, CR-V, HR-V)
    else if (/^[A-Z]{2}$/i.test(a) && /^\d{1,2}\b/.test(b)) {
      parts[i] = a + '-' + b;
      parts.splice(i+1, 1);
    }
  }

  // Rejoin known multi-word models that get split by hyphens
  // "Grand-Caravan" → ["Grand","Caravan"] → rejoin as "Grand Caravan"
  const MULTI_WORD_MODELS = ['grand caravan','grand cherokee','grand cherokee l','grand wagoneer',
    'santa fe','santa cruz','model 3','model y','model s','model x',
    'cr v','hr v','br v','rav4','land cruiser','range rover','town country',
    'pt cruiser','monte carlo','el camino','la crosse'];
  for (let i = 0; i < parts.length - 1; i++) {
    const joined2 = (parts[i] + ' ' + parts[i+1]).trim().toLowerCase();
    if (MULTI_WORD_MODELS.includes(joined2)) {
      parts[i] = parts[i].trim() + ' ' + parts[i+1].trim();
      parts.splice(i+1, 1);
      // Check 3-word models (Grand Cherokee L)
      if (i < parts.length - 1) {
        const joined3 = (parts[i] + ' ' + parts[i+1]).trim().toLowerCase();
        if (MULTI_WORD_MODELS.includes(joined3)) {
          parts[i] = parts[i].trim() + ' ' + parts[i+1].trim();
          parts.splice(i+1, 1);
        }
      }
      break;
    }
  }

  // Strip trailing WordPress duplicate slug suffix (e.g., -2, -3 in /2018-ram-1500-2/)
  // But NOT if preceding part is "Model" (Tesla Model 3, Model Y, Model S, Model X)
  if (parts.length > 2 && /^\d{1,2}$/.test(parts[parts.length - 1].trim()) &&
      !/^\d{3,}$/.test(parts[parts.length - 1].trim()) &&
      !/^model$/i.test(parts[parts.length - 2]?.trim())) {
    parts.pop();
  }

  if (parts[0]) result.make  = normMake(parts[0].trim());
  if (parts[1]) {
    // Handle "Model Y", "Model 3", "Model S", "Model X" as single model name
    if (/^model$/i.test(parts[1].trim()) && parts[2] && /^[3ySX]$/i.test(parts[2].trim())) {
      result.model = parts[1].trim() + ' ' + parts[2].trim().toUpperCase();
      parts.splice(2, 1); // remove the letter so it doesn't end up in trim
    } else {
      result.model = titleWord(parts[1].trim());
    }
  }
  if (parts.length > 2)
    result.trim = parts.slice(2).map(p => titleWord(p.trim())).join(' ');
  return result;
}

// ── VDP detail page parser (HOC / Automaxx / similar slug-based sites) ───
function parseVdpDetail(url) {
  const body  = document.body.innerText;
  const slug  = parseFromSlug(url);

  let title = '';
  for (const sel of ['h1.vehicle-title','h1.listing-title','.vehicle-name h1','h1','.car-title','.srp-vehicle-title']) {
    const el = document.querySelector(sel);
    if (el?.innerText.trim().length > 3) { title = clean(el.innerText); break; }
  }
  title = title.replace(/^(used|new|pre-?owned)\s+/i, '').trim();

  let price = 0;
  // Priority 1: VDP-specific sale price selectors (avoids nav/category "Starting at" prices)
  const PRICE_SELS = [
    '#carPrice', '.priceDivPrice',
    '.pricing-group__final-price', '[class*="price-block__price--lg"]',
    '.finalPrice', '.vdpPricing', '.sale-price', '.salePrice',
    '.vehicle-price', '.listing-price', '.price-current',
    '[class*="salePrice"]', '[class*="finalPrice"]', '[class*="internet-price"]'
  ];
  for (const sel of PRICE_SELS) {
    const el = document.querySelector(sel);
    if (el) {
      // Skip "Was/Original" prices — look for "Sale Price" text or just the final number
      const txt = el.innerText || '';
      const saleMatch = txt.match(/sale\s*price[:\s$]*\$?([\d,]+)/i);
      if (saleMatch) { price = parseInt(saleMatch[1].replace(/,/g, '')); break; }
      const p = parsePrice(txt);
      if (p >= 1000) { price = p; break; }
    }
  }
  // Priority 2: "Sale Price" or "Internet Price" text anywhere in the body
  if (!price) {
    const saleM = body.match(/(?:sale|internet|final|cash)\s*price[\s:$]*\$?\s*([\d,]+)/i);
    if (saleM) price = parseInt(saleM[1].replace(/,/g, ''));
  }
  // Priority 3: generic price element (but skip nav/category elements)
  if (!price) {
    document.querySelectorAll('.price,[class*="price"],[class*="Price"]').forEach(el => {
      if (price) return;
      const txt = el.innerText || '';
      // Skip category/nav "Starting at" prices
      if (/starting at|view inventory|contact us/i.test(txt)) return;
      const p = parsePrice(txt);
      if (p >= 1000) price = p;
    });
  }
  // Priority 4: first dollar amount in body
  if (!price) { const m = body.match(/\$([\d,]+)/); if (m) price = parseInt(m[1].replace(/,/g,'')); }

  let vin = slug.vin || '';
  if (!vin) { const m = body.match(/(?:vin|vehicle id)[:\s#]*([A-HJ-NPR-Z0-9]{17})/i); if (m) vin = m[1]; }

  let stock = '';
  const stockM = body.match(/(?:stock|stock\s*#)[:\s#]*([A-Z0-9\-]{4,12})/i);
  if (stockM) stock = stockM[1].toUpperCase();
  if (!stock && vin) stock = vin.slice(-8);
  if (!stock) stock = (url.split('/').filter(Boolean).pop() || '').slice(0, 12).toUpperCase();

  // ── Spec-block label extraction (mirrors lib/scraper.js) ─────────────────
  // Hunt and most D2C dealer pages have a structured spec list with
  // `Label: Value` rows. Pull these directly instead of grepping for body
  // style words in the whole page text — pre-fix every Hunt vehicle was
  // tagged "Sedan" or "Van" because the body-style regex matched the FIRST
  // body-style word anywhere on the page (sidebars list "Honda Civic Sedan",
  // "RAM Promaster Cargo Van", etc.). The label-based version pulls the
  // CANONICAL category and never hits sidebars.
  function _specVal(re) {
    const m = body.match(re);
    return m ? String(m[1]).replace(/\s+/g, ' ').trim() : '';
  }
  // \s* prefix in NEXT_LABEL is critical for innerText: browsers put newlines
  // between spec-list <li> items so "Black\nPassengers" needs the lookahead
  // to skip the newline. Char class for values now allows /, &, comma, hyphen
  // so categories like "SUVs / Crossovers" get captured (pre-fix this was
  // why 2012 Jeep Grand Cherokee tagged Sedan — Category capture failed at
  // the slash, fell through to grepping "Sedan" from the sidebar).
  const NEXT_LABEL = '(?=\\s*(?:Passengers|Doors|Kilometers|Stock|VIN|Price|Drive|Transmission|Fuel|Engine|Cylinders|Exterior|Interior|Category|Trim|Model|Body|Mileage|Year|Make|Color|Colour|Share|Download|Carfax|City|Highway|$))';
  const VALCHARS   = '[A-Za-z][A-Za-z ,/&\\-]{1,40}?';
  const _categoryRaw   = _specVal(new RegExp('Category\\s*:\\s*(' + VALCHARS + ')' + NEXT_LABEL, 'i'));
  const _extColorRaw   = _specVal(new RegExp('Exterior\\s*Colou?r\\s*:\\s*(' + VALCHARS + ')' + NEXT_LABEL, 'i'));
  const _intColorRaw   = _specVal(new RegExp('Interior\\s*Colou?r\\s*:\\s*(' + VALCHARS + ')' + NEXT_LABEL, 'i'));
  const _driveTrainV   = _specVal(/Drive\s*train\s*:\s*((?:Front|Rear|All|Four)\s*-?\s*wheel\s+drive|FWD|RWD|AWD|4WD|4x4|2WD)/i);
  const _transmissionV = _specVal(new RegExp('Transmission\\s*:\\s*(\\d{1,2}\\s*-?\\s*Speed\\s+(?:Automatic|Auto|Manual|DCT|CVT))' + NEXT_LABEL, 'i'))
                      || _specVal(/Transmission\s*:\s*(Automatic|Manual|CVT|DCT|Auto-?manual|Dual\s*Clutch|Tiptronic)/i);
  const _fuelTypeV     = _specVal(/Fuel\s*:\s*(Plug-?in\s*Hybrid|Gasoline|Gas|Diesel|Electric|Hybrid|Plug-?in|Flex(?:\s*Fuel)?|E85|CNG|LPG)/i);
  const _engineV       = _specVal(new RegExp('Engine\\s*:\\s*([A-Za-z0-9][A-Za-z0-9 \\.\\-/,]{2,80}?)' + NEXT_LABEL, 'i'));

  function _mapBodyStyle(s) {
    if (!s) return '';
    const t = s.toLowerCase();
    if (/truck|pickup/.test(t))                      return 'Pickup';
    if (/suv|crossover|sport.?utility|cuv/.test(t))  return 'SUV';
    if (/van|minivan|cargo/.test(t))                 return 'Van';
    if (/sedan/.test(t))                             return 'Sedan';
    if (/coupe/.test(t))                             return 'Coupe';
    if (/hatchback/.test(t))                         return 'Hatchback';
    if (/wagon/.test(t))                             return 'Wagon';
    if (/convertible/.test(t))                       return 'Convertible';
    return s.replace(/s$/i, '');
  }
  let type = _mapBodyStyle(_categoryRaw);
  if (!type) {
    const typeM = body.match(/\b(sedan|suv|truck|pickup|coupe|hatchback|wagon|convertible|crossover)\b/i);
    type = typeM ? typeM[1][0].toUpperCase() + typeM[1].slice(1).toLowerCase() : 'Used';
  }

  // Collect photos from vehicle gallery only (not "similar vehicles" or site chrome)
  const photos = [];
  const seen = new Set();

  // Strategy 1: Look for a dedicated vehicle gallery container
  const GALLERY_SELS = [
    // D2C Media (Renfrew, etc.) — check first, most specific
    '.advanced-slider', '.slider-main',
    // Vehica (Stampede Auto, etc.)
    '.vehica-gallery-main', '.vehica-car-gallery', '[class*="vehica-gallery"]',
    // eDealer (Applewood Nissan, etc.)
    '.gallery-images', '.vdp-media-gallery',
    // Common dealer platforms
    '.vehicleCarousel', '.vehicle-gallery', '.vdp-gallery', '.media-gallery',
    '[class*="vehicleCarousel"]', '[class*="vehicle-gallery"]', '[class*="vdp-photo"]',
    '.gallery-container', '.photo-gallery', '.slider-for', '.main-slider',
    '.slick-slider', '[class*="carousel"]',
    '.swiper-wrapper', '[class*="swiper-container"]'
  ];
  let galleryEl = null;
  for (const sel of GALLERY_SELS) {
    const el = document.querySelector(sel);
    // Use >= 1 for D2C sliders (background tabs may only render 1-2 images initially)
    const minImgs = (sel === '.advanced-slider' || sel === '.slider-main') ? 1 : 3;
    if (el && el.querySelectorAll('img').length >= minImgs) { galleryEl = el; break; }
  }

  function addPhoto(src, altText) {
    if (!src || src.length < 20) return;
    if (/logo|icon|placeholder|svg|badge|carfax|equifax|sprite|favicon|certified\.png|LIVE-CHAT|BANNER/i.test(src)) return;
    // Skip dealer banner/overlay images from Convertus CDN (not vehicle photos)
    if (/cdn-convertus\.com/i.test(src)) return;
    // Skip small compressed thumbnails (e.g., 300x300, 150x150 in URL)
    if (/compressed\/\d+x\d+/i.test(src) || /\/\d+x\d+_/i.test(src)) return;
    // Skip known "similar vehicles" CDN patterns
    if (/foxdealer\.com.*compressed/i.test(src)) return;
    // Skip D2C "similar vehicles" thumbnails (URL has /T/ instead of /1/, /2/ etc.)
    if (/d2cmedia\.ca.*\/T\//i.test(src)) return;
    // Skip dealer-uploaded marketing graphics (CPO badges, warranty plans, reconditioned cards, etc.)
    if (/capital.?secure|appearance.?plan|warranty.?plan|reconditioned|certified.?pre.?owned|cpo.?(badge|info|logo|graphic|banner)|work.?completed|coverage.?includes/i.test(src)) return;
    if (altText && /capital.?secure|appearance.?plan|warranty|reconditioned|certified.?pre.?owned|cpo|coverage.?includes|work.?completed|first.?canadian.?financial/i.test(altText)) return;
    const clean = src.replace(/-\d+x\d+(\.\w+)$/, '$1');
    if (!clean.startsWith('http')) return;
    // d2cmedia (Hunt etc.) serves the same photo at multiple path prefixes
    // (s.../cb.../etc — different image transforms). Dedupe by `{carid}/{position}`
    // so each position only stores once instead of eating slots with size variants.
    const d2cKey = clean.match(/d2cmedia\.ca\/[^/]+\/\d+\/(\d+)\/(\d+)\//i);
    const seenKey = d2cKey ? ('d2c:' + d2cKey[1] + '/' + d2cKey[2]) : clean;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    photos.push(clean);
  }

  // Helper to get the best image URL from an img element (handles lazy-loading)
  function getBestSrc(img) {
    // Priority: actual src (if not a placeholder) > data-lazy-src > data-src > srcset first URL
    const src = img.src || '';
    if (src.startsWith('http') && !src.includes('data:image') && src.length > 30) return src;
    if (img.dataset.lazySrc) return img.dataset.lazySrc;
    if (img.dataset.src) return img.dataset.src;
    // Parse srcset — take the largest image
    const srcset = img.srcset || img.dataset.srcset || '';
    if (srcset) {
      const parts = srcset.split(',').map(s => s.trim().split(/\s+/));
      let best = '';
      let bestW = 0;
      for (const [url, descriptor] of parts) {
        if (!url || !url.startsWith('http')) continue;
        const w = parseInt(descriptor) || 0;
        if (w > bestW || !best) { best = url; bestW = w; }
      }
      if (best) return best;
    }
    return src;
  }

  // DEBUG: write to DOM so page context can read it
  try { document.documentElement.dataset.ffDebugGallery = galleryEl ? galleryEl.className : 'NONE'; } catch(_){}
  try { document.documentElement.dataset.ffDebugImgs = galleryEl ? galleryEl.querySelectorAll('img').length : 0; } catch(_){}

  if (galleryEl) {
    // Gallery found — only take images from it
    galleryEl.querySelectorAll('img').forEach((img, idx) => {
      addPhoto(getBestSrc(img), img.alt || img.title || '');
    });
  }

  // Strategy 1.5: D2C Media sequential photo generation
  // D2C only puts photo #1 in the HTML; #2-#10+ are loaded by JS.
  // If we found a d2cmedia URL with /1/, generate /2/ through /10/
  if (photos.length < 3) {
    const d2cBase = photos.find(p => /d2cmedia\.ca.*\/1\//i.test(p));
    if (d2cBase) {
      for (let n = 2; n <= 10; n++) {
        addPhoto(d2cBase.replace(/\/1\//, '/' + n + '/'));
      }
    }
  }

  // D2C junk photo filter: marketing images use a different stock ID than the real vehicle photos.
  // Only apply when we have enough photos (>5) to avoid stripping vehicles with few gallery images.
  if (photos.length > 5) {
    const d2cIdRe = /d2cmedia\.ca\/[^/]+\/\d+\/(\d+)\//i;
    const idCounts = {};
    for (const p of photos) {
      const m = p.match(d2cIdRe);
      if (m) idCounts[m[1]] = (idCounts[m[1]] || 0) + 1;
    }
    const ids = Object.entries(idCounts);
    if (ids.length > 1) {
      ids.sort((a, b) => b[1] - a[1]);
      const realId = ids[0][0];
      for (let i = photos.length - 1; i >= 0; i--) {
        const m = photos[i].match(d2cIdRe);
        if (m && m[1] !== realId) { photos.splice(i, 1); }
      }
    }
  }

  // DEBUG: write photo count to DOM
  try { document.documentElement.dataset.ffDebugPhotos = photos.length; } catch(_){}
  try { document.documentElement.dataset.ffDebugFirst = photos[0]?.substring(0, 80) || 'NONE'; } catch(_){}

  // Strategy 2: ALWAYS sweep all <img> for known dealer-photo CDN URLs
  // (was gated on `< 3` — same bug as the server-side scraper had).
  // 2026-04-27: bumped to `< 30` so this fills up to the cap even when
  // Strategy 1's gallery container already returned a healthy-but-
  // incomplete set. Mirrors the server-side fix in lib/scraper.js.
  if (photos.length < 30) {
    document.querySelectorAll('img').forEach(img => {
      const src = getBestSrc(img);
      if (/homenet|dealerphoto|dealerphotos|vehiclephoto|d2cmedia|imagescdn|autotradercdn|getedealer|pictures\.dealer\.com|cdn.*\/(640|800|1024|1280)/i.test(src)) {
        addPhoto(src, img.alt || img.title || '');
      }
    });
  }

  // Strategy 2.5: regex sweep on raw HTML for known dealer-photo CDN
  // URLs that aren't in <img> tags (preload links, JSON blobs, hidden
  // carousel templates, data-* attributes). Hunt VDPs embed ~26+
  // d2cmedia URLs but the gallery <img> selector only sees ~20 — the
  // rest live in non-img DOM. Mirrors lib/scraper.js Strategy 2.5.
  if (photos.length < 30) {
    try {
      const rawHtml = document.documentElement.outerHTML || '';
      const cdnRe = /https?:\/\/[^\s"'<>)\\,]*(?:d2cmedia|imagescdn|autotradercdn|getedealer|dealerphoto|homenet)[^\s"'<>)\\,]*\.(?:jpg|jpeg|png|webp)[^\s"'<>)\\,]*/gi;
      const found = [...new Set(rawHtml.match(cdnRe) || [])];
      for (const url of found) {
        if (photos.length >= 30) break;
        addPhoto(url, '');
      }
    } catch (_) {}
  }

  // Strategy 3: Still nothing? Take any non-junk image over 200px wide
  if (photos.length < 3) {
    document.querySelectorAll('img').forEach(img => {
      const src = getBestSrc(img);
      if (img.naturalWidth >= 200 || /\/(640|800|1024|1280)x/i.test(src)) {
        addPhoto(src, img.alt || img.title || '');
      }
    });
  }

  // Targeted mileage — look for odometer/km label then digits
  let mileage = 0;
  // Pattern 1: "km: 151,000" or "odometer: 89,000 km" or "Kilometres: 293,874" (label before value)
  const odoMatch = body.match(/(?:odometer|mileage|km|kilometers?|kilometres?)[:\s]+([0-9,]{3,7})(?:\s*km)?/i);
  if (odoMatch) {
    const v = parseInt(odoMatch[1].replace(/,/g, ''));
    if (v >= 500 && v <= 400000) mileage = v;
  }
  // Pattern 2: "151,000 km" (value before unit)
  if (!mileage) {
    const kmMatches = [...body.matchAll(/([0-9,]{3,7})\s*km\b/gi)];
    for (const km of kmMatches) {
      const v = parseInt(km[1].replace(/,/g, ''));
      if (v >= 5000 && v <= 400000) { mileage = v; break; }
    }
  }

  // Try to extract exterior color
  let color = '';
  const colorEl = document.querySelector('[class*="color"],[class*="colour"],[class*="Color"],[class*="Colour"]');
  if (colorEl) color = parseColor(colorEl.innerText);
  if (!color) {
    const cm = body.match(/(?:ext(?:erior)?|colour|color)[.:\s#]+([A-Za-z][A-Za-z ]{2,20}?)(?:\n|,|\||\/|\d)/i);
    if (cm) color = parseColor(cm[1]);
  }
  if (!color) color = parseColor(body.substring(0, 3000));

  // Reject prices that are actually the vehicle year (e.g., $2,016 for a 2016 vehicle)
  const vehicleYear = slug.year || parseYear(title) || 0;
  if (price > 0 && price >= 1990 && price <= 2030 && Math.abs(price - vehicleYear) <= 2) price = 0;

  // Fallback: if slug make is numeric-only or empty, parse from page title or h1
  let finalMake  = slug.make  || '';
  let finalModel = slug.model || '';
  let finalTrim  = slug.trim  || '';
  if (!finalMake || /^\d+$/.test(finalMake)) {
    // Try page title: "2021 Tesla Model 3 Standard Plus - Navi / Glassroof - Luminous Luxury"
    const pageTitle = (document.title || '').replace(/\s*[-|].*dealer.*$/i, '').replace(/\s*[-|]\s*[A-Z][a-z]+\s+[A-Z]/,'').trim();
    const titleSlug = parseFromSlug('/' + pageTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '') + '/');
    if (titleSlug.make && !/^\d+$/.test(titleSlug.make)) {
      finalMake  = titleSlug.make;
      finalModel = titleSlug.model || finalModel;
      finalTrim  = titleSlug.trim  || finalTrim;
    }
    // Also try h1 if available
    if (!finalMake || /^\d+$/.test(finalMake)) {
      const titleParts = (title || pageTitle).replace(/^(used|new|pre-?owned)\s+/i, '').replace(/^\d{4}\s+/, '').split(/\s+/);
      if (titleParts[0]) finalMake  = normMake(titleParts[0]);
      // Handle "Model 3", "Model Y", "Model S", "Model X" as a single model name
      if (titleParts[1] && /^model$/i.test(titleParts[1]) && titleParts[2]) {
        finalModel = titleParts[1] + ' ' + titleParts[2];
        if (titleParts.length > 3) finalTrim = titleParts.slice(3).map(p => titleWord(p)).join(' ');
      } else {
        if (titleParts[1]) finalModel = titleWord(titleParts[1]);
        if (titleParts.length > 2) finalTrim = titleParts.slice(2).map(p => titleWord(p)).join(' ');
      }
    }
  }

  // Prefer labeled "Exterior Colour:" over regex-mined `color`
  const _finalColor    = parseColor(_extColorRaw) || color;
  const _finalIntColor = parseColor(_intColorRaw);

  return {
    stock, vin, type,
    mileage,
    price,
    year:      vehicleYear || 2020,
    make:      finalMake,
    model:     finalModel,
    trim:      finalTrim,
    color:     _finalColor,
    condition: 'Used',
    carfax:    0,
    book_value: 0,
    int_color:    _finalIntColor,
    transmission: _transmissionV,
    fuel_type:    _fuelTypeV,
    drive_train:  _driveTrainV,
    engine:       _engineV,
    _title:  title,
    _photos: photos.slice(0, 30),
    _url:    url
  };
}

// ── Main scraper ──────────────────────────────────────────────────────────
function scrapeCurrentPage() {
  const hostname = location.hostname.toLowerCase();
  const url      = location.href;

  // ── 1. Sunridge Auto — data attributes on listing cards (full page in one shot) ──
  if (hostname.includes('sunridgeauto.com')) {
    const cards = document.querySelectorAll('.vehicle-card[data-vehicle-vin], .vehicle-card[data-vehicle-stock]');
    if (cards.length >= 2) {
      const vehicles = [];
      cards.forEach((card, idx) => {
        try {
          const vin      = (card.dataset.vehicleVin   || '').toUpperCase();
          const stock    = card.dataset.vehicleStock   || (vin ? vin.slice(-8) : `GEN${String(idx+1).padStart(3,'0')}`);
          const year     = parseInt(card.dataset.vehicleYear)  || 2020;
          const make     = card.dataset.vehicleMake   || '';
          const model    = card.dataset.vehicleModel  || '';
          const color    = card.dataset.vehicleColour || '';
          const condition= card.dataset.vehicleCondition || 'Used';
          const mileageRaw = parseInt((card.dataset.vehicleOdo || '').replace(/\D/g, '')) || 0;
          const mileage  = mileageRaw > 350000 ? 0 : mileageRaw;
          const price    = parseInt((card.dataset.vehicleInternetPrice || card.dataset.vehicleMsrp || '').replace(/\D/g, '')) || 0;
          // Find the VDP link (not Carfax/external)
          let link = url;
          for (const a of card.querySelectorAll('a[href]')) {
            if (/\/(inventory|vehicles)\//i.test(a.href) && a.href.includes(location.hostname)) { link = a.href; break; }
          }
          if (link === url) link = card.querySelector('a[href]')?.href || url;
          const img      = card.querySelector('img')?.src || '';

          vehicles.push({
            stock, vin, year, make, model, trim: '',
            mileage, price, color,
            type: condition === 'New' ? 'New' : 'Used',
            condition,
            carfax: 0, book_value: 0,
            _title:  `${year} ${make} ${model}`.trim(),
            _photos: img ? [img] : [],
            _url:    link
          });
        } catch (_) {}
      });
      // VDP crawl for photos + cardVehicles for correct prices
      if (vehicles.length > 0) {
        const vdpLinks = vehicles.map(v => v._url).filter(u => u && u !== url);
        if (vdpLinks.length > 0) {
          // Detect D2C-style button pagination — Hunt Chrysler (huntchryslerfiat.ca)
          // and similar sites on the newer D2C platform put .divPaginationBox <li>
          // elements in the DOM with item-value="N" and one button per page.
          // The existing D2C handler (line ~727) only catches sites whose card
          // class is `div.carImage[data-vin][data-make]`; Hunt uses
          // `li.carBoxWrapper[data-carid]` with embedded JSON-LD and falls into
          // this fast-cards path instead. Without d2cSlugPages, the scan stops
          // at page 1 (~36 vehicles). Background.js's d2cSlugPages handler then
          // clicks each page button in a hidden tab and re-scrapes VDP links,
          // and Hunt's VDP URLs (`-id12345.html`) match the existing /-id\d+\.html/
          // regex used there.
          const d2cBoxes = document.querySelectorAll('.divPaginationBox');
          const d2cSlugPages = d2cBoxes.length > 1 ? d2cBoxes.length : 0;
          return { type: 'listing', links: vdpLinks, pageLinks: [], d2cSlugPages, vehicaPagination: 0, url, cardVehicles: vehicles };
        }
        return { type: 'listing_cards', vehicles };
      }
    }

    // Sunridge VDP — parse body text
    const slug = parseFromSlug(url);
    const h1   = document.querySelector('h1')?.innerText || '';
    const body = document.body.innerText;
    return {
      type: 'detail',
      vehicles: [{
        stock:    (url.split('/').filter(Boolean).pop() || 'GEN001').slice(0, 12).toUpperCase(),
        year:     slug.year  || parseYear(h1) || 2020,
        make:     slug.make  || '',
        model:    slug.model || '',
        trim:     '',
        mileage:  parseMileage(body),
        price:    parsePrice(body.match(/\$([\d,]+)/)?.[0] || ''),
        vin:      slug.vin   || '',
        color: '', type: 'Used', condition: 'Used', carfax: 0, book_value: 0,
        _title:  clean(h1),
        _photos: [],
        _url:    url
      }]
    };
  }

  // ── 1b. Convertus / Achilles dealer.com platform — listing-only mode ──
  //    Detected by .vehicle-card[data-vehicle-vin] cards (same data-attr scheme
  //    Sunridge uses, but found across many Convertus-hosted Canadian dealers
  //    including miltonchrysler.ca, huntchrysler.ca, etc.). These sites are
  //    Cloudflare-protected, which blocks VDP crawls — so we extract everything
  //    we need from the listing cards and skip VDP. Photos are the one casualty
  //    (single thumbnail per vehicle), but VIN/stock/YMM/price/mileage/color
  //    all come through cleanly.
  {
    const convertusCards = document.querySelectorAll('.vehicle-card[data-vehicle-vin]');
    if (convertusCards.length >= 2) {
      const vehicles = [];
      convertusCards.forEach((card, idx) => {
        try {
          const vin       = (card.dataset.vehicleVin || '').toUpperCase();
          const stock     = card.dataset.vehicleStock || (vin ? vin.slice(-8) : `GEN${String(idx+1).padStart(3,'0')}`);
          const year      = parseInt(card.dataset.vehicleYear) || 2020;
          const make      = card.dataset.vehicleMake  || '';
          const model     = card.dataset.vehicleModel || '';
          const trim      = clean(card.dataset.vehicleTrim || '').replace(/[, ]+$/, '');
          const color     = card.dataset.vehicleColour || '';
          const condition = card.dataset.vehicleCondition || 'Used';
          const mileageRaw = parseInt((card.dataset.vehicleOdo || '').replace(/\D/g, '')) || 0;
          const mileage   = mileageRaw > 350000 ? 0 : mileageRaw;
          const price     = parseInt((card.dataset.vehicleInternetPrice || card.dataset.vehicleMsrp || '').replace(/\D/g, '')) || 0;

          let link = url;
          for (const a of card.querySelectorAll('a[href]')) {
            if (a.href.includes(location.hostname) && /\/(inventory|vehicles)\//i.test(a.href)) { link = a.href; break; }
          }

          // Filter out badges (carfax, equifax, certified, td, etc.) — only
          // real vehicle photos from photomanager / autotradercdn / dealer CDN.
          // Convertus carousels hide additional thumbnails behind background-image
          // styles + data-src lazy-load attrs, so scan multiple sources.
          const photos      = [];
          const photoSeen   = new Set();
          const BAD_RE      = /badge|certified|carfax|equifax|td-icon|equityplus|eshop|favicon|logo|sprite|placeholder/i;
          const GOOD_RE     = /photomanager|autotradercdn|dealer\.com|inventory|vehicle|cdn\.dealer|d2cmedia|homenet|getedealer/i;
          const tryPushPhoto = (raw) => {
            if (!raw) return;
            const u = String(raw).trim().replace(/^["']|["']$/g, '');
            if (!u || photoSeen.has(u)) return;
            if (BAD_RE.test(u)) return;
            if (!GOOD_RE.test(u)) return;
            photoSeen.add(u);
            photos.push(u);
          };

          // 1. Standard <img src/data-src/srcset>
          card.querySelectorAll('img').forEach(img => {
            tryPushPhoto(img.src);
            tryPushPhoto(img.dataset.src);
            tryPushPhoto(img.dataset.lazySrc);
            tryPushPhoto(img.getAttribute('data-original'));
            const srcset = img.getAttribute('srcset') || '';
            srcset.split(',').forEach(s => tryPushPhoto((s.trim().split(/\s+/)[0] || '')));
          });

          // 2. Inline background-image styles (Convertus hides slides this way)
          card.querySelectorAll('[style*="background"]').forEach(el => {
            const style = el.getAttribute('style') || '';
            const matches = style.match(/url\(([^)]+)\)/gi) || [];
            matches.forEach(m => tryPushPhoto(m.replace(/^url\(|\)$/gi, '')));
          });

          // 3. Common photo data attributes
          ['data-photo','data-image','data-bg','data-bg-image','data-src','data-photos'].forEach(attr => {
            card.querySelectorAll('[' + attr + ']').forEach(el => {
              const v = el.getAttribute(attr) || '';
              // Could be JSON array, comma-list, or single URL
              if (v.startsWith('[') || v.startsWith('{')) {
                try { const parsed = JSON.parse(v); (Array.isArray(parsed) ? parsed : [parsed]).forEach(p => tryPushPhoto(typeof p === 'string' ? p : p.url || p.src || '')); } catch(_){}
              } else if (v.includes(',')) {
                v.split(',').forEach(s => tryPushPhoto(s.trim()));
              } else {
                tryPushPhoto(v);
              }
            });
          });

          // 2026-04-27: dropped the explicit truncate — the slice(0, 30)
          // on _photos below is the actual cap, and the in-loop truncate
          // was leaving Hunt-style VDPs at exactly 20 photos when they
          // had more available. Keep up to 30 so dealers can pick the
          // best 20 in FB Poster.

          vehicles.push({
            stock, vin, year, make, model, trim,
            mileage, price, color,
            type: condition === 'New' ? 'New' : 'Used',
            condition,
            carfax: 0, book_value: 0,
            _title:  `${year} ${make} ${model}${trim ? ' ' + trim : ''}`.trim(),
            _photos: photos.slice(0, 30),
            _url:    link
          });
        } catch (_) {}
      });
      if (vehicles.length > 0) {
        return { type: 'listing_cards', vehicles };
      }
    }
  }

  // ── 2. Auto-detect VDP listing pages by link pattern ──────────────────
  //    Works for House of Cars, Automaxx, Stampede Auto, D2C Media (Renfrew), and similar sites.
  //    Matches: /inventory/Used-2023-, /vehicle-details/2023-, /vehicle/2023-, /vehicles/2023-
  //    D2C Media: /demos/2026-RAM-, /used/2024-Ford-, /new/inventory/2026-RAM-
  const VDP_LINK_RE = /\/(inventory\/((Used|New)-)?|vehicle-details\/|vehicle\/|vehicles\/|demos\/|used\/([^/]+\/)?|certified\/([^/]+\/)?|new\/inventory\/)\d{4}[-\/]/i;
  const isVdpDetail = VDP_LINK_RE.test(location.pathname);

  // ── eDealer (Applewood Nissan, etc.) — data-vin + data-slug cards ──────────
  if (!isVdpDetail) {
    const edCards = document.querySelectorAll('div.cell.card[data-vin][data-slug]');
    if (edCards.length >= 2) {
      const seenSlug = new Set();
      const vdpLinks = [];
      const cardVehicles = [];
      edCards.forEach((card, idx) => {
        const slug = card.dataset.slug;
        if (!slug || seenSlug.has(slug)) return;
        seenSlug.add(slug);
        const link = location.origin + '/inventory/' + slug;
        vdpLinks.push(link);
        // Extract data from attributes + text
        const text = card.innerText || '';
        const kmM = text.replace(/,/g, '').match(/(\d+)\s*km/i);
        const mileage = kmM ? parseInt(kmM[1]) : 0;
        const img = card.querySelector('img');
        const imgSrc = img ? (img.src || img.dataset.src || '') : '';
        cardVehicles.push({
          stock:    card.dataset.stocknumber || '',
          vin:      card.dataset.vin || '',
          year:     parseInt(card.dataset.year) || 2020,
          make:     card.dataset.make || '',
          model:    card.dataset.model || '',
          trim:     card.dataset.trim || '',
          mileage,
          price:    parseInt(card.dataset.price) || 0,
          color:    card.dataset.color || '',
          type:     (card.dataset.condition || '').toUpperCase() === 'NEW' ? 'New' : 'Used',
          condition: card.dataset.conditionname || card.dataset.condition || 'Used',
          carfax: 0, book_value: 0,
          _title: card.dataset.name || '',
          _photos: imgSrc ? [imgSrc] : [],
          _url: link
        });
      });
      if (vdpLinks.length > 0) {
        // eDealer pagination: generate all ?page=N URLs from total count
        const pageLinks = [];
        const perPage = vdpLinks.length;
        // Try to find total count from page text (e.g., "46 Results", "46 Vehicles")
        const countEl = document.querySelector('.results-count, .inventory-count, [class*="result"]');
        const countText = (countEl ? countEl.textContent : document.body.innerText.slice(0, 3000)) || '';
        const countMatch = countText.match(/(\d+)\s*(Results?|Vehicles?|Found|Cars?|listings?)/i);
        const totalVehicles = countMatch ? parseInt(countMatch[1]) : 0;
        if (totalVehicles > perPage) {
          const totalPages = Math.ceil(totalVehicles / perPage);
          const baseUrl = new URL(location.href);
          for (let p = 1; p <= totalPages; p++) {
            baseUrl.searchParams.set('page', p);
            const pageUrl = baseUrl.toString();
            if (pageUrl !== location.href) pageLinks.push(pageUrl);
          }
        } else {
          // Fallback: find ?page=N links on the page
          const pageSeen = new Set([location.href]);
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href || '';
            if (pageSeen.has(href)) return;
            if (/[?&]page=\d+/.test(href) && href.includes(location.hostname)) {
              pageSeen.add(href);
              pageLinks.push(href);
            }
          });
        }
        return { type: 'listing', links: vdpLinks, pageLinks, vehicaPagination: 0, url: location.href, cardVehicles };
      }
    }
  }

  // ── D2C Media (Renfrew Chrysler, etc.) — data-vin cards with rich attributes ──
  if (!isVdpDetail) {
    const d2cCards = document.querySelectorAll('div.carImage[data-vin][data-make]');
    if (d2cCards.length >= 2) {
      // D2C has data attributes on cards + VDP links — use VDP crawl for photos
      const seen = new Set();
      const vdpLinks = [];
      d2cCards.forEach(card => {
        const link = card.querySelector('a[href]')?.href;
        if (link && !seen.has(link) && VDP_LINK_RE.test(link)) {
          seen.add(link);
          vdpLinks.push(link);
        }
      });
      if (vdpLinks.length > 0) {
        // D2C pagination: construct page URLs by modifying the filterid param
        // D2C uses filterid=...qN... where N is the 0-based page index
        const d2cPageBoxes = document.querySelectorAll('.divPaginationBox');
        const d2cPageLinks = [];
        let d2cSlugPages = 0;
        if (d2cPageBoxes.length > 1) {
          const curUrl = location.href;
          if (/filterid=.*q\d+/.test(curUrl)) {
            // filterid URL — construct page URLs by replacing q0→q1, q2, etc.
            for (let p = 1; p < d2cPageBoxes.length; p++) {
              const pageUrl = curUrl.replace(/q\d+/, 'q' + p);
              if (pageUrl !== curUrl) d2cPageLinks.push(pageUrl);
            }
          } else {
            // Slug URL (/used/Jeep.html) — no filterid, need button-click pagination
            d2cSlugPages = d2cPageBoxes.length;
          }
        }
        return { type: 'listing', links: vdpLinks, pageLinks: d2cPageLinks, d2cSlugPages, vehicaPagination: 0, url: location.href };
      }
    }
  }

  if (!isVdpDetail) {
    // ── Try listing card extraction first (fast, server-rendered, no JS issues) ─
    // If cards have prices, skip the slow VDP crawl entirely
    const CARD_SELS_FAST = [
      '.vehicle-card', '.inventory-item', '.listing-item', '.car-card',
      '.vehicle-listing', 'article.vehicle', '.carbox-wrap', '.carbox',
      '[class*="inventory-card"]', '[class*="vehicle-item"]', 'li.vehicle'
    ];
    let fastCards = [];
    for (const sel of CARD_SELS_FAST) {
      const found = document.querySelectorAll(sel);
      if (found.length >= 2) { fastCards = Array.from(found); break; }
    }
    if (fastCards.length >= 2) {
      const cardVehicles = [];
      fastCards.forEach((card, idx) => {
        try {
          const text    = clean(card.innerText);
          // Find the VDP link first (not Carfax/tel/external links)
          let link = location.href;
          const cardLinks = card.querySelectorAll('a[href]');
          for (const a of cardLinks) {
            if (VDP_LINK_RE.test(a.href)) { link = a.href; break; }
          }
          if (link === location.href) {
            // Fallback: any link on the same domain that's not carfax/tel
            for (const a of cardLinks) {
              if (a.href.includes(location.hostname) && !a.href.includes('carfax') && !a.href.startsWith('tel:') && a.pathname !== '/') { link = a.href; break; }
            }
          }
          const slug    = parseFromSlug(link);
          // Stock# from card text
          const stockM  = text.match(/stock\s*#?\s*[:\-]?\s*([A-Z0-9\-]{4,12})/i);
          const stock   = stockM ? stockM[1].toUpperCase()
                        : slug.vin ? slug.vin.slice(-8)
                        : `GEN${String(idx+1).padStart(3,'0')}`;
          // Title
          let title = clean(card.querySelector('h2,h3,.title,.name,.vehicle-title')?.innerText || '');
          title = title.replace(/^(used|new|pre-?owned)\s+/i,'').trim();
          // Price — prefer sale/current price over "Was" price; take lowest valid value
          let price = 0;
          // First pass: skip "Was / Original / MSRP / Regular" labels
          card.querySelectorAll('[class*="price"],[class*="Price"],.price').forEach(el => {
            const txt = el.innerText || '';
            if (/\b(was|original|msrp|regular|list)\b/i.test(txt)) return;
            const p = parsePrice(txt);
            if (p >= 1000 && (price === 0 || p < price)) price = p;
          });
          // Second pass fallback: accept any price element, still take lowest
          if (!price) {
            card.querySelectorAll('[class*="price"],[class*="Price"],.price').forEach(el => {
              const p = parsePrice(el.innerText);
              if (p >= 1000 && (price === 0 || p < price)) price = p;
            });
          }
          if (!price) price = parsePrice(text);
          // Mileage — find km values in odometer range
          let mileage = 0;
          const kmAll = [...text.matchAll(/([0-9,]{3,7})\s*km/gi)];
          for (const m of kmAll) {
            const v = parseInt(m[1].replace(/,/g,''));
            if (v >= 500 && v <= 400000) { mileage = v; break; }
          }
          const img = card.querySelector('img')?.src || '';
          // Try to get color from a dedicated element first, then card text
          let color = '';
          const colorEl = card.querySelector('[class*="color"],[class*="colour"],[class*="Color"],[class*="Colour"]');
          if (colorEl) color = parseColor(colorEl.innerText);
          if (!color) color = parseColor(text);
          cardVehicles.push({
            stock, vin: slug.vin || '',
            year:  slug.year  || parseYear(text) || 2020,
            make:  slug.make  || '',
            model: slug.model || '',
            trim:  slug.trim  || '',
            mileage, price,
            color, type: 'Used', condition: 'Used', carfax: 0, book_value: 0,
            _title: title, _photos: img ? [img] : [], _url: link
          });
        } catch(_) {}
      });
      // If more than half have real prices, use card data
      const priced = cardVehicles.filter(v => v.price >= 1000).length;
      if (priced > cardVehicles.length * 0.4) {
        // Check if there are additional pages — if so, tell popup to crawl them too
        const pageSeen = new Set([location.href]);
        const extraPages = [];
        // Automaxx-style slug pagination + ?page=N + Dealer.com ?start=N links
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          if (pageSeen.has(href)) return;
          if (/\/(used|new|pre-?owned)-page-\d+\b/i.test(href) || /\/page-\d+/i.test(href) ||
              /[?&](page|pg|p)=\d+/i.test(href) || /\/page\/\d+/i.test(href)) {
            try { if (new URL(href).hostname !== location.hostname) return; } catch { return; }
            pageSeen.add(href);
            extraPages.push(href);
          }
          // Dealer.com ?start=N — merge with current URL to preserve filters
          const startM = href.match(/[?&]start=(\d+)/i);
          if (startM && parseInt(startM[1]) > 0) {
            const merged = new URL(location.href);
            merged.searchParams.set('start', startM[1]);
            const full = merged.toString();
            if (!pageSeen.has(full)) { pageSeen.add(full); extraPages.push(full); }
          }
        });
        // Vehica Vue-rendered pagination (divs, not links) — always check, merge with above
        const vehicaPages = document.querySelectorAll('.vehica-pagination__page:not(.vehica-pagination__page--active)');
        if (vehicaPages.length) {
          const base = new URL(location.href);
          vehicaPages.forEach(div => {
            const num = parseInt(div.textContent.trim());
            if (num && num > 1) {
              base.searchParams.set('page', num);
              const href = base.toString();
              if (!pageSeen.has(href)) { pageSeen.add(href); extraPages.push(href); }
            }
          });
        }
        // Always check for VDP links — use VDP crawl to get full photos.
        // Dedupe by pathname so /vehicles/.../67541008/?x=1 and
        // /vehicles/.../67541008/?x=1?retailing don't both make the cut
        // (Milton Chrysler / Convertus emit both variants per card, doubling the count).
        const seen  = new Set();
        const vdpLinks = [];
        document.querySelectorAll('a[href]').forEach(a => {
          if (!VDP_LINK_RE.test(a.href)) return;
          let key; try { key = new URL(a.href).pathname; } catch(_) { key = a.href.split('?')[0]; }
          if (!seen.has(key)) { seen.add(key); vdpLinks.push(a.href); }
        });
        if (vdpLinks.length > 0) {
          // Detect Vehica Vue pagination — calculate total pages from vehicle count
          // Vehica shows a sliding window of page buttons (e.g., 1-7) not all pages
          const vehicaPageDivs = document.querySelectorAll('.vehica-pagination__page');
          let vehicaPagination = 0;
          if (vehicaPageDivs.length > 1) {
            const countMatch = document.body.innerText.match(/(\d+)\s*Used\s*(cars|vehicles|trucks)/i);
            const totalVehicles = countMatch ? parseInt(countMatch[1]) : 0;
            const perPage = vdpLinks.length || 16;
            if (totalVehicles > perPage) {
              vehicaPagination = Math.ceil(totalVehicles / perPage);
            } else {
              vehicaPagination = vehicaPageDivs.length;
            }
          }
          // Vehica base URL fallback: no pagination divs but "NNN Used cars" text
          if (vehicaPagination === 0 && !extraPages.length) {
            const countFB = document.body.innerText.match(/(\d+)\s*Used\s*(cars|vehicles|trucks)/i);
            if (countFB) {
              const total = parseInt(countFB[1]);
              const perPage = vdpLinks.length || 16;
              if (total > perPage) {
                const base = new URL(location.href);
                const totalPages = Math.ceil(total / perPage);
                for (let p = 2; p <= totalPages; p++) {
                  base.searchParams.set('page', p);
                  extraPages.push(base.toString());
                }
              }
            }
          }
          return { type: 'listing', links: vdpLinks, pageLinks: extraPages, vehicaPagination, url: location.href };
        }
        // No VDP links — use card data as-is (single photos)
        return { type: 'listing_cards', vehicles: cardVehicles };
      }
    }

    // Dedupe by URL pathname so the same VDP linked twice with different
    // querystrings (Convertus does this per card) doesn't get crawled twice.
    const seen  = new Set();
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      if (!VDP_LINK_RE.test(a.href)) return;
      let key; try { key = new URL(a.href).pathname; } catch(_) { key = a.href.split('?')[0]; }
      if (!seen.has(key)) { seen.add(key); links.push(a.href); }
    });

    if (links.length > 0) {
      // Detect pagination links so background can crawl all pages
      const pageSeen = new Set([location.href]);
      const pageLinks = [];
      const paginationSels = [
        '.pagination', '[class*="pagination"]', '.pager',
        '[class*="pager"]', '.page-numbers', 'nav.pages',
        '[aria-label*="page"]', '[aria-label*="pagination"]'
      ];
      let foundInContainer = false;
      for (const sel of paginationSels) {
        document.querySelectorAll(sel).forEach(container => {
          container.querySelectorAll('a[href]').forEach(a => {
            let href = a.href;
            if (!href) return;
            try { if (new URL(href).hostname !== location.hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return; // skip VDP links
            // Merge offset/start params with current URL to preserve filters
            const startM = href.match(/[?&]start=(\d+)/i);
            if (startM) {
              if (parseInt(startM[1]) === 0) return; // skip page 1 duplicate
              const merged = new URL(location.href);
              merged.searchParams.set('start', startM[1]);
              href = merged.toString();
            }
            if (pageSeen.has(href)) return;
            pageSeen.add(href);
            pageLinks.push(href);
            foundInContainer = true;
          });
        });
        if (foundInContainer) break;
      }
      // Fallback: ?page= or /page/ or ?start= URL patterns anywhere on page
      if (!foundInContainer) {
        const curBase = new URL(location.href);
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          if (pageSeen.has(href)) return;
          if (/[?&](page|pg|p|pagenumber)=\d+/i.test(href) || /\/page\/\d+/i.test(href)) {
            try { if (new URL(href).hostname !== location.hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return;
            pageSeen.add(href);
            pageLinks.push(href);
          }
          // Dealer.com ?start=N pagination — merge with current URL params, skip start=0
          const startM = href.match(/[?&]start=(\d+)/i);
          if (startM && parseInt(startM[1]) > 0) {
            const merged = new URL(location.href);
            merged.searchParams.set('start', startM[1]);
            const full = merged.toString();
            if (!pageSeen.has(full)) {
              pageSeen.add(full);
              pageLinks.push(full);
            }
          }
        });
      }
      // Automaxx-style slug pagination: /inventory/used-page-2/ or /inventory/new-page-3/
      if (!pageLinks.length) {
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          if (pageSeen.has(href)) return;
          if (/\/(used|new|pre-?owned)-page-\d+\b/i.test(href) ||
              /\/inventory\/page-\d+/i.test(href) ||
              /\/page-\d+\//i.test(href)) {
            try { if (new URL(href).hostname !== location.hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return;
            pageSeen.add(href);
            pageLinks.push(href);
          }
        });
      }
      // Vehica (WordPress theme) Vue-rendered pagination — divs, not links
      // Detect .vehica-pagination__page divs and build ?page=N URLs
      if (!pageLinks.length) {
        const vehicaPages = document.querySelectorAll('.vehica-pagination__page:not(.vehica-pagination__page--active)');
        if (vehicaPages.length) {
          const base = new URL(location.href);
          vehicaPages.forEach(div => {
            const num = parseInt(div.textContent.trim());
            if (num && num > 1) {
              base.searchParams.set('page', num);
              const href = base.toString();
              if (!pageSeen.has(href)) { pageSeen.add(href); pageLinks.push(href); }
            }
          });
        }
      }
      const vehicaPageDivs2 = document.querySelectorAll('.vehica-pagination__page');
      let vehicaPagination = 0;
      if (vehicaPageDivs2.length > 1) {
        const countMatch2 = document.body.innerText.match(/(\d+)\s*Used\s*(cars|vehicles|trucks)/i);
        const totalVehicles2 = countMatch2 ? parseInt(countMatch2[1]) : 0;
        const perPage2 = links.length || 16;
        vehicaPagination = totalVehicles2 > perPage2 ? Math.ceil(totalVehicles2 / perPage2) : vehicaPageDivs2.length;
      }
      // Vehica base URL fallback: no pagination divs rendered but "NNN Used cars" text exists
      // Calculate pages from total count ÷ per-page and generate ?page=N links
      if (vehicaPagination === 0 && !pageLinks.length) {
        const countFallback = document.body.innerText.match(/(\d+)\s*Used\s*(cars|vehicles|trucks)/i);
        if (countFallback) {
          const total = parseInt(countFallback[1]);
          const perPage = links.length || 16;
          if (total > perPage) {
            const totalPages = Math.ceil(total / perPage);
            const base = new URL(location.href);
            for (let p = 2; p <= totalPages; p++) {
              base.searchParams.set('page', p);
              const href = base.toString();
              if (!pageSeen.has(href)) { pageSeen.add(href); pageLinks.push(href); }
            }
          }
        }
      }
      // Detect "load more" / infinite scroll buttons (Algolia, etc.)
      const hasLoadMore = !!document.querySelector('.ais-InfiniteHits-loadMore, [class*="load-more"], [class*="loadmore"]');
      return { type: 'listing', links, pageLinks, vehicaPagination, hasLoadMore, url };
    }
  }

  if (isVdpDetail) {
    const vdpResult = parseVdpDetail(url);
    console.log('[FF-DEBUG] VDP result for', url, '→ photos:', vdpResult._photos?.length, 'first:', vdpResult._photos?.[0]?.substring(0, 60));
    return { type: 'detail', vehicles: [vdpResult] };
  }

  // ── 3. Generic dealer site — card selectors ───────────────────────────
  const CARD_SELS = [
    '.vehicle-card', '.inventory-item', '.listing-item', '.car-card',
    '.vehicle-listing', 'article.vehicle', 'article.type-vehicle',
    '[class*="inventory-card"]', '[class*="vehicle-item"]',
    '.inventory-listing article', 'li.vehicle',
    '.carbox-wrap', '.carbox',              // Automaxx listing cards
    '.result-item', '.srp-list-item',       // Generic SRP patterns
  ];

  let cards = [];
  for (const sel of CARD_SELS) {
    const found = document.querySelectorAll(sel);
    if (found.length >= 2) { cards = Array.from(found); break; }
  }

  if (cards.length === 0) {
    // Single vehicle detail page — parse as best we can
    const body    = document.body.innerText;
    const slugData = parseFromSlug(url);
    const h1Text  = document.querySelector('h1')?.innerText || '';
    return {
      type: 'detail',
      vehicles: [{
        stock:    (url.split('/').filter(Boolean).pop() || 'GEN001').slice(0, 12).toUpperCase(),
        year:     slugData.year  || parseYear(h1Text) || 2020,
        make:     slugData.make  || '',
        model:    slugData.model || '',
        trim:     slugData.trim  || '',
        mileage:  parseMileage(body),
        price:    parsePrice(body.match(/\$([\d,]+)/)?.[0] || ''),
        vin:      slugData.vin   || '',
        color: '', type: 'Used', condition: 'Used', carfax: 0, book_value: 0,
        _title:   clean(h1Text),
        _photos:  [],
        _url:     url
      }]
    };
  }

  // Multiple vehicle cards — generic parsing
  const vehicles = [];
  cards.forEach((card, idx) => {
    try {
      const text     = clean(card.innerText);
      // Find VDP link first, avoid Carfax/tel/external
      let link = url;
      for (const a of card.querySelectorAll('a[href]')) {
        if (/\/inventory\/(Used|New)-\d{4}-/i.test(a.href)) { link = a.href; break; }
      }
      if (link === url) {
        for (const a of card.querySelectorAll('a[href]')) {
          if (a.href.includes(location.hostname) && !a.href.includes('carfax') && !a.href.startsWith('tel:') && a.pathname !== '/') { link = a.href; break; }
        }
      }
      const slugData = parseFromSlug(link);

      let title = clean(card.querySelector('h2,h3,.title,.name,.vehicle-title,.srp-vehicle-title')?.innerText || '');
      title = title.replace(/^(used|new|pre-?owned)\s+/i, '').trim();

      const priceEl = card.querySelector('[class*="price"],[class*="Price"]');
      const price   = priceEl ? parsePrice(priceEl.innerText) : parsePrice(text.match(/\$([\d,]+)/)?.[0] || '');
      const img     = card.querySelector('img')?.src || '';

      vehicles.push({
        stock:    slugData.vin ? slugData.vin.slice(-8) : `GEN${String(idx + 1).padStart(3, '0')}`,
        year:     slugData.year  || parseYear(text)  || 2020,
        make:     slugData.make  || '',
        model:    slugData.model || '',
        trim:     slugData.trim  || '',
        mileage:  parseMileage(text),
        price,
        vin:      slugData.vin || '',
        color: '', type: 'Used', condition: 'Used', carfax: 0, book_value: 0,
        _title:   title,
        _photos:  img ? [img] : [],
        _url:     link
      });
    } catch (_) {}
  });

  return { type: 'listing_cards', vehicles };
}

// ── Convertus VDP lightbox photo extractor ──────────────────────────────
// Runs IN THE VDP TAB after background.js navigates there. Clicks the
// View Photos lightbox to force the carousel to populate the DOM with
// all 24-26 photos, then scrapes them. Returns up to 25 unique photos.
//
// This is exposed on `window` so background.js can call it via
// chrome.scripting.executeScript({ func: () => window.__FF_extractVdpLightboxPhotos() }).
async function __FF_extractVdpLightboxPhotos() {
  // Step 1: wait for VDP JS to render the gallery (5s is the safe minimum;
  // pages with slow CDNs occasionally need 6-7s).
  await new Promise(r => setTimeout(r, 5000));

  // Step 2: find the EXACT lightbox trigger and click it. The match must
  // hit `.button.view-photos` specifically — matching `.view-photos` alone
  // can grab the wrapper and silently no-op.
  const trigger = document.querySelector('.button.view-photos, div.button.view-photos');
  if (trigger) {
    const rect = trigger.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    try { trigger.dispatchEvent(new PointerEvent('pointerdown', init)); } catch(_){}
    try { trigger.dispatchEvent(new MouseEvent('mousedown', init)); } catch(_){}
    try { trigger.dispatchEvent(new PointerEvent('pointerup', init)); } catch(_){}
    try { trigger.dispatchEvent(new MouseEvent('mouseup', init)); } catch(_){}
    try { trigger.dispatchEvent(new MouseEvent('click', init)); } catch(_){}
    try { trigger.click(); } catch(_){}
    // Wait for lightbox XHR/template to populate
    await new Promise(r => setTimeout(r, 4000));
  }

  // Step 3: scrape ALL autotradercdn photo URLs from the document.
  // Dedupe by UUID (each photo has multiple size variants like -1024x786
  // and -2048x1536 — keep the largest).
  const html = document.documentElement.outerHTML;
  const allUrls = html.match(/https?:\/\/[^\s"'<>)\\,]*autotradercdn[^\s"'<>)\\,]*\.(?:jpg|jpeg|png|webp)[^\s"'<>)\\,]*/gi) || [];
  const byUuid = new Map();
  for (const url of allUrls) {
    const uuidMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    const key = uuidMatch ? uuidMatch[1] : url;
    const existing = byUuid.get(key);
    if (!existing) { byUuid.set(key, url); continue; }
    // Prefer larger size variant
    const sizeNew = parseInt(url.match(/-(\d+)x\d+/)?.[1] || '0');
    const sizeOld = parseInt(existing.match(/-(\d+)x\d+/)?.[1] || '0');
    if (sizeNew > sizeOld) byUuid.set(key, url);
  }
  // Filter out obvious non-vehicle images (badges, logos, overlays)
  const photos = [...byUuid.values()].filter(u =>
    !/badge|logo|favicon|sprite|placeholder|gubagoo|certified.*generic|car-fax-badge/i.test(u)
  );
  return photos.slice(0, 30);
}
// Expose on window for executeScript func: () => calls
try { window.__FF_extractVdpLightboxPhotos = __FF_extractVdpLightboxPhotos; } catch(_){}

// ── Pagination post-processor ────────────────────────────────────────────
// scrapeCurrentPage() has many platform-specific code paths; some set
// d2cSlugPages (existing D2C carImage handler) and some don't (the generic
// VDP-link detector that catches Hunt Chrysler / huntchryslerfiat.ca).
// Rather than touching every return statement, we post-process here: if
// the result is a 'listing' type and d2cSlugPages wasn't already set, scan
// the DOM for .divPaginationBox elements (D2C-style numbered page buttons)
// and inject d2cSlugPages so background.js's slug-pagination handler can
// click through pages 2..N.
function _scrapeAndAugment() {
  const result = scrapeCurrentPage();
  if (result && result.type === 'listing' && !result.d2cSlugPages) {
    try {
      const boxes = document.querySelectorAll('.divPaginationBox');
      if (boxes.length > 1) {
        result.d2cSlugPages = boxes.length;
        console.log('[FIRST-FIN] post-process: detected ' + boxes.length + ' pagination buttons');
      }
    } catch (_) {}
  }
  return result;
}

// ── Message listener (server-first with client fallback) ─────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // SCRAPE_LOCAL: client-only scrape — used by background.js to avoid server relay deadlock
  if (msg.type === 'SCRAPE_LOCAL') {
    try {
      const result = _scrapeAndAugment();
      sendResponse({ ok: true, result });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return false;
  }

  if (msg.type !== 'SCRAPE') return false;

  // Client-side fallback — the original v2.5 scraper (always works)
  function fallbackScrape() {
    try {
      const result = _scrapeAndAugment();
      console.log('[FF] CLIENT scrape:', result.type, 'vehicles:', result.vehicles?.length);
      sendResponse({ ok: true, result });
    } catch (e) {
      console.error('[FF] CLIENT scrape error:', e.message);
      sendResponse({ ok: false, error: e.message });
    }
  }

  // CONVERTUS SHORT-CIRCUIT: skip the server-side scrape (which only returns
  // raw VDP links). Listing cards already expose VIN/stock/YMM/price/etc.
  // Photos beyond the card thumbnail (12-26 per vehicle) live behind the
  // VDP lightbox and are picked up by background.js in a deep-scan phase
  // that opens each VDP, clicks .view-photos, and scrapes the rendered DOM.
  if (document.querySelectorAll('.vehicle-card[data-vehicle-vin]').length >= 2) {
    console.log('[FF] Convertus cards detected — using client scrape (deep photos via background)');
    fallbackScrape();
    return false;
  }

  // Try server-first: capture HTML, send to server for parsing
  try {
    const html = document.documentElement.outerHTML;
    const url = location.href;
    // Only attempt server if page has enough content
    if (html.length < 500) { fallbackScrape(); return false; }

    chrome.runtime.sendMessage(
      { type: 'FF_SERVER_SCRAPE', html, url },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok || !resp?.result) {
          console.log('[FF] Server scrape failed, using client fallback');
          fallbackScrape();
          return;
        }
        console.log('[FF] SERVER scrape:', resp.result.type, 'vehicles:', resp.result.vehicles?.length);
        sendResponse({ ok: true, result: resp.result });
      }
    );
  } catch (e) {
    console.log('[FF] Server attempt error, using client fallback:', e.message);
    fallbackScrape();
    return false;
  }
  return true; // keep channel open for async server response
});

// ── FB Auto-Fill relay (only on the FIRST-FIN platform) ──────────────────
if (location.hostname === 'app.firstfinancialcanada.com') {
  // Page-side errors are surfaced back via window.postMessage so the
  // FB Poster UI can show a toast instead of failing silently (e.g.,
  // service worker dormant, extension context invalidated after reload).
  const postErr = (error) => {
    try {
      window.postMessage({ type: 'FIRSTFIN_FB_AUTOFILL_ERROR', error: String(error).slice(0, 200) }, '*');
    } catch {}
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'FIRSTFIN_FB_AUTOFILL') return;
    try {
      chrome.runtime.sendMessage({
        type: 'FB_AUTOFILL',
        vehicle: event.data.vehicle
      }, (_resp) => {
        // Detect dead service worker or invalidated context
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) postErr('Extension unavailable: ' + err.message + ' — try reloading the page');
      });
    } catch (e) {
      postErr('Extension not responding: ' + (e.message || e) + ' — reload the page');
    }
  });

  // Errors raised asynchronously inside the background worker are relayed
  // back here via chrome.tabs.sendMessage and forwarded to the page.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'FB_AUTOFILL_ERROR') postErr(msg.error || 'Auto-fill failed');
  });
}

} // end __FIRSTFIN_LOADED guard
