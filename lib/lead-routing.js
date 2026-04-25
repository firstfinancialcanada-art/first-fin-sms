// lib/lead-routing.js — Lead distribution rules engine
//
// When Build 2's IMAP poller drops a new lead into the CRM (currently
// with assigned_rep_id=NULL), this module decides which rep gets it
// and updates assigned_rep_id accordingly.
//
// Mil's pitch (project_hunt_chrysler_deal.md):
//   "I want the dashboard to have the flexibility to create whatever
//    I want. I can do round robin, sharks and I can assign certain
//    sources just to go to one person or deselect people from a
//    source."
//
// MVP rule types implemented here:
//   - source_match  (lead.source ∈ rule.sources → assign to rule.repIds round-robin)
//   - round_robin   (catch-all → assign to all active reps in round-robin)
//   - none          (always pool — kept as 'noop' / 'leave_unassigned')
//
// Out of MVP scope (deferred):
//   - 'sharks' (skill-weighted distribution by rep performance)
//   - per-source deselect UI sugar (achievable today via source_match
//     with everyone EXCEPT the deselected reps)
//   - working-hours-aware routing (only assign to reps currently online)
//
// Rule ordering: lowest priority number wins. We evaluate rules in
// ascending priority order and stop at the first match. Non-matches
// fall through. If no rule matches, the lead stays in the pool.
//
// Round-robin state lives in lead_routing_state (one row per
// tenant + rule_id) — tracks the last_rep_id we assigned to so the
// next call advances to the next rep. Cycle is deterministic by
// member_id ASC after filtering to active reps eligible per the rule.
'use strict';

const { pool } = require('./db');

const VALID_RULE_TYPES = ['source_match', 'round_robin', 'noop'];

// ── Schema (idempotent, runs on require) ───────────────────────────
let _initPromise = null;
function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS lead_routing_rules (
          id          SERIAL PRIMARY KEY,
          tenant_id   INTEGER NOT NULL REFERENCES desk_tenants(id) ON DELETE CASCADE,
          priority    INTEGER NOT NULL DEFAULT 100,
          rule_type   VARCHAR(40) NOT NULL,
          sources     TEXT[],
          rep_ids     INTEGER[],
          enabled     BOOLEAN NOT NULL DEFAULT TRUE,
          label       VARCHAR(120),
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_routing_rules_tenant
          ON lead_routing_rules(tenant_id, priority);

        CREATE TABLE IF NOT EXISTS lead_routing_state (
          tenant_id     INTEGER NOT NULL REFERENCES desk_tenants(id) ON DELETE CASCADE,
          rule_id       INTEGER NOT NULL REFERENCES lead_routing_rules(id) ON DELETE CASCADE,
          last_rep_id   INTEGER REFERENCES desk_users(id) ON DELETE SET NULL,
          last_assigned_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (tenant_id, rule_id)
        );
      `);
      console.log('✅ lead_routing_rules + lead_routing_state ready');
    } catch (e) {
      console.error('❌ lead-routing init:', e.message);
    }
  })();
  return _initPromise;
}
init();

// ── Read helpers ───────────────────────────────────────────────────

// All enabled rules for a tenant, ordered by priority ASC (lower = first).
async function listRules(tenantId, includeDisabled = false) {
  const where = includeDisabled
    ? 'WHERE tenant_id = $1'
    : 'WHERE tenant_id = $1 AND enabled = TRUE';
  const { rows } = await pool.query(
    `SELECT id, priority, rule_type, sources, rep_ids, enabled, label,
            created_at, updated_at
       FROM lead_routing_rules ${where}
       ORDER BY priority ASC, id ASC`,
    [tenantId]
  );
  return rows;
}

// Active reps in this tenant — used to expand 'all reps' for
// round-robin and to filter rule.rep_ids down to current members
// (in case a rep was removed but rules weren't updated).
async function listActiveReps(tenantId) {
  const { rows } = await pool.query(
    `SELECT m.user_id, m.role, u.display_name, u.email
       FROM desk_members m
       JOIN desk_users   u ON u.id = m.user_id
      WHERE m.tenant_id = $1
        AND m.active = TRUE
        AND m.role IN ('rep', 'manager')
      ORDER BY m.id ASC`,
    [tenantId]
  );
  return rows;
}

// ── Write helpers (used by Build 4 admin UI) ───────────────────────

async function createRule(tenantId, opts = {}) {
  const { priority = 100, ruleType, sources = null, repIds = null,
          enabled = true, label = null } = opts;
  if (!VALID_RULE_TYPES.includes(ruleType)) {
    throw new Error('Invalid rule_type: ' + ruleType);
  }
  const { rows } = await pool.query(
    `INSERT INTO lead_routing_rules
       (tenant_id, priority, rule_type, sources, rep_ids, enabled, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, priority, ruleType, sources, repIds, enabled, label]
  );
  return rows[0];
}

async function updateRule(ruleId, patch) {
  const fields = [];
  const vals   = [ruleId];
  const set    = (col, val) => { vals.push(val); fields.push(`${col} = $${vals.length}`); };
  if (patch.priority  !== undefined) set('priority',  patch.priority);
  if (patch.ruleType  !== undefined) {
    if (!VALID_RULE_TYPES.includes(patch.ruleType)) throw new Error('Invalid rule_type');
    set('rule_type', patch.ruleType);
  }
  if (patch.sources   !== undefined) set('sources',   patch.sources);
  if (patch.repIds    !== undefined) set('rep_ids',   patch.repIds);
  if (patch.enabled   !== undefined) set('enabled',   !!patch.enabled);
  if (patch.label     !== undefined) set('label',     patch.label);
  if (!fields.length) return;
  fields.push('updated_at = NOW()');
  await pool.query(
    `UPDATE lead_routing_rules SET ${fields.join(', ')} WHERE id = $1`,
    vals
  );
}

async function deleteRule(ruleId) {
  await pool.query(`DELETE FROM lead_routing_rules WHERE id = $1`, [ruleId]);
}

// ── Round-robin advance ────────────────────────────────────────────
// Given a tenant, rule, and the candidate rep list, pick the rep AFTER
// the one we last assigned to. First call (state row missing) picks
// the first candidate. State row updates atomically inside the same
// transaction the caller uses.
async function pickRoundRobinRep(client, tenantId, ruleId, candidateUserIds) {
  if (!candidateUserIds || !candidateUserIds.length) return null;
  const sorted = [...candidateUserIds].sort((a, b) => a - b);

  const stateRow = await client.query(
    `SELECT last_rep_id FROM lead_routing_state
      WHERE tenant_id = $1 AND rule_id = $2 FOR UPDATE`,
    [tenantId, ruleId]
  );
  const lastId = stateRow.rows[0]?.last_rep_id;

  // Pick the rep after lastId (or the first if we've never assigned)
  let nextId;
  if (lastId == null) {
    nextId = sorted[0];
  } else {
    const idx = sorted.indexOf(lastId);
    if (idx === -1) {
      nextId = sorted[0];                      // last rep no longer eligible
    } else {
      nextId = sorted[(idx + 1) % sorted.length];
    }
  }

  // Upsert state
  await client.query(
    `INSERT INTO lead_routing_state (tenant_id, rule_id, last_rep_id, last_assigned_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, rule_id) DO UPDATE
       SET last_rep_id = $3, last_assigned_at = NOW()`,
    [tenantId, ruleId, nextId]
  );
  return nextId;
}

// ── Main: assign a fresh CRM lead per the tenant's rules ───────────
// Inputs: tenantId + crmEntryId (the row Build 2 just inserted, in pool)
//          + the lead's source ('AutoTrader' / 'Kijiji' / etc.)
// Effect: updates desk_crm.assigned_rep_id if any rule matches.
// Returns: { assigned: bool, repId, ruleId, ruleType, candidates }
async function routeLead({ tenantId, crmEntryId, source }) {
  if (!tenantId || !crmEntryId) {
    return { assigned: false, reason: 'missing_args' };
  }
  await init();
  const rules     = await listRules(tenantId, false);
  const activeReps = await listActiveReps(tenantId);
  const activeIds  = activeReps.map(r => r.user_id);
  if (!rules.length) {
    return { assigned: false, reason: 'no_rules', activeReps: activeIds.length };
  }
  if (!activeIds.length) {
    return { assigned: false, reason: 'no_active_reps' };
  }

  for (const rule of rules) {
    // Determine candidate reps for this rule
    let candidates;
    if (rule.rep_ids && rule.rep_ids.length) {
      // Filter to currently-active reps only — if a rep was removed
      // since the rule was made, skip them.
      candidates = rule.rep_ids.filter(id => activeIds.includes(id));
    } else {
      // No rep_ids configured = "all reps in the tenant"
      candidates = activeIds;
    }
    if (!candidates.length) continue;

    // Type-specific match check
    if (rule.rule_type === 'source_match') {
      const sources = (rule.sources || []).map(s => String(s).toLowerCase());
      if (!sources.includes(String(source || '').toLowerCase())) continue;
      // Match — round-robin among the candidates
    } else if (rule.rule_type === 'round_robin') {
      // Always matches (catch-all)
    } else if (rule.rule_type === 'noop') {
      // Explicitly leave in pool — exit here, don't fall through to
      // later rules. Useful as a "dead drop" rule for one source.
      return { assigned: false, reason: 'noop_rule', ruleId: rule.id };
    } else {
      continue;
    }

    // Apply: pick rep + update CRM row inside a transaction so the
    // round-robin state advance and the assignment are atomic.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const repId = await pickRoundRobinRep(client, tenantId, rule.id, candidates);
      if (!repId) { await client.query('ROLLBACK'); continue; }
      await client.query(
        `UPDATE desk_crm
            SET assigned_rep_id = $1, updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3`,
        [repId, crmEntryId, tenantId]
      );
      await client.query('COMMIT');
      return {
        assigned:   true,
        repId,
        ruleId:     rule.id,
        ruleType:   rule.rule_type,
        candidates: candidates.length,
      };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error('[lead-routing] route error on rule', rule.id, e.message);
      // continue to next rule rather than swallow the lead
    } finally {
      client.release();
    }
  }

  return { assigned: false, reason: 'no_rule_matched' };
}

module.exports = {
  init,
  listRules,
  listActiveReps,
  createRule,
  updateRule,
  deleteRule,
  routeLead,
  VALID_RULE_TYPES,
};
