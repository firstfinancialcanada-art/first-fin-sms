const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Store active SMS conversations (in production, use database)
const conversations = {};

// Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE',
    twoway_sms: 'Ready',
    backend_url: `https://${req.get('host')}/api`
  });
});

// Start SMS conversation (from HTML button)
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone } = req.body;
    
    // Initialize conversation
    conversations[phone] = {
      messages: [],
      started: new Date(),
      status: 'active',
      data: {}
    };
    
    // Send first message
    const initialMessage = "Hi! 👋 I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)";
    
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: initialMessage
    });
    
    conversations[phone].messages.push({ role: 'assistant', content: initialMessage });
    
    res.json({ success: true, message: 'SMS conversation started!' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Twilio Webhook - Incoming SMS
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;
    const customerPhone = From;
    const customerMessage = Body.trim();
    
    console.log('Incoming SMS from:', customerPhone, '- Message:', customerMessage);
    
    // Initialize conversation if doesn't exist
    if (!conversations[customerPhone]) {
      conversations[customerPhone] = {
        messages: [],
        started: new Date(),
        status: 'active',
        data: {}
      };
    }
    
    // Add customer message
    conversations[customerPhone].messages.push({ role: 'user', content: customerMessage });
    
    // Get AI response from Perplexity
    const aiResponse = await getJerryResponse(customerPhone, customerMessage);
    
    // Send response via Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse);
    
    conversations[customerPhone].messages.push({ role: 'assistant', content: aiResponse });
    
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Webhook error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("I'm having trouble right now. Please call us at (403) 555-0100!");
    res.type('text/xml').send(twiml.toString());
  }
});

// Generate Jerry's AI response
async function getJerryResponse(phone, message) {
  try {
    const conversation = conversations[phone];
    const lowerMsg = message.toLowerCase();
    
    // Build context
    const context = `You are Jerry, a friendly car dealership AI assistant via SMS. Keep responses SHORT (1-2 sentences max).
Customer conversation so far: ${JSON.stringify(conversation.messages.slice(-5))}

Your goals:
1. Ask about vehicle preferences (type, budget)
2. Offer to book test drive appointment
3. Get name and preferred date/time
4. Confirm appointment details

Current message: ${message}`;
    
    // Check for booking intent
    if (lowerMsg.includes('book') || lowerMsg.includes('appointment') || lowerMsg.includes('test drive') || lowerMsg.includes('schedule')) {
      conversation.data.intent = 'booking';
      if (!conversation.data.name) {
        return "Great! What's your name?";
      } else if (!conversation.data.date) {
        return `Perfect ${conversation.data.name}! What day works best for you this week?`;
      } else {
        return `Got it! What time works best - morning (9-12) or afternoon (1-5)?`;
      }
    }
    
    // Check for callback
    if (lowerMsg.includes('call') || lowerMsg.includes('phone')) {
      conversation.data.intent = 'callback';
      return "I'd be happy to have someone call you! What's the best time to reach you?";
    }
    
    // Extract name if not set
    if (!conversation.data.name && conversation.messages.length > 2) {
      const words = message.split(' ');
      if (words.length <= 3) {
        conversation.data.name = message;
        return `Nice to meet you, ${message}! What type of vehicle interests you - Sedan, SUV, or Truck?`;
      }
    }
    
    // Call Perplexity for intelligent response
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-small-chat',
        messages: [{ role: 'user', content: context }]
      })
    });
    
    const data = await response.json();
    return data.choices[0].message.content.substring(0, 160); // SMS limit
    
  } catch (error) {
    console.error('AI error:', error);
    return "I'm here to help! Are you interested in booking a test drive?";
  }
}

// Regular chat endpoint (for web)
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

// Manual SMS
app.post('/api/send-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: message
    });
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend with 2-Way SMS on port ${PORT}`);
});
