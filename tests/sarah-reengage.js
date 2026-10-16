// Harness for the reengage FSM. The function lives inside a module
// closure in routes/sarah.js, so we lift its source out and run it
// against stubs. Verifies branching + the exact copy that goes to a
// live customer.
const fs = require('fs');
const path = require('path');

const SARAH = path.join('C:\\Users\\rolli\\Desktop\\New folder (2)\\FIRST-FIN V1.4', 'routes', 'sarah.js');
const src = fs.readFileSync(SARAH, 'utf8');

const start = src.indexOf('  async function getReengageResponse(');
if (start < 0) throw new Error('getReengageResponse not found');
const endMarker = '\n  async function getJerryResponse(';
const end = src.indexOf(endMarker, start);
if (end < 0) throw new Error('end marker not found');
const fnSrc = src.slice(start, end);

// ── stubs ────────────────────────────────────────────────────────
let db, calls;
function reset(conv) {
  db = Object.assign({ id: 1, customer_name: 'Rick Overwater', status: 'active',
                       stage: 'reengage_confirm', mode: 'reengage', vehicle_type: null }, conv || {});
  calls = { update: [], callback: [], notify: [], analytics: [], optOut: [], optIn: [] };
}
const updateConversation = async (id, u) => { calls.update.push(u); Object.assign(db, u); };
const addOptOut    = async (p, r) => calls.optOut.push({ p, r });
const removeOptOut = async (p)    => calls.optIn.push(p);
const logAnalytics = async (e, p, d) => calls.analytics.push({ e, d });
const saveCallback = async (d)    => calls.callback.push(d);
const notifyTenantManagers = async (o) => calls.notify.push(o.body);
const formatPretty = (p) => p;
const twilioClient = {};

const factory = new Function(
  'updateConversation','addOptOut','removeOptOut','logAnalytics','saveCallback',
  'notifyTenantManagers','formatPretty','twilioClient',
  fnSrc + '\n return getReengageResponse;'
);
const getReengageResponse = factory(updateConversation, addOptOut, removeOptOut,
  logAnalytics, saveCallback, notifyTenantManagers, formatPretty, twilioClient);

const run = (msg, conv) => {
  reset(conv);
  return getReengageResponse('+14035195567', msg, db, 1, '+15873303601', 3,
                             'House of Cars', 'FRANCO');
};

// ── expectations ─────────────────────────────────────────────────
const checks = [];
const T = (label, fn) => checks.push({ label, fn });

T('STOP opts out, no callback', async () => {
  const r = await run('STOP');
  return db.status === 'stopped' && calls.optOut.length === 1 && calls.callback.length === 0 && calls.notify.length === 0;
});

T('bare "no" closes stage, does NOT opt out, no callback', async () => {
  const r = await run('no');
  return db.stage === 'reengage_closed' && db.status === 'active'
      && calls.optOut.length === 0 && calls.callback.length === 0 && calls.notify.length === 0;
});

T('"nope" same as no', async () => {
  await run('Nope');
  return db.stage === 'reengage_closed' && db.status === 'active' && calls.notify.length === 0;
});

T('"already bought one" closes, logs bought, no callback', async () => {
  const r = await run('I already bought one thanks');
  return db.stage === 'reengage_closed' && calls.callback.length === 0
      && calls.analytics.some(a => a.d && a.d.reason === 'already_bought')
      && /Congrats Rick/.test(r);
});

T('"yes" asks for a time, names Franco, books nothing yet', async () => {
  const r = await run('yes');
  return db.stage === 'reengage_time' && calls.callback.length === 0
      && /Our sales manager Franco will call you back/.test(r)
      && /what time/i.test(r);
});

T('"still looking" routes to time', async () => {
  const r = await run('yeah still looking for something');
  return db.stage === 'reengage_time' && /Franco/.test(r);
});

T('price question does NOT get answered — routes to callback', async () => {
  const r = await run("what's the best price on the Escape?");
  return db.stage === 'reengage_time_q'
      && !/\$/.test(r)
      && /Franco/.test(r) && /what time/i.test(r);
});

T('time reply books callback + fires alert to manager', async () => {
  const r = await run('tomorrow after 4', { stage: 'reengage_time' });
  return calls.callback.length === 1
      && calls.callback[0].datetime === 'tomorrow after 4'
      && calls.notify.length === 1
      && /CALLBACK — REENGAGE/.test(calls.notify[0])
      && /Rick Overwater/.test(calls.notify[0])
      && db.stage === 'reengage_done' && db.status === 'converted'
      && /Franco will call you tomorrow after 4/.test(r);
});

T('no copy ever contains a dollar figure, appointment or "in the market"', async () => {
  const msgs = ['yes','no','already bought one','whats the payment on it','tomorrow at 2','STOP','START'];
  for (const m of msgs) {
    const r = await run(m, { stage: m === 'tomorrow at 2' ? 'reengage_time' : 'reengage_confirm' });
    if (/\$|\bin the market\b|\btest drive\b|\bappointment\b|\bcome (in|by|down)\b/i.test(r)) {
      console.log('   ↳ offending reply for', JSON.stringify(m), '→', r);
      return false;
    }
  }
  return true;
});

T('"not interested" is a real opt-out', async () => {
  await run('not interested');
  return db.status === 'stopped';
});

T('already-closed lead does not re-book on a stray reply', async () => {
  const r = await run('ok', { stage: 'reengage_closed' });
  return calls.callback.length === 0 && calls.notify.length === 0;
});


T('after callback booked, a reschedule reaches the manager and does NOT reopen the loop', async () => {
  const r = await run('actually can we make it Thursday instead', { stage: 'reengage_done', status: 'converted', datetime: 'Wednesday' });
  return calls.notify.length === 1
      && /REPLY AFTER CALLBACK BOOKED/.test(calls.notify[0])
      && /Was: Wednesday/.test(calls.notify[0])
      && /Thursday instead/.test(calls.notify[0])
      && db.stage === 'reengage_done'
      && !/\?/.test(r);
});

T('after callback booked, a bare "thanks" does not ping the manager', async () => {
  const r = await run('thanks!', { stage: 'reengage_done', status: 'converted', datetime: 'Wednesday' });
  return calls.notify.length === 0 && db.stage === 'reengage_done' && !/\?/.test(r);
});

T('after close, "actually I am looking again" reaches the manager, no loop restart', async () => {
  const r = await run('actually I am looking again', { stage: 'reengage_closed' });
  return calls.notify.length === 1
      && /REPLY AFTER CLOSE/.test(calls.notify[0])
      && db.stage === 'reengage_closed'
      && !/\?/.test(r);
});

T('withdrawal at the time step closes instead of booking a bogus callback', async () => {
  const r = await run('no actually never mind', { stage: 'reengage_time' });
  return calls.callback.length === 0 && calls.notify.length === 0 && db.stage === 'reengage_closed';
});

T('Sarah never asks more than one question in the whole funnel', async () => {
  // every stage, every shape of reply — only the time ask may contain '?'
  const cases = [
    ['reengage_confirm','yes'], ['reengage_confirm','no'], ['reengage_confirm','already bought one'],
    ['reengage_confirm','what do you have in stock'], ['reengage_time','tomorrow 3pm'],
    ['reengage_time','no never mind'], ['reengage_done','make it Friday'], ['reengage_done','ok'],
    ['reengage_closed','hello again'], ['reengage_closed','thanks'],
  ];
  for (const [stage, msg] of cases) {
    const r = await run(msg, { stage });
    const qs = (r.match(/\?/g) || []).length;
    const isTimeAsk = /what time/i.test(r);
    if (qs > 1 || (qs === 1 && !isTimeAsk)) {
      console.log('   ↳ digging at', stage, JSON.stringify(msg), '→', r);
      return false;
    }
  }
  return true;
});

T('STOP still works after a callback is booked', async () => {
  await run('STOP', { stage: 'reengage_done', status: 'converted' });
  return db.status === 'stopped' && calls.optOut.length === 1;
});


T('Gabriel case: a non-time answer is NOT echoed back into the sentence', async () => {
  const r = await run('Should of been negociable when I wanted to buy.\nThanks', { stage: 'reengage_time_q' });
  return calls.callback.length === 1
      && !/will call you Should/.test(r)
      && /passed that to/.test(r)
      && /negociable/.test(calls.callback[0].datetime);
});

T('a real time IS still echoed back', async () => {
  const r = await run('tomorrow after 4', { stage: 'reengage_time' });
  return /will call you tomorrow after 4/.test(r);
});

T('alert claims "Still looking" only when they actually said yes', async () => {
  await run('tomorrow at 2', { stage: 'reengage_time' });
  const yes = calls.notify[0];
  await run('tomorrow at 2', { stage: 'reengage_time_q' });
  const unclear = calls.notify[0];
  return /Still looking\./.test(yes) && /Not a clear yes/.test(unclear) && !/Still looking\./.test(unclear);
});

T('catch-all routes to reengage_time_q, not reengage_time', async () => {
  await run('what do you have in stock', { stage: 'reengage_confirm' });
  return db.stage === 'reengage_time_q';
});


T('Danny case: "Sorry, not looking." does NOT get congratulated', async () => {
  const r = await run('Sorry, not looking.');
  return db.stage === 'reengage_closed' && !/Congrats/i.test(r) && /No problem at all/.test(r);
});

T('an actual purchase still gets congratulated', async () => {
  const r = await run('I already bought one');
  return db.stage === 'reengage_closed' && /Congrats/.test(r);
});

T('"all set" closes neutrally rather than congratulating', async () => {
  const r = await run('all set thanks');
  return db.stage === 'reengage_closed' && !/Congrats/i.test(r);
});


T('Monica case: "Nope, bought a vehicle elsewhere" reads as BOUGHT, not just declined', async () => {
  const r = await run('Nope, bought a vehicle elsewhere. Thanks');
  return db.stage === 'reengage_closed'
      && /Congrats/.test(r)
      && calls.analytics.some(a => a.d && a.d.reason === 'already_bought');
});

T('"I have not bought anything yet" is NOT read as bought', async () => {
  const r = await run("I haven't bought anything yet");
  return !/Congrats/.test(r);
});

T('"found something else" reads as bought', async () => {
  const r = await run('found something else already');
  return /Congrats/.test(r) && db.stage === 'reengage_closed';
});

T('"went with another dealer" reads as bought', async () => {
  const r = await run('went with another dealer sorry');
  return /Congrats/.test(r);
});


T('Radi case: "Definitely not" at the time step closes, never books', async () => {
  const r = await run('Definitely not', { stage: 'reengage_time_q' });
  return calls.callback.length === 0 && calls.notify.length === 0 && db.stage === 'reengage_closed';
});

T('other unanchored refusals at the time step also close', async () => {
  for (const m of ['absolutely not', 'please don\'t call me', 'no need thanks', 'actually not interested']) {
    const r = await run(m, { stage: 'reengage_time' });
    // "not interested" is a UNIVERSAL opt-out and sets status=stopped rather
    // than the reengage close, so assert what actually matters: no callback
    // booked and nothing sent to the manager.
    const parked = db.stage === 'reengage_closed' || db.status === 'stopped';
    if (calls.callback.length !== 0 || calls.notify.length !== 0 || !parked) {
      console.log('   \u21b3 mishandled', JSON.stringify(m), '-> stage', db.stage, 'status', db.status, 'cb', calls.callback.length);
      return false;
    }
  }
  return true;
});

T('"I don\'t know you" identifies and closes, no callback ask', async () => {
  const r = await run("I don't know you");
  return db.stage === 'reengage_closed'
      && calls.callback.length === 0
      && /Sarah at/.test(r)
      && !/what time/i.test(r);
});

T('"who is this" same handling', async () => {
  const r = await run('who is this?');
  return db.stage === 'reengage_closed' && !/what time/i.test(r);
});

T('a genuine time is still not mistaken for a refusal', async () => {
  const r = await run('tomorrow afternoon works', { stage: 'reengage_time' });
  return calls.callback.length === 1 && /will call you tomorrow afternoon works/.test(r);
});


T('LOOP GUARD: stage only ever moves forward, never back to the opening question', async () => {
  const ORDER = { reengage_confirm:0, reengage_time:1, reengage_time_q:1, reengage_done:2, reengage_closed:2 };
  // the march-2026 sales-funnel loop was: booked -> stray reply -> back to question one
  const chaos = ['Haha','ok','Chevy truck 3/4 ton to 1 ton','what do you have','yes','Who is this ?',
                 'tomorrow','My name is Jason','thanks','actually never mind','hello','$500 a month',
                 'still there?','👍','call me','Trucks','no','I am at work til 6:30'];
  for (const start of ['reengage_confirm','reengage_time','reengage_time_q','reengage_done','reengage_closed']) {
    reset({ stage: start });
    let prev = ORDER[start];
    for (const m of chaos) {
      const r = await getReengageResponse('+14035481389', m, db, 1, '+15873303601', 3, 'House of Cars', 'FRANCO');
      if (db.status === 'stopped') break;                 // opt-out is a legitimate exit
      const now = ORDER[db.stage];
      if (now === undefined) { console.log('   \u21b3 unknown stage', db.stage); return false; }
      if (now < prev) { console.log('   \u21b3 WENT BACKWARDS at', JSON.stringify(m), prev, '->', db.stage); return false; }
      if (/Are you still looking\?/i.test(r)) { console.log('   \u21b3 re-asked the opener after', JSON.stringify(m)); return false; }
      prev = now;
    }
  }
  return true;
});

T('LOOP GUARD: a booked callback is never booked twice', async () => {
  reset({ stage: 'reengage_time' });
  for (const m of ['tomorrow at 2','Haha','ok','tomorrow at 2','yes','call me']) {
    if (db.status === 'stopped') break;
    await getReengageResponse('+14035481389', m, db, 1, '+15873303601', 3, 'House of Cars', 'FRANCO');
  }
  return calls.callback.length === 1;
});

T('LOOP GUARD: Sarah never asks the time twice', async () => {
  reset({ stage: 'reengage_confirm' });
  let timeAsks = 0;
  for (const m of ['what do you have','sure','ok','yes','hello','anything?']) {
    if (db.status === 'stopped') break;
    const r = await getReengageResponse('+14035481389', m, db, 1, '+15873303601', 3, 'House of Cars', 'FRANCO');
    if (/what time (works|suits)/i.test(r)) timeAsks++;
  }
  return timeAsks <= 1;
});


T('decline vocabulary is the SAME at the opening question and the time step', async () => {
  const declines = ['Not at the moment','not now','not today','no thanks','not right now',
                    'maybe later','definitely not','never mind','no need','changed my mind',
                    'some other time','not interested'];
  for (const m of declines) {
    // at the opening question
    reset({ stage: 'reengage_confirm' });
    await getReengageResponse('+1403', m, db, 1, '+15873303601', 3, 'House of Cars', 'FRANCO');
    const a = (db.stage === 'reengage_closed' || db.status === 'stopped');
    // and one stage further on, where Radi and Dale could both have landed
    reset({ stage: 'reengage_time_q' });
    const before = calls.callback.length;
    await getReengageResponse('+1403', m, db, 1, '+15873303601', 3, 'House of Cars', 'FRANCO');
    const b = (db.stage === 'reengage_closed' || db.status === 'stopped') && calls.callback.length === before;
    if (!a || !b) { console.log('   \u21b3 "' + m + '" confirm:' + (a?'ok':'MISSED') + ' time:' + (b?'ok':'BOOKED A CALLBACK')); return false; }
  }
  return true;
});

T('a real time is still not swallowed by the wider decline list', async () => {
  for (const m of ['tomorrow after 4','Thursday morning','anytime today','2pm works','call me at 10']) {
    reset({ stage: 'reengage_time' });
    const before = calls.callback.length;
    await getReengageResponse('+1403', m, db, 1, '+15873303601', 3, 'House of Cars', 'FRANCO');
    if (calls.callback.length !== before + 1) { console.log('   \u21b3 lost a real time:', JSON.stringify(m)); return false; }
  }
  return true;
});


T('Ryan case: a removal request wins over a leading "Yes"', async () => {
  const r = await run('Yes I am but will not be dealing with anyone at house of cars. Please lose my number.');
  return db.status === 'stopped'
      && calls.optOut.length === 1
      && !/call you back|what time/i.test(r);
});

T('removal requests are added to the opt-out table, not just the conversation', async () => {
  for (const m of ['lose my number','please remove my number','delete my number',
                   'not interested','take me off your list','do not contact me again']) {
    const r = await run(m);
    if (db.status !== 'stopped' || calls.optOut.length !== 1) {
      console.log('   \u21b3 not opted out:', JSON.stringify(m), 'status', db.status, 'optOut', calls.optOut.length);
      return false;
    }
  }
  return true;
});

T('a plain yes is still a yes', async () => {
  const r = await run('Yes');
  return db.stage === 'reengage_time' && /what time/i.test(r) && calls.optOut.length === 0;
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
