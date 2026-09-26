// scripts/package-extension.js — Build obfuscated extension package for client distribution
// Usage: node scripts/package-extension.js
//
// Creates: ONBOARDING/firstfin-extension.zip, and publishes the same zip to
// public/downloads/firstfin-extension.zip (the link customers download).
// - JS: comments + console calls stripped, whitespace removed, local
//   variable names mangled (Terser)
// - HTML: <!-- --> comments stripped
// - Icons, manifest preserved as-is
// - Source .src.js files excluded
// - A JS file that won't minify FAILS the build — readable source is never
//   shipped as a fallback
//
// Why not mangle harder: the old settings mangled top-level names and every
// property starting with "_". content.js, background.js and the platform
// page pass vehicles around as { _photos, _url, ... }, and each file is
// minified on its own, so those names came out different in each file and
// the pieces could no longer read each other's messages. The served zip had
// in fact been built some other way and shipped readable source from May 2.

'use strict';
const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');

const EXT_DIR  = path.join(__dirname, '..', 'chrome-extension');
const OUT_DIR  = path.join(__dirname, '..', 'ONBOARDING', 'firstfin-extension');
const ZIP_PATH = path.join(__dirname, '..', 'ONBOARDING', 'firstfin-extension.zip');
const PUBLIC_ZIP = path.join(__dirname, '..', 'public', 'downloads', 'firstfin-extension.zip');

// Files to skip (source maps, readme)
const SKIP_FILES = [
  'popup.src.js',
  'background.src.js',
  'content.src.js',
  'README - INSTALL EXTENSION.txt'
];

// The .src.js files are NOT build inputs and never were. They are gitignored
// April backups from before the tracked .js files became the readable source
// — content.js today is 1443 commented lines and carries fixes the 1034-line
// content.src.js has never seen. Editing a .src.js changes nothing and the
// silence is the problem: you get no error, just a fix that does not exist.
// Verified 2026-09-25: no function in any .src.js is absent from its .js, so
// they hold nothing worth keeping.
function warnAboutStaleSources() {
  const stale = [];
  for (const name of SKIP_FILES.filter(f => f.endsWith('.src.js'))) {
    const src  = path.join(EXT_DIR, name);
    const real = path.join(EXT_DIR, name.replace('.src.js', '.js'));
    if (!fs.existsSync(src) || !fs.existsSync(real)) continue;
    const sm = fs.statSync(src).mtime, rm = fs.statSync(real).mtime;
    const days = Math.round((rm - sm) / 86400000);
    if (days > 0) stale.push(`${name} is ${days} day(s) behind ${path.basename(real)}`);
  }
  if (stale.length) {
    console.warn('');
    console.warn('⚠️  Stale .src.js files present — they are NOT build inputs:');
    for (const line of stale) console.warn('     ' + line);
    console.warn('   Edit the tracked .js files. Deleting the .src.js copies is safe.');
    console.warn('');
  }
}

const TERSER_OPTS = {
  compress: {
    dead_code: true,
    drop_console: true,       // no debug breadcrumbs in the customer build
    drop_debugger: true,
    passes: 2
  },
  mangle: {
    toplevel: false,          // top-level names are shared across files
    keep_fnames: true
  },
  format: { comments: false }
};

async function run() {
  console.log('📦 Packaging FIRST-FIN extension for distribution...\n');
  warnAboutStaleSources();

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
          throw new Error('minify returned no code');
        }
      } catch (err) {
        throw new Error(`${entry.name} would not minify (${err.message}) — nothing packaged`);
      }
    } else if (entry.name.endsWith('.html')) {
      const html = fs.readFileSync(srcPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      fs.writeFileSync(outPath, html, 'utf8');
      console.log(`  📄 ${entry.name} (comments stripped)`);
    } else {
      // Copy non-JS files as-is (HTML, JSON, images, etc.)
      fs.copyFileSync(srcPath, outPath);
      console.log(`  📄 ${entry.name} (copied)`);
    }
  }

  // Create ZIP
  console.log(`\n🗜  Creating ZIP...`);
  await createZip(OUT_DIR, ZIP_PATH);
  fs.mkdirSync(path.dirname(PUBLIC_ZIP), { recursive: true });
  fs.copyFileSync(ZIP_PATH, PUBLIC_ZIP);
  console.log(`   🌐 Published: ${PUBLIC_ZIP}`);

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

// PowerShell's Compress-Archive writes entry names with backslashes, which
// Chrome's "Load unpacked" rejects after extraction on some systems. Build
// the archive with System.IO.Compression and explicit forward-slash names.
async function createZip(sourceDir, zipPath) {
  const { execFileSync } = require('child_process');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const src = path.resolve(sourceDir), dst = path.resolve(zipPath);
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
    `$src = '${src.replace(/'/g, "''")}'`,
    `$zip = [System.IO.Compression.ZipFile]::Open('${dst.replace(/'/g, "''")}', 'Create')`,
    'try {',
    '  Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {',
    "    $rel = $_.FullName.Substring($src.Length + 1).Replace('\\', '/')",
    '    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null',
    '  }',
    '} finally { $zip.Dispose() }',
  ].join('\n');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe' });
  console.log(`   ZIP created: ${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB`);
}

run().catch(err => {
  console.error('❌ Package script error:', err.message);
  process.exit(1);
});
