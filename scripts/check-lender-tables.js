#!/usr/bin/env node
// scripts/check-lender-tables.js — do the screen and the engine agree?
//
// The lender criteria exist twice: routes/compare.js holds the table the
// approval engine actually enforces, and public/js/platform-main.js holds the
// one drawn on screen. Nothing kept them in step, and they drifted: iA Auto
// Finance's bottom two tiers were shown with a 140,000 km cap while the engine
// applied the lender-wide 180,000 to every tier.
//
// That is the worst kind of bug in this product. It does not throw, it does not
// log, and it gives a confident wrong answer about a real customer's deal —
// either scaring off business that would have funded, or sending in a deal the
// lender will decline.
//
// Run it:  node scripts/check-lender-tables.js
// Exits 1 on any disagreement, so it can gate a deploy.
'use strict';

const fs   = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

// Both tables are declared as `const lenders = {`. Pull the literal out and
// evaluate it rather than parsing by hand — the shape changes often.
function extractTable(relPath) {
  const full  = path.join(root, relPath);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const start = lines.findIndex(l => /(?:^|\s)(?:const|let|var)\s+lenders\s*=\s*\{/.test(l));
  if (start === -1) throw new Error(`no 'lenders' table found in ${relPath}`);

  let depth = 0, started = false;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    out.push(lines[i]);
    if (started && depth === 0) break;
  }
  let src = out.join('\n');
  src = src.slice(src.indexOf('{')).trim();
  if (src.endsWith(';')) src = src.slice(0, -1);
  return eval('(' + src + ')');   // our own source, not user input
}

// "140,000" / "$7,500" / "140%" all reduce to a number for comparison.
const num = v => {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
};

// tier field -> the lender-wide field the engine falls back to
const FALLBACK = { maxMile: 'maxMileage', maxCfx: 'maxCarfax', maxLtv: 'maxLTV', minYear: 'minYear' };

function main() {
  const server = extractTable('routes/compare.js');
  const client = extractTable('public/js/platform-main.js');
  const problems = [];

  const keys = [...new Set([...Object.keys(server), ...Object.keys(client)])].sort();
  for (const k of keys) {
    const s = server[k], c = client[k];
    if (!s) { problems.push(`${k}: on screen but not in the engine`); continue; }
    if (!c) { problems.push(`${k}: in the engine but not on screen`); continue; }

    for (const f of ['minYear', 'maxMileage', 'maxCarfax', 'maxLTV']) {
      if (num(s[f]) !== num(c[f])) problems.push(`${k}.${f}: engine=${s[f]} screen=${c[f]}`);
    }

    const sp = s.programs || [], cp = c.programs || [];
    if (sp.length !== cp.length) {
      problems.push(`${k}: ${sp.length} tiers in the engine, ${cp.length} on screen`);
      continue;
    }
    for (let i = 0; i < sp.length; i++) {
      const tier = cp[i].tier || `tier ${i + 1}`;
      for (const f of ['minYear', 'maxLtv', 'maxMile', 'maxCfx']) {
        const sv = num(sp[i][f]), cv = num(cp[i][f]);
        if (sv === null && cv !== null) {
          // No per-tier value server-side means the engine applies the
          // lender-wide limit. Only a problem if the screen disagrees with it.
          const wide = num(s[FALLBACK[f]]);
          if (wide !== cv) {
            problems.push(`${k} [${tier}] ${f}: screen says ${cp[i][f]}, engine has no tier value so applies lender-wide ${wide}`);
          }
        } else if (sv !== null && cv !== null && sv !== cv) {
          problems.push(`${k} [${tier}] ${f}: engine=${sp[i][f]} screen=${cp[i][f]}`);
        }
      }
    }
  }

  console.log(`Checked ${keys.length} lenders.`);
  if (!problems.length) {
    console.log('✅ the screen and the approval engine agree');
    return 0;
  }
  console.log(`❌ ${problems.length} disagreement(s):\n`);
  for (const p of problems) console.log('   ' + p);
  console.log('\nEach one is a wrong answer about a real deal. Fix the table that is wrong,');
  console.log('then re-run. Lender policy is a question for Franco, not a guess.');
  return 1;
}

process.exit(main());
