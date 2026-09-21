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

// Inline <script> blocks. Stripping <!-- --> left every // comment inside
// the pages' own scripts live — ~160 lines on /platform naming client
// stores, lender sources and file paths (2026-09-21 audit). Comments and
// whitespace only: no compress, no mangle, so nothing is renamed and the
// globals that onclick="" handlers call stay intact. A block terser can't
// parse is left exactly as it was rather than failing the page.
async function stripInlineScriptComments(html, label) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let out = '', last = 0, m, done = 0, kept = 0;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    let code = m[1];
    try {
      const r = await minify(code, { compress: false, mangle: false, format: { comments: false } });
      if (r.code != null) { code = r.code; done++; }
    } catch (err) {
      kept++;
      console.warn(`  ⚠️  ${label} inline script left as-is: ${err.message}`);
    }
    out += '<script>' + code + '</script>';
    last = re.lastIndex;
  }
  return { html: out + html.slice(last), done, kept };
}

async function stripHtmlComments(dir = PUBLIC_DIR) {
  if (!fs.existsSync(dir)) {
    console.log('⚠️  public/ not found — skipping HTML strip');
    return;
  }

  const htmlFiles = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  console.log(`🧹 Stripping comments from ${htmlFiles.length} HTML files...`);

  let ok = 0, fail = 0;
  for (const file of htmlFiles) {
    const filePath = path.join(dir, file);
    const src = fs.readFileSync(filePath, 'utf8');
    try {
      // Strip HTML comments: <!-- ... -->
      // Does NOT touch <!DOCTYPE html> (starts with <!DOCTYPE, not <!--)
      // No IE conditional comments in this codebase (verified)
      const noHtmlComments = src.replace(/<!--[\s\S]*?-->/g, '');
      const { html: stripped, done, kept } = await stripInlineScriptComments(noHtmlComments, file);
      const savings = (((src.length - stripped.length) / src.length) * 100).toFixed(1);
      fs.writeFileSync(filePath, stripped, 'utf8');
      console.log(`  ✅ ${file} — ${savings}% smaller (${done} inline script${done === 1 ? '' : 's'}${kept ? `, ${kept} left as-is` : ''})`);
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
  await stripHtmlComments();
}

module.exports = { stripHtmlComments, stripInlineScriptComments };

if (require.main === module) {
  run().catch(err => {
    console.error('Minify script error:', err.message);
    process.exit(0); // don't block deploy if minify fails
  });
}

