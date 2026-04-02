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
  if (parts.length > 2 && /^\d{1,2}$/.test(parts[parts.length - 1].trim()) &&
      !/^\d{3,}$/.test(parts[parts.length - 1].trim()) &&
      !/^model$/i.test(parts[parts.length - 2]?.trim())) {
    parts.pop();
  }
  if (parts[0]) result.make = normMake(parts[0].trim());
  if (parts[1]) result.model = titleWord(parts[1].trim());
  if (parts.length > 2) result.trim = parts.slice(2).map(p => titleWord(p.trim())).join(' ');
  return result;
}

// ── VDP link detection ───────────────────────────────────────────────────
const VDP_LINK_RE = /\/(inventory\/((Used|New)-)?|vehicle-details\/|vehicle\/|vehicles\/|demos\/|used\/|new\/inventory\/)\d{4}[-\/]/i;
const D2C_VDP_RE = /-id\d+\.html/i;

// ── Photo helpers (cheerio version) ──────────────────────────────────────
function addPhoto(src, photos, seen) {
  if (!src || src.length < 20) return;
  if (/logo|icon|placeholder|svg|badge|carfax|equifax|sprite|favicon|certified\.png|LIVE-CHAT|BANNER/i.test(src)) return;
  if (/cdn-convertus\.com/i.test(src)) return;
  if (/compressed\/\d+x\d+/i.test(src) || /\/\d+x\d+_/i.test(src)) return;
  if (/foxdealer\.com.*compressed/i.test(src)) return;
  if (/d2cmedia\.ca.*\/T\//i.test(src)) return;
  const cleaned = src.replace(/-\d+x\d+(\.\w+)$/, '$1');
  if (cleaned.startsWith('http') && !seen.has(cleaned)) { seen.add(cleaned); photos.push(cleaned); }
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
      addPhoto(getBestSrc($(img)), photos, seen);
    });
  }

  // Strategy 1.5: D2C sequential photo generation
  if (photos.length < 3) {
    const d2cBase = photos.find(p => /d2cmedia\.ca.*\/1\//i.test(p));
    if (d2cBase) {
      for (let n = 2; n <= 10; n++) {
        addPhoto(d2cBase.replace(/\/1\//, '/' + n + '/'), photos, seen);
      }
    }
  }

  // Strategy 2: CDN pattern matching
  if (photos.length < 3) {
    $('img').each((i, img) => {
      const src = getBestSrc($(img));
      if (/homenet|dealerphoto|dealerphotos|vehiclephoto|d2cmedia|imagescdn|autotradercdn|cdn.*\/(640|800|1024|1280)/i.test(src)) {
        addPhoto(src, photos, seen);
      }
    });
  }

  // Strategy 3: any non-junk image with size hints in URL
  if (photos.length < 3) {
    $('img').each((i, img) => {
      const src = getBestSrc($(img));
      if (/\/(640|800|1024|1280)x/i.test(src)) {
        addPhoto(src, photos, seen);
      }
    });
  }

  return photos.slice(0, 10);
}

// ── VDP detail page parser (cheerio version) ─────────────────────────────
function parseVdpDetailHtml(html, url) {
  const $ = cheerio.load(html);
  const body = $('body').text();
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

  // Stock
  let stock = '';
  const stockM = body.match(/(?:stock|stock\s*#)[:\s#]*([A-Z0-9\-]{4,12})/i);
  if (stockM) stock = stockM[1].toUpperCase();
  if (!stock && vin) stock = vin.slice(-8);
  if (!stock) stock = (url.split('/').filter(Boolean).pop() || '').slice(0, 12).toUpperCase();

  // Type
  const typeM = body.match(/\b(sedan|suv|truck|pickup|coupe|hatchback|van|wagon|convertible|crossover)\b/i);
  const type = typeM ? typeM[1][0].toUpperCase() + typeM[1].slice(1).toLowerCase() : 'Used';

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

  return {
    stock, vin, type, mileage, price,
    year: vehicleYear || 2020,
    make: finalMake, model: finalModel, trim: finalTrim,
    color, condition: 'Used', carfax: 0, book_value: 0,
    _title: title, _photos: photos, _url: url
  };
}

// ── Main page scraper (listing detection) ────────────────────────────────
function scrapePageHtml(html, url) {
  const $ = cheerio.load(html);
  const hostname = new URL(url).hostname.toLowerCase();
  const pathname = new URL(url).pathname;

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
      // Use VDP crawl to get full photo galleries instead of just card thumbnails
      if (vehicles.length > 0) {
        const vdpLinks = vehicles.map(v => v._url).filter(u => u && u !== url);
        if (vdpLinks.length > 0) {
          return { type: 'listing', links: vdpLinks, pageLinks: [], vehicaPagination: 0, url };
        }
        return { type: 'listing_cards', vehicles };
      }
    }
  }

  // ── 2. Check if VDP detail page ───────────────────────────────────────
  const isVdpDetail = VDP_LINK_RE.test(pathname);

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
        return { type: 'listing', links: vdpLinks, pageLinks: d2cPageLinks, vehicaPagination: 0, url };
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

      // Fallback: ?page= or /page/ URL patterns
      if (!foundInContainer) {
        $('a[href]').each((i, a) => {
          const href = $(a).attr('href') || '';
          if (pageSeen.has(href)) return;
          if (/[?&](page|pg|p|pagenumber)=\d+/i.test(href) || /\/page\/\d+/i.test(href)) {
            try { if (new URL(href).hostname !== new URL(url).hostname) return; } catch { return; }
            if (VDP_LINK_RE.test(href)) return;
            pageSeen.add(href); pageLinks.push(href);
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

      return { type: 'listing', links, pageLinks, vehicaPagination, hasLoadMore, url };
    }
  }

  // ── VDP detail page ───────────────────────────────────────────────────
  if (isVdpDetail) {
    return { type: 'detail', vehicles: [parseVdpDetailHtml(html, url)] };
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

  return { type: 'listing_cards', vehicles };
}

module.exports = { scrapePageHtml, parseVdpDetailHtml, parseFromSlug, VDP_LINK_RE, D2C_VDP_RE };
