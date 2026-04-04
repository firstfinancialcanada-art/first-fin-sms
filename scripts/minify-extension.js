// scripts/minify-extension.js — Minifies Chrome extension JS files for IP protection
// Keeps .src.js backups so you can develop on readable source
// Run: node scripts/minify-extension.js
const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');

const EXT_DIR = path.join(__dirname, '..', 'chrome-extension');
const FILES = ['content.js', 'background.js', 'popup.js'];

async function run() {
  console.log('🔒 Minifying Chrome extension for IP protection...\n');

  for (const file of FILES) {
    const filePath = path.join(EXT_DIR, file);
    const srcPath  = path.join(EXT_DIR, file.replace('.js', '.src.js'));

    if (!fs.existsSync(filePath)) {
      console.log(`  ⏭  ${file} — not found, skipping`);
      continue;
    }

    const src = fs.readFileSync(filePath, 'utf8');
    const lines = src.split('\n').length;

    // If already minified (< 10 lines), skip
    if (lines < 10) {
      console.log(`  ⏭  ${file} — already minified (${lines} lines)`);
      continue;
    }

    try {
      const result = await minify(src, {
        compress: {
          dead_code: true,
          drop_console: false,
          passes: 2
        },
        mangle: {
          keep_fnames: true,     // keep function names (Chrome APIs reference them)
          toplevel: false,       // DO NOT mangle top-level — breaks chrome.* API callbacks
          properties: false
        },
        format: {
          comments: false,
          beautify: false
        }
      });

      if (result.code) {
        // Backup readable source
        fs.writeFileSync(srcPath, src, 'utf8');
        // Write minified version
        fs.writeFileSync(filePath, result.code, 'utf8');
        const pct = (((src.length - result.code.length) / src.length) * 100).toFixed(1);
        console.log(`  ✅ ${file} — ${lines} lines → 1 line (${pct}% smaller) | backup: ${file.replace('.js', '.src.js')}`);
      }
    } catch (err) {
      console.error(`  ❌ ${file} — minify failed: ${err.message}`);
    }
  }

  console.log('\n🏁 Done. Extension files minified.');
  console.log('💡 To restore readable source: copy .src.js back to .js');
  console.log('💡 To re-minify after changes: node scripts/minify-extension.js\n');
}

run().catch(err => {
  console.error('Extension minify error:', err.message);
  process.exit(1);
});
