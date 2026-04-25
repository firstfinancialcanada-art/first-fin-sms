// tests/adf-parser.test.js — integration test for lib/adf-parser.js
//
// Uses the real Hunt Chrysler ADF sample that Mil Radenkovic pasted
// into SMS on 2026-04-23 — see memory project_hunt_chrysler_deal.md.
// This is a node --check-style script (no test framework), run with:
//   node tests/adf-parser.test.js
// Exits with code 0 on pass, 1 on fail.
'use strict';

const { parseAdfXml, leadToCrmRow } = require('../lib/adf-parser');

// Faithful reconstruction of the CarCostCanada → Hunt Chrysler lead
// Mil sent. Fields transcribed from SMS screenshots; fake names/phones
// preserved so this can live in source.
const HUNT_SAMPLE = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<?adf version="1.0"?>
<!-- Dealer XML Feed -->
<adf xmlns:xsi="https://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="https://www.w3.org/2001/XMLSchema">
  <prospect status="new">
    <requestdate>2026-04-10T20:35:43-04:00</requestdate>
    <vehicle interest="buy" status="new">
      <year>2026</year>
      <make>Dodge</make>
      <model><![CDATA[Durango]]></model>
      <trim><![CDATA[GT Plus]]></trim>
      <price type="msrp" currency="CAD">70885</price>
      <option>
        <optionname><![CDATA[Engine: 3.6L Pentastar VVT V6 w/ESS (STD)]]></optionname>
        <manufacturercode>ERC</manufacturercode>
      </option>
      <option>
        <optionname><![CDATA[Transmission: 8-Speed TorqueFlite Automatic (STD)]]></optionname>
        <manufacturercode>DFT</manufacturercode>
      </option>
      <option>
        <optionname><![CDATA[Wheels: 20" x 8" Fine Silver Aluminum (STD)]]></optionname>
        <manufacturercode>WHJ</manufacturercode>
      </option>
      <option>
        <optionname><![CDATA[Tires: 265/50R20 BSW AS LRR (STD)]]></optionname>
        <manufacturercode>TKJ</manufacturercode>
      </option>
      <option>
        <optionname><![CDATA[White Knuckle]]></optionname>
        <manufacturercode>PW7</manufacturercode>
      </option>
      <option>
        <optionname><![CDATA[Black Leather-Faced Bucket Seats]]></optionname>
        <manufacturercode>MLX9</manufacturercode>
      </option>
      <option>
        <optionname><![CDATA[Quick Order Package 2BH GT Plus]]></optionname>
        <manufacturercode>2BH</manufacturercode>
      </option>
      <option>
        <optionname><![CDATA[Federal air conditioning excise tax]]></optionname>
      </option>
    </vehicle>
    <customer>
      <contact>
        <name part="full"><![CDATA[ALAN SYDNEY]]></name>
        <phone type="voice">647-289-2177</phone>
        <email><![CDATA[aesydney80@gmail.com]]></email>
        <address type="home">
          <street><![CDATA[]]></street>
          <city><![CDATA[Monora]]></city>
          <regioncode>ON</regioncode>
          <postalcode>L9W 6r8</postalcode>
          <country>CA</country>
        </address>
      </contact>
      <id sequence="1" source="CarCostCanada"><![CDATA[493578]]></id>
      <comments><![CDATA[CarCostCanada Member Since: 10/04/2026]]></comments>
    </customer>
    <vendor>
      <vendorname><![CDATA[Hunt Chrysler]]></vendorname>
      <contact primarycontact="1">
        <name part="full"><![CDATA[Robbie Hunt]]></name>
        <email><![CDATA[robhunt@huntchrysler.com]]></email>
        <phone type="voice">905-876-2580</phone>
      </contact>
      <contact primarycontact="1">
        <name part="full"><![CDATA[Mil Radenkovic]]></name>
        <email><![CDATA[mil@huntchrysler.com]]></email>
      </contact>
      <contact primarycontact="0">
        <name part="full"><![CDATA[Wes Olsen]]></name>
        <email><![CDATA[wolsen@huntchrysler.com]]></email>
      </contact>
    </vendor>
    <provider>
      <name><![CDATA[CarCostCanada]]></name>
      <service><![CDATA[New Car Pricing Website]]></service>
      <url><![CDATA[https://carcostcanada.com]]></url>
      <email><![CDATA[rrdealers@carcostcanada.com]]></email>
      <phone type="voice">1-866-453-6995</phone>
      <contact primarycontact="1">
        <name part="full"><![CDATA[CarCostCanada]]></name>
        <email><![CDATA[rrdealers@carcostcanada.com]]></email>
        <address type="work">
          <street line="1"><![CDATA[1230 Crestlawn Drive]]></street>
          <city><![CDATA[Mississauga]]></city>
          <regioncode>ON</regioncode>
          <postalcode>L4W 1A6</postalcode>
          <country>CA</country>
        </address>
      </contact>
    </provider>
  </prospect>
</adf>`;

// ── Assertion helper ───────────────────────────────────────────────
let failed = 0;
function assert(cond, label, actual) {
  if (cond) {
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label + (actual !== undefined ? '  (got: ' + JSON.stringify(actual) + ')' : ''));
  }
}

// ── Run tests ──────────────────────────────────────────────────────
console.log('\n▶ ADF parser — Hunt Chrysler CarCostCanada sample\n');

const result = parseAdfXml(HUNT_SAMPLE);
assert(result.ok === true,                                  'parser returns ok=true', result.error);
assert(result.error === null,                               'no error');
assert(result.lead != null,                                 'lead object present');

const lead = result.lead;
assert(lead.source === 'CarCostCanada',                     'source normalized to CarCostCanada', lead.source);
assert(lead.sourceRaw === 'CarCostCanada',                  'sourceRaw preserved', lead.sourceRaw);
assert(lead.requestDate === '2026-04-10T20:35:43-04:00',    'requestDate parsed', lead.requestDate);
assert(lead.prospectId === '493578',                        'prospectId extracted', lead.prospectId);

console.log('\n  Vehicle:');
assert(String(lead.vehicle.year) === '2026',                '  year 2026', lead.vehicle.year);
assert(lead.vehicle.make === 'Dodge',                       '  make Dodge', lead.vehicle.make);
assert(lead.vehicle.model === 'Durango',                    '  model Durango', lead.vehicle.model);
assert(lead.vehicle.trim === 'GT Plus',                     '  trim GT Plus', lead.vehicle.trim);
assert(lead.vehicle.priceMsrp === 70885,                    '  price 70885', lead.vehicle.priceMsrp);
assert(lead.vehicle.priceCurrency === 'CAD',                '  currency CAD', lead.vehicle.priceCurrency);
assert(lead.vehicle.interest === 'buy',                     '  interest=buy', lead.vehicle.interest);
assert(lead.vehicle.status === 'new',                       '  status=new', lead.vehicle.status);
assert(Array.isArray(lead.vehicle.options),                 '  options is array');
assert(lead.vehicle.options.length === 8,                   '  8 options parsed', lead.vehicle.options.length);
assert(lead.vehicle.options.some(o => /Pentastar/.test(o)), '  engine option present');

console.log('\n  Customer:');
assert(lead.customer.name === 'ALAN SYDNEY',               '  name ALAN SYDNEY', lead.customer.name);
assert(lead.customer.phone === '647-289-2177',              '  phone', lead.customer.phone);
assert(lead.customer.email === 'aesydney80@gmail.com',      '  email', lead.customer.email);
assert(lead.customer.addressCity === 'Monora',              '  city Monora', lead.customer.addressCity);
assert(lead.customer.addressRegion === 'ON',                '  region ON', lead.customer.addressRegion);
assert(lead.customer.addressPostal === 'L9W 6r8',           '  postal', lead.customer.addressPostal);
assert(lead.customer.addressCountry === 'CA',               '  country CA', lead.customer.addressCountry);

console.log('\n  Vendor:');
assert(lead.vendor.name === 'Hunt Chrysler',                '  vendor name', lead.vendor.name);
assert(lead.vendor.contacts.length === 3,                   '  3 vendor contacts', lead.vendor.contacts.length);
assert(lead.vendor.contacts.some(c => c.name === 'Mil Radenkovic'),
                                                            '  Mil is a vendor contact');

console.log('\n  Comments:');
assert(/CarCostCanada Member/.test(lead.comments || ''),    '  comments include CarCostCanada', lead.comments);

// ── CRM row mapping ───────────────────────────────────────────────
console.log('\n  leadToCrmRow(lead):');
const row = leadToCrmRow(lead);
assert(row.name  === 'ALAN SYDNEY',                         '  name', row.name);
assert(row.phone === '+16472892177',                        '  phone (E.164)', row.phone);
assert(row.email === 'aesydney80@gmail.com',                '  email', row.email);
assert(row.vehicle_interest === '2026 Dodge Durango GT Plus',
                                                            '  vehicle_interest composed',
                                                            row.vehicle_interest);
assert(/CAD/.test(row.budget_range || ''),                  '  budget_range CAD band', row.budget_range);
assert(row.status === 'Lead',                               '  status Lead', row.status);
assert(row.source === 'CarCostCanada',                      '  source', row.source);
assert(/Monora/.test(row.notes || ''),                      '  notes include city', row.notes);

// ── Source normalization edge cases ────────────────────────────────
console.log('\n  Source normalization:');
const { normalizeSource } = require('../lib/adf-parser');
assert(normalizeSource('AutoTrader')         === 'AutoTrader',    'AutoTrader');
assert(normalizeSource('Auto Trader')        === 'AutoTrader',    'Auto Trader');
assert(normalizeSource('autotrader.ca')      === 'AutoTrader',    'autotrader.ca');
assert(normalizeSource('Kijiji Autos')       === 'Kijiji',        'Kijiji Autos');
assert(normalizeSource('Car Cost Canada')    === 'CarCostCanada', 'Car Cost Canada');
assert(normalizeSource('TAQ Auto')           === 'TAQ',           'TAQ Auto');
assert(normalizeSource('CarGurus Inc')       === 'CarGurus',      'CarGurus');
assert(normalizeSource('Facebook Marketplace') === 'Facebook',    'Facebook');
assert(normalizeSource('')                   === 'Other',         'empty → Other');
assert(normalizeSource('Unknown Lead Co')    === 'Unknown Lead Co', 'unknown preserved trimmed');

// ── Edge: malformed XML ────────────────────────────────────────────
console.log('\n  Malformed input:');
const bad = parseAdfXml('<not-xml');
assert(bad.ok === false,                                    'bad xml returns ok=false');
assert(typeof bad.error === 'string' && bad.error.length,   'bad xml has error message');

const empty = parseAdfXml('');
assert(empty.ok === false,                                  'empty returns ok=false');

const noProspect = parseAdfXml('<?xml version="1.0"?><adf></adf>');
assert(noProspect.ok === false,                             'no <prospect> returns ok=false');
assert(/prospect/i.test(noProspect.error || ''),            'error mentions prospect');

// ── Report ─────────────────────────────────────────────────────────
console.log('\n' + (failed ? `✗ ${failed} assertion(s) failed` : '✓ all assertions passed'));
process.exit(failed ? 1 : 0);
