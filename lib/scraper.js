// lib/scraper.js — Server-side page scraper (PROPRIETARY — never sent to client)
// Parses dealer inventory pages using cheerio. All detection patterns, selectors,
// and parsing logic stays on the server. The Chrome extension only captures raw HTML.
'use strict';
const cheerio = require('cheerio');

// ── Text helpers (pure functions, no DOM) ────────────────────────────────
function clean(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

function parsePrice(t) {
  const s = (t || '').replace(/,/g, '');
  const m = s.match(/\$\s*(\d{4,6})(?!\d)/);
  if (m) return parseInt(m[1]);
  const m2 = s.match(/\$?\s*(\d+)/);
  const v = m2 ? parseInt(m2[1]) : 0;
  return v >= 1000 ? v : 0;
}

function parseYear(t) {
  const m = (t || '').match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0]) : null;
}

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
  const labeled = (t || '').match(/(?:kilometres?|kilometers?|odometer|mileage)[:\s]+([0-9,]{3,7})/i);
  if (labeled) { const v = parseInt(labeled[1].replace(/,/g, '')); if (v >= 500 && v <= 400000) return v; }
  const m = (t || '').replace(/,/g, '').match(/([\d]+)\s*k(?:m|ilometers?|ilometres?)?/i);
  if (m) { const v = parseInt(m[1]); return v > 350000 ? 0 : v; }
  const m2 = (t || '').replace(/,/g, '').match(/([\d]+)\s*km/i);
  if (m2) { const v = parseInt(m2[1]); return v > 350000 ? 0 : v; }
  return 0;
}

function parseFromSlug(url) {
  const pathSegs = (url || '').replace(/\?.*/, '').split('/').filter(Boolean);
  const vehIdx = pathSegs.indexOf('vehicles');
  if (vehIdx >= 0 && pathSegs[vehIdx + 1] && /^\d{4}$/.test(pathSegs[vehIdx + 1])) {
    return {
      year: parseInt(pathSegs[vehIdx + 1]) || 0,
      make: normMake(pathSegs[vehIdx + 2] || ''),
      model: titleWord(pathSegs[vehIdx + 3] || ''),
      trim: ''
    };
  }
  let slug = pathSegs.pop() || '';
  slug = slug.replace(/\.html?$/i, '').replace(/-id\d+$/i, '');
  const decoded = slug.replace(/\+/g, ' ').replace(/%20/g, ' ').replace(/_/g, ' ');
  const s = decoded.replace(/^(used|new|pre-?owned)[- ]/i, '');
  const parts = s.split(/[-]/).filter(Boolean);
  const result = {};
  if (parts[0] && /^\d{4}$/.test(parts[0].trim())) result.year = parseInt(parts.shift());
  if (parts.length && /^[A-HJ-NPR-Z0-9]{17}$/i.test(parts[parts.length - 1].trim()))
    result.vin = parts.pop().trim().toUpperCase();
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i].trim(), b = parts[i+1].trim();
    if (/^[A-Z]$/i.test(a) && /^\d{1,3}\b/.test(b)) { parts[i] = a + '-' + b; parts.splice(i+1, 1); }
    else if (/^[A-Z]{2}$/i.test(a) && /^\d{1,2}\b/.test(b)) { parts[i] = a + '-' + b; parts.splice(i+1, 1); }
  }
  // Rejoin known multi-word models
  const MULTI_WORD_MODELS = ['grand caravan','grand cherokee','grand cherokee l','grand wagoneer',
    'santa fe','santa cruz','model 3','model y','model s','model x',
    'cr v','hr v','br v','land cruiser','range rover','town country','pt cruiser'];
  for (let i = 0; i < parts.length - 1; i++) {
    const joined2 = (parts[i] + ' ' + parts[i+1]).trim().toLowerCase();
    if (MULTI_WORD_MODELS.includes(joined2)) {
      parts[i] = parts[i].trim() + ' ' + parts[i+1].trim();
      parts.splice(i+1, 1);
      if (i < parts.length - 1) {
        const joined3 = (parts[i] + ' ' + parts[i+1]).trim().toLowerCase();
        if (MULTI_WORD_MODELS.includes(joined3)) { parts[i] = parts[i].trim() + ' ' + parts[i+1].trim(); parts.splice(i+1, 1); }
      }
      break;
    }
  }
  if (parts.length > 2 && /^\d{1,2}$/.test(parts[parts.length - 1].trim()) &&
      !/^\d{3,}$/.test(parts[parts.length - 1].trim()) &&
      !/^model$/i.test(parts[parts.length - 2]?.trim())) {
    parts.pop();
  }
  if (parts[0]) result.make = normMake(parts[0].trim());
  if (parts[1]) {
    // Handle "Model Y", "Model 3", "Model S", "Model X" as single model name
    if (/^model$/i.test(parts[1].trim()) && parts[2] && /^[3ySX]$/i.test(parts[2].trim())) {
      result.model = parts[1].trim() + ' ' + parts[2].trim().toUpperCase();
      parts.splice(2, 1);
    } else {
      result.model = titleWord(parts[1].trim());
    }
  }
  if (parts.length > 2) result.trim = parts.slice(2).map(p => titleWord(p.trim())).join(' ');
  return result;
}

// ── VDP link detection ───────────────────────────────────────────────────
const VDP_LINK_RE = /\/(inventory\/((Used|New)-)?|vehicle-details\/|vehicle\/|vehicles\/|demos\/|used\/([^/]+\/)?|certified\/([^/]+\/)?|new\/inventory\/)\d{4}[-\/]/i;
const D2C_VDP_RE = /-id\d+\.html/i;

// ── Photo helpers (cheerio version) ──────────────────────────────────────
// addPhoto — adds an image URL to the photos array if it passes filters.
// Filters are split into two tiers:
//   HARD reject: never a vehicle photo (CPO badges, warranty graphics,
//                marketing collateral, dealer signage). Returns silently.
//   SOFT reject: brand logos / SVG manufacturer placeholders / generic
//                icons. NOT pushed to photos[], but if a softRejected
//                array is provided, pushed there as a fallback pool.
//                If extractPhotos ends with photos[] empty, it falls back
//                to softRejected so the vehicle at least has SOMETHING
//                instead of zero photos. Caught 2026-04-27 — Hunt has
//                older inventory units where the dealer only uploaded a
//                Dodge.svg brand logo and our hard-filter for "logo|svg"
//                stripped it down to no photos at all.
function addPhoto(src, photos, seen, altText, softRejected) {
  if (!src || src.length < 20) return;
  // HARD reject — definitely not a vehicle photo
  if (/cdn-convertus\.com/i.test(src)) return;
  if (/compressed\/\d+x\d+/i.test(src) || /\/\d+x\d+_/i.test(src)) return;
  if (/foxdealer\.com.*compressed/i.test(src)) return;
  if (/d2cmedia\.ca.*\/T\//i.test(src)) return;
  if (/capital.?secure|appearance.?plan|warranty.?plan|reconditioned|certified.?pre.?owned|cpo.?(badge|info|logo|graphic|banner)|work.?completed|coverage.?includes/i.test(src)) return;
  if (altText && /capital.?secure|appearance.?plan|warranty|reconditioned|certified.?pre.?owned|cpo|coverage.?includes|work.?completed|first.?canadian.?financial/i.test(altText)) return;
  // SOFT reject — manufacturer brand logos / SVG placeholders / icons.
  // Acceptable as last-resort fallback only.
  const isSoftReject = /logo|icon|placeholder|svg|badge|carfax|equifax|sprite|favicon|certified\.png|LIVE-CHAT|BANNER/i.test(src);
  const cleaned = src.replace(/-\d+x\d+(\.\w+)$/, '$1');
  if (!cleaned.startsWith('http')) return;
  // d2cmedia serves the same photo at multiple path prefixes (s.../cb.../etc).
  // Dedupe by `{carid}/{position}` so a vehicle's 26 real positions don't
  // get crowded out by 2-3 size variants per position eating the slot cap.
  const d2cKey = cleaned.match(/d2cmedia\.ca\/[^/]+\/\d+\/(\d+)\/(\d+)\//i);
  const seenKey = d2cKey ? ('d2c:' + d2cKey[1] + '/' + d2cKey[2]) : cleaned;
  if (seen.has(seenKey)) return;
  seen.add(seenKey);
  if (isSoftReject) {
    if (softRejected) softRejected.push(cleaned);
    return;
  }
  photos.push(cleaned);
}

function getBestSrc($img) {
  const src = $img.attr('src') || '';
  if (src.startsWith('http') && !src.includes('data:image') && src.length > 30) return src;
  if ($img.attr('data-lazy-src')) return $img.attr('data-lazy-src');
  if ($img.attr('data-src')) return $img.attr('data-src');
  const srcset = $img.attr('srcset') || $img.attr('data-srcset') || '';
  if (srcset) {
    const parts = srcset.split(',').map(s => s.trim().split(/\s+/));
    let best = '', bestW = 0;
    for (const [url, descriptor] of parts) {
      if (!url || !url.startsWith('http')) continue;
      const w = parseInt(descriptor) || 0;
      if (w > bestW || !best) { best = url; bestW = w; }
    }
    if (best) return best;
  }
  return src;
}

// ── Gallery selectors (priority order) ───────────────────────────────────
const GALLERY_SELS = [
  '.advanced-slider', '.slider-main',
  '.vehica-gallery-main', '.vehica-car-gallery', '[class*="vehica-gallery"]',
  '.vehicleCarousel', '.vehicle-gallery', '.vdp-gallery', '.media-gallery',
  '[class*="vehicleCarousel"]', '[class*="vehicle-gallery"]', '[class*="vdp-photo"]',
  '.gallery-container', '.photo-gallery', '.slider-for', '.main-slider',
  '.slick-slider', '[class*="carousel"]',
  '.swiper-wrapper', '[class*="swiper-container"]'
];

function extractPhotos($, url) {
  const photos = [];
  const seen = new Set();
  // Soft-rejected pool (brand logos, SVG placeholders). Only used as a
  // last-resort fallback on D2C-style pages where dealers commonly upload
  // a manufacturer brand SVG when they don't have real photos for an
  // older unit. Other platforms keep the original "filter to zero" behavior
  // because their pages have different junk patterns and we don't want to
  // surface random badge graphics as vehicle photos. Detection: URL matches
  // D2C_VDP_RE (`-id\d+\.html`) OR page references d2cmedia CDN.
  const softRejected = [];
  const isD2C = D2C_VDP_RE.test(url || '') || /d2cmedia\.ca/i.test($.html() || '');

  // Strategy 1: dedicated gallery container
  let galleryEl = null;
  for (const sel of GALLERY_SELS) {
    const el = $(sel).first();
    if (el.length) {
      const minImgs = (sel === '.advanced-slider' || sel === '.slider-main') ? 1 : 3;
      if (el.find('img').length >= minImgs) { galleryEl = el; break; }
    }
  }

  if (galleryEl) {
    galleryEl.find('img').each((i, img) => {
      const $img = $(img);
      addPhoto(getBestSrc($img), photos, seen, $img.attr('alt') || $img.attr('title') || '', softRejected);
    });
  }

  // Strategy 1.5: D2C sequential photo generation
  if (photos.length < 3) {
    const d2cBase = photos.find(p => /d2cmedia\.ca.*\/1\//i.test(p));
    if (d2cBase) {
      for (let n = 2; n <= 10; n++) {
        addPhoto(d2cBase.replace(/\/1\//, '/' + n + '/'), photos, seen, '', softRejected);
      }
    }
  }

  // Strategy 2: CDN pattern matching — sweep ALL <img> tags for known
  // dealer-photo CDN URLs the gallery container selector might miss.
  // Bumped guard from `< 3` to `< 30` so it always fills up to the cap.
  if (photos.length < 30) {
    $('img').each((i, img) => {
      const $img = $(img);
      const src = getBestSrc($img);
      if (/homenet|dealerphoto|dealerphotos|vehiclephoto|d2cmedia|imagescdn|autotradercdn|getedealer|pictures\.dealer\.com|cdn.*\/(640|800|1024|1280)/i.test(src)) {
        addPhoto(src, photos, seen, $img.attr('alt') || $img.attr('title') || '', softRejected);
      }
    });
  }

  // Strategy 2.5: raw HTML regex sweep for known dealer-photo CDN URLs.
  // Catches photos that DON'T live in <img> tags — preload <link> tags,
  // JSON blobs in <script>, data attributes, hidden carousel templates,
  // structured-data productList arrays. Hunt Chrysler embeds 26+ unique
  // d2cmedia positions per VDP but the gallery <img> selector only sees
  // ~20 — the rest are in non-img DOM. Caught 2026-04-27 when Hunt RAMs
  // showed 📷20 in the scan log even after Strategy 2 was made
  // unconditional (gallery + non-gallery <img> both maxed at 20 still).
  if (photos.length < 30) {
    try {
      const rawHtml = $.html() || '';
      const cdnRe = /https?:\/\/[^\s"'<>)\\,]*(?:d2cmedia|imagescdn|autotradercdn|getedealer|dealerphoto|homenet)[^\s"'<>)\\,]*\.(?:jpg|jpeg|png|webp)[^\s"'<>)\\,]*/gi;
      const found = [...new Set(rawHtml.match(cdnRe) || [])];
      for (const url of found) {
        if (photos.length >= 30) break;
        addPhoto(url, photos, seen, '', softRejected);
      }
    } catch (_) {}
  }

  // Strategy 3: any non-junk image with size hints in URL
  if (photos.length < 3) {
    $('img').each((i, img) => {
      const $img = $(img);
      const src = getBestSrc($img);
      if (/\/(640|800|1024|1280)x/i.test(src)) {
        addPhoto(src, photos, seen, $img.attr('alt') || $img.attr('title') || '', softRejected);
      }
    });
  }

  // D2C-only fallback: dealer only uploaded a brand logo / SVG placeholder
  // for this unit (common on older inventory at Hunt etc.). Better to show
  // that than nothing. NOT applied to non-D2C sites — other platforms have
  // different junk patterns where the soft-reject pool would surface random
  // badges. Scoped per Franco 2026-04-27.
  if (isD2C && photos.length === 0 && softRejected.length > 0) {
    for (const url of softRejected.slice(0, 5)) photos.push(url);
  }

  // D2C junk photo filter: marketing images use a different stock ID than the real vehicle photos.
  // Find the most common d2cmedia stock ID — that's the real vehicle. Discard mismatches.
  if (photos.length > 1) {
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

  // 2026-04-27: bumped 25 -> 30. Some dealers list 50+ photos per
  // vehicle; we capture 30 and the dealer trims to 20 in FB Poster
  // (Facebook Marketplace's hard cap is 20 photos per listing).
  return photos.slice(0, 30);
}

// ── VDP detail page parser (cheerio version) ─────────────────────────────
function parseVdpDetailHtml(html, url) {
  const $ = cheerio.load(html);
  // Strip <style> and <script> from the body before extracting text — Hunt
  // (and other dealers running inline CSS in body) put FontAwesome rules like
  // `.fa-shuttle-van:before` inline, and cheerio's .text() concatenates that
  // CSS as plain text. Pre-fix this caused two regressions in one session:
  // stock="IMGSTYLE" (matched .stockImgStyle CSS class) and type="Van"
  // (matched .fa-shuttle-van CSS class) for every Hunt vehicle.
  const $body = $('body').clone();
  $body.find('style, script, noscript').remove();
  const body = $body.text();
  const slug = parseFromSlug(url);

  // Title
  let title = '';
  for (const sel of ['h1.vehicle-title','h1.listing-title','.vehicle-name h1','h1','.car-title','.srp-vehicle-title']) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 3) { title = clean(el.text()); break; }
  }
  title = title.replace(/^(used|new|pre-?owned)\s+/i, '').trim();

  // Price
  let price = 0;
  const PRICE_SELS = [
    '#carPrice', '.priceDivPrice',
    '.pricing-group__final-price', '[class*="price-block__price--lg"]',
    '.finalPrice', '.vdpPricing', '.sale-price', '.salePrice',
    '.vehicle-price', '.listing-price', '.price-current',
    '[class*="salePrice"]', '[class*="finalPrice"]', '[class*="internet-price"]'
  ];
  for (const sel of PRICE_SELS) {
    const el = $(sel).first();
    if (el.length) {
      const txt = el.text() || '';
      const saleMatch = txt.match(/sale\s*price[:\s$]*\$?([\d,]+)/i);
      if (saleMatch) { price = parseInt(saleMatch[1].replace(/,/g, '')); break; }
      const inetMatch = txt.match(/internet\s*price[:\s$]*\$?\s*([\d,]+)/i);
      if (inetMatch) { price = parseInt(inetMatch[1].replace(/,/g, '')); break; }
      const p = parsePrice(txt);
      if (p >= 1000) { price = p; break; }
    }
  }
  // Priority 2: "Sale Price" or "Internet Price" in body
  if (!price) {
    const saleM = body.match(/(?:sale|internet|final|cash)\s*price[\s:$]*\$?\s*([\d,]+)/i);
    if (saleM) price = parseInt(saleM[1].replace(/,/g, ''));
  }
  if (!price) {
    $('.price,[class*="price"],[class*="Price"]').each((i, el) => {
      if (price) return;
      const txt = $(el).text() || '';
      if (/starting at|view inventory|contact us/i.test(txt)) return;
      const p = parsePrice(txt);
      if (p >= 1000) price = p;
    });
  }
  if (!price) { const m = body.match(/\$([\d,]+)/); if (m) price = parseInt(m[1].replace(/,/g, '')); }

  // VIN
  let vin = slug.vin || '';
  if (!vin) { const m = body.match(/(?:vin|vehicle id)[:\s#]*([A-HJ-NPR-Z0-9]{17})/i); if (m) vin = m[1]; }

  // Stock — require at least one real separator after "stock" (colon, hash,
  // or whitespace) so we don't match things like Hunt's `.stockImgStyle` CSS
  // class name that ends up in body.text() via inline <style> tags. Pre-fix,
  // every Hunt VDP returned stock="IMGSTYLE" because the prior `[:\s#]*`
  // (zero-or-more) happily captured "ImgStyle" right after "stock". Sync
  // dedupes by stock#, so 57 vehicles collapsed to 1 row in inventory.
  let stock = '';
  const stockM = body.match(/(?:stock|stock\s*#)\s*[:#]\s*([A-Z0-9\-]{3,12})/i)
              || body.match(/\bstock\s*#?\s+([A-Z][A-Z0-9\-]{3,11})\b/i);
  if (stockM) stock = stockM[1].toUpperCase();
  if (!stock && vin) stock = vin.slice(-8);
  if (!stock) {
    const urlSeg = (url.split('/').filter(Boolean).pop() || '').replace(/\.html?$/i, '');
    stock = urlSeg.slice(0, 12).toUpperCase();
  }

  // ── Spec-block label extraction ──────────────────────────────────────
  // Many dealer VDPs (Hunt, most D2C platforms) have a structured spec list
  // with `Label: Value` rows like "Category: Trucks", "Exterior Colour: White",
  // "Transmission: 9-Speed automatic", "Fuel: Gas". Pull these directly
  // instead of body-wide regex grep — pre-fix every Hunt vehicle was tagged
  // type:"Van" because the body-style regex matched the FIRST occurrence of
  // any body-style word in the page, and Hunt's sidebar lists "RAM ProMaster
  // Cargo Van" before any other vehicle, so "Van" always won.
  function specVal(re) {
    const m = body.match(re);
    return m ? clean(m[1]).replace(/\s+/g, ' ').trim() : '';
  }
  // Cheerio's body.text() concatenates inline-list spec rows without
  // whitespace ("...driveTransmission:AutomaticFuel:GasEngine:..."), so we
  // can't rely on `\b` word boundaries between values and the next label.
  // For colors/categories (open-ended values) we lazy-match up to a known
  // following label. Lookahead uses an enumerated label list — pre-fix the
  // lookahead was `(?=\s*[A-Z][A-Za-z]+\s*:|$)` with /i flag, but /i made
  // `[A-Z]` case-insensitive so "ackPassengers" satisfied the lookahead and
  // intColor captured only "Bl" instead of "Black".
  const NEXT_LABEL = '(?=Passengers|Doors|Kilometers|Stock|VIN|Price|Drive|Transmission|Fuel|Engine|Cylinders|Exterior|Interior|Category|Trim|Model|Body|Mileage|Year|Make|Color|Colour|Share|Download|Carfax|City|Highway|$)';
  const categoryRaw = specVal(new RegExp('Category\\s*:\\s*([A-Za-z][A-Za-z ]{1,30}?)' + NEXT_LABEL, 'i'));
  const extColorRaw = specVal(new RegExp('Exterior\\s*Colou?r\\s*:\\s*([A-Za-z][A-Za-z ]{1,30}?)' + NEXT_LABEL, 'i'));
  const intColorRaw = specVal(new RegExp('Interior\\s*Colou?r\\s*:\\s*([A-Za-z][A-Za-z ]{1,30}?)' + NEXT_LABEL, 'i'));
  // Drive train: known canonical values
  const driveTrainV   = specVal(/Drive\s*train\s*:\s*((?:Front|Rear|All|Four)\s*-?\s*wheel\s+drive|FWD|RWD|AWD|4WD|4x4|2WD)/i);
  // Transmission: enumerated common values. Try the longer "N-Speed X" form
  // first so we don't truncate to just "automatic" when the page actually has
  // "8-Speed automatic". Use the same enumerated NEXT_LABEL terminator as
  // colors so we don't glue the next label ("Fuel:") onto the value.
  const transmissionV = specVal(new RegExp('Transmission\\s*:\\s*(\\d{1,2}\\s*-?\\s*Speed\\s+(?:Automatic|Auto|Manual|DCT|CVT))' + NEXT_LABEL, 'i'))
                     || specVal(/Transmission\s*:\s*(Automatic|Manual|CVT|DCT|Auto-?manual|Dual\s*Clutch|Tiptronic)/i);
  // Fuel: enumerated. Avoid the "Fuel efficiency" header by requiring the
  // value to be a known fuel type, not text.
  // No trailing \b — Hunt's body text has "Fuel: GasEngine:..." with no
  // separator, and "s" + "E" are both word chars, so \b never holds. The
  // alternation order (Gasoline before Gas) handles the prefix-match risk.
  const fuelTypeV   = specVal(/Fuel\s*:\s*(Plug-?in\s*Hybrid|Gasoline|Gas|Diesel|Electric|Hybrid|Plug-?in|Flex(?:\s*Fuel)?|E85|CNG|LPG)/i);
  const engineV     = specVal(new RegExp('Engine\\s*:\\s*([A-Za-z0-9][A-Za-z0-9 \\.\\-/]{2,80}?)' + NEXT_LABEL, 'i'));

  // Body style: prefer "Category:" label (canonical), then map vendor-specific
  // category words ("Commercial Vans", "Trucks", "Crossovers") to clean
  // taxonomy. Only fall back to body-wide regex grep if nothing labeled.
  function mapBodyStyle(s) {
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
    return clean(s).replace(/s$/i, ''); // strip trailing s ("Trucks"→"Truck")
  }
  let type = mapBodyStyle(categoryRaw);
  if (!type) {
    const typeM = body.match(/\b(sedan|suv|truck|pickup|coupe|hatchback|wagon|convertible|crossover)\b/i);
    type = typeM ? typeM[1][0].toUpperCase() + typeM[1].slice(1).toLowerCase() : 'Used';
  }

  // Photos
  const photos = extractPhotos($, url);

  // Mileage
  let mileage = 0;
  const odoMatch = body.match(/(?:odometer|mileage|km|kilometers?|kilometres?)[:\s]+([0-9,]{3,7})(?:\s*km)?/i);
  if (odoMatch) { const v = parseInt(odoMatch[1].replace(/,/g, '')); if (v >= 500 && v <= 400000) mileage = v; }
  if (!mileage) {
    const kmMatches = [...body.matchAll(/([0-9,]{3,7})\s*km\b/gi)];
    for (const km of kmMatches) {
      const v = parseInt(km[1].replace(/,/g, ''));
      if (v >= 5000 && v <= 400000) { mileage = v; break; }
    }
  }

  // Color
  let color = '';
  const colorEl = $('[class*="color"],[class*="colour"],[class*="Color"],[class*="Colour"]').first();
  if (colorEl.length) color = parseColor(colorEl.text());
  if (!color) {
    const cm = body.match(/(?:ext(?:erior)?|colour|color)[.:\s#]+([A-Za-z][A-Za-z ]{2,20}?)(?:\n|,|\||\/|\d)/i);
    if (cm) color = parseColor(cm[1]);
  }
  if (!color) color = parseColor(body.substring(0, 3000));

  // Year validation + price-year rejection
  const vehicleYear = slug.year || parseYear(title) || 0;
  if (price > 0 && price >= 1990 && price <= 2030 && Math.abs(price - vehicleYear) <= 2) price = 0;

  // Fallback: if slug make is numeric-only, parse from page title
  let finalMake = slug.make || '';
  let finalModel = slug.model || '';
  let finalTrim = slug.trim || '';
  if (!finalMake || /^\d+$/.test(finalMake)) {
    const pageTitle = ($('title').text() || '').replace(/\s*[-|].*dealer.*$/i, '').replace(/\s*[-|]\s*[A-Z][a-z]+\s+[A-Z]/,'').trim();
    const titleSlug = parseFromSlug('/' + pageTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '') + '/');
    if (titleSlug.make && !/^\d+$/.test(titleSlug.make)) {
      finalMake = titleSlug.make;
      finalModel = titleSlug.model || finalModel;
      finalTrim = titleSlug.trim || finalTrim;
    }
    if (!finalMake || /^\d+$/.test(finalMake)) {
      const titleParts = (title || pageTitle).replace(/^(used|new|pre-?owned)\s+/i, '').replace(/^\d{4}\s+/, '').split(/\s+/);
      if (titleParts[0]) finalMake = normMake(titleParts[0]);
      if (titleParts[1] && /^model$/i.test(titleParts[1]) && titleParts[2]) {
        finalModel = titleParts[1] + ' ' + titleParts[2];
        if (titleParts.length > 3) finalTrim = titleParts.slice(3).map(p => titleWord(p)).join(' ');
      } else {
        if (titleParts[1]) finalModel = titleWord(titleParts[1]);
        if (titleParts.length > 2) finalTrim = titleParts.slice(2).map(p => titleWord(p)).join(' ');
      }
    }
  }

  // Prefer the labeled "Exterior Colour:" value over the regex-mined `color`
  // when both exist — the labeled value is unambiguous, the regex one can
  // accidentally pick up "Coloured" headers or category sidebar text.
  const finalExtColor = parseColor(extColorRaw) || color;
  const finalIntColor = parseColor(intColorRaw);

  return {
    stock, vin, type, mileage, price,
    year: vehicleYear || 2020,
    make: finalMake, model: finalModel, trim: finalTrim,
    color: finalExtColor, condition: 'Used', carfax: 0, book_value: 0,
    int_color:    finalIntColor,
    transmission: transmissionV,
    fuel_type:    fuelTypeV,
    drive_train:  driveTrainV,
    engine:       engineV,
    _title: title, _photos: photos, _url: url
  };
}

// ── Main page scraper (listing detection) ────────────────────────────────
// Resolve relative URLs to absolute using the page URL as base
function resolveUrl(href, baseUrl) {
  if (!href) return href;
  try { return new URL(href, baseUrl).href; } catch { return href; }
}
function resolveLinks(links, baseUrl) {
  return (links || []).map(l => resolveUrl(l, baseUrl));
}
function resolveResult(result, baseUrl) {
  if (!result) return result;
  if (result.links) result.links = resolveLinks(result.links, baseUrl);
  if (result.pageLinks) result.pageLinks = resolveLinks(result.pageLinks, baseUrl);
  if (result.vehicles) result.vehicles.forEach(v => { if (v._url) v._url = resolveUrl(v._url, baseUrl); });
  if (result.cardVehicles) result.cardVehicles.forEach(v => { if (v._url) v._url = resolveUrl(v._url, baseUrl); });
  return result;
}

// ── SmartBuy Auto — fetch vehicles from their Supabase REST API ───────────
// SmartBuy's site is a React SPA that loads inventory via a single
// supabase-js call to /rest/v1/vehicles?select=*. The server-side scraper
// only sees the shell HTML (no vehicle data), so the tier-2 generic parsers
// fall back to treating the hostname as make ("Smartbuyauto.ca") and auto-
// generate GEN## stock numbers. We short-circuit that by extracting the
// Supabase project URL + anon JWT from the shell HTML (both are public) and
// pulling the complete vehicle schema directly — full VINs, real stock
// numbers, proper make/model/trim, AND every photo in image_urls[].
async function fetchSmartBuyInventory(html) {
  try {
    const projectMatch = html.match(/https:\/\/[a-z0-9]+\.supabase\.co/);
    const keyMatch = html.match(/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    if (!projectMatch || !keyMatch) return null;
    const sbUrl = projectMatch[0];
    const key = keyMatch[0];
    // Filter: only active listings (In Stock, Consignment) — excludes
    // Paid/Sold/Junk which bloat the set and aren't customer-facing.
    const apiUrl = `${sbUrl}/rest/v1/vehicles?select=id,stock_number,vin,year,make,model,trim,exterior_color,km,customer_price,image_urls,status,engine&status=in.(In Stock,Consignment)`;
    const r = await fetch(apiUrl, {
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows
      .filter(v => Array.isArray(v.image_urls) && v.image_urls.length > 0)
      .map(v => {
        const kmRaw = parseInt(String(v.km || '').replace(/\D/g, '')) || 0;
        return {
          stock:     (v.stock_number || (v.vin ? 'SB' + v.vin.slice(-8) : 'SB' + String(v.id).slice(-8))).toString().toUpperCase(),
          vin:       (v.vin || '').toUpperCase(),
          year:      parseInt(v.year) || 2020,
          make:      v.make || '',
          model:     v.model || '',
          trim:      v.trim || '',
          mileage:   kmRaw > 350000 ? 0 : kmRaw,
          price:     parseInt(v.customer_price) || 0,
          color:     v.exterior_color || '',
          type:      'Used',
          condition: 'Used',
          carfax:    0,
          book_value: 0,
          _title:    `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim(),
          _photos:   v.image_urls.slice(0, 30),
          _url:      'https://smartbuyauto.ca/'
        };
      });
  } catch (e) {
    console.error('[scraper] smartbuy fetch error:', e.message);
    return null;
  }
}

async function scrapePageHtml(html, url) {
  const $ = cheerio.load(html);
  const hostname = new URL(url).hostname.toLowerCase();
  const pathname = new URL(url).pathname;

  // ── 0. SmartBuy Auto (Supabase-backed SPA) ────────────────────────────
  if (hostname.includes('smartbuyauto.ca')) {
    const vehicles = await fetchSmartBuyInventory(html);
    if (vehicles && vehicles.length >= 2) {
      return resolveResult({ type: 'listing_cards', vehicles }, url);
    }
    // Fall through to generic parsers if API extraction failed
  }

  // ── 1. Sunridge Auto ──────────────────────────────────────────────────
  if (hostname.includes('sunridgeauto.com')) {
    const cards = $('.vehicle-card[data-vehicle-vin], .vehicle-card[data-vehicle-stock]');
    if (cards.length >= 2) {
      const vehicles = [];
      cards.each((idx, card) => {
        const $c = $(card);
        const vin = ($c.attr('data-vehicle-vin') || '').toUpperCase();
        const stock = $c.attr('data-vehicle-stock') || (vin ? vin.slice(-8) : `GEN${String(idx+1).padStart(3,'0')}`);
        const year = parseInt($c.attr('data-vehicle-year')) || 2020;
        const make = $c.attr('data-vehicle-make') || '';
        const model = $c.attr('data-vehicle-model') || '';
        const color = $c.attr('data-vehicle-colour') || '';
        const condition = $c.attr('data-vehicle-condition') || 'Used';
        const mileageRaw = parseInt(($c.attr('data-vehicle-odo') || '').replace(/\D/g, '')) || 0;
        const mileage = mileageRaw > 350000 ? 0 : mileageRaw;
        const price = parseInt(($c.attr('data-vehicle-internet-price') || $c.attr('data-vehicle-msrp') || '').replace(/\D/g, '')) || 0;
        let link = url;
        $c.find('a[href]').each((i, a) => {
          if (/\/(inventory|vehicles)\//i.test($(a).attr('href')) && $(a).attr('href').includes(hostname)) { link = $(a).attr('href'); return false; }
        });
        if (link === url) { const a = $c.find('a[href]').first(); if (a.length) link = a.attr('href') || url; }
        const img = $c.find('img').first().attr('src') || '';
        vehicles.push({ stock, vin, year, make, model, trim: '', mileage, price, color, type: condition === 'New' ? 'New' : 'Used', condition, carfax: 0, book_value: 0, _title: `${year} ${make} ${model}`.trim(), _photos: img ? [img] : [], _url: link });
      });
      // Return VDP links for photo crawl + cardVehicles for correct prices
      if (vehicles.length > 0) {
        const vdpLinks = vehicles.map(v => v._url).filter(u => u && u !== url);
        if (vdpLinks.length > 0) {
          return resolveResult({ type: 'listing', links: vdpLinks, pageLinks: [], vehicaPagination: 0, url, cardVehicles: vehicles }, url);
        }
        return resolveResult({ type: 'listing_cards', vehicles }, url);
      }
    }
  }

  // ── 2. Check if VDP detail page ───────────────────────────────────────
  const isVdpDetail = VDP_LINK_RE.test(pathname);

  // ── D2C Media (newer variant) — li.carBoxWrapper[data-carid] ─────────
  // Hunt Chrysler (huntchryslerfiat.ca) and similar dealers on the newer
  // D2C platform use this card structure with embedded JSON-LD product
  // data. Different from the older D2C carImage[data-vin][data-make]
  // handler below — this one falls through that selector and would have
  // landed in the generic fallback with no pagination support.
  // Pagination uses the SAME .divPaginationBox <li> button structure as
  // the older D2C variant, so we just need to count them and return
  // d2cSlugPages — background.js's existing slug-pagination handler then
  // clicks through pages 2..N in a hidden tab and scrapes additional
  // VDP links matching the D2C_VDP_RE regex. Confirmed 2026-04-27 on
  // Hunt's /new/inventory/search.html (5 pages, 154 vehicles total).
  if (!isVdpDetail) {
    const huntCards = $('li.carBoxWrapper[data-carid]');
    if (huntCards.length >= 2) {
      const seen = new Set();
      const vdpLinks = [];
      const cardVehicles = [];
      huntCards.each((i, card) => {
        const $c = $(card);
        // Canonical VDP link — first <a> matching D2C_VDP_RE
        let cardLink = '';
        $c.find('a[href]').each((_, a) => {
          const href = $(a).attr('href');
          if (href && D2C_VDP_RE.test(href) && !seen.has(href)) {
            seen.add(href);
            cardLink = href;
            vdpLinks.push(href);
            return false;
          }
        });
        if (!cardLink) return;
        // Parse embedded JSON-LD for clean year/make/model/price/image —
        // more reliable than scraping rendered text.
        let year = 0, make = '', model = '', price = 0, image = '', condition = 'Used';
        try {
          const ldText = $c.find('script[type="application/ld+json"]').first().text();
          if (ldText) {
            const ld = JSON.parse(ldText);
            const offer = ld.offers || {};
            const nameMatch = String(ld.name || '').match(/^(\d{4})\s+(\S+)\s*(.*)$/);
            if (nameMatch) {
              year = parseInt(nameMatch[1]);
              make = normMake(nameMatch[2]);
              model = nameMatch[3].trim();
            }
            price = parseInt(offer.price) || 0;
            image = (Array.isArray(ld.image) ? ld.image[0] : ld.image) || '';
            const ic = String(offer.itemCondition || '').toLowerCase();
            condition = ic.includes('new') ? 'New' : 'Used';
          }
        } catch (_) {}
        // Hunt cards expose mileage / VIN / stock# / color in the rendered
        // text — JSON-LD doesn't carry them. Pull from the card text so we
        // don't depend on VDP iteration to populate these fields. Pre-fix,
        // every Hunt vehicle showed 0 km even on used 2022/2023 units that
        // clearly had real km, because my JSON-LD-only handler returned
        // mileage:0 and the card->VDP merge used to overwrite VDP mileage
        // with the card default. Caught 2026-04-27.
        const cardText = clean($c.text());
        const kmM    = cardText.replace(/,/g,'').match(/(\d{2,7})\s*KM/i);
        const cardMileage = kmM ? parseInt(kmM[1]) : 0;
        const vinM   = cardText.match(/VIN\s*:?\s*([A-HJ-NPR-Z0-9]{17})/i);
        const cardVin = vinM ? vinM[1].toUpperCase() : '';
        // Stop the stock# capture at a word boundary OR at the literal "VIN"
        // that follows on the same line (after clean() collapses newlines).
        // Pre-fix the greedy [A-Z0-9-]{3,12} swallowed "P6796VIN" — the "V"
        // in "VIN" passed the char class. Caught 2026-04-27.
        const stkM   = cardText.match(/Stock\s*[#:]?\s*([A-Z0-9\-]{3,12}?)(?=\s|VIN|$)/i);
        const cardStock = stkM ? stkM[1].toUpperCase() : '';
        const colM   = cardText.match(/Ext\s*:?\s*(White|Black|Silver|Grey|Gray|Red|Blue|Green|Brown|Beige|Gold|Yellow|Orange|Maroon|Tan|Burgundy|Champagne|Pearl|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);
        const cardColor = colM ? colM[1] : '';
        const stock = cardStock || $c.attr('data-carid') || `H${String(i+1).padStart(4,'0')}`;
        cardVehicles.push({
          stock, vin: cardVin,
          year: year || 2020, make, model, trim: '',
          mileage: cardMileage,
          price, color: cardColor,
          type: condition,
          condition,
          carfax: 0, book_value: 0,
          _title: `${year} ${make} ${model}`.trim(),
          _photos: image ? [image] : [],
          _url: cardLink,
        });
      });
      if (vdpLinks.length > 0) {
        // Pagination via .divPaginationBox count — pass to extension's
        // existing d2cSlugPages handler which clicks each page button in
        // a background tab and aggregates the additional VDP links.
        const pageBoxes = $('.divPaginationBox');
        const d2cSlugPages = pageBoxes.length > 1 ? pageBoxes.length : 0;
        return resolveResult({
          type: 'listing',
          links: vdpLinks,
          pageLinks: [],
          d2cSlugPages,
          vehicaPagination: 0,
          url,
          cardVehicles,
        }, url);
      }
    }
  }

  // ── D2C Media cards ───────────────────────────────────────────────────
  if (!isVdpDetail) {
    const d2cCards = $('div.carImage[data-vin][data-make]');
    if (d2cCards.length >= 2) {
      const seen = new Set();
      const vdpLinks = [];
      d2cCards.each((i, card) => {
        const $c = $(card);
        const link = $c.find('a[href]').first().attr('href');
        if (link && !seen.has(link) && VDP_LINK_RE.test(link)) { seen.add(link); vdpLinks.push(link); }
      });
      if (vdpLinks.length > 0) {
        // D2C pagination: filterid with qN
        const d2cPageBoxes = $('.divPaginationBox');
        const d2cPageLinks = [];
        if (d2cPageBoxes.length > 1) {
          for (let p = 1; p < d2cPageBoxes.length; p++) {
            const pageUrl = url.replace(/q\d+/, 'q' + p);
            if (pageUrl !== url) d2cPageLinks.push(pageUrl);
          }
        }
        return resolveResult({ type: 'listing', links: vdpLinks, pageLinks: d2cPageLinks, vehicaPagination: 0, url }, url);
      }
    }
  }

  // ── eDealer (Applewood Nissan, etc.) — data-vin + data-slug cards ────
  if (!isVdpDetail) {
    const edCards = $('div.cell.card[data-vin][data-slug]');
    if (edCards.length >= 2) {
      const seenSlug = new Set();
      const vdpLinks = [];
      const cardVehicles = [];
      edCards.each((idx, card) => {
        const $c = $(card);
        const slug = $c.attr('data-slug');
        if (!slug || seenSlug.has(slug)) return;
        seenSlug.add(slug);
        const origin = new URL(url).origin;
        const link = origin + '/inventory/' + slug;
        vdpLinks.push(link);
        const text = clean($c.text());
        const kmM = text.replace(/,/g, '').match(/(\d+)\s*km/i);
        const mileage = kmM ? parseInt(kmM[1]) : 0;
        const img = $c.find('img').first().attr('src') || $c.find('img').first().attr('data-src') || '';
        cardVehicles.push({
          stock: $c.attr('data-stocknumber') || '', vin: $c.attr('data-vin') || '',
          year: parseInt($c.attr('data-year')) || 2020, make: $c.attr('data-make') || '',
          model: $c.attr('data-model') || '', trim: $c.attr('data-trim') || '',
          mileage, price: parseInt($c.attr('data-price')) || 0,
          color: $c.attr('data-color') || '',
          type: ($c.attr('data-condition') || '').toUpperCase() === 'NEW' ? 'New' : 'Used',
          condition: $c.attr('data-conditionname') || 'Used',
          carfax: 0, book_value: 0,
          _title: $c.attr('data-name') || '', _photos: img ? [img] : [], _url: link
        });
      });
      if (vdpLinks.length > 0) {
        // eDealer pagination: generate all ?page=N URLs from total count
        const pageLinks = [];
        const perPage = vdpLinks.length;
        const bodyText = clean($('body').text()).slice(0, 3000);
        const countMatch = bodyText.match(/(\d+)\s*(Results?|Vehicles?|Found|Cars?|listings?)/i);
        const totalVehicles = countMatch ? parseInt(countMatch[1]) : 0;
        if (totalVehicles > perPage) {
          const totalPages = Math.ceil(totalVehicles / perPage);
          const baseUrl = new URL(url);
          for (let p = 1; p <= totalPages; p++) {
            baseUrl.searchParams.set('page', p);
            const pageUrl = baseUrl.toString();
            if (pageUrl !== url) pageLinks.push(pageUrl);
          }
        } else {
          // Fallback: find ?page=N links in the HTML
          const pageSeen = new Set([url]);
          $('a[href]').each((i, a) => {
            const href = $(a).attr('href') || '';
            if (pageSeen.has(href)) return;
            if (/[?&]page=\d+/.test(href) && href.includes(new URL(url).hostname)) { pageSeen.add(href); pageLinks.push(href); }
          });
        }
        return resolveResult({ type: 'listing', links: vdpLinks, pageLinks, vehicaPagination: 0, url, cardVehicles }, url);
      }
    }
  }

  // ── Generic listing detection ─────────────────────────────────────────
  if (!isVdpDetail) {
    // Collect VDP links
    const seen = new Set();
    const links = [];
    $('a[href]').each((i, a) => {
      const href = $(a).attr('href') || '';
      // For D2C: skip category pages (no -id suffix)
      if (/(demos|used|new\/inventory)\/\d{4}-/i.test(href) && !D2C_VDP_RE.test(href)) return;
      if (!seen.has(href) && VDP_LINK_RE.test(href)) { seen.add(href); links.push(href); }
    });

    if (links.length > 0) {
      // Detect pagination
      const pageSeen = new Set([url]);
      const pageLinks = [];

      // Standard pagination containers
      const paginationSels = ['.pagination', '[class*="pagination"]', '.pager', '[class*="pager"]', '.page-numbers', 'nav.pages', '[aria-label*="page"]', '[aria-label*="pagination"]'];
      let foundInContainer = false;
      for (const sel of paginationSels) {
        $(sel).find('a[href]').each((i, a) => {
          const href = $(a).attr('href');
          if (!href || pageSeen.has(href)) return;
          try { if (new URL(href).hostname !== new URL(url).hostname) return; } catch { return; }
          if (VDP_LINK_RE.test(href)) return;
          pageSeen.add(href); pageLinks.push(href); foundInContainer = true;
        });
        if (foundInContainer) break;
      }

      // Fallback: ?page= or /page/ or ?start=N URL patterns
      if (!foundInContainer) {
        $('a[href]').each((i, a) => {
          const href = $(a).attr('href') || '';
          if (pageSeen.has(href)) return;
          if (/[?&](page|pg|p|pagenumber)=\d+/i.test(href) || /\/page\/\d+/i.test(href)) {
            try { if (new URL(href).hostname !== new URL(url).hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return;
            pageSeen.add(href); pageLinks.push(href);
          }
          // Dealer.com ?start=N — merge with current URL to preserve filters
          const startM = href.match(/[?&]start=(\d+)/i);
          if (startM && parseInt(startM[1]) > 0) {
            try {
              const merged = new URL(url);
              merged.searchParams.set('start', startM[1]);
              const full = merged.toString();
              if (!pageSeen.has(full)) { pageSeen.add(full); pageLinks.push(full); }
            } catch {}
          }
        });
      }

      // Automaxx-style slug pagination
      if (!pageLinks.length) {
        $('a[href]').each((i, a) => {
          const href = $(a).attr('href') || '';
          if (pageSeen.has(href)) return;
          if (/\/(used|new|pre-?owned)-page-\d+\b/i.test(href) || /\/inventory\/page-\d+/i.test(href) || /\/page-\d+\//i.test(href)) {
            try { if (new URL(href).hostname !== new URL(url).hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return;
            pageSeen.add(href); pageLinks.push(href);
          }
        });
      }

      // Vehica Vue pagination (detect divs in HTML — server can see them even if Vue hasn't rendered)
      const vehicaPageDivs = $('.vehica-pagination__page');
      let vehicaPagination = 0;
      if (vehicaPageDivs.length > 1) {
        const countMatch = $('body').text().match(/(\d+)\s*Used\s*(cars|vehicles|trucks)/i);
        const totalVehicles = countMatch ? parseInt(countMatch[1]) : 0;
        const perPage = links.length || 16;
        vehicaPagination = totalVehicles > perPage ? Math.ceil(totalVehicles / perPage) : vehicaPageDivs.length;
      }

      // Detect "load more" / infinite scroll (Algolia, etc.)
      const hasLoadMore = !!$('.ais-InfiniteHits-loadMore, [class*="load-more"], [class*="loadmore"]').length;

      return resolveResult({ type: 'listing', links, pageLinks, vehicaPagination, hasLoadMore, url }, url);
    }
  }

  // ── VDP detail page ───────────────────────────────────────────────────
  if (isVdpDetail) {
    return resolveResult({ type: 'detail', vehicles: [parseVdpDetailHtml(html, url)] }, url);
  }

  // ── Fallback: try generic card selectors ──────────────────────────────
  const CARD_SELS = ['.vehicle-card', '.inventory-item', '.listing-item', '.car-card',
    '.vehicle-listing', 'article.vehicle', 'article.type-vehicle',
    '[class*="inventory-card"]', '[class*="vehicle-item"]',
    '.inventory-listing article', 'li.vehicle', '.carbox-wrap', '.carbox',
    '.result-item', '.srp-list-item'];
  let cards = null;
  for (const sel of CARD_SELS) {
    const found = $(sel);
    if (found.length >= 2) { cards = found; break; }
  }

  if (!cards || !cards.length) {
    // Single vehicle detail page
    const body = $('body').text();
    const slugData = parseFromSlug(url);
    const h1Text = $('h1').first().text() || '';
    return {
      type: 'detail',
      vehicles: [{
        stock: (url.split('/').filter(Boolean).pop() || 'GEN001').slice(0, 12).toUpperCase(),
        year: slugData.year || parseYear(h1Text) || 2020,
        make: slugData.make || '', model: slugData.model || '', trim: slugData.trim || '',
        mileage: parseMileage(body),
        price: parsePrice(body.match(/\$([\d,]+)/)?.[0] || ''),
        vin: slugData.vin || '',
        color: '', type: 'Used', condition: 'Used', carfax: 0, book_value: 0,
        _title: clean(h1Text), _photos: [], _url: url
      }]
    };
  }

  // Multiple cards — generic parsing
  const vehicles = [];
  cards.each((idx, card) => {
    const $c = $(card);
    const text = clean($c.text());
    let link = url;
    $c.find('a[href]').each((i, a) => {
      if (VDP_LINK_RE.test($(a).attr('href'))) { link = $(a).attr('href'); return false; }
    });
    if (link === url) {
      $c.find('a[href]').each((i, a) => {
        const h = $(a).attr('href') || '';
        if (h.includes(new URL(url).hostname) && !h.includes('carfax') && !h.startsWith('tel:')) { link = h; return false; }
      });
    }
    const slugData = parseFromSlug(link);
    let cardTitle = clean($c.find('h2,h3,.title,.name,.vehicle-title,.srp-vehicle-title').first().text() || '');
    cardTitle = cardTitle.replace(/^(used|new|pre-?owned)\s+/i, '').trim();
    const priceEl = $c.find('[class*="price"],[class*="Price"]').first();
    const cardPrice = priceEl.length ? parsePrice(priceEl.text()) : parsePrice(text.match(/\$([\d,]+)/)?.[0] || '');
    const img = $c.find('img').first().attr('src') || '';
    vehicles.push({
      stock: slugData.vin ? slugData.vin.slice(-8) : `GEN${String(idx + 1).padStart(3, '0')}`,
      year: slugData.year || parseYear(text) || 2020,
      make: slugData.make || '', model: slugData.model || '', trim: slugData.trim || '',
      mileage: parseMileage(text), price: cardPrice,
      vin: slugData.vin || '',
      color: '', type: 'Used', condition: 'Used', carfax: 0, book_value: 0,
      _title: cardTitle, _photos: img ? [img] : [], _url: link
    });
  });

  return resolveResult({ type: 'listing_cards', vehicles }, url);
}

module.exports = { scrapePageHtml, parseVdpDetailHtml, parseFromSlug, VDP_LINK_RE, D2C_VDP_RE };
