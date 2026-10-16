// Tenant isolation tests for Sarah lead alerts.
//
// Franco's reported symptom: Hunt Chrysler set their own notify number at
// setup and alerts still landed on his phone. These cover the fan-out half
// (getNotifyTargets / notifyTenantManagers) against a fake database.
const path = require('path');
const Module = require('module');

const ROOT = 'C:\\Users\\rolli\\Desktop\\New folder (2)\\FIRST-FIN V1.4';
const P = (p) => path.join(ROOT, 'lib', p);

// tenant 3 = Franco (owner, +18257474442), tenant 9 = Hunt (owner, +15195550199)
const USERS = [
  { id: 1, email: 'kevlarkarz@gmail.com',  display_name: 'Franco Fannin', notify_phone: '+18257474442', settings: { notifyPhone: '+18257474442' } },
  { id: 7, email: 'mil@huntchrysler.com',  display_name: 'Mil Radenkovic', notify_phone: '+15195550199', settings: { notifyPhone: '+15195550199' } },
  { id: 8, email: 'rep@huntchrysler.com',  display_name: 'Hunt Rep',       notify_phone: '+15195550123', settings: {} },
];
const MEMBERS = [
  { tenant_id: 3, user_id: 1, role: 'owner',   active: true },
  { tenant_id: 9, user_id: 7, role: 'owner',   active: true },
  { tenant_id: 9, user_id: 8, role: 'rep',     active: true },   // rep: must NOT be alerted
];
const TENANTS = [{ id: 3, owner_user_id: 1 }, { id: 9, owner_user_id: 7 }];

let noNotifyPhones = false;   // flips branch 1 off to exercise the settings fallback

async function fakeQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (s.includes('FROM desk_members m') && s.includes('JOIN desk_users')) {
    const tid = params[0];
    const rows = MEMBERS
      .filter(m => m.tenant_id === tid && m.active && ['owner','manager'].includes(m.role))
      .map(m => ({ ...USERS.find(u => u.id === m.user_id), role: m.role }))
      .filter(u => !noNotifyPhones && u.notify_phone && u.notify_phone.length >= 10)
      .map(u => ({ user_id: u.id, display_name: u.display_name, notify_phone: u.notify_phone, role: u.role }));
    return { rows };
  }
  if (s.includes('FROM desk_tenants t')) {
    const tid = params[0];
    const t = TENANTS.find(x => x.id === tid);
    if (!t) return { rows: [] };
    const u = USERS.find(x => x.id === t.owner_user_id);
    const phone = u && u.settings && u.settings.notifyPhone;
    return { rows: phone && phone.length >= 10 ? [{ user_id: u.id, display_name: u.display_name, phone }] : [] };
  }
  if (s.includes('FROM desk_users WHERE id')) {
    const u = USERS.find(x => x.id === params[0]);
    return { rows: u ? [{ display_name: u.display_name, notify_phone: u.notify_phone }] : [] };
  }
  return { rows: [] };
}

function stub(absPath, exports) {
  const resolved = Module._resolveFilename(absPath, module, false);
  const m = new Module(resolved, module);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
}
const realHelpers = require(P('helpers.js'));
stub(P('db.js'), { pool: { query: fakeQuery, connect: async () => ({ query: fakeQuery, release() {} }) }, migrationsReady: Promise.resolve() });
stub(P('helpers.js'), realHelpers);

const notify = require(P('notify.js'));

const sentTo = [];
const twilioClient = { messages: { create: async (o) => { sentTo.push(o.to); return { sid: 'SM1' }; } } };

const checks = [];
const T = (label, fn) => checks.push({ label, fn });

T("Hunt's alert goes to Hunt's phone only — never the platform owner's", async () => {
  sentTo.length = 0;
  await notify.notifyTenantManagers({ tenantId: 9, fromNumber: '+15195550000', body: 'CALLBACK', twilioClient });
  return sentTo.length === 1 && sentTo[0] === '+15195550199' && !sentTo.includes('+18257474442');
});

T("Franco's alert goes to Franco only — never Hunt", async () => {
  sentTo.length = 0;
  await notify.notifyTenantManagers({ tenantId: 3, fromNumber: '+15873303601', body: 'CALLBACK', twilioClient });
  return sentTo.length === 1 && sentTo[0] === '+18257474442';
});

T('a rep on the tenant is not alerted — owners and managers only', async () => {
  const targets = await notify.getNotifyTargets(9);
  return targets.every(t => t.phone !== '+15195550123');
});

T('settings fallback stays inside the tenant (no cross-tenant owner)', async () => {
  noNotifyPhones = true;                       // force branch 2
  const t9 = await notify.getNotifyTargets(9);
  const t3 = await notify.getNotifyTargets(3);
  noNotifyPhones = false;
  return t9.length === 1 && t9[0].phone === '+15195550199'
      && t3.length === 1 && t3[0].phone === '+18257474442';
});

T('a tenant with no notify config gets NOTHING — no global env fallback', async () => {
  sentTo.length = 0;
  process.env.FORWARD_PHONE = '+15870000000';
  process.env.OWNER_PHONE   = '+15870000000';
  const r = await notify.notifyTenantManagers({ tenantId: 99, fromNumber: '+15873303601', body: 'CALLBACK', twilioClient });
  return sentTo.length === 0 && r.reason === 'no_targets';
});

T('a null tenantId sends to nobody', async () => {
  sentTo.length = 0;
  const r = await notify.notifyTenantManagers({ tenantId: null, fromNumber: '+15873303601', body: 'x', twilioClient });
  return sentTo.length === 0 && r.sent === 0;
});

(async () => {
  let pass = 0, fail = 0;
  for (const c of checks) {
    let ok = false, err = null;
    try { ok = await c.fn(); } catch (e) { err = e.message; }
    if (ok) { pass++; console.log('  PASS  ' + c.label); }
    else    { fail++; console.log('  FAIL  ' + c.label + (err ? ' — ' + err : '')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
