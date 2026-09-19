// routes/meta-leads.js — Meta lead-ads webhook (SaaS prospects, NOT car buyers)
//
// Why this exists: Meta deletes the contact details on an instant-form lead
// after 90 days. On 2026-09-19 that cost us ~35 of 46 paid leads — the names
// survive in Leads Center with the email and phone stripped out, so there is
// nothing to export. Roughly $2k of spend with no way back.
//
// These are prospects for selling the First-Fin system to dealers and sales
// people. They deliberately do NOT go into desk_crm: that table is car
// buyers, scoped per dealer tenant, and Sarah works it. Mixing the two would
// put Franco's SaaS pipeline in front of Automaxx's customers.
//
// Flow: Meta POSTs a leadgen event -> we fetch the field values from the
// Graph API with the page token -> store in saas_leads -> text Franco.
// Speed matters more than anything here: a lead answered in minutes beats
// one answered tomorrow.
'use strict';

const crypto = require('crypto');
const { pool } = require('../lib/db');

const GRAPH = 'https://graph.facebook.com/v21.0';

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saas_leads (
      id            SERIAL PRIMARY KEY,
      leadgen_id    VARCHAR(64) UNIQUE,     -- Meta's id; the dedupe key on retries
      form_id       VARCHAR(64),
      form_name     VARCHAR(160),
      page_id       VARCHAR(64),
      ad_id         VARCHAR(64),
      campaign_name VARCHAR(160),
      full_name     VARCHAR(160),
      email         VARCHAR(200),
      phone         VARCHAR(40),
      company       VARCHAR(160),
      raw           JSONB,                  -- every field Meta sent, verbatim
      created_time  TIMESTAMPTZ,
      received_at   TIMESTAMPTZ DEFAULT NOW(),
      notified      BOOLEAN DEFAULT FALSE,
      status        VARCHAR(30) DEFAULT 'new',
      notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saas_leads_received ON saas_leads(received_at DESC);
  `);
}

// Meta signs every POST with the app secret. Without this check anyone who
// learns the URL can inject prospects.
function verifySignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return { ok: false, why: 'META_APP_SECRET not set' };
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(req.rawBody || Buffer.from(JSON.stringify(req.body)), 'utf8')
    .digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, why: 'signature length mismatch' };
  return { ok: crypto.timingSafeEqual(a, b), why: 'signature mismatch' };
}

// Meta's field names vary by form ("full_name", "email", "phone_number",
// "company_name", plus anything custom), so keep the raw payload and pull
// the common ones out for the text message and the list view.
function pickFields(fieldData) {
  const get = (...names) => {
    for (const n of names) {
      const f = (fieldData || []).find(x => (x.name || '').toLowerCase() === n);
      if (f && f.values && f.values[0]) return String(f.values[0]).slice(0, 200);
    }
    return null;
  };
  return {
    full_name: get('full_name', 'name', 'first_name'),
    email:     get('email', 'email_address'),
    phone:     get('phone_number', 'phone', 'mobile_number'),
    company:   get('company_name', 'company', 'dealership', 'dealership_name'),
  };
}

module.exports = function (app, { twilioClient } = {}) {
  ensureTable().catch(e => console.error('❌ saas_leads table:', e.message));

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
          const v = change.value || {};
          await handleLead(v, twilioClient);
        }
      }
    } catch (e) {
      console.error('❌ meta-leads processing:', e.message);
    }
  });

  async function handleLead(v, twilio) {
    const token = process.env.META_PAGE_TOKEN;
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
    // go back for the details, which beats losing the lead entirely.
    const { rows } = await pool.query(
      `INSERT INTO saas_leads
         (leadgen_id, form_id, page_id, ad_id, campaign_name, full_name, email, phone, company, raw, created_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (leadgen_id) DO NOTHING
       RETURNING id, full_name, email, phone, company`,
      [
        v.leadgen_id || null,
        v.form_id || null,
        v.page_id || null,
        v.ad_id || null,
        detail.campaign_name || null,
        f.full_name, f.email, f.phone, f.company,
        JSON.stringify(detail.field_data || v),
        detail.created_time || (v.created_time ? new Date(v.created_time * 1000).toISOString() : null),
      ]
    );
    if (!rows.length) return;   // duplicate delivery, already have it

    const lead = rows[0];
    console.log(`🎯 SaaS lead: ${lead.full_name || '(no name)'} ${lead.email || ''} ${lead.phone || ''}`);

    const to = process.env.SAAS_LEAD_ALERT_PHONE;
    if (twilio && to && process.env.TWILIO_PHONE_NUMBER) {
      const body = [
        '🎯 New First-Fin lead',
        lead.full_name || '(no name)',
        lead.company || '',
        lead.phone || '',
        lead.email || '',
      ].filter(Boolean).join('\n');
      try {
        await twilio.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
        await pool.query('UPDATE saas_leads SET notified = TRUE WHERE id = $1', [lead.id]);
      } catch (e) {
        console.error('❌ SaaS lead alert failed:', e.message);
      }
    } else {
      console.warn('⚠️ SAAS_LEAD_ALERT_PHONE / Twilio not configured — lead stored, no text sent');
    }
  }

  // ── Read them back (admin token, same guard style as the rest) ──────
  app.get('/api/saas-leads', async (req, res) => {
    const token = req.get('x-admin-token') || req.query.token;
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) return res.sendStatus(403);
    try {
      const { rows } = await pool.query(
        `SELECT id, created_time, received_at, full_name, email, phone, company,
                form_id, campaign_name, status, notes
         FROM saas_leads ORDER BY received_at DESC LIMIT 500`
      );
      if (req.query.format === 'csv') {
        const esc = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
        const head = 'received_at,created_time,name,company,email,phone,campaign,status,notes';
        const body = rows.map(r => [r.received_at, r.created_time, r.full_name, r.company,
          r.email, r.phone, r.campaign_name, r.status, r.notes].map(esc).join(','));
        res.type('text/csv').send([head, ...body].join('\n'));
      } else {
        res.json({ success: true, count: rows.length, leads: rows });
      }
    } catch (e) {
      console.error('❌ /api/saas-leads:', e.message);
      res.status(500).json({ success: false });
    }
  });
};
