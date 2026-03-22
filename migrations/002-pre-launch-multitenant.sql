-- ============================================================
-- FIRST-FIN Migration: Pre-Launch Multi-Tenant Fixes
-- Safe to run multiple times (IF NOT EXISTS / catch errors)
-- Run via: node run-migration.js
-- ============================================================

-- ── C5: desk_inventory — drop global unique on stock, add composite ──
-- The original schema has UNIQUE(stock) which blocks two dealers
-- from having the same stock number. We need UNIQUE(user_id, stock).
ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS user_id INTEGER;

-- Drop the old global unique constraint (name may vary)
DO $$
BEGIN
  -- Try the default constraint name
  ALTER TABLE desk_inventory DROP CONSTRAINT IF EXISTS desk_inventory_stock_key;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Also try dropping a unique index if it exists instead of a constraint
DROP INDEX IF EXISTS desk_inventory_stock_key;

-- Create the composite unique index (safe if already exists)
CREATE UNIQUE INDEX IF NOT EXISTS idx_dinv_user_stock ON desk_inventory(user_id, stock);

-- Add color/trim/cost/book_value columns if missing (used by load-all)
ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS color VARCHAR(50);
ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS trim VARCHAR(100);
ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS cost NUMERIC(12,2);
ALTER TABLE desk_inventory ADD COLUMN IF NOT EXISTS book_value NUMERIC(12,2);


-- ── C6: deals — add user_id column ──────────────────────────────────
ALTER TABLE deals ADD COLUMN IF NOT EXISTS user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_deals_user ON deals(user_id);


-- ── M1: customers — drop global unique on phone, add composite ──────
-- Same problem: two dealers can't have the same customer phone.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS user_id INTEGER;

DO $$
BEGIN
  ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_phone_key;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DROP INDEX IF EXISTS customers_phone_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user_phone ON customers(user_id, phone);


-- ── H2: Add suspended column to desk_users ──────────────────────────
ALTER TABLE desk_users ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT FALSE;


-- ── Performance indexes (from earlier audit) ────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments(user_id);
CREATE INDEX IF NOT EXISTS idx_callbacks_user ON callbacks(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_bulk_messages_user ON bulk_messages(user_id);


-- ── Refresh token cleanup index ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_drt_expires ON desk_refresh_tokens(expires_at);


-- ── M7: platform_inquiries — previously created at runtime in request handler ──
CREATE TABLE IF NOT EXISTS platform_inquiries (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  dealership TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ── M8: voicemails — previously created as side effect of require() ─────────
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
);
CREATE INDEX IF NOT EXISTS idx_voicemails_phone ON voicemails(caller_phone);


-- ── M8: bulk_messages — previously created as side effect of require() ───────
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
);
CREATE INDEX IF NOT EXISTS idx_bulk_messages_processing
  ON bulk_messages(status, scheduled_at)
  WHERE status = 'pending';


-- ── M8: deals — previously created as side effect of require() ───────────────
-- (user_id already added above; this ensures the table itself exists)
CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  user_id           INTEGER,
  customer_name     VARCHAR(255),
  customer_phone    VARCHAR(30),
  customer_email    VARCHAR(255),
  vehicle_desc      VARCHAR(500),
  stock_num         VARCHAR(50),
  selling_price     NUMERIC(12,2),
  finance_amount    NUMERIC(12,2),
  apr               NUMERIC(6,3),
  term_months       INTEGER,
  monthly_payment   NUMERIC(10,2),
  down_payment      NUMERIC(12,2),
  trade_allowance   NUMERIC(12,2),
  trade_payoff      NUMERIC(12,2),
  doc_fee           NUMERIC(10,2),
  gst_amount        NUMERIC(10,2),
  vsc_price         NUMERIC(10,2),
  gap_price         NUMERIC(10,2),
  tw_price          NUMERIC(10,2),
  wa_price          NUMERIC(10,2),
  front_gross       NUMERIC(12,2),
  back_gross        NUMERIC(12,2),
  total_gross       NUMERIC(12,2),
  pvr               NUMERIC(12,2),
  salesperson       VARCHAR(255),
  dealership        VARCHAR(255),
  follow_up_sent    BOOLEAN DEFAULT FALSE,
  logged_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  raw_data          JSONB
);
CREATE INDEX IF NOT EXISTS idx_deals_phone  ON deals(customer_phone);
CREATE INDEX IF NOT EXISTS idx_deals_logged ON deals(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_user   ON deals(user_id);


-- ── deal_outcomes (used by probability/outcomes-admin) ───────────────────────
CREATE TABLE IF NOT EXISTS deal_outcomes (
  id SERIAL PRIMARY KEY,
  user_id       INTEGER,
  lender_key    VARCHAR(50),
  outcome       VARCHAR(20) DEFAULT 'pending',
  beacon        INTEGER,
  ltv_pct       NUMERIC(6,2),
  vehicle_year  INTEGER,
  vehicle_km    INTEGER,
  rate_offered  NUMERIC(6,3),
  term_months   INTEGER,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outcomes_user ON deal_outcomes(user_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_lender ON deal_outcomes(lender_key);
