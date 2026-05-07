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
const leadRouting = require('./lead-routing');

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
      // setup-database-v2.js has these migrations but isn't required
      // from index.js — the lead-intake INSERT relies on them, so own
      // them here to guarantee they run on deploy.
      await pool.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS vehicle_interest VARCHAR(100)`);
      await pool.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS budget_range     VARCHAR(50)`);
      await pool.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS follow_up_date   DATE`);
      await pool.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS follow_up_note   VARCHAR(255)`);
      await pool.query(`ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS last_contact     TIMESTAMP`);
      console.log('✅ lead_intake schema ready (desk_tenants.lead_intake_email + lead_intake_log + desk_crm cols)');
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

// ── ADF content → tenant lookup (fallback) ─────────────────────────
// When the recipient address didn't match any tenant's lead_intake_email
// (e.g., the lead arrived at a legacy/shared address like
// leads@firstfinancialcanada.com because the dealer's aggregator hasn't
// been re-pointed at their per-tenant address yet), inspect the ADF body
// for routing signals. Tried in order of reliability:
//   1. VIN — strongest. Two dealers can't have the same VIN in
//      inventory simultaneously.
//   2. Stock # — usually unique within a tenant; cross-dealer
//      collisions happen so we only accept a single-tenant match.
//   3. <vendor><vendorname> in the ADF — fuzzy substring match against
//      desk_tenants.dealership. Aggregators normalize this consistently
//      per dealer (Kijiji always sends "Hunt Chrysler Dodge Jeep Ram
//      Fiat" for Hunt). Bidirectional substring covers stored short
//      forms vs long forms in the feed.
// Returns { tenant, matchedBy, matchValue } or null.
async function resolveTenantByAdf(parsed) {
  const lead = parsed && parsed.lead;
  if (!lead) return null;
  const v = lead.vehicle || {};

  // 1. VIN
  if (v.vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(v.vin)) {
    const r = await pool.query(
      `SELECT DISTINCT tenant_id FROM desk_inventory
         WHERE UPPER(vin) = UPPER($1) AND tenant_id IS NOT NULL
         LIMIT 2`,
      [v.vin]
    );
    if (r.rows.length === 1) {
      const t = await pool.query(
        `SELECT id, tier FROM desk_tenants WHERE id = $1`,
        [r.rows[0].tenant_id]
      );
      if (t.rows.length) return { tenant: t.rows[0], matchedBy: 'vin', matchValue: v.vin };
    }
  }

  // 2. Stock #
  if (v.stock) {
    const r = await pool.query(
      `SELECT DISTINCT tenant_id FROM desk_inventory
         WHERE LOWER(stock) = LOWER($1) AND tenant_id IS NOT NULL
         LIMIT 2`,
      [v.stock]
    );
    if (r.rows.length === 1) {
      const t = await pool.query(
        `SELECT id, tier FROM desk_tenants WHERE id = $1`,
        [r.rows[0].tenant_id]
      );
      if (t.rows.length) return { tenant: t.rows[0], matchedBy: 'stock', matchValue: v.stock };
    }
  }

  // 3. Vendor name fuzzy match
  const vname = lead.vendor && lead.vendor.name;
  if (vname && vname.length >= 5) {
    const norm = (s) => String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const vn = norm(vname);
    const r = await pool.query(
      `SELECT id, tier, dealership FROM desk_tenants WHERE dealership IS NOT NULL`
    );
    const candidates = r.rows.filter(t => {
      const d = norm(t.dealership);
      if (!d || d.length < 5) return false;
      return vn.includes(d) || d.includes(vn);
    });
    if (candidates.length === 1) {
      return { tenant: candidates[0], matchedBy: 'vendor_name', matchValue: vname };
    }
  }

  return null;
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
    // Dedup: skip ONLY if a prior attempt successfully landed this message
    // in the CRM (status='ok'). Earlier failed attempts (no_tenant, no_adf,
    // parse_error, error) get a re-try — useful when fallback routing is
    // added or a tenant's intake address is repaired and historical drops
    // need to be replayed.
    if (summary.messageId) {
      const dup = await pool.query(
        `SELECT id, status FROM lead_intake_log WHERE message_id = $1 LIMIT 1`,
        [summary.messageId]
      );
      if (dup.rows.length && dup.rows[0].status === 'ok') {
        summary.status = 'duplicate';
        return summary;
      }
      if (dup.rows.length) {
        // Clear the stale failed entry so the new outcome can be logged.
        await pool.query(`DELETE FROM lead_intake_log WHERE message_id = $1`, [summary.messageId]);
      }
    }

    // Extract ADF early — content fields drive the fallback router below.
    const xml = extractAdfXml(parsedMail);
    let parsed = null;
    if (xml) parsed = parseAdfXml(xml);

    // Step 1 — try recipient-address routing (canonical, fast)
    const recipients = collectRecipients(parsedMail);
    let tenant = null;
    let matchedBy = null;
    for (const r of recipients) {
      tenant = await resolveTenantByAddress(r);
      if (tenant) {
        summary.intakeAddr = r;
        summary.tenantId   = tenant.id;
        matchedBy = 'address';
        break;
      }
    }

    // Step 2 — fallback to ADF content routing (rescues legacy/shared-
    // address traffic during a tenant's transition window).
    if (!tenant && parsed && parsed.ok) {
      const fb = await resolveTenantByAdf(parsed);
      if (fb) {
        tenant = fb.tenant;
        summary.tenantId   = fb.tenant.id;
        // Encode how we routed in intake_addr for ops visibility.
        summary.intakeAddr = '<' + fb.matchedBy + ':' + String(fb.matchValue || '').slice(0, 80) + '>';
        matchedBy = fb.matchedBy;
      }
    }

    if (!tenant) {
      summary.status = 'no_tenant';
      const vendorHint = (parsed && parsed.ok) ? '; ADF vendor=' + (parsed.lead.vendor.name || 'none') : '; no ADF';
      summary.error  = 'No tenant match. Recipients=' + recipients.join(',') + vendorHint;
      await logIntake(summary);
      return summary;
    }

    // We have a tenant. Now require ADF to actually create the CRM row.
    if (!xml) {
      summary.status = 'no_adf';
      summary.error  = 'No ADF XML found in attachments or body';
      await logIntake(summary);
      return summary;
    }
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

    // Hand off to the routing engine — assigns a rep based on the
    // tenant's rules, or leaves in the pool if no rule matches.
    // Failure to route is non-fatal: lead is still in the CRM pool.
    try {
      const routed = await leadRouting.routeLead({
        tenantId:   tenant.id,
        crmEntryId: summary.crmEntryId,
        source:     summary.source,
      });
      summary.routing = routed;
    } catch (re) {
      console.warn('[lead-intake] routing error:', re.message);
      summary.routing = { assigned: false, reason: 'route_error', error: re.message };
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
      tlsOptions: {
        servername: host,
        rejectUnauthorized: false,
      },
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

// ── Replay loop for backfilling dropped leads ──────────────────────
// Same code path as pollOnce() but searches with custom criteria
// (TO header / SINCE date) instead of UNSEEN, and never sets the Seen
// flag — replay must be idempotent. Powered by the dedup-on-success
// logic in processMessage so re-runs are safe and only previously-
// failed messages get a second chance.
//
// opts: { to?, since?, limit?, dryRun? }
//   to:      filter by To header substring (e.g. 'leads@firstfinancialcanada.com')
//   since:   filter by SINCE date string ('YYYY-MM-DD' or 'DD-MMM-YYYY')
//   limit:   stop after this many messages (default 200; admin endpoint trims)
//   dryRun:  walk + parse but don't call processMessage — count only
async function replayInbox(opts = {}) {
  const cfg = imapConfig();
  if (!cfg) return { status: 'not_configured' };
  const { imaps, simpleParser } = _deps();
  const limit  = parseInt(opts.limit, 10) || 200;
  const dryRun = !!opts.dryRun;

  // Build IMAP search criteria. ALL is required when no filters narrow it.
  const criteria = ['ALL'];
  if (opts.since) criteria.push(['SINCE', String(opts.since)]);
  if (opts.to)    criteria.push(['TO',    String(opts.to)]);

  let connection = null;
  try {
    connection = await imaps.connect(cfg);
    await connection.openBox('INBOX');
    const messages = await connection.search(criteria, {
      bodies: [''],
      markSeen: false,
      struct:   true,
    });

    const counts  = { ok: 0, duplicate: 0, no_tenant: 0, no_adf: 0, parse_error: 0, error: 0, dry: 0 };
    const samples = [];
    let processed = 0;
    for (const msg of messages) {
      if (processed >= limit) break;
      processed++;
      const all = msg.parts.find(p => p.which === '');
      if (!all || !all.body) continue;

      let parsedMail;
      try { parsedMail = await simpleParser(all.body); }
      catch (pe) {
        counts.error++;
        samples.push({ idx: processed, status: 'parse_mail_error', subject: '?', error: pe.message });
        continue;
      }

      if (dryRun) {
        counts.dry++;
        samples.push({
          idx: processed, status: 'dry',
          subject: (parsedMail.subject || '').slice(0, 80),
          date: parsedMail.date ? parsedMail.date.toISOString() : null,
          to: collectRecipients(parsedMail).slice(0, 3),
        });
        continue;
      }

      const summary = await processMessage(parsedMail, 'replay');
      counts[summary.status] = (counts[summary.status] || 0) + 1;
      samples.push({
        idx: processed,
        status: summary.status,
        subject: (parsedMail.subject || '').slice(0, 80),
        intakeAddr: summary.intakeAddr,
        tenantId: summary.tenantId,
        crmEntryId: summary.crmEntryId,
        error: summary.error || null,
      });
    }

    return {
      status: 'ok',
      candidates: messages.length,
      processed,
      limited: messages.length > processed,
      counts,
      samples,
    };
  } catch (e) {
    return { status: 'error', error: e.message };
  } finally {
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
  replayInbox,             // backfill dropped leads via IMAP search
  processMessage,          // exported for test hooks (feed a pre-parsed mail)
  resolveTenantByAddress,
  extractAdfXml,
  collectRecipients,
};
