// lib/crm-history.js — CRM history, audit, undo, soft-delete
//
// What this module owns:
//
// 1. desk_crm_notes      — append-only per-note records with author + ts.
//                          Soft-deletable; reaper keeps the last 3 deleted
//                          per lead, hard-deletes older than that.
// 2. desk_crm_audit      — every PATCH on a lead row writes an audit entry
//                          with the changed fields (JSONB diff), user, ts.
// 3. desk_crm columns    — previous_state JSONB + previous_state_at + by
//                          (one-step undo for the lead row), plus
//                          deleted_at + deleted_by (soft-delete the row).
//
// Why a dedicated file: the existing routes/desk.js PATCH endpoint is the
// only place we write CRM rows; centralising audit + snapshot logic here
// means we can't forget to log a future write path. Idempotent init
// pattern matches lib/lead-intake.js + lib/lead-routing.js so deploy
// migrations are automatic — no manual `node run-migration.js` step.
'use strict';

const { pool } = require('./db');

// ── Idempotent schema (runs once on require) ───────────────────────
let _initPromise = null;
function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      // Per-note table — append-only. soft-delete via deleted_at.
      // tenant_id duplicated for cheap WHERE filtering without joining
      // back to desk_crm on every read.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS desk_crm_notes (
          id            SERIAL PRIMARY KEY,
          crm_entry_id  INTEGER NOT NULL REFERENCES desk_crm(id) ON DELETE CASCADE,
          tenant_id     INTEGER NOT NULL REFERENCES desk_tenants(id) ON DELETE CASCADE,
          author_id     INTEGER REFERENCES desk_users(id) ON DELETE SET NULL,
          body          TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at    TIMESTAMPTZ,
          deleted_by    INTEGER REFERENCES desk_users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_crm_notes_lead
          ON desk_crm_notes(crm_entry_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_crm_notes_tenant
          ON desk_crm_notes(tenant_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_crm_notes_deleted
          ON desk_crm_notes(crm_entry_id, deleted_at)
          WHERE deleted_at IS NOT NULL;
      `);

      // Audit log — one row per PATCH/delete/undo/restore on a lead.
      // changes JSONB stores the diff: { field: { from, to } }.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS desk_crm_audit (
          id            SERIAL PRIMARY KEY,
          crm_entry_id  INTEGER NOT NULL REFERENCES desk_crm(id) ON DELETE CASCADE,
          tenant_id     INTEGER NOT NULL REFERENCES desk_tenants(id) ON DELETE CASCADE,
          user_id       INTEGER REFERENCES desk_users(id) ON DELETE SET NULL,
          action        VARCHAR(40) NOT NULL,
          changes       JSONB,
          occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_crm_audit_lead
          ON desk_crm_audit(crm_entry_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_crm_audit_tenant
          ON desk_crm_audit(tenant_id, occurred_at DESC);
      `);

      // desk_crm extras: snapshot for one-step undo + soft delete on the row.
      await pool.query(`
        ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS previous_state    JSONB;
        ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS previous_state_at TIMESTAMPTZ;
        ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS previous_state_by INTEGER REFERENCES desk_users(id) ON DELETE SET NULL;
        ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;
        ALTER TABLE desk_crm ADD COLUMN IF NOT EXISTS deleted_by        INTEGER REFERENCES desk_users(id) ON DELETE SET NULL;
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_desk_crm_deleted
          ON desk_crm(tenant_id, deleted_at)
          WHERE deleted_at IS NOT NULL;
      `);

      console.log('✅ crm-history schema ready (desk_crm_notes + desk_crm_audit + soft-delete cols)');

      // One-shot legacy migration: any existing desk_crm.notes content
      // becomes the first row in desk_crm_notes for that lead. Idempotent
      // via a NOT EXISTS guard so re-runs don't duplicate.
      await migrateLegacyNotes();
    } catch (e) {
      console.error('❌ crm-history init:', e.message);
    }
  })();
  return _initPromise;
}
init();

// ── Legacy notes migration (one-shot, idempotent) ──────────────────
// For every desk_crm row whose `notes` is non-empty AND has no entry in
// desk_crm_notes yet, copy the text into a single desk_crm_notes row
// timestamped at the lead's last_contact (or updated_at as fallback).
// Author is left NULL since we don't know which rep wrote it.
async function migrateLegacyNotes() {
  try {
    const r = await pool.query(`
      INSERT INTO desk_crm_notes (crm_entry_id, tenant_id, author_id, body, created_at)
      SELECT c.id,
             c.tenant_id,
             NULL,
             c.notes,
             COALESCE(c.last_contact, c.updated_at, NOW())
        FROM desk_crm c
       WHERE c.notes IS NOT NULL
         AND TRIM(c.notes) <> ''
         AND c.tenant_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM desk_crm_notes n WHERE n.crm_entry_id = c.id
         )
    `);
    if (r.rowCount > 0) {
      console.log(`📝 crm-history: migrated ${r.rowCount} legacy note(s) into desk_crm_notes`);
    }
  } catch (e) {
    console.warn('crm-history: legacy notes migration skipped:', e.message);
  }
}

// ── Notes API ──────────────────────────────────────────────────────

async function addNote({ tenantId, leadId, authorId, body }) {
  if (!tenantId || !leadId || !body || !String(body).trim()) {
    return { ok: false, error: 'missing_args' };
  }
  const { rows } = await pool.query(
    `INSERT INTO desk_crm_notes (crm_entry_id, tenant_id, author_id, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, crm_entry_id, author_id, body, created_at`,
    [leadId, tenantId, authorId || null, String(body).trim()]
  );
  return { ok: true, note: rows[0] };
}

// List notes for a lead. Includes author display_name via join.
// includeDeleted: if true, returns soft-deleted notes too (for the
// "recently deleted" recovery view, capped at the last 3 by reaper).
async function listNotes({ tenantId, leadId, includeDeleted = false }) {
  const where = includeDeleted
    ? `n.crm_entry_id = $1 AND n.tenant_id = $2`
    : `n.crm_entry_id = $1 AND n.tenant_id = $2 AND n.deleted_at IS NULL`;
  const { rows } = await pool.query(
    `SELECT n.id, n.body, n.created_at, n.deleted_at,
            n.author_id, ua.display_name AS author_name,
            n.deleted_by, ud.display_name AS deleted_by_name
       FROM desk_crm_notes n
       LEFT JOIN desk_users ua ON ua.id = n.author_id
       LEFT JOIN desk_users ud ON ud.id = n.deleted_by
      WHERE ${where}
      ORDER BY n.created_at DESC, n.id DESC`,
    [leadId, tenantId]
  );
  return rows;
}

async function softDeleteNote({ tenantId, noteId, userId }) {
  const { rows } = await pool.query(
    `UPDATE desk_crm_notes
        SET deleted_at = NOW(), deleted_by = $3
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
      RETURNING id, crm_entry_id`,
    [noteId, tenantId, userId || null]
  );
  if (!rows.length) return { ok: false, error: 'not_found_or_already_deleted' };
  // After deleting, prune older deleted notes beyond the last 3.
  await reapOldDeletedNotes(rows[0].crm_entry_id, tenantId);
  return { ok: true, leadId: rows[0].crm_entry_id };
}

async function restoreNote({ tenantId, noteId }) {
  const { rows } = await pool.query(
    `UPDATE desk_crm_notes
        SET deleted_at = NULL, deleted_by = NULL
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL
      RETURNING id`,
    [noteId, tenantId]
  );
  return { ok: !!rows.length };
}

// Reaper — for a single lead, keep at most 3 deleted notes (the most
// recently deleted), hard-delete the rest. Called after every soft-
// delete so the table doesn't accumulate. Cheap: index on
// (crm_entry_id, deleted_at) WHERE deleted_at IS NOT NULL.
async function reapOldDeletedNotes(leadId, tenantId) {
  await pool.query(
    `DELETE FROM desk_crm_notes
      WHERE id IN (
        SELECT id FROM desk_crm_notes
         WHERE crm_entry_id = $1
           AND tenant_id = $2
           AND deleted_at IS NOT NULL
         ORDER BY deleted_at DESC, id DESC
         OFFSET 3
      )`,
    [leadId, tenantId]
  );
}

// ── Audit API ──────────────────────────────────────────────────────

// Build a JSONB diff of { field: { from, to } } from the prior row state
// and the patch body. Only fields the user actually changed are recorded
// (so a no-op PATCH doesn't pollute the audit log).
function buildDiff(priorRow, patchBody, allowedFields) {
  const diff = {};
  for (const f of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(patchBody, f)) continue;
    const before = priorRow ? priorRow[f] : undefined;
    const after  = patchBody[f] === '' ? null : patchBody[f];
    // Loose compare — null/undefined/empty string all read as "no value".
    const eq = (a, b) =>
      (a == null && b == null) ||
      String(a ?? '') === String(b ?? '');
    if (!eq(before, after)) {
      diff[f] = { from: before ?? null, to: after ?? null };
    }
  }
  return diff;
}

async function logAudit({ tenantId, leadId, userId, action, changes }) {
  if (!tenantId || !leadId || !action) return;
  // Skip empty diffs unless action is a non-update verb.
  const isMutation = action === 'update';
  if (isMutation && (!changes || !Object.keys(changes).length)) return;
  try {
    await pool.query(
      `INSERT INTO desk_crm_audit (crm_entry_id, tenant_id, user_id, action, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [leadId, tenantId, userId || null, action, changes ? JSON.stringify(changes) : null]
    );
  } catch (e) {
    console.warn('[crm-history] audit insert:', e.message);
  }
}

// List audit entries (newest first), with user display name joined.
async function listAudit({ tenantId, leadId, limit = 50 }) {
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.changes, a.occurred_at,
            a.user_id, u.display_name AS user_name
       FROM desk_crm_audit a
       LEFT JOIN desk_users u ON u.id = a.user_id
      WHERE a.crm_entry_id = $1 AND a.tenant_id = $2
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT $3`,
    [leadId, tenantId, Math.min(parseInt(limit, 10) || 50, 200)]
  );
  return rows;
}

// ── Snapshot for one-step undo ─────────────────────────────────────
// The PATCH endpoint calls snapshotBeforeUpdate inside its transaction
// BEFORE writing the new values. Stores the editable subset of the row
// so undoLastChange can restore it. Pass the same `client` from the
// transaction so it's atomic with the UPDATE.
const SNAPSHOT_FIELDS = [
  'name','phone','email','status','source','notes','beacon',
  'income','obligations','vehicle_interest','budget_range',
  'follow_up_date','follow_up_note','last_contact','assigned_rep_id',
];

async function snapshotBeforeUpdate(client, { tenantId, leadId, userId }) {
  const { rows } = await client.query(
    `SELECT ${SNAPSHOT_FIELDS.join(', ')}
       FROM desk_crm
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [leadId, tenantId]
  );
  if (!rows.length) return null;
  await client.query(
    `UPDATE desk_crm
        SET previous_state    = $1::jsonb,
            previous_state_at = NOW(),
            previous_state_by = $2
      WHERE id = $3 AND tenant_id = $4`,
    [JSON.stringify(rows[0]), userId || null, leadId, tenantId]
  );
  return rows[0];
}

// Undo: copy previous_state JSONB back into the live columns.
// Idempotent-ish: clears previous_state_at after undo so the user can't
// keep undoing the same change repeatedly. (Per Franco — this is one-step
// undo, not a stack.)
async function undoLastChange({ tenantId, leadId, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT previous_state FROM desk_crm
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [leadId, tenantId]
    );
    if (!rows.length || !rows[0].previous_state) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'no_snapshot' };
    }
    const prev = rows[0].previous_state;
    const sets = [];
    const vals = [];
    let idx = 1;
    for (const f of SNAPSHOT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(prev, f)) {
        sets.push(`${f} = $${idx++}`);
        vals.push(prev[f]);
      }
    }
    if (!sets.length) { await client.query('ROLLBACK'); return { ok: false, error: 'empty_snapshot' }; }
    sets.push(`previous_state    = NULL`);
    sets.push(`previous_state_at = NULL`);
    sets.push(`previous_state_by = NULL`);
    sets.push(`updated_at        = NOW()`);
    vals.push(leadId, tenantId);
    await client.query(
      `UPDATE desk_crm SET ${sets.join(', ')}
        WHERE id = $${idx++} AND tenant_id = $${idx}`,
      vals
    );
    await client.query(
      `INSERT INTO desk_crm_audit (crm_entry_id, tenant_id, user_id, action, changes)
       VALUES ($1, $2, $3, 'undo', $4)`,
      [leadId, tenantId, userId || null, JSON.stringify({ restored: prev })]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
}

// ── Soft-delete on the lead row itself ─────────────────────────────

async function softDeleteLead({ tenantId, leadId, userId }) {
  const { rows } = await pool.query(
    `UPDATE desk_crm
        SET deleted_at = NOW(), deleted_by = $3, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [leadId, tenantId, userId || null]
  );
  if (!rows.length) return { ok: false, error: 'not_found_or_already_deleted' };
  await logAudit({ tenantId, leadId, userId, action: 'delete', changes: null });
  return { ok: true };
}

async function restoreLead({ tenantId, leadId, userId }) {
  const { rows } = await pool.query(
    `UPDATE desk_crm
        SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL
      RETURNING id`,
    [leadId, tenantId]
  );
  if (!rows.length) return { ok: false, error: 'not_found_or_not_deleted' };
  await logAudit({ tenantId, leadId, userId, action: 'restore', changes: null });
  return { ok: true };
}

async function listRecentlyDeleted({ tenantId, days = 30, limit = 100 }) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.phone, c.email, c.status, c.source,
            c.deleted_at, c.deleted_by,
            u.display_name AS deleted_by_name,
            c.assigned_rep_id, c.vehicle_interest, c.created_at
       FROM desk_crm c
       LEFT JOIN desk_users u ON u.id = c.deleted_by
      WHERE c.tenant_id = $1
        AND c.deleted_at IS NOT NULL
        AND c.deleted_at > NOW() - ($2 || ' days')::interval
      ORDER BY c.deleted_at DESC
      LIMIT $3`,
    [tenantId, String(days), Math.min(parseInt(limit, 10) || 100, 500)]
  );
  return rows;
}

// Hard-delete reaper for soft-deleted leads older than `days`.
// Called by a daily cron from index.js (set up later if desired).
async function reapOldDeletedLeads(days = 30) {
  const r = await pool.query(
    `DELETE FROM desk_crm
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return { hardDeleted: r.rowCount };
}

module.exports = {
  init,
  // notes
  addNote,
  listNotes,
  softDeleteNote,
  restoreNote,
  reapOldDeletedNotes,
  // audit
  buildDiff,
  logAudit,
  listAudit,
  // undo
  snapshotBeforeUpdate,
  undoLastChange,
  SNAPSHOT_FIELDS,
  // soft-delete on lead row
  softDeleteLead,
  restoreLead,
  listRecentlyDeleted,
  reapOldDeletedLeads,
  // legacy
  migrateLegacyNotes,
};
