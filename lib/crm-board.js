// lib/crm-board.js — the temperature ladder behind the CRM board
//
// Franco, 2026-10-08: "i would like the first fin client crm more hot and
// cold like the sheet ... can i fill a whole line in a dead -- cold - hot
// type color and move them up and down the list as they are updated ...
// i want a master crm tab and a monthly crm tracker inside first fin".
//
// The sheet he works from is FRANK'S K.M SUBPRIME SHEET: one tab per month,
// a DEAD tab, and every row filled with a colour that carries the real
// meaning. Reading July 2024: green = delivered (42 rows), orange = hot and
// being worked (27), white = warm, waiting on the customer (9), cyan =
// parked or carried over (6), red = dead (5, and the whole DEAD tab).
//
// So temperature is a SEPARATE axis from status, not a replacement for it.
// status says where the deal is (Lead → Contacted → Test Drive →
// Negotiating → Sold); temperature says how live it feels today. His sheet
// only ever had the colour, which is why a 'Sold' row and a 'needs a SIN
// number' row could sit next to each other looking identical. Keeping both
// means nothing is lost from the 245 leads already in the system.
'use strict';

const { pool } = require('./db');

// Ordered coldest → hottest, with Sold parked at the end as an outcome
// rather than a temperature. Order matters: the board sorts by it.
//
// Five bands, not the six first discussed — that is what the sheet
// actually uses once you read the fills rather than the headings, and
// matching his muscle memory beats inventing a rung he has never needed.
// Adding 'Hottest' later is this line plus one colour.
const TEMPERATURES = ['Dead', 'Cold', 'Warm', 'Hot', 'Sold'];

// Seed temperature from whatever status a lead already carries, so the
// board is useful the first time it opens instead of one undifferentiated
// column. Franco re-files them by hand from there — that is the point.
const FROM_STATUS = {
  'Sold': 'Sold',
  'Negotiating': 'Hot',
  'Test Drive': 'Hot',
  'Contacted': 'Warm',
  'Lead': 'Cold',
};

function normalize(t) {
  if (!t) return null;
  const hit = TEMPERATURES.find(x => x.toLowerCase() === String(t).trim().toLowerCase());
  return hit || null;
}

let _initPromise = null;

function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      await pool.query(`
        ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS temperature VARCHAR(10);
        ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS board_rank  INTEGER;
      `);
      // Board reads are always "this tenant, this temperature, in rank
      // order" — index it that way.
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_desk_crm_board
          ON desk_crm(tenant_id, temperature, board_rank);
      `);

      // Backfill ONLY rows that have never been filed. Guarded on
      // temperature IS NULL so a re-run can never stomp on a lead Franco
      // has already moved by hand.
      const seed = await pool.query(`
        UPDATE desk_crm
           SET temperature = CASE status
                 WHEN 'Sold'        THEN 'Sold'
                 WHEN 'Negotiating' THEN 'Hot'
                 WHEN 'Test Drive'  THEN 'Hot'
                 WHEN 'Contacted'   THEN 'Warm'
                 ELSE 'Cold'
               END
         WHERE temperature IS NULL
      `);
      if (seed.rowCount) console.log(`✅ crm-board: seeded temperature on ${seed.rowCount} leads`);

      // board_rank starts as the lead id so the first render has a stable,
      // sensible order (newest at the top) and every later move is a
      // comparison against real numbers rather than against NULL.
      await pool.query(`UPDATE desk_crm SET board_rank = id WHERE board_rank IS NULL`);

      // ...and keep it that way for rows created from here on. FIVE paths
      // insert into desk_crm - the API, bulk replace, the Sarah sync, email
      // lead intake and lead routing - and none of them set board_rank or
      // temperature. A lead added between restarts therefore had board_rank
      // NULL, which sorts LAST: a brand-new lead landed at the bottom of the
      // board, which is exactly backwards. Patching five call sites would
      // just leave the sixth one to be written later, so it goes here where
      // every writer has to pass through it.
      //
      // rank = id always outranks the existing rows: ids are monotonic, and
      // a heat-sort only ever permutes ranks already in use, so every rank
      // in the table is <= the largest id at the time.
      await pool.query(`
        CREATE OR REPLACE FUNCTION desk_crm_fill_board_defaults() RETURNS trigger AS $fn$
        BEGIN
          IF NEW.board_rank IS NULL THEN
            NEW.board_rank := NEW.id;
          END IF;
          IF NEW.temperature IS NULL THEN
            NEW.temperature := CASE NEW.status
              WHEN 'Sold'        THEN 'Sold'
              WHEN 'Negotiating' THEN 'Hot'
              WHEN 'Test Drive'  THEN 'Hot'
              WHEN 'Contacted'   THEN 'Warm'
              ELSE 'Cold'
            END;
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
      `);
      await pool.query(`DROP TRIGGER IF EXISTS trg_desk_crm_board_defaults ON desk_crm;`);
      await pool.query(`
        CREATE TRIGGER trg_desk_crm_board_defaults
          BEFORE INSERT ON desk_crm
          FOR EACH ROW EXECUTE FUNCTION desk_crm_fill_board_defaults();
      `);

      console.log('✅ crm-board schema ready (temperature + board_rank)');
    } catch (e) {
      console.error('❌ crm-board init:', e.message);
    }
  })();
  return _initPromise;
}

init();

module.exports = { TEMPERATURES, FROM_STATUS, normalize, init };
