// scripts/minify.js — runs on postinstall, minifies public/js/*.js in place
const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');

// Files to skip minifying (already minified or third-party)
const SKIP = [];

async function run() {
  if (!fs.existsSync(JS_DIR)) {
    console.log('⚠️  public/js not found — skipping minify');
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
          drop_console: false, // keep console.log for now — useful for Railway logs
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

  console.log(`🏁 Done — ${ok} minified, ${fail} failed`);
}

run().catch(err => {
  console.error('Minify script error:', err.message);
  process.exit(0); // don't block deploy if minify fails
});

