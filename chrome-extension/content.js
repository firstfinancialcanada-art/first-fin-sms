// content.js — FIRST-FIN Inventory Importer v2.3
// Injected into dealer pages. Responds to SCRAPE messages from the popup.
'use strict';

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
  const m = (t || '').replace(/,/g, '').match(/([\d]+)\s*k(?:m|ilometers?)?/i);
  if (m) { const v = parseInt(m[1]); return v > 350000 ? 0 : v; }
  // Also handle plain km numbers like "89000 km"
  const m2 = (t || '').replace(/,/g, '').match(/([\d]+)\s*km/i);
  if (m2) { const v = parseInt(m2[1]); return v > 350000 ? 0 : v; }
  return 0;
}
function parseFromSlug(url) {
  const slug   = (url || '').split('/').filter(Boolean).pop() || '';
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

  // Strip trailing WordPress duplicate slug suffix (e.g., -2, -3 in /2018-ram-1500-2/)
  if (parts.length > 2 && /^\d{1,2}$/.test(parts[parts.length - 1].trim()) &&
      !/^\d{3,}$/.test(parts[parts.length - 1].trim())) {
    parts.pop();
  }

  if (parts[0]) result.make  = normMake(parts[0].trim());
  if (parts[1]) result.model = titleWord(parts[1].trim());
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
    '.finalPrice', '.vdpPricing', '.sale-price', '.salePrice',
    '.vehicle-price', '.listing-price', '.price-current',
    '[class*="salePrice"]', '[class*="finalPrice"]'
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
  // Priority 2: "Sale Price" text anywhere in the body
  if (!price) {
    const saleM = body.match(/sale\s*price[:\s$]*\$?([\d,]+)/i);
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

  const typeM = body.match(/\b(sedan|suv|truck|pickup|coupe|hatchback|van|wagon|convertible|crossover)\b/i);
  const type  = typeM ? typeM[1][0].toUpperCase() + typeM[1].slice(1).toLowerCase() : 'Used';

  // Collect photos from vehicle gallery only (not "similar vehicles" or site chrome)
  const photos = [];
  const seen = new Set();

  // Strategy 1: Look for a dedicated vehicle gallery container
  const GALLERY_SELS = [
    '.vehicleCarousel', '.vehicle-gallery', '.vdp-gallery', '.media-gallery',
    '[class*="vehicleCarousel"]', '[class*="vehicle-gallery"]', '[class*="vdp-photo"]',
    '.gallery-container', '.photo-gallery', '.slider-for', '.main-slider',
    '.slick-slider', '[class*="carousel"]',
    '.vehica-gallery-main', '.vehica-car-gallery', '[class*="vehica-gallery"]',
    '.swiper-wrapper', '[class*="swiper-container"]'
  ];
  let galleryEl = null;
  for (const sel of GALLERY_SELS) {
    const el = document.querySelector(sel);
    if (el && el.querySelectorAll('img').length >= 3) { galleryEl = el; break; }
  }

  function addPhoto(src) {
    if (!src || src.length < 20) return;
    if (/logo|icon|placeholder|svg|badge|carfax|equifax|sprite|favicon/i.test(src)) return;
    // Skip small compressed thumbnails (e.g., 300x300, 150x150 in URL)
    if (/compressed\/\d+x\d+/i.test(src) || /\/\d+x\d+_/i.test(src)) return;
    // Skip known "similar vehicles" CDN patterns
    if (/foxdealer\.com.*compressed/i.test(src)) return;
    const clean = src.replace(/-\d+x\d+(\.\w+)$/, '$1');
    if (clean.startsWith('http') && !seen.has(clean)) { seen.add(clean); photos.push(clean); }
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
      addPhoto(getBestSrc(img));
    });
  }

  // DEBUG: write photo count to DOM
  try { document.documentElement.dataset.ffDebugPhotos = photos.length; } catch(_){}
  try { document.documentElement.dataset.ffDebugFirst = photos[0]?.substring(0, 80) || 'NONE'; } catch(_){}

  // Strategy 2: If gallery had < 3 photos, try all images but filter aggressively
  if (photos.length < 3) {
    document.querySelectorAll('img').forEach(img => {
      const src = getBestSrc(img);
      // Only accept images that look like vehicle photos (large CDN images)
      if (/homenet|dealerphoto|dealerphotos|vehiclephoto|cdn.*\/(640|800|1024|1280)/i.test(src)) {
        addPhoto(src);
      }
    });
  }

  // Strategy 3: Still nothing? Take any non-junk image over 200px wide
  if (photos.length < 3) {
    document.querySelectorAll('img').forEach(img => {
      const src = getBestSrc(img);
      if (img.naturalWidth >= 200 || /\/(640|800|1024|1280)x/i.test(src)) {
        addPhoto(src);
      }
    });
  }

  // Targeted mileage — look for odometer/km label then digits
  let mileage = 0;
  // Pattern 1: "km: 151,000" or "odometer: 89,000 km" (label before value)
  const odoMatch = body.match(/(?:odometer|mileage|km|kilometers?)[:\s]+([0-9,]{3,7})(?:\s*km)?/i);
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

  return {
    stock, vin, type,
    mileage,
    price,
    year:      vehicleYear || 2020,
    make:      slug.make  || '',
    model:     slug.model || '',
    trim:      slug.trim  || '',
    color,
    condition: 'Used',
    carfax:    0,
    book_value: 0,
    _title:  title,
    _photos: photos.slice(0, 10),
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
            if (/\/inventory\//i.test(a.href) && a.href.includes(location.hostname)) { link = a.href; break; }
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
      if (vehicles.length > 0) return { type: 'listing_cards', vehicles };
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

  // ── 2. Auto-detect VDP listing pages by link pattern ──────────────────
  //    Works for House of Cars, Automaxx, Stampede Auto, and similar sites.
  //    Matches: /inventory/Used-2023-, /vehicle-details/2023-, /vehicle/2023-, /vehicles/2023-
  const VDP_LINK_RE = /\/(inventory\/(Used|New)-|vehicle-details\/|vehicle\/|vehicles\/)\d{4}[-\/]/i;
  const isVdpDetail = VDP_LINK_RE.test(location.pathname);

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
        // Automaxx-style slug pagination + ?page=N links
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          if (pageSeen.has(href)) return;
          if (/\/(used|new|pre-?owned)-page-\d+\b/i.test(href) || /\/page-\d+/i.test(href) ||
              /[?&](page|pg|p)=\d+/i.test(href) || /\/page\/\d+/i.test(href)) {
            try { if (new URL(href).hostname !== location.hostname) return; } catch { return; }
            pageSeen.add(href);
            extraPages.push(href);
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
        // Always check for VDP links — use VDP crawl to get full photos
        const seen  = new Set();
        const vdpLinks = [];
        document.querySelectorAll('a[href]').forEach(a => {
          if (!seen.has(a.href) && VDP_LINK_RE.test(a.href)) { seen.add(a.href); vdpLinks.push(a.href); }
        });
        if (vdpLinks.length > 0) {
          // Detect Vehica Vue pagination — calculate total pages from vehicle count
          // Vehica shows a sliding window of page buttons (e.g., 1-7) not all pages
          const vehicaPageDivs = document.querySelectorAll('.vehica-pagination__page');
          let vehicaPagination = 0;
          if (vehicaPageDivs.length > 1) {
            // Try to calculate from "N Used cars" text + per-page count
            const countMatch = document.body.innerText.match(/(\d+)\s*Used\s*(cars|vehicles|trucks)/i);
            const totalVehicles = countMatch ? parseInt(countMatch[1]) : 0;
            const perPage = vdpLinks.length || 16;
            if (totalVehicles > perPage) {
              vehicaPagination = Math.ceil(totalVehicles / perPage);
            } else {
              vehicaPagination = vehicaPageDivs.length;
            }
          }
          return { type: 'listing', links: vdpLinks, pageLinks: extraPages, vehicaPagination, url: location.href };
        }
        // No VDP links — use card data as-is (single photos)
        return { type: 'listing_cards', vehicles: cardVehicles };
      }
    }

    const seen  = new Set();
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!seen.has(href) && VDP_LINK_RE.test(href)) {
        seen.add(href);
        links.push(href);
      }
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
            const href = a.href;
            if (!href || pageSeen.has(href)) return;
            try { if (new URL(href).hostname !== location.hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return; // skip VDP links
            pageSeen.add(href);
            pageLinks.push(href);
            foundInContainer = true;
          });
        });
        if (foundInContainer) break;
      }
      // Fallback: ?page= or /page/ URL patterns anywhere on page
      if (!foundInContainer) {
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href || '';
          if (pageSeen.has(href)) return;
          if (/[?&](page|pg|p|pagenumber)=\d+/i.test(href) || /\/page\/\d+/i.test(href)) {
            try { if (new URL(href).hostname !== location.hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return;
            pageSeen.add(href);
            pageLinks.push(href);
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
      return { type: 'listing', links, pageLinks, vehicaPagination, url };
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

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SCRAPE') return false;
  try {
    const result = scrapeCurrentPage();
    console.log('[FF-DEBUG] SCRAPE response type:', result.type, 'vehicles:', result.vehicles?.length, 'photos:', result.vehicles?.[0]?._photos?.length);
    sendResponse({ ok: true, result });
  } catch (e) {
    console.error('[FF-DEBUG] SCRAPE error:', e.message);
    sendResponse({ ok: false, error: e.message });
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
