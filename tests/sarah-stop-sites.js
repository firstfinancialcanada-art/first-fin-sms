// Every way a conversation can be stopped.
//
// Two branches used to stop the thread and reply "I've taken you off our
// list" without ever calling addOptOut. lib/bulk.js gates every send on
// isOptedOut and nothing else, so those customers were told in writing that
// they had been removed and then included in the next blast. The reengage
// path had already been fixed for exactly this; the acquisition and sales
// paths were missed, and nothing was watching.
//
// This reads the source rather than driving the FSMs, because the three FSMs
// take different dependencies and the point here is coverage of *every* stop
// site, including ones added later. The corpus test checks the reengage
// behaviour itself. Reading source in a test matches what
// tests/sarah-reply-corpus.js already does to pull its regexes out.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'routes', 'sarah.js');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);

// A stop site is a WRITE that parks a conversation in 'stopped' — either the
// FSM object form or the manual endpoint's SQL. A `WHERE status = 'stopped'`
// read filter is not one, so the SQL pattern requires SET.
const SITE_RE = /status:\s*'stopped'|SET\s+status\s*=\s*'stopped'/;

const sites = [];
lines.forEach((line, i) => {
  if (SITE_RE.test(line)) sites.push({ line: i + 1, text: line.trim() });
});

// How far to look for the opt-out write. The manual endpoint calls addOptOut
// before its UPDATE (it refuses the request if that write does not stick),
// the FSM branches call it after, so the window runs both ways.
const WINDOW = 16;
const near = (idx, needle) => {
  const from = Math.max(0, idx - 1 - WINDOW);
  const to   = Math.min(lines.length, idx + WINDOW);
  return lines.slice(from, to).join('\n').includes(needle);
};

const checks = [];
const T = (label, fn) => checks.push({ label, fn });

T('every stop site was found', () =>
  // Six FSM branches plus the manual endpoint. If this number moves, a stop
  // site was added or removed and the rest of this file needs a look.
  sites.length === 7 || 'found ' + sites.length + ' stop sites: ' +
    sites.map(s => s.line).join(', '));

T('every stop site records why it stopped', () => {
  // Without a reason the win/loss breakdown reads "unknown" for everything,
  // which is what it did for all of October.
  const bad = sites.filter(s => !/stop_reason/.test(s.text));
  return bad.length === 0 ||
    'no stop_reason at line(s) ' + bad.map(s => s.line).join(', ');
});

T('every stop site reaches the opt-out table', () => {
  // The conversation status is not a send gate. lib/bulk.js checks
  // isOptedOut, so a stopped conversation with no opt-out row still gets
  // texted by the next campaign.
  const bad = sites.filter(s => !near(s.line, 'addOptOut('));
  return bad.length === 0 ||
    'stopped without an opt-out at line(s) ' + bad.map(s => s.line).join(', ');
});

T('a stop reason is always a non-empty value', () => {
  const bad = sites.filter(s => /stop_reason:\s*(''|""|null|undefined)/.test(s.text));
  return bad.length === 0 || 'empty stop_reason at line(s) ' + bad.map(s => s.line).join(', ');
});

T('stop_reason is writable through updateConversation', () => {
  // It is whitelisted in lib/db.js. Without the entry every write above is
  // dropped with a console warning and the column stays NULL — which is how
  // this stayed invisible.
  const db = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  const m = db.match(/const ALLOWED_FIELDS = new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return 'ALLOWED_FIELDS not found in lib/db.js';
  return /'stop_reason'/.test(m[1]) || 'stop_reason missing from ALLOWED_FIELDS';
});

T('the column exists before the dashboard reads it', () => {
  // routes/analytics.js creates it on boot. setup-database-v2.js also
  // declares it, but that only runs under `npm run migrate` and never ran in
  // production, which is why /api/analytics returned 500 all month.
  const a = fs.readFileSync(path.join(__dirname, '..', 'routes', 'analytics.js'), 'utf8');
  return /ADD COLUMN IF NOT EXISTS stop_reason/.test(a)
    || 'routes/analytics.js does not ensure the stop_reason column';
});

T('the dashboard waits for that migration before querying', () =>
  /app\.get\('\/api\/analytics'[\s\S]{0,120}?await ensureAnalyticsColumns\(\)/.test(
    fs.readFileSync(path.join(__dirname, '..', 'routes', 'analytics.js'), 'utf8'))
  || '/api/analytics does not await ensureAnalyticsColumns()');

let pass = 0, fail = 0;
for (const c of checks) {
  let r;
  try { r = c.fn(); } catch (e) { r = 'threw — ' + e.message; }
  if (r === true) { pass++; console.log('  PASS  ' + c.label); }
  else { fail++; console.log('  FAIL  ' + c.label + (typeof r === 'string' ? ' — ' + r : '')); }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (!fail) console.log('  (' + sites.length + ' stop sites: lines ' + sites.map(s => s.line).join(', ') + ')');
process.exit(fail ? 1 : 0);
