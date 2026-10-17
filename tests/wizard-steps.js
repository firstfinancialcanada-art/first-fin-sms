// Welcome-wizard step navigation, per tier.
//
// The wizard shipped asking every dealer for "3 managers + 7 sales reps" and
// drawing six stepper dots no matter what they bought, so a single-seat Solo
// account was invited to fill nine seats the server refuses and watched the
// dots jump 3 -> 5. The step list is data now; this pins it down.
//
// Lifts the wizard's own <script> out of welcome.html and runs it against a
// fake DOM, so the test exercises the shipped file rather than a copy.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'welcome.html'), 'utf8');
const src = (html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/) || [])[1];
if (!src) throw new Error('wizard script block not found in welcome.html');

function load() {
  const els = {};
  const mk = (id) => ({ id, style: {}, className: '', textContent: '',
                        classList: { add() {}, remove() {} }, parentElement: { style: {} } });
  const el = (id) => (els[id] || (els[id] = mk(id)));
  for (let i = 1; i <= 6; i++) el('dot-' + i);
  for (let i = 1; i <= 5; i++) el('line-' + i);
  ['w-seat-count', 'w-seat-desc', 'w-team-sub', 'w-next-routing'].forEach(el);
  const document = {
    getElementById: (id) => (id.startsWith('panel-') ? el(id) : (els[id] || null)),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { FF: { apiFetch: async () => ({ status: 500 }) }, scrollTo() {}, location: {} };
  const fn = new Function('document', 'window', 'console', 'setTimeout', 'FF',
    'return (function(){' + src + '\nreturn { applyTier, goStep, get STEPS(){return STEPS;}, get currentStep(){return currentStep;} };})()');
  const api = fn(document, window, { log() {}, warn() {}, error() {} }, setTimeout, window.FF);
  return { api, els };
}

const checks = [];
const T = (label, fn) => checks.push({ label, fn });

const walk = (api, order) => order.map(n => { api.goStep(n); return api.currentStep; });

T('gold walks all six steps', () => {
  const { api } = load();
  api.applyTier('gold', 10);
  return JSON.stringify(api.STEPS) === '[1,2,3,4,5,6]'
      && walk(api, [2,3,4,5,6]).join() === '2,3,4,5,6';
});

T('platinum walks all six steps', () => {
  const { api } = load();
  api.applyTier('platinum', 50);
  return JSON.stringify(api.STEPS) === '[1,2,3,4,5,6]';
});

T('single skips the team step going forward', () => {
  const { api } = load();
  api.applyTier('single', 1);
  return JSON.stringify(api.STEPS) === '[1,2,3,5,6]'
      && walk(api, [2,3,4]).join() === '2,3,5';
});

T('single skips the team step going BACK too', () => {
  const { api } = load();
  api.applyTier('single', 1);
  api.goStep(5);
  api.goStep(4);          // the Back button on the number step
  return api.currentStep === 3;
});

T('single never lands on the team panel from any button', () => {
  const { api } = load();
  api.applyTier('single', 1);
  for (const n of [1,2,3,4,5,6,4,2,4,6,4]) {
    api.goStep(n);
    if (api.currentStep === 4) return false;
  }
  return true;
});

T('stepper dots are renumbered, not left with a gap', () => {
  const { api, els } = load();
  api.applyTier('single', 1);
  const shown = [1,2,3,4,5,6]
    .filter(i => els['dot-' + i].style.display !== 'none')
    .map(i => els['dot-' + i].textContent);
  return shown.join('') === '12345' && els['dot-4'].style.display === 'none';
});

T('gold keeps all six dots numbered 1-6', () => {
  const { api, els } = load();
  api.applyTier('gold', 10);
  const shown = [1,2,3,4,5,6]
    .filter(i => els['dot-' + i].style.display !== 'none')
    .map(i => els['dot-' + i].textContent);
  return shown.join('') === '123456';
});

T('no two stepper lines sit side by side when a step is skipped', () => {
  const { api, els } = load();
  api.applyTier('single', 1);
  // order is dot1 line1 dot2 line2 dot3 line3 dot4 line4 dot5 line5 dot6
  const seq = [];
  for (let i = 1; i <= 6; i++) {
    if (els['dot-' + i].style.display !== 'none') seq.push('d');
    const line = els['line-' + i];
    if (line && line.style.display !== 'none') seq.push('l');
  }
  return !/ll/.test(seq.join('')) && seq.join('') === 'dldldldld';
});

T('an unknown tier falls back to the full wizard, not a broken one', () => {
  const { api } = load();
  api.applyTier(null, null);
  return JSON.stringify(api.STEPS) === '[1,2,3,4,5,6]';
});

T('an unknown tier with a single seat still skips the team step', () => {
  const { api } = load();
  api.applyTier(null, 1);
  return JSON.stringify(api.STEPS) === '[1,2,3,5,6]';
});

T('seat copy states the real number, never a hardcoded 10', () => {
  const a = load(); a.api.applyTier('single', 1);
  const b = load(); b.api.applyTier('gold', 10);
  return a.els['w-seat-count'].textContent === '1 Seat'
      && /Just you/.test(a.els['w-seat-desc'].textContent)
      && b.els['w-seat-count'].textContent === '10 Seats'
      && /plus 9 more/.test(b.els['w-seat-desc'].textContent);
});

T('the team step copy never promises managers and reps a plan has no room for', () => {
  const { api, els } = load();
  api.applyTier('gold', 10);
  const sub = els['w-team-sub'].textContent;
  return /up to 9 more people/.test(sub) && !/3 managers/.test(sub);
});

T('routing advice is hidden for a one-man shop', () => {
  const a = load(); a.api.applyTier('single', 1);
  const b = load(); b.api.applyTier('gold', 10);
  return a.els['w-next-routing'].style.display === 'none'
      && b.els['w-next-routing'].style.display !== 'none';
});

T('the seat tile hides rather than showing a made-up count', () => {
  const { api, els } = load();
  api.applyTier(null, null);
  return els['w-seat-count'].parentElement.style.display === 'none';
});

T('the required fields exist in the markup', () => {
  // the notify phone is what makes the difference between a dealer getting
  // their leads and silently getting nothing
  return /id="w-notify-phone"/.test(html)
      && /id="w-sales-name"/.test(html)
      && /notifyPhone, salesName/.test(html);
});

(async () => {
  let pass = 0, fail = 0;
  for (const c of checks) {
    let ok = false, err = null;
    try { ok = await c.fn(); } catch (e) { err = e.message; }
    if (ok) { pass++; console.log('  PASS  ' + c.label); }
    else    { fail++; console.log('  FAIL  ' + c.label + (err ? ' — ' + err : '')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
