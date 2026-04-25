// lib/lead-intake.js — Email-based ADF lead ingestion poller
//
// Polls a Gmail inbox via IMAP every LEADS_POLL_INTERVAL_SEC seconds,
// looks for unseen messages that contain ADF XML (either as an
// attachment or inline in the body), parses them via lib/adf-parser,
// resolves the recipient address to a tenant, and inserts a CRM row
// scoped to that tenant with assigned_rep_id routed through the
// rules engine (Build 3 — not yet present; for now leads land in the
// pool with assigned_rep_id = NULL).
//
// Design choices:
// - imap-simple + mailparser for the mail side — battle-tested combo.
// - Tenant is resolved from the original recipient. Cloudflare Email
//   Routing preserves the original To: when forwarding, so if mail was
//   sent to miltonchrysler@firstfinancialcanada.com and forwarded to
//   firstfinleads@gmail.com, the Gmail message still carries
//   miltonchrysler@firstfinancialcanada.com in its To/Delivered-To/
//   Original-To headers. We check all of those, fall back to the
//   top-level `to` field.
// - Tenants opt in via an entry in the desk_tenants.lead_intake_email
//   column (added here idempotently). Empty tenants are ignored.
// - Marking messages as \Seen after processing is the "poll cursor" —
//   no separate state needed. If processing fails, we don't mark read
//   so the next poll retries.
// - Fail-open: any single email failing doesn't stop the loop.
'use strict';

const { pool } = require('./db');
const { parseAdfXml, leadToCrmRow } = require('./adf-parser');

// These are required at use-time (not top-of-file) so that envs without
// lead intake configured don't pay the require cost or fail if the
// optional deps aren't installed yet. Both ship in package.json.
let _imaps = null;
let _simpleParser = null;
function _deps() {
  if (!_imaps)        _imaps = require('imap-simple');
  if (!_simpleParser) _simpleParser = require('mailparser').simpleParser;
  return { imaps: _imaps, simpleParser: _simpleParser };
}

// ── Schema migration (idempotent, runs once on require) ────────────
// Adds lead_intake_email to desk_tenants (the forwarding address the
// dealer was told to use — UNIQUE so we can resolve tenant by address).
// Also creates lead_intake_log to record every processed message for
// audit/debugging and to dedupe on Message-Id.
let _initPromise = null;
function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      await pool.query(`
        ALTER TABLE desk_tenants
          ADD COLUMN IF NOT EXISTS lead_intake_email VARCHAR(255)
      `);
      // Partial unique index: only enforce uniqueness when the value is
      // non-null. Allows many tenants to have no intake address without
      // collision on empty strings.
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_lead_intake_email
          ON desk_tenants(lead_intake_email)
          WHERE lead_intake_email IS NOT NULL
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS lead_intake_log (
          id            SERIAL PRIMARY KEY,
          tenant_id     INTEGER REFERENCES desk_tenants(id) ON DELETE SET NULL,
          message_id    TEXT UNIQUE,
          intake_addr   TEXT,
          sender_from   TEXT,
          subject       TEXT,
          source        TEXT,
          prospect_id   TEXT,
          crm_entry_id  INTEGER REFERENCES desk_crm(id) ON DELETE SET NULL,
          status        TEXT NOT NULL DEFAULT 'ok',
          error         TEXT,
          processed_at  TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_lead_log_tenant
          ON lead_intake_log(tenant_id, processed_at DESC);
      `);
      console.log('✅ lead_intake schema ready (desk_tenants.lead_intake_email + lead_intake_log)');
    } catch (e) {
      console.error('❌ lead_intake init:', e.message);
    }
  })();
  return _initPromise;
}
init();

// ── Address → tenant lookup ────────────────────────────────────────
// Case-insensitive match against desk_tenants.lead_intake_email.
// Strips any +tag so "leads+extra@foo" matches "leads@foo" too
// (we don't use plus-addressing in the primary scheme but some
// providers might append one).
async function resolveTenantByAddress(addr) {
  if (!addr) return null;
  const clean = String(addr).toLowerCase().trim().replace(/\+[^@]*@/, '@');
  const { rows } = await pool.query(
    `SELECT id, tier FROM desk_tenants
      WHERE LOWER(lead_intake_email) = $1 LIMIT 1`,
    [clean]
  );
  return rows[0] || null;
}

// ── Extract ADF XML from a parsed email ────────────────────────────
// Tries, in order:
//   1. Any attachment whose filename ends in .xml or content-type is
//      application/xml / text/xml.
//   2. Inline text that looks like ADF (has <adf> or <prospect> tag).
// Returns the raw XML string or null.
function extractAdfXml(parsedMail) {
  // Attachments first
  const atts = Array.isArray(parsedMail.attachments) ? parsedMail.attachments : [];
  for (const a of atts) {
    const name = (a.filename || '').toLowerCase();
    const ctype = (a.contentType || '').toLowerCase();
    const isXml = name.endsWith('.xml') || /xml/i.test(ctype);
    if (!isXml) continue;
    if (!a.content) continue;
    const txt = Buffer.isBuffer(a.content)
      ? a.content.toString('utf8')
      : String(a.content);
    if (/<adf|<prospect/i.test(txt)) return txt;
  }
  // Inline body — some providers inline the XML instead of attaching it
  const candidates = [parsedMail.text, parsedMail.html].filter(Boolean);
  for (const body of candidates) {
    const s = String(body);
    const m = s.match(/<\?xml[\s\S]*?<\/adf>/i) || s.match(/<adf[\s\S]*?<\/adf>/i);
    if (m) return m[0];
  }
  return null;
}

// ── Pull every plausible recipient address from a parsed mail ──────
// Cloudflare Email Routing forwards preserve the original To: but some
// providers mangle it. We pull from everywhere we can see, dedupe,
// lowercase, and return the first one that matches a tenant.
function collectRecipients(parsedMail) {
  const out = new Set();
  const pushAddr = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      // Rough email regex — headers can have "Name <addr>" or just addr
      const m = v.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g);
      if (m) m.forEach(x => out.add(x.toLowerCase()));
      return;
    }
    if (Array.isArray(v))           return v.forEach(pushAddr);
    if (v.value && Array.isArray(v.value)) return v.value.forEach(pushAddr);
    if (v.address)                   out.add(String(v.address).toLowerCase());
    if (v.text)                      return pushAddr(v.text);
  };
  pushAddr(parsedMail.to);
  pushAddr(parsedMail.cc);
  pushAddr(parsedMail.bcc);
  // mailparser exposes headers as a Map; pull the raw forwarding hints
  const hdrs = parsedMail.headers;
  if (hdrs && typeof hdrs.get === 'function') {
    ['delivered-to', 'x-original-to', 'x-forwarded-to', 'envelope-to'].forEach(h => {
      const v = hdrs.get(h);
      if (v) pushAddr(String(v));
    });
  } else if (hdrs && typeof hdrs === 'object') {
    ['delivered-to', 'x-original-to', 'x-forwarded-to', 'envelope-to'].forEach(h => {
      if (hdrs[h]) pushAddr(String(hdrs[h]));
    });
  }
  return [...out];
}

// ── Process a single message ───────────────────────────────────────
// Returns a summary object. Does NOT throw — all errors logged and
// surfaced via the `status`/`error` fields.
async function processMessage(parsedMail, rawSource = 'imap') {
  const summary = {
    messageId:  parsedMail.messageId || null,
    from:       (parsedMail.from && parsedMail.from.text) || null,
    subject:    parsedMail.subject || null,
    intakeAddr: null,
    tenantId:   null,
    source:     null,
    prospectId: null,
    crmEntryId: null,
    status:     'skipped',
    error:      null,
  };

  try {
    // Dedup: if we've already logged this message_id, stop.
    if (summary.messageId) {
      const dup = await pool.query(
        `SELECT id FROM lead_intake_log WHERE message_id = $1 LIMIT 1`,
        [summary.messageId]
      );
      if (dup.rows.length) {
        summary.status = 'duplicate';
        return summary;
      }
    }

    // Resolve tenant from recipient(s)
    const recipients = collectRecipients(parsedMail);
    let tenant = null;
    for (const r of recipients) {
      tenant = await resolveTenantByAddress(r);
      if (tenant) {
        summary.intakeAddr = r;
        summary.tenantId   = tenant.id;
        break;
      }
    }
    if (!tenant) {
      summary.status = 'no_tenant';
      summary.error  = 'Recipient did not match any tenant. Checked: ' + recipients.join(', ');
      await logIntake(summary);
      return summary;
    }

    // Extract ADF XML
    const xml = extractAdfXml(parsedMail);
    if (!xml) {
      summary.status = 'no_adf';
      summary.error  = 'No ADF XML found in attachments or body';
      await logIntake(summary);
      return summary;
    }

    // Parse
    const parsed = parseAdfXml(xml);
    if (!parsed.ok) {
      summary.status = 'parse_error';
      summary.error  = parsed.error;
      await logIntake(summary);
      return summary;
    }
    summary.source     = parsed.lead.source;
    summary.prospectId = parsed.lead.prospectId;

    // Build the CRM row and insert, scoped to tenant, unassigned pool.
    // Build 3's routing engine will set assigned_rep_id; until then,
    // leads land in the pool and any rep with pool_plus_own can see
    // + claim them.
    const row = leadToCrmRow(parsed.lead);
    const client = await pool.connect();
    try {
      const ins = await client.query(
        `INSERT INTO desk_crm
           (tenant_id, user_id, assigned_rep_id, name, phone, email,
            vehicle_interest, budget_range, status, source, notes, last_contact)
         VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING id`,
        [
          tenant.id,
          row.name, row.phone, row.email,
          row.vehicle_interest, row.budget_range,
          row.status, row.source, row.notes,
        ]
      );
      summary.crmEntryId = ins.rows[0].id;
      summary.status     = 'ok';
    } finally {
      client.release();
    }

    await logIntake(summary);
    return summary;
  } catch (e) {
    summary.status = 'error';
    summary.error  = String(e.message || e).slice(0, 400);
    try { await logIntake(summary); } catch {}
    return summary;
  }
}

async function logIntake(summary) {
  try {
    await pool.query(
      `INSERT INTO lead_intake_log
         (tenant_id, message_id, intake_addr, sender_from, subject,
          source, prospect_id, crm_entry_id, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (message_id) DO NOTHING`,
      [
        summary.tenantId, summary.messageId, summary.intakeAddr,
        summary.from, summary.subject, summary.source,
        summary.prospectId, summary.crmEntryId,
        summary.status, summary.error,
      ]
    );
  } catch (e) {
    console.warn('[lead-intake] log insert:', e.message);
  }
}

// ── IMAP poll loop ─────────────────────────────────────────────────
// Connects to the configured IMAP, searches for UNSEEN messages in the
// INBOX, processes each, marks as Seen on success. Runs on a timer so
// a single crashed poll doesn't kill the loop.
let _pollTimer = null;
let _isPolling = false;

function imapConfig() {
  const user = process.env.LEADS_IMAP_USER;
  const pass = process.env.LEADS_IMAP_PASS;
  const host = process.env.LEADS_IMAP_HOST || 'imap.gmail.com';
  const port = parseInt(process.env.LEADS_IMAP_PORT || '993', 10);
  if (!user || !pass) return null;
  return {
    imap: {
      user, password: pass, host, port,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true },
    },
  };
}

async function pollOnce() {
  if (_isPolling) return { status: 'busy' };
  const cfg = imapConfig();
  if (!cfg) return { status: 'not_configured' };

  _isPolling = true;
  const { imaps, simpleParser } = _deps();
  let connection = null;
  try {
    connection = await imaps.connect(cfg);
    await connection.openBox('INBOX');

    // Search UNSEEN only — processing marks them Seen so they don't
    // show up again.
    const messages = await connection.search(['UNSEEN'], {
      bodies: [''],
      markSeen: false,  // we mark Seen only on success
      struct:   true,
    });

    const results = [];
    for (const msg of messages) {
      const all    = msg.parts.find(p => p.which === '');
      const raw    = all ? all.body : '';
      let parsed;
      try {
        parsed = await simpleParser(raw);
      } catch (pe) {
        results.push({ messageId: null, status: 'parse_mail_error', error: pe.message });
        continue;
      }
      const summary = await processMessage(parsed);
      // Mark seen IF we successfully logged (ok / skipped / no_adf / no_tenant / duplicate)
      // — only leave UNSEEN on hard errors so the next poll retries.
      if (summary.status !== 'error') {
        try {
          await connection.addFlags(msg.attributes.uid, '\\Seen');
        } catch {}
      }
      results.push(summary);
    }

    return { status: 'ok', processed: results.length, results };
  } catch (e) {
    console.error('[lead-intake] poll error:', e.message);
    return { status: 'error', error: e.message };
  } finally {
    _isPolling = false;
    if (connection) { try { connection.end(); } catch {} }
  }
}

function startPolling() {
  const cfg = imapConfig();
  if (!cfg) {
    console.log('⚠ lead-intake: LEADS_IMAP_USER/PASS not set, polling disabled');
    return;
  }
  const intervalSec = parseInt(process.env.LEADS_POLL_INTERVAL_SEC || '30', 10);
  console.log(`✅ lead-intake polling every ${intervalSec}s (${cfg.imap.user} @ ${cfg.imap.host})`);
  // First poll fires after a short delay so startup logs are clean
  setTimeout(() => pollOnce().catch(() => {}), 5000);
  _pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, intervalSec * 1000);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

module.exports = {
  init,
  startPolling,
  stopPolling,
  pollOnce,
  processMessage,          // exported for test hooks (feed a pre-parsed mail)
  resolveTenantByAddress,
  extractAdfXml,
  collectRecipients,
};
