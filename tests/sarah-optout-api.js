// Manual opt-out endpoints.
//
// Before these existed the only way into the opt-out table was the FSM
// spotting a keyword in an inbound text. Someone who asked to stop on the
// phone or at the desk could not be recorded, and two customers whose
// written STOP the matcher missed had to be screened out of every campaign
// by hand off a note. These cover the behaviour that makes that a real
// control rather than a habit.
const path = require('path');
const Module = require('module');

const ROOT = 'C:\\Users\\rolli\\Desktop\\New folder (2)\\FIRST-FIN V1.4';
const P = (p) => path.join(ROOT, 'lib', p);

// ── fake opt-out table + conversations ───────────────────────────
let optOuts = new Map();          // canonical phone -> source
let conversations = [];           // {customer_phone, user_id, status}
let addOptOutShouldFail = false;
let convUpdateShouldThrow = false;
const logged = [];

const digits = p => String(p || '').replace(/\D/g, '');
const canon = p => { const d = digits(p); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : null; };
const phoneKeys = p => { const c = canon(p); if (!c) return []; const d = digits(c).slice(-10);
  return [c, d, '1' + d, '+1' + d, `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`]; };

const fakePool = {
  connect: async () => ({ query: fakeQuery, release() {} }),
  query: (...a) => fakeQuery(...a),
};
async function fakeQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (s.startsWith("UPDATE conversations SET status = 'stopped'")) {
    if (convUpdateShouldThrow) throw new Error('simulated DB failure');
    const keys = params[0], uid = params[1];
    const hit = conversations.filter(c => keys.includes(c.customer_phone) && c.user_id === uid && c.status !== 'stopped');
    hit.forEach(c => { c.status = 'stopped'; });
    return { rowCount: hit.length };
  }
  if (s.startsWith('SELECT * FROM conversations WHERE customer_phone = ANY')) {
    const keys = params[0], uid = params[1];
    const hit = conversations.filter(c => keys.includes(c.customer_phone) && c.user_id === uid);
    return { rows: hit };
  }
  if (s.startsWith('SELECT id FROM conversations WHERE customer_phone = ANY')) {
    const keys = params[0], uid = params[1];
    return { rows: conversations.filter(c => keys.includes(c.customer_phone) && c.user_id === uid)
               .map((c, i) => ({ id: i + 1 })) };
  }
  if (s.startsWith('SELECT * FROM messages WHERE conversation_id')) return { rows: [] };
  if (s.startsWith("UPDATE conversations SET status = 'active'")) {
    const keys = params[0], uid = params[1];
    const hit = conversations.filter(c => keys.includes(c.customer_phone) && c.user_id === uid && c.status === 'stopped');
    hit.forEach(c => { c.status = 'active'; });
    return { rowCount: hit.length };
  }
  return { rows: [], rowCount: 0 };
}

function stub(absPath, exports) {
  const resolved = Module._resolveFilename(absPath, module, false);
  const m = new Module(resolved, module);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
}

const realHelpers = require(P('helpers.js'));
stub(P('helpers.js'), realHelpers);
stub(P('db.js'), {
  pool: fakePool, phoneKeys,
  bumpCrmLastContact: async () => {},
  addOptOut: async (phone, source) => { if (addOptOutShouldFail) return; const c = canon(phone); if (c) optOuts.set(c, source); },
  removeOptOut: async (phone) => { for (const k of phoneKeys(phone)) optOuts.delete(k); const c = canon(phone); if (c) optOuts.delete(c); },
  isOptedOut: async (phone) => phoneKeys(phone).some(k => optOuts.has(k)),
  logAnalytics: async (event, phone, meta) => { logged.push({ event, phone, meta }); },
  getOrCreateCustomer: async () => ({}), getOrCreateConversation: async () => ({ id: 1 }),
  updateConversation: async () => {}, saveMessage: async () => {},
  hasActiveConversation: async () => false, deleteConversation: async () => {},
  saveAppointment: async () => {}, saveCallback: async () => {},
});
stub(P('customer-sms.js'), { sendCustomerSms: async () => ({ ok: true }) });
stub(P('bulk.js'), { state: {} });
stub(P('spend-cap.js'), { guardedSmsSend: async () => ({ ok: true }), recordSpend: async () => {}, reconcileSpend: async () => {} });
stub(P('notify.js'), { notifyTenantManagers: async () => {}, notifyRep: async () => {} });
stub(P('lead-routing.js'), {});

// ── capture the route handlers ───────────────────────────────────
const routes = {};
const app = {
  locals: {},
  get:  (p, ...h) => { routes['GET ' + p]    = h[h.length - 1]; },
  post: (p, ...h) => { routes['POST ' + p]   = h[h.length - 1]; },
  delete: (p, ...h) => { routes['DELETE ' + p] = h[h.length - 1]; },
  put: () => {}, use: () => {}, all: () => {},
};
require(path.join(ROOT, 'routes', 'sarah.js'))(app, {
  twilioClient: null, requireAuth: (q, s, n) => n && n(),
  requireBilling: (q, s, n) => n && n(), notifyOwner: async () => {},
});

function call(route, { body = {}, query = {}, params = {}, userId = 1 } = {}) {
  return new Promise(resolve => {
    const res = { _s: 200, _h: {},
      status(c) { this._s = c; return this; },
      set(k, v) { this._h[k] = v; return this; },
      json(payload) { resolve({ status: this._s, body: payload, headers: this._h }); return this; } };
    routes[route]({ body, query, params, user: { userId } }, res);
  });
}

// ── tests ────────────────────────────────────────────────────────
const checks = [];
const T = (label, fn) => checks.push({ label, fn });
const reset = () => { optOuts = new Map(); conversations = []; addOptOutShouldFail = false;
                      convUpdateShouldThrow = false; logged.length = 0; };

T('the endpoints exist', async () =>
  !!routes['POST /api/opt-out'] && !!routes['DELETE /api/opt-out'] && !!routes['GET /api/opt-out']);

T('a manual opt-out lands in the table the senders actually check', async () => {
  reset();
  const r = await call('POST /api/opt-out', { body: { phone: '403-919-0678', reason: 'said stop at the desk' } });
  return r.status === 200 && r.body.success === true
      && optOuts.get('+14039190678') === 'said stop at the desk';
});

T('every phone format reaches the same person', async () => {
  reset();
  await call('POST /api/opt-out', { body: { phone: '(403) 919-0678' } });
  const a = await call('GET /api/opt-out', { query: { phone: '+14039190678' } });
  const b = await call('GET /api/opt-out', { query: { phone: '4039190678' } });
  const c = await call('GET /api/opt-out', { query: { phone: '1-403-919-0678' } });
  return a.body.optedOut && b.body.optedOut && c.body.optedOut;
});

T('it also stops their open conversations', async () => {
  reset();
  conversations.push({ customer_phone: '+14039190678', user_id: 1, status: 'active' });
  const r = await call('POST /api/opt-out', { body: { phone: '+14039190678' } });
  return r.body.conversationsStopped === 1 && conversations[0].status === 'stopped';
});

T('another tenant\u2019s conversation is never touched', async () => {
  reset();
  conversations.push({ customer_phone: '+14039190678', user_id: 2, status: 'active' });
  const r = await call('POST /api/opt-out', { body: { phone: '+14039190678' }, userId: 1 });
  return r.body.conversationsStopped === 0 && conversations[0].status === 'active';
});

T('a failed conversation update still leaves the customer opted out', async () => {
  reset();
  convUpdateShouldThrow = true;
  conversations.push({ customer_phone: '+14039190678', user_id: 1, status: 'active' });
  const r = await call('POST /api/opt-out', { body: { phone: '+14039190678' } });
  // the thing that protects the customer is the opt-out table, not the status
  return r.status === 200 && r.body.success === true && optOuts.has('+14039190678');
});

T('an opt-out that did NOT stick fails loudly instead of reporting success', async () => {
  reset();
  addOptOutShouldFail = true;
  const r = await call('POST /api/opt-out', { body: { phone: '+14039190678' } });
  return r.status === 500 && r.body.success === false;
});

T('a junk number is refused rather than silently stored', async () => {
  reset();
  const a = await call('POST /api/opt-out', { body: { phone: '123' } });
  const b = await call('POST /api/opt-out', { body: {} });
  return a.status === 400 && b.status === 400 && optOuts.size === 0;
});

T('source defaults to manual when no reason is given', async () => {
  reset();
  await call('POST /api/opt-out', { body: { phone: '+14039190678' } });
  return optOuts.get('+14039190678') === 'manual';
});

T('removing an opt-out puts them back and reports it', async () => {
  reset();
  conversations.push({ customer_phone: '+14039190678', user_id: 1, status: 'active' });
  await call('POST /api/opt-out', { body: { phone: '+14039190678' } });
  const r = await call('DELETE /api/opt-out', { body: { phone: '+14039190678', reason: 'matcher false positive' } });
  const after = await call('GET /api/opt-out', { query: { phone: '+14039190678' } });
  return r.body.success === true && r.body.stillOptedOut === false
      && after.body.optedOut === false && conversations[0].status === 'active';
});

T('a number nobody opted out reads as not opted out', async () => {
  reset();
  const r = await call('GET /api/opt-out', { query: { phone: '+14035551234' } });
  return r.status === 200 && r.body.optedOut === false;
});

T('a thread is found whatever way the number is written', async () => {
  // desk_crm stores "(403) 835-4162" while conversations stores
  // "+14038354162". An exact compare reported "No conversation found" for a
  // customer who had a thread, which reads as never contacted rather than as
  // a lookup miss - and that is how a real follow-up nearly went out blind.
  reset();
  conversations.push({ customer_phone: '+14038354162', user_id: 1, status: 'active' });
  const spellings = ['(403) 835-4162', '403-835-4162', '4038354162', '+14038354162', '1-403-835-4162'];
  for (const p of spellings) {
    const r = await call('GET /api/conversation/:phone', { params: { phone: p } });
    if (!r.body || r.body.error || !r.body.conversation) {
      console.log('      missed the thread for ' + p);
      return false;
    }
  }
  return true;
});

T('a number with no thread still reports cleanly', async () => {
  reset();
  const r = await call('GET /api/conversation/:phone', { params: { phone: '+14035550000' } });
  return !!(r.body && r.body.error);
});

T('the opt-out is logged for the audit trail', async () => {
  reset();
  await call('POST /api/opt-out', { body: { phone: '+14039190678', reason: 'phoned in' } });
  const e = logged.find(x => x.event === 'conversation_stopped');
  return !!e && e.meta && e.meta.manual === true && e.meta.source === 'phoned in';
});

(async () => {
  let pass = 0, fail = 0;
  for (const c of checks) {
    let ok = false, err = null;
    try { ok = await c.fn(); } catch (e) { err = e.message; }
    // Strict: a check that returns a descriptive failure string instead of
    // false would otherwise be counted as a pass, which is exactly how a
    // broken test sat here reporting green.
    if (ok === true) { pass++; console.log('  PASS  ' + c.label); }
    else    { fail++; console.log('  FAIL  ' + c.label + (err ? ' — ' + err : '')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
