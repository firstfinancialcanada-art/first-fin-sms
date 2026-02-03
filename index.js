const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ===== DATABASE CONNECTION =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection on startup
pool.connect()
  .then(() => console.log('✅ Database connected'))
  .catch(err => console.error('❌ Database connection error:', err));

// ===== DATABASE HELPER FUNCTIONS =====

// Get or create customer
async function getOrCreateCustomer(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM customers WHERE phone = $1',
      [phone]
    );
    
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO customers (phone) VALUES ($1) RETURNING *',
        [phone]
      );
      console.log('📝 New customer created:', phone);
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Get or create active conversation
async function getOrCreateConversation(phone) {
  const client = await pool.connect();
  try {
    // Check for active conversation
    let result = await client.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 AND status = $2 ORDER BY started_at DESC LIMIT 1',
      [phone, 'active']
    );
    
    if (result.rows.length === 0) {
      // Create new conversation
      result = await client.query(
        'INSERT INTO conversations (customer_phone) VALUES ($1) RETURNING *',
        [phone]
      );
      console.log('💬 New conversation started:', phone);
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Update conversation data
async function updateConversation(conversationId, updates) {
  const client = await pool.connect();
  try {
    const fields = [];
    const values = [];
    let paramCount = 1;
    
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
    
    values.push(conversationId);
    
    await client.query(
      `UPDATE conversations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount}`,
      values
    );
  } finally {
    client.release();
  }
}

// Save message to database
async function saveMessage(conversationId, phone, role, content) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO messages (conversation_id, customer_phone, role, content) VALUES ($1, $2, $3, $4)',
      [conversationId, phone, role, content]
    );
  } finally {
    client.release();
  }
}

// Save appointment
async function saveAppointment(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO appointments (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('🚗 Appointment saved:', data.name);
  } finally {
    client.release();
  }
}

// Save callback
async function saveCallback(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO callbacks (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('📞 Callback saved:', data.name);
  } finally {
    client.release();
  }
}

// Log analytics event
async function logAnalytics(eventType, phone, data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO analytics (event_type, customer_phone, data) VALUES ($1, $2, $3)',
      [eventType, phone, JSON.stringify(data)]
    );
  } finally {
    client.release();
  }
}

// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE - Database Edition',
    database: '✅ PostgreSQL Connected',
    endpoints: {
      startSms: '/api/start-sms',
      webhook: '/api/sms-webhook',
      dashboard: '/api/dashboard'
    },
    timestamp: new Date()
  });
});

// Dashboard - View all data
app.get('/api/dashboard', async (req, res) => {
  const client = await pool.connect();
  try {
    const customers = await client.query('SELECT COUNT(*) as count FROM customers');
    const conversations = await client.query('SELECT COUNT(*) as count FROM conversations');
    const messages = await client.query('SELECT COUNT(*) as count FROM messages');
    const appointments = await client.query('SELECT * FROM appointments ORDER BY created_at DESC LIMIT 10');
    const callbacks = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC LIMIT 10');
    
    res.json({
      stats: {
        totalCustomers: parseInt(customers.rows[0].count),
        totalConversations: parseInt(conversations.rows[0].count),
        totalMessages: parseInt(messages.rows[0].count),
        totalAppointments: appointments.rows.length,
        totalCallbacks: callbacks.rows.length
      },
      recentAppointments: appointments.rows,
      recentCallbacks: callbacks.rows
    });
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// Get conversation history
app.get('/api/conversation/:phone', async (req, res) => {
  const client = await pool.connect();
  try {
    const { phone } = req.params;
    
    const conversation = await client.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
      [phone]
    );
    
    if (conversation.rows.length === 0) {
      return res.json({ error: 'No conversation found' });
    }
    
    const messages = await client.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversation.rows[0].id]
    );
    
    res.json({
      conversation: conversation.rows[0],
      messages: messages.rows
    });
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// Start SMS campaign
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.json({ success: false, error: 'Phone number required' });
    }
    
    // Ensure customer exists
    await getOrCreateCustomer(phone);
    
    // Create new conversation
    await getOrCreateConversation(phone);
    
    // Log analytics
    await logAnalytics('sms_sent', phone, { source: 'manual_campaign' });
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const client = twilio(accountSid, authToken);
    
    await client.messages.create({
      body: "Hi! 👋 I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)",
      from: fromNumber,
      to: phone
    });
    
    console.log('✅ SMS sent to:', phone);
    res.json({ success: true, message: 'SMS sent!' });
  } catch (error) {
    console.error('❌ Error sending SMS:', error);
    res.json({ success: false, error: error.message });
  }
});

// Twilio Webhook - Receive SMS
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From: phone, Body: message } = req.body;
    
    console.log('📩 Received from:', phone);
    console.log('💬 Message:', message);
    
    // Ensure customer exists
    await getOrCreateCustomer(phone);
    
    // Get or create conversation
    const conversation = await getOrCreateConversation(phone);
    
    // Save incoming message
    await saveMessage(conversation.id, phone, 'user', message);
    
    // Log analytics
    await logAnalytics('message_received', phone, { message });
    
    // Get AI response
    const aiResponse = await getJerryResponse(phone, message, conversation);
    
    // Save outgoing message
    await saveMessage(conversation.id, phone, 'assistant', aiResponse);
    
    // Send response via Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse);
    
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
async function getJerryResponse(phone, message, conversation) {
  const lowerMsg = message.toLowerCase();
  
  // Handle STOP
  if (lowerMsg === 'stop') {
    await updateConversation(conversation.id, { status: 'stopped' });
    await logAnalytics('conversation_stopped', phone, {});
    return "You've been unsubscribed. Reply START to resume.";
  }
  
  // ===== STAGE 1: VEHICLE TYPE =====
  if (conversation.stage === 'greeting' || !conversation.vehicle_type) {
    
    if (lowerMsg.includes('suv')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'SUV',
        stage: 'budget'
      });
      return `Great choice! SUVs are very popular. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('truck')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Truck',
        stage: 'budget'
      });
      return `Awesome! Trucks are great. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('sedan')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Sedan',
        stage: 'budget'
      });
      return `Perfect! Sedans are reliable. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('car') || lowerMsg.includes('vehicle') || 
        lowerMsg.includes('yes') || lowerMsg.includes('interested') ||
        lowerMsg.includes('want') || lowerMsg.includes('looking')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Vehicle',
        stage: 'budget'
      });
      return `Great! What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    return "What type of vehicle interests you? We have SUVs, Trucks, Sedans, Coupes, and more!";
  }
  
  // ===== STAGE 2: BUDGET =====
  if (conversation.stage === 'budget' && !conversation.budget) {
    const numbers = message.match(/\d+/g);
    let budgetAmount = 0;
    
    if (numbers && numbers.length > 0) {
      budgetAmount = parseInt(numbers[0]);
      
      if (lowerMsg.includes('k') && budgetAmount < 1000) {
        budgetAmount = budgetAmount * 1000;
      }
      
      if (message.includes(',')) {
        const fullNumber = message.replace(/,/g, '');
        const extracted = fullNumber.match(/\d+/);
        if (extracted) {
          budgetAmount = parseInt(extracted[0]);
        }
      }
    }
    
    if (budgetAmount > 0) {
      let budgetRange = '';
      if (budgetAmount < 30000) {
        budgetRange = 'Under $30k';
      } else if (budgetAmount >= 30000 && budgetAmount <= 50000) {
        budgetRange = '$30k-$50k';
      } else {
        budgetRange = '$50k+';
      }
      
      await updateConversation(conversation.id, { 
        budget: budgetRange,
        budget_amount: budgetAmount,
        stage: 'appointment'
      });
      
      return `Perfect! I have some great ${conversation.vehicle_type}s around $${(budgetAmount/1000).toFixed(0)}k. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!`;
    }
    
    if (lowerMsg.includes('cheap') || lowerMsg.includes('low') || lowerMsg.includes('budget')) {
      await updateConversation(conversation.id, { 
        budget: 'Under $30k',
        stage: 'appointment'
      });
      return `Got it! I have great budget-friendly options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    if (lowerMsg.includes('high') || lowerMsg.includes('premium') || lowerMsg.includes('luxury')) {
      await updateConversation(conversation.id, { 
        budget: '$50k+',
        stage: 'appointment'
      });
      return `Excellent! I have some premium options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    return "What's your budget? Just give me a number like $15k, $20k, $40k, etc.";
  }
  
  // ===== STAGE 3: APPOINTMENT/CALLBACK =====
  if (conversation.stage === 'appointment' && !conversation.intent) {
    if (lowerMsg.includes('1') || lowerMsg.includes('test') || lowerMsg.includes('drive') || 
        lowerMsg.includes('appointment') || lowerMsg.includes('visit')) {
      await updateConversation(conversation.id, { 
        intent: 'test_drive',
        stage: 'name'
      });
      return "Awesome! What's your name?";
    }
    
    if (lowerMsg.includes('2') || lowerMsg.includes('call') || lowerMsg.includes('phone') || 
        lowerMsg.includes('talk')) {
      await updateConversation(conversation.id, { 
        intent: 'callback',
        stage: 'name'
      });
      return "Great! What's your name?";
    }
    
    return "Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!";
  }
  
  // ===== STAGE 4: GET NAME =====
  if (conversation.stage === 'name' && !conversation.customer_name) {
    let name = message.trim();
    
    if (lowerMsg.includes('my name is')) {
      name = message.split(/my name is/i)[1].trim();
    } else if (lowerMsg.includes("i'm")) {
      name = message.split(/i'm/i)[1].trim();
    } else if (lowerMsg.includes("i am")) {
      name = message.split(/i am/i)[1].trim();
    }
    
    name = name.charAt(0).toUpperCase() + name.slice(1);
    
    await updateConversation(conversation.id, { 
      customer_name: name,
      stage: 'datetime'
    });
    
    // Update customer name
    await pool.query(
      'UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2',
      [name, phone]
    );
    
    if (conversation.intent === 'test_drive') {
      return `Nice to meet you, ${name}! When works best for your test drive? (e.g., Tomorrow afternoon, Saturday morning, Next week)`;
    } else {
      return `Nice to meet you, ${name}! When's the best time to call you? (e.g., Tomorrow at 2pm, Friday morning, This evening)`;
    }
  }
  
  // ===== STAGE 5: DATE/TIME & CONFIRMATION =====
  if (conversation.stage === 'datetime' && !conversation.datetime) {
    await updateConversation(conversation.id, { 
      datetime: message,
      stage: 'confirmed',
      status: 'converted'
    });
    
    const appointmentData = {
      phone: phone,
      name: conversation.customer_name,
      vehicleType: conversation.vehicle_type,
      budget: conversation.budget,
      budgetAmount: conversation.budget_amount,
      datetime: message
    };
    
    if (conversation.intent === 'test_drive') {
      await saveAppointment(appointmentData);
      await logAnalytics('appointment_booked', phone, appointmentData);
      return `✅ Perfect ${conversation.customer_name}! I've booked your test drive for ${message}.\n\n📍 We're at 123 Auto Blvd, Calgary\n📧 Confirmation sent!\n\nLooking forward to seeing you! Reply STOP to opt out.`;
    } else {
      await saveCallback(appointmentData);
      await logAnalytics('callback_requested', phone, appointmentData);
      return `✅ Got it ${conversation.customer_name}! We'll call you ${message}.\n\nWe're excited to help you find your perfect ${conversation.vehicle_type}!\n\nTalk soon! Reply STOP to opt out.`;
    }
  }
  
  // ===== ALREADY CONFIRMED =====
  if (conversation.stage === 'confirmed') {
    return `Thanks ${conversation.customer_name}! We're all set for ${conversation.datetime}. If you need to reschedule, just call us at (403) 555-0100!`;
  }
  
  // ===== DEFAULT FALLBACK =====
  return "Thanks for your message! To help you better, let me know:\n• What type of vehicle? (SUV, Sedan, Truck)\n• Your budget? (e.g., $20k)\n• Test drive or callback?";
}

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend - Database Edition - Port ${PORT}`);
});
