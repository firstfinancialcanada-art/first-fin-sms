// tests/api-tests.js — Critical API tests for FIRST-FIN platform
// Run: node tests/api-tests.js
// Requires: server running at BASE_URL (default http://localhost:3000)
'use strict';

const BASE = process.env.TEST_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'ChangeMe12345';
let TOKEN = null;
let passed = 0, failed = 0, skipped = 0;

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: text }; }
}

function assert(condition, name, detail) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════

async function testAuth() {
  console.log('\n🔑 AUTH');
  // Login with test account
  const r = await api('POST', '/api/desk/login', { email: 'fintest@fintest.com', password: 'fintest123' });
  assert(r.status === 200 && r.data.accessToken, 'Login returns token', `status=${r.status}`);
  if (r.data.accessToken) TOKEN = r.data.accessToken;
  else { console.error('  ⚠️  Cannot continue without auth token'); return false; }

  // Me endpoint
  const me = await api('GET', '/api/desk/me');
  assert(me.status === 200 && me.data.user?.email === 'fintest@fintest.com', 'GET /me returns user');

  // Bad login
  const bad = await api('POST', '/api/desk/login', { email: 'fake@fake.com', password: 'wrong' });
  assert(bad.status === 401 || bad.data.error, 'Bad login rejected');
  return true;
}

async function testFinanceEngine() {
  console.log('\n📊 FINANCE ENGINE');
  // Deal summary
  const r = await api('POST', '/api/desk/calculate', {
    action: 'deal-summary', price: 25000, doc: 998, gst: 5, apr: 12.99, term: 72,
    tradeAllow: 5000, tradePayoff: 8000, down: 2000, bookValue: 20000,
    income: 4000, existingPayments: 500, frequency: 'weekly',
    vscPrice: 2000, vscCost: 800, gapPrice: 900, gapCost: 300,
    acv: 3000, recon: 500, lotPack: 200, contractRate: 14.99, buyRate: 12.99, bankSplit: 75
  });
  assert(r.status === 200 && r.data.ok, 'Calculate deal-summary succeeds');
  const d = r.data.result;
  assert(d.payment > 0, 'Payment calculated', `$${d.payment}`);
  assert(d.frequency === 'weekly', 'Frequency is weekly');
  assert(d.paymentGrid?.monthly?.payment > 0, 'Payment grid has monthly');
  assert(d.paymentGrid?.biweekly?.payment > 0, 'Payment grid has biweekly');
  assert(d.paymentGrid?.semimonthly?.payment > 0, 'Payment grid has semimonthly');
  assert(d.paymentGrid?.weekly?.payment > 0, 'Payment grid has weekly');
  assert(d.rolledNegativeEquity === 3000, 'Negative equity rolled', `$${d.rolledNegativeEquity}`);
  assert(d.effectiveLtv > d.cleanLtv, 'Effective LTV > clean LTV (rollover)');
  assert(d.frontEnd?.totalFront > 0, 'Front-end profit calculated');
  assert(d.backEnd?.vsc?.marginPct > 0, 'VSC margin % calculated');
  assert(d.dealTotal?.dealGrade, 'Deal grade assigned', d.dealTotal?.dealGrade);
  assert(d.dealTotal?.costToMarket > 0, 'Cost-to-market calculated');

  // Quick calc
  const q = await api('POST', '/api/desk/calculate', { action: 'quick-calc', amount: 20000, apr: 9.99, term: 60 });
  assert(q.status === 200 && q.data.result > 0, 'Quick calc returns payment', `$${q.data.result}`);

  // Reverse calc
  const rv = await api('POST', '/api/desk/calculate', { action: 'reverse-calc', payment: 400, apr: 9.99, term: 60 });
  assert(rv.status === 200 && rv.data.result > 10000, 'Reverse calc returns max loan', `$${rv.data.result}`);
}

async function testInventory() {
  console.log('\n🚗 INVENTORY');
  const r = await api('GET', '/api/desk/inventory');
  assert(r.status === 200 && Array.isArray(r.data.inventory), 'GET inventory returns array');

  // Add vehicle
  const add = await api('POST', '/api/desk/inventory', {
    stock: 'TEST001', year: 2020, make: 'Toyota', model: 'Camry',
    mileage: 50000, price: 22000, vin: '1234567890ABCDEFG', color: 'White'
  });
  assert(add.status === 200 || add.status === 201, 'POST inventory adds vehicle');

  // Delete it
  if (add.data?.entry?.id) {
    const del = await api('DELETE', '/api/desk/inventory/' + add.data.entry.id);
    assert(del.status === 200, 'DELETE inventory removes vehicle');
  }
}

async function testCRM() {
  console.log('\n👤 CRM');
  const r = await api('GET', '/api/desk/crm');
  assert(r.status === 200, 'GET CRM succeeds');

  // Add contact
  const add = await api('POST', '/api/desk/crm', {
    name: 'Test Customer', phone: '+15551234567', email: 'test@test.com',
    beacon: 680, income: 4000, status: 'Lead', source: 'API Test'
  });
  assert(add.status === 200 && add.data.success, 'POST CRM adds contact');

  // Update with notes + follow-up
  if (add.data?.entry?.id) {
    const patch = await api('PATCH', '/api/desk/crm/' + add.data.entry.id, {
      notes: 'Test notes from API', vehicle_interest: 'SUV',
      follow_up_date: '2026-04-10', follow_up_note: 'Follow up on financing'
    });
    assert(patch.status === 200 && patch.data.success, 'PATCH CRM updates notes + follow-up');

    // Delete it
    const del = await api('DELETE', '/api/desk/crm/' + add.data.entry.id);
    assert(del.status === 200, 'DELETE CRM removes contact');
  }
}

async function testCompareAll() {
  console.log('\n🏦 COMPARE ALL');
  // With beacon=0 — should flag as unknown
  const r0 = await api('POST', '/api/compare-all', {
    stock: 'TEST001', beacon: 0, income: 4000, term: 72, existing: 500,
    down: 2000, trade: 0, fees: 998
  });
  assert(r0.status === 200, 'Compare All with beacon=0 succeeds');

  // With proper beacon
  const r1 = await api('POST', '/api/compare-all', {
    stock: 'TEST001', beacon: 680, income: 4000, term: 72, existing: 500,
    down: 2000, trade: 0, fees: 998, gstEnabled: true, gstRate: 5
  });
  assert(r1.status === 200, 'Compare All with beacon=680 succeeds');
  if (r1.data?.eligible) {
    assert(r1.data.eligible.length > 0, 'At least 1 eligible lender', `found ${r1.data.eligible.length}`);
    const first = r1.data.eligible[0];
    assert(first.lName, 'Lender has name', first.lName);
    assert(first.payment > 0, 'Lender result has payment');
    assert(typeof first.ltvPct === 'number', 'LTV calculated');
  }
}

async function testBulkSMS() {
  console.log('\n📱 BULK SMS');
  // Parse CSV
  const csv = await api('POST', '/api/bulk-sms/parse-csv', 'Name,Phone\nJohn Doe,4035551234\nJane Smith,4035555678\nBad Number,123');
  assert(csv.status === 200 && csv.data.success, 'CSV parse succeeds');
  assert(csv.data.contacts?.length === 2, 'Parsed 2 valid contacts', `got ${csv.data.contacts?.length}`);
  assert(csv.data.errors?.length >= 1, 'Flagged invalid number');

  // Status check
  const status = await api('GET', '/api/bulk-status');
  assert(status.status === 200, 'Bulk status endpoint works');
}

async function testAnalytics() {
  console.log('\n📈 ANALYTICS');
  const r = await api('GET', '/api/analytics');
  assert(r.status === 200 && !r.data.error, 'GET analytics succeeds');
  assert(r.data.totalConversations !== undefined, 'Has totalConversations');
  assert(r.data.conversionRate !== undefined, 'Has conversionRate');
  assert(r.data.dealStats, 'Has dealStats');
  assert(r.data.sourceBreakdown !== undefined, 'Has sourceBreakdown (new)');
  assert(r.data.stopReasons !== undefined, 'Has stopReasons (new)');
  if (r.data.dealStats) {
    assert(r.data.dealStats.productPenetration, 'Has productPenetration (new)');
  }
}

async function testAdmin() {
  console.log('\n🛡️ ADMIN');
  const headers = { 'x-admin-token': ADMIN_TOKEN };

  const stats = await api('GET', '/api/admin/stats', null, headers);
  assert(stats.status === 200, 'Admin stats endpoint works');

  const users = await api('GET', '/api/admin/users', null, headers);
  assert(users.status === 200 && Array.isArray(users.data), 'Admin users list works');

  // Forbidden without token
  const noAuth = await api('GET', '/api/admin/stats');
  assert(noAuth.status === 403, 'Admin requires token');
}

async function testOptOut() {
  console.log('\n🚫 OPT-OUT');
  // CSV with opted-out number (won't actually be opted out unless we add one)
  const csv = await api('POST', '/api/bulk-sms/parse-csv', 'Name,Phone\nTest User,4035559999');
  assert(csv.status === 200, 'CSV parse works for opt-out test');
  // Check that optedOut count is returned
  assert(csv.data.optedOut !== undefined, 'Response includes optedOut count');
}

// ═══════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════

async function run() {
  console.log(`\n🧪 FIRST-FIN API TESTS — ${BASE}\n${'═'.repeat(50)}`);

  const authed = await testAuth();
  if (!authed) { console.log('\n⚠️  Auth failed — skipping authenticated tests'); process.exit(1); }

  await testFinanceEngine();
  await testInventory();
  await testCRM();
  await testCompareAll();
  await testBulkSMS();
  await testAnalytics();
  await testAdmin();
  await testOptOut();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}  ⏭ Skipped: ${skipped}`);
  console.log(`${'═'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Test runner error:', e); process.exit(1); });
