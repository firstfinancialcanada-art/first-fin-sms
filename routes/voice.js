// routes/voice.js
const { pool, getOrCreateConversation, saveMessage, logAnalytics } = require('../lib/db');
const { normalizePhone, isBusinessHours, twimlSafe, makeTwilioWebhookValidator } = require('../lib/helpers');
const validateTwilio = makeTwilioWebhookValidator();

// ── Voice table setup ─────────────────────────────────────────────
async function createVoiceTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS voicemails (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER,
        caller_phone    VARCHAR(30),
        call_sid        VARCHAR(60),
        recording_url   VARCHAR(500),
        recording_sid   VARCHAR(60),
        transcript      TEXT,
        duration        INTEGER,
        call_type       VARCHAR(20) DEFAULT 'inbound',
        notified        BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_voicemails_phone ON voicemails(caller_phone)`);
    await client.query(`ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS user_id INTEGER`).catch(() => {});
    console.log('✅ voicemails table ready');
  } catch(e) {
    console.error('❌ voicemails table error:', e.message);
  } finally { client.release(); }
}
createVoiceTable();

// ── Get recent SMS history for call preview ───────────────────────
async function getCustomerSMSHistory(phone, userId, limit = 4) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT m.role, m.content, m.created_at, c.customer_name
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.customer_phone = $1
        AND c.user_id = $3
        AND m.content NOT LIKE '📞%'
        AND m.content NOT LIKE '📬%'
        AND m.content NOT LIKE '📵%'
      ORDER BY m.created_at DESC
      LIMIT $2
    `, [phone, limit, userId]);
    return result.rows.reverse();
  } catch(e) {
    console.error('❌ getCustomerSMSHistory error:', e.message);
    return [];
  } finally { client.release(); }
}

// ── Resolve tenant from inbound Twilio number ─────────────────────
async function getTenantByNumber(toNumber) {
  const fallbackSettings = {
    userId:      null,
    fromNumber:  process.env.TWILIO_PHONE_NUMBER,
    forwardPhone: process.env.FORWARD_PHONE || process.env.OWNER_PHONE || '',
    dealerName:  process.env.DEALER_NAME || 'First Financial'
  };
  if (!toNumber) return fallbackSettings;
  try {
    const r = await pool.query(
      `SELECT id, settings_json FROM desk_users WHERE twilio_number = $1 LIMIT 1`,
      [toNumber]
    );
    if (!r.rows.length) return fallbackSettings;
    const row = r.rows[0];
    const s = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : (row.settings_json || {});
    return {
      userId:       row.id,
      fromNumber:   s.twilioNumber  || process.env.TWILIO_PHONE_NUMBER,
      forwardPhone: s.notifyPhone   || process.env.FORWARD_PHONE || process.env.OWNER_PHONE || '',
      dealerName:   s.dealerName    || process.env.DEALER_NAME   || 'First Financial'
    };
  } catch(e) {
    console.error('⚠️ getTenantByNumber failed:', e.message);
    return fallbackSettings;
  }
}

// ── Save a voice event into the unified timeline ──────────────────
async function saveVoiceEvent(phone, eventContent, role = 'user', userId = null) {
  try {
    const normalized = normalizePhone(phone) || phone;
    const conv = await getOrCreateConversation(normalized, userId);
    const client = await pool.connect();
    try {
      await client.query(
        'INSERT INTO messages (conversation_id, customer_phone, role, content, user_id) VALUES ($1, $2, $3, $4, $5)',
        [conv.id, normalized, role, eventContent, userId]
      );
    } finally { client.release(); }
    console.log('📋 Voice event logged:', eventContent.substring(0, 60));
  } catch(e) {
    console.error('❌ saveVoiceEvent error:', e.message);
  }
}

// ── Error sanitizer — never leak DB internals to client ──────────
function sanitizeError(e) {
  console.error('Route error:', e);
  return 'An unexpected error occurred. Please try again.';
}

module.exports = function voiceRoutes(app, { twilioClient, requireAuth, requireBilling }) {

  // ── Health check for Desk ─────────────────────────────────────
  app.get('/api/desk-ping', (req, res) => {
    const token = req.query.token || req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    res.json({
      success: true, version: 'sarah_v4',
      timestamp: new Date().toISOString(),
      features: ['qualified-leads','deals','deal-funded','campaign-from-crm','voice-drop','voice-campaign']
    });
  });

  // ── 1. INBOUND CALL HANDLER ───────────────────────────────────
  app.post('/api/voice/inbound', validateTwilio, async (req, res) => {
    const tenant   = await getTenantByNumber(req.body.To || process.env.TWILIO_PHONE_NUMBER);
    const dealer   = twimlSafe(tenant.dealerName);
    const baseUrl  = process.env.BASE_URL || '';
    const hours    = isBusinessHours();
    res.type('text/xml');

    if (hours) {
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${baseUrl}/api/voice/inbound-gather" timeout="8" method="POST">
    <Say voice="Polly.Joanna" language="en-CA">
      Thank you for calling ${dealer}. 
      To speak with us now, press 1.
      To leave a voicemail, press 2.
      To have us text you back, press 3.
    </Say>
  </Gather>
  <Say voice="Polly.Joanna" language="en-CA">
    We didn't catch that. Please leave us a message after the tone and we will get right back to you.
  </Say>
  <Record 
    action="${baseUrl}/api/voice/voicemail-done"
    transcribe="true"
    transcribeCallback="${baseUrl}/api/voice/transcription"
    maxLength="120"
    playBeep="true"
    trim="trim-silence"
  />
</Response>`);
    } else {
      const start    = process.env.BUSINESS_HOURS_START || '9';
      const end      = parseInt(process.env.BUSINESS_HOURS_END || 18);
      const endFmt   = end > 12 ? (end-12)+'pm' : end+'am';
      const startFmt = parseInt(start) > 12 ? (parseInt(start)-12)+'pm' : start+'am';
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${baseUrl}/api/voice/inbound-gather" timeout="8" method="POST">
    <Say voice="Polly.Joanna" language="en-CA">
      Thank you for calling ${dealer}. 
      Our team is currently unavailable. Our hours are ${startFmt} to ${endFmt}, Monday through Friday.
      Press 1 to leave a voicemail and we will call you back first thing.
      Or simply hang up and reply to this number by text — we respond quickly.
    </Say>
  </Gather>
  <Say voice="Polly.Joanna" language="en-CA">
    Please leave us a message after the tone.
  </Say>
  <Record 
    action="${baseUrl}/api/voice/voicemail-done"
    transcribe="true"
    transcribeCallback="${baseUrl}/api/voice/transcription"
    maxLength="120"
    playBeep="true"
    trim="trim-silence"
  />
</Response>`);
    }
  });

  // ── 2. GATHER HANDLER ─────────────────────────────────────────
  app.post('/api/voice/inbound-gather', validateTwilio, async (req, res) => {
    const digit   = req.body.Digits;
    const caller  = req.body.From || req.body.Caller || '';
    const callSid = req.body.CallSid || '';
    const tenant  = await getTenantByNumber(req.body.To || process.env.TWILIO_PHONE_NUMBER);
    const dealer  = twimlSafe(tenant.dealerName);
    const forward = tenant.forwardPhone;
    const fromNum = tenant.fromNumber;
    const baseUrl = process.env.BASE_URL || '';
    res.type('text/xml');
    console.log(`📞 Inbound keypress: ${digit} from ${caller} [tenant:${tenant.userId||'global'}]`);

    if (digit === '1' && forward) {
      await saveVoiceEvent(caller, `📞 CALL_INBOUND | status:connecting | pressed:1`, 'user', tenant.userId);
      try {
        const history = await getCustomerSMSHistory(caller, tenant.userId, 4);
        if (history.length > 0) {
          const callerFmt = caller.replace('+1','');
          const name      = history[0].customer_name || callerFmt;
          const preview   = history.map(m => (m.role === 'user' ? '👤' : '🤖') + ' \"' + m.content.substring(0, 80) + (m.content.length > 80 ? '...' : '') + '\"').join('\n');
          const lastDate  = new Date(history[history.length-1].created_at).toLocaleDateString();
          await twilioClient.messages.create({
            body: `📞 Incoming call — ${name} (${callerFmt})\nLast contact: ${lastDate}\n\n${preview}`,
            from: fromNum,
            to: forward
          });
          console.log('📱 Call context preview sent for:', caller);
        }
      } catch(e) { console.error('❌ Call preview SMS error:', e.message); }

      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">Please hold for just a moment while we connect you.</Say>
  <Dial 
    action="${baseUrl}/api/voice/call-complete"
    timeout="20"
    callerId="${fromNum}"
  >
    <Number url="${baseUrl}/api/voice/whisper">${forward}</Number>
  </Dial>
  <Say voice="Polly.Joanna" language="en-CA">
    We're sorry, no one is available right now. Please leave a message after the tone.
  </Say>
  <Record 
    action="${baseUrl}/api/voice/voicemail-done"
    transcribe="true"
    transcribeCallback="${baseUrl}/api/voice/transcription"
    maxLength="120"
    playBeep="true"
    trim="trim-silence"
  />
</Response>`);

    } else if (digit === '2') {
      await saveVoiceEvent(caller, `📞 CALL_INBOUND | status:voicemail_requested | pressed:2`, 'user', tenant.userId);
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">
    Please leave your name, number, and what vehicle you're looking for after the tone. 
    We'll get back to you as soon as possible.
  </Say>
  <Record 
    action="${baseUrl}/api/voice/voicemail-done"
    transcribe="true"
    transcribeCallback="${baseUrl}/api/voice/transcription"
    maxLength="120"
    playBeep="true"
    trim="trim-silence"
  />
</Response>`);

    } else if (digit === '3') {
      try {
        if (caller && caller.startsWith('+')) {
          const msg = `Hi! You just called ${tenant.dealerName}. We'll get right back to you! If you can share what vehicle you're looking for, we'll have info ready when we connect. 🚗`;
          await twilioClient.messages.create({ body: msg, from: fromNum, to: caller });
          const conv = await getOrCreateConversation(caller, tenant.userId);
          await saveMessage(conv.id, caller, 'assistant', msg, tenant.userId);
          await logAnalytics('inbound_call_sms_requested', caller, { callSid });
          await saveVoiceEvent(caller, '📞 CALL_INBOUND | status:text_back_requested | pressed:3', 'user', tenant.userId);
          console.log('📱 Text-back sent to:', caller);
        }
      } catch(e) { console.error('❌ Text-back failed:', e.message); }
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">
    Perfect. We just sent you a text message. We'll follow up with you shortly. Have a great day!
  </Say>
  <Hangup/>
</Response>`);

    } else {
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">
    Please leave us a message after the tone.
  </Say>
  <Record 
    action="${baseUrl}/api/voice/voicemail-done"
    transcribe="true"
    transcribeCallback="${baseUrl}/api/voice/transcription"
    maxLength="120"
    playBeep="true"
    trim="trim-silence"
  />
</Response>`);
    }
  });

  // ── 3. WHISPER ────────────────────────────────────────────────
  app.post('/api/voice/whisper', validateTwilio, (req, res) => {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">
    Incoming lead call from First Financial. Press any key to connect.
  </Say>
  <Gather numDigits="1" timeout="5"/>
</Response>`);
  });

  // ── 4. VOICEMAIL RECORDING COMPLETE ──────────────────────────
  app.post('/api/voice/voicemail-done', validateTwilio, async (req, res) => {
    const caller       = req.body.From    || req.body.Caller || '';
    const callSid      = req.body.CallSid || '';
    const recordingUrl = req.body.RecordingUrl || '';
    const recordingSid = req.body.RecordingSid || '';
    const duration     = parseInt(req.body.RecordingDuration) || 0;
    const tenant       = await getTenantByNumber(req.body.To || process.env.TWILIO_PHONE_NUMBER);
    console.log(`📬 Voicemail received from ${caller}, ${duration}s, SID: ${recordingSid} [tenant:${tenant.userId||'global'}]`);

    try {
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO voicemails (caller_phone, call_sid, recording_url, recording_sid, duration, user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
          [caller, callSid, recordingUrl + '.mp3', recordingSid, duration, tenant.userId]
        );
      } finally { client.release(); }
    } catch(e) { console.error('❌ Voicemail save error:', e.message); }

    try {
      if (tenant.forwardPhone) {
        const callerFmt = caller.replace('+1','');
        await twilioClient.messages.create({
          body: `📬 New voicemail from ${callerFmt} (${duration}s)\n🔗 Listen: ${recordingUrl}.mp3\n\nReply to them via the platform.`,
          from: tenant.fromNumber,
          to: tenant.forwardPhone
        });
      }
    } catch(e) { console.error('❌ Voicemail notification error:', e.message); }

    await logAnalytics('voicemail_received', caller, { callSid, duration });
    await saveVoiceEvent(caller, `📬 VOICEMAIL | duration:${duration}s | recording:${recordingUrl}.mp3`, 'user', tenant.userId);

    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">
    Your message has been received. We'll get back to you shortly. Thank you for calling!
  </Say>
  <Hangup/>
</Response>`);
  });

  // ── 5. TRANSCRIPTION CALLBACK ─────────────────────────────────
  app.post('/api/voice/transcription', validateTwilio, async (req, res) => {
    const recordingSid = req.body.RecordingSid  || '';
    const transcript   = req.body.TranscriptionText || '';
    const caller       = req.body.From || '';
    console.log(`📝 Transcription ready for ${recordingSid}: "${transcript.substring(0,80)}..."`);

    if (transcript && recordingSid) {
      try {
        const client = await pool.connect();
        let voicemailUserId = null;
        try {
          await client.query(`UPDATE voicemails SET transcript = $1 WHERE recording_sid = $2`, [transcript, recordingSid]);
          // Resolve tenant from voicemail record for scoped updates
          const vmRow = await client.query(`SELECT user_id FROM voicemails WHERE recording_sid = $1 LIMIT 1`, [recordingSid]);
          voicemailUserId = vmRow.rows[0]?.user_id || null;
        } finally { client.release(); }

        if (caller) {
          const normalized = normalizePhone(caller) || caller;
          const convCheck  = await pool.connect();
          try {
            if (voicemailUserId) {
              await convCheck.query(`
                UPDATE messages SET content = $1
                WHERE customer_phone = $2
                  AND user_id = $3
                  AND content LIKE '📬 VOICEMAIL%'
                  AND created_at > NOW() - INTERVAL '10 minutes'
              `, [`📬 VOICEMAIL | transcript: "${transcript.substring(0, 200)}"`, normalized, voicemailUserId]);
            } else {
              // No tenant resolved — skip update rather than updating across all tenants
              console.warn('⚠️ Transcription: no user_id on voicemail record, skipping message update');
            }
          } catch(e){ console.error('Timeline transcript update error:', e.message); }
          finally { convCheck.release(); }
        }

        const forward = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;
        if (forward && transcript.length > 5) {
          const callerFmt = (caller||'').replace('+1','');
          // Use tenant from voicemail record for correct from number
          let fromNum = process.env.TWILIO_PHONE_NUMBER;
          try {
            if (voicemailUserId) {
              const sr = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [voicemailUserId]);
              const s = typeof sr.rows[0]?.settings_json === 'string' ? JSON.parse(sr.rows[0].settings_json) : (sr.rows[0]?.settings_json || {});
              if (s.twilioNumber) fromNum = s.twilioNumber;
            }
          } catch(e) {}
          await twilioClient.messages.create({
            body: `📝 Voicemail transcript from ${callerFmt}:\n\n"${transcript.substring(0,280)}"`,
            from: fromNum,
            to: forward
          });
        }
      } catch(e) { console.error('❌ Transcript save error:', e.message); }
    }
    res.sendStatus(200);
  });

  // ── 6. CALL COMPLETE ──────────────────────────────────────────
  app.post('/api/voice/call-complete', validateTwilio, async (req, res) => {
    const caller       = req.body.From    || '';
    const dialStatus   = req.body.DialCallStatus || '';
    const callDuration = req.body.DialCallDuration || 0;
    const baseUrl      = process.env.BASE_URL || '';
    const tenant       = await getTenantByNumber(req.body.To || process.env.TWILIO_PHONE_NUMBER);
    console.log(`📞 Call complete: ${dialStatus}, ${callDuration}s from ${caller} [tenant:${tenant.userId||'global'}]`);
    await logAnalytics('inbound_call_complete', caller, { dialStatus, callDuration });
    const statusLabel = dialStatus === 'completed' ? `connected (${callDuration}s)` : dialStatus;
    await saveVoiceEvent(caller, `📞 CALL_COMPLETE | status:${statusLabel}`, 'user', tenant.userId);

    if (dialStatus === 'no-answer' || dialStatus === 'busy' || dialStatus === 'failed') {
      res.type('text/xml');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">
    We're sorry, no one is available. Please leave a message after the tone.
  </Say>
  <Record 
    action="${baseUrl}/api/voice/voicemail-done"
    transcribe="true"
    transcribeCallback="${baseUrl}/api/voice/transcription"
    maxLength="120"
    playBeep="true"
  />
</Response>`);
    }
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  });

  // ── 7. Get voicemails ─────────────────────────────────────────
  app.get('/api/voicemails', requireAuth, async (req, res) => {
    const uid = req.user.userId;
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM voicemails WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [uid]
      );
      res.json({ success: true, voicemails: result.rows });
    } catch(e) {
      res.status(500).json({ success: false, error: sanitizeError(e) });
    } finally { client.release(); }
  });

  // ── 8. Voice drop v2 ─────────────────────────────────────────
  app.post('/api/voice/drop-v2', requireAuth, requireBilling, async (req, res) => {
    try {
      const uid = req.user.userId;
      const { phone, customerName, message } = req.body;
      if (!phone || !message) return res.status(400).json({ success: false, error: 'phone and message required' });
      const normalized = normalizePhone(phone);
      if (!normalized) return res.status(400).json({ success: false, error: 'Invalid phone' });
      const name    = twimlSafe(customerName || 'there');
      const safeMsg = twimlSafe(message.replace(/{name}/gi, name));
      const baseUrl = process.env.BASE_URL || '';

      // Use tenant's provisioned number so caller ID shows dealer's number
      let fromNumber = process.env.TWILIO_PHONE_NUMBER;
      try {
        const ts = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [uid]);
        const s  = ts.rows[0]?.settings_json;
        const p  = typeof s === 'string' ? JSON.parse(s) : (s || {});
        if (p.twilioNumber) fromNumber = p.twilioNumber;
      } catch(e) { console.warn('⚠️ voice drop tenant lookup:', e.message); }

      const call = await twilioClient.calls.create({
        to: normalized,
        from: fromNumber,
        twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-CA">${safeMsg}</Say>
  <Pause length="1"/>
  <Gather numDigits="1" action="${baseUrl}/api/voice/drop-keypress" timeout="8" method="POST">
    <Say voice="Polly.Joanna" language="en-CA">
      To speak with us right now, press 1. 
      To opt out of future calls, press 9.
      Or simply reply to this number by text anytime.
    </Say>
  </Gather>
  <Say voice="Polly.Joanna" language="en-CA">Thanks for listening. Have a great day!</Say>
  <Hangup/>
</Response>`
      });

      await logAnalytics('voice_drop_v2', normalized, { callSid: call.sid, customerName });
      await saveVoiceEvent(normalized, `📵 VOICE_DROP | sid:${call.sid} | name:${customerName||''}`, 'assistant');
      console.log('📞 Voice drop v2:', call.sid, '->', normalized);
      res.json({ success: true, callSid: call.sid, to: normalized });
    } catch(e) {
      console.error('❌ /api/voice/drop-v2 error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── 9. Drop keypress ─────────────────────────────────────────
  app.post('/api/voice/drop-keypress', validateTwilio, async (req, res) => {
    const digit   = req.body.Digits;
    const callee  = req.body.To || '';
    const callSid = req.body.CallSid || '';
    const tenant  = await getTenantByNumber(req.body.Called || process.env.TWILIO_PHONE_NUMBER);
    const forward = tenant.forwardPhone;
    const fromNum = tenant.fromNumber;
    const baseUrl = process.env.BASE_URL || '';
    res.type('text/xml');

    if (digit === '1' && forward) {
      await logAnalytics('voice_drop_press1', callee, { callSid });
      await saveVoiceEvent(callee, `📞 VOICE_DROP_CALLBACK | status:connecting | pressed:1`, 'user', tenant.userId);
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">Great! Connecting you now. One moment please.</Say>
  <Dial 
    action="${baseUrl}/api/voice/call-complete"
    timeout="20"
    callerId="${fromNum}"
  >
    <Number url="${baseUrl}/api/voice/whisper">${forward}</Number>
  </Dial>
</Response>`);
    } else if (digit === '9') {
      await logAnalytics('voice_drop_optout', callee, { callSid });
      try {
        const normalized = normalizePhone(callee);
        if (normalized) {
          const conv = await getOrCreateConversation(normalized);
          await saveMessage(conv.id, normalized, 'assistant', '[Customer opted out of voice calls via press-9]');
        }
      } catch(e) { console.error('Opt-out log error:', e.message); }
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-CA">
    You have been removed from our call list. We apologize for any inconvenience. Goodbye.
  </Say>
  <Hangup/>
</Response>`);
    } else {
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
  });

  // ── 10. Voice campaign v2 ─────────────────────────────────────
  app.post('/api/voice/campaign-v2', async (req, res) => {
    const token = req.body.token || req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN) return res.status(403).json({ success: false, error: 'Forbidden' });
    try {
      const { contacts, message, delaySeconds } = req.body;
      if (!contacts?.length || !message) return res.status(400).json({ success: false, error: 'contacts[] and message required' });
      const delay = parseInt(delaySeconds) || 12;
      let scheduled = 0, skipped = 0;
      for (let i = 0; i < contacts.length; i++) {
        const normalized = normalizePhone(contacts[i].phone);
        if (!normalized) { skipped++; continue; }
        setTimeout(async () => {
          try {
            const name    = twimlSafe(contacts[i].name || 'there');
            const safeMsg = twimlSafe(message.replace(/{name}/gi, name));
            const baseUrl = process.env.BASE_URL || '';
            await twilioClient.calls.create({
              to: normalized, from: process.env.TWILIO_PHONE_NUMBER,
              twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="Polly.Joanna" language="en-CA">${safeMsg}</Say><Pause length="1"/><Gather numDigits="1" action="${baseUrl}/api/voice/drop-keypress" timeout="8" method="POST"><Say voice="Polly.Joanna" language="en-CA">To speak with us right now, press 1. To opt out of future calls, press 9.</Say></Gather><Hangup/></Response>`
            });
            console.log(`📞 Campaign v2 drop ${i+1}/${contacts.length}:`, normalized);
          } catch(err) { console.error('❌ Campaign drop failed:', normalized, err.message); }
        }, i * delay * 1000);
        scheduled++;
      }
      res.json({ success: true, scheduled, skipped, message: `${scheduled} voice drops queued (${delay}s apart)` });
    } catch(e) {
      console.error('❌ /api/voice/campaign-v2 error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── Legacy voice drop (v1) ────────────────────────────────────
  app.post('/api/voice/drop', async (req, res) => {
    const token = req.body.token || req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN) return res.status(403).json({ success: false, error: 'Forbidden' });
    try {
      const { phone, message } = req.body;
      if (!phone || !message) return res.status(400).json({ success: false, error: 'phone and message required' });
      const normalized = normalizePhone(phone);
      if (!normalized) return res.status(400).json({ success: false, error: 'Invalid phone' });
      const call = await twilioClient.calls.create({
        to: normalized, from: process.env.TWILIO_PHONE_NUMBER,
        twiml: `<Response><Say voice="Polly.Joanna">${message.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Say><Pause length="1"/><Say voice="Polly.Joanna">Press 1 to speak with us now or simply reply to this number by text. Thank you!</Say><Gather numDigits="1" action="${process.env.BASE_URL || ''}/api/voice/keypress"><Pause length="5"/></Gather></Response>`
      });
      await logAnalytics('voice_drop', normalized, { callSid: call.sid });
      console.log('📞 Voice drop initiated:', call.sid, '->', normalized);
      res.json({ success: true, callSid: call.sid, to: normalized });
    } catch(e) {
      console.error('❌ /api/voice/drop error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── Legacy voice campaign (v1) ────────────────────────────────
  app.post('/api/voice/campaign', requireAuth, requireBilling, async (req, res) => {
    try {
      const uid = req.user.userId;
      const { contacts, message, delaySeconds } = req.body;
      if (!contacts || !contacts.length || !message) return res.status(400).json({ success: false, error: 'contacts[] and message required' });

      // Resolve tenant number once for entire campaign
      let fromNumber = process.env.TWILIO_PHONE_NUMBER;
      try {
        const ts = await pool.query('SELECT settings_json FROM desk_users WHERE id = $1', [uid]);
        const s  = ts.rows[0]?.settings_json;
        const p  = typeof s === 'string' ? JSON.parse(s) : (s || {});
        if (p.twilioNumber) fromNumber = p.twilioNumber;
      } catch(e) { console.warn('⚠️ voice campaign tenant lookup:', e.message); }

      const delay = parseInt(delaySeconds) || 10;
      let scheduled = 0;
      for (let i = 0; i < contacts.length; i++) {
        const normalized = normalizePhone(contacts[i].phone);
        if (!normalized) continue;
        setTimeout(async () => {
          try {
            const personalizedMsg = message.replace(/{name}/gi, contacts[i].name || 'there');
            await twilioClient.calls.create({
              to: normalized, from: fromNumber,
              twiml: `<Response><Say voice="Polly.Joanna">${personalizedMsg.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Say><Pause length="1"/><Say voice="Polly.Joanna">Press 1 to speak with us or reply by text. Thank you!</Say><Gather numDigits="1" action="${process.env.BASE_URL || ''}/api/voice/keypress"><Pause length="5"/></Gather></Response>`
            });
            console.log('📞 Voice drop sent:', normalized);
          } catch (err) { console.error('❌ Voice drop failed for', normalized, err.message); }
        }, i * delay * 1000);
        scheduled++;
      }
      res.json({ success: true, scheduled, message: `${scheduled} voice drops queued` });
    } catch(e) {
      console.error('❌ /api/voice/campaign error:', e.message);
      res.status(500).json({ success: false, error: sanitizeError(e) });
    }
  });

  // ── Legacy keypress handler (v1) ──────────────────────────────
  app.post('/api/voice/keypress', validateTwilio, (req, res) => {
    const digit     = req.body.Digits;
    const forwardTo = process.env.FORWARD_PHONE || process.env.OWNER_PHONE;
    if (digit === '1' && forwardTo) {
      res.type('text/xml').send(`<Response><Say voice="Polly.Joanna">Please hold while we connect you.</Say><Dial>${forwardTo}</Dial></Response>`);
    } else {
      res.type('text/xml').send(`<Response><Say voice="Polly.Joanna">Thank you! Feel free to text us anytime. Goodbye!</Say><Hangup/></Response>`);
    }
  });

};

