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
      'INSERT INTO appointments (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)
