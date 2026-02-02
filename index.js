const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE on Railway',
    timestamp: new Date().toISOString(),
    perplexity: !!process.env.PERPLEXITY_API_KEY,
    twilio: !!process.env.TWILIO_ACCOUNT_SID,
    backend_url: `https://${req.get('host')}/api`
  });
});

// Perplexity Chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-small-chat',
        messages: [{ role: 'user', content: message }]
      })
    });
    const data = await response.json();
    res.json({ success: true, message: data.choices[0].message.content });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Twilio SMS
app.post('/api/send-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const result = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: message
    });
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});
