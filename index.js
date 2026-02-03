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
    status: '✅ Jerry AI Backend LIVE - Smart Budget Edition',
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
    
    console.log('✅ SMS sent to:', phone);
    res.json({ success: true, message: 'SMS sent!' });
  } catch (error) {
    console.error('❌ Error sending SMS:', error);
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
    
    console.log('✅ Jerry replied:', aiResponse);
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('❌ Webhook error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("I'm having trouble right now. Please call us at (403) 555-0100!");
    res.type('text/xml').send(twiml.toString());
  }
});

// ===== JERRY AI LOGIC =====
async function getJerryResponse(phone, message) {
  const conversation = conversations[phone];
  const lowerMsg = message.toLowerCase();
  
  // Handle STOP
  if (lowerMsg === 'stop') {
    conversation.status = 'stopped';
    return "You've been unsubscribed. Reply START to resume.";
  }
  
  // ===== STAGE 1: VEHICLE TYPE =====
  if (conversation.stage === 'greeting' || !conversation.data.vehicleType) {
    // Detect vehicle type keywords
    if (lowerMsg.includes('suv')) {
      conversation.data.vehicleType = 'SUV';
      conversation.stage = 'budget';
      return `Great choice! SUVs are very popular. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('truck')) {
      conversation.data.vehicleType = 'Truck';
      conversation.stage = 'budget';
      return `Awesome! Trucks are great. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('sedan')) {
      conversation.data.vehicleType = 'Sedan';
      conversation.stage = 'budget';
      return `Perfect! Sedans are reliable. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    // Generic positive responses
    if (lowerMsg.includes('car') || lowerMsg.includes('vehicle') || 
        lowerMsg.includes('yes') || lowerMsg.includes('interested') ||
        lowerMsg.includes('want') || lowerMsg.includes('looking')) {
      conversation.data.vehicleType = 'Vehicle';
      conversation.stage = 'budget';
      return `Great! What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    return "What type of vehicle interests you? We have SUVs, Trucks, Sedans, Coupes, and more!";
  }
  
  // ===== STAGE 2: BUDGET - IMPROVED WITH SMART DETECTION =====
  if (conversation.stage === 'budget' && !conversation.data.budget) {
    // Extract all numbers from the message
    const numbers = message.match(/\d+/g);
    let budgetAmount = 0;
    
    if (numbers && numbers.length > 0) {
      budgetAmount = parseInt(numbers[0]);
      
      // Handle "k" multiplier (15k = 15000)
      if (lowerMsg.includes('k') && budgetAmount < 1000) {
        budgetAmount = budgetAmount * 1000;
      }
      
      // Handle comma-separated numbers (25,000)
      if (message.includes(',')) {
        const fullNumber = message.replace(/,/g, '');
        const extracted = fullNumber.match(/\d+/);
        if (extracted) {
          budgetAmount = parseInt(extracted[0]);
        }
      }
    }
    
    // Categorize budget intelligently
    if (budgetAmount > 0) {
      if (budgetAmount < 30000) {
        conversation.data.budget = 'Under $30k';
        conversation.data.budgetAmount = budgetAmount;
      } else if (budgetAmount >= 30000 && budgetAmount <= 50000) {
        conversation.data.budget = '$30k-$50k';
        conversation.data.budgetAmount = budgetAmount;
      } else if (budgetAmount > 50000) {
        conversation.data.budget = '$50k+';
        conversation.data.budgetAmount = budgetAmount;
      }
      
      conversation.stage = 'appointment';
      return `Perfect! I have some great ${conversation.data.vehicleType}s around $${(budgetAmount/1000).toFixed(0)}k. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!`;
    }
    
    // Fallback for text responses like "cheap", "expensive", etc.
    if (lowerMsg.includes('cheap') || lowerMsg.includes('low') || lowerMsg.includes('budget')) {
      conversation.data.budget = 'Under $30k';
      conversation.stage = 'appointment';
      return `Got it! I have great budget-friendly options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    if (lowerMsg.includes('high') || lowerMsg.includes('premium') || lowerMsg.includes('luxury')) {
      conversation.data.budget = '$50k+';
      conversation.stage = 'appointment';
      return `Excellent! I have some premium options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    return "What's your budget? Just give me a number like $15k, $20k, $40k, etc.";
  }
  
  // ===== STAGE 3: APPOINTMENT/CALLBACK =====
  if (conversation.stage === 'appointment' && !conversation.data.intent) {
    if (lowerMsg.includes('1') || lowerMsg.includes('test') || lowerMsg.includes('drive') || 
        lowerMsg.includes('appointment') || lowerMsg.includes('visit')) {
      conversation.data.intent = 'test_drive';
      conversation.stage = 'name';
      return "Awesome! What's your name?";
    }
    
    if (lowerMsg.includes('2') || lowerMsg.includes('call') || lowerMsg.includes('phone') || 
        lowerMsg.includes('talk')) {
      conversation.data.intent = 'callback';
      conversation.stage = 'name';
      return "Great! What's your name?";
    }
    
    return "Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!";
  }
  
  // ===== STAGE 4: GET NAME =====
  if (conversation.stage === 'name' && !conversation.data.name) {
    // Clean up the name (remove extra words)
    let name = message.trim();
    
    // If they say "my name is..." or "I'm...", extract just the name
    if (lowerMsg.includes('my name is')) {
      name = message.split(/my name is/i)[1].trim();
    } else if (lowerMsg.includes("i'm")) {
      name = message.split(/i'm/i)[1].trim();
    } else if (lowerMsg.includes("i am")) {
      name = message.split(/i am/i)[1].trim();
    }
    
    // Capitalize first letter
    name = name.charAt(0).toUpperCase() + name.slice(1);
    
    conversation.data.name = name;
    conversation.stage = 'datetime';
    
    if (conversation.data.intent === 'test_drive') {
      return `Nice to meet you, ${name}! When works best for your test drive? (e.g., Tomorrow afternoon, Saturday morning, Next week)`;
    } else {
      return `Nice to meet you, ${name}! When's the best time to call you? (e.g., Tomorrow at 2pm, Friday morning, This evening)`;
    }
  }
  
  // ===== STAGE 5: DATE/TIME & CONFIRMATION =====
  if (conversation.stage === 'datetime' && !conversation.data.datetime) {
    conversation.data.datetime = message;
    conversation.stage = 'confirmed';
    conversation.status = 'converted';
    
    const entry = {
      phone: phone,
      name: conversation.data.name,
      vehicleType: conversation.data.vehicleType,
      budget: conversation.data.budget,
      budgetAmount: conversation.data.budgetAmount,
      datetime: message,
      createdAt: new Date()
    };
    
    if (conversation.data.intent === 'test_drive') {
      appointments.push(entry);
      console.log('🚗 NEW APPOINTMENT:', entry);
      return `✅ Perfect ${conversation.data.name}! I've booked your test drive for ${message}.\n\n📍 We're at 123 Auto Blvd, Calgary\n📧 Confirmation sent!\n\nLooking forward to seeing you! Reply STOP to opt out.`;
    } else {
      callbacks.push(entry);
      console.log('📞 NEW CALLBACK:', entry);
      return `✅ Got it ${conversation.data.name}! We'll call you ${message}.\n\nWe're excited to help you find your perfect ${conversation.data.vehicleType}!\n\nTalk soon! Reply STOP to opt out.`;
    }
  }
  
  // ===== ALREADY CONFIRMED =====
  if (conversation.stage === 'confirmed') {
    return `Thanks ${conversation.data.name}! We're all set for ${conversation.data.datetime}. If you need to reschedule, just call us at (403) 555-0100!`;
  }
  
  // ===== DEFAULT FALLBACK =====
  return "Thanks for your message! To help you better, let me know:\n• What type of vehicle? (SUV, Sedan, Truck)\n• Your budget? (e.g., $20k)\n• Test drive or callback?";
}

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend - Smart Edition - Port ${PORT}`);
});
