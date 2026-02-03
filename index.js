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

// Store conversations
const conversations = {};
const appointments = [];
const callbacks = [];

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE',
    endpoints: {
      startSms: '/api/start-sms',
      webhook: '/api/sms-webhook',
      conversations: '/api/conversations',
      appointments: '/api/appointments',
      callbacks: '/api/callbacks'
    }
  });
});

// Get conversations
app.get('/api/conversations', (req, res) => {
  const convList = Object.keys(conversations).map(phone => ({
    phone: phone,
    status: conversations[phone].status,
    stage: conversations[phone].stage,
    data: conversations[phone].data,
    started: conversations[phone].started,
    messageCount: conversations[phone].messages.length
  }));
  res.json({ success: true, conversations: convList });
});

// Get appointments
app.get('/api/appointments', (req, res) => {
  res.json({ success: true, appointments: appointments });
});

// Get callbacks
app.get('/api/callbacks', (req, res) => {
  res.json({ success: true, callbacks: callbacks });
});

// Start SMS
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    conversations[phone] = {
      messages: [],
      started: new Date(),
      status: 'active',
      stage: 'greeting',
      data: {}
    };
    
    const initialMessage = message || "Hi! 👋 I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)";
    
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: initialMessage
    });
    
    conversations[phone].messages.push({ 
      role: 'assistant', 
      content: initialMessage,
      timestamp: new Date()
    });
    
    res.json({ success: true, message: 'SMS sent!' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Twilio Webhook
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;
    const customerPhone = From;
    const customerMessage = Body.trim();
    
    console.log('📱 SMS from:', customerPhone, '- Message:', customerMessage);
    
    if (!conversations[customerPhone]) {
      conversations[customerPhone] = {
        messages: [],
        started: new Date(),
        status: 'active',
        stage: 'greeting',
        data: {}
      };
    }
    
    conversations[customerPhone].messages.push({ 
      role: 'user', 
      content: customerMessage,
      timestamp: new Date()
    });
    
    const aiResponse = await getJerryResponse(customerPhone, customerMessage);
    
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse);
    
    conversations[customerPhone].messages.push({ 
      role: 'assistant', 
      content: aiResponse,
      timestamp: new Date()
    });
    
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('❌ Error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("I'm having trouble right now. Please call us at (403) 555-0100!");
    res.type('text/xml').send(twiml.toString());
  }
});

async function getJerryResponse(phone, message) {
  const conversation = conversations[phone];
  const lowerMsg = message.toLowerCase();
  
  if (lowerMsg === 'stop') {
    conversation.status = 'stopped';
    return "You've been unsubscribed. Reply START to resume.";
  }
  
  // Stage 1: Vehicle Interest
  if (conversation.stage === 'greeting' || !conversation.data.vehicleType) {
    if (lowerMsg.includes('suv') || lowerMsg.includes('truck') || lowerMsg.includes('sedan') || 
        lowerMsg.includes('car') || lowerMsg.includes('vehicle') || lowerMsg.includes('yes') || 
        lowerMsg.includes('interested')) {
      
      if (lowerMsg.includes('suv')) conversation.data.vehicleType = 'SUV';
      else if (lowerMsg.includes('truck')) conversation.data.vehicleType = 'Truck';
      else if (lowerMsg.includes('sedan')) conversation.data.vehicleType = 'Sedan';
      else conversation.data.vehicleType = 'Vehicle';
      
      conversation.stage = 'budget';
      return `Great choice! What's your budget range for a ${conversation.data.vehicleType}? (Under $30k, $30k-$50k, $50k+)`;
    }
    return "What type of vehicle interests you? We have SUVs, Trucks, Sedans, and more!";
  }
  
  // Stage 2: Budget
  if (conversation.stage === 'budget' && !conversation.data.budget) {
    if (lowerMsg.includes('30') || lowerMsg.includes('50') || lowerMsg.includes('k') || 
        lowerMsg.includes('$') || lowerMsg.includes('thousand')) {
      
      if (lowerMsg.includes('30') && !lowerMsg.includes('50')) conversation.data.budget = 'Under $30k';
      else if (lowerMsg.includes('50')) conversation.data.budget = '$30k-$50k';
      else conversation.data.budget = '$50k+';
      
      conversation.stage = 'appointment';
      return `Perfect! I have some great ${conversation.data.vehicleType}s in that range. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!`;
    }
    return "What's your budget? (e.g., Under $30k, $30k-$50k, or $50k+)";
  }
  
  // Stage 3: Appointment/Callback
  if (conversation.stage === 'appointment') {
    if (lowerMsg.includes('1') || lowerMsg.includes('test') || lowerMsg.includes('drive')) {
      conversation.data.intent = 'test_drive';
      conversation.stage = 'name';
      return "Awesome! What's your name?";
    }
    
    if (lowerMsg.includes('2') || lowerMsg.includes('call') || lowerMsg.includes('phone')) {
      conversation.data.intent = 'callback';
      conversation.stage = 'name';
      return "Great! What's your name?";
    }
    
    return "Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!";
  }
  
  // Stage 4: Get Name
  if (conversation.stage === 'name' && !conversation.data.name) {
    conversation.data.name = message;
    conversation.stage = 'datetime';
    
    if (conversation.data.intent === 'test_drive') {
      return `Nice to meet you, ${message}! When works best for your test drive? (e.g., Tomorrow afternoon, This Saturday)`;
    } else {
      return `Nice to meet you, ${message}! When's the best time to call you? (e.g., Tomorrow morning, This afternoon)`;
    }
  }
  
  // Stage 5: Date/Time
  if (conversation.stage === 'datetime' && !conversation.data.datetime) {
    conversation.data.datetime = message;
    conversation.stage = 'confirmed';
    
    const entry = {
      phone: phone,
      name: conversation.data.name,
      vehicleType: conversation.data.vehicleType,
      budget: conversation.data.budget,
      datetime: message,
      createdAt: new Date()
    };
    
    if (conversation.data.intent === 'test_drive') {
      appointments.push(entry);
      return `✅ Perfect ${conversation.data.name}! I've booked your test drive for ${message}. We'll text you the day before. Excited to see you!`;
    } else {
      callbacks.push(entry);
      return `✅ Got it ${conversation.data.name}! We'll call you ${message}. Looking forward to helping you find your perfect ${conversation.data.vehicleType}!`;
    }
  }
  
  return "Thanks! To help you better:\n• What vehicle type interests you?\n• Your budget?\n• Test drive or callback?";
}

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend with 2-Way SMS on port ${PORT}`);
});
