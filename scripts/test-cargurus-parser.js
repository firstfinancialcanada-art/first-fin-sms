// scripts/test-cargurus-parser.js
//
// Smoke test for the CarGurus plain-text parser. Runs against the real
// Hunt Chrysler CarGurus lead body Franco audited on 2026-05-11 — same
// email that was silently dropping at status='no_adf' before the
// parsePlainTextLead path landed.
//
// USAGE (no env required — pure parser test):
//   node scripts/test-cargurus-parser.js
//
// Exits 0 on pass, 1 on fail. Add to CI later if we want.

'use strict';

const { parsePlainTextLead, parseCarGurusPlainText, leadToCrmRow } = require('../lib/adf-parser');

// Real CarGurus body — copy-paste from the inbox audit. Don't trim or
// reformat — the parser has to handle the exact whitespace shipped.
const REAL_BODY = `** Please reply back to consumer using contact information below. **

Lead Submission from CarGurus

Contact:
First Name: Frank
Last Name: Picard
Email: frank57265@gmail.com
Telephone: (519) 722-5071
Postal code: L9T 9B1

Comments:
I am interested in your 2014 GMC Sierra 1500 SLE Double Cab 4WD. You can reach me by email at frank57265@gmail.com or phone at (519) 722-5071. Thank you! (CarGurus Deal Rating: N/A / Is From Shippable Listing: No)

Listing:
VIN: 1GTV2UEC0EZ122211
Vehicle: 2014 GMC Sierra 1500 SLE Double Cab 4WD
Stock Number: P7056
Listed Price: $8,999
CarGurus Instant Market Value: N/A
Is From Shippable Listing: No
View Listing on CarGurus [https://example/listing]

Seller:
Dealer Id: 5440
Name: Hunt Chrysler Dodge Jeep Ram
Address: 500 Bronte St, S
Location: Milton, ON L9T 9H5

To get more out of your CarGurus subscription:
...

This email was sent to leads@firstfinancialcanada.com.

Lead Date: Sent by CarGurus on May 11, 2026 2:19:11 EDT AM.
Transaction ID: A68617D869CEED2FD49F967E1F281DB94F1567A413A7D768798B1A1621791580
`;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label); }
}

console.log('\n── parseCarGurusPlainText direct ────────────────────────────────');
const direct = parseCarGurusPlainText(REAL_BODY);
assert(direct && direct.ok === true,                         'parser returns ok=true');
assert(direct?.lead?.source === 'CarGurus',                  'source = CarGurus');
assert(direct?.lead?.customer?.firstName === 'Frank',        'first name = Frank');
assert(direct?.lead?.customer?.lastName  === 'Picard',       'last name = Picard');
assert(direct?.lead?.customer?.email === 'frank57265@gmail.com', 'email captured');
assert(direct?.lead?.customer?.phone === '(519) 722-5071',   'phone captured (raw)');
assert(direct?.lead?.customer?.addressPostal === 'L9T 9B1',  'postal captured');
assert(direct?.lead?.vehicle?.vin === '1GTV2UEC0EZ122211',   'VIN captured');
assert(direct?.lead?.vehicle?.year === '2014',               'year = 2014');
assert(direct?.lead?.vehicle?.make === 'GMC',                'make = GMC');
assert(direct?.lead?.vehicle?.model === 'Sierra',            'model = Sierra');
assert(direct?.lead?.vehicle?.trim?.startsWith('1500'),      'trim starts with 1500');
assert(direct?.lead?.vehicle?.stock === 'P7056',             'stock = P7056');
assert(direct?.lead?.vehicle?.priceMsrp === 8999,            'price = 8999');
assert(direct?.lead?.vendor?.name === 'Hunt Chrysler Dodge Jeep Ram', 'vendor = Hunt Chrysler Dodge Jeep Ram');
assert(/2014 GMC Sierra/.test(direct?.lead?.comments || ''), 'comments contain customer message');
assert(direct?.lead?.prospectId?.startsWith('A68617D869'),   'prospectId = transaction id');

console.log('\n── parsePlainTextLead front door ────────────────────────────────');
const front = parsePlainTextLead(REAL_BODY);
assert(front && front.ok === true,                           'front door returns ok=true');
assert(front?.lead?.source === 'CarGurus',                   'front door returns CarGurus lead');

console.log('\n── leadToCrmRow shape ───────────────────────────────────────────');
const row = leadToCrmRow(direct.lead);
assert(row?.name === 'Frank Picard',                         'CRM name = Frank Picard');
assert(row?.phone === '+15197225071',                        'CRM phone normalized to E.164');
assert(row?.email === 'frank57265@gmail.com',                'CRM email passthrough');
assert(row?.source === 'CarGurus',                           'CRM source = CarGurus');
assert((row?.vehicle_interest || '').includes('GMC Sierra'), 'CRM vehicle_interest contains GMC Sierra');

console.log('\n── Rejection tests ──────────────────────────────────────────────');
const notCargurus = parseCarGurusPlainText('This is just a random email body with no markers.');
assert(notCargurus === null,                                 'non-CarGurus body → null (try next parser)');
const bareSig = parseCarGurusPlainText('Lead Submission from CarGurus\n\nGarbage with no fields.');
assert(bareSig && bareSig.ok === false && /no customer/i.test(bareSig.error), 'matched signature but missing contact → ok=false with reason');

console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
