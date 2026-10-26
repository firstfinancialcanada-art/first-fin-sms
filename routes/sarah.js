// routes/sarah.js
const { pool, getOrCreateCustomer, getOrCreateConversation, updateConversation,
        saveMessage, hasActiveConversation, deleteConversation,
        saveAppointment, saveCallback, logAnalytics,
        addOptOut, removeOptOut, isOptedOut } = require('../lib/db');
const { sendCustomerSms } = require('../lib/customer-sms');
const { normalizePhone, toE164NorthAmerica, formatPretty, makeTwilioWebhookValidator } = require('../lib/helpers');
const { state } = require('../lib/bulk');
const { guardedSmsSend, recordSpend, reconcileSpend } = require('../lib/spend-cap');
const { notifyTenantManagers, notifyRep } = require('../lib/notify');
const leadRouting = require('../lib/lead-routing');
const validateTwilio = makeTwilioWebhookValidator();

// ── Phase 7+ — Centralised vehicle vocabulary ─────────────────────────
// Used by BOTH the sales and acquisition FSMs so they stay consistent and
// recognise the same dealer-customer slang. Expand a list here, both
// scripts get smarter at once. Lower-cased — callers compare with .toLowerCase().
const VEHICLE_VOCAB = {
  truck: [
    'truck','pickup','pick-up','pick up','f-150','f150','f-250','f250','f-350','f350','f-450','f450',
    'silverado','sierra','ram','tacoma','tundra','ranger','frontier','colorado','canyon','gladiator',
    'titan','dakota','ridgeline','maverick','santa cruz','half ton','3/4 ton','1 ton','dually',
    'heavy duty','hd','work truck','wt','lifted','diesel','super duty','cummins','duramax','powerstroke',
    'crew cab','quad cab','extended cab','reg cab','regular cab',
  ],
  suv: [
    'suv','crossover','cuv','jeep','wagoneer','grand cherokee','cherokee','compass','wrangler','renegade',
    'rav4','rav-4','crv','cr-v','hr-v','hrv','passport','pilot','element','highlander','4runner','sequoia',
    'venza','escape','explorer','expedition','edge','equinox','tahoe','suburban','traverse','trailblazer',
    'blazer','yukon','acadia','terrain','bronco','bronco sport','tucson','santa fe','santa cruz','palisade',
    'kona','venue','sorento','sportage','seltos','telluride','rogue','murano','pathfinder','armada','xterra',
    'kicks','ariya','outback','forester','ascent','crosstrek','q3','q5','q7','q8','x1','x3','x5','x6','x7',
    'glc','gle','gls','glb','gla','rx','nx','gx','lx','tx','ux','rdx','mdx','xt5','xt6','xt4','escalade',
    'navigator','aviator','corsair','range rover','discovery','defender','evoque','velar','cayenne','macan',
    'levante','urus','dbx','bentayga','cullinan',
  ],
  car: [
    'car','sedan','coupe','2-door','two door','hatchback','hatch','sports car','sportscar','sport',
    'convertible','cabrio','cabriolet','drop top','droptop','roadster','wagon','station wagon','liftback',
    'civic','accord','corolla','camry','prius','altima','sentra','maxima','versa','elantra','sonata',
    'optima','k5','stinger','forte','rio','soul','niro','jetta','passat','golf','arteon','beetle',
    '3 series','5 series','7 series','8 series','m3','m4','m5','m8','c-class','e-class','s-class','cls','amg',
    'a3','a4','a5','a6','a7','a8','rs','is','es','ls','rc','lc','tlx','ilx','rlx','model 3','model s','model y','model x','plaid',
    'mustang','camaro','challenger','charger','300','dart','focus','fusion','fiesta','taurus','impala',
    'malibu','cruze','spark','sonic','volt','bolt','lancer','mirage','eclipse','cts','ats','xts',
    'mazda3','mazda 3','mazda6','mazda 6','miata','mx-5','mx5','brz','frs','86','supra','gt-r','gtr','nsx',
    'wrx','sti','impreza','legacy','genesis g70','genesis g80','genesis g90','g70','g80','g90',
  ],
  van: [
    'van','minivan','mini-van','mini van','sienna','odyssey','pacifica','voyager','carnival','caravan',
    'town and country','town & country','town country','quest','transit','transit connect','sprinter',
    'promaster','metris','express','savana','nv200','cargo van','passenger van',
  ],
  ev: [
    'electric','ev','hybrid','phev','bev','plug-in','plug in','plugin','battery electric',
    'tesla','model 3','model s','model y','model x','rivian','r1t','r1s','lucid','air','polestar',
    'ioniq','ioniq 5','ioniq 6','mach-e','mach e','mache','lightning','f-150 lightning','bolt','bolt euv',
    'leaf','i3','i4','i5','i7','ix','ix3','etron','e-tron','q4 e-tron','q8 e-tron','taycan',
    'eqs','eqe','eqb','genesis gv60','gv60','prius prime','volt','rav4 prime','niro ev','kona ev','ev6','ev9',
  ],
};

// All known makes — broad, includes spelling variants. Used to recognise
// "do you have any 2020 Mustangs?" or "I'm selling my 2018 Civic".
// ── Credit / affordability vocabulary ─────────────────────────────────
// An aged lead who didn't buy often didn't buy for one reason, and it is
// usually this one. Jefferson wrote "Yeah but my credit is still bad and no
// cosigner"; four of the nine callbacks off the first reengage run were
// credit or write-off cases. Those people are a different conversation from
// a shopper who simply hasn't found the right truck yet, so they get their
// own list for the desk to work.
//
// Sarah says NOTHING about any of this. She does not mention credit,
// financing, debt or approval, does not ask a follow-up question about it,
// and never suggests a product — she acknowledges it plainly and hands it
// to a human, same as every other reply in the funnel. This regex only
// decides which list the lead lands on.
//
// Generic words (declined, denied, turned down) are left unanchored on
// purpose: on a list of people who enquired about a vehicle and didn't buy,
// "I got declined" is about financing. A false positive costs one extra row
// on a call list that shows the customer's own words, which is cheap. A
// miss costs the lead.
const CREDIT_RE = /\b(bad credit|poor credit|no credit|thin credit|credit score|credit challenged|credit (is|isn'?t|was|ain'?t)\s*(bad|poor|shot|rough|great|good|terrible|awful)?|my credit|rebuilding (my )?credit|subprime|no co[- ]?signer|co[- ]?signer|bankrupt|bankruptcy|consumer proposal|repo(ed|s|'d|ssession|ssessed|ssessing)?|in collections|collections|garnish(ment|ed)?|judge?ment|too much debt|debt|student loans?|laid off|lost my job|no job|unemployed|on ei|disability|can'?t afford|cannot afford|struggling|turned down|declined|denied|not approved|not approve|wasn'?t approved|need (a|an)? ?co[- ]?signer|couldn'?t get (approve|approved|financ(ed|ing))|(won'?t|wont|can'?t|cant|cannot|unable to|not)[^.!?]{0,28}financ(e|ed|ing)|can'?t get (approve|approved|financ(ed|ing))|cant get approve|financing (fell|didn'?t|did not|was declined)|bank (said no|turned me down|declined)|no money|no down( payment)?|money('?s)? tight|tight on money)\b/i;

const VEHICLE_MAKES = [
  'ford','chevrolet','chevy','gmc','dodge','ram','jeep','chrysler','fiat','alfa romeo','alfa-romeo','alfa',
  'toyota','honda','acura','lexus','infiniti','nissan','datsun','mazda','subaru','mitsubishi','suzuki','isuzu',
  'volkswagen','vw','audi','bmw','mini','mercedes','mercedes-benz','mercedes benz','smart','porsche',
  'volvo','jaguar','land rover','range rover','rover',
  'hyundai','kia','genesis','tesla','rivian','lucid','polestar','byd',
  'cadillac','lincoln','buick','pontiac','saturn','oldsmobile','mercury','saab','hummer',
  'ferrari','lamborghini','maserati','bentley','rolls-royce','rolls royce','aston martin','aston-martin',
  'mclaren','bugatti','lotus','koenigsegg','pagani',
];

// Returns vehicleType ('Truck' | 'SUV' | 'Car' | 'Van' | 'Electric/Hybrid' | null)
// for a customer message — runs against VEHICLE_VOCAB. Also handles bare
// affirmatives like "yes" / "looking" by returning generic 'Vehicle' so
// the FSM can advance instead of looping.
// Matches a vocab term as a whole word, allowing a plural. Raw
// String.includes() was matching short model codes inside ordinary words:
// "my business is slow" → Lexus IS → Car. "i have a program" → RAM → Truck.
// "interested", "address" and "available" all contain Lexus ES. Every one of
// those false hits also wrote a wrong vehicle_type onto the lead and shoved
// the customer into the buying funnel, which is where "Car — great choice!"
// came from. Trailing s/es is allowed so "trucks" and "SUVs" still match.
const VOCAB_RE_CACHE = new Map();
function vocabMatch(text, term) {
  let re = VOCAB_RE_CACHE.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(^|[^a-z0-9])${esc}(s|es)?([^a-z0-9]|$)`, 'i');
    VOCAB_RE_CACHE.set(term, re);
  }
  return re.test(text);
}

// Vocab terms that are also ordinary English words or bare numbers. Whole-word
// matching isn't enough for these: "my name is chris" and "the price is too
// high" are not people shopping for a Lexus IS, and "300 a month" is not a
// Chrysler 300. They only count when the message also names a make.
const AMBIGUOUS_TERMS = new Set(['is', 'es', 'ls', 'rs', 'rc', 'lc', 'gx', 'lx', 'nx', 'ux', 'tx', 'hd', 'wt', 'sport', '300', '86']);
const MAKE_WORDS = [
  'lexus', 'audi', 'bmw', 'mercedes', 'benz', 'chrysler', 'cadillac', 'toyota', 'honda',
  'ford', 'chevy', 'chevrolet', 'gmc', 'ram', 'dodge', 'jeep', 'nissan', 'hyundai', 'kia',
  'mazda', 'subaru', 'volkswagen', 'vw', 'tesla', 'acura', 'infiniti', 'lincoln', 'buick',
  'genesis', 'porsche', 'volvo', 'mitsubishi', 'land rover', 'range rover', 'jaguar', 'mini',
];

function detectVehicleType(lowerMsg) {
  if (!lowerMsg) return null;
  const hasMake = MAKE_WORDS.some(m => vocabMatch(lowerMsg, m));
  const has = (list) => list.some(w =>
    (AMBIGUOUS_TERMS.has(w) ? hasMake : true) && vocabMatch(lowerMsg, w));
  // Order matters — EV check first because "tesla model 3" should classify
  // as EV not Car (the model 3 token is in both lists by design).
  if (has(VEHICLE_VOCAB.ev))    return 'Electric/Hybrid';
  if (has(VEHICLE_VOCAB.truck)) return 'Truck';
  if (has(VEHICLE_VOCAB.suv))   return 'SUV';
  if (has(VEHICLE_VOCAB.van))   return 'Van';
  if (has(VEHICLE_VOCAB.car))   return 'Car';
  // Weak affirmatives — no specific vehicle named, but enough intent to
  // advance instead of looping. Whole-word too: "yes" must not fire on
  // "yesterday", and these only ever produce the generic 'Vehicle', which
  // GENERIC_TYPES keeps out of anything we say back to the customer.
  if (['yes', 'yeah', 'interested', 'looking', 'want', 'need', 'vehicle', 'something']
      .some(w => vocabMatch(lowerMsg, w))) return 'Vehicle';
  return null;
}

// detectVehicleType returns these when it matched nothing specific — just a
// word like "vehicle" or "looking". Never say one back to a customer: "Vehicle
// — great choice!" is how a template slot full of nothing ends up in a text.
const GENERIC_TYPES = new Set(['Vehicle']);

// How each detected type reads inside a sentence. Naive .toLowerCase() gives
// "a suv" and "a electric/hybrid"; the article has to follow the sound of the
// word, not the spelling — "an SUV", "a Van".
const TYPE_PHRASE = {
  'Truck':            'a truck',
  'SUV':              'an SUV',
  'Van':              'a van',
  'Car':              'a car',
  'Electric/Hybrid':  'an EV or hybrid',
};
function typePhrase(type) { return TYPE_PHRASE[type] || ''; }

// True when the customer answered without giving us anything — "no", "idk",
// "just looking". The rule (Franco): stop probing and go book. One unanswered
// discovery question is a signal, not an invitation to ask it differently.
// Deliberately narrow: only explicit non-answers, so "Honda Civic" or "4x4"
// can never be mistaken for a stall.
const STALL_RE = /^(no|nope|nah|n\/?a|idk|dunno|i ?don'?t ?know|not ?sure|no ?idea|whatever|anything|any|doesn'?t ?matter|does ?not ?matter|don'?t ?care|nothing|none|(just ?)?(looking|browsing)|open|not ?really|maybe)\b[\s.!?]*$/i;
function soundsStalled(raw) {
  const t = String(raw || '').trim();
  return !t || STALL_RE.test(t);
}

// Detects when a customer's message clearly indicates the OPPOSITE direction
// from the conversation's current mode. Examples:
//  - In sales mode, customer says "selling my civic" → returns 'acquisition'
//  - In acquisition mode, customer says "looking for a truck" → returns 'sales'
// Returns null if no clear signal. Defensive — only fires on unambiguous cues
// so accidental pivots are rare. Used at the top of both FSMs for mid-flow
// dynamicity (Franco's bulletproofing requirement).
function detectWrongDirection(lowerMsg, currentMode) {
  if (!lowerMsg) return null;
  // SELL-side intent — pivots TO acquisition mode if currently in sales
  const sellingPhrases = [
    "selling my","sell my","want to sell","wanna sell","looking to sell","trying to sell",
    "trade in my","trade my","appraise my","appraisal on my","value of my","what's my",
    "i'm selling","im selling","got a car to sell","got a truck to sell",
    "sell you my","sell to you","unload my","get rid of my","traded in my",
  ];
  // BUY-side intent — pivots TO sales mode if currently in acquisition
  const buyingPhrases = [
    "looking to buy","want to buy","wanna buy","need to buy","looking for a","need a",
    "shopping for","in the market for","interested in buying","i'm buying","im buying",
    "do you have any","do you have a","got any","any ", // " any " with trailing space — generic ask
  ];
  if (currentMode === 'sales') {
    if (sellingPhrases.some(p => lowerMsg.includes(p))) return 'acquisition';
  }
  if (currentMode === 'acquisition') {
    if (buyingPhrases.some(p => lowerMsg.includes(p))) return 'sales';
  }
  return null;
}

// Robust mileage / odometer parser. Handles:
//   "150000", "150,000", "150K", "150k", "150 km", "150,000 kms", "150 thousand"
// Tightened: "k" multiplier ONLY fires when it's a true suffix (e.g. "150k"
// or "150K" with no letters after) — NOT when the message contains "km"/"kms"
// alone (which means "kilometers" the unit, not "thousand"). Returns the
// parsed integer or null if ambiguous / out of plausible range.
function parseMileage(message) {
  if (!message) return null;
  const lower = message.toLowerCase();
  // Word-form: "150 thousand" / "two hundred thousand" — handle the digit case
  const thousandMatch = lower.match(/(\d[\d,]*)\s*(thousand|grand)/);
  if (thousandMatch) {
    const n = parseInt(thousandMatch[1].replace(/,/g, ''), 10) * 1000;
    return (n >= 1000 && n <= 999999) ? n : null;
  }
  // Standard digit pattern
  const numMatch = message.match(/\d[\d,]*/);
  if (!numMatch) return null;
  let n = parseInt(numMatch[0].replace(/,/g, ''), 10);
  // K multiplier: ONLY if the digit is followed directly by 'k' (no 'm' after,
  // i.e. "150k" yes, "150km" no). Use regex with word boundary.
  if (/\d+\s*k(?![ms])/i.test(message)) n *= 1000;
  if (n >= 100 && n <= 999999) return n;
  return null;
}

// Parse a dollar amount: "$15,000" / "15k" / "15000" / "fifteen thousand".
// Same K-vs-unit safeguard.
function parseDollarAmount(message) {
  if (!message) return null;
  const cleaned = message.replace(/[\$,]/g, '');
  const m = cleaned.match(/\d+/);
  if (!m) return null;
  let n = parseInt(m[0], 10);
  if (/\d+\s*k\b/i.test(message)) n *= 1000;
  if (n >= 100 && n <= 999999) return n;
  return null;
}

// Try to extract year/make/model from a message like "yes my 2020 Mustang"
// or "selling a 2018 Civic". Returns { year, make, model } where any field
// may be null.
function extractVehicleFromText(message) {
  if (!message) return { year: null, make: null, model: null };
  const lower = message.toLowerCase();
  const yearMatch = message.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
  const make = VEHICLE_MAKES.find(m => lower.includes(m)) || null;
  // Naive model: scan all VEHICLE_VOCAB lists for a hit other than the generic
  // category words ("truck", "suv", "car", etc).
  let model = null;
  const generic = new Set(['truck','suv','car','sedan','van','minivan','mini-van','mini van',
    'crossover','coupe','hatchback','hatch','sports car','sportscar','sport','convertible','wagon',
    'electric','ev','hybrid','phev','vehicle','pickup','pick-up','pick up']);
  for (const list of Object.values(VEHICLE_VOCAB)) {
    for (const word of list) {
      if (generic.has(word)) continue;
      if (lower.includes(word) && (!model || word.length > model.length)) {
        model = word;
      }
    }
  }
  const makeLabel = make
    ? make.split(/[\s-]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
    : null;
  const modelLabel = model
    ? model.split(/[\s-]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
    : null;
  return { year, make: makeLabel, model: modelLabel };
}

module.exports = function sarahRoutes(app, { twilioClient, requireAuth, requireBilling, notifyOwner }) {

  // ── Tenant settings cache — 5 min TTL ────────────────────────────
  const _tenantCache = new Map();
  const TENANT_CACHE_TTL = 5 * 60 * 1000;

  async function getTenantSettings(userId) {
    const cached = _tenantCache.get(userId);
    if (cached && Date.now() - cached.ts < TENANT_CACHE_TTL) return cached.data;
    const result = await pool.query(
      `SELECT settings_json, twilio_number FROM desk_users WHERE id = $1`,
      [userId]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    const parsed = typeof row.settings_json === 'string'
      ? JSON.parse(row.settings_json) : (row.settings_json || {});
    const data = {
      twilioNumber:    row.twilio_number || parsed.twilioNumber  || null,
      notifyPhone:     parsed.notifyPhone   || null,
      dealerName:      parsed.dealerName    || null,
      dealerCity:      parsed.dealerCity    || null,
      salesName:       parsed.salesName     || null,
      deliveryArea:    parsed.deliveryArea  || '',
      googleReviewUrl: parsed.googleReviewUrl || null,
    };
    _tenantCache.set(userId, { data, ts: Date.now() });
    return data;
  }

  function invalidateTenantCache(userId) { _tenantCache.delete(userId); }

  // When a tenant is out of its monthly allowance Sarah's reply is
  // blocked. The customer hears nothing, so a person has to — one alert
  // per customer per 30 minutes, not one per message.
  const _capAlerted = new Map();
  function shouldAlertCapBlock(tenantId, phone) {
    const key = `${tenantId}:${phone}`;
    const last = _capAlerted.get(key) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return false;
    _capAlerted.set(key, Date.now());
    if (_capAlerted.size > 5000) _capAlerted.clear();
    return true;
  }

  // Expose cache invalidation for desk.js settings save
  app.locals.invalidateTenantCache = invalidateTenantCache;

  // ── Ensure twilio_number index exists ─────────────────────────────
  ;(async () => {
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_desk_users_twilio_number
        ON desk_users(twilio_number)
        WHERE twilio_number IS NOT NULL
      `);
    } catch(e) { /* index already exists or schema issue */ }
  })();

  // ── Sarah modes + acquisition fields (Phase 7) ─────────────────────
  // Adds a 'mode' switch on conversations + the columns the acquisition
  // FSM populates (vehicle being sold, mileage, condition, asking price,
  // replacement interest). Plus trade-in fields used by BOTH modes — the
  // sales flow asks "got a trade?" before booking, the acquisition flow
  // asks "looking to replace it?" — same fields, opposite lead direction.
  // Idempotent ALTER ADD COLUMN IF NOT EXISTS so re-deploys are no-ops.
  ;(async () => {
    try {
      await pool.query(`
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'sales';
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source VARCHAR(40);
        -- What the buyer said they're after, verbatim, from the discovery
        -- stage ("crew cab, 4x4, room for car seats"). Free text on purpose:
        -- it's for the closer to read, not for us to parse.
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_detail  VARCHAR(255);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_make    VARCHAR(60);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_model   VARCHAR(80);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_year    INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_mileage INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_condition VARCHAR(50);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS asking_price   INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS replacement_interest BOOLEAN;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_make  VARCHAR(60);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_model VARCHAR(80);
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_year  INTEGER;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trade_in_value INTEGER;
        -- Phase 8b: the credit funnel. A reengage lead who says they were
        -- declined, or that their credit is bad, is worth a different call
        -- than a shopper still hunting, so the desk needs them as a list.
        -- credit_note holds their own words -- the desk reads those, not a
        -- label we invented for them.
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS credit_flag BOOLEAN DEFAULT FALSE;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS credit_note VARCHAR(255);
        -- Human takeover. The moment an operator types a reply themselves,
        -- the thread stops being Sarah's. Without this she keeps running her
        -- script on the customer's next message and answers on top of the
        -- person who just spoke -- two voices in one thread, which is exactly
        -- what confused Nick Foessel when the desk started calling a customer
        -- whose documents were already collected.
        --
        -- One way only. Nothing in the FSM clears it; re-enabling automation
        -- on a thread a human has entered is a deliberate act, not a timeout.
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_by INTEGER;
      `);
      // bulk_messages carries the campaign mode through to the processor so
      // the conversation it creates inherits the right mode.
      await pool.query(`
        ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'sales';
      `);
      console.log('✅ conversations.mode + acquisition/trade-in columns ready');
    } catch(e) { console.warn('Sarah modes schema:', e.message); }
  })();


  // ── Dashboard stats ───────────────────────────────────────────
  app.get('/api/dashboard', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const customers      = await client.query('SELECT COUNT(*) as count FROM customers WHERE user_id = $1', [uid]);
      const conversations  = await client.query('SELECT COUNT(*) as count FROM conversations WHERE user_id = $1', [uid]);
      const messages       = await client.query('SELECT COUNT(*) as count FROM messages WHERE user_id = $1', [uid]);
      const appointments   = await client.query('SELECT * FROM appointments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25', [uid]);
      const callbacks      = await client.query('SELECT * FROM callbacks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25', [uid]);
      res.json({
        stats: {
          totalCustomers:     parseInt(customers.rows[0].count),
          totalConversations: parseInt(conversations.rows[0].count),
          totalMessages:      parseInt(messages.rows[0].count),
          totalAppointments:  appointments.rows.length,
          totalCallbacks:     callbacks.rows.length
        },
        recentAppointments: appointments.rows,
        recentCallbacks:    callbacks.rows
      });
    } catch (error) {
      res.json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ── All conversations ─────────────────────────────────────────
  app.get('/api/conversations', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT ON (c.customer_phone)
          c.id, c.customer_phone,
          -- customers.name is only ever written by the sales and acquisition
          -- FSMs, at the point Sarah asks "what's your name?". Reengage never
          -- asks, because the campaign already supplied it — so the whole
          -- pilot rendered as 25 rows of "Unknown" while the name sat in
          -- conversations.customer_name the entire time. Read both.
          COALESCE(NULLIF(TRIM(cu.name), ''), NULLIF(TRIM(c.customer_name), '')) as customer_name,
          c.stage, c.status, c.vehicle_type, c.budget, c.mode,
          c.started_at, c.updated_at,
          (SELECT COUNT(*) FROM messages m
           JOIN conversations cx ON m.conversation_id = cx.id
           WHERE cx.customer_phone = c.customer_phone AND cx.user_id = $1) as message_count,
          (SELECT m2.content FROM messages m2
           JOIN conversations cx2 ON m2.conversation_id = cx2.id
           WHERE cx2.customer_phone = c.customer_phone AND cx2.user_id = $1
           ORDER BY m2.created_at DESC LIMIT 1) as last_message
        FROM conversations c
        LEFT JOIN customers cu ON c.customer_phone = cu.phone AND cu.user_id = $1
        WHERE c.user_id = $1
        ORDER BY c.customer_phone, c.updated_at DESC
      `, [uid]);
      result.rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      res.json(result.rows.slice(0, 50));
    } catch (error) {
      res.json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Credit funnel — the list the desk works ───────────────────
  // Everyone the reengage funnel heard a credit or affordability answer
  // from, newest first, with their own words. Separate from the ordinary
  // callback list because it is a different phone call.
  //
  // Opted-out numbers are left off. Someone who asked to be taken off the
  // list is off it, and a list that quietly keeps them is the thing that
  // gets a dealer in trouble.
  app.get('/api/reengage/credit-leads', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    try {
      const r = await pool.query(`
        SELECT DISTINCT ON (c.customer_phone)
               c.customer_phone,
               COALESCE(NULLIF(TRIM(cu.name), ''), NULLIF(TRIM(c.customer_name), '')) AS customer_name,
               c.credit_note, c.stage, c.status, c.datetime, c.vehicle_detail, c.updated_at,
               (SELECT m.content FROM messages m
                 WHERE m.conversation_id = c.id AND m.role = 'user'
                 ORDER BY m.created_at DESC LIMIT 1) AS last_inbound
          FROM conversations c
          LEFT JOIN customers cu ON cu.phone = c.customer_phone AND cu.user_id = $1
         WHERE c.user_id = $1
           AND c.credit_flag = TRUE
           AND c.status <> 'stopped'
         ORDER BY c.customer_phone, c.updated_at DESC
      `, [uid]);
      const leads = r.rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      res.json({ success: true, count: leads.length, leads });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── Credit funnel — backfill from replies already in hand ─────
  // The first reengage run finished before the flag existed, and the most
  // valuable answers on it were credit answers. Re-reads what those people
  // actually said and flags them, so the list starts full instead of empty.
  // Idempotent: run it as often as you like.
  async function backfillCreditFlags(uid) {
    const SEP = String.fromCharCode(30);   // record separator — not typable on a phone
    const r = await pool.query(`
      SELECT c.id, c.customer_phone, c.credit_flag,
             (SELECT string_agg(m.content, $2 ORDER BY m.created_at)
                FROM messages m
               WHERE m.conversation_id = c.id AND m.role = 'user') AS said
        FROM conversations c
       WHERE c.user_id = $1 AND c.mode = 'reengage' AND c.status <> 'stopped'
    `, [uid, SEP]);
    let flagged = 0, already = 0;
    const hits = [];
    for (const row of r.rows) {
      const said = String(row.said || '');
      if (!said) continue;
      const hit = said.split(SEP).find(part => CREDIT_RE.test(part));
      if (!hit) continue;
      if (row.credit_flag) { already++; continue; }
      const note = hit.trim().replace(/\s+/g, ' ').slice(0, 250);
      await updateConversation(row.id, { credit_flag: true, credit_note: note });
      flagged++;
      hits.push({ phone: row.customer_phone, note });
    }
    return { success: true, scanned: r.rows.length, flagged, already, hits };
  }

  app.post('/api/reengage/backfill-credit', requireAuth, async (req, res) => {
    try {
      res.json(await backfillCreditFlags(req.user.userId));
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Same backfill, admin-token authenticated, so it can be run for a tenant
  // from the operator side without touching their password. userId is
  // required and is the only tenant touched.
  app.post('/api/admin/reengage/backfill-credit', async (req, res) => {
    if (!process.env.ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
    }
    const uid = Number(req.body && req.body.userId);
    if (!uid) return res.status(400).json({ success: false, error: 'userId required' });
    try {
      res.json(await backfillCreditFlags(uid));
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── Single conversation history ───────────────────────────────
  app.get('/api/conversation/:phone', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const { phone } = req.params;
      const conversation = await client.query(
        'SELECT * FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 1',
        [phone, uid]
      );
      if (conversation.rows.length === 0) {
        return res.json({ error: 'No conversation found' });
      }
      const allConvIds = await client.query(
        'SELECT id FROM conversations WHERE customer_phone = $1 AND user_id = $2',
        [phone, uid]
      );
      const ids = allConvIds.rows.map(r => r.id);
      let messages;
      if (ids.length === 1) {
        messages = await client.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [ids[0]]);
      } else {
        messages = await client.query('SELECT * FROM messages WHERE conversation_id = ANY($1) ORDER BY created_at ASC', [ids]);
      }
      res.json({ conversation: conversation.rows[0], messages: messages.rows });
    } catch (error) {
      res.json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Delete conversation ───────────────────────────────────────
  app.delete('/api/conversation/:phone', requireAuth, requireBilling, async (req, res) => {
    try {
      const { phone } = req.params;
      const deleted = await deleteConversation(phone, req.user.userId);
      if (deleted) {
        res.json({ success: true, message: 'Conversation deleted' });
      } else {
        res.json({ success: false, error: 'Conversation not found' });
      }
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

  // ── Delete appointment ────────────────────────────────────────
  app.delete('/api/appointment/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      await client.query('DELETE FROM appointments WHERE id = $1 AND user_id = $2', [id, req.user.userId]);
      console.log('✅ Appointment deleted:', id);
      res.json({ success: true, message: 'Appointment deleted' });
    } catch (error) {
      console.error('Error deleting appointment:', error);
      res.json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Delete callback ───────────────────────────────────────────
  app.delete('/api/callback/:id', requireAuth, requireBilling, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      await client.query('DELETE FROM callbacks WHERE id = $1 AND user_id = $2', [id, req.user.userId]);
      console.log('✅ Callback deleted:', id);
      res.json({ success: true, message: 'Callback deleted' });
    } catch (error) {
      console.error('Error deleting callback:', error);
      res.json({ success: false, error: error.message });
    } finally {
      client.release();
    }
  });

  // ── Manual reply ──────────────────────────────────────────────
  app.post('/api/manual-reply', requireAuth, requireBilling, async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) return res.json({ success: false, error: 'Phone and message required' });
      // CASL: block replies to opted-out customers (global opt-out table + conversation status)
      if (await isOptedOut(phone)) {
        return res.json({ success: false, error: 'This number is on the global opt-out list. They must reply START to re-subscribe.' });
      }
      const stoppedCheck = await pool.query(
        `SELECT status FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1`,
        [phone, req.user.userId]
      );
      if (stoppedCheck.rows[0]?.status === 'stopped') {
        return res.json({
          success: false,
          error: 'This customer has opted out (replied STOP). They must reply START before you can contact them.'
        });
      }
      const conversation = await getOrCreateConversation(phone, req.user.userId);
      await saveMessage(conversation.id, phone, 'assistant', message, req.user.userId);
      // A human has entered the thread. Stamp it before the send, not after:
      // if Twilio is slow the customer can reply while we are still waiting,
      // and the inbound must already know Sarah is off this conversation.
      // Only the first takeover is recorded -- re-stamping on every manual
      // reply would lose when the handoff actually happened.
      if (!conversation.handoff_at) {
        await pool.query(
          'UPDATE conversations SET handoff_at = NOW(), handoff_by = $1 WHERE id = $2 AND handoff_at IS NULL',
          [req.user.userId, conversation.id]
        ).catch(() => {});
        await logAnalytics('handoff_to_human', phone, { conversationId: conversation.id }, req.user.userId).catch(() => {});
        console.log('🙋 Handoff to human for', phone, '— Sarah is off this thread');
      }
      await logAnalytics('manual_reply_sent', phone, { message }, req.user.userId);
      // Use tenant's twilio number for outbound
      let manualFromNumber = process.env.TWILIO_PHONE_NUMBER;
      try {
        const ts = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [req.user.userId]);
        const sp = typeof ts.rows[0]?.settings_json === 'string' ? JSON.parse(ts.rows[0].settings_json) : (ts.rows[0]?.settings_json || {});
        if (sp.twilioNumber) manualFromNumber = sp.twilioNumber;
      } catch(e) {}
      const sendResult = await guardedSmsSend(twilioClient, req.user.userId, {
        body: message, from: manualFromNumber, to: phone
      });
      if (!sendResult.ok && sendResult.reason === 'SPEND_CAP_EXCEEDED') {
        return res.status(402).json({
          success: false, code: 'SPEND_CAP_EXCEEDED',
          error: 'Monthly Twilio cap reached. Top up overage balance to continue sending.',
          usage: sendResult.usage, needCents: sendResult.needCents,
        });
      }
      if (!sendResult.ok) throw sendResult.error || new Error('SMS send failed');
      console.log('✅ Manual reply sent to:', phone);
      res.json({ success: true, message: 'Reply sent!' });
    } catch (error) {
      console.error('❌ Error sending manual reply:', error);
      res.json({ success: false, error: error.message });
    }
  });

  // ── Start SMS campaign ────────────────────────────────────────
  app.post('/api/start-sms', requireAuth, requireBilling, async (req, res) => {
    try {
      const { phone, message, mode } = req.body;
      // 'sales' (default — buy-side qualification) or 'acquisition' (Sarah
      // is reaching out to a prospective seller — qualifies the customer's
      // vehicle, mileage, condition, asking price, then pivots to "looking
      // to replace it?" before booking). Same modes as the bulk launcher.
      const launchMode = (mode === 'acquisition' || mode === 'reengage') ? mode : 'sales';
      if (!phone) return res.json({ success: false, error: 'Phone number required' });
      const normalizedPhone = toE164NorthAmerica(phone);
      if (!normalizedPhone) return res.json({ success: false, error: 'Invalid phone number format' });
      const hasActive = await hasActiveConversation(normalizedPhone, req.user.userId);
      if (hasActive) {
        return res.json({
          success: false,
          error: 'This customer already has an active conversation. Check "Recent Conversations" below to continue their conversation.'
        });
      }
      // CASL: block if customer has previously opted out
      const stoppedCheck = await pool.query(
        `SELECT status FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1`,
        [normalizedPhone, req.user.userId]
      );
      if (stoppedCheck.rows[0]?.status === 'stopped') {
        return res.json({
          success: false,
          error: 'This number has opted out (replied STOP). You cannot contact them unless they reply START.'
        });
      }
      // Resolve dealer name from tenant settings (TENANT_DEALER_NAME is only scoped to the webhook handler)
      let tenantName = 'the dealership';
      try {
        const ts = await getTenantSettings(req.user.userId);
        if (ts?.dealerName) tenantName = ts.dealerName;
      } catch(e) {}
      const messageBody = message || `Hi! 👋 I'm Sarah from ${tenantName}. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)`;
      const uid = req.user.userId;
      await getOrCreateCustomer(normalizedPhone, uid);
      const conversation = await getOrCreateConversation(normalizedPhone, uid);
      if (!conversation.source) {
        await pool.query('UPDATE conversations SET source = $1 WHERE id = $2', ['manual', conversation.id]).catch(() => {});
      }
      // Phase 7 — propagate launch mode to the conversation so when the
      // customer replies, Sarah runs the acquisition FSM instead of the
      // sales one. Only sets if the conversation isn't already in
      // acquisition mode (don't downgrade an existing acq thread).
      if (launchMode === 'acquisition' && conversation.mode !== 'acquisition') {
        await updateConversation(conversation.id, { mode: 'acquisition', stage: 'acq_confirm' });
      }
      // Reengage is an explicit, operator-chosen campaign on an aged list,
      // so it does set mode even over an existing sales thread — but it
      // never overwrites a live acquisition thread.
      if (launchMode === 'reengage' && conversation.mode !== 'acquisition') {
        await updateConversation(conversation.id, { mode: 'reengage', stage: 'reengage_confirm' });
      }
      await saveMessage(conversation.id, normalizedPhone, 'assistant', messageBody, uid);
      await logAnalytics('sms_sent', normalizedPhone, { messageBody, mode: launchMode }, uid);
      // Use tenant's twilio number for outbound
      let startFromNumber = process.env.TWILIO_PHONE_NUMBER;
      try {
        const ts = await getTenantSettings(uid);
        if (ts?.twilioNumber) startFromNumber = ts.twilioNumber;
      } catch(e) {}
      const startResult = await guardedSmsSend(twilioClient, uid, {
        body: messageBody, from: startFromNumber, to: normalizedPhone
      });
      if (!startResult.ok && startResult.reason === 'SPEND_CAP_EXCEEDED') {
        return res.status(402).json({
          success: false, code: 'SPEND_CAP_EXCEEDED',
          error: 'Monthly Twilio cap reached. Top up overage balance to continue sending.',
          usage: startResult.usage, needCents: startResult.needCents,
        });
      }
      if (!startResult.ok) throw startResult.error || new Error('SMS send failed');
      console.log('✅ SMS sent to:', normalizedPhone);
      res.json({ success: true, message: 'SMS sent!' });
    } catch (error) {
      console.error('❌ Error sending SMS:', error);
      res.json({ success: false, error: error.message });
    }
  });

  // ── SMS Delivery Status Callback (Twilio) ─────────────────────
  // Twilio POSTs here after each message status transition. Final 'delivered'
  // or 'failed' events typically include Price (negative decimal string in
  // account currency), which we reconcile against the at-send-time estimate
  // stored in tenant_spend_events so tenant_usage.sms_spend_cents reflects
  // actual Twilio billing rather than our 1¢/segment approximation.
  // Signed like every other Twilio callback. This one moves money: it feeds
  // reconcileSpend, so an unsigned POST with a large Price could inflate a
  // dealer's usage until the cap silences Sarah on their real leads. Needs a
  // message SID to aim at, which is not a reason to leave it open.
  app.post('/api/sms-status', validateTwilio, async (req, res) => {
    try {
      const { MessageSid, MessageStatus, Price } = req.body;
      if (MessageSid && MessageStatus) {
        await pool.query(
          'UPDATE bulk_messages SET delivery_status = $1 WHERE twilio_sid = $2',
          [MessageStatus, MessageSid]
        );
      }
      if (MessageSid && Price) {
        const actualCents = Math.round(Math.abs(parseFloat(Price)) * 100);
        if (Number.isFinite(actualCents)) {
          await reconcileSpend(MessageSid, actualCents);
        }
      }
    } catch (e) {
      console.error('❌ sms-status callback error:', e.message);
    }
    res.status(200).send('<Response></Response>');
  });

  // ── SMS Webhook (Twilio) ──────────────────────────────────────
  app.post('/api/sms-webhook', validateTwilio, async (req, res) => {
    // Phase 1: resolve tenant from Twilio 'To' number
    const toNumber = req.body.To || process.env.TWILIO_PHONE_NUMBER;
    let WEBHOOK_USER_ID;

    // Tenant is resolved from the number the customer texted, and ONLY from
    // that. The fallback here used to end at "whatever account OWNER_EMAIL
    // points at", which meant any message to a number not present in
    // desk_users.twilio_number was attributed to the platform owner: their
    // Sarah replied, their notify phone rang, their CRM took the lead. A
    // tenant could set their own notify number correctly and still never see
    // their leads, because the message was never theirs to begin with.
    //
    // The master-number fallback is kept, but only for the master number
    // itself — demo traffic and an unprovisioned tenant texting the shared
    // line. Anything else is refused loudly. Silence that shows up in the log
    // is recoverable; quietly handing one dealer's customer to another is not.
    async function resolveMasterTenant() {
      const masterNumber = process.env.TWILIO_PHONE_NUMBER;
      if (!masterNumber) return null;
      const r = await pool.query(
        `SELECT id FROM desk_users WHERE twilio_number = $1 LIMIT 1`, [masterNumber]
      );
      return r.rows[0]?.id || null;
    }

    try {
      const tenantResult = await pool.query(
        `SELECT id FROM desk_users WHERE twilio_number = $1 LIMIT 1`,
        [toNumber]
      );
      if (tenantResult.rows.length > 0) {
        WEBHOOK_USER_ID = tenantResult.rows[0].id;
      } else if (toNumber && toNumber === process.env.TWILIO_PHONE_NUMBER) {
        WEBHOOK_USER_ID = await resolveMasterTenant();
      } else {
        console.error(`❌ Inbound to ${toNumber} matches no tenant's twilio_number — REFUSED, not reassigned. ` +
                      `If this is a real tenant, set their twilio_number in Settings.`);
        return res.type('text/xml').send('<Response></Response>');
      }
    } catch(e) {
      console.error('⚠️ Tenant lookup failed:', e.message);
      return res.type('text/xml').send('<Response></Response>');
    }
    if (!WEBHOOK_USER_ID) {
      console.error('❌ No tenant found for webhook');
      return res.status(500).send('No tenant');
    }

    // Fetch tenant settings (cached) + inventory in parallel.
    // Phase 7 — TENANT_NOTIFY_PHONE is no longer carried as a single phone
    // through the FSM. notifications fan out to all owner+manager members
    // via lib/notify.js using TENANT_ID resolved below. Dropped the
    // process.env.FORWARD_PHONE / OWNER_PHONE fallback that was leaking
    // every tenant's lead alerts to the platform operator's phone.
    let TENANT_FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
    let TENANT_DEALER_NAME  = process.env.DEALER_NAME  || 'First Financial Auto';
    // No city fallback: the env value is "Canada", so a tenant that left
    // City blank had Sarah announce "We're in Canada". Blank now means the
    // city is left out of the sentence.
    let TENANT_DEALER_CITY  = '';
    // Who reengage-mode callbacks are announced as. Blank is fine —
    // Sarah falls back to "our sales manager" rather than a stray name.
    let TENANT_SALES_NAME   = '';
    let TENANT_DELIVERY     = '';
    let TENANT_INVENTORY    = [];
    let TENANT_ID           = null;
    try {
      const [ts, invResult, tenantRow] = await Promise.all([
        getTenantSettings(WEBHOOK_USER_ID),
        pool.query(
          `SELECT year, make, model, mileage, price, type, condition, stock
             FROM desk_inventory
            WHERE status = 'available'
              AND (tenant_id = (SELECT tenant_id FROM desk_members
                                 WHERE user_id = $1 AND active = TRUE
                                 ORDER BY id ASC LIMIT 1)
                   OR (tenant_id IS NULL AND user_id = $1))
            ORDER BY year DESC LIMIT 20`,
          [WEBHOOK_USER_ID]
        ),
        pool.query(
          `SELECT m.tenant_id FROM desk_members m
            WHERE m.user_id = $1 AND m.active = TRUE
            ORDER BY m.id ASC LIMIT 1`,
          [WEBHOOK_USER_ID]
        ),
      ]);
      if (ts) {
        if (ts.twilioNumber) TENANT_FROM_NUMBER  = ts.twilioNumber;
        if (ts.dealerName)   TENANT_DEALER_NAME  = ts.dealerName;
        if (ts.dealerCity)   TENANT_DEALER_CITY  = ts.dealerCity;
        if (ts.salesName)    TENANT_SALES_NAME   = ts.salesName;
        TENANT_DELIVERY = ts.deliveryArea || '';
      }
      TENANT_INVENTORY = invResult.rows;
      TENANT_ID = tenantRow.rows[0]?.tenant_id || null;
    } catch(e) { console.error('⚠️ Tenant settings/inventory fetch failed:', e.message); }

    try {
      const { From: phone, Body: message } = req.body;
      console.log('📩 Received from:', phone);
      console.log('💬 Message:', message);

      // Respond to Twilio IMMEDIATELY (prevents retries/duplicates)
      res.type('text/xml').send('<Response></Response>');

      // Background processing
      (async () => {
        try {
          // ── Dedup: block if this MessageSid was already processed ──
          const msgSid = req.body.MessageSid || req.body.SmsSid || '';
          if (msgSid) {
            const sidKey = `twilio_sid_${msgSid}`;
            if (global._processedSids && global._processedSids.has(sidKey)) {
              console.log('[WEBHOOK] Duplicate MessageSid blocked:', msgSid);
              return;
            }
            if (!global._processedSids) global._processedSids = new Set();
            global._processedSids.add(sidKey);
            // Clean up after 5 minutes to prevent memory growth
            setTimeout(() => { if (global._processedSids) global._processedSids.delete(sidKey); }, 5 * 60 * 1000);
          }

          const _wd = String(phone).replace(/\D/g,'');
          const _nanp = (_wd.length===10&&_wd[0]>='2')||(_wd.length===11&&_wd.startsWith('1')&&_wd[1]>='2');
          if (!_nanp) { console.log('[WEBHOOK] Non-NANP blocked:', phone); return; }
          if (state.aiResponderPaused) { console.log('[WEBHOOK] AI paused, skipping', phone); return; }

          await getOrCreateCustomer(phone, WEBHOOK_USER_ID);

          // Phase 6: bump desk_crm.last_contact whenever the customer
          // texts in. Lets the 'Last Activity' column on the manager's
          // CRM dashboard reflect every inbound engagement, not just
          // explicit notes-panel saves. Fire-and-forget; CRM might not
          // have a row for this phone yet (the lead might come from
          // SMS-first not ADF-first), in which case the UPDATE is a
          // no-op. Match on the last 10 digits so format variance
          // (+1 prefix, dashes, etc.) doesn't miss the row.
          pool.query(
            `UPDATE desk_crm
             SET last_contact = NOW(), updated_at = NOW()
             WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10)
                 = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
               AND tenant_id IN (
                 SELECT tenant_id FROM desk_members WHERE user_id = $2 AND active = TRUE
               )`,
            [phone, WEBHOOK_USER_ID]
          ).catch((e) => console.warn('crm last_contact bump failed:', e.message));

          const lowerBody = message.toLowerCase().trim();
          const isStartCmd = lowerBody === 'start' || lowerBody.includes('resubscribe');
          const isStopCmd  = lowerBody === 'stop' || lowerBody.startsWith('stop') || lowerBody.includes('unsubscribe');

          const recentConvResult = await pool.query(
            'SELECT * FROM conversations WHERE customer_phone = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1',
            [phone, WEBHOOK_USER_ID]
          );
          const recentConv = recentConvResult.rows[0];

          if (recentConv && recentConv.status === 'stopped' && !isStartCmd && !isStopCmd) {
            await twilioClient.messages.create({
              body: "You're currently unsubscribed. Reply START to receive messages again.",
              from: TENANT_FROM_NUMBER,
              to: phone
            });
            return;
          }

          const conversation = await getOrCreateConversation(phone, WEBHOOK_USER_ID);
          // Set source if new conversation (source will be null on first message)
          if (!conversation.source) {
            await pool.query('UPDATE conversations SET source = $1 WHERE id = $2', ['inbound', conversation.id]).catch(() => {});
          }

          // Mark conversation as 'engaged' on first customer reply (was 'active' = outreach sent, no reply yet)
          if (conversation.status === 'active' && !isStopCmd && !isStartCmd) {
            await updateConversation(conversation.id, { status: 'engaged' });
            conversation.status = 'engaged';
          }

          await saveMessage(conversation.id, phone, 'user', message, WEBHOOK_USER_ID);
          try { await logAnalytics('message_received', phone, { message }, WEBHOOK_USER_ID); } catch(e) { console.error('Analytics error:', e.message); }

          // An inbound with no text is not an answer. Tapback reactions, a
          // bare MMS attachment and some carrier receipts all arrive with an
          // empty Body, and every FSM here ends in a catch-all that treats
          // whatever it got as a reply — so an empty one silently advanced
          // the stage. Caught live on the first reengage pilot: Gabriel's
          // empty inbound moved him to the time step, so his NEXT message
          // was read as the callback time. Record it, answer nothing.
          if (!message || !String(message).trim()) {
            console.log('📭 Empty inbound body from', phone, '— logged, no FSM, no reply');
            return;
          }

          // A human has this thread. Once someone has typed a reply by hand,
          // no script starts again on it — not reengage, not acquisition, and
          // above all not the sales FSM, which is where an unrecognised mode
          // lands and which opens a full discovery script.
          //
          // The message still reaches a person: it is saved above and the
          // manager gets it verbatim here. Staying silent is the point — a
          // canned acknowledgement on top of a live human conversation is the
          // same two-voices problem, just politer.
          //
          // STOP and START are the exception and always pass through. Every
          // addOptOut call lives inside the FSM, so a guard that swallowed
          // them would leave a customer who texted STOP still subscribed —
          // a CASL breach, and one nobody would notice until it mattered.
          // Silence is for conversation, never for a legal instruction.
          if (conversation.handoff_at && !isStopCmd && !isStartCmd) {
            console.log('🙋 Handoff thread for', phone, '— human has it, no FSM, no reply');
            try {
              await notifyTenantManagers({
                tenantId: TENANT_ID, fromNumber: TENANT_FROM_NUMBER, twilioClient,
                body: `${formatPretty(phone)} replied:\n"${String(message).trim().slice(0, 300)}"\n\nYou have this conversation — Sarah did not answer.`,
              });
            } catch (e) { console.error('Handoff notify failed:', e.message); }
            return;
          }

          const aiResponse = await getJerryResponse(phone, message, conversation, WEBHOOK_USER_ID, TENANT_FROM_NUMBER, TENANT_ID, TENANT_DEALER_NAME, TENANT_DEALER_CITY, TENANT_INVENTORY, TENANT_DELIVERY, TENANT_SALES_NAME);

          // An FSM can decline to answer by returning nothing. Used when a
          // customer is mid-burst: they have sent a fragment and the rest of
          // the thought is still coming, so replying to the fragment is how
          // Irene's "It's all / Mine lol" got booked as her callback time
          // while "He can call anytime" arrived a beat later. Staying quiet
          // for one message lets the real answer land.
          if (!aiResponse || !String(aiResponse).trim()) {
            console.log('🤐 Holding for', phone, '— no reply sent, waiting for the rest');
            return;
          }
          await saveMessage(conversation.id, phone, 'assistant', aiResponse, WEBHOOK_USER_ID);

          try {
            const sarahSend = await guardedSmsSend(twilioClient, WEBHOOK_USER_ID, {
              body: aiResponse, from: TENANT_FROM_NUMBER, to: phone
            });
            if (sarahSend.ok) {
              console.log('✅ Sarah replied:', aiResponse);
              // Phase 6: bump CRM last_contact when Sarah successfully replies.
              // Together with the inbound bump above, this gives the manager's
              // 'Last Activity' column a true picture of engagement over time.
              pool.query(
                `UPDATE desk_crm
                 SET last_contact = NOW(), updated_at = NOW()
                 WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10)
                     = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
                   AND tenant_id IN (
                     SELECT tenant_id FROM desk_members WHERE user_id = $2 AND active = TRUE
                   )`,
                [phone, WEBHOOK_USER_ID]
              ).catch((e) => console.warn('crm last_contact bump (sarah reply) failed:', e.message));
            } else if (sarahSend.reason === 'SPEND_CAP_EXCEEDED') {
              console.warn(`⚠️ SARAH reply BLOCKED by spend cap for user ${WEBHOOK_USER_ID} → ${phone}`);
              // Before this, the block only reached analytics: customer got
              // no answer and nobody was told. Alerts bypass the cap.
              if (TENANT_ID && shouldAlertCapBlock(TENANT_ID, phone)) {
                const said = message.length > 100 ? message.substring(0, 100) + '...' : message;
                notifyTenantManagers({
                  tenantId: TENANT_ID, fromNumber: TENANT_FROM_NUMBER, twilioClient,
                  body: `⚠️ Sarah did NOT reply — ${TENANT_DEALER_NAME} is out of its monthly texting allowance.\n📞 ${formatPretty(phone)}\n"${said}"\n\nText or call them yourself.`,
                }).catch(e => console.error('❌ cap-block alert failed:', e.message));
              }
              try {
                await logAnalytics('sms_cap_blocked', phone, {
                  usage: sarahSend.usage, need_cents: sarahSend.needCents,
                  attempted_message: aiResponse.substring(0, 100)
                }, WEBHOOK_USER_ID);
              } catch(e) {}
            } else {
              const err = sarahSend.error || {};
              console.error(`❌ Sarah send FAILED to ${phone} — Code: ${err.code} Status: ${err.status} Msg: ${err.message}`);
              try {
                await logAnalytics('sms_send_failed', phone, {
                  error_code: err.code, error_message: err.message,
                  attempted_message: aiResponse.substring(0, 100)
                }, WEBHOOK_USER_ID);
              } catch(e) {}
            }
          } catch (outerErr) {
            console.error(`❌ Sarah outer send error to ${phone}:`, outerErr.message);
          }

          const custName  = conversation.customer_name || 'Unknown';
          const custPhone = formatPretty(phone);
          const preview   = message.length > 100 ? message.substring(0, 100) + '...' : message;
          // Only notify dealer on first contact (new lead) — stage-change events
          // (appt booked, callback) send their own dedicated alerts already.
          // Notifying on every reply is too noisy for active conversations.
          const isFirstContact = conversation.stage === 'greeting' ||
            (await pool.query(
              'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = $1',
              [conversation.id]
            )).rows[0]?.cnt <= 2;
          if (isFirstContact && TENANT_ID) {
            // Fan out the new-lead alert to every owner+manager in the
            // tenant. Falls back to legacy settings.notifyPhone (the owner)
            // if no member has a per-user phone yet. Never falls back to
            // env vars — see lib/notify.js for the safety reasoning.
            notifyTenantManagers({
              tenantId: TENANT_ID,
              fromNumber: TENANT_FROM_NUMBER,
              body: `💬 New lead from ${custName}\n📞 ${custPhone}\n\n"${preview}"\n\nReply via: app.firstfinancialcanada.com`,
              twilioClient,
            }).then(r => {
              if (r.sent > 0) console.log(`✅ New lead notify: ${r.sent}/${r.targetCount} delivered`);
              else if (r.reason === 'no_targets') console.warn(`⚠️ Tenant ${TENANT_ID} has no notify_phone configured — alert skipped`);
            }).catch(err => console.error('❌ Notify fan-out error:', err.message));
          }

        } catch (bgError) {
          console.error('❌ Background processing error:', bgError);
        }
      })();

    } catch (error) {
      console.error('❌ Webhook error:', error);
      res.type('text/xml').send('<Response></Response>');
    }
  });

  // ── Sarah / Jerry AI Logic ────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────
  // ACQUISITION MODE — Sarah is reaching out to a prospective seller
  // (Kijiji private listing, etc.) instead of a buyer. Mirrors the design
  // of getJerryResponse (rule-based FSM, no LLM, on-rails by design) but
  // with stages tuned for "buy a car FROM the customer" instead of "sell
  // a car TO the customer". Both flows always land on appointment OR
  // callback per Franco's universal rule.
  //
  // Stages (conversation.stage values used in acquisition mode):
  //   acq_confirm        — opener replied to; confirm vehicle + intent
  //   acq_mileage        — capture km/mi
  //   acq_condition      — accidents, mods, owners, overall shape
  //   acq_asking_price   — what they want for it
  //   acq_replacement    — Mil's pivot: are they also looking to buy?
  //   acq_appointment    — appraisal vs callback choice
  //   name / datetime / confirmed — shared with sales mode
  // ────────────────────────────────────────────────────────────────────
  // "We're in Calgary, AB — and we deliver all across Canada!" Built from
  // the tenant's own City and Delivery Area settings; either can be blank,
  // and with both blank it's an empty string rather than a guess.
  function whereWeAre(city, delivery) {
    if (city && delivery) return `We're in ${city} — and we deliver ${delivery}!`;
    if (city)             return `We're in ${city}.`;
    if (delivery)         return `We deliver ${delivery}!`;
    return '';
  }

  async function getAcquisitionResponse(phone, message, conversation, userId, fromNumber, tenantId, dealerName = 'the dealership', dealerCity = '', deliveryArea = '') {
    const lowerMsg = message.toLowerCase().trim();
    const name = conversation.customer_name || '';
    function pick(...opts) { return opts[Math.floor(Math.random() * opts.length)]; }

    // ── MID-FLOW MODE PIVOT (Phase 7+ dynamicity) ────────────────────
    // If a seller-side customer drops a clear "looking to buy a truck"
    // signal at ANY stage of the acquisition FSM, flip into sales mode
    // and route through the buy-side greeting. Mirrors the sales-side
    // pivot so customers can change direction without restarting.
    const wrongDir = detectWrongDirection(lowerMsg, 'acquisition');
    if (wrongDir === 'sales' && conversation.stage !== 'confirmed') {
      const detectedType = detectVehicleType(lowerMsg);
      const updates = { mode: 'sales', stage: detectedType ? 'discovery' : 'greeting' };
      if (detectedType && detectedType !== 'Vehicle') updates.vehicle_type = detectedType;
      await updateConversation(conversation.id, updates);
      // Lands in discovery, not budget — a customer who just changed
      // direction is the last one to open with a payment question.
      return detectedType && detectedType !== 'Vehicle'
        ? `Switching gears — looking for a ${detectedType.toLowerCase()}, got it. Any particular make or model in mind?`
        : "Got it — switching to buy-side. Are you looking for a Car, Truck, Van, or SUV?";
    }

    // ── Universal handlers (mirror sales mode) ─────────────────────
    // STOP / unsubscribe
    if (lowerMsg === 'stop' || /^stop[^a-z]/i.test(message.trim()) ||
        lowerMsg.includes('unsubscribe') || lowerMsg.includes('opt out') || lowerMsg.includes('opt-out')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await addOptOut(phone, 'sms_stop');
      await logAnalytics('conversation_stopped', phone, { mode: 'acquisition' }, userId);
      return "You've been unsubscribed and won't receive further messages. Reply START anytime to resume.";
    }
    if (lowerMsg === 'start' || lowerMsg.includes('resubscribe') || lowerMsg.includes('opt in')) {
      await updateConversation(conversation.id, { status: 'active', stage: 'acq_confirm' });
      await removeOptOut(phone);
      return `Welcome back! I'm Sarah from ${dealerName}. Are you still considering selling your vehicle?`;
    }
    if (conversation.status === 'stopped') return "You're currently unsubscribed. Reply START to receive messages again.";

    // "Already sold it" / "already in the works with someone" — graceful exit + door open
    if (lowerMsg.includes('already sold') || lowerMsg.includes('sold it') ||
        lowerMsg.includes('already gone') || lowerMsg.includes('found a buyer') ||
        lowerMsg.includes('not selling anymore') || lowerMsg.includes("don't want to sell")) {
      await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
      if (!name) {
        return pick(
          "All good — congrats on the sale! 🎉 If you ever have another vehicle to sell or are looking to buy something next, we'd love the chance. What's your name? I'll keep you on file.",
          "Got it — congrats! 🎉 If something else comes up down the road, just text me. What's your name?"
        );
      }
      return `Congrats ${name}! 🎉 If something else comes up — selling, trading, or buying — we'd love the chance. Want a quick call from our team to introduce themselves?`;
    }

    // Hard "not interested" — same handling as sales mode.
    // CRITICAL: do NOT match bare "no" / "nah" / "nope" here. Customers
    // legitimately answer "no" to binary stage questions ("looking to
    // replace it?" → "no" means no replacement, not opt-out). Bug caught
    // 2026-05-08 by Franco when his test reply "No" at acq_replacement
    // got interpreted as universal opt-out and stopped the conversation.
    if (lowerMsg.includes('not interested') || lowerMsg.includes('no thanks') || lowerMsg.includes('no thank you') ||
        lowerMsg.includes('wrong number') || lowerMsg.includes('leave me alone') || lowerMsg.includes('remove me') ||
        lowerMsg.includes('do not contact') || lowerMsg.includes('go away') ||
        lowerMsg.includes("don't text") || lowerMsg.includes('stop texting') || lowerMsg.includes('please stop')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await logAnalytics('conversation_stopped', phone, { reason: 'not_interested', mode: 'acquisition' }, userId);
      return "No worries! I've taken you off our list. If anything changes — selling, buying, or trading — just text back anytime.";
    }

    // ── STAGE: acq_confirm — opener replied to ─────────────────────
    // Default initial stage for acquisition; "Yes" / "I am" / "sure"
    // affirms; numbers in this stage we treat as mileage (skip ahead).
    if (!conversation.stage || conversation.stage === 'greeting' || conversation.stage === 'acq_confirm') {
      // Negative — they said no / not really / not sure
      if (lowerMsg === 'no' || lowerMsg === 'nah' || lowerMsg === 'nope' ||
          lowerMsg.includes('not really') || lowerMsg.includes('not sure') ||
          lowerMsg.includes('maybe later') || lowerMsg.includes('thinking about')) {
        await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
        if (!name) return "No worries! If you ever decide to, we'd love the chance to give you a fair offer — and we can also help if you're looking for something next. What's your name? I'll have someone follow up later.";
        return `${name}, no rush! When you're ready, we'd love the chance — and if you're also looking for something next, we can line that up too. Want a quick call now or later?`;
      }
      // Try to extract year/make/model from any positive response — capture
      // for the closer's screen even if the customer keeps it short.
      const extracted = extractVehicleFromText(message);
      // Positive confirm — yes, sure, considering, looking to sell, plus
      // expanded forms ("yeah", "sure am", "definitely", "absolutely",
      // "for sure", "i'd be open").
      const positiveCues = [
        'yes','yep','yeah','sure','i am','sure am','considering','thinking of','looking to sell',
        'want to sell','wanna sell','would sell','open to','open to it','open to selling',
        "i'd be open",'definitely','absolutely','for sure','let me know','tell me more','interested',
      ];
      if (positiveCues.some(p => lowerMsg === p || lowerMsg.includes(p)) ||
          extracted.year || extracted.make || extracted.model) {
        const updates = { stage: 'acq_mileage' };
        if (extracted.year)  updates.vehicle_year  = extracted.year;
        if (extracted.make)  updates.vehicle_make  = extracted.make;
        if (extracted.model) updates.vehicle_model = extracted.model;
        await updateConversation(conversation.id, updates);
        const vSummary = [extracted.year, extracted.make, extracted.model].filter(Boolean).join(' ');
        if (vSummary) {
          return `Great — ${vSummary}, got it. What's the current mileage on it? (km or miles, whichever you've got)`;
        }
        return pick(
          "Great! What's the current mileage on it? (km or miles is fine)",
          "Awesome — to get you a real offer I'll need a couple quick details. What's the mileage?"
        );
      }
      // Number alone — treat as mileage via the tighter parser so "150" alone
      // doesn't silently become 150k.
      const acqMileage = parseMileage(message);
      if (acqMileage != null && acqMileage >= 1000) {
        await updateConversation(conversation.id, { vehicle_mileage: acqMileage, stage: 'acq_condition' });
        return `Got it — ${acqMileage.toLocaleString()} km. How's the condition? Any accidents, major repairs, or modifications I should know about?`;
      }
      // Default — re-confirm
      return pick(
        "Just to confirm — are you still considering selling your vehicle? A simple yes or no is fine.",
        "Sorry if I caught you at a weird time — are you open to selling? Yes or no, no pressure either way."
      );
    }

    // ── STAGE: acq_mileage ─────────────────────────────────────────
    if (conversation.stage === 'acq_mileage' && !conversation.vehicle_mileage) {
      const n = parseMileage(message);
      if (n != null) {
        await updateConversation(conversation.id, { vehicle_mileage: n, stage: 'acq_condition' });
        return pick(
          `Got it — ${n.toLocaleString()} km. How's the overall condition? Any accidents, repairs, or modifications worth mentioning?`,
          `${n.toLocaleString()} km, noted. What's the condition like? Accidents, mods, or anything I should flag?`
        );
      }
      // Ambiguous — clarify rather than silently picking the wrong interpretation.
      // Common case: "150" alone — could be 150 km exact (rare) or 150K km. Ask.
      const rawNum = message.match(/\d[\d,]*/);
      if (rawNum) {
        const small = parseInt(rawNum[0].replace(/,/g, ''), 10);
        if (small > 0 && small < 100) {
          return `Just to confirm — ${small} thousand km, or ${small} km exact? Either way's fine, just want to be precise for the appraisal.`;
        }
      }
      // Fail-forward: customer didn't give a parseable number. Don't loop —
      // capture nothing, advance to condition. The closer gets exact mileage
      // at the appraisal/callback. Per Franco: extract once, then move on.
      await updateConversation(conversation.id, { stage: 'acq_condition' });
      return pick(
        "All good — we can confirm the exact mileage when our buyer follows up. How's the overall condition? Any accidents, repairs, or mods worth mentioning?",
        "No worries, we'll lock that in later. What's the condition like — accidents, mods, or anything to flag?"
      );
    }

    // ── STAGE: acq_condition ───────────────────────────────────────
    if (conversation.stage === 'acq_condition' && !conversation.vehicle_condition) {
      // Categorize roughly so the closer has a snapshot
      let cond = null;
      if (lowerMsg.includes('mint') || lowerMsg.includes('excellent') || lowerMsg.includes('like new') ||
          lowerMsg.includes('immaculate') || lowerMsg.includes('perfect')) cond = 'Excellent';
      else if (lowerMsg.includes('good') || lowerMsg.includes('clean') || lowerMsg.includes('great shape') ||
          lowerMsg.includes('well maintained') || lowerMsg === 'no accidents' || lowerMsg.includes('no accidents')) cond = 'Good';
      else if (lowerMsg.includes('fair') || lowerMsg.includes('decent') || lowerMsg.includes('average') ||
          lowerMsg.includes('minor') || lowerMsg.includes('small dent') || lowerMsg.includes('scratch')) cond = 'Fair';
      else if (lowerMsg.includes('rough') || lowerMsg.includes('accident') || lowerMsg.includes('damage') ||
          lowerMsg.includes('rebuilt') || lowerMsg.includes('salvage') || lowerMsg.includes('mechanical')) cond = 'Needs Work';
      else cond = message.slice(0, 50); // Free-text capture if unclassifiable
      await updateConversation(conversation.id, { vehicle_condition: cond, stage: 'acq_asking_price' });
      return pick(
        "Thanks. What are you hoping to get for it?",
        "Got it. What number are you hoping to sell it for?",
        "Noted. Ballpark — what would you want for it?"
      );
    }

    // ── STAGE: acq_asking_price ────────────────────────────────────
    if (conversation.stage === 'acq_asking_price' && !conversation.asking_price) {
      const n = parseDollarAmount(message);
      if (n != null && n >= 500) {
        await updateConversation(conversation.id, { asking_price: n, stage: 'acq_replacement' });
        return pick(
          `$${n.toLocaleString()} — got it. Quick question while we're at it: are you also looking for something next? Trade-ins often make the math work better.`,
          `Noted — $${n.toLocaleString()}. One more thing: are you considering buying something next? We can line both up together.`
        );
      }
      // Customer said "not sure" or "what's it worth" — they want our opinion
      if (lowerMsg.includes('not sure') || lowerMsg.includes("don't know") || lowerMsg.includes("what's it worth") ||
          lowerMsg.includes('what would you offer') || lowerMsg.includes('open to offers') || lowerMsg.includes('best offer')) {
        await updateConversation(conversation.id, { asking_price: 0, stage: 'acq_replacement' });
        return pick(
          "All good — our buyer can put a real number on it when they look. Quick question: are you also looking for something next? Trade-ins often make the math work better.",
          "No problem — we'll give you a fair number when our buyer follows up. While we're here, considering something next? We can line both up."
        );
      }
      // Fail-forward: no price extracted, treat as "open to offers" and
      // advance. Don't loop on price — the closer prices it later.
      await updateConversation(conversation.id, { asking_price: 0, stage: 'acq_replacement' });
      return pick(
        "All good — our buyer can put a real number on it when they look. Quick question: are you also looking for something next? Trade-ins often make the math work better.",
        "No worries — we'll give you a fair number when we connect. While we're here, considering something next as well? Easy to line both up."
      );
    }

    // ── STAGE: acq_replacement — the Mil pivot ─────────────────────
    if (conversation.stage === 'acq_replacement' && conversation.replacement_interest == null) {
      // Broader positive signals — capture "just sell" and "considering"
      // patterns that previously fell to the loop fallback.
      const replYes = ['yes','yep','sure','maybe','possibly','probably',"i'd be open",'open to it'];
      if (replYes.some(p => lowerMsg === p) ||
          lowerMsg.includes('looking') || lowerMsg.includes('interested') || lowerMsg.includes('thinking about') ||
          lowerMsg.includes('would like') || lowerMsg.includes('want to') || lowerMsg.includes('shopping') ||
          lowerMsg.includes('in the market')) {
        await updateConversation(conversation.id, { replacement_interest: true, stage: 'acq_appointment' });
        return pick(
          "Perfect — that's how most of our deals work. Phone call first to talk numbers, or come in for the appraisal and check out options at the same time? Either works.",
          "Awesome, we'll put both together. Quick call to line it up, or come in for the appraisal + a look around? Up to you."
        );
      }
      // Broader negative / "just selling" signals — added "just sell",
      // "selling only", "not buying", "no replacement" so the matcher
      // catches the language Franco hit during the live test.
      if (lowerMsg === 'no' || lowerMsg === 'nope' || lowerMsg === 'nah' ||
          lowerMsg.includes('not looking') || lowerMsg.includes("don't need") ||
          lowerMsg.includes('just sell') || lowerMsg.includes('selling only') ||
          lowerMsg.includes('only selling') || lowerMsg.includes('not buying') ||
          lowerMsg.includes('no replacement') || lowerMsg.includes('not interested in buying')) {
        await updateConversation(conversation.id, { replacement_interest: false, stage: 'acq_appointment' });
        return pick(
          "All good — selling only. Quick call from our buyer to talk numbers, or come in for the appraisal? Whichever's easier for you.",
          "Got it. Phone or in-person — both get you a real offer. What works better?"
        );
      }
      // Customer named a vehicle type / make in the response
      const replWords = ['truck','suv','car','sedan','van','minivan','jeep','ram','ford','chevy','toyota','honda'];
      if (replWords.some(w => lowerMsg.includes(w))) {
        await updateConversation(conversation.id, { replacement_interest: true, stage: 'acq_appointment' });
        return "Nice — we'll have options ready. Quick call to line it up, or come in for the appraisal and a look around? Either's fine.";
      }
      // Fail-forward: can't tell from this reply. Don't loop a yes/no at a
      // hot lead — they've already given mileage + condition + price. Hand
      // off to the closer, who'll clarify replacement intent in person or
      // on the call. Stage advances; replacement_interest stays null so the
      // closer knows it wasn't captured (vs. an explicit "no").
      await updateConversation(conversation.id, { stage: 'acq_appointment' });
      return pick(
        "Got it — we'll sort that out together. Quick call to talk numbers, or come in for the appraisal? Either works on our end.",
        "All good — let's get you in front of our buyer. Phone or in-person, both get you a real offer. Which works better?"
      );
    }

    // ── STAGE: acq_appointment — book or callback ─────────────────
    if (conversation.stage === 'acq_appointment' && !conversation.intent) {
      if (lowerMsg.includes('come') || lowerMsg.includes('visit') || lowerMsg.includes('appraisal') ||
          lowerMsg.includes('in person') || lowerMsg.includes('drop by') || lowerMsg.includes('show') ||
          lowerMsg.includes('book') || lowerMsg.includes('appointment')) {
        await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when works best to come in? We're flexible — mornings, afternoons, evenings, weekends.`
          : "Sounds great! What's your name so I can get the appraisal lined up?";
      }
      if (lowerMsg.includes('call') || lowerMsg.includes('phone') || lowerMsg.includes('talk') ||
          lowerMsg.includes('reach') || lowerMsg.includes('contact') || lowerMsg.includes('ring')) {
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when's the best time for our buyer to give you a call?`
          : "Got it — what's your name? I'll have our buyer reach out.";
      }
      if (lowerMsg.includes('maybe') || lowerMsg.includes('not sure') || lowerMsg.includes('think') || lowerMsg.includes('busy')) {
        // Fail-forward: don't loop on hedging. Default to callback (less
        // pushy than an in-person ask), advance toward name/datetime, let
        // the closer pace from there.
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        return name
          ? `No rush ${name} — I'll have our buyer give you a quick call. What time of day usually works best?`
          : "No rush — I'll have our buyer reach out. What's your name and when's a good time for a quick call?";
      }
      // Default — assume callback so we always advance
      await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
      return name
        ? `${name}, I'll have our buyer give you a call. When's the best time?`
        : "What's your name? I'll have our buyer reach out and line everything up.";
    }

    // ── STAGE: name ────────────────────────────────────────────────
    if (conversation.stage === 'name' && !name) {
      let parsedName = message.trim();
      if (lowerMsg.includes('my name is')) parsedName = message.split(/my name is/i)[1].trim();
      else if (lowerMsg.includes("i'm")) parsedName = message.split(/i'm/i)[1].trim();
      else if (lowerMsg.includes("i am")) parsedName = message.split(/i am/i)[1].trim();
      else if (lowerMsg.includes("call me")) parsedName = message.split(/call me/i)[1].trim();
      parsedName = parsedName.replace(/[^a-zA-Z\s'-]/g, '').trim().substring(0, 100);
      const parts = parsedName.split(/\s+/).slice(0, 2);
      parsedName = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      if (!parsedName || parsedName.length < 2) return "Sorry, didn't catch that — what's your first name?";
      await updateConversation(conversation.id, { customer_name: parsedName, stage: 'datetime' });
      await pool.query('UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2', [parsedName, phone]);
      if (conversation.intent === 'test_drive') {
        return `Hey ${parsedName}! When works best to come by for the appraisal? Mornings, afternoons, or evenings — and weekends are open too.`;
      }
      return `Hey ${parsedName}! When's the best time for our buyer to give you a quick call?`;
    }

    // ── STAGE: datetime — handled by the shared logic in getJerryResponse
    // Reuse: re-enter the sales-mode getJerryResponse from datetime onward
    // since the datetime → confirmed path is identical regardless of mode.
    if (conversation.stage === 'datetime' || conversation.stage === 'confirmed') {
      // Hand off to the buy-side function for datetime parsing + confirmation
      // (it doesn't read mode-specific fields past this point).
      return await getJerryResponse(phone, message, conversation, userId, fromNumber, tenantId, dealerName, dealerCity, [], deliveryArea);
    }

    // ── Fallback: fail-forward to a human ──────────────────────────
    // Stage is in some unexpected state. Don't re-prompt — get them to a
    // closer. Default to callback (less pushy than an in-person ask) and
    // let our buyer untangle whatever's happening over the phone.
    await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
    return name
      ? `${name}, let me have our buyer give you a quick call to sort everything out — what time of day works best?`
      : "Let me have our buyer give you a quick call to sort everything out. What's your name and a good time to reach you?";
  }

  // ── REENGAGE MODE (Phase 8) ──────────────────────────────────────
  // A third FSM, for waking up aged leads. Deliberately far smaller than
  // sales and acquisition: the only question it asks is whether they're
  // still looking, and the only thing it books is a callback. It never
  // quotes a price, discusses trim or financing, or offers to book them
  // in — these are people who already didn't buy once, so the ask has to
  // be smaller than the one they walked away from.
  //
  // It also gives "I already bought something" somewhere to land. In
  // sales mode that answer falls through to a pitch; here it closes the
  // lead cleanly, which is half the reason to run a list like this at
  // all. Note it closes the STAGE, not the status — they didn't withdraw
  // consent, they just aren't buying today, and marking them 'stopped'
  // would wrongly block legitimate contact later.
  async function getReengageResponse(phone, message, conversation, userId, fromNumber, tenantId, dealerName = 'the dealership', managerName = '') {
    const lowerMsg = message.toLowerCase().trim();
    const name  = conversation.customer_name || '';
    const first = name ? name.split(' ')[0] : '';
    function pick(...opts) { return opts[Math.floor(Math.random() * opts.length)]; }

    // Settings store the name however the dealer typed it ("FRANCO"), and
    // Sarah is not shouting it at a customer. First name, title case.
    const _raw = String(managerName || '').trim().split(/\s+/)[0] || '';
    const _mgrFirst = _raw ? _raw.charAt(0).toUpperCase() + _raw.slice(1).toLowerCase() : '';
    const mgr = _mgrFirst ? `our sales manager ${_mgrFirst}` : 'our sales manager';
    const Mgr = _mgrFirst ? `Our sales manager ${_mgrFirst}` : 'Our sales manager';

    // ── STOP / START ───────────────────────────────────────────────
    if (lowerMsg === 'stop' || /^stop[^a-z]/i.test(message.trim()) ||
        lowerMsg.includes('unsubscribe') || lowerMsg.includes('opt out') || lowerMsg.includes('opt-out')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await addOptOut(phone, 'sms_stop');
      await logAnalytics('conversation_stopped', phone, { mode: 'reengage' }, userId);
      return "You've been unsubscribed and won't receive further messages. Reply START anytime to resume.";
    }
    if (lowerMsg === 'start' || lowerMsg.includes('resubscribe') || lowerMsg.includes('opt in')) {
      await updateConversation(conversation.id, { status: 'active', stage: 'reengage_confirm' });
      await removeOptOut(phone);
      // Deliberately doesn't name the store. A reengage campaign is often
      // run under a different banner than the account's own dealerName
      // (Franco's account is "Rolling with Franco" but the House of Cars
      // list goes out as House of Cars), and a mismatch here reads as a
      // different company texting you.
      return 'Welcome back! Sarah here. Are you still looking for a vehicle?';
    }
    if (conversation.status === 'stopped') return "You're currently unsubscribed. Reply START to receive messages again.";

    // ── One decline vocabulary for the whole funnel ────────────────
    // This used to be written out twice, at the opening question and at the
    // time step, and the two lists drifted. "Not at the moment" was a decline
    // at one and a callback time at the other, so the same words from the same
    // person meant opposite things depending only on whether a stray message
    // had nudged them a stage forward. Dale said exactly that on batch 2 and
    // was handled correctly only by luck of timing. Declared once so they
    // cannot disagree again.
    const DECLINE_RE = /\b(definitely not|absolutely not|certainly not|not interested|no thanks|no thank you|never ?mind|nvm|forget it|changed my mind|not anymore|not any more|not at the moment|not right now|not now|not today|for the time being|for now|don'?t call|do not call|don'?t bother|no need|i'?m good|all good|don'?t worry|no time|too busy|maybe later|some other time)\b/i;
    const BARE_NO_RE = /^(n|no|nope|nah|naw|not)\b/i;

    // One line on the alert, so the desk knows before it dials that this is
    // a credit conversation and not a shopping one. Their own words, and not
    // repeated if the detail line already carries them.
    function creditLine(conv) {
      if (!conv || !conv.credit_flag) return '';
      const note = String(conv.credit_note || '').trim();
      const detail = String(conv.vehicle_detail || '');
      if (!note || detail.includes(note)) return `\nCREDIT CASE.`;
      return `\nCREDIT: "${note.slice(0, 160)}"`;
    }

    // Hard "leave me alone". Kept separate from the plain "no" handled at
    // reengage_confirm below — on this list a bare "no" is an answer to
    // the question we asked, not a request to be removed. Conflating the
    // two is the 2026-05-08 acquisition bug all over again.
    // "Please lose my number" was not in this list, and the yes-branch below
    // matched the "Yes" that opened the sentence — so Ryan, who wrote "Yes I
    // am but will not be dealing with anyone at house of cars. Please lose my
    // number", was answered "Good to hear. Our sales manager Franco will call
    // you back." A removal request has to be read before anything else in the
    // message, because people put it at the END of a sentence that starts
    // some other way. Checked first, and the vocabulary now covers the
    // ordinary ways of saying it.
    if (lowerMsg.includes('not interested') || lowerMsg.includes('wrong number') ||
        lowerMsg.includes('leave me alone') || lowerMsg.includes('remove me') ||
        lowerMsg.includes('do not contact') || lowerMsg.includes("don't text") ||
        lowerMsg.includes('stop texting') || lowerMsg.includes('please stop') ||
        lowerMsg.includes('take me off') ||
        lowerMsg.includes('lose my number') || lowerMsg.includes('lose this number') ||
        lowerMsg.includes('delete my number') || lowerMsg.includes('remove my number') ||
        lowerMsg.includes('remove this number') || lowerMsg.includes('forget my number') ||
        // Enumerating the phrasings kept losing. Kyle wrote "can you get rid
        // of my number please I don't like being bugged every month about a
        // car when I've already bought on[e]" and, because "get rid of" was
        // not on the list, it fell through to the purchase branch on the word
        // "bought" and Sarah answered "Congrats Kyle!". Match the SHAPE of the
        // ask -- a removal verb within a few words of "my/this number" --
        // instead of guessing which verb they will use.
        /\b(get(ting)? rid of|getting rid of|rid of|lose|loose|delete|remove|erase|scrub|forget|drop|ditch|take off)\b[^.!?]{0,24}?\b(my|this|the)\s+(number|phone|cell|contact|info)\b/i.test(message) ||
        // "take my number off" splits the verb around the noun, so the
        // pattern above walks straight past it.
        /\btake\s+(my|this|the)\s+(number|phone|cell|contact|info)\s+(off|out)\b/i.test(message) ||
        lowerMsg.includes("don't contact") || lowerMsg.includes('never contact') ||
        lowerMsg.includes("don't call me again") || lowerMsg.includes('do not call me again') ||
        lowerMsg.includes('unsubscribe')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      // addOptOut as well as the conversation status. Only the STOP branch
      // was writing the opt-out table, so someone who asked in words rather
      // than by the keyword — "not interested", "lose my number" — was marked
      // stopped on this conversation but left textable by the next campaign,
      // because the bulk sender screens against isOptedOut(). Asking politely
      // has to work as well as sending the magic word.
      await addOptOut(phone, 'asked_to_be_removed');
      await logAnalytics('conversation_stopped', phone, { reason: 'asked_to_be_removed', mode: 'reengage', reply: message.slice(0, 200) }, userId);
      return "No problem — I've taken you off the list. All the best.";
    }

    // ── Credit flag ────────────────────────────────────────────────
    // Checked on every inbound, not only on the yes, because people
    // volunteer it wherever it lands: at the opening question, in the middle
    // of giving a callback time, or in a reply days after the lead closed.
    // Runs AFTER the removal and STOP branches above, so someone asking to
    // be left alone is never added to a call list.
    //
    // Sarah's words do not change because of this. She does not raise
    // credit, financing or debt with a customer, ever -- the flag is for the
    // desk, which decides what to offer on the phone.
    if (CREDIT_RE.test(message)) {
      const quote = message.trim().replace(/\s+/g, ' ').slice(0, 240);
      if (!conversation.credit_flag) {
        await updateConversation(conversation.id, { credit_flag: true, credit_note: quote.slice(0, 250) });
        await logAnalytics('reengage_credit_flag', phone, { stage: conversation.stage, reply: quote }, userId);
        conversation.credit_flag = true;
        conversation.credit_note = quote;
      }
    }

    // ── STAGE: reengage_time — they said yes, we asked when ────────
    // Their words go through verbatim. Sarah isn't parsing "Tuesday
    // afternoon" into a timestamp and risking getting it wrong; the
    // manager reads what the customer actually wrote.
    //
    // reengage_held_y / reengage_held_q are the same step one beat later:
    // the customer sent a fragment, Sarah said nothing, and this is the
    // message she waited for. Same decline vocabulary, same booking, but
    // no second hold — the wait is bounded to exactly one message so
    // nobody is left in silence.
    const atTime = conversation.stage === 'reengage_time' || conversation.stage === 'reengage_time_q';
    const atHeld = conversation.stage === 'reengage_held_y' || conversation.stage === 'reengage_held_q';
    if (atTime || atHeld) {
      // A withdrawal here is not a time. Without this, a refusal becomes a
      // callback booked for the words of the refusal and the manager rings
      // someone who just said no. Closes instead — still no second question.
      //
      // Anchoring this at ^ was the bug: Radi answered "Definitely not" on
      // the live pilot and it sailed past, because the refusal didn't start
      // with "no". A negative anywhere in a reply to "what time works?" is a
      // negative — people don't decline by leading with the word every time.
      // One vocabulary, not two. This list and the one at reengage_confirm
      // below had drifted apart: "not at the moment" was recognised as a
      // decline at the opening question but not here, so the same words from
      // the same person meant "no" or meant "call me Thursday" depending only
      // on whether a stray message had nudged them a stage forward. Dale said
      // exactly that on batch 2 and was only handled right by luck of timing.
      if (DECLINE_RE.test(message) || BARE_NO_RE.test(message.trim())) {
        await updateConversation(conversation.id, { stage: 'reengage_closed' });
        await logAnalytics('reengage_not_looking', phone, { reason: 'withdrew_at_time', reply: message.slice(0, 200) }, userId);
        return "No problem at all, thanks for letting me know. If anything changes, I'm here.";
      }
      const when = message.trim().slice(0, 120);
      // Only read it back if it actually looks like a time. Verbatim is right
      // for the MANAGER — he needs their words — but echoing it into a
      // sentence assumes it is one. Gabriel answered the time question with
      // "Should of been negociable when I wanted to buy" and got back
      // "Franco will call you Should of been negociable when I wanted to
      // buy." A neutral confirmation cannot embarrass anyone.
      // John answered "Whenever is fine" and it was not recognised, so he sat
      // in the hold for three minutes waiting on the sweeper instead of
      // being booked on the spot. An open answer IS an answer.
      // A bare digit used to count as a time, so "Mercedes GT 4 doors" was one.
      // Luc answered "Only if it is a Mercedes GT 4 doors" and was sent
      // "Perfect Luc - our sales manager Franco will call you Only if it is a
      // Mercedes GT 4 doors." A digit only means a time in a time SHAPE:
      // 4:30, 9am, at 4, 4 o'clock, in 20 minutes, or the whole answer being
      // a number. "2019 Tundra", "3/4 ton" and "$5000 down" are not times.
      const looksLikeTime = /\d{1,2}\s*[:.]\d{2}|\d{1,2}\s*(am|pm|a\.m|p\.m)\b|\b(at|after|before|around|by|til|till|until|from)\s+\d{1,2}\b|\d{1,2}\s*(o'?clock|ish)\b|\bin\s+\d+\s*(min|mins|minutes|hour|hours|hrs)\b|^\s*\d{1,4}\s*$|noon|tonight|today|tomorrow|morning|afternoon|evening|anytime|any time|when ?ever|any ?day|all day|asap|after|before|weekend|\b(mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/i.test(when);
      // Did they actually say yes, or did we route them here from the
      // catch-all? The manager plans a call differently for each, so the
      // alert must not claim "still looking" on his behalf.
      const saidYes = conversation.stage === 'reengage_time' || conversation.stage === 'reengage_held_y';

      // ── Burst hold ───────────────────────────
      // People text in pieces. Irene answered "what time works?" with
      // "It's all" then "Mine lol" then "He can call anytime" — three
      // messages, one thought. Sarah booked the first fragment as the
      // callback time and told her Franco would call her "It's all",
      // then the real answer arrived at a stage that no longer asked.
      // Robyn's "It's easier to text" did the same.
      //
      // So: a reply that does not look like a time gets no answer at all,
      // once. The fragment is kept for the manager and the next message
      // books the callback whatever it says. No timers, no guessing at
      // typing speed — just one beat of silence, which is also what a
      // human reading three texts in a row would do.
      if (atTime && !looksLikeTime) {
        const carried = [conversation.vehicle_detail, when].filter(Boolean).join(' / ').slice(0, 300);
        await updateConversation(conversation.id, {
          stage: saidYes ? 'reengage_held_y' : 'reengage_held_q',
          vehicle_detail: carried,
        });
        await logAnalytics('reengage_held_for_burst', phone, { reply: message.slice(0, 200) }, userId);
        return '';
      }

      // Only a time belongs in the time slot. Casey burst three messages at
      // this step -- "Hey yes I am", "Do u have a car for me?", "I've already
      // given my requirements" -- and the third was booked verbatim, so the
      // alert read 'Call them: I've already given my requirements' and the
      // callbacks list carried that as his preferred time. Their words still
      // reach the manager, on their own line, which is where they belong.
      const slot = looksLikeTime ? when : 'no time given';
      await saveCallback({
        phone, name: name || 'Reengage lead',
        vehicleType: conversation.vehicle_type || null,
        budget: null, budgetAmount: null, datetime: slot, userId,
      });
      await updateConversation(conversation.id, {
        status: 'converted', stage: 'reengage_done', intent: 'callback', datetime: slot,
      });
      try {
        await notifyTenantManagers({
          tenantId, fromNumber, twilioClient,
          body: `CALLBACK — REENGAGE\n${name || 'Unknown'}\n${formatPretty(phone)}\n` +
                (saidYes ? 'Still looking.' : 'Not a clear yes.') +
                // "They asked" is right for the catch-all route, where the
                // detail IS their question. A held fragment is not a
                // question, so it gets a label that doesn’t claim to be one.
                (conversation.vehicle_detail ? `\n${atHeld ? 'Also said' : 'They asked'}: "${conversation.vehicle_detail}"` : '') +
                creditLine(conversation) +
                (looksLikeTime
                  ? `\nCall them: ${when}`
                  : `\nThey said: "${when}"` + `\nNo time given — call when you can.`),
        });
      } catch(e) { console.error('❌ manager notify failed:', e.message); }
      await logAnalytics('reengage_callback', phone, { when, saidYes }, userId);
      // Reading it back only works when what they wrote IS a time phrase.
      // David answered "Hold on. Talk to me Monday." — a time by the pattern,
      // because of the "Monday" — and got "Perfect David — our sales manager
      // Franco will call you Hold on. Talk to me Monday." Found by replaying
      // the real replies in tests/sarah-reply-corpus.js, not by a customer.
      //
      // So: echo a short phrase with no sentence break in it. Anything that
      // reads like two sentences gets the neutral line instead. The manager
      // still receives their exact words either way.
      const echoable = looksLikeTime && when.length <= 60 && !/[.!?]\s*\S*[A-Za-z]/.test(when);
      if (echoable) {
        return first ? `Perfect ${first} — ${mgr} will call you ${when}.`
                     : `Perfect — ${mgr} will call you ${when}.`;
      }
      return first ? `Thanks ${first} — I've passed that to ${mgr} and he'll give you a call.`
                   : `Thanks — I've passed that to ${mgr} and he'll give you a call.`;
    }

    // ── TERMINAL STAGES — the funnel is over ───────────────────────
    // reengage_done = callback booked. reengage_closed = they told us
    // they're done. Neither ever asks a question again, so a later text
    // cannot drop them back into the funnel and start the loop over.
    //
    // It must not swallow them either. "Make it Thursday instead" after
    // a booking, or "actually I'm looking again" after a close, is
    // exactly the message that matters, and a canned thank-you would
    // bury it where nobody sees it. So anything past a bare pleasantry
    // goes to the manager verbatim and gets a flat acknowledgement —
    // no question back, nothing for Sarah to dig into.
    if (conversation.stage === 'reengage_done' || conversation.stage === 'reengage_closed') {
      const booked = conversation.stage === 'reengage_done';
      // An iOS/Android tapback arrives as literal text — Liked "…",
      // Loved "…", Emphasised "…". Nothing recognised it, so Barry's thumbs
      // up on a closing message was forwarded to Franco's phone as though he
      // had said something, and Sarah's reply to it can be tapbacked in turn.
      const isTapback = /^(liked|loved|laughed at|emphas(i[sz])?ed|disliked|questioned|reacted to)\s*[“"'«]/i.test(message.trim());
      // Courtesies come in more than one word. The old check wanted the whole
      // message to be a single token, so "Ok. Thanks" — two words and a full
      // stop — counted as substantive and pinged the manager. Strip the
      // punctuation and ask whether EVERY word left is a courtesy.
      const COURTESY = new Set(['ok','okay','k','kk','kool','cool','thanks','thank','thankyou','you','ty','thx',
                                'great','perfect','sounds','good','sweet','awesome','will','do','no','worries',
                                'np','cheers','yes','yep','yup','sure','alright','appreciate','it','much','so',
                                'nice','gotcha','got','understood','noted','bye','goodbye','take','care',
                                'very','really','lot','lots','again','anyway','anyways','fine','welcome','that','is','all']);
      const words = message.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
      // Nobody spells "thanks" one way. Jeff wrote "Ok thanku" after his
      // callback was booked and it pinged Franco mid-call-block, because
      // "thanku" was not on the list while "thankyou" was. A pattern for the
      // two families that actually vary -- thanks and ok -- beats adding a
      // spelling to the set every time someone invents one.
      const COURTESY_RE = /^(thanks?|thanx|thankyou|thanku|thanks|thnx|thnks|tks|tysm|tyvm|ty|thx|kk+|oka?y?|okey|okies|cool|kool|aight|alright|roger|gotit)$/i;
      const isCourtesy = (w) => COURTESY.has(w) || COURTESY_RE.test(w);
      const allCourtesy = words.length > 0 && words.length <= 5 && words.every(isCourtesy);
      const emojiOnly   = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(message.trim());
      const pleasantry  = isTapback || emojiOnly || allCourtesy;
      if (!pleasantry) {
        try {
          await notifyTenantManagers({
            tenantId, fromNumber, twilioClient,
            body: `REENGAGE — REPLY AFTER ${booked ? 'CALLBACK BOOKED' : 'CLOSE'}\n${name || 'Unknown'}\n${formatPretty(phone)}\n` +
                  (booked && conversation.datetime ? `Was: ${conversation.datetime}\n` : '') +
                  `They said: "${message.trim().slice(0, 160)}"` +
                  creditLine(conversation),
          });
        } catch(e) { console.error('❌ manager notify failed:', e.message); }
        await logAnalytics('reengage_post_close_reply', phone, { stage: conversation.stage, reply: message.slice(0, 200) }, userId);
        return first ? `Got it ${first} — I've passed that to ${mgr}.`
                     : `Got it — I've passed that to ${mgr}.`;
      }
      return booked
        ? `${Mgr} has your details and will call you.`
        : 'Thanks — if anything changes down the road, just text me here.';
    }

    // ── STAGE: reengage_confirm — the one question ─────────────────
    // Bought something. Worth congratulating, and the most valuable answer
    // on the list: it tells the desk to stop chasing.
    //
    // ONLY an actual purchase belongs here. "not looking" and "all set"
    // used to match this branch, so Danny's "Sorry, not looking." came back
    // "Congrats Danny!" on the live pilot. Someone declining is not someone
    // celebrating, and congratulating them reads as not listening.
    // Match the verb, not a list of objects. Enumerating "bought one / a car
    // / a truck / elsewhere" missed Monica's "Nope, bought a vehicle
    // elsewhere. Thanks" on the live pilot — she fell through to the plain
    // decline and the fact she'd BOUGHT, which is what makes her a referral
    // conversation, was lost. Nobody says "bought" in answer to "are you
    // still looking?" unless they did, so the verb alone carries it, minus
    // the explicit negations.
    // "found" gets the same treatment as "bought" — the verb, not a list of
    // things that can be found. It was left enumerated when bought was fixed,
    // so Terrence's "Found a car, thanks" fell through to the catch-all and
    // he was asked when Franco could call him. He sent STOP nineteen seconds
    // later. Half-applying a fix to one verb and not the one beside it is how
    // the same bug comes back wearing a different word.
    const boughtRe    = /\b(bought|purchased|found|already (got|sorted)|went with (another|someone|somewhere|a)|got (one|something) already|sorted now|picked (one|something) up)\b/;
    // Widened alongside the verb match above: "still looking" and "haven't
    // found anything yet" must never read as a purchase now that the bare
    // verb counts.
    // A purchase in the past tense does not mean the search is over. Amy
    // wrote "We bought one and it got hit and written off two days later so
    // we are looking again" and was congratulated and closed, then told
    // "I'm confused. I just said we are looking and you said you're closing
    // the file." The verb match saw "bought" and nothing looked for what came
    // after it. Any present-tense searching signal anywhere in the message
    // outranks the purchase, because people explain the history before they
    // get to the point.
    const stillLookingRe = /\b(looking again|searching again|still (looking|searching|in the hunt|need|needs|want)|look(ing)? for another|need another|want another|back to (looking|square)|start(ing)? over|written off|wrote off|write[- ]?off|totall?ed|got hit|insurance (wrote|total)|back on the hunt|looking once more)\b/i;
    const notBoughtRe = /\b(haven'?t|have not|has not|hasn'?t|didn'?t|did not|never|not)\s+(yet\s+)?(bought|purchased|found)\b|\bhaven'?t found\b/;
    if (boughtRe.test(lowerMsg) && !notBoughtRe.test(lowerMsg) && !stillLookingRe.test(message)) {
      await updateConversation(conversation.id, { stage: 'reengage_closed' });
      await logAnalytics('reengage_not_looking', phone, { reason: 'already_bought', reply: message.slice(0, 200) }, userId);
      return first
        ? `Congrats ${first}! Thanks for letting me know — I'll close it off. If anything changes down the road, just text me here.`
        : "Congrats! Thanks for letting me know — I'll close it off. If anything changes down the road, just text me here.";
    }

    // Not looking — said anywhere in the sentence, because "Sorry, not
    // looking." does not start with "no". Same close, neutral wording.
    if (/\b(no longer looking|not looking|not searching|stopped looking|all set|gave up|decided against|changed my mind|not buying)\b/.test(lowerMsg)) {
      await updateConversation(conversation.id, { stage: 'reengage_closed' });
      await logAnalytics('reengage_not_looking', phone, { reason: 'declined', reply: message.slice(0, 200) }, userId);
      return "No problem at all, thanks for letting me know. If anything changes, I'm here.";
    }

    // Plain "no" / "nope" / "not right now" — an answer, not an opt-out.
    // Shares DECLINE_RE with the time step so the two can never disagree.
    if (BARE_NO_RE.test(message.trim()) || DECLINE_RE.test(message)) {
      await updateConversation(conversation.id, { stage: 'reengage_closed' });
      await logAnalytics('reengage_not_looking', phone, { reason: 'declined', reply: message.slice(0, 200) }, userId);
      return "No problem at all, thanks for letting me know. If anything changes, I'm here.";
    }

    // Still looking → ask for a time. The only booking this FSM makes.
    // Anchored for the short answers — "y", "ok", "sure" only mean yes when
    // they ARE the message. Unanchored for the unambiguous ones, because
    // people lead with a greeting: Miguel wrote "Hi 👋 yes .. I am searching
    // for what I need" and the anchor missed it, so he was logged as an
    // unclear reply and Franco would have been told to read it rather than
    // that the man said yes. Safe to look mid-sentence here because the
    // removal, purchase and decline branches have all already run.
    if (/^(y|ya|yah|yes|yeah|yep|yup|sure|ok|okay|correct|still (looking|am|interested)|i am|we are|absolutely|definitely|kind of|kinda|maybe|possibly|sort of)\b/.test(lowerMsg) ||
        /\b(yes|yeah|yep|yup|still looking|still searching|still interested|still need|still want|looking for|searching for|in the hunt)\b/.test(lowerMsg) ||
        stillLookingRe.test(message)) {
      // Carry their words only when there are some. A bare "yes" would
      // otherwise reach Franco as 'They asked: "yes"', which is noise
      // dressed as context.
      const yesWords = message.trim().split(/\s+/).filter(Boolean);
      await updateConversation(conversation.id, {
        stage: 'reengage_time', intent: 'callback',
        ...(yesWords.length >= 5 ? { vehicle_detail: message.trim().slice(0, 160) } : {}),
      });
      // A yes often arrives carrying a problem. Jefferson wrote "Yeah but my
      // credit is still bad and no cosigner" and got "Good to hear." — the
      // branch fired on his yes and used its cheerful line without reading
      // the rest of the sentence. Same fault as answering "Sorry, not
      // looking" with "Congrats". When someone volunteers a hardship, drop
      // the brightness and acknowledge it; never evaluate it, never promise
      // anything about approval — that is the closer's call, not Sarah's.
      const hardship = CREDIT_RE.test(message);
      if (hardship) {
        return `Understood${first ? ' ' + first : ''} — ${mgr} will give you a call. What time works today or tomorrow?`;
      }
      return pick(
        `Good to hear. ${Mgr} will call you back — what time works today or tomorrow?`,
        `Great. ${Mgr} will call you back — what time suits you today or tomorrow?`
      );
    }

    // "Who is this?" / "I don't know you". Not an ambiguous buying signal —
    // it's someone who doesn't recognise us, and on a list this old it may
    // well be a recycled number. Pushing a callback at them is exactly the
    // pushiness this mode exists to avoid, and it's how Radi ended up with
    // a callback booked off "Definitely not" on the live pilot. Identify
    // once, close, ask nothing.
    if (/\b(who is this|whos this|who'?s this|who are you|i don'?t know you|dont know you|do i know you|who dis)\b/.test(lowerMsg)) {
      await updateConversation(conversation.id, { stage: 'reengage_closed' });
      await logAnalytics('reengage_not_looking', phone, { reason: 'did_not_recognise', reply: message.slice(0, 200) }, userId);
      return `Sorry for the confusion — it's Sarah at ${dealerName}, you'd enquired with us about a vehicle a while back. I'll leave it there. All the best.`;
    }

    // A hard refusal stated as a fact rather than an answer. There was no
    // category for this, so it fell to the catch-all — whose reply is always
    // "when can we call you". Mohammed wrote "I'll never buy from house of
    // cars" and was asked what time suited him. Ryan and Radi landed the same
    // way in different words. Closed, not asked, and the manager is told,
    // because a customer saying that about the dealership is worth his
    // knowing even though there is no sale in it.
    if (/\b(never (buy|buying|purchase|purchasing|shop|deal|do business)|won'?t (buy|deal|shop)|will not (buy|deal|shop)|wouldn'?t (buy|deal)|never again|not buying from|never going back|done with (you|house of cars))\b/i.test(message)) {
      await updateConversation(conversation.id, { stage: 'reengage_closed' });
      try {
        await notifyTenantManagers({
          tenantId, fromNumber, twilioClient,
          body: `REENGAGE — COMPLAINT, NOT A LEAD\n${name || 'Unknown'}\n${formatPretty(phone)}\n` +
                `They said: "${message.trim().slice(0, 160)}"\nClosed, no callback booked.`,
        });
      } catch(e) { console.error('❌ manager notify failed:', e.message); }
      await logAnalytics('reengage_not_looking', phone, { reason: 'hard_refusal', reply: message.slice(0, 200) }, userId);
      return "Understood — I'll close it off and leave you be. Sorry we didn't get it right.";
    }

    // Anything else — a question, a price ask, a specific unit, a story.
    // Sarah does not field it. She routes it to a human, which is the
    // whole point of the mode. Marked _q rather than reengage_time so the
    // callback alert doesn't tell the manager they said they're still
    // looking when all they did was fail to match a yes.
    // Keep what they actually said. The booking alert otherwise carries only
    // their answer to "what time". Chris asked for a 2016 Toyota Venza 2.5 and
    // the alert read 'Not a clear yes — read it. They said: "Today,
    // anytime..."' — it told Franco to read something it never showed him.
    // John's was worse: he wanted to SELL a car, and the alert said only
    // "Tomorrow morning works."
    await updateConversation(conversation.id, {
      stage: 'reengage_time_q', intent: 'callback',
      vehicle_detail: message.trim().slice(0, 160),
    });
    return first
      ? `Let me get ${mgr} to call you on that, ${first} — what time works today or tomorrow?`
      : `Let me get ${mgr} to call you on that — what time works today or tomorrow?`;
  }

  async function getJerryResponse(phone, message, conversation, userId, fromNumber, tenantId, dealerName = 'the dealership', dealerCity = '', inventory = [], deliveryArea = '', managerName = '') {
    // Mode router — acquisition campaigns go to a separate FSM that asks
    // about the seller's vehicle, mileage, condition, asking price, and
    // pivots to "looking to replace it?" before booking. Sales mode (the
    // historical default) continues unchanged below.
    if (conversation.mode === 'acquisition') {
      return getAcquisitionResponse(phone, message, conversation, userId, fromNumber, tenantId, dealerName, dealerCity, deliveryArea);
    }
    // Reengage campaigns (aged leads) run a third, much smaller FSM:
    // one question, callbacks only, no appointments and no numbers.
    if (conversation.mode === 'reengage') {
      return getReengageResponse(phone, message, conversation, userId, fromNumber, tenantId, dealerName, managerName);
    }

    const lowerMsg = message.toLowerCase().trim();
    const name = conversation.customer_name || '';
    function pick(...opts) { return opts[Math.floor(Math.random() * opts.length)]; }

    // ── MID-FLOW MODE PIVOT (Phase 7+ dynamicity) ────────────────────
    // If a buy-side customer drops a clear "I'm selling my X" signal at
    // ANY stage of the sales FSM, flip into acquisition mode + extract
    // year/make/model from the same message. Avoids the bug Mil hit
    // where Sarah ignored the seller signal and kept asking for budget.
    const wrongDir = detectWrongDirection(lowerMsg, 'sales');
    if (wrongDir === 'acquisition' && conversation.stage !== 'confirmed') {
      const v = extractVehicleFromText(message);
      const updates = { mode: 'acquisition', stage: 'acq_confirm' };
      if (v.year)  updates.vehicle_year  = v.year;
      if (v.make)  updates.vehicle_make  = v.make;
      if (v.model) updates.vehicle_model = v.model;
      await updateConversation(conversation.id, updates);
      const vSummary = [v.year, v.make, v.model].filter(Boolean).join(' ');
      return vSummary
        ? `Got it — sounds like you've got a ${vSummary} you're thinking of selling. Want me to walk you through what we'd offer? What's the mileage on it?`
        : "Oh — sounds like you're thinking about selling. We do those too! What is it (year/make/model) and what's the mileage?";
    }

    // ── BARE GREETING — hi/hello/hey ─────────────────────────
    if (lowerMsg === 'hi' || lowerMsg === 'hello' || lowerMsg === 'hey' ||
        lowerMsg === 'hey there' || lowerMsg === 'hi there' || lowerMsg === 'good morning' ||
        lowerMsg === 'good afternoon' || lowerMsg === 'good evening' || lowerMsg === 'howdy') {
      if (conversation.stage === 'confirmed' || conversation.status === 'converted') {
        return `Hey${name ? ' '+name : ''}! You're all set for ${conversation.datetime || 'your appointment'}. Anything else I can help with?`;
      }
      if (name && conversation.vehicle_type) {
        // Returning customer mid-funnel — pick up where they left off
        if (conversation.stage === 'discovery') return `Hey ${name}! Still here 😊 Any particular make or model you had in mind?`;
        if (conversation.stage === 'budget' && !conversation.budget) return `Hey ${name}! Still here 😊 Where are you comfortable for monthly payments on a ${conversation.vehicle_type}?`;
        if (conversation.stage === 'appointment') return `Hey ${name}! Would you like to schedule a viewing — we can also deliver — or would a quick call be easier?`;
        if (conversation.stage === 'datetime') return `Hey ${name}! When works best for you?`;
      }
      return pick(
        `Hey${name ? ' '+name : ''}! 👋 Great to hear from you. Are you looking for a Car, Truck, Van, or SUV?`,
        `Hi${name ? ' '+name : ''}! I'm Sarah — what type of vehicle are you looking for today?`,
        `Hey there${name ? ' '+name : ''}! Looking for a vehicle? Car, Truck, Van, or SUV — what are you after?`
      );
    }

    // ── AMBIGUOUS POSITIVE — ok/sure/yeah/sounds good ────────
    if (lowerMsg === 'ok' || lowerMsg === 'okay' || lowerMsg === 'sure' ||
        lowerMsg === 'yeah' || lowerMsg === 'yep' || lowerMsg === 'sounds good' ||
        lowerMsg === 'alright' || lowerMsg === 'cool' || lowerMsg === 'great' ||
        lowerMsg === 'perfect' || lowerMsg === 'works for me') {
      // Route based on current stage
      if (conversation.stage === 'confirmed') return `${name ? 'Great '+name+'! ' : 'Great! '}See you ${conversation.datetime || 'soon'}! Text me if anything changes.`;
      if (conversation.stage === 'appointment' && !conversation.intent) {
        await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
        return name ? `${name}, when works best to book a time?` : "What's your name? I'll get everything set up for you.";
      }
      if (conversation.stage === 'datetime') return `When works best${name ? ' '+name : ''}? Morning, afternoon, or evening?`;
      if (conversation.stage === 'name' && !name) return "What's your name?";
      // "ok" to "any particular make in mind?" is a non-answer. Don't ask it
      // a second way — go book.
      if (conversation.stage === 'discovery') {
        await updateConversation(conversation.id, { stage: 'appointment' });
        return `${name ? name + ', want' : 'Want'} to book a time to see a few, or would a quick call be easier?`;
      }
      if (!conversation.vehicle_type) return "Are you looking for a Car, Truck, Van, or SUV?";
      if (!conversation.budget) return `What monthly payment range works for you on a ${conversation.vehicle_type}?`;
      return `${name ? name+', when' : 'When'} works best — would you prefer to schedule a viewing or have someone call you?`;
    }

    // ── STOP / UNSUBSCRIBE ────────────────────────────────────
    if (lowerMsg === 'stop' || /^stop[^a-z]/i.test(message.trim()) ||
        lowerMsg.includes('unsubscribe') || lowerMsg.includes('opt out') || lowerMsg.includes('opt-out')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await addOptOut(phone, 'sms_stop');
      await logAnalytics('conversation_stopped', phone, {}, userId);
      return "You've been unsubscribed and won't receive further messages. Reply START anytime to resume.";
    }

    // ── START / RESUBSCRIBE ───────────────────────────────────
    if (lowerMsg === 'start' || lowerMsg.includes('resubscribe') || lowerMsg.includes('opt in')) {
      await updateConversation(conversation.id, { status: 'active', stage: 'greeting' });
      await removeOptOut(phone);
      await logAnalytics('conversation_restarted', phone, {}, userId);
      return `Welcome back! I'm Sarah from ${dealerName}. Are you still looking for a vehicle? Car, Truck, Van, or SUV?`;
    }

    if (conversation.status === 'stopped') {
      return "You're currently unsubscribed. Reply START to receive messages again.";
    }

    // ── NOT INTERESTED ────────────────────────────────────────
    // ── ALREADY SPOKE TO SOMEONE ─────────────────────────────
    if (lowerMsg.includes('already spoke') || lowerMsg.includes('already talked') ||
        lowerMsg.includes('already called') || lowerMsg.includes('someone called me') ||
        lowerMsg.includes('already dealing') || lowerMsg.includes('already working') ||
        lowerMsg.includes('salesperson') || lowerMsg.includes('sales person') ||
        lowerMsg.includes('already in touch') || lowerMsg.includes('already contacted')) {
      if (conversation.stage === 'confirmed' || conversation.status === 'converted') {
        return `${name ? 'Hey '+name+'! ' : ''}Sounds like you\'re all set — our team will take great care of you. If you have any other questions, just text me anytime!`;
      }
      await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
      if (!name) return "No problem at all! What's your name so I can make sure the right person follows up?";
      return `${name}, no problem! I'll make a note so the right person follows up. When would be a good time for them to reach out?`;
    }

    // ── ALREADY BOUGHT / FOUND ONE ELSEWHERE ────────────────
    if (lowerMsg.includes('already bought') || lowerMsg.includes('already got') ||
        lowerMsg.includes('found one') || lowerMsg.includes('got one') ||
        lowerMsg.includes('purchased') || lowerMsg.includes('just bought') ||
        lowerMsg.includes('went with') || lowerMsg.includes('went somewhere') ||
        lowerMsg.includes('got a car') || lowerMsg.includes('got a truck') ||
        lowerMsg.includes('got a vehicle') || lowerMsg.includes('nevermind') ||
        lowerMsg.includes('never mind') || lowerMsg.includes('no longer') ||
        lowerMsg.includes('not looking anymore') || lowerMsg.includes('found what')) {
      // Congratulate but still try to open a door
      await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
      if (conversation.status === 'converted') {
        return `${name ? 'Congrats '+name+'! ' : 'Congrats! '}Excited for you — enjoy the new ride! If you ever need anything down the road, we're always here.`;
      }
      if (!name) {
        return pick(
          "Congrats on the new vehicle! 🎉 Just so you know — if you ever need anything down the road, financing options, trade-in, or protection packages, we're always here. What's your name? I'll keep you on file.",
          "Oh nice, congrats! 🎉 If things don't work out or you're ever looking again, we'd love to earn your business. What's your name?"
        );
      }
      return pick(
        `Congrats ${name}! 🎉 Enjoy the new ride. If you ever need anything — trade-in, protection packages, or a vehicle down the road — just text me anytime. Would you be open to a quick call from our manager just to introduce himself?`,
        `That's awesome ${name}! 🎉 If anything comes up or you know someone looking, we'd love the chance. Would a quick call from our team be okay — just a 2-minute intro, no pressure?`
      );
    }

    // CRITICAL: do NOT match bare "no" / "nah" / "nope" — customers say
    // "no" to legitimate binary stage questions (e.g. "got a trade?" →
    // "no" means no trade). Stage handlers below decide what bare "no"
    // means in context. Universal opt-out only fires on explicit phrases.
    if (lowerMsg.includes('not interested') || lowerMsg.includes('no thanks') ||
        lowerMsg.includes('no thank you') || lowerMsg.includes('wrong number') ||
        lowerMsg.includes('leave me alone') || lowerMsg.includes('remove me') ||
        lowerMsg.includes('do not contact') || lowerMsg.includes('go away') ||
        lowerMsg.includes("don't text") || lowerMsg.includes('stop texting') || lowerMsg.includes('please stop')) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await logAnalytics('conversation_stopped', phone, { reason: 'not_interested' }, userId);
      return "No worries at all! I've taken you off our list. If anything changes down the road, just text back anytime. Take care!";
    }

    // ── ODD QUESTIONS → funnel to callback ───────────────────
    if (lowerMsg.includes('location') || lowerMsg.includes('where are you') || lowerMsg.includes('address') || lowerMsg.includes('directions')) {
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); const where = whereWeAre(dealerCity, deliveryArea); return `${where ? where + ' ' : ''}I can have one of our team call you with the details. What's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      const where = whereWeAre(dealerCity, deliveryArea);
      return `${where ? where + ' ' : ''}When's a good time for one of our team to call you with directions, ${name}?`;
    }

    if (lowerMsg.includes('financ') || lowerMsg.includes('credit') || lowerMsg.includes('loan') ||
        lowerMsg.includes('bad credit') || lowerMsg.includes('no credit') || lowerMsg.includes('poor credit') ||
        lowerMsg.includes('bankrupt') || lowerMsg.includes('consumer proposal') || lowerMsg.includes('cosign') ||
        lowerMsg.includes('down payment') || lowerMsg.includes('trade') || lowerMsg.includes('trading')) {
      const hasTrade = lowerMsg.includes('trade') || lowerMsg.includes('trading');
      if (hasTrade) {
        if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Trades are no problem — we handle all makes and models, and we'll give you a fair value. What's your name? I'll have someone reach out to discuss what you've got."; }
        await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
        return `${name}, trades are no problem at all! Our team will assess your vehicle and give you a real number. When's a good time for a quick call to go over the details?`;
      }
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Great question — that's exactly what our finance team handles. We work with all credit situations and have flexible options. What's your name? I'll have someone reach out who can walk you through everything."; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, our finance team handles all of that — they work with every credit situation. When's a good time for them to give you a quick call? No obligation.`;
    }

    // ── FINANCING TIMELINE / PROCESS QUESTIONS ──────────────
    if (lowerMsg.includes('how long') || lowerMsg.includes('how does') || lowerMsg.includes('how do') ||
        lowerMsg.includes('process') || lowerMsg.includes('timeline') || lowerMsg.includes('how fast') ||
        lowerMsg.includes('quick') || lowerMsg.includes('same day') || lowerMsg.includes('how soon') ||
        lowerMsg.includes('when can i') || lowerMsg.includes('how does financing') ||
        lowerMsg.includes('what do i need') || lowerMsg.includes('what documents') ||
        lowerMsg.includes('what papers') || lowerMsg.includes('requirements') ||
        (lowerMsg.includes('financing') && (lowerMsg.includes('work') || lowerMsg.includes('take') || lowerMsg.includes('long') || lowerMsg.includes('fast')))) {
      if (!name) {
        await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
        return "Great question! Our finance managers can walk you through the whole process — it's usually pretty quick. What's your name? I'll have one of them reach out.";
      }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, our finance manager can walk you through everything — most deals move fast, sometimes same day depending on the situation. When's a good time for a quick call? They'll answer all your questions.`;
    }

    if (lowerMsg.includes('how much') || lowerMsg.includes('price') || lowerMsg.includes('cost') ||
        lowerMsg.includes('cheapest') || lowerMsg.includes('expensive') || lowerMsg.includes('rates')) {
      if (!conversation.vehicle_type) { await updateConversation(conversation.id, { stage: 'greeting' }); return "Pricing really depends on what you're looking for! Are you thinking Car, Truck, Van, or SUV? Once I know that I can point you in the right direction."; }
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `${conversation.vehicle_type} pricing varies by year and features. I can have one of our team send you some options with pricing — what's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, pricing on ${conversation.vehicle_type}s really depends on the specifics. When's a good time for one of our team to call you? They can go over everything and find the best fit.`;
    }

    if (lowerMsg.includes('detail') || lowerMsg.includes('more info') || lowerMsg.includes('tell me more') ||
        lowerMsg.includes('manager') || lowerMsg.includes('speak to') || lowerMsg.includes('talk to someone')) {
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Absolutely — I'll have one of our team reach out with all the details. What's your name?"; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll get one of our team on it. When's the best time to reach you?`;
    }

    // ── SPECIFIC YEAR/MAKE/MODEL REQUEST ─────────────────────
    const yearMatch = message.match(/\b(19|20)\d{2}\b/);
    const makeWords = ['ford','toyota','honda','chevrolet','chevy','gmc','dodge','ram','jeep','nissan','hyundai','kia','mazda','subaru','volkswagen','vw','bmw','mercedes','audi','lexus','infiniti','acura','cadillac','lincoln','buick','chrysler','mitsubishi','volvo','tesla','genesis'];
    const hasMake = makeWords.some(m => lowerMsg.includes(m));
    if ((yearMatch || hasMake) && (lowerMsg.includes('have') || lowerMsg.includes('got') || lowerMsg.includes('looking') || lowerMsg.includes('want') || lowerMsg.includes('need') || lowerMsg.includes('find') || lowerMsg.includes('sell') || lowerMsg.includes('any') || lowerMsg.includes('do you') || lowerMsg.includes('stock'))) {
      const year = yearMatch ? yearMatch[0] : null;
      const make = makeWords.find(m => lowerMsg.includes(m)) || '';
      const makeLabel = make ? make.charAt(0).toUpperCase() + make.slice(1) : '';
      const label = [year, makeLabel].filter(Boolean).join(' ');
      if (inventory && inventory.length > 0) {
        const matches = inventory.filter(v => {
          const matchYear = year ? String(v.year) === year : true;
          const matchMake = make ? (v.make || '').toLowerCase().includes(make) : true;
          return matchYear && matchMake;
        });
        if (matches.length > 0) {
          const examples = matches.slice(0,3).map(v => `${v.year} ${v.make} ${v.model}${v.mileage ? ' ('+Math.round(v.mileage/1000)+'k km)' : ''}${v.price ? ' — $'+Number(v.price).toLocaleString() : ''}`).join(', ');
          if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name', vehicle_type: makeLabel || conversation.vehicle_type }); return `Yes! We have ${matches.length} ${label} option${matches.length>1?'s':''}: ${examples}. I can have someone reach out with full details and photos — what's your name?`; }
          await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime', vehicle_type: makeLabel || conversation.vehicle_type });
          return `${name}, we have ${matches.length} ${label} option${matches.length>1?'s':''} in stock: ${examples}. Would you like to schedule a viewing, or a quick call to go over the details?`;
        } else {
          if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `We don't have a ${label} in stock right now, but inventory moves fast and we can source vehicles. What's your name? I'll have someone reach out with what's coming in.`; }
          await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
          return `${name}, we don't have a ${label} right now but we can source them and get something close. When's a good time for one of our team to reach out with some options?`;
        }
      }
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return `I'll have one of our team reach out with details on ${label} options. What's your name?`; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll have the team pull up ${label} options for you. When's a good time to reach out?`;
    }

    if (lowerMsg.includes('do you have') || lowerMsg.includes('got any') || lowerMsg.includes('available') ||
        lowerMsg.includes('in stock') || lowerMsg.includes('inventory') || lowerMsg.includes('photos') ||
        lowerMsg.includes('pictures') || lowerMsg.includes('send me')) {

      // Build inventory-aware response using tenant's actual stock
      function buildInventoryReply(filterFn, typeName) {
        if (!inventory || inventory.length === 0) return null;
        const matches = filterFn ? inventory.filter(filterFn) : inventory;
        if (matches.length === 0) return null;
        const count = matches.length;
        // Show up to 3 specific vehicles
        const examples = matches.slice(0, 3).map(v =>
          `${v.year} ${v.make} ${v.model}${v.mileage ? ' (' + Math.round(v.mileage/1000) + 'k km)' : ''}`
        ).join(', ');
        return { count, examples };
      }

      // Detect if asking about a specific type
      const askTruck   = ['truck','pickup','f-150','f150','silverado','ram','tacoma','tundra','sierra','ranger'].some(w => lowerMsg.includes(w));
      const askSuv     = ['suv','crossover','highlander','rav4','explorer','tahoe','suburban','pilot','4runner','tucson'].some(w => lowerMsg.includes(w));
      const askCar     = ['sedan','car','civic','corolla','camry','accord','altima'].some(w => lowerMsg.includes(w));
      const askVan     = ['van','minivan','sienna','odyssey','pacifica'].some(w => lowerMsg.includes(w));

      let invReply = null;
      if (askTruck)    invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('truck') || v.make?.toLowerCase().match(/ford|ram|chevrolet|gmc|toyota|nissan/), 'truck');
      else if (askSuv) invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('suv') || v.type?.toLowerCase().includes('4x4'), 'SUV');
      else if (askCar) invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('car') || v.type?.toLowerCase().includes('sedan'), 'car');
      else if (askVan) invReply = buildInventoryReply(v => v.type?.toLowerCase().includes('van'), 'van');
      else             invReply = buildInventoryReply(null, 'vehicle');

      if (invReply && invReply.count > 0) {
        const typeLabel = askTruck ? 'truck' : askSuv ? 'SUV' : askCar ? 'car' : askVan ? 'van' : 'vehicle';
        if (!name) {
          await updateConversation(conversation.id, { intent: 'callback', stage: 'name' });
          return `Yes! We have ${invReply.count} ${typeLabel}${invReply.count > 1 ? 's' : ''} in stock — ${invReply.examples}. Our team can reach out with photos and full details. What's your name?`;
        }
        await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
        return `${name}, we have ${invReply.count} ${typeLabel}${invReply.count > 1 ? 's' : ''} in stock right now — ${invReply.examples}. Which one do you want to look at, and what day works — today or later this week?`;
      }

      // Fallback if no inventory or no match
      if (!name) { await updateConversation(conversation.id, { intent: 'callback', stage: 'name' }); return "Yes! We have a great selection. I can have one of our team send you photos and details — what's your name?"; }
      await updateConversation(conversation.id, { intent: 'callback', stage: 'datetime' });
      return `${name}, I'll have the team send over what we've got. When's a good time to reach you? They can send photos and walk you through the options.`;
    }

    // ── MULTI-INTENT: inventory ask + call request in same message ──
    const wantsCall = lowerMsg.includes('call me') || lowerMsg.includes('give me a call') ||
                      lowerMsg.includes('reach me') || lowerMsg.includes('contact me') ||
                      lowerMsg.includes('someone call') || lowerMsg.includes('have someone');
    const wantsInfo = lowerMsg.includes('do you have') || lowerMsg.includes('got any') ||
                      lowerMsg.includes('in stock') || lowerMsg.includes('available');
    if (wantsCall && wantsInfo && conversation.stage !== 'confirmed') {
      // Answer the inventory question first, then capture callback intent
      if (inventory && inventory.length > 0) {
        const typeLabel = conversation.vehicle_type || 'vehicle';
        const matches = inventory.slice(0, 3).map(v => `${v.year} ${v.make} ${v.model}`).join(', ');
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        if (!name) return `Yes! We have ${inventory.length} vehicles in stock — ${matches} and more. What's your name? I'll have someone reach out with details and photos.`;
        return `${name}, yes! We have options in stock right now. I'll have one of our team call you — when's the best time to reach you?`;
      }
      await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
      if (!name) return "Yes we do! What's your name? I'll have someone call you with full details.";
      return `${name}, I'll have someone call you with what we've got. When's the best time to reach you?`;
    }

    // ── STAGE 1: GREETING ─────────────────────────────────────
    if (conversation.stage === 'greeting' || !conversation.vehicle_type) {
      // Phase 7+ — uses centralised VEHICLE_VOCAB via detectVehicleType().
      // Recognises sports cars, hatchbacks, convertibles, EVs, and a much
      // broader make/model list than the old inline word lists. Easy to
      // expand: add a word to VEHICLE_VOCAB at the top of this file and
      // it works in both sales and acquisition modes.
      const vehicleType = detectVehicleType(lowerMsg);

      if (vehicleType) {
        // Discovery before money. Opening on payments anchors the whole
        // conversation on cost before there's any interest to protect, and
        // this reply used to echo the detected type back with a compliment —
        // "Car — great choice!" when the customer had said nothing of the
        // kind. Capture the type silently and ask what they're actually
        // after; the payment question lives in the discovery stage below,
        // once they're talking.
        await updateConversation(conversation.id, { vehicle_type: vehicleType, stage: 'discovery' });
        const phrase = GENERIC_TYPES.has(vehicleType) ? '' : typePhrase(vehicleType);
        return phrase
          ? pick(
              `Got it, ${phrase}. Any particular make or model in mind?`,
              `${phrase.charAt(0).toUpperCase() + phrase.slice(1)} — what year or model are you after?`,
              `Got it. Anything it has to have — make, model, must-haves?`
            )
          : pick(
              "Any particular make or model in mind?",
              "What are you after — anything specific, or still deciding?"
            );
      }
      // Number without context at greeting — could be a budget
      const greetNumbers = message.match(/\d+/g);
      if (greetNumbers && greetNumbers.length > 0) {
        const num = parseInt(greetNumbers[0]);
        if (num >= 200 && num <= 2000) {
          // Looks like a monthly budget — treat it as such
          const budgetRange = (num * 72) < 30000 ? 'Under $30k' : (num * 72) < 50000 ? '$30k-$50k' : '$50k+';
          await updateConversation(conversation.id, { budget: budgetRange, budget_amount: num, stage: 'appointment' });
          return pick(
            `$${num}/month — solid! I've got great options in that range. Would you like to schedule a viewing, or would a quick call work better?`,
            `Around $${num}/month works! I can find you some solid vehicles. Would you like to book a time to see it, or start with a quick call?`
          );
        }
      }
      return pick(
        "Are you looking for a Car, Truck, Van, or SUV? Just let me know and I'll find you the best options.",
        "What kind of vehicle are you after? Car, Truck, Van, or SUV?",
        "To get you the best match — are you thinking Car, Truck, Van, or SUV?"
      );
    }

    // ── STAGE 1.5: DISCOVERY ──────────────────────────────────
    // One turn, and only one. The customer tells us what they're after in
    // their own words; we store it verbatim for the closer and move on to
    // payment. If they give us nothing back, we stop asking and go book —
    // a customer who won't answer a make/model question is not going to
    // warm up to a second one.
    if (conversation.stage === 'discovery') {
      if (soundsStalled(message)) {
        await updateConversation(conversation.id, { stage: 'appointment' });
        // Franco's own shape, from his sales texts: name the thing, anchor on
        // a day, and ask them to choose rather than offering a yes/no with an
        // easy no in it. "Do you have time today to come test drive?" books;
        // "would you like to schedule a viewing?" invites a maybe.
        const what = typePhrase(conversation.vehicle_type) || 'a few';
        return pick(
          `No problem${name ? ' ' + name : ''} — easiest way is to see ${what} in person. Are you around today or tomorrow? I can also have someone give you a call.`,
          `All good — quickest thing is to get you behind the wheel. What day works, today or later this week? Or I can set up a call.`
        );
      }
      // Verbatim capture, no echo and no commentary on their choice.
      const detail = String(message).trim().slice(0, 255);
      const updates = { vehicle_detail: detail, stage: 'budget' };
      // If they named something we recognise, tighten the stored type too —
      // "looking for a Wrangler" starts as Car/Vehicle and is really an SUV.
      const sharper = detectVehicleType(lowerMsg);
      if (sharper && !GENERIC_TYPES.has(sharper)) updates.vehicle_type = sharper;
      await updateConversation(conversation.id, updates);
      return pick(
        "Perfect. Where are you comfortable for monthly payments? Rough number is fine — $300, $500, $700.",
        "Got it. What monthly payment range works for you? Ballpark is fine.",
        "Noted. What are you looking to keep payments around each month?"
      );
    }

    // ── STAGE 2: BUDGET ───────────────────────────────────────
    if (conversation.stage === 'budget' && !conversation.budget) {
      const numbers = message.match(/\d+/g);
      let budgetAmount = 0;
      if (numbers && numbers.length > 0) {
        budgetAmount = parseInt(numbers[0]);
        if (lowerMsg.includes('k') && budgetAmount < 1000) budgetAmount *= 1000;
        if (message.includes(',')) { const e = message.replace(/,/g,'').match(/\d+/); if (e) budgetAmount = parseInt(e[0]); }
      }
      if (budgetAmount > 0 && budgetAmount < 2000) {
        const estTotal = budgetAmount * 72;
        const budgetRange = estTotal < 30000 ? 'Under $30k' : estTotal < 50000 ? '$30k-$50k' : '$50k+';
        await updateConversation(conversation.id, { budget: budgetRange, budget_amount: budgetAmount, stage: 'appointment' });
        return pick(
          `$${budgetAmount}/month works. I've got ${conversation.vehicle_type} options in that range. What day suits you to come take one for a drive — today or later this week? We deliver too.`,
          `Around $${budgetAmount}/month — I have solid options for you. Are you free today or tomorrow to come see one? I can also have someone call you first.`
        );
      }
      if (budgetAmount >= 2000) {
        const budgetRange = budgetAmount < 30000 ? 'Under $30k' : budgetAmount < 50000 ? '$30k-$50k' : '$50k+';
        await updateConversation(conversation.id, { budget: budgetRange, budget_amount: budgetAmount, stage: 'appointment' });
        return pick(
          `Around $${(budgetAmount/1000).toFixed(0)}k — solid budget. I have some great options. Would you like to schedule a viewing, or a quick call to go over what we have?`,
          `$${(budgetAmount/1000).toFixed(0)}k — I can work with that. Would you like to book a time to view something, or prefer a call first?`
        );
      }
      if (lowerMsg.includes('cheap') || lowerMsg.includes('low') || lowerMsg.includes('budget') || lowerMsg.includes('affordable')) {
        await updateConversation(conversation.id, { budget: 'Under $30k', stage: 'appointment' });
        return "I hear you — we've got great value options. Would you like to book a time to view one, or should one of our team reach out with what's available?";
      }
      if (lowerMsg.includes("don't care") || lowerMsg.includes('whatever') || lowerMsg.includes('open') || lowerMsg.includes('flexible') || lowerMsg.includes('not sure')) {
        await updateConversation(conversation.id, { budget: 'Flexible', stage: 'appointment' });
        return "No problem — we'll find the right fit. Would you like to book a time to see what we have, or would a quick call be easier?";
      }
      if (lowerMsg.includes('high') || lowerMsg.includes('premium') || lowerMsg.includes('luxury')) {
        await updateConversation(conversation.id, { budget: '$50k+', stage: 'appointment' });
        return "We have options in that range. What day works to come see one — today or later this week? Or I can have someone call you with details and photos.";
      }
      if (budgetAmount > 0 && budgetAmount < 100) {
        return "Just to make sure I understand — is that $" + budgetAmount + " per month, or total budget? Most people are in the $300-$700/month range.";
      }
      // Price objection handler
      if (lowerMsg.includes('too expensive') || lowerMsg.includes('too much') || lowerMsg.includes("can't afford") ||
          lowerMsg.includes('cannot afford') || lowerMsg.includes('out of my budget') || lowerMsg.includes('too high') ||
          lowerMsg.includes('no money') || lowerMsg.includes('broke') || lowerMsg.includes('tight') ||
          lowerMsg.includes('cheaper') || lowerMsg.includes('less expensive') || lowerMsg.includes('lower payment')) {
        await updateConversation(conversation.id, { budget: 'Under $30k', stage: 'appointment' });
        return pick(
          `No worries at all${name ? ' '+name : ''}! We work with all budgets and every credit situation. Even $200-$300/month gets you into something solid. Would you like to schedule a time — we can also bring the vehicle to you — or would a quick call be easier?`,
          `${name ? name+', we' : "We"} specialize in making deals work — we've helped people in every situation. Let's find something that works for you. Would you like to book a time, or would a call be a better first step?`
        );
      }
      return pick(
        "Just a rough number is fine — like $300/month, $500/month, or a total budget like $25k, $40k. Whatever you're comfortable with.",
        "What range are you thinking? Like $300-500/month, or a total budget? Just ballpark it for me."
      );
    }

    // ── STAGE 3: APPOINTMENT ──────────────────────────────────
    if (conversation.stage === 'appointment' && !conversation.intent) {
      if (lowerMsg.includes('view') || lowerMsg.includes('book') || lowerMsg.includes('visit') || lowerMsg.includes('test') ||
          lowerMsg.includes('drive') || lowerMsg.includes('see') || lowerMsg.includes('look') ||
          lowerMsg.includes('come') || lowerMsg.includes('in person') || lowerMsg.includes('show up') || lowerMsg.includes('schedule')) {
        await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when works best for you? We're flexible — mornings, afternoons, evenings, weekends. We can also arrange delivery if that's easier.`
          : "Sounds great! What's your name so I can get everything set up for you?";
      }
      if (lowerMsg.includes('call') || lowerMsg.includes('phone') || lowerMsg.includes('talk') ||
          lowerMsg.includes('reach') || lowerMsg.includes('contact') || lowerMsg.includes('ring')) {
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        return name
          ? `${name}, when's the best time to give you a call?`
          : "Sounds good — what's your name? I'll have someone reach out.";
      }
      if (lowerMsg.includes('maybe') || lowerMsg.includes('not sure') || lowerMsg.includes('think') ||
          lowerMsg.includes('later') || lowerMsg.includes('busy')) {
        // This used to end with "whenever you're ready" and ask for nothing,
        // which is a dead lead dressed up as politeness. Someone who won't
        // commit to coming in will often take a call, and a callback is a
        // real outcome — so fall back to the smaller ask instead of none.
        await updateConversation(conversation.id, { intent: 'callback', stage: name ? 'datetime' : 'name' });
        return name
          ? `No rush ${name} — want me to have someone give you a quick call instead? No obligation.`
          : "No rush — I can have someone give you a quick call instead, no obligation. What's your name?";
      }
      await updateConversation(conversation.id, { intent: 'test_drive', stage: name ? 'datetime' : 'name' });
      return name
        ? `${name}, I've got options lined up for you. What day works to come take one for a drive — today or later this week? We can deliver too.`
        : "I've got solid options lined up. What's your name? I'll get everything ready for you.";
    }

    // ── STAGE 4: NAME ─────────────────────────────────────────
    if (conversation.stage === 'name' && !name) {
      let parsedName = message.trim();
      if (lowerMsg.includes('my name is')) parsedName = message.split(/my name is/i)[1].trim();
      else if (lowerMsg.includes("i'm")) parsedName = message.split(/i'm/i)[1].trim();
      else if (lowerMsg.includes("i am")) parsedName = message.split(/i am/i)[1].trim();
      else if (lowerMsg.includes("it's") || lowerMsg.includes("its")) parsedName = message.split(/it'?s/i)[1]?.trim() || parsedName;
      else if (lowerMsg.includes("call me")) parsedName = message.split(/call me/i)[1].trim();
      parsedName = parsedName.replace(/[^a-zA-Z\s'-]/g, '').trim().substring(0, 100);
      const parts = parsedName.split(/\s+/).slice(0, 2);
      parsedName = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      if (!parsedName || parsedName.length < 2) return "Sorry, I didn't catch that — what's your first name?";
      // Phase 7 — sales flow now asks trade-in BEFORE datetime so the
      // closer walks into the conversation knowing if there's a trade
      // (and an appraisal opportunity) on the table.
      await updateConversation(conversation.id, { customer_name: parsedName, stage: 'trade_in_check' });
      await pool.query('UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2', [parsedName, phone]);
      return pick(
        `Hey ${parsedName}! Quick one before we lock in a time — do you have a vehicle to trade in? Even a rough year/make/model helps.`,
        `Nice to meet you ${parsedName}! One quick thing — any vehicle you'd want to trade in? If yes, what is it and what would you want for it?`,
        `${parsedName}, before we book — got a trade? If you tell me year/make/model and what you'd want for it, I can have it appraised by the time you come in.`
      );
    }

    // ── STAGE 4.5: TRADE-IN CHECK (Phase 7) ────────────────────
    // Asks every buyer about a potential trade-in. Captures details if
    // they have one; either way advances to datetime so we always end on
    // an appointment or callback.
    if (conversation.stage === 'trade_in_check') {
      // Negative — no trade
      if (lowerMsg === 'no' || lowerMsg === 'nope' || lowerMsg === 'nah' ||
          lowerMsg.includes('no trade') || lowerMsg.includes("don't have") || lowerMsg.includes('not trading') ||
          lowerMsg.includes('nothing to trade') || lowerMsg.includes('just buying')) {
        await updateConversation(conversation.id, { trade_in_value: 0, stage: 'datetime' });
        if (conversation.intent === 'test_drive') {
          return pick(
            `All good ${name}! When works best for a viewing? Mornings, afternoons, evenings — even weekends.`,
            `No worries ${name}! When would you like to come in?`
          );
        }
        return `No problem ${name}! When's the best time for a quick call? Morning, afternoon, or evening?`;
      }
      // Positive — they have a trade. Try to extract year/make.
      const yearMatch = message.match(/\b(19|20)\d{2}\b/);
      const makeWords = ['ford','toyota','honda','chevrolet','chevy','gmc','dodge','ram','jeep','nissan','hyundai','kia','mazda','subaru','volkswagen','vw','bmw','mercedes','audi','lexus','infiniti','acura','cadillac','lincoln','buick','chrysler','mitsubishi','volvo','tesla','genesis'];
      const make = makeWords.find(m => lowerMsg.includes(m));
      const dollarMatch = message.match(/\$?(\d{1,3}(?:[,.]?\d{3})+|\d{4,6})/);
      const year = yearMatch ? parseInt(yearMatch[0]) : null;
      const makeLabel = make ? make.charAt(0).toUpperCase() + make.slice(1) : null;
      const tradeValue = dollarMatch ? parseInt(dollarMatch[1].replace(/[,.]/g, '')) : null;
      // Affirmative without details — ask for them
      if ((lowerMsg === 'yes' || lowerMsg === 'yep' || lowerMsg === 'sure' || lowerMsg.includes('have one') ||
           lowerMsg.includes('have a trade') || lowerMsg === 'i do' || lowerMsg.includes('yeah')) &&
          !year && !make && !tradeValue) {
        return "Awesome — what is it? Year, make, model and what you'd want for it (rough number is fine).";
      }
      // We got something — capture what we can and advance
      const updates = { stage: 'datetime' };
      if (year)       updates.trade_in_year = year;
      if (makeLabel)  updates.trade_in_make = makeLabel;
      if (tradeValue && tradeValue >= 500 && tradeValue <= 200000) updates.trade_in_value = tradeValue;
      // If nothing parsed, save the raw message as the model so the closer has something
      if (!year && !makeLabel && !tradeValue) updates.trade_in_model = message.slice(0, 80);
      await updateConversation(conversation.id, updates);
      const summary = [year, makeLabel].filter(Boolean).join(' ') || 'your trade';
      const valueNote = tradeValue ? ` ($${tradeValue.toLocaleString()})` : '';
      if (conversation.intent === 'test_drive') {
        return `Perfect — ${summary}${valueNote} noted. We'll appraise it when you come in. When works best — mornings, afternoons, evenings, or a weekend?`;
      }
      return `Got it — ${summary}${valueNote} noted. Our team will work up a real number for the trade. When's a good time for a quick call?`;
    }

    // ── STAGE 5: DATETIME ─────────────────────────────────────
    if (conversation.stage === 'datetime' && !conversation.datetime) {
      let finalDateTime = message;
      if (lowerMsg.includes('today')) {
        finalDateTime = lowerMsg.includes('morning') ? 'Today morning' : lowerMsg.includes('evening') || lowerMsg.includes('tonight') ? 'Today evening' : 'Today afternoon';
      } else if (lowerMsg.includes('tomorrow')) {
        finalDateTime = lowerMsg.includes('morning') ? 'Tomorrow morning' : lowerMsg.includes('evening') ? 'Tomorrow evening' : 'Tomorrow afternoon';
      } else if (lowerMsg.includes('this weekend') || lowerMsg === 'weekend') {
        finalDateTime = 'This weekend';
      } else if (lowerMsg.includes('next week')) {
        finalDateTime = 'Next week';
      } else if (lowerMsg.includes('this morning')) {
        finalDateTime = 'Today morning';
      } else if (lowerMsg.includes('this afternoon')) {
        finalDateTime = 'Today afternoon';
      } else if (lowerMsg.includes('this evening') || lowerMsg.includes('tonight')) {
        finalDateTime = 'Today evening';
      } else if (lowerMsg.includes('anytime') || lowerMsg.includes('whenever') || lowerMsg.includes('asap') || lowerMsg.includes('now')) {
        finalDateTime = 'ASAP';
      }

      // After-hours awareness: flag if booked outside typical hours
      const nowHour = new Date().getHours();
      const isAfterHours = nowHour >= 21 || nowHour < 8; // After 9pm or before 8am
      await updateConversation(conversation.id, { datetime: finalDateTime, stage: 'confirmed', status: 'converted' });
      const data = {
        phone, name: conversation.customer_name, vehicleType: conversation.vehicle_type,
        budget: conversation.budget, budgetAmount: conversation.budget_amount, datetime: finalDateTime,
        userId
      };

      // A booked lead becomes a CRM entry, gets assigned by the round-robin
      // rules, and the rep who caught it gets told — none of which used to
      // happen for a Sarah lead. Before this, booking produced an
      // appointment row and a text to the managers, and the CRM only learned
      // about the customer if somebody later ran the manual import screen.
      // Best-effort and never in the way: a routing failure must not stop the
      // customer getting their confirmation.
      (async () => {
        try {
          const r = await leadRouting.captureAndRouteSarahLead({
            tenantId, userId,
            phone,
            name:        conversation.customer_name,
            vehicleType: conversation.vehicle_type,
            budget:      conversation.budget,
            detail:      conversation.vehicle_detail,
          });
          if (r.assigned && r.repId) {
            const what = conversation.vehicle_detail
              ? `${conversation.vehicle_type || 'Vehicle'} — "${conversation.vehicle_detail}"`
              : (conversation.vehicle_type || 'Vehicle TBD');
            await notifyRep({
              repUserId:  r.repId,
              fromNumber,
              body: `🎯 Lead assigned to you\n${conversation.customer_name || 'New lead'}\n${formatPretty(phone)}\n${what}\n${conversation.intent === 'test_drive' ? 'Appointment' : 'Callback'}: ${finalDateTime}`,
              twilioClient,
            });
          }
        } catch (e) { console.error('❌ sarah lead capture/route:', e.message); }
      })();

      // What the customer actually said they wanted, in their words. The
      // type alone ("Truck") tells a closer nothing; "crew cab, needs to tow"
      // tells them which two units to have pulled up front.
      const wanted = conversation.vehicle_detail
        ? `${conversation.vehicle_type || 'Vehicle'} — "${conversation.vehicle_detail}"`
        : (conversation.vehicle_type || 'Vehicle TBD');

      if (conversation.intent === 'test_drive') {
        await saveAppointment(data);
        try {
          await notifyTenantManagers({
            tenantId, fromNumber, twilioClient,
            body: `APPOINTMENT BOOKED!\n${conversation.customer_name}\n${formatPretty(phone)}\n${wanted} / ${conversation.budget || 'Budget TBD'}\nTime: ${finalDateTime}`,
          });
        } catch(e) { console.error('❌ manager notify failed:', e.message); }
        // Send customer a confirmation reminder 60s later
        setTimeout(async () => {
          try {
            const confirmMsg = `Hi ${conversation.customer_name.split(' ')[0]}! Just confirming your appointment at ${dealerName} for ${finalDateTime}. We're looking forward to seeing you! Reply anytime if anything changes.`;
            // A minute is long enough for someone to reply STOP in between.
            const cs = await sendCustomerSms(twilioClient, userId,
              { body: confirmMsg, from: fromNumber, to: phone }, 'appt_confirm');
            if (!cs.ok) console.log('🔇 Appt confirmation not sent:', cs.reason);
          } catch(e) { console.warn('⚠️ Appt confirmation SMS failed:', e.message); }
        }, 60000);
        await logAnalytics('appointment_booked', phone, data, userId);
        const afterHoursNote = isAfterHours ? ` Our team will confirm your time in the morning.` : '';
        return `Perfect ${conversation.customer_name}! You're all set for ${finalDateTime}.${afterHoursNote} We're at ${dealerName}${dealerCity ? ' in ' + dealerCity : ''}${deliveryArea ? ' and we deliver ' + deliveryArea : ''}. Our team will have everything ready for you.\n\nIf anything changes just text me back. See you soon!`;
      } else {
        await saveCallback(data);
        try {
          await notifyTenantManagers({
            tenantId, fromNumber, twilioClient,
            body: `CALLBACK REQUESTED!\n${conversation.customer_name}\n${formatPretty(phone)}\n${wanted}\nCall them: ${finalDateTime}`,
          });
        } catch(e) { console.error('❌ manager notify failed:', e.message); }
        await logAnalytics('callback_requested', phone, data, userId);
        return `Got it ${conversation.customer_name}! One of our team will call you ${finalDateTime}. They'll have all the details on ${conversation.vehicle_type || 'vehicle'} options in your range.\n\nIf anything comes up, just text me. Talk soon!`;
      }
    }

    // ── STAGE 6: CONFIRMED ────────────────────────────────────
    if (conversation.stage === 'confirmed') {
      if (lowerMsg.includes('reschedule') || lowerMsg.includes('change') || lowerMsg.includes('different time') || lowerMsg.includes('push')) {
        await updateConversation(conversation.id, { stage: 'datetime', datetime: null });
        return `No problem ${name}! What time works better?`;
      }
      if (lowerMsg.includes('cancel')) {
        await updateConversation(conversation.id, { status: 'active', stage: 'datetime', datetime: null, intent: conversation.intent });
        return `No worries ${name}! Want to pick a different time instead? Just let me know.`;
      }
      if (lowerMsg.includes('inventory') || lowerMsg.includes('photos') || lowerMsg.includes('pictures') || lowerMsg.includes('send')) {
        try {
          await notifyTenantManagers({
            tenantId, fromNumber, twilioClient,
            body: `PHOTOS REQUESTED\n${name}\n${formatPretty(phone)}\n${conversation.vehicle_type || '—'} / ${conversation.budget || '—'}`,
          });
        } catch(e) { console.error('❌ manager notify failed:', e.message); }
        await saveCallback({ phone, name, vehicleType: conversation.vehicle_type, budget: conversation.budget, budgetAmount: conversation.budget_amount, datetime: 'ASAP - Requested photos', userId });
        return `${name}, I've flagged it — someone will text you photos of what we've got in your range shortly!`;
      }
      if (lowerMsg.includes('warranty') || lowerMsg.includes('protection') || lowerMsg.includes('gap') || lowerMsg.includes('coverage')) {
        return `Great question ${name}! We offer full protection packages including payment coverage, powertrain warranty, GAP insurance, and tire & wheel. Your finance manager will walk you through all the options when you connect with our team.`;
      }
      if (lowerMsg.includes('payment') || lowerMsg.includes('first payment') || lowerMsg.includes('void') || lowerMsg.includes('cheque') || lowerMsg.includes('insurance') || lowerMsg.includes('pink slip')) {
        return `${name}, our finance team will go over all of that with you — payments, insurance, everything. They'll make sure it's all taken care of. Is there anything else I can help with?`;
      }
      if (lowerMsg.includes('thank') || lowerMsg.includes('thanks') || lowerMsg.includes('appreciate') || lowerMsg.includes('awesome') || lowerMsg.includes('perfect')) {
        return pick(
          `You're welcome ${name}! See you ${conversation.datetime || 'soon'}!`,
          `Anytime ${name}! Can't wait to get you behind the wheel. See you ${conversation.datetime || 'soon'}!`
        );
      }
      if (lowerMsg.includes('update') || lowerMsg.includes('status') || lowerMsg.includes('ready') || lowerMsg.includes('anything new')) {
        return `Still working on it ${name}! Quick heads up — if anyone from other dealerships reaches out, best not to engage. Conflicting info with the lenders can affect pre-approvals we have in place. I'll update you soon.`;
      }
      return `Hey ${name}! You're all set for ${conversation.datetime || 'your appointment'}. If you need to reschedule or have any questions, just text me back!`;
    }

    // ── FALLBACK ──────────────────────────────────────────────
    if (!conversation.vehicle_type || conversation.stage === 'greeting') {
      return pick("What type of vehicle are you looking for? Car, Truck, Van, or SUV?", "To find you the best match — are you thinking Car, Truck, Van, or SUV?");
    }
    if (conversation.stage === 'discovery') {
      return "Any particular make or model in mind? Or anything it has to have?";
    }
    if (!conversation.budget || conversation.stage === 'budget') {
      return `Where are you comfortable for monthly payments on a ${conversation.vehicle_type || 'vehicle'}? Just a rough number.`;
    }
    if (conversation.stage === 'appointment' && !conversation.intent) {
      return `${name ? name+', would' : 'Would'} you like to book a time to view one — we can deliver too — or would a quick call be a better start?`;
    }
    if (conversation.stage === 'name' && !name) {
      return "What's your name? I'll get everything set up for you.";
    }
    if (conversation.stage === 'datetime' && !conversation.datetime) {
      return conversation.intent === 'test_drive'
        ? `When works best${name ? ' '+name : ''}? We're flexible on timing.`
        : `When's the best time to call you${name ? ' '+name : ''}?`;
    }
    return `Hey${name ? ' '+name : ''}! Is there anything else I can help with? Just text me anytime.`;
  }


  // ── Reengage hold flush ──────────────────────────────────────────
  // The burst hold above buys one message of silence so a fragment is not
  // mistaken for a callback time. That is only safe if something guarantees
  // the second message is not required. Plenty of people send exactly one
  // reply and never text again — Gabriel did, on the live pilot — and a
  // lead sitting silently in a held stage is a lead nobody is told about.
  //
  // So the hold has a floor: after REENGAGE_HOLD_MAX_WAIT_SEC with nothing
  // further, this books the callback from what they did say, alerts the
  // manager, and sends the acknowledgement the hold withheld. The wait
  // lives in the database, not in a timer, so a restart cannot lose it.
  const HOLD_FLUSH_MS       = Number(process.env.REENGAGE_HOLD_FLUSH_MS || 60 * 1000);
  const HOLD_MAX_WAIT_SEC   = Number(process.env.REENGAGE_HOLD_MAX_WAIT_SEC || 180);

  async function flushReengageHolds() {
    let rows = [];
    try {
      // Claim and advance in one statement. Two workers (or a worker and a
      // customer's own next message) cannot both book the same person.
      const claimed = await pool.query(
        `WITH due AS (
           SELECT id, stage AS held_stage
             FROM conversations
            WHERE mode = 'reengage'
              AND stage IN ('reengage_held_y', 'reengage_held_q')
              AND updated_at < NOW() - ($1 || ' seconds')::interval
            ORDER BY updated_at ASC
            LIMIT 25
            FOR UPDATE SKIP LOCKED
         ), upd AS (
           UPDATE conversations c
              SET stage = 'reengage_done', status = 'converted', intent = 'callback',
                  datetime = LEFT(COALESCE(c.vehicle_detail, ''), 120),
                  updated_at = CURRENT_TIMESTAMP
             FROM due
            WHERE c.id = due.id
            RETURNING c.id, c.user_id, c.customer_phone, c.customer_name,
                      c.vehicle_detail, c.vehicle_type, c.credit_flag, due.held_stage
         )
         SELECT * FROM upd`,
        [String(HOLD_MAX_WAIT_SEC)]
      );
      rows = claimed.rows || [];
    } catch (e) {
      // A dead pool at boot, or the column set not migrated yet. Never throw
      // out of an interval.
      return;
    }
    if (!rows.length) return;
    console.log(`⏱️ Flushing ${rows.length} held reengage repl${rows.length === 1 ? 'y' : 'ies'}`);

    for (const row of rows) {
      const saidYes = row.held_stage === 'reengage_held_y';
      const words   = String(row.vehicle_detail || '').trim();
      const name    = row.customer_name || '';
      const first   = name ? name.split(' ')[0] : '';
      let ts = null, tenantId = null;
      try { ts = await getTenantSettings(row.user_id); } catch(e) {}
      try {
        const t = await pool.query(
          `SELECT tenant_id FROM desk_members WHERE user_id = $1 AND active = TRUE ORDER BY id ASC LIMIT 1`,
          [row.user_id]
        );
        tenantId = t.rows[0]?.tenant_id || null;
      } catch(e) {}
      const fromNumber = (ts && ts.twilioNumber) || null;
      const _raw     = String((ts && ts.salesName) || '').trim().split(/\s+/)[0] || '';
      const mgrFirst = _raw ? _raw.charAt(0).toUpperCase() + _raw.slice(1).toLowerCase() : '';
      const mgr      = mgrFirst ? `our sales manager ${mgrFirst}` : 'our sales manager';

      try {
        await saveCallback({
          phone: row.customer_phone, name: name || 'Reengage lead',
          vehicleType: row.vehicle_type || null,
          budget: null, budgetAmount: null,
          datetime: words.slice(0, 120) || 'no time given', userId: row.user_id,
        });
      } catch(e) { console.error('❌ hold flush saveCallback failed:', e.message); }

      try {
        await notifyTenantManagers({
          tenantId, fromNumber, twilioClient,
          body: `CALLBACK — REENGAGE\n${name || 'Unknown'}\n${formatPretty(row.customer_phone)}\n` +
                (saidYes ? 'Still looking.' : 'Not a clear yes.') +
                (words ? `\nThey said: "${words.slice(0, 160)}"` : '') +
                (row.credit_flag ? `\nCREDIT CASE.` : '') +
                `\nNo time given — call when you can.`,
        });
      } catch(e) { console.error('❌ hold flush notify failed:', e.message); }

      // The acknowledgement the hold withheld. Same words the FSM uses for a
      // reply that isn't a time, so the customer cannot tell a hold happened.
      if (fromNumber) {
        const reply = first
          ? `Thanks ${first} — I've passed that to ${mgr} and he'll give you a call.`
          : `Thanks — I've passed that to ${mgr} and he'll give you a call.`;
        try {
          const send = await guardedSmsSend(twilioClient, row.user_id, {
            body: reply, from: fromNumber, to: row.customer_phone,
          });
          if (send.ok) await saveMessage(row.id, row.customer_phone, 'assistant', reply, row.user_id);
        } catch(e) { console.error('❌ hold flush reply failed:', e.message); }
      }

      try {
        await logAnalytics('reengage_callback', row.customer_phone,
          { when: words.slice(0, 120), saidYes, flushed: true }, row.user_id);
      } catch(e) {}
    }
  }

  setInterval(flushReengageHolds, HOLD_FLUSH_MS).unref();


};
