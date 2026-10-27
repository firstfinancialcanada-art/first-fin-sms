const { pool, getOrCreateConversation, updateConversation, saveMessage, isOptedOut, phoneKeys } = require('./db');
const { guardedSmsSend } = require('./spend-cap');
const { normalizePhone, fillTemplate, unresolvedTokens } = require('./helpers');

// Campaigns are scheduled 15s apart (see saveBulkCampaign), so on a healthy
// queue only one row is ever due per tick and the batch size is irrelevant.
// It only bites on a BACKLOG: after a restart or a pause, every overdue row is
// due at once and a batch of 5 every 5s drains at 60/min — far above what a
// single Canadian long code gets away with before carriers start filtering,
// and the number wears the reputation hit. 1 keeps the burst ceiling at 12/min
// without slowing a normal campaign at all.
const BULK_BATCH_SIZE = parseInt(process.env.BULK_BATCH_SIZE) || 1;
const BULK_INTERVAL_MS = parseInt(process.env.BULK_INTERVAL_MS) || 5000;

// ── Shared mutable state ──────────────────────────────────────────
const state = {
  bulkSmsProcessor: null,
  bulkSmsProcessorPaused: false,
  aiResponderPaused: false
};

// ── Table setup ───────────────────────────────────────────────────
// Memoized so the processor can wait for it. index.js calls this without
// awaiting and then starts the processor immediately, so the very first tick
// used to race the migrations — on the deploy that added claimed_at, tick one
// hit "column claimed_at does not exist" before the ALTER had landed. It
// recovered on the next tick, but a processor that throws on boot every time a
// column is added is a trap for whoever adds the next one.
let _schemaReady = null;
async function createBulkMessagesTable() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = _createBulkMessagesTable();
  return _schemaReady;
}

async function _createBulkMessagesTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bulk_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        campaign_name VARCHAR(255),
        message_template TEXT NOT NULL,
        recipient_name VARCHAR(255) NOT NULL,
        recipient_phone VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        error_message TEXT,
        scheduled_at TIMESTAMP,
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bulk_messages_processing
      ON bulk_messages(status, scheduled_at)
      WHERE status = 'pending'
    `);
    console.log('✅ bulk_messages table ready');
    // Safe migrations
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS user_id INTEGER`).catch(() => {});
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'unknown'`).catch(() => {});
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS twilio_sid VARCHAR(50)`).catch(() => {});
    // Per-contact template values — {month}, {vehicle}, {stock}. Tenant-wide
    // tokens come from settings; these differ row by row, which is what lets
    // one campaign span two months without telling half of it the wrong one.
    await client.query(`ALTER TABLE bulk_messages ADD COLUMN IF NOT EXISTS merge_json JSONB`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bulk_messages_sid ON bulk_messages(twilio_sid) WHERE twilio_sid IS NOT NULL`).catch(() => {});
    console.log('✅ bulk_messages columns + indexes ready');
  } catch (error) {
    console.error('❌ bulk_messages table error:', error);
  } finally {
    client.release();
  }
}

// ── Campaign helpers ──────────────────────────────────────────────
async function saveBulkCampaign(campaignName, messageTemplate, contacts, userId, mode = 'sales', startDelayMinutes = 0) {
  const client = await pool.connect();
  try {
    // startDelayMinutes lets a caller stagger several campaigns so a long
    // list goes out in spaced batches rather than one continuous run. The
    // rows simply sit in the queue until their scheduled_at arrives — no
    // timer to keep alive, and the whole lot is still killable with stop-mine.
    const delayMs = Math.max(0, Number(startDelayMinutes) || 0) * 60000;
    const startTime = new Date(Date.now() + 60000 + delayMs);
    if (contacts.length === 0) return { ids: [], skipped: [] };

    // Drop anyone already texted recently, at build time.
    //
    // The per-number cooldown further down only RESCHEDULES a row 24 hours
    // out. Inside a single campaign that is right — the row is a send we
    // still owe. Across campaigns it is wrong: a second blast built from an
    // overlapping list would still reach everyone who got the first one, just
    // a day later. Nothing about that is visible to the operator either; the
    // rows sit 'pending' and go out quietly the next day.
    //
    // Suppressing here is what makes "don't text the people we just texted"
    // actually true, and it is reported back so the operator sees the count.
    const SUPPRESS_DAYS = Math.max(0, Number(process.env.BULK_SUPPRESS_DAYS) || 30);
    const normalized = contacts.map(c => normalizePhone(c.phone) || c.phone);
    let skipped = [];
    if (SUPPRESS_DAYS > 0) {
      const { rows: recent } = await client.query(
        `SELECT DISTINCT recipient_phone FROM bulk_messages
          WHERE recipient_phone = ANY($1) AND user_id IS NOT DISTINCT FROM $2
            AND status = 'sent' AND sent_at > NOW() - ($3 || ' days')::interval`,
        [normalized.flatMap(p => phoneKeys(p)), userId || null, String(SUPPRESS_DAYS)]
      );
      if (recent.length) {
        const hit = new Set(recent.map(r => r.recipient_phone));
        const keep = [], drop = [];
        contacts.forEach((c, i) => {
          (phoneKeys(normalized[i]).some(k => hit.has(k)) ? drop : keep).push(c);
        });
        if (drop.length) {
          skipped = drop.map(c => ({ name: c.name, phone: c.phone }));
          console.log(`🔁 Suppressed ${drop.length} contact(s) texted in the last ${SUPPRESS_DAYS} days`);
          contacts = keep;
        }
      }
    }
    if (contacts.length === 0) return { ids: [], skipped };

    // After suppression, so the 15s spacing is across what actually sends.
    const scheduledTimes = contacts.map((_, i) =>
      new Date(startTime.getTime() + (i * 15000))
    );
    // Whitelist, not a boolean. This silently coerced everything that
    // wasn't 'acquisition' down to 'sales', so a reengage campaign was
    // stored as sales and every reply ran the buy-side FSM instead —
    // the opposite of what the operator picked, on a live list.
    // 'notify' is the send-and-stop mode: the opener goes out and Sarah
    // never speaks on that thread again. It is not an FSM — see the
    // handoff stamp in the send loop below.
    const safeMode = (mode === 'acquisition' || mode === 'reengage' || mode === 'notify') ? mode : 'sales';
    const valuePlaceholders = contacts.map((_, i) =>
      `($${i*8+1}, $${i*8+2}, $${i*8+3}, $${i*8+4}, $${i*8+5}, $${i*8+6}, $${i*8+7}, $${i*8+8})`
    ).join(', ');
    // Store E.164 so the cooldown and opt-out comparisons downstream are
    // matching on one shape. The CSV importer already normalises; campaigns
    // built straight off the CRM carry whatever the rep typed.
    const flatValues = contacts.flatMap((contact, i) => [
      campaignName, messageTemplate, contact.name,
      normalizePhone(contact.phone) || contact.phone,
      scheduledTimes[i], userId || null, safeMode,
      // Anything on the contact that isn't name/phone rides along as that
      // row's own template values.
      JSON.stringify(contact.merge && typeof contact.merge === 'object' ? contact.merge : {})
    ]);
    const result = await client.query(
      `INSERT INTO bulk_messages (campaign_name, message_template, recipient_name, recipient_phone, scheduled_at, user_id, mode, merge_json) VALUES ${valuePlaceholders} RETURNING id`,
      flatValues
    );
    return { ids: result.rows.map(r => r.id), skipped };
  } finally {
    client.release();
  }
}

async function getPendingBulkMessages(limit = BULK_BATCH_SIZE, client = null) {
  const c = client || await pool.connect();
  try {
    const result = await c.query(
      'SELECT * FROM bulk_messages WHERE status = $1 AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT $2',
      ['pending', limit]
    );
    return result.rows;
  } finally {
    if (!client) c.release();
  }
}

// ── Claim a batch before sending it ─────────────────────────────────────
// The processor used to SELECT rows that were still 'pending', send them, and
// only mark them 'sent' afterwards — with getOrCreateConversation, saveMessage
// and two more updates in between. Anything that interrupted that window left
// the row 'pending' with the customer already texted, and the next tick sent
// it again.
//
// The likelier trigger was never a crash: setInterval fires every 5s and does
// not wait for the previous run, so one slow Twilio batch is enough for two
// runs to overlap and pick up the same rows.
//
// Claiming flips them to 'sending' in the same statement that selects them.
// SKIP LOCKED means a second worker takes the next rows instead of blocking.
async function claimPendingBulkMessages(limit = BULK_BATCH_SIZE) {
  const { rows } = await pool.query(
    `UPDATE bulk_messages SET status = 'sending', claimed_at = NOW()
      WHERE id IN (
        SELECT id FROM bulk_messages
         WHERE status = 'pending' AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit]
  );
  return rows;
}

// ── Rows that were claimed and never resolved ───────────────────────────
// A process that dies mid-send leaves 'sending' behind. We deliberately do NOT
// put these back to 'pending': the customer may well have received the text,
// and texting someone twice is worse than not recording that we texted them
// once. They are parked as 'unknown' and shouted about, for a human to check
// against Twilio's own log.
async function reapStuckBulkMessages(staleMinutes = 15) {
  try {
    const { rows } = await pool.query(
      `UPDATE bulk_messages
          SET status = 'unknown',
              error_message = 'Interrupted mid-send — check Twilio before resending'
        WHERE status = 'sending' AND claimed_at < NOW() - ($1 || ' minutes')::interval
        RETURNING id, recipient_phone, twilio_sid`,
      [String(staleMinutes)]
    );
    if (rows.length) {
      console.error(`⚠️ ${rows.length} bulk message(s) interrupted mid-send and NOT resent:`);
      for (const r of rows) {
        console.error(`   id=${r.id} to=${r.recipient_phone} sid=${r.twilio_sid || '(never reached Twilio)'}`);
      }
    }
  } catch (e) {
    console.error('bulk reaper failed:', e.message);
  }
}

async function updateBulkMessageStatus(messageId, status, errorMessage = null, client = null) {
  const c = client || await pool.connect();
  try {
    await c.query(
      'UPDATE bulk_messages SET status = $1, error_message = $2, sent_at = CASE WHEN $1 = $3 THEN NOW() ELSE sent_at END WHERE id = $4',
      [status, errorMessage, 'sent', messageId]
    );
  } finally {
    if (!client) c.release();
  }
}

async function getBulkCampaignStats(campaignName, userId) {
  const client = await pool.connect();
  try {
    const result = userId
      ? await client.query(
          'SELECT COUNT(*) as total, COUNT(CASE WHEN status = $1 THEN 1 END) as sent, COUNT(CASE WHEN status = $2 THEN 1 END) as pending, COUNT(CASE WHEN status = $3 THEN 1 END) as failed FROM bulk_messages WHERE campaign_name = $4 AND user_id = $5',
          ['sent', 'pending', 'failed', campaignName, userId]
        )
      : await client.query(
          'SELECT COUNT(*) as total, COUNT(CASE WHEN status = $1 THEN 1 END) as sent, COUNT(CASE WHEN status = $2 THEN 1 END) as pending, COUNT(CASE WHEN status = $3 THEN 1 END) as failed FROM bulk_messages WHERE campaign_name = $4',
          ['sent', 'pending', 'failed', campaignName]
        );
    return result.rows[0];
  } finally {
    client.release();
  }
}

// ── Processor (needs twilioClient injected) ───────────────────────
function makeBulkProcessor(twilioClient) {
  // setInterval does not wait for an async callback, so a batch that outruns
  // BULK_INTERVAL_MS used to have two runs in flight at once. The claim below
  // makes that safe, this makes it not happen in the first place.
  let running = false;
  let reaperTick = 0;
  let runStartedAt = 0;
  let currentRun = 0;

  // If any await in a run never settles — a wedged pool connection, a Twilio
  // call with no timeout — `running` stays true and EVERY later tick returns
  // at the guard below. The reaper lives inside the same function, so it stops
  // running too: the queue goes silent until the dyno restarts, with no log
  // line saying why. That is the "bulk sender locked up" failure.
  //
  // Releasing the guard after this long is safe because claiming is what makes
  // it safe: the stuck run's rows are already flipped to 'sending', so a fresh
  // run claims different rows and nobody gets texted twice. The run token stops
  // a stale run's finally{} from clearing a newer run's guard on its way out.
  const RUN_WATCHDOG_MS = parseInt(process.env.BULK_RUN_WATCHDOG_MS) || 120000;

  async function processBulkMessages() {
    if (state.bulkSmsProcessorPaused) {
      console.log('⏸️  Paused');
      return;
    }
    if (running) {
      const stuckMs = Date.now() - runStartedAt;
      if (stuckMs < RUN_WATCHDOG_MS) return;
      console.error(`⚠️ Bulk run in flight ${Math.round(stuckMs / 1000)}s — releasing the guard. ` +
                    `Rows it claimed stay 'sending' and get reaped, never resent.`);
    }
    running = true;
    runStartedAt = Date.now();
    const myRun = ++currentRun;
    try {
      await createBulkMessagesTable();   // memoized; a no-op after the first call
      // Every ~5 minutes, surface anything a previous run died holding.
      if (++reaperTick % Math.max(1, Math.round(300000 / BULK_INTERVAL_MS)) === 0) {
        await reapStuckBulkMessages();
      }
      const pendingMessages = await claimPendingBulkMessages(BULK_BATCH_SIZE);
      if (pendingMessages.length === 0) return;

      // Build a per-tenant from-number cache for this batch
      // Caches the from-number AND the branding that fills {dealership} /
      // {city} in the campaign script — one lookup per tenant per batch.
      const tenantCache = {};
      async function getTenant(userId) {
        if (!userId) return { from: process.env.TWILIO_PHONE_NUMBER, dealership: process.env.DEALER_NAME || '', city: '' };
        if (tenantCache[userId]) return tenantCache[userId];
        let t = { from: process.env.TWILIO_PHONE_NUMBER, dealership: process.env.DEALER_NAME || '', city: '' };
        try {
          const r = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [userId]);
          const s = r.rows[0]?.settings_json;
          const parsed = typeof s === 'string' ? JSON.parse(s) : (s || {});
          t = {
            from:       parsed.twilioNumber || process.env.TWILIO_PHONE_NUMBER,
            dealership: parsed.dealerName   || process.env.DEALER_NAME || '',
            city:       parsed.dealerCity   || '',
          };
        } catch(e) { /* fall through to env defaults */ }
        tenantCache[userId] = t;
        return t;
      }

      for (const message of pendingMessages) {
        try {
          // 🚨 BLOCK SPAMMER +12899688778
          if (message.recipient_phone.includes('2899688778') ||
              message.recipient_phone.includes('12899688778')) {
            await updateBulkMessageStatus(message.id, 'blocked', 'Blacklisted number');
            console.log('🚫 BLOCKED SPAMMER:', message.recipient_phone);
            continue;
          }

          // A number we can't parse must never reach Twilio. Terminal
          // 'failed', not 'pending' — a row left pending gets picked up by
          // the very next tick and tries forever, which is how a handful of
          // bad CSV rows once turned into a rolling charge.
          const toNumber = normalizePhone(message.recipient_phone);
          if (!toNumber) {
            await updateBulkMessageStatus(message.id, 'failed', 'Invalid phone number — never sent');
            console.warn('🚫 INVALID NUMBER, not sent:', message.recipient_phone);
            continue;
          }

          // CASL: skip opted-out numbers
          if (await isOptedOut(message.recipient_phone)) {
            await updateBulkMessageStatus(message.id, 'blocked', 'Opted out (STOP)');
            console.log('🚫 SKIPPED OPT-OUT:', message.recipient_phone);
            continue;
          }

          // Per-number cooldown: skip if this phone got bulk SMS in last 24
          // hours. Matched across every stored format — an exact compare let
          // the same person be texted twice in a day under two spellings.
          const cooldownCheck = await pool.query(
            `SELECT 1 FROM bulk_messages
              WHERE recipient_phone = ANY($1) AND user_id IS NOT DISTINCT FROM $2
                AND status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
            [phoneKeys(message.recipient_phone), message.user_id]
          );
          if (cooldownCheck.rows.length > 0) {
            // Reschedule for 24 hours later instead of blocking. Back to
            // 'pending' too — it is claimed right now, and leaving it that way
            // would strand it in 'sending' forever.
            await pool.query(
              "UPDATE bulk_messages SET status = 'pending', claimed_at = NULL, scheduled_at = NOW() + INTERVAL '24 hours' WHERE id = $1",
              [message.id]
            );
            console.log('⏳ COOLDOWN: rescheduled', message.recipient_phone);
            continue;
          }

          const tenant = await getTenant(message.user_id);
          let merge = {};
          try {
            merge = typeof message.merge_json === 'string'
              ? JSON.parse(message.merge_json) : (message.merge_json || {});
          } catch(e) { merge = {}; }
          let personalizedMessage = fillTemplate(message.message_template, {
            name: message.recipient_name, dealership: tenant.dealership, city: tenant.city,
            ...merge,
          });

          // A token that didn't resolve must never reach a customer. Sending
          // a literal "{month}" is embarrassing; silently dropping it is
          // worse, because the sentence still reads fine and nobody finds
          // out. Terminal 'failed' with the token named, so it shows up in
          // the campaign's failed count and can be fixed and re-queued.
          const missing = unresolvedTokens(personalizedMessage);
          if (missing.length) {
            await updateBulkMessageStatus(message.id, 'failed',
              `Unfilled template token(s): ${missing.join(' ')} — not sent`);
            console.error(`🚫 UNFILLED TOKEN ${missing.join(' ')} for ${message.recipient_phone} — not sent`);
            continue;
          }
          // CASL compliance: ensure opt-out footer is present
          const hasStopFooter = /reply\s+stop|text\s+stop|opt.?out/i.test(personalizedMessage);
          if (!hasStopFooter) {
            personalizedMessage += ' (Reply STOP to opt out)';
          }
          const fromNumber = tenant.from;
          const statusCallbackUrl = process.env.BASE_URL ? process.env.BASE_URL + '/api/sms-status' : null;
          const sendOpts = { body: personalizedMessage, from: fromNumber, to: toNumber };
          if (statusCallbackUrl) sendOpts.statusCallback = statusCallbackUrl;

          const bulkResult = await guardedSmsSend(twilioClient, message.user_id, sendOpts);
          if (!bulkResult.ok) {
            if (bulkResult.reason === 'SPEND_CAP_EXCEEDED') {
              // Pause this tenant's remaining queued messages until next period
              // or overage top-up. Mark as 'paused' (not failed) so they can resume.
              console.warn(`⚠️ Bulk spend-cap hit for user ${message.user_id} — pausing campaign`);
              await pool.query(
                `UPDATE bulk_messages SET status = 'paused', claimed_at = NULL,
                        error_message = 'Paused: monthly Twilio cap reached — top up overage to resume'
                 WHERE user_id = $1 AND status IN ('pending', 'sending')`,
                [message.user_id]
              ).catch(() => {});
              continue;
            }
            const err = bulkResult.error || {};
            console.error(`❌ Bulk send FAILED to ${message.recipient_name} [${message.recipient_phone}] — Code: ${err.code} Msg: ${err.message}`);
            await updateBulkMessageStatus(message.id, 'failed', `Twilio ${err.code}: ${err.message}`);
            continue;
          }
          // Resolve the row FIRST. The conversation bookkeeping below is four
          // more round trips, and anything that interrupts them must not leave
          // a row looking unsent — the customer already has the text.
          await pool.query(
            `UPDATE bulk_messages
                SET status = 'sent', sent_at = NOW(), twilio_sid = COALESCE($1, twilio_sid)
              WHERE id = $2`,
            [bulkResult.sid || null, message.id]
          );

          const conversation = await getOrCreateConversation(message.recipient_phone, message.user_id);
          if (message.recipient_name && !conversation.customer_name) {
            await updateConversation(conversation.id, { customer_name: message.recipient_name });
          }
          // And on the customer record, which is where the conversations list
          // reads from. getOrCreateCustomer only ever inserts a phone, and the
          // only writers of customers.name are the two FSM branches that ask
          // for it out loud — so a campaign that already knows the name left
          // every row showing "Unknown".
          if (message.recipient_name) {
            await pool.query(
              `UPDATE customers SET name = $1 WHERE phone = $2 AND user_id = $3
                 AND (name IS NULL OR TRIM(name) = '')`,
              [message.recipient_name, message.recipient_phone, message.user_id]
            ).catch(() => {});
          }
          if (!conversation.source) {
            await pool.query('UPDATE conversations SET source = $1 WHERE id = $2', ['bulk_sms', conversation.id]).catch(() => {});
          }
          // Phase 7 — propagate campaign mode to the conversation so when
          // the customer replies, Sarah knows whether to run the buy-side
          // (sales) FSM or the seller-side (acquisition) FSM. Only sets
          // mode if it isn't already 'acquisition' — protects an existing
          // acquisition thread from being overwritten by a stray sales
          // campaign on the same number.
          if (message.mode === 'acquisition' && conversation.mode !== 'acquisition') {
            await updateConversation(conversation.id, { mode: 'acquisition', stage: 'acq_confirm' });
          }
          // Phase 8 — same for reengage campaigns, which run the aged-lead
          // FSM (one question, callback only). Never overwrites a live
          // acquisition thread.
          if (message.mode === 'reengage' && conversation.mode !== 'acquisition') {
            await updateConversation(conversation.id, { mode: 'reengage', stage: 'reengage_confirm' });
          }
          // Phase 9 — 'notify' campaigns are send-and-stop. Sarah delivers the
          // opener and never speaks on that thread again: the handoff flag is
          // stamped here, at send time, so the very first reply is forwarded
          // to the managers verbatim instead of starting a script.
          //
          // This exists for lists where no script is safe to run. The Wipe Out
          // Debt entrants are the case it was built for — every honest answer
          // there is about debt, and Sarah must never discuss credit,
          // financing or consolidation with a customer. Stamping at send time
          // leaves no window between the opener landing and a human owning it.
          //
          // No conversation mode is set: the thread keeps whatever it had, and
          // the webhook guard short-circuits before the router reads it. STOP
          // still passes through that guard, so opt-outs are unaffected.
          //
          // Deliberately not updateConversation — handoff_at is one-way and is
          // kept off the generic field whitelist on purpose.
          //
          // This one does not get a silent catch. Everywhere else in this
          // block a failed write costs a name or a source tag; here it is the
          // whole safety property — an unstamped thread runs the sales FSM on
          // the next reply. The text has already gone out by this point and
          // cannot be recalled, so the only thing left to do is make the
          // failure impossible to miss.
          if (message.mode === 'notify' && !conversation.handoff_at) {
            try {
              await pool.query(
                `UPDATE conversations SET handoff_at = NOW(), handoff_by = $1
                  WHERE id = $2 AND handoff_at IS NULL`,
                [message.user_id || null, conversation.id]
              );
              console.log(`🙋 Notify-only campaign — ${message.recipient_phone} handed to a human up front`);
            } catch (e) {
              console.error(
                `🚨 HANDOFF STAMP FAILED for ${message.recipient_phone} (conversation ${conversation.id}): ${e.message}\n` +
                `   This thread is NOT protected — Sarah will run the FSM on the next reply. Set handoff_at by hand now.`
              );
            }
          }
          await saveMessage(conversation.id, message.recipient_phone, 'assistant', personalizedMessage, message.user_id);
          console.log(`✅ Bulk SMS sent to ${message.recipient_name} [tenant:${message.user_id||'global'}]`);

        } catch (error) {
          console.error(`❌ Bulk SMS failed for ${message.recipient_name}:`, error.message);
          // The row is marked 'sent' the instant Twilio accepts it, so a throw
          // from the conversation bookkeeping afterwards must not rewrite that
          // to 'failed' — the customer has the text either way, and a false
          // 'failed' is how someone ends up resending by hand.
          await pool.query(
            `UPDATE bulk_messages SET status = 'failed', error_message = $1
              WHERE id = $2 AND status <> 'sent'`,
            [String(error.message || error).slice(0, 300), message.id]
          ).catch(() => {});
        }
      }
    } catch (error) {
      console.error('❌ Bulk processor error:', error);
    } finally {
      // Only the newest run owns the guard — a stale run finishing after the
      // watchdog released it must not unlock the one now in flight.
      if (myRun === currentRun) running = false;
    }
  }

  function startBulkProcessor() {
    if (state.bulkSmsProcessor) return;
    console.log('🚀 Bulk SMS processor started');
    console.log(`⚙️  Batch size: ${BULK_BATCH_SIZE}, Interval: ${BULK_INTERVAL_MS}ms`);
    processBulkMessages();
    state.bulkSmsProcessor = setInterval(processBulkMessages, BULK_INTERVAL_MS);
  }

  return { startBulkProcessor, processBulkMessages };
}

module.exports = {
  state,
  createBulkMessagesTable,
  saveBulkCampaign,
  getPendingBulkMessages,
  claimPendingBulkMessages,
  reapStuckBulkMessages,
  updateBulkMessageStatus,
  getBulkCampaignStats,
  makeBulkProcessor,
  BULK_BATCH_SIZE,
  BULK_INTERVAL_MS
};

