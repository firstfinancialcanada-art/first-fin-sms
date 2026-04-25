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

const { XMLParser } = require('fast-xml-parser');

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
  const ids       = asArray(cust.id);
  const prospectId = ids.length ? (txt(ids[0]) || attr(ids[0], 'source')) : null;
  const comments   = txt(cust.comments);

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
    phone:            c.phone || null,
    email:            c.email || null,
    vehicle_interest: vehicleInterest,
    budget_range:     budgetRange,
    status:           'Lead',
    source:           lead.source,           // normalized tag
    notes:            noteBits.join(' · ') || null,
  };
}

module.exports = {
  parseAdfXml,
  normalizeSource,
  leadToCrmRow,
  SOURCE_PATTERNS,
};
