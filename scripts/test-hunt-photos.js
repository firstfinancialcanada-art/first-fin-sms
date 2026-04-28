// Direct test: fetch a Hunt Chrysler VDP and run our scraper against it.
// Bypasses extension/server entirely. Tells us what extractPhotos actually
// finds in the raw HTML.
//
// Usage: node scripts/test-hunt-photos.js <vdp-url>
// If no URL given, picks the first VDP off the listing page.

const scraper = require('../lib/scraper');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

(async () => {
  let url = process.argv[2];
  if (!url) {
    console.log('No URL passed — pulling first VDP from listing page');
    const listingHtml = await fetchHtml('https://www.huntchryslerfiat.ca/used/search.html');
    const m = listingHtml.match(/https:\/\/www\.huntchryslerfiat\.ca\/[^"'\s]*-id\d+\.html/);
    if (!m) { console.error('No VDP link found on listing page'); process.exit(1); }
    url = m[0];
    console.log('Using:', url);
  }

  console.log('\n--- Fetching VDP ---');
  const html = await fetchHtml(url);
  console.log('HTML length:', html.length, 'bytes');

  // Quick raw count of d2cmedia URLs in HTML
  const rawHits = [...new Set((html.match(/https?:\/\/[^\s"'<>)\\,]*d2cmedia[^\s"'<>)\\,]*\.(?:jpg|jpeg|png|webp)[^\s"'<>)\\,]*/gi) || []))];
  console.log('Raw unique d2cmedia URLs in HTML:', rawHits.length);

  console.log('\n--- Running parseVdpDetailHtml ---');
  const v = scraper.parseVdpDetailHtml(html, url);
  console.log('Year/Make/Model:', v.year, v.make, v.model);
  console.log('Mileage/Price:   ', v.mileage, '/', v.price);
  console.log('VIN/Stock:       ', v.vin, '/', v.stock);
  console.log('Photos returned: ', v._photos?.length || 0);
  if (v._photos?.length) {
    console.log('All photos:');
    v._photos.forEach((p, i) => console.log('  ' + String(i+1).padStart(2) + '.', p));
    const positions = v._photos.map(p => parseInt(p.match(/\/(\d+)\/[^/]+\.(?:jpg|jpeg|png|webp)/i)?.[1] || '0')).filter(Boolean);
    console.log('\nUnique positions in result:', [...new Set(positions)].sort((a,b)=>a-b).join(','));
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
