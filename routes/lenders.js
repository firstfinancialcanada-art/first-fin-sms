// ============================================================
// routes/lenders.js — Multi-Tenant Lender Rate Sheet Engine
// Handles: PDF upload + parsing, manual entry, rate retrieval
// Mounts: /api/lenders/*
// ============================================================
const { requireAuth } = require('../middleware/auth');

// multer is lazy-loaded inside the upload route — missing dep won't crash the server
function getUpload() {
  try {
    const multer = require('multer');
    return multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Only PDF files accepted'), false);
      }
    });
  } catch(e) {
    return null;
  }
}

// ── Lender fee defaults (added to ATF before LTV calc) ────────────────────
const DEFAULT_LENDER_FEES = {
  autocapital: 895,
  cibc: 0,
  edenpark: 695,
  iceberg: 695,
  northlake: 695,
  prefera: 695,
  rbc: 0,
  santander: 595,
  sda: 995,
  servus: 0,
  wsleasing: 0
};

// ── Lender detection from PDF text ────────────────────────────────────────
function detectLender(text) {
  if (/scotia.*dealer|sda\s*finance|scotiabank.*auto/i.test(text)) return 'sda';
  if (/autocapital/i.test(text)) return 'autocapital';
  if (/northlake/i.test(text))   return 'northlake';
  if (/eden\s*park/i.test(text)) return 'edenpark';
  if (/iceberg/i.test(text))     return 'iceberg';
  if (/prefera/i.test(text))     return 'prefera';
  if (/santander/i.test(text))   return 'santander';
  if (/rbc.*auto|royal.*bank.*auto/i.test(text)) return 'rbc';
  if (/cibc.*auto/i.test(text))  return 'cibc';
  if (/servus/i.test(text))      return 'servus';
  if (/iA\s*Auto\s*Finance|ia\.ca|iafastincome|shift\s*into\s*gear/i.test(text)) return 'iauto';
  return null;
}

// ── Generic rate extractor helper ─────────────────────────────────────────
// Searches a block of lines for a decimal rate like 13.49%
function findRateInBlock(lines, startIdx, windowSize = 4) {
  const block = lines.slice(startIdx, startIdx + windowSize).join(' ');
  const m = block.match(/(\d{1,2}\.\d{2})\s*%/);
  return m ? parseFloat(m[1]) : null;
}

// Searches a block for a FICO range like 680+, 620-679, <540
function findFicoInBlock(lines, startIdx, windowSize = 4) {
  const block = lines.slice(startIdx, startIdx + windowSize).join(' ');
  if (/no\s*min|no\s*fico|n\/a|credit.based|varies/i.test(block)) return { min: 0, max: 9999 };
  const rangeM = block.match(/(\d{3})\s*[–\-]\s*(\d{3})/);
  if (rangeM) return { min: parseInt(rangeM[1]), max: parseInt(rangeM[2]) };
  const plusM = block.match(/(\d{3})\+/);
  if (plusM) return { min: parseInt(plusM[1]), max: 9999 };
  const ltM = block.match(/<\s*(\d{3})/);
  if (ltM) return { min: 0, max: parseInt(ltM[1]) - 1 };
  return null;
}

// ── SDA (Scotia Dealer Advantage) parser ──────────────────────────────────
// SDA rate sheets use "Star 7", "Star 6" etc. tiers
function extractSDA(lines) {
  const programs = [];
  const ltvMap  = { 7: 180, 6: 180, 5: 165, 4: 160, 3: 140, 2: 125, 1: 110 };
  const ficoMap = { 7: 750, 6: 700, 5: 650, 4: 600, 3: 550, 2: 500, 1: 450 };

  lines.forEach((line, i) => {
    const starM = line.match(/Star\s*(\d)/i);
    if (!starM) return;
    const star = parseInt(starM[1]);
    const rate = findRateInBlock(lines, i, 4);
    if (!rate) return;
    const minFico = ficoMap[star] || 0;
    const maxLTV  = ltvMap[star]  || 140;
    programs.push({
      tier: `Star ${star}`,
      rate, minFico, maxFico: ficoMap[star - 1] ? ficoMap[star - 1] - 1 : 9999,
      maxLTV, minYear: star >= 5 ? 2015 : 2012,
      maxMileage: 250000, maxCarfax: 8000, fee: 995
    });
  });

  // Deduplicate by tier
  return programs.filter((p, i, arr) => arr.findIndex(x => x.tier === p.tier) === i);
}

// ── Autocapital parser ─────────────────────────────────────────────────────
// Tiers: Tier 1 (Prime) through Tier 6 (Subprime)
function extractAutocapital(lines) {
  const programs = [];
  const tierDefaults = {
    1: { minFico: 680, maxFico: 9999, rate: 13.49, minYear: 2025, maxLTV: 175 },
    2: { minFico: 620, maxFico: 679,  rate: 14.49, minYear: 2024, maxLTV: 175 },
    3: { minFico: 590, maxFico: 619,  rate: 15.99, minYear: 2023, maxLTV: 165 },
    4: { minFico: 560, maxFico: 589,  rate: 17.99, minYear: 2022, maxLTV: 165 },
    5: { minFico: 540, maxFico: 559,  rate: 21.49, minYear: 2020, maxLTV: 150 },
    6: { minFico: 0,   maxFico: 539,  rate: 23.49, minYear: 2015, maxLTV: 150 }
  };

  lines.forEach((line, i) => {
    const tierM = line.match(/Tier\s*(\d)/i);
    if (!tierM) return;
    const tier = parseInt(tierM[1]);
    if (!tierDefaults[tier]) return;
    const d = tierDefaults[tier];
    const rate = findRateInBlock(lines, i, 3) || d.rate;
    const fico = findFicoInBlock(lines, i, 4) || { min: d.minFico, max: d.maxFico };
    programs.push({
      tier: `Tier ${tier}`, rate,
      minFico: fico.min, maxFico: fico.max,
      maxLTV: d.maxLTV, minYear: d.minYear,
      maxMileage: 195000, maxCarfax: 7500, fee: 895
    });
  });

  return programs.filter((p, i, arr) => arr.findIndex(x => x.tier === p.tier) === i);
}

// ── Northlake parser ───────────────────────────────────────────────────────
function extractNorthlake(lines) {
  const programs = [];
  const text = lines.join(' ');

  // ── Current format (March 2026): Titanium/Platinum/Gold/Standard ─────────
  // Titanium 750+: 6.99%+, LTV 150%, PTI 20%
  // Platinum 700-749: 8.99%+, LTV 140%, PTI 20%
  // Gold 600-699: 12.99%+, LTV 135%, PTI 18%
  // Standard 500-599: 17.99%+, LTV 125%, PTI 17%
  const currentTiers = [
    { name: 'Titanium', minFico: 750, maxFico: 9999, rate: 6.99,  maxLTV: 150, maxMileage: 300000 },
    { name: 'Platinum', minFico: 700, maxFico: 749,  rate: 8.99,  maxLTV: 140, maxMileage: 300000 },
    { name: 'Gold',     minFico: 600, maxFico: 699,  rate: 12.99, maxLTV: 135, maxMileage: 300000 },
    { name: 'Standard', minFico: 500, maxFico: 599,  rate: 17.99, maxLTV: 125, maxMileage: 300000 },
  ];

  const hasTitanium = /titanium/i.test(text);
  const hasPlatinum = /platinum/i.test(text);

  if (hasTitanium || hasPlatinum) {
    // Current tier format detected — use known rates, optionally parse from PDF
    currentTiers.forEach(t => {
      // Try to parse rate from PDF text for this tier
      const ratePattern = new RegExp(t.name + '[^%\d]*(\d{1,2}\.\d{2})\s*\+?\s*%?', 'i');
      const m = text.match(ratePattern);
      const rate = m ? parseFloat(m[1]) : t.rate;
      programs.push({
        tier: t.name, rate,
        minFico: t.minFico, maxFico: t.maxFico,
        maxLTV: t.maxLTV, minYear: 2003,
        maxMileage: t.maxMileage, maxCarfax: 7500, fee: 695
      });
    });
    return programs;
  }

  // ── Legacy format: Standard/Extended/U-Drive ──────────────────────────────
  const keywords = { standard: 0, extended: 1, 'u-drive': 2, drive: 2 };
  lines.forEach((line, i) => {
    const lc = line.toLowerCase();
    const key = Object.keys(keywords).find(k => lc.includes(k));
    if (!key) return;
    const rate = findRateInBlock(lines, i, 4);
    if (!rate) return;
    const rateMin = key === 'standard' ? 10.99 : key === 'extended' ? 17.99 : 22.99;
    programs.push({
      tier: key.charAt(0).toUpperCase() + key.slice(1),
      rate: rate || rateMin,
      minFico: 0, maxFico: 9999,
      maxLTV: key === 'standard' ? 140 : 130,
      minYear: key === 'extended' ? 2003 : 2015,
      maxMileage: key === 'extended' ? 300000 : 200000,
      maxCarfax: 7500, fee: 695
    });
  });
  return programs.filter((p, i, arr) => arr.findIndex(x => x.tier === p.tier) === i);
}

// ── Prefera parser ─────────────────────────────────────────────────────────
function extractPrefera(lines) {
  const programs = [];
  const tierMap = {
    A: { minFico: 620, maxFico: 9999, minYear: 2018, maxLTV: 170 },
    B: { minFico: 580, maxFico: 619, minYear: 2016, maxLTV: 160 },
    C: { minFico: 550, maxFico: 579, minYear: 2015, maxLTV: 150 },
    D: { minFico: 0,   maxFico: 549, minYear: 2015, maxLTV: 140 }
  };
  lines.forEach((line, i) => {
    const tierM = line.match(/Tier\s*([A-D])/i);
    if (!tierM) return;
    const t = tierM[1].toUpperCase();
    if (!tierMap[t]) return;
    const rate = findRateInBlock(lines, i, 3);
    if (!rate) return;
    const d = tierMap[t];
    programs.push({
      tier: `Tier ${t}`, rate,
      minFico: d.minFico, maxFico: d.maxFico,
      maxLTV: d.maxLTV, minYear: d.minYear,
      maxMileage: 200000, maxCarfax: 5000, fee: 695
    });
  });
  return programs.filter((p, i, arr) => arr.findIndex(x => x.tier === p.tier) === i);
}

// ── Edenpark parser ────────────────────────────────────────────────────────
function extractEdenpark(lines) {
  const programs = [];
  const tierMap = {
    A: { minFico: 640, maxFico: 9999, minYear: 2020, maxLTV: 140 },
    B: { minFico: 600, maxFico: 639,  minYear: 2017, maxLTV: 135 },
    C: { minFico: 560, maxFico: 599,  minYear: 2016, maxLTV: 130 },
    D: { minFico: 0,   maxFico: 559,  minYear: 2015, maxLTV: 125 }
  };
  lines.forEach((line, i) => {
    const tierM = line.match(/Tier\s*([A-D])/i);
    if (!tierM) return;
    const t = tierM[1].toUpperCase();
    if (!tierMap[t]) return;
    const rate = findRateInBlock(lines, i, 3);
    if (!rate) return;
    const d = tierMap[t];
    programs.push({
      tier: `Tier ${t}`, rate,
      minFico: d.minFico, maxFico: d.maxFico,
      maxLTV: d.maxLTV, minYear: d.minYear,
      maxMileage: 180000, maxCarfax: 7500, fee: 695
    });
  });
  return programs.filter((p, i, arr) => arr.findIndex(x => x.tier === p.tier) === i);
}

// ── Iceberg parser ─────────────────────────────────────────────────────────
function extractIceberg(lines) {
  const programs = [];
  const text = lines.join(' ');

  // Iceberg uses Gold/Silver/Bronze tiers (current rate sheet format)
  // Gold: 12.99%-20.25%, Silver: 20.99%-27.25%, Bronze: 27.99%-31.99%
  // Gold = 640+ beacon, Silver = 600-639, Bronze = 560-599
  const tierDefs = [
    { names: ['gold'],   minFico: 640, maxFico: 9999, ratePattern: /gold[^%]*?(\d{1,2}\.\d{2})\s*%/i,   minYear: 2012, maxLTV: 140, maxMileage: 180000, maxCarfax: 6500 },
    { names: ['silver'], minFico: 600, maxFico: 639,  ratePattern: /silver[^%]*?(\d{1,2}\.\d{2})\s*%/i, minYear: 2012, maxLTV: 140, maxMileage: 180000, maxCarfax: 6500 },
    { names: ['bronze'], minFico: 0,   maxFico: 599,  ratePattern: /bronze[^%]*?(\d{1,2}\.\d{2})\s*%/i, minYear: 2012, maxLTV: 140, maxMileage: 180000, maxCarfax: 6500 },
  ];

  // Try Gold/Silver/Bronze format first
  let found = false;
  tierDefs.forEach(def => {
    const m = text.match(def.ratePattern);
    const rate = m ? parseFloat(m[1]) : null;
    if (rate) {
      programs.push({
        tier: def.names[0].charAt(0).toUpperCase() + def.names[0].slice(1),
        rate, minFico: def.minFico, maxFico: def.maxFico,
        maxLTV: def.maxLTV, minYear: def.minYear,
        maxMileage: def.maxMileage, maxCarfax: def.maxCarfax, fee: 695
      });
      found = true;
    }
  });
  if (found) return programs;

  // Fallback: look for legacy Tier 1/2/3/4 format
  const tierMap = {
    1: { minFico: 640, maxFico: 9999, minYear: 2018, maxLTV: 140 },
    2: { minFico: 600, maxFico: 639,  minYear: 2015, maxLTV: 135 },
    3: { minFico: 560, maxFico: 599,  minYear: 2013, maxLTV: 130 },
    4: { minFico: 0,   maxFico: 559,  minYear: 2012, maxLTV: 125 }
  };
  lines.forEach((line, i) => {
    const tierM = line.match(/Tier\s*(\d)/i);
    if (!tierM) return;
    const t = parseInt(tierM[1]);
    if (!tierMap[t]) return;
    const rate = findRateInBlock(lines, i, 3);
    if (!rate) return;
    const d = tierMap[t];
    programs.push({
      tier: `Tier ${t}`, rate,
      minFico: d.minFico, maxFico: d.maxFico,
      maxLTV: d.maxLTV, minYear: d.minYear,
      maxMileage: 180000, maxCarfax: 6500, fee: 695
    });
  });
  return programs.filter((p, i, arr) => arr.findIndex(x => x.tier === p.tier) === i);
}

// ── iA Auto Finance parser (Gear-based tiers) ────────────────────────────
function extractIAuto(lines) {
  const text = lines.join(' ');
  const programs = [];

  // iA uses 6th/5th/4th/3rd/2nd/1st Gear naming
  // Try to parse rates directly from PDF text
  const gearDefs = [
    { name: '6th Gear', minFico: 700, maxFico: 9999, defaultRate: 11.49, maxLTV: 140, maxMileage: 180000 },
    { name: '5th Gear', minFico: 650, maxFico: 699,  defaultRate: 15.49, maxLTV: 140, maxMileage: 180000 },
    { name: '4th Gear', minFico: 600, maxFico: 649,  defaultRate: 20.49, maxLTV: 135, maxMileage: 180000 },
    { name: '3rd Gear', minFico: 560, maxFico: 599,  defaultRate: 25.49, maxLTV: 125, maxMileage: 180000 },
    { name: '2nd Gear', minFico: 520, maxFico: 559,  defaultRate: 29.99, maxLTV: 125, maxMileage: 140000 },
    { name: '1st Gear', minFico: 0,   maxFico: 519,  defaultRate: 29.99, maxLTV: 110, maxMileage: 140000 },
  ];

  // Try to find rates in a row — iA lists them as: 11.49% 15.49% 20.49% 25.49% 29.99% 29.99%
  const rateMatches = text.match(/(\d{1,2}\.\d{2})%/g);
  const rates = rateMatches ? rateMatches.map(r => parseFloat(r)).filter(r => r > 5 && r < 40) : [];
  // Deduplicate while preserving order
  const uniqueRates = [...new Map(rates.map(r => [r, r])).values()];

  gearDefs.forEach((def, i) => {
    const rate = uniqueRates[i] || def.defaultRate;
    programs.push({
      tier: def.name, rate,
      minFico: def.minFico, maxFico: def.maxFico,
      maxLTV: def.maxLTV, minYear: 2015,
      maxMileage: def.maxMileage, maxCarfax: 7500, fee: 699
    });
  });

  return programs;
}

// ── Generic fallback parser (pull any % rates with tier labels) ───────────
function extractGeneric(lines) {
  const programs = [];
  const text = lines.join(' ');

  // ── Pattern 1: Named tiers — Gold/Silver/Bronze/Platinum/Titanium/Standard ──
  const namedTiers = [
    { pat: /titanium/i, name: 'Titanium', minFico: 750 },
    { pat: /platinum/i, name: 'Platinum', minFico: 700 },
    { pat: /gold/i,     name: 'Gold',     minFico: 640 },
    { pat: /silver/i,   name: 'Silver',   minFico: 600 },
    { pat: /bronze/i,   name: 'Bronze',   minFico: 560 },
    { pat: /standard/i, name: 'Standard', minFico: 500 },
  ];
  const namedFound = namedTiers.filter(t => t.pat.test(text));
  if (namedFound.length >= 2) {
    namedFound.forEach((t, idx) => {
      const rateP = new RegExp(t.name + '[^%\\d]*(\\d{1,2}\\.\\d{2})\\s*\\+?\\s*%?', 'i');
      const m = text.match(rateP);
      if (m) {
        programs.push({
          tier: t.name, rate: parseFloat(m[1]),
          minFico: t.minFico, maxFico: namedFound[idx-1] ? namedFound[idx-1].minFico - 1 : 9999,
          maxLTV: 140, minYear: 2015,
          maxMileage: 200000, maxCarfax: 7500, fee: 0
        });
      }
    });
    if (programs.length >= 2) return programs;
  }

  // ── Pattern 2: Ordinal Gear tiers — 6th, 5th, 4th etc ───────────────────
  const gearM = text.match(/(\d+)(?:st|nd|rd|th)\s*(?:gear)?[^%]*(\d{1,2}\.\d{2})\s*%/gi);
  if (gearM && gearM.length >= 2) {
    gearM.forEach(match => {
      const numM = match.match(/(\d+)(?:st|nd|rd|th)/i);
      const rateM = match.match(/(\d{1,2}\.\d{2})\s*%/);
      if (numM && rateM) {
        programs.push({
          tier: numM[0] + ' Gear', rate: parseFloat(rateM[1]),
          minFico: 0, maxFico: 9999,
          maxLTV: 140, minYear: 2015,
          maxMileage: 200000, maxCarfax: 7500, fee: 0
        });
      }
    });
    if (programs.length >= 2) return programs.slice(0, 8);
  }

  // ── Pattern 3: Lettered tiers — A/B/C/D ─────────────────────────────────
  const letterTiers = ['A','B','C','D','E'];
  const letterFico  = [700, 640, 580, 520, 0];
  let letterFound = 0;
  lines.forEach((line, i) => {
    const m = line.match(/^(?:Tier\s*)?([A-E])(?:\s|$|\+|-)/);
    if (!m) return;
    const idx = letterTiers.indexOf(m[1]);
    if (idx < 0) return;
    const rate = findRateInBlock(lines, i, 4);
    if (!rate) return;
    programs.push({
      tier: 'Tier ' + m[1], rate,
      minFico: letterFico[idx], maxFico: idx > 0 ? letterFico[idx-1]-1 : 9999,
      maxLTV: 140 - (idx * 5), minYear: 2015,
      maxMileage: 200000, maxCarfax: 7500, fee: 0
    });
    letterFound++;
  });
  if (letterFound >= 2) return programs.filter((p,i,a) => a.findIndex(x=>x.tier===p.tier)===i);

  // ── Pattern 4: Numbered tiers — Tier 1/2/3/4 Star 7/6/5 etc ─────────────
  const tierPatterns = [/Tier\s*(\d)/i, /Star\s*(\d)/i, /Program\s*(\d)/i, /Grade\s*([A-D])/i];
  lines.forEach((line, i) => {
    let tierName = null;
    for (const pat of tierPatterns) {
      const m = line.match(pat);
      if (m) { tierName = line.trim(); break; }
    }
    if (!tierName) return;
    const rate = findRateInBlock(lines, i, 4);
    if (!rate) return;
    const fico = findFicoInBlock(lines, i, 4) || { min: 0, max: 9999 };
    programs.push({
      tier: tierName.slice(0, 40),
      rate, minFico: fico.min, maxFico: fico.max,
      maxLTV: 140, minYear: 2015,
      maxMileage: 200000, maxCarfax: 7500, fee: 0
    });
  });
  return programs.filter((p, i, arr) => arr.findIndex(x => x.tier === p.tier) === i).slice(0, 8);
}

// ── Router dispatcher ──────────────────────────────────────────────────────
function extractRates(text, lenderName) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  switch (lenderName) {
    case 'sda':         return extractSDA(lines);
    case 'autocapital': return extractAutocapital(lines);
    case 'northlake':   return extractNorthlake(lines);
    case 'prefera':     return extractPrefera(lines);
    case 'edenpark':    return extractEdenpark(lines);
    case 'iceberg':     return extractIceberg(lines);
    case 'iauto':       return extractIAuto(lines);
    default:            return extractGeneric(lines);
  }
}

// ── Route module ───────────────────────────────────────────────────────────
// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}

module.exports = function (app, pool, requireBilling) {

  // Ensure table exists on first load
  (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lender_rate_sheets (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES desk_users(id) ON DELETE CASCADE,
        lender_name  TEXT NOT NULL,
        tier_name    TEXT,
        min_fico     INTEGER DEFAULT 0,
        max_fico     INTEGER DEFAULT 9999,
        min_year     INTEGER,
        max_mileage  INTEGER,
        max_carfax   INTEGER,
        max_ltv      INTEGER,
        buy_rate     DECIMAL(6,2),
        lender_fee   DECIMAL(10,2) DEFAULT 0,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_lrs_user_lender
        ON lender_rate_sheets(user_id, lender_name);
    `);
    console.log('✅ lender_rate_sheets table ready');
  })().catch(e => console.error('❌ lender_rate_sheets migration:', e.message));

  // ── GET /api/lenders/rates ─────────────────────────────────────────────
  // Returns tenant's custom rate sheets + extraLenders (DB lenders not in hardcoded list)
  app.get('/api/lenders/rates', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT lender_name, tier_name, min_fico, max_fico, min_year,
                max_mileage, max_carfax, max_ltv, buy_rate, lender_fee
         FROM lender_rate_sheets
         WHERE user_id = $1
         ORDER BY lender_name, min_fico DESC`,
        [req.user.userId]
      );

      // Known lender keys — these are handled by hardcoded lender objects in frontend
      const KNOWN_KEYS = ['sda','autocapital','northlake','prefera','edenpark','iceberg',
                          'cibc','rbc','santander','servus','wsleasing','iauto'];

      // Group all DB rates by lender_name
      const grouped = {};
      rows.forEach(r => {
        if (!grouped[r.lender_name]) grouped[r.lender_name] = [];
        grouped[r.lender_name].push(r);
      });

      // extraLenders = lenders in DB not in the known hardcoded list
      const extraLenders = {};
      Object.entries(grouped).forEach(([key, tiers]) => {
        if (!KNOWN_KEYS.includes(key)) {
          // Build a display name from the key
          const displayName = key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          extraLenders[key] = {
            name: displayName,
            tiers: tiers.map(t => ({
              tier: t.tier_name,
              minFico: parseInt(t.min_fico) || 0,
              maxFico: parseInt(t.max_fico) || 9999,
              rate: parseFloat(t.buy_rate) || 0,
              maxLTV: parseInt(t.max_ltv) || 140,
              minYear: parseInt(t.min_year) || 2015,
              maxMileage: parseInt(t.max_mileage) || 200000,
              maxCarfax: parseInt(t.max_carfax) || 7500,
              fee: parseFloat(t.lender_fee) || 0,
            }))
          };
        }
      });

      res.json({
        success: true,
        rates: rows,
        hasCustomRates: rows.length > 0,
        extraLenders   // dynamic lenders unknown to frontend
      });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── POST /api/lenders/upload-sheet ─────────────────────────────────────
  // Accepts PDF, detects lender, parses tiers, saves to DB
  app.post('/api/lenders/upload-sheet', requireAuth, requireBilling, async (req, res) => {
    const upload = getUpload();
    if (!upload) {
      return res.status(503).json({ success: false, error: 'PDF upload not available — multer not installed. Run: npm install multer pdf-parse' });
    }
    // Apply multer as inline middleware
    await new Promise((resolve, reject) => {
      upload.single('sheet')(req, res, (err) => {
        if (err) reject(err); else resolve();
      });
    }).catch(err => { return res.status(400).json({ success: false, error: sanitizeError(err) }); });
    if (res.headersSent) return;
    if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file uploaded' });
    let pdf;
    try { pdf = require('pdf-parse'); } catch (e) {
      return res.status(500).json({
        success: false,
        error: 'pdf-parse not installed. Run: npm install pdf-parse multer'
      });
    }
    try {
      const data      = await pdf(req.file.buffer);
      const text      = data.text;
      const userId    = req.user.userId;
      const detected  = detectLender(text);
      const lenderName = detected || req.body.lenderName?.toLowerCase();

      if (!lenderName) {
        return res.status(422).json({
          success: false, fallback: true,
          rawSnippet: text.slice(0, 400),
          error: 'Could not identify lender from PDF. Select manually and re-upload.'
        });
      }

      const extracted = extractRates(text, lenderName);

      if (!extracted.length) {
        return res.status(422).json({
          success: false, fallback: true,
          lender: lenderName,
          rawSnippet: text.slice(0, 600),
          error: `Detected ${lenderName.toUpperCase()} but could not parse rate tiers. Use manual entry.`
        });
      }

      // Upsert: clear old rates for this lender/user, insert fresh
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM lender_rate_sheets WHERE user_id = $1 AND lender_name = $2',
          [userId, lenderName]
        );
        for (const item of extracted) {
          await client.query(
            `INSERT INTO lender_rate_sheets
             (user_id, lender_name, tier_name, min_fico, max_fico, buy_rate,
              max_ltv, min_year, max_mileage, max_carfax, lender_fee)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [userId, lenderName, item.tier, item.minFico, item.maxFico,
             item.rate||0, item.maxLTV, item.minYear, item.maxMileage,
             item.maxCarfax, item.fee || DEFAULT_LENDER_FEES[lenderName] || 0]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({
        success: true,
        lender: lenderName,
        count: extracted.length,
        tiers: extracted.map(t => ({ tier: t.tier, rate: t.rate + '%', fico: `${t.minFico}–${t.maxFico === 9999 ? '∞' : t.maxFico}` }))
      });

    } catch (e) {
      console.error('❌ PDF parse error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── POST /api/lenders/manual-rates ────────────────────────────────────
  // Manual tier entry fallback
  app.post('/api/lenders/manual-rates', requireAuth, requireBilling, async (req, res) => {
    const { lenderName, tiers } = req.body;
    if (!lenderName || !Array.isArray(tiers) || !tiers.length) {
      return res.status(400).json({ success: false, error: 'lenderName and tiers[] required' });
    }
    const userId = req.user.userId;
    const lid    = lenderName.toLowerCase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM lender_rate_sheets WHERE user_id = $1 AND lender_name = $2',
        [userId, lid]
      );
      for (const t of tiers) {
        await client.query(
          `INSERT INTO lender_rate_sheets
           (user_id, lender_name, tier_name, min_fico, max_fico, buy_rate,
            max_ltv, min_year, max_mileage, max_carfax, lender_fee)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [userId, lid, t.tier || `Tier ${tiers.indexOf(t)+1}`,
           parseInt(t.minFico)||0, parseInt(t.maxFico)||9999,
           parseFloat(t.rate)||0, parseInt(t.maxLTV)||140,
           parseInt(t.minYear)||2015, parseInt(t.maxMileage)||200000,
           parseInt(t.maxCarfax)||9999,
           parseFloat(t.fee) || DEFAULT_LENDER_FEES[lid] || 0]
        );
      }
      await client.query('COMMIT');
      res.json({ success: true, count: tiers.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally {
      client.release();
    }
  });

  // ── DELETE /api/lenders/rates/:lenderName ─────────────────────────────
  // Reset lender to hardcoded defaults by removing custom rates
  app.delete('/api/lenders/rates/:lenderName', requireAuth, requireBilling, async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM lender_rate_sheets WHERE user_id = $1 AND lender_name = $2',
        [req.user.userId, req.params.lenderName.toLowerCase()]
      );
      res.json({ success: true, message: `${req.params.lenderName} reset to platform defaults` });
    } catch (e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── GET /api/lenders/defaults ─────────────────────────────────────────
  // Returns the lender fee map for use in frontend
  app.get('/api/lenders/defaults', requireAuth, (req, res) => {
    res.json({ success: true, fees: DEFAULT_LENDER_FEES });
  });
};
