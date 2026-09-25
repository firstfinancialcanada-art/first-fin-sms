// lib/customer-sms.js — every text that reaches a CUSTOMER goes through here
//
// Opt-outs were only honoured in two places: bulk campaigns (lib/bulk.js) and
// Sarah's own replies (routes/sarah.js). Four other paths texted customers
// directly through twilioClient.messages.create, so someone who had replied
// STOP could still be sent:
//
//   - the "you just called us" text after pressing 3   (routes/voice.js)
//   - the funded-deal congratulations AND its review request
//     (routes/deals.js and a second copy in routes/desk.js)
//   - the appointment confirmation a minute after booking (routes/sarah.js)
//
// Under CASL an express opt-out has to be honoured on all commercial messages,
// and the funded-deal text carries a review request, so it is squarely
// commercial. These also skipped the spend cap, so they spent money nobody was
// counting.
//
// Staff alerts are deliberately NOT routed through here. Lead and voicemail
// notifications to the dealer's own managers are uncapped on purpose — missing
// a lead costs far more than the text does.
'use strict';

const { isOptedOut } = require('./db');
const { guardedSmsSend } = require('./spend-cap');

/**
 * @param kind  short label for the log line, e.g. 'deal_funded'
 * @returns the guardedSmsSend result, or { ok:false, reason:'OPTED_OUT' }
 */
async function sendCustomerSms(twilioClient, userId, params, kind = 'customer') {
  const to = params && params.to;
  if (!to) return { ok: false, reason: 'NO_RECIPIENT' };

  try {
    if (await isOptedOut(to)) {
      console.log(`🔇 ${kind} SMS suppressed — ${to} has opted out`);
      return { ok: false, reason: 'OPTED_OUT' };
    }
  } catch (e) {
    // Fail CLOSED. If we can't tell whether they opted out, not sending is a
    // missed pleasantry; sending is a compliance breach.
    console.error(`❌ opt-out check failed for ${kind}, not sending:`, e.message);
    return { ok: false, reason: 'OPT_OUT_CHECK_FAILED' };
  }

  const r = await guardedSmsSend(twilioClient, userId, params);
  if (!r.ok && r.reason !== 'OPTED_OUT') {
    console.warn(`⚠️ ${kind} SMS not sent — ${r.reason}`);
  }
  return r;
}

module.exports = { sendCustomerSms };
