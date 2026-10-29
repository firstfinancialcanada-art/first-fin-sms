// Inbound call routing.
//
// A caller used to hear a menu: press 1 for a person, 2 for voicemail, 3 for
// a text back. Anyone who hesitated for eight seconds got the machine, which
// is the opposite of what a dealership wants from a ringing phone. A live
// call now rings the forward number straight away.
//
// Two things have to stay true for that to be safe. The forward number must
// be the tenant's own and nobody else's — connecting Hunt's customer to
// Franco's cell is the cross-tenant leak the comments in routes/voice.js
// were written about. And an unanswered forward must still reach voicemail,
// which depends entirely on action= pointing at /api/voice/call-complete,
// because Twilio never reads anything after </Dial>.
process.env.JWT_SECRET  = process.env.JWT_SECRET || 'test-only-not-a-real-secret';
process.env.BASE_URL    = 'https://app.example.com';
process.env.TWILIO_PHONE_NUMBER = '+15870000000';
process.env.DEALER_NAME = 'Fallback Motors';

const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const L = (f) => path.join(ROOT, 'lib', f);

// ── tenants keyed by the number dialled ──────────────────────────
const TENANTS = {
  // Franco: notifyPhone set, so calls forward to his Freedom line.
  '+15873303601': { id: 1, settings_json: { dealerName: 'House of Cars', notifyPhone: '+18257474442',
                                            twilioNumber: '+15873303601' } },
  // Hunt: no notifyPhone. Must NOT fall back to anyone else's number.
  '+15195550199': { id: 9, settings_json: { dealerName: 'Hunt Chrysler', twilioNumber: '+15195550199' } },
  // Column set, settings blob stale/empty. lib/notify.js treats the column as
  // canonical, so voice has to resolve it too or the call forwards nowhere.
  '+15875550000': { id: 4, notify_phone: '+15873066133',
                    settings_json: { dealerName: 'Column Only Motors', twilioNumber: '+15875550000' } },
};

const sentSms = [];
const fakePool = {
  connect: async () => ({ query: fakeQuery, release() {} }),
  query: (...a) => fakeQuery(...a),
};
async function fakeQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  // Matched on the table and the lookup column, not the full select list,
  // so adding a column to the query does not quietly turn every tenant
  // into the fallback and fail ten unrelated assertions.
  if (/FROM desk_users WHERE twilio_number/.test(s)) {
    const t = TENANTS[params[0]];
    return { rows: t ? [t] : [] };
  }
  if (s.startsWith('SELECT tenant_id FROM desk_members')) return { rows: [{ tenant_id: params[0] }] };
  return { rows: [], rowCount: 0 };
}

function stub(abs, exports) {
  const resolved = Module._resolveFilename(abs, module, false);
  const m = new Module(resolved, module);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
}

stub(L('db.js'), {
  pool: fakePool,
  getOrCreateConversation: async () => ({ id: 1 }),
  saveMessage: async () => {},
  logAnalytics: async () => {},
});
stub(L('customer-sms.js'), { sendCustomerSms: async () => ({ ok: true }) });
stub(L('spend-cap.js'), { guardedVoiceCall: async () => ({ ok: true }), reconcileSpend: async () => {} });
// Mirrors the real return shape; alertInboundCall reads .reason off it.
stub(L('notify.js'), { notifyTenantManagers: async () => ({ ok: true }), notifyRep: async () => ({ ok: true }) });

const twilioClient = { messages: { create: async (m) => { sentSms.push(m); return { sid: 'SM1' }; } } };

// ── capture the handlers ─────────────────────────────────────────
function loadRoutes() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('routes') && k.includes('voice')) delete require.cache[k];
  }
  const routes = {};
  const app = {
    get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; },
    put: () => {}, delete: () => {}, use: () => {}, all: () => {},
  };
  require(path.join(ROOT, 'routes', 'voice.js'))(app, {
    twilioClient, requireAuth: (q, s, n) => n && n(), requireBilling: (q, s, n) => n && n(),
  });
  return routes;
}

function call(routes, route, body) {
  return new Promise((resolve) => {
    let sent = '';
    const res = {
      _type: null, _s: 200,
      type(t) { this._type = t; return this; },
      status(c) { this._s = c; return this; },
      send(x) { sent = String(x == null ? '' : x); resolve({ xml: sent, type: this._type, status: this._s }); return this; },
      json(x) { resolve({ json: x, status: this._s }); return this; },
    };
    Promise.resolve(routes[route]({ body }, res)).catch((e) => resolve({ error: e.message }));
  });
}

const inbound = (routes, to, from) =>
  call(routes, 'POST /api/voice/inbound', { To: to, From: from, CallSid: 'CA1' });

const checks = [];
const T = (label, fn) => checks.push({ label, fn });

// ── a configured tenant gets rung, not read a menu ───────────────
T('a live call rings the forward number instead of playing a menu', async () => {
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return r.xml.includes('<Dial') && r.xml.includes('+18257474442') && !r.xml.includes('<Gather');
});

T('the caller is never asked to press a key first', async () => {
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return !/press\s+(1|one)/i.test(r.xml);
});

T('an unanswered forward can still reach voicemail', async () => {
  // Twilio reads nothing after </Dial>, so this attribute is the only thing
  // that makes a missed call recoverable.
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return r.xml.includes('action="https://app.example.com/api/voice/call-complete"');
});

T('the forwarded phone hears the whisper', async () => {
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return r.xml.includes('url="https://app.example.com/api/voice/whisper"');
});

T('the call is presented as coming from the dealership number', async () => {
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return r.xml.includes('callerId="+15873303601"');
});

T('the forward does not ring forever', async () => {
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return /timeout="\d+"/.test(r.xml);
});

T('the greeting names the dealership, not the fallback', async () => {
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return r.xml.includes('House of Cars') && !r.xml.includes('Fallback Motors');
});

T('it is valid TwiML', async () => {
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return r.type === 'text/xml'
      && r.xml.trim().startsWith('<?xml')
      && r.xml.includes('<Response>') && r.xml.includes('</Response>');
});

// ── the cross-tenant guard ───────────────────────────────────────
T('a tenant with no forward number is never connected to another tenant', async () => {
  // This is the leak the module comments describe: forwardPhone must not
  // fall back to FORWARD_PHONE, OWNER_PHONE or anyone else's cell.
  const r = await inbound(loadRoutes(), '+15195550199', '+16135551234');
  return !r.xml.includes('<Dial') && !r.xml.includes('8257474442');
});

T('that caller still gets the menu rather than nothing', async () => {
  const r = await inbound(loadRoutes(), '+15195550199', '+16135551234');
  return r.xml.includes('<Gather') && r.xml.includes('Hunt Chrysler');
});

T('an unknown number does not dial anybody', async () => {
  const r = await inbound(loadRoutes(), '+19999999999', '+16135551234');
  return !r.xml.includes('<Dial');
});

T('a number held only on the canonical column still forwards', async () => {
  const r = await inbound(loadRoutes(), '+15875550000', '+14035551234');
  return r.xml.includes('<Dial') && r.xml.includes('+15873066133');
});

// ── the kill switch ──────────────────────────────────
T('VOICE_FORWARD_IMMEDIATE=0 puts the menu back', async () => {
  process.env.VOICE_FORWARD_IMMEDIATE = '0';
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  delete process.env.VOICE_FORWARD_IMMEDIATE;
  return r.xml.includes('<Gather') && !r.xml.includes('<Dial');
});

T('press 1 still connects when the menu is in use', async () => {
  process.env.VOICE_FORWARD_IMMEDIATE = '0';
  const routes = loadRoutes();
  const r = await call(routes, 'POST /api/voice/inbound-gather',
    { To: '+15873303601', From: '+14035551234', Digits: '1', CallSid: 'CA1' });
  delete process.env.VOICE_FORWARD_IMMEDIATE;
  return r.xml.includes('<Dial') && r.xml.includes('+18257474442')
      && r.xml.includes('/api/voice/call-complete');
});

T('forwarding is on unless it is switched off', async () => {
  delete process.env.VOICE_FORWARD_IMMEDIATE;
  const r = await inbound(loadRoutes(), '+15873303601', '+14035551234');
  return r.xml.includes('<Dial');
});

// ── context preview ──────────────────────────────────────────────
T('a preview SMS never goes to a tenant without a forward number', async () => {
  sentSms.length = 0;
  await inbound(loadRoutes(), '+15195550199', '+16135551234');
  await new Promise(r => setTimeout(r, 30));
  return sentSms.length === 0;
});

let pass = 0, fail = 0;
(async () => {
  for (const c of checks) {
    let ok = false, err = null;
    try { ok = await c.fn(); } catch (e) { err = e.message; }
    if (ok === true) { pass++; console.log('  PASS  ' + c.label); }
    else { fail++; console.log('  FAIL  ' + c.label + (err ? ' — ' + err : '')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
