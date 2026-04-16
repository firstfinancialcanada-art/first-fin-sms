// scripts/minify.js — runs on postinstall, minifies public/js/*.js and strips comments from public/*.html
const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Files to skip minifying (already minified or third-party)
const SKIP = [];

async function minifyJs() {
  if (!fs.existsSync(JS_DIR)) {
    console.log('⚠️  public/js not found — skipping JS minify');
    return;
  }

  const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js') && !SKIP.includes(f));
  console.log(`🔧 Minifying ${files.length} JS files...`);

  let ok = 0, fail = 0;
  for (const file of files) {
    const filePath = path.join(JS_DIR, file);
    const src = fs.readFileSync(filePath, 'utf8');

    // Skip if already minified (no newlines = already compact)
    const lines = src.split('\n').length;
    if (lines < 5) { console.log(`  ⏭  ${file} (already minified)`); ok++; continue; }

    try {
      const result = await minify(src, {
        compress: {
          dead_code: true,
          drop_console: true, // strip console.log — hides internal flow from browser scrapers (Railway server logs unaffected)
          passes: 2
        },
        mangle: {
          keep_fnames: false,
          toplevel: false  // don't mangle top-level names — breaks window.FF etc
        },
        format: { comments: false }
      });

      if (result.code) {
        fs.writeFileSync(filePath, result.code, 'utf8');
        const savings = (((src.length - result.code.length) / src.length) * 100).toFixed(1);
        console.log(`  ✅ ${file} — ${savings}% smaller`);
        ok++;
      }
    } catch (err) {
      console.warn(`  ⚠️  ${file} — minify failed: ${err.message}`);
      fail++;
    }
  }

  console.log(`🏁 JS done — ${ok} minified, ${fail} failed`);
}

function stripHtmlComments() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.log('⚠️  public/ not found — skipping HTML strip');
    return;
  }

  const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
  console.log(`🧹 Stripping comments from ${htmlFiles.length} HTML files...`);

  let ok = 0, fail = 0;
  for (const file of htmlFiles) {
    const filePath = path.join(PUBLIC_DIR, file);
    const src = fs.readFileSync(filePath, 'utf8');
    try {
      // Strip HTML comments: <!-- ... -->
      // Does NOT touch <!DOCTYPE html> (starts with <!DOCTYPE, not <!--)
      // No IE conditional comments in this codebase (verified)
      const stripped = src.replace(/<!--[\s\S]*?-->/g, '');
      const savings = (((src.length - stripped.length) / src.length) * 100).toFixed(1);
      fs.writeFileSync(filePath, stripped, 'utf8');
      console.log(`  ✅ ${file} — ${savings}% smaller`);
      ok++;
    } catch (err) {
      console.warn(`  ⚠️  ${file} — strip failed: ${err.message}`);
      fail++;
    }
  }

  console.log(`🏁 HTML done — ${ok} processed, ${fail} failed`);
}

async function run() {
  await minifyJs();
  stripHtmlComments();
}

run().catch(err => {
  console.error('Minify script error:', err.message);
  process.exit(0); // don't block deploy if minify fails
});

