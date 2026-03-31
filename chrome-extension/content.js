// content.js — FIRST-FIN Inventory Importer v2.2
// Injected into dealer pages. Responds to SCRAPE messages from the popup.
'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────
function clean(t)      { return (t || '').replace(/\s+/g, ' ').trim(); }
function parsePrice(t) {
  const m = (t || '').replace(/,/g, '').match(/\$?\s*([\d]+)/);
  return m ? parseInt(m[1]) : 0;
}
function parseYear(t) {
  const m = (t || '').match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0]) : null;
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
  const s      = slug.replace(/^(used|new|pre-?owned)-/i, '');
  const parts  = s.split('-').filter(Boolean);
  const result = {};
  if (parts[0] && /^\d{4}$/.test(parts[0]))
    { result.year = parseInt(parts.shift()); }
  if (parts.length && /^[A-HJ-NPR-Z0-9]{17}$/i.test(parts[parts.length - 1]))
    { result.vin = parts.pop().toUpperCase(); }
  if (parts[0]) result.make  = parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase();
  if (parts[1]) result.model = parts[1][0].toUpperCase() + parts[1].slice(1).toLowerCase();
  if (parts.length > 2)
    result.trim = parts.slice(2).map(p => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
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
  const priceEl = document.querySelector('.price,.vehicle-price,.listing-price,[class*="price"],[class*="Price"]');
  if (priceEl) price = parsePrice(priceEl.innerText);
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

  const photos = [];
  document.querySelectorAll('img').forEach(img => {
    const src = img.src || img.dataset.src || '';
    if (!src || /logo|icon|placeholder/i.test(src)) return;
    const s = src.replace(/-\d+x\d+(\.\w+)$/, '$1');
    if (s.startsWith('http') && !photos.includes(s)) photos.push(s);
  });

  return {
    stock, vin, type,
    mileage:   parseMileage(body),
    price,
    year:      slug.year  || parseYear(title) || 2020,
    make:      slug.make  || '',
    model:     slug.model || '',
    trim:      slug.trim  || '',
    color:     '',
    condition: 'Used',
    carfax:    0,
    book_value: 0,
    _title:  title,
    _photos: photos.slice(0, 4),
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
          const link     = card.querySelector('a')?.href || url;
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
  //    Works for House of Cars, Automaxx, and any site using
  //    /inventory/Used-YYYY- or /inventory/New-YYYY- style VDP URLs.
  const VDP_LINK_RE = /\/inventory\/(Used|New)-\d{4}-/i;
  const isVdpDetail = VDP_LINK_RE.test(location.pathname);

  if (!isVdpDetail) {
    const seen  = new Set();
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!seen.has(href) && VDP_LINK_RE.test(href)) {
        seen.add(href);
        links.push(href);
      }
    });
    if (links.length > 0) return { type: 'listing', links, url };
  }

  if (isVdpDetail) {
    return { type: 'detail', vehicles: [parseVdpDetail(url)] };
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
      const link     = card.querySelector('a')?.href || url;
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
    sendResponse({ ok: true, result });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return false;
});
