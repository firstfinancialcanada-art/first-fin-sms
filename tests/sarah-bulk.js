// Bulk sender audit tests. Stubs lib/db + lib/spend-cap via the require
// cache so lib/bulk.js runs for real against a fake queue.
//
// Covers the two faults found: campaign mode being coerced to 'sales',
// and a hung run wedging the processor forever (the "locked up" symptom).
process.env.BULK_BATCH_SIZE = '1';   // one row per tick, so the hang test is unambiguous
const path = require('path');
const Module = require('module');

const ROOT = 'C:\\Users\\rolli\\Desktop\\New folder (2)\\FIRST-FIN V1.4';
const P = (p) => path.join(ROOT, 'lib', p);

// ── fake queue ───────────────────────────────────────────────────
let rows = [];
let nextId = 1;
const sentLog = [];          // every number handed to Twilio
const sentBodies = [];       // and the exact text each one got
const handoffStamps = [];    // conversation ids handed to a human at send time
const recentlySent = new Set();  // phones that already got a bulk text inside the window
let hangNextSend = false;
let failHandoffStamp = false;

function addRow(phone, name, mode, tpl, merge) {
  rows.push({ id: nextId++, user_id: 1, campaign_name: 'c', message_template: tpl || 'Hi {name}',
              recipient_name: name, recipient_phone: phone, status: 'pending',
              scheduled_at: new Date(Date.now() - 1000), mode, claimed_at: null,
              merge_json: merge || null });
}

const fakePool = {
  connect: async () => ({ query: fakeQuery, release() {} }),
  query: (...a) => fakeQuery(...a),
};

async function fakeQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();

  if (s.startsWith("UPDATE bulk_messages SET status = 'sending'")) {
    const limit = params[0];
    const claim = rows.filter(r => r.status === 'pending' && r.scheduled_at <= new Date()).slice(0, limit);
    claim.forEach(r => { r.status = 'sending'; r.claimed_at = new Date(); });
    return { rows: claim.map(r => ({ ...r })) };
  }
  if (s.includes("SET status = 'unknown'")) {                       // reaper
    const stale = rows.filter(r => r.status === 'sending');
    stale.forEach(r => { r.status = 'unknown'; });
    return { rows: stale.map(r => ({ id: r.id, recipient_phone: r.recipient_phone, twilio_sid: null })) };
  }
  if (s.includes('FROM bulk_messages') && s.includes('24 hours')) return { rows: [] };  // cooldown
  if (s.includes('SELECT settings_json')) {
    return { rows: [{ settings_json: { twilioNumber: '+15873303601', dealerName: 'House of Cars', dealerCity: 'Calgary' } }] };
  }
  if (s.startsWith('UPDATE bulk_messages SET status = $1')) {   // updateBulkMessageStatus
    const [status, , , id] = params;
    const r = rows.find(x => x.id === id);
    if (r) r.status = status;
    return { rows: [] };
  }
  if (s.startsWith('UPDATE bulk_messages')) {                   // inline literal-status updates
    const id = params[params.length - 1];
    const r = rows.find(x => x.id === id);
    if (r) {
      if (s.includes("status = 'sent'")) r.status = 'sent';
      else if (s.includes("status = 'pending'")) r.status = 'pending';
      else if (s.includes("status = 'failed'") && r.status !== 'sent') r.status = 'failed';
      else if (s.includes("status = 'paused'")) r.status = 'paused';
    }
    return { rows: [] };
  }
  if (s.includes('SELECT DISTINCT recipient_phone')) {        // build-time suppression
    const asked = params[0] || [];
    return { rows: asked.filter(p => recentlySent.has(p)).map(p => ({ recipient_phone: p })) };
  }
  if (s.startsWith('UPDATE conversations')) {
    if (s.includes('handoff_at = NOW()')) {
      if (failHandoffStamp) throw new Error('column "handoff_at" does not exist');
      handoffStamps.push({ conversationId: params[1], by: params[0] });
    }
    return { rows: [] };
  }
  return { rows: [] };
}

// ── stub modules ─────────────────────────────────────────────────
function stub(absPath, exports) {
  const resolved = Module._resolveFilename(absPath, module, false);
  const m = new Module(resolved, module);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
}

const realHelpers = require(P('helpers.js'));
stub(P('db.js'), {
  pool: fakePool,
  getOrCreateConversation: async (phone) => ({ id: 99, customer_name: null, mode: null, source: null }),
  updateConversation: async () => {},
  saveMessage: async () => {},
  isOptedOut: async () => false,
  phoneKeys: (p) => [p],
});
stub(P('spend-cap.js'), {
  guardedSmsSend: async (client, uid, opts) => {
    sentLog.push(opts.to);
    sentBodies.push(opts.body);
    if (hangNextSend) { hangNextSend = false; await new Promise(() => {}); }  // never settles
    return { ok: true, sid: 'SM' + Math.random().toString(36).slice(2, 10) };
  },
});
stub(P('helpers.js'), realHelpers);

const bulk = require(P('bulk.js'));

// ── tests ────────────────────────────────────────────────────────
const checks = [];
const T = (label, fn) => checks.push({ label, fn });

T("campaign mode 'reengage' survives saveBulkCampaign (was coerced to sales)", async () => {
  let captured = null;
  const origQuery = fakeQuery;
  const probe = async (sql, params) => {
    if (String(sql).includes('INSERT INTO bulk_messages')) { captured = params; return { rows: [{ id: 1 }] }; }
    return origQuery(sql, params);
  };
  fakePool.connect = async () => ({ query: probe, release() {} });
  await bulk.saveBulkCampaign('reengage-aug', 'Hi {name}', [{ name: 'Rick', phone: '4035195567' }], 1, 'reengage');
  fakePool.connect = async () => ({ query: fakeQuery, release() {} });
  return captured && captured[6] === 'reengage';
});

T("unknown mode still falls back to 'sales'", async () => {
  let captured = null;
  const origQuery = fakeQuery;
  const probe = async (sql, params) => {
    if (String(sql).includes('INSERT INTO bulk_messages')) { captured = params; return { rows: [{ id: 1 }] }; }
    return origQuery(sql, params);
  };
  fakePool.connect = async () => ({ query: probe, release() {} });
  await bulk.saveBulkCampaign('x', 'Hi', [{ name: 'A', phone: '4035195567' }], 1, 'nonsense');
  fakePool.connect = async () => ({ query: fakeQuery, release() {} });
  return captured && captured[6] === 'sales';
});

T('a hung run does NOT wedge the processor forever, and nobody is texted twice', async () => {
  rows = []; nextId = 1; sentLog.length = 0;
  addRow('+14035195567', 'Rick', 'reengage');
  addRow('+15878304729', 'Allan', 'reengage');

  process.env.BULK_RUN_WATCHDOG_MS = '300';
  const proc = bulk.makeBulkProcessor({});

  hangNextSend = true;
  proc.processBulkMessages();                                  // hangs on row 1
  await new Promise(r => setTimeout(r, 120));

  const blockedWhileHung = sentLog.length;                     // should be 1
  await proc.processBulkMessages();                            // guard still held
  const afterBlocked = sentLog.length;

  await new Promise(r => setTimeout(r, 300));                  // past watchdog
  await proc.processBulkMessages();                            // should proceed to the next row

  const uniq = new Set(sentLog);
  return blockedWhileHung === 1
      && afterBlocked === 1                                    // guard held before watchdog
      && sentLog.length > 1                                    // recovered after it
      && uniq.size === sentLog.length;                         // no number sent twice
});

T('invalid phone is terminally failed, never retried', async () => {
  rows = []; nextId = 1; sentLog.length = 0;
  addRow('not-a-number', 'Bad', 'reengage');
  const proc = bulk.makeBulkProcessor({});
  await proc.processBulkMessages();
  await proc.processBulkMessages();
  return sentLog.length === 0 && rows[0].status === 'failed';
});


T('one campaign, two months: each contact gets its OWN month', async () => {
  rows = []; nextId = 1; sentLog.length = 0; sentBodies.length = 0;
  const TPL = 'Hi {name}, you reached out back in {month}. Still looking?';
  addRow('+14035550001', 'Ian',   'reengage', TPL, { month: 'August' });
  addRow('+14035550002', 'Nader', 'reengage', TPL, { month: 'September' });
  const proc = bulk.makeBulkProcessor({});
  await proc.processBulkMessages();
  await proc.processBulkMessages();
  return sentBodies.length === 2
      && sentBodies.some(b => /Ian, you reached out back in August\./.test(b))
      && sentBodies.some(b => /Nader, you reached out back in September\./.test(b))
      && !sentBodies.some(b => /\{month\}/.test(b));
});

T('a contact missing its month is FAILED, never sent with a raw token', async () => {
  rows = []; nextId = 1; sentLog.length = 0; sentBodies.length = 0;
  addRow('+14035550003', 'Ghost', 'reengage', 'Hi {name}, back in {month}?', {});
  const proc = bulk.makeBulkProcessor({});
  await proc.processBulkMessages();
  await proc.processBulkMessages();
  return sentBodies.length === 0 && rows[0].status === 'failed';
});

T('merge values survive the saveBulkCampaign round trip', async () => {
  let captured = null;
  const orig = fakeQuery;
  fakePool.connect = async () => ({ query: async (sql, params) => {
    if (String(sql).includes('INSERT INTO bulk_messages')) { captured = params; return { rows: [{ id: 1 }] }; }
    return orig(sql, params);
  }, release() {} });
  await bulk.saveBulkCampaign('c', 'Hi {name} {month}', [{ name: 'Ian', phone: '4035195567', merge: { month: 'August' } }], 1, 'reengage');
  fakePool.connect = async () => ({ query: fakeQuery, release() {} });
  return captured && JSON.parse(captured[7]).month === 'August';
});

// ── notify-only campaigns ────────────────────────────────────────
// The Wipe Out Debt case: Sarah sends one opener and is then off the
// thread for good, because every honest reply on that list is about debt
// and she must never discuss credit with a customer.

T("campaign mode 'notify' survives saveBulkCampaign", async () => {
  let captured = null;
  const orig = fakeQuery;
  fakePool.connect = async () => ({ query: async (sql, params) => {
    if (String(sql).includes('INSERT INTO bulk_messages')) { captured = params; return { rows: [{ id: 1 }] }; }
    return orig(sql, params);
  }, release() {} });
  await bulk.saveBulkCampaign('wod', 'Hi {name}', [{ name: 'Gene', phone: '4035195567' }], 1, 'notify');
  fakePool.connect = async () => ({ query: fakeQuery, release() {} });
  return captured && captured[6] === 'notify';
});

T('a notify campaign stamps handoff_at at send time, so the FIRST reply goes to a human', async () => {
  rows = []; nextId = 1; sentLog.length = 0; handoffStamps.length = 0;
  addRow('+14035550010', 'Gene', 'notify');
  const proc = bulk.makeBulkProcessor({});
  await proc.processBulkMessages();
  return sentLog.length === 1                      // the opener did go out
      && handoffStamps.length === 1                // and the thread was handed over
      && handoffStamps[0].conversationId === 99
      && handoffStamps[0].by === 1;
});

T('a reengage campaign does NOT stamp handoff_at — its FSM still runs', async () => {
  rows = []; nextId = 1; sentLog.length = 0; handoffStamps.length = 0;
  addRow('+14035550011', 'Rick', 'reengage');
  const proc = bulk.makeBulkProcessor({});
  await proc.processBulkMessages();
  return sentLog.length === 1 && handoffStamps.length === 0;
});

T('a failed handoff stamp is loud, and never silently marks the send failed', async () => {
  rows = []; nextId = 1; sentLog.length = 0; handoffStamps.length = 0;
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  failHandoffStamp = true;
  addRow('+14035550012', 'Gene', 'notify');
  const proc = bulk.makeBulkProcessor({});
  await proc.processBulkMessages();
  failHandoffStamp = false;
  console.error = realErr;
  return rows[0].status === 'sent'                             // text went out, row is honest
      && errs.some(e => /HANDOFF STAMP FAILED/.test(e))        // and the failure is impossible to miss
      && errs.some(e => /NOT protected/.test(e));
});

// ── build-time suppression ───────────────────────────────────────
// "Don't re-hit the people we just blasted." The 24h cooldown in the send
// loop only RESCHEDULES, so without this a second overlapping campaign
// still reaches everyone, a day late and invisibly.

function probeInsert(onCapture) {
  const orig = fakeQuery;
  fakePool.connect = async () => ({ query: async (sql, params) => {
    if (String(sql).includes('INSERT INTO bulk_messages')) { onCapture(params); return { rows: [{ id: 1 }] }; }
    return orig(sql, params);
  }, release() {} });
  return () => { fakePool.connect = async () => ({ query: fakeQuery, release() {} }); };
}

T('a contact texted inside the window is DROPPED from the campaign, not queued', async () => {
  recentlySent.clear(); recentlySent.add('+14035195567');
  let captured = null;
  const restore = probeInsert(p => { captured = p; });
  const r = await bulk.saveBulkCampaign('blast2', 'Hi {name}',
    [{ name: 'Gene', phone: '4035195567' }, { name: 'Fresh', phone: '4035550099' }], 1, 'notify');
  restore(); recentlySent.clear();
  return r.ids.length === 1
      && r.skipped.length === 1 && r.skipped[0].name === 'Gene'
      && captured && captured[2] === 'Fresh';          // only the un-texted one was inserted
});

T('suppression never silently empties a campaign — an all-suppressed list reports every name', async () => {
  recentlySent.clear(); recentlySent.add('+14035195567');
  let inserted = false;
  const restore = probeInsert(() => { inserted = true; });
  const r = await bulk.saveBulkCampaign('blast2', 'Hi {name}', [{ name: 'Gene', phone: '4035195567' }], 1, 'notify');
  restore(); recentlySent.clear();
  return r.ids.length === 0 && r.skipped.length === 1 && r.skipped[0].name === 'Gene' && !inserted;
});

T('nobody is suppressed when the window is clean', async () => {
  recentlySent.clear();
  let captured = null;
  const restore = probeInsert(p => { captured = p; });
  const r = await bulk.saveBulkCampaign('blast1', 'Hi {name}', [{ name: 'Gene', phone: '4035195567' }], 1, 'notify');
  restore();
  return r.ids.length === 1 && r.skipped.length === 0 && captured && captured[2] === 'Gene';
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
