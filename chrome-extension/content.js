// content.js — FIRST-FIN Inventory Importer v2.0
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

// ── Main scraper ──────────────────────────────────────────────────────────
function scrapeCurrentPage() {
  const hostname = location.hostname.toLowerCase();
  const url      = location.href;

  // ── House of Cars ─────────────────────────────────────────────────────
  if (hostname.includes('houseofcars.com')) {
    const isDetailPage = /\/(Used|New)-\d{4}-/i.test(location.pathname);

    if (!isDetailPage) {
      // Listing page — collect VDP links only (must match /inventory/Used-YYYY- or /inventory/New-YYYY-)
      const seen  = new Set();
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (seen.has(href)) return;
        // Only real VDP pages have this pattern — filters out nav, search, category links
        if (!/\/inventory\/(Used|New)-\d{4}-/i.test(href)) return;
        seen.add(href);
        links.push(href);
      });
      return { type: 'listing', links, url };
    }

    // Detail page
    const body = document.body.innerText;
    const slug = parseFromSlug(url);

    let title = '';
    for (const sel of ['h1.vehicle-title','h1.listing-title','.vehicle-name h1','h1','.car-title']) {
      const el = document.querySelector(sel);
      if (el?.innerText.trim().length > 3) { title = clean(el.innerText); break; }
    }
    title = title.replace(/^(used|new|pre-?owned)\s+/i, '').trim();

    let price = 0;
    const priceEl = document.querySelector('.price,.vehicle-price,.listing-price,[class*="price"]');
    if (priceEl) price = parsePrice(priceEl.innerText);
    if (!price) { const m = body.match(/\$([\d,]+)/); if (m) price = parseInt(m[1].replace(/,/g,'')); }

    let vin = slug.vin || '';
    if (!vin) { const m = body.match(/(?:vin|vehicle id)[:\s#]*([A-HJ-NPR-Z0-9]{17})/i); if (m) vin = m[1]; }

    let stock = '';
    const stockM = body.match(/(?:stock|stock\s*#)[:\s#]*([A-Z0-9\-]{4,12})/i);
    if (stockM) stock = stockM[1].toUpperCase();
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
      type: 'detail',
      vehicles: [{
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
      }]
    };
  }

  // ── Generic dealer site ───────────────────────────────────────────────
  const CARD_SELS = [
    '.vehicle-card', '.inventory-item', '.listing-item', '.car-card',
    '.vehicle-listing', 'article.vehicle', 'article.type-vehicle',
    '[class*="inventory-card"]', '[class*="vehicle-item"]',
    '.inventory-listing article', 'li.vehicle'
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
        type:     'Used', condition: 'Used', carfax: 0, book_value: 0,
        _title:   clean(h1Text),
        _photos:  [],
        _url:     url
      }]
    };
  }

  // Multiple vehicle cards
  const vehicles = [];
  cards.forEach((card, idx) => {
    try {
      const text     = clean(card.innerText);
      const link     = card.querySelector('a')?.href || url;
      const slugData = parseFromSlug(link);

      let title = clean(card.querySelector('h2,h3,.title,.name,.vehicle-title')?.innerText || '');
      title = title.replace(/^(used|new|pre-?owned)\s+/i, '').trim();

      const priceEl = card.querySelector('[class*="price"]');
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
        type:     'Used', condition: 'Used', carfax: 0, book_value: 0,
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
  return false; // synchronous response
});
