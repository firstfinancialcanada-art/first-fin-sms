// lib/vehicle-photos.js — photos Franco takes himself, for units no scraper feeds
//
// Every photo in desk_inventory.photos until now came from a scrape: a remote
// URL on the supplier's CDN. That covers Automaxx, SmartBuy and House of Cars,
// and covers nothing else. A truck that just landed on the lot, or a car of
// Adil's being posted as a favour, is photographed on a phone and has nowhere
// to go — so it could be added to inventory but never posted to Marketplace,
// which is the whole point of putting it in.
//
// Storage mirrors the tenant logo, which has been serving bytes out of
// Postgres since May: BYTEA in the row, one public GET with an ETag, and only
// the URL kept on the vehicle. Keeping bytes out of desk_inventory matters —
// that table is read whole by the inventory list, the poster and the deal
// desk, and a few megabytes per unit inlined there would be felt on every one
// of those calls.
//
// Public on read, deliberately: the FB Poster's background worker fetches each
// photo with no session, and the photo editor draws them to a canvas, which
// taints without permissive CORS. These are pictures of a car that is for
// sale. The bytes are only reachable by a numeric id that is never listed.
'use strict';

const { pool } = require('./db');

const MAX_BYTES = 12 * 1024 * 1024;   // a phone photo, uncompressed, with room
const MAX_FILES = 30;                 // a long walkaround, not a bulk import
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

let _initPromise = null;
function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS desk_vehicle_photos (
          id         SERIAL PRIMARY KEY,
          tenant_id  INTEGER REFERENCES desk_tenants(id) ON DELETE CASCADE,
          user_id    INTEGER REFERENCES desk_users(id)   ON DELETE SET NULL,
          stock      VARCHAR(50) NOT NULL,
          position   INTEGER NOT NULL DEFAULT 0,
          data       BYTEA NOT NULL,
          mime       VARCHAR(60) NOT NULL,
          bytes      INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_dvp_tenant_stock
          ON desk_vehicle_photos(tenant_id, stock, position);
      `);
      console.log('✅ vehicle-photos schema ready (desk_vehicle_photos)');
    } catch (e) {
      console.error('❌ vehicle-photos init:', e.message);
    }
  })();
  return _initPromise;
}
init();

function publicUrl(id) {
  const base = (process.env.BASE_URL || '').replace(/\/$/, '') || 'https://app.firstfinancialcanada.com';
  return `${base}/api/vehicle-photo/${id}`;
}

module.exports = { init, publicUrl, MAX_BYTES, MAX_FILES, ALLOWED };
