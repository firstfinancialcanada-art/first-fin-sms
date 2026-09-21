// routes/meta-leads.js — Meta lead-ads webhook (SaaS prospects, NOT car buyers)
//
// Why this exists: Meta deletes the contact details on an instant-form lead
// after 90 days. On 2026-09-19 that cost ~35 of 46 paid leads — the names
// survive in Leads Center with email and phone stripped, so there is nothing
// left to export. Roughly $2k of spend with no way back.
//
// Leads land in platform_inquiries, the same table the landing-page form
// writes to, tagged source='facebook'. That's deliberate: the admin
// dashboard already lists, filters and works that table (pending/approve/
// contacted/reject), so Facebook leads show up in the one place Franco
// already looks instead of a second list to remember.
//
// These are prospects for SELLING the system to dealers and sales people.
// They never touch desk_crm — that table is car buyers, scoped per dealer
// tenant, worked by Sarah. Keeping them apart matters: Automaxx's customers
// and Franco's SaaS pipeline are different businesses.
'use strict';

const crypto = require('crypto');
const { pool } = require('../lib/db');

const GRAPH = 'https://graph.facebook.com/v21.0';

async function ensureColumns() {
  // platform_inquiries predates this; add what a Facebook lead needs.
  await pool.query(`
    ALTER TABLE platform_inquiries
      ADD COLUMN IF NOT EXISTS source      TEXT DEFAULT 'landing',
      ADD COLUMN IF NOT EXISTS external_id TEXT,
      ADD COLUMN IF NOT EXISTS meta        JSONB
  `).catch(() => {});
  // Meta retries deliveries, so the lead id has to be the dedupe key.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_inquiries_external
      ON platform_inquiries(external_id) WHERE external_id IS NOT NULL
  `).catch(() => {});
}

// Meta signs every POST with the app secret. Without this check, anyone who
// learns the URL can inject prospects.
function verifySignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return { ok: false, why: 'META_APP_SECRET not set' };
  const body = req.rawBody || Buffer.from(JSON.stringify(req.body));

  // Real deliveries carry X-Hub-Signature-256. The dashboard's "Send to
  // server" test only sends the older SHA-1 X-Hub-Signature, so a 256-only
  // check silently 403s every test — which is exactly what happened on
  // 2026-09-19 (logs showed the verify pings and no POST at all). Both are
  // HMACs keyed on the app secret, so accepting SHA-1 as a fallback costs
  // nothing; an unsigned request still gets rejected.
  const candidates = [
    { header: req.get('x-hub-signature-256'), algo: 'sha256', prefix: 'sha256=' },
    { header: req.get('x-hub-signature'),     algo: 'sha1',   prefix: 'sha1='   },
  ];
  for (const c of candidates) {
    if (!c.header) continue;
    const expected = c.prefix + crypto.createHmac(c.algo, secret).update(body, 'utf8').digest('hex');
    const a = Buffer.from(c.header);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
    return { ok: false, why: `${c.algo} signature mismatch` };
  }
  return { ok: false, why: 'no signature header' };
}

// Field names vary per form ("full_name", "email", "phone_number",
// "company_name", plus custom ones), so pull the common shapes and keep the
// whole payload in `meta` for anything unexpected.
function pickFields(fieldData) {
  const get = (...names) => {
    for (const n of names) {
      const f = (fieldData || []).find(x => (x.name || '').toLowerCase() === n);
      if (f && f.values && f.values[0]) return String(f.values[0]).slice(0, 200);
    }
    return null;
  };
  return {
    name:       get('full_name', 'name', 'first_name'),
    email:      get('email', 'email_address'),
    phone:      get('phone_number', 'phone', 'mobile_number'),
    dealership: get('company_name', 'company', 'dealership', 'dealership_name', 'business_name'),
  };
}

module.exports = function (app, { twilioClient } = {}) {
  ensureColumns().catch(e => console.error('❌ platform_inquiries columns:', e.message));

  // ── Meta's subscription handshake ───────────────────────────────────
  app.get('/api/webhooks/meta-leads', (req, res) => {
    const token = process.env.META_VERIFY_TOKEN;
    if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) {
      console.log('✅ Meta webhook verified');
      return res.status(200).send(req.query['hub.challenge']);
    }
    console.warn('⚠️ Meta webhook verify failed');
    res.sendStatus(403);
  });

  app.post('/api/webhooks/meta-leads', async (req, res) => {
    const sig = verifySignature(req);
    if (!sig.ok) {
      console.warn('⚠️ Meta webhook rejected:', sig.why);
      return res.sendStatus(403);
    }
    // Acknowledge immediately — Meta retries anything slow, and a retry
    // storm is worse than a late text.
    res.sendStatus(200);

    try {
      for (const entry of req.body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'leadgen') continue;
          await handleLead(change.value || {}, twilioClient);
        }
      }
    } catch (e) {
      console.error('❌ meta-leads processing:', e.message);
    }
  });

  // META_PAGE_TOKEN now holds a SYSTEM USER token (never expires, created
  // 2026-09-20 in the First-Fin business portfolio). The token before it was
  // a short-lived page token that died Saturday 19 Sept 14:00 PDT without
  // anyone noticing — every lead after that would have been stored as
  // "(no name)" with no way to call it back.
  //
  // Page-scoped endpoints reject a system-user token outright ("Invalid
  // OAuth 2.0 Access Token" on /{page}/subscribed_apps, verified). The
  // standard move is to ask the Page for its own access token using the
  // system-user token; one derived from a never-expiring token doesn't
  // expire either (debug_token: type PAGE, expires NEVER). Cached per Page so
  // it's one extra Graph call per process, not per lead. If derivation fails
  // — e.g. someone puts a plain page token back in the env — fall back to
  // using the env value as-is, which is what that case needs anyway.
  const _pageTokens = new Map();
  async function pageTokenFor(pageId) {
    const base = process.env.META_PAGE_TOKEN;
    if (!base || !pageId) return base || null;
    if (_pageTokens.has(pageId)) return _pageTokens.get(pageId);
    try {
      const r = await fetch(`${GRAPH}/${pageId}?fields=access_token&access_token=${encodeURIComponent(base)}`);
      const j = await r.json();
      if (j && j.access_token) {
        _pageTokens.set(pageId, j.access_token);   // only cache a success
        return j.access_token;
      }
      if (j && j.error) console.warn('⚠️ page token derivation:', j.error.message);
    } catch (e) { console.warn('⚠️ page token derivation:', e.message); }
    // Not cached: a transient failure shouldn't pin the fallback for the
    // life of the process. Leads are rare enough that retrying is free.
    return base;
  }

  async function handleLead(v, twilio) {
    const token = await pageTokenFor(v.page_id);
    let detail = {};
    if (token && v.leadgen_id) {
      try {
        const r = await fetch(`${GRAPH}/${v.leadgen_id}?access_token=${encodeURIComponent(token)}`);
        if (r.ok) detail = await r.json();
        else console.error('❌ Graph lead fetch:', r.status, (await r.text()).slice(0, 200));
      } catch (e) { console.error('❌ Graph lead fetch:', e.message); }
    }

    const f = pickFields(detail.field_data);
    // Store even when the Graph fetch failed: the leadgen_id alone lets us
    // go back for the details, which beats losing the lead entirely. phone
    // is NOT NULL on this table, so fall back to a placeholder rather than
    // dropping the row.
    const { rows } = await pool.query(
      `INSERT INTO platform_inquiries (name, dealership, phone, email, source, external_id, meta, status)
       VALUES ($1,$2,$3,$4,'facebook',$5,$6,'pending')
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
       RETURNING id, name, dealership, phone, email`,
      [
        f.name || '(no name)',
        f.dealership || null,
        f.phone || '—',
        f.email || null,
        v.leadgen_id || null,
        JSON.stringify({ field_data: detail.field_data || null, form_id: v.form_id, ad_id: v.ad_id, page_id: v.page_id }),
      ]
    );
    if (!rows.length) return;   // duplicate delivery, already have it

    const lead = rows[0];
    console.log(`🎯 Facebook lead: ${lead.name} ${lead.email || ''} ${lead.phone || ''}`);

    // Same alert path as a landing-page inquiry, so there's one phone number
    // to keep configured and one message shape to recognize.
    const ownerPhone = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;
    if (twilio && ownerPhone && process.env.TWILIO_PHONE_NUMBER) {
      const body = `New Facebook lead — ${lead.dealership || 'no dealership'}, ${lead.name}, ${lead.phone}${lead.email ? ', ' + lead.email : ''}`;
      try {
        await twilio.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to: ownerPhone });
      } catch (e) {
        console.error('❌ Facebook lead alert failed:', e.message);
      }
    } else {
      console.warn('⚠️ No owner phone / Twilio — lead stored, no text sent');
    }
  }
};
