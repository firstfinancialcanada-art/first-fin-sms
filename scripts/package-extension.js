// scripts/package-extension.js — Build obfuscated extension package for client distribution
// Usage: node scripts/package-extension.js
//
// Creates: ONBOARDING/firstfin-extension.zip
// - All JS files aggressively minified + mangled (Terser)
// - Variable/function names replaced with short gibberish
// - Comments stripped, whitespace removed
// - Icons, HTML, manifest preserved as-is
// - Source .src.js files excluded

'use strict';
const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');

const EXT_DIR  = path.join(__dirname, '..', 'chrome-extension');
const OUT_DIR  = path.join(__dirname, '..', 'ONBOARDING', 'firstfin-extension');
const ZIP_PATH = path.join(__dirname, '..', 'ONBOARDING', 'firstfin-extension.zip');

// Files to skip (source maps, readme)
const SKIP_FILES = [
  'popup.src.js',
  'background.src.js',
  'content.src.js',
  'README - INSTALL EXTENSION.txt'
];

const TERSER_OPTS = {
  compress: {
    dead_code: true,
    drop_console: true,       // strip all console.log — no debug breadcrumbs
    drop_debugger: true,
    passes: 3,
    booleans_as_integers: true,
    collapse_vars: true,
    reduce_vars: true,
    toplevel: true,
    unsafe_math: true
  },
  mangle: {
    toplevel: true,           // mangle top-level function/var names
    properties: {
      regex: /^_/             // mangle properties starting with _ (internal)
    }
  },
  format: {
    comments: false,          // strip all comments
    semicolons: true,
    wrap_iife: true
  }
};

async function run() {
  console.log('📦 Packaging FIRST-FIN extension for distribution...\n');

  // Clean output directory
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Copy and process all files
  const entries = fs.readdirSync(EXT_DIR, { withFileTypes: true });
  let minified = 0;

  for (const entry of entries) {
    if (SKIP_FILES.includes(entry.name)) {
      console.log(`  ⏭  ${entry.name} (skipped)`);
      continue;
    }

    const srcPath = path.join(EXT_DIR, entry.name);
    const outPath = path.join(OUT_DIR, entry.name);

    if (entry.isDirectory()) {
      // Copy directories (icons, etc.) recursively
      copyDirSync(srcPath, outPath);
      console.log(`  📁 ${entry.name}/ (copied)`);
      continue;
    }

    if (entry.name.endsWith('.js')) {
      // Minify + obfuscate JS files
      const src = fs.readFileSync(srcPath, 'utf8');
      try {
        const result = await minify(src, TERSER_OPTS);
        if (result.code) {
          fs.writeFileSync(outPath, result.code, 'utf8');
          const pct = (((src.length - result.code.length) / src.length) * 100).toFixed(1);
          console.log(`  🔒 ${entry.name} — ${src.length.toLocaleString()} → ${result.code.length.toLocaleString()} bytes (${pct}% smaller)`);
          minified++;
        } else {
          // Fallback: copy as-is
          fs.copyFileSync(srcPath, outPath);
          console.log(`  ⚠️  ${entry.name} — minify returned empty, copied as-is`);
        }
      } catch (err) {
        console.warn(`  ⚠️  ${entry.name} — minify failed: ${err.message}`);
        // Try less aggressive settings
        try {
          const fallback = await minify(src, {
            compress: { drop_console: true, passes: 2 },
            mangle: { toplevel: false },
            format: { comments: false }
          });
          if (fallback.code) {
            fs.writeFileSync(outPath, fallback.code, 'utf8');
            console.log(`  🔒 ${entry.name} — minified with fallback settings`);
            minified++;
          } else {
            fs.copyFileSync(srcPath, outPath);
          }
        } catch {
          fs.copyFileSync(srcPath, outPath);
          console.log(`  📄 ${entry.name} — copied unminified`);
        }
      }
    } else {
      // Copy non-JS files as-is (HTML, JSON, images, etc.)
      fs.copyFileSync(srcPath, outPath);
      console.log(`  📄 ${entry.name} (copied)`);
    }
  }

  // Create ZIP
  console.log(`\n🗜  Creating ZIP...`);
  await createZip(OUT_DIR, ZIP_PATH);

  console.log(`\n✅ Done — ${minified} JS files obfuscated`);
  console.log(`   📁 Folder: ${OUT_DIR}`);
  console.log(`   📦 ZIP:    ${ZIP_PATH}`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function createZip(sourceDir, zipPath) {
  // Use Node.js built-in or fall back to system zip
  try {
    const { execSync } = require('child_process');
    // Remove old zip if exists
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    // Try PowerShell Compress-Archive (Windows)
    const absSource = path.resolve(sourceDir) + '\\*';
    const absZip = path.resolve(zipPath);
    execSync(`powershell -Command "Compress-Archive -Path '${absSource}' -DestinationPath '${absZip}' -Force"`, { stdio: 'pipe' });
    console.log(`   ZIP created: ${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.log(`   ⚠️  Could not create ZIP automatically: ${e.message}`);
    console.log(`   📁 Use the folder at: ${sourceDir}`);
  }
}

run().catch(err => {
  console.error('❌ Package script error:', err.message);
  process.exit(1);
});
