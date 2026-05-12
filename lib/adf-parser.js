// lib/adf-parser.js — Auto-Lead Data Format (ADF) XML parser
//
// ADF is the auto-industry standard for dealer lead feeds. AutoTrader,
// Kijiji, CarCostCanada, and TAQ all send leads as email attachments
// or inline XML bodies in this format. This module takes the raw XML
// string and returns a normalized object the rest of the stack can
// use to create CRM rows.
//
// The real-world ADF sample we tested against came from Hunt Chrysler
// via Mil Radenkovic (2026-04-23 SMS) — see
// project_hunt_chrysler_deal.md memory for the full source XML.
//
// Design:
// - fast-xml-parser in "preserve CDATA / decode entities" mode so
//   ADF's <![CDATA[…]]> sections come through as plain strings.
// - Tolerant of missing fields — ADF feeds from different providers
//   include different optional blocks. Every field in the output is
//   nullable; caller decides what's required.
// - Source-name normalization — raw provider names are messy
//   ("AutoTrader" vs "Trader" vs "autotrader.ca") so we snap each to
//   a known tag used elsewhere in the platform (routing rules etc.).
'use strict';

// fast-xml-parser is lazy-loaded inside parseAdfXml so the rest of the
// module (normalizeSource, leadToCrmRow, parsePlainTextLead, …) stays
// usable in environments where the optional dep isn't installed — e.g.
// quick local smoke tests of the plain-text parsers.
let _XMLParser = null;
function getXmlParser() {
  if (!_XMLParser) _XMLParser = require('fast-xml-parser').XMLParser;
  return _XMLParser;
}

// ── Known lead sources, with detection patterns ────────────────────
// First match wins. Order matters — put specific patterns before
// generic catch-alls. 'Other' is the fallback if nothing matches.
const SOURCE_PATTERNS = [
  { tag: 'AutoTrader',    rx: /\b(auto\s*trader|autotrader)\b/i },
  { tag: 'Kijiji',        rx: /\bkijiji\b/i },
  { tag: 'CarCostCanada', rx: /\bcar\s*cost\s*canada\b/i },
  { tag: 'TAQ',           rx: /\btaq\b/i },
  { tag: 'CarGurus',      rx: /\bcar\s*gurus\b/i },
  { tag: 'Facebook',      rx: /\bfacebook|\bfb\s*marketplace\b/i },
  { tag: 'DealerWebsite', rx: /\bdealer\s*website|\bwebsite\b/i },
];

function normalizeSource(rawName) {
  const s = String(rawName || '').trim();
  if (!s) return 'Other';
  for (const { tag, rx } of SOURCE_PATTERNS) {
    if (rx.test(s)) return tag;
  }
  // If no pattern matches, keep the raw name but trimmed to 40 chars
  // so we don't end up with novel-length source strings in the CRM.
  return s.slice(0, 40);
}

// ── Helpers: safely read a field that might be string, {#text:...}, or array ──
// fast-xml-parser returns different shapes depending on whether an
// element has attributes, repeats, or is plain text. These walkers
// normalize to string | null regardless.
function txt(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    if ('#text' in node) return txt(node['#text']);
    if (Array.isArray(node)) return txt(node[0]);
  }
  return null;
}

function attr(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return attr(node[0], key);
  const v = node['@_' + key];
  return v != null ? String(v) : null;
}

// Ensure array shape for repeated elements (fast-xml-parser returns
// a single object when there's one match, an array when there's >1).
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// ── Main: parse an ADF XML string ──────────────────────────────────
// Returns { ok, lead, error } — if ok=true, lead is a fully-normalized
// record ready to insert into desk_crm. If ok=false, error describes
// what went wrong and lead is null.
//
// Lead shape:
//   {
//     source:        'AutoTrader' | 'Kijiji' | ...  (normalized)
//     sourceRaw:     original provider string
//     requestDate:   ISO 8601 string or null
//     prospectId:    string or null (the <id> from <customer>)
//     vehicle: { year, make, model, trim, priceMsrp, priceCurrency,
//                interest, status, options: string[] }
//     customer: { name, firstName, lastName, phone, email,
//                 addressStreet, addressCity, addressRegion,
//                 addressPostal, addressCountry }
//     comments:      string or null
//     vendor: { name, contacts: [{name, email, phone}] }
//     raw:           the parsed object (for debugging; may be stripped later)
//   }
function parseAdfXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') {
    return { ok: false, lead: null, error: 'XML string required' };
  }

  const XMLParser = getXmlParser();
  const parser = new XMLParser({
    ignoreAttributes:       false,
    attributeNamePrefix:    '@_',
    textNodeName:           '#text',
    parseTagValue:          true,
    parseAttributeValue:    false,
    trimValues:             true,
    cdataPropName:          false,      // inline CDATA as plain strings
    removeNSPrefix:         true,
    processEntities:        true,
  });

  let doc;
  try {
    doc = parser.parse(xmlString);
  } catch (e) {
    return { ok: false, lead: null, error: 'XML parse error: ' + e.message };
  }

  // Most feeds wrap everything in <adf><prospect>…</prospect></adf>.
  // A few rogue senders ship the prospect at the root. Handle both.
  const prospect = doc.adf?.prospect || doc.prospect;
  if (!prospect) {
    return { ok: false, lead: null, error: 'No <prospect> element found' };
  }

  // ── Vehicle block ─────────────────────────────────────────────────
  const v = prospect.vehicle || {};
  // ADF allows two shapes: <option>Hard top</option> (text node) or
  // <option><optionname>Hard top</optionname></option> (structured).
  // Support both — fall back to the option's own text when no nested
  // <optionname> exists.
  const options = asArray(v.option)
    .map(o => txt(o?.optionname) || txt(o))
    .filter(Boolean);

  const vehicle = {
    year:          txt(v.year),
    make:          txt(v.make),
    model:         txt(v.model),
    trim:          txt(v.trim),
    vin:           txt(v.vin),                // 17-char VIN — strongest tenant-routing signal
    stock:         txt(v.stock),              // dealer's stock #, less reliable (cross-dealer collisions)
    bodystyle:     txt(v.bodystyle),
    interest:      attr(v, 'interest'),       // 'buy' | 'lease' | 'trade' | 'sell'
    status:        attr(v, 'status'),         // 'new' | 'used'
    priceMsrp:     null,
    priceCurrency: null,
    options,
  };
  // <price> can repeat (msrp vs retail). Prefer msrp.
  const prices = asArray(v.price);
  const msrp   = prices.find(p => attr(p, 'type') === 'msrp') || prices[0];
  if (msrp) {
    vehicle.priceMsrp     = txt(msrp) ? parseFloat(String(txt(msrp)).replace(/[^\d.]/g, '')) || null : null;
    vehicle.priceCurrency = attr(msrp, 'currency');
  }

  // ── Customer block ────────────────────────────────────────────────
  const cust    = prospect.customer || {};
  const contact = cust.contact || {};

  // Name can arrive as a single <name part="full">…</name> OR
  // separate first/last parts. Handle both.
  const names = asArray(contact.name);
  let nameFull = null, firstName = null, lastName = null;
  for (const n of names) {
    const part = attr(n, 'part');
    const val  = txt(n);
    if (!val) continue;
    if (part === 'full')         nameFull  = val;
    else if (part === 'first')   firstName = val;
    else if (part === 'last')    lastName  = val;
    else if (!nameFull)          nameFull  = val;  // fallback
  }
  if (!nameFull && (firstName || lastName)) {
    nameFull = [firstName, lastName].filter(Boolean).join(' ');
  }

  const address = asArray(contact.address)[0] || {};
  const phones  = asArray(contact.phone);
  const emails  = asArray(contact.email);

  const customer = {
    name:           nameFull,
    firstName,
    lastName,
    phone:          txt(phones[0]),
    email:          txt(emails[0]),
    addressStreet:  txt(address.street),
    addressCity:    txt(address.city),
    addressRegion:  txt(address.regioncode),
    addressPostal:  txt(address.postalcode),
    addressCountry: txt(address.country),
  };

  // ── Customer-level id + comments ──────────────────────────────────
  // ADF spec puts <comments> as a sibling of <customer> at the prospect
  // level, but some malformed feeds nest it inside <customer>. Accept
  // both — prospect-level wins.
  const ids       = asArray(cust.id);
  const prospectId = ids.length ? (txt(ids[0]) || attr(ids[0], 'source')) : null;
  const comments   = txt(prospect.comments) || txt(cust.comments);

  // ── Vendor / provider blocks ──────────────────────────────────────
  // <vendor> is the DEALERSHIP receiving the lead.
  // <provider> is the LEAD SOURCE company (AutoTrader, Kijiji…).
  const vendor       = prospect.vendor   || {};
  const providerNode = prospect.provider || {};

  const vendorContacts = asArray(vendor.contact).map(c => ({
    name:  txt(c?.name) || null,
    email: txt(asArray(c?.email)[0]) || null,
    phone: txt(asArray(c?.phone)[0]) || null,
  })).filter(c => c.name || c.email);

  // Source identification — prefer provider/name, fall back to
  // customer/id/@source, then vendor name, then 'Other'.
  const providerName =
       txt(providerNode.name)
    || attr(ids[0], 'source')
    || txt(vendor.vendorname)
    || null;

  return {
    ok: true,
    lead: {
      source:       normalizeSource(providerName),
      sourceRaw:    providerName,
      requestDate:  txt(prospect.requestdate),
      prospectId,
      vehicle,
      customer,
      comments,
      vendor: {
        name:     txt(vendor.vendorname),
        contacts: vendorContacts,
      },
    },
    error: null,
  };
}

// Normalize an inbound phone to E.164 (+1XXXXXXXXXX) for North American
// numbers. Sarah/Twilio reject anything else. Real ADF feeds arrive in
// "(416) 555-1234", "416-555-1234", "4165551234", "+14165551234"
// — all of these collapse to +14165551234.
// Returns null for phones that don't yield 10 or 11 digits.
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10)                       return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

// ── Build a CRM-row payload from a parsed lead ─────────────────────
// Maps the rich ADF structure down to the flat fields desk_crm expects.
// Callers (lead-intake) supply tenant_id + assigned_rep_id separately.
function leadToCrmRow(lead) {
  if (!lead) return null;
  const v = lead.vehicle   || {};
  const c = lead.customer  || {};
  // Compose a vehicle-interest string for the CRM's vehicle_interest
  // field — "2026 Dodge Durango GT Plus" is what a salesperson wants
  // to see in their queue, not a JSON blob.
  const vehicleParts = [v.year, v.make, v.model, v.trim].filter(Boolean);
  const vehicleInterest = vehicleParts.join(' ') || null;

  // budget_range rough-synth from msrp (ADF rarely carries buyer budget
  // directly) — use a +/- 10% band around MSRP.
  let budgetRange = null;
  if (v.priceMsrp && v.priceMsrp > 1000) {
    const low  = Math.round(v.priceMsrp * 0.9  / 1000) * 1000;
    const high = Math.round(v.priceMsrp * 1.05 / 1000) * 1000;
    budgetRange = `$${low.toLocaleString()}–$${high.toLocaleString()} CAD`;
  }

  // Notes field: comments + option highlights (first 3) + address city
  const noteBits = [];
  if (lead.comments)                noteBits.push(lead.comments);
  if (v.interest || v.status)       noteBits.push(`Interest: ${[v.interest, v.status].filter(Boolean).join(' / ')}`);
  if (v.options && v.options.length) {
    const opts = v.options.slice(0, 3).join(' · ');
    noteBits.push('Options: ' + opts + (v.options.length > 3 ? ` (+${v.options.length - 3} more)` : ''));
  }
  if (c.addressCity || c.addressRegion) {
    noteBits.push('Location: ' + [c.addressCity, c.addressRegion].filter(Boolean).join(', '));
  }
  if (lead.requestDate) noteBits.push('Received: ' + lead.requestDate);

  return {
    name:             c.name  || 'Unknown',
    phone:            normalizePhone(c.phone),
    email:            c.email || null,
    vehicle_interest: vehicleInterest,
    budget_range:     budgetRange,
    status:           'Lead',
    source:           lead.source,           // normalized tag
    notes:            noteBits.join(' · ') || null,
  };
}

// ────────────────────────────────────────────────────────────────────
// PLAIN-TEXT LEAD PARSERS
// ────────────────────────────────────────────────────────────────────
// Some lead providers (notably CarGurus) email leads as formatted
// plain text rather than ADF XML. Same fields, different wire format.
// These parsers extract the fields by regex and return the SAME
// { ok, lead, error } shape parseAdfXml emits — so lead-intake.js
// treats them identically once parsing succeeds (tenant resolution
// by To-address still works, content-fallback router can still match
// on vin/stock/vendor.name, leadToCrmRow handles them unchanged).
//
// Hunt Chrysler / Mil's first CarGurus lead audit (2026-05-11) caught
// this — CarGurus leads to leads@firstfinancialcanada.com were
// arriving + tenant-resolving correctly but failing the parser stage
// with no_adf, so they never reached desk_crm. After this ships:
//   POST /api/admin/replay-leads { since: "<earlier-date>" }
// re-runs the polled inbox and backfills the dropped CarGurus leads
// into the CRM (dedup-on-success keeps it safe to replay).
//
// Adding a new provider:
//   1. Write a parseXxxPlainText(body) that returns:
//        null                          → "not my format, try the next one"
//        { ok: true,  lead:  {...} }   → matched + extracted
//        { ok: false, error: '...' }   → matched but failed validation
//   2. Push it onto PLAIN_TEXT_PARSERS below.
//   3. Anchor regexes to label strings ("First Name:", "VIN:") so
//      cosmetic provider tweaks don't break extraction.

function matchOne(rx, s, captureGroup = 1) {
  if (!s) return null;
  const m = rx.exec(s);
  if (!m) return null;
  const v = (m[captureGroup] || '').trim();
  return v || null;
}

// Split a "2014 GMC Sierra 1500 SLE Double Cab 4WD" line into
// { year, make, model, trim }. Tolerant — missing tokens come back null.
function splitVehicleLine(line) {
  if (!line) return { year: null, make: null, model: null, trim: null };
  const parts = String(line).trim().split(/\s+/);
  return {
    year:  parts[0] && /^\d{4}$/.test(parts[0]) ? parts[0] : null,
    make:  parts[1] || null,
    model: parts[2] || null,
    trim:  parts.slice(3).join(' ') || null,
  };
}

// CarGurus plain-text parser.
// Body signature: contains "Lead Submission from CarGurus".
// Section headers: Contact: / Comments: / Listing: / Seller:.
// Tested against real Hunt Chrysler CarGurus lead (frank57265@gmail.com,
// VIN 1GTV2UEC0EZ122211, 2014 GMC Sierra 1500, May 10 2026 11:19PM).
function parseCarGurusPlainText(body) {
  if (!body || !/Lead Submission from CarGurus/i.test(body)) return null;

  const firstName  = matchOne(/^\s*First Name:\s*([^\r\n]+)/im, body);
  const lastName   = matchOne(/^\s*Last Name:\s*([^\r\n]+)/im, body);
  const email      = matchOne(/^\s*Email:\s*(\S+)/im, body);
  const phone      = matchOne(/^\s*Telephone:\s*([^\r\n]+)/im, body);
  const postal     = matchOne(/^\s*Postal\s*code:\s*([^\r\n]+)/im, body);

  // Comments is the multiline block between "Comments:" and the next
  // section header. Anchor on the section delimiters so a long
  // customer message doesn't accidentally swallow Listing/Seller data.
  const commentsMatch = body.match(/Comments:\s*\r?\n([\s\S]+?)(?=\r?\n\s*(?:Listing|Seller|To get more|This email was sent|Lead Date)\s*[:\.]|$)/i);
  const comments = commentsMatch ? commentsMatch[1].trim() : null;

  const vin        = matchOne(/\bVIN:\s*([A-HJ-NPR-Z0-9]{17})\b/i, body);
  const vehLine    = matchOne(/^\s*Vehicle:\s*([^\r\n]+)/im, body);
  const stock      = matchOne(/^\s*Stock\s*Number:\s*([^\r\n]+)/im, body);
  const priceRaw   = matchOne(/Listed\s*Price:\s*\$?([\d,]+(?:\.\d+)?)/i, body);

  // Seller block — "Seller:" header then "Name: <dealership>" within
  // a few lines. Used by the content-fallback router for vendor-name
  // matching against desk_tenants.dealership.
  const vendorName = matchOne(/Seller:\s*\r?\n(?:[^\r\n]*\r?\n){0,4}\s*Name:\s*([^\r\n]+)/i, body);
  const dealerId   = matchOne(/Dealer\s*Id:\s*([^\r\n]+)/i, body);

  const prospectId = matchOne(/Transaction\s*ID:\s*(\w+)/i, body);

  const veh       = splitVehicleLine(vehLine);
  const priceMsrp = priceRaw ? (parseFloat(priceRaw.replace(/,/g, '')) || null) : null;

  // Minimum viable: customer contact + vehicle identifier. Without one
  // of each, the CRM row isn't actionable — reject rather than insert
  // a half-empty lead.
  if (!email && !phone) {
    return { ok: false, lead: null, error: 'CarGurus plain-text: no customer email/phone' };
  }
  if (!vin && !veh.year && !veh.make) {
    return { ok: false, lead: null, error: 'CarGurus plain-text: no vehicle identifier (VIN or year/make)' };
  }

  const nameFull = [firstName, lastName].filter(Boolean).join(' ') || null;

  return {
    ok: true,
    lead: {
      source:      'CarGurus',
      sourceRaw:   'CarGurus',
      requestDate: null,                  // CarGurus puts a timestamp in the footer; not extracted
      prospectId,
      vehicle: {
        year:          veh.year,
        make:          veh.make,
        model:         veh.model,
        trim:          veh.trim,
        vin,
        stock,
        bodystyle:     null,
        interest:      'buy',             // CarGurus is buy-side
        status:        null,
        priceMsrp,
        priceCurrency: priceMsrp ? 'CAD' : null,
        options:       [],
      },
      customer: {
        name:           nameFull,
        firstName,
        lastName,
        phone,
        email,
        addressStreet:  null,
        addressCity:    null,
        addressRegion:  null,
        addressPostal:  postal,
        addressCountry: null,
      },
      comments,
      vendor: {
        name:     vendorName || (dealerId ? `Dealer #${dealerId}` : null),
        contacts: [],
      },
    },
    error: null,
  };
}

// Registered plain-text parsers. Order matters — most-specific first,
// generic fallbacks last. parsePlainTextLead returns the first ok
// match; if every parser returns null (no signature match), the
// final return signals "no plain-text parser claimed this email".
const PLAIN_TEXT_PARSERS = [
  parseCarGurusPlainText,
  // Future:
  // parseTraderPlainText,
  // parseFcaDigitalPlainText,
];

function parsePlainTextLead(body) {
  if (!body || typeof body !== 'string') {
    return { ok: false, lead: null, error: 'No plain-text body' };
  }
  let lastError = null;
  for (const fn of PLAIN_TEXT_PARSERS) {
    const r = fn(body);
    if (!r) continue;            // parser said "not my format"
    if (r.ok) return r;
    lastError = r.error;         // matched signature but failed validation
  }
  return { ok: false, lead: null, error: lastError || 'No plain-text parser matched' };
}

module.exports = {
  parseAdfXml,
  parsePlainTextLead,
  parseCarGurusPlainText,
  normalizeSource,
  leadToCrmRow,
  SOURCE_PATTERNS,
};
