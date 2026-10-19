// Replays every real reply from both re-engage runs against the FSM and
// asserts the things that must never happen, at every stage.
//
// Why this file exists. Nine bugs shipped on 2026-10-17, every one found by
// a customer rather than a test, and all nine were the same bug: a word
// enumerated in one spelling while customers write it in four.
//
//   "can you get rid of my number please ... I've already bought on[e]"
//        -> "Congrats Kyle!"            (removal ask lost to the word "bought")
//   "I moved to Edmonton"
//        -> "Franco will call you I moved to Edmonton."   (Ed-MON-ton)
//   "Only if it is a Mercedes GT 4 doors"
//        -> "Franco will call you Only if it is a Mercedes GT 4 doors."  (the 4)
//   "yes but i can't get approve they say i need a co signer"
//        -> "Great."                     (and no credit flag)
//
// Each was fixed with a test naming that customer, which stops that exact
// sentence recurring and nothing else. This is the general form: 140 real
// replies x every stage, checked against invariants rather than expected
// strings. It would have caught all four above before anyone saw them.
//
// The corpus is the actual inbound text, de-duplicated, with phone numbers
// and emails masked. Add to it after every run.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'routes', 'sarah.js'), 'utf8');
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reengage-replies.json'), 'utf8'));

// ── lift the FSM out of the module closure, same as sarah-reengage.js ──
const start = src.indexOf('  async function getReengageResponse(');
if (start < 0) throw new Error('getReengageResponse not found');
const end = src.indexOf('\n  async function getJerryResponse(', start);
const creditSrc = (src.match(/^const CREDIT_RE = .*$/m) || [])[0];
if (!creditSrc) throw new Error('CREDIT_RE not found');
const fnSrc = creditSrc + String.fromCharCode(10) + src.slice(start, end);

// The live vocabularies, read out of the shipped file so the test can never
// check a pattern the product no longer uses.
const grab = (re) => { const m = src.match(re); if (!m) throw new Error('pattern not found: ' + re); return m[1]; };
const toRe = (lit) => new RegExp(lit.slice(1, lit.lastIndexOf('/')), 'i');
const LOOKS_LIKE_TIME = toRe(grab(/const looksLikeTime = (\/.*\/i)\.test/));
const CREDIT_RE = toRe(grab(/^const CREDIT_RE = (\/.*\/i);$/m));

let db, calls;
function reset(conv) {
  db = Object.assign({ id: 1, customer_name: 'Test Person', status: 'active',
                       stage: 'reengage_confirm', mode: 'reengage',
                       vehicle_type: null, vehicle_detail: null, datetime: null,
                       credit_flag: false, credit_note: null }, conv || {});
  calls = { update: [], callback: [], notify: [], analytics: [], optOut: [], optIn: [] };
}
const updateConversation = async (id, u) => { calls.update.push(u); Object.assign(db, u); };
const addOptOut = async (p, r) => calls.optOut.push({ p, r });
const removeOptOut = async (p) => calls.optIn.push(p);
const logAnalytics = async (e, p, d) => calls.analytics.push({ e, d });
const saveCallback = async (d) => calls.callback.push(d);
const notifyTenantManagers = async (o) => calls.notify.push(o.body);
const formatPretty = (p) => p;
const twilioClient = {};

const factory = new Function(
  'updateConversation', 'addOptOut', 'removeOptOut', 'logAnalytics', 'saveCallback',
  'notifyTenantManagers', 'formatPretty', 'twilioClient',
  fnSrc + '\n return getReengageResponse;');
const fsm = factory(updateConversation, addOptOut, removeOptOut, logAnalytics,
                    saveCallback, notifyTenantManagers, formatPretty, twilioClient);

const STAGES = ['reengage_confirm', 'reengage_time', 'reengage_time_q',
                'reengage_held_y', 'reengage_held_q', 'reengage_done', 'reengage_closed'];

const run = async (msg, stage) => {
  reset({ stage, datetime: stage === 'reengage_done' ? 'tomorrow' : null });
  const reply = await fsm('+14035550000', msg, db, 1, '+15873303601', 3, 'House of Cars', 'FRANCO');
  return { reply: reply == null ? '' : String(reply) };
};

// ── what must never happen ────────────────────────────────────────
// Each returns a failure string, or null when the outcome is acceptable.
const INVARIANTS = [
  {
    name: 'never reads a customer phrase back as their callback time',
    check: ({ msg, reply }) => {
      const m = reply.match(/will call you ([^.]+)\./);
      if (!m) return null;
      const quoted = m[1].trim();
      if (LOOKS_LIKE_TIME.test(quoted)) return null;
      // Only a complaint if the echoed words came from the customer.
      if (!msg.toLowerCase().includes(quoted.toLowerCase().slice(0, 12))) return null;
      return 'echoed "' + quoted + '" as a time';
    },
  },
  {
    name: 'never congratulates someone who asked to be removed',
    check: ({ msg, reply }) => {
      const removal = /\b(get(ting)? rid of|lose|delete|remove|forget|take off|drop|ditch|scrub)\b[^.!?]{0,24}?\b(my|this|the)\s+(number|phone|cell|contact|info)\b|take\s+(my|this)\s+(number|phone)\s+(off|out)|\b(stop texting|leave me alone|not interested|lose my number)\b/i;
      if (!removal.test(msg)) return null;
      if (/congrat/i.test(reply)) return 'congratulated a removal ask';
      if (db.status !== 'stopped') return 'removal ask did not opt them out (status=' + db.status + ')';
      return null;
    },
  },
  {
    name: 'never quotes money, financing or an appointment',
    check: ({ reply }) => {
      const banned = /\$|\bin the market\b|\btest drive\b|\bappointment\b|\bcome (in|by|down)\b|\bcredit\b|\bfinanc|\bdebt\b|consolidat|\bapprov|\bloan\b|interest rate|\blender/i;
      const hit = reply.match(banned);
      return hit ? 'said "' + hit[0] + '"' : null;
    },
  },
  {
    name: 'a credit answer always sets the credit flag',
    check: ({ msg }) => {
      if (!CREDIT_RE.test(msg)) return null;
      // A removal ask is read first and outranks everything - correct, and
      // those people must not end up on a call list.
      if (db.status === 'stopped') return null;
      return db.credit_flag ? null : 'credit answer left unflagged';
    },
  },
  {
    name: 'never asks more than one question in a reply',
    check: ({ reply }) => {
      const n = (reply.match(/\?/g) || []).length;
      return n > 1 ? 'asked ' + n + ' questions' : null;
    },
  },
  {
    name: 'a booking always carries a time or says it has none',
    check: () => {
      if (!calls.callback.length) return null;
      const when = String(calls.callback[0].datetime || '');
      if (when === 'no time given') return null;
      return LOOKS_LIKE_TIME.test(when) ? null : 'booked "' + when + '" as the time';
    },
  },
  {
    name: 'an opt-out keyword always opts out',
    check: ({ msg }) => {
      if (!/^\s*(stop|unsubscribe)\b/i.test(msg)) return null;
      if (db.status !== 'stopped') return 'STOP did not stop the conversation';
      return calls.optOut.length ? null : 'STOP did not reach the opt-out table';
    },
  },
];

(async () => {
  let runs = 0;
  const failures = new Map();   // invariant -> [{stage, msg, detail}]
  for (const msg of corpus) {
    for (const stage of STAGES) {
      let out;
      try {
        out = await run(msg, stage);
      } catch (e) {
        failures.set('threw', (failures.get('threw') || []).concat(
          [{ stage, msg, detail: e.message }]));
        continue;
      }
      runs++;
      for (const inv of INVARIANTS) {
        let detail = null;
        try { detail = inv.check({ msg, reply: out.reply, stage }); }
        catch (e) { detail = 'check crashed: ' + e.message; }
        if (detail) {
          failures.set(inv.name, (failures.get(inv.name) || []).concat([{ stage, msg, detail }]));
        }
      }
    }
  }

  console.log('  replayed ' + corpus.length + ' real replies across ' + STAGES.length +
              ' stages (' + runs + ' runs)');
  let failed = 0;
  for (const inv of INVARIANTS.map(i => i.name).concat(['threw'])) {
    const hits = failures.get(inv);
    if (!hits) { if (inv !== 'threw') console.log('  PASS  ' + inv); continue; }
    failed++;
    console.log('  FAIL  ' + inv + ' — ' + hits.length + ' case(s)');
    for (const h of hits.slice(0, 4)) {
      console.log('          at ' + h.stage + ': ' + h.detail);
      console.log('          reply to: ' + JSON.stringify(h.msg.slice(0, 90)));
    }
    if (hits.length > 4) console.log('          ... and ' + (hits.length - 4) + ' more');
  }
  console.log('\n' + (INVARIANTS.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
