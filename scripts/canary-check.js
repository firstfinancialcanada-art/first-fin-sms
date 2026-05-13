// scripts/canary-check.js
//
// CLI runner for the lead-silence canary. Designed to run once a day from
// Railway's scheduled-jobs / cron / external scheduler. Sends one SMS per
// silent tenant to the platform alert phone (process.env.PLATFORM_ALERT_PHONE,
// falling back to Franco's user notify_phone).
//
// USAGE (from V1.4 root, with Railway env loaded):
//   railway run node scripts/canary-check.js                # send alerts
//   railway run node scripts/canary-check.js --dry-run      # print, don't SMS
//   railway run node scripts/canary-check.js --silence 48   # 48h silence window
//   railway run node scripts/canary-check.js --lookback 14  # 14-day baseline
//
// Schedule recommendation: once daily at 12:00 noon EST (after morning lead
// flow should have arrived, before end-of-day so the dealer can chase it).
//
// Returns exit code 0 if everything is quiet/healthy, 1 if any tenant
// alert fired (useful for chaining into a monitor that emails on non-zero).

'use strict';

require('dotenv').config();

const { Pool }                = require('pg');
const { getSilentTenants }    = require('../lib/lead-silence-canary');

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => {
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = arr[i + 1];
      if (next && !next.startsWith('--')) return [key, next];
      return [key, true];
    }
    return null;
  }).filter(Boolean)
);

const DRY_RUN       = !!args['dry-run'];
const LOOKBACK_DAYS = parseInt(args.lookback, 10) || undefined;
const SILENCE_HOURS = parseInt(args.silence,  10) || undefined;
const MIN_MEDIAN    = parseFloat(args['min-median']) || undefined;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

function banner(title) {
  console.log('\n' + '─'.repeat(70));
  console.log('  ' + title);
  console.log('─'.repeat(70));
}

// Resolve where to send the alert SMS.
//   1. process.env.PLATFORM_ALERT_PHONE (preferred — explicit single source)
//   2. Owner of First Financial Auto tenant (Franco's user) notify_phone
async function resolveAlertPhone() {
  if (process.env.PLATFORM_ALERT_PHONE) return process.env.PLATFORM_ALERT_PHONE;
  // Fall back to Franco's user notify_phone (kevlarkarz@gmail.com per memory)
  const r = await pool.query(`
    SELECT notify_phone FROM desk_users
     WHERE LOWER(email) = LOWER('kevlarkarz@gmail.com')
        OR LOWER(email) = LOWER('first@firstfinancialcanada.com')
     ORDER BY id LIMIT 1
  `);
  return r.rows[0]?.notify_phone || null;
}

function buildSmsBody(t) {
  return `🚨 First-Fin canary: ${t.dealership} has had ZERO leads in the last 24h. `
       + `Historical baseline: ${t.historicalMedian.toFixed(1)} leads/day. `
       + `Check aggregator delivery + lead_intake_log.`;
}

async function sendSms(toPhone, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    return { sent: false, reason: 'twilio_not_configured' };
  }
  // Lazy require so the script can run in dry-run without twilio installed.
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  try {
    await twilio.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   toPhone,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

async function main() {
  banner('Lead-silence canary');
  console.log('  Mode:           ' + (DRY_RUN ? 'DRY RUN (no SMS)' : 'LIVE (will SMS)'));
  if (LOOKBACK_DAYS) console.log('  Lookback days:  ' + LOOKBACK_DAYS);
  if (SILENCE_HOURS) console.log('  Silence hours:  ' + SILENCE_HOURS);
  if (MIN_MEDIAN != null) console.log('  Min median:     ' + MIN_MEDIAN);

  const opts = {};
  if (LOOKBACK_DAYS) opts.lookbackDays         = LOOKBACK_DAYS;
  if (SILENCE_HOURS) opts.silenceHours         = SILENCE_HOURS;
  if (MIN_MEDIAN != null) opts.minHistoricalMedian = MIN_MEDIAN;

  const { config, silentTenants } = await getSilentTenants(opts);

  banner('Settings');
  console.log('  Lookback:       ' + config.lookbackDays + ' days');
  console.log('  Silence window: ' + config.silenceHours + ' hours');
  console.log('  Min median:     ' + config.minHistoricalMedian + ' leads/day');

  banner('Result');
  if (!silentTenants.length) {
    console.log('  ✅ All active tenants healthy. Either receiving leads in the window');
    console.log('     or below the baseline threshold (not enough history to page).');
    await pool.end();
    process.exit(0);
  }

  console.log(`  ⚠️  ${silentTenants.length} tenant(s) gone silent:\n`);
  for (const t of silentTenants) {
    console.log(`  • ${t.dealership} (${t.tier})`);
    console.log(`      owner: ${t.ownerEmail}`);
    console.log(`      historical median: ${t.historicalMedian.toFixed(1)} leads/day`);
    console.log(`      last ${config.silenceHours}h: ${t.recentCount} leads`);
  }

  // Send alerts
  banner(DRY_RUN ? 'Dry run — would have sent:' : 'Sending SMS alerts');
  const alertPhone = await resolveAlertPhone();
  if (!alertPhone) {
    console.error('  ❌ No alert phone resolved. Set PLATFORM_ALERT_PHONE in Railway env');
    console.error('     or set notify_phone on Franco\'s desk_users row.');
    await pool.end();
    process.exit(1);
  }
  console.log('  Alert recipient: ' + alertPhone.replace(/\d(?=\d{4})/g, '*'));

  let sent = 0, failed = 0;
  for (const t of silentTenants) {
    const body = buildSmsBody(t);
    if (DRY_RUN) {
      console.log('   → ' + body);
      continue;
    }
    const r = await sendSms(alertPhone, body);
    if (r.sent) { console.log('   ✅ ' + t.dealership); sent++; }
    else        { console.log('   ❌ ' + t.dealership + '  (' + r.reason + ')'); failed++; }
  }

  banner('Summary');
  if (DRY_RUN) console.log('  Would have sent: ' + silentTenants.length);
  else         console.log('  Sent: ' + sent + ', failed: ' + failed);

  await pool.end();
  process.exit(silentTenants.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Canary crashed:', err.message);
  console.error(err.stack);
  pool.end().catch(() => {});
  process.exit(1);
});
