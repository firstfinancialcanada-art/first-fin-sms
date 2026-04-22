// lib/tenant-scope.js — Tenant + role resolver for route handlers
//
// Central place where routes get "who is this user, what tenant do they
// belong to, what's their role, and what CRM visibility mode do they
// have?" Consumed by Phase 5's per-route scoping migration. Not used
// by any route as of Phase 4 — just sitting here ready.
//
// Why a helper instead of inlining in every route:
//   1. JWT carries tenantId/memberRole/crmMode as of Phase 2b, BUT
//      tokens issued before that deploy don't have those fields. This
//      module handles the fallback DB lookup transparently so route
//      handlers can treat scope as always-available.
//   2. Routes that need to build CRM visibility SQL (reps see own +
//      pool, managers see all) all use the same logic via
//      buildCrmReadFilter. Keeps the visibility rules in one place.
//   3. Role hierarchy (owner ≥ manager ≥ rep) is checked via roleAtLeast
//      rather than each route writing its own role comparison.
'use strict';

const tenants = require('./tenants');

const ROLE_RANK = { owner: 3, manager: 2, rep: 1 };

// Resolve the full scope context for an authenticated request.
// Prefers JWT-embedded fields (Phase 2b+), falls back to DB lookup for
// older tokens. Returns null if the user has no member row at all
// (shouldn't happen post-migration but is guarded for safety).
async function resolveScope(req) {
  if (!req || !req.user || !req.user.userId) return null;

  // Fast path: JWT has everything we need
  if (req.user.tenantId && req.user.memberRole) {
    return {
      userId:     req.user.userId,
      tenantId:   req.user.tenantId,
      memberRole: req.user.memberRole,
      crmMode:    req.user.crmMode || 'pool_plus_own',
      tier:       req.user.tier   || 'single',
      source:     'jwt',
    };
  }

  // Slow path: older token, look up membership from DB
  try {
    const m = await tenants.getPrimaryMembership(req.user.userId);
    if (!m) return null;
    return {
      userId:     req.user.userId,
      tenantId:   m.tenantId,
      memberRole: m.memberRole,
      crmMode:    m.crmMode,
      tier:       m.tier,
      source:     'db',
    };
  } catch {
    return null;
  }
}

// Role hierarchy check. True if the user's role >= minimum required.
function roleAtLeast(scope, minRole) {
  if (!scope || !scope.memberRole) return false;
  return (ROLE_RANK[scope.memberRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

// Build a SQL WHERE fragment + params array for CRM read visibility,
// based on the user's role and crmMode. Usage:
//
//   const { where, params } = buildCrmReadFilter(scope, 'c');
//   const sql = `SELECT * FROM desk_crm c WHERE ${where} ORDER BY ...`;
//
// The returned `params` array is ready to concat with any additional
// route-specific params — callers should place it FIRST and adjust
// their placeholder indexing accordingly.
//
// Visibility rules:
//   owner    / manager → all rows in the tenant
//   rep + team_read    → all rows in the tenant (read-only at app layer)
//   rep + pool_plus_own → own + unassigned (assigned_rep_id IS NULL)
//   rep + private      → only own
function buildCrmReadFilter(scope, tableAlias = 'desk_crm') {
  if (!scope) return { where: 'FALSE', params: [] };
  const alias = tableAlias.replace(/[^a-z0-9_]/gi, '');  // injection guard
  const col = (c) => alias ? `${alias}.${c}` : c;

  // Managers and owners always see everything in their tenant
  if (roleAtLeast(scope, 'manager')) {
    return {
      where:  `${col('tenant_id')} = $1`,
      params: [scope.tenantId],
    };
  }

  // Reps — branch on crm_mode
  switch (scope.crmMode) {
    case 'team_read':
      return {
        where:  `${col('tenant_id')} = $1`,
        params: [scope.tenantId],
      };
    case 'private':
      return {
        where:  `${col('tenant_id')} = $1 AND ${col('assigned_rep_id')} = $2`,
        params: [scope.tenantId, scope.userId],
      };
    case 'pool_plus_own':
    default:
      return {
        where:  `${col('tenant_id')} = $1 AND (${col('assigned_rep_id')} = $2 OR ${col('assigned_rep_id')} IS NULL)`,
        params: [scope.tenantId, scope.userId],
      };
  }
}

// Given a fetched CRM row, decide whether this user can mutate it
// (PATCH/DELETE). Managers+ always can; reps can only mutate rows
// they're assigned to (or claim from the pool by first-write).
function canMutateCrmRow(scope, row) {
  if (!scope || !row) return false;
  if (row.tenant_id !== scope.tenantId) return false;
  if (roleAtLeast(scope, 'manager')) return true;
  // Rep: own row OR unassigned (they're claiming it via this action)
  if (row.assigned_rep_id == null) return true;
  return row.assigned_rep_id === scope.userId;
}

// Express middleware factory: blocks requests whose user doesn't meet
// the minimum role for a route. Use like:
//   app.post('/api/.../manager-only-thing', requireAuth, requireRole('manager'), handler)
function requireRole(minRole) {
  return async (req, res, next) => {
    const scope = await resolveScope(req);
    if (!scope) {
      return res.status(401).json({ success: false, error: 'No tenant membership' });
    }
    if (!roleAtLeast(scope, minRole)) {
      return res.status(403).json({ success: false, error: `Requires ${minRole} role or higher` });
    }
    // Cache on the request so handlers don't re-resolve
    req.scope = scope;
    next();
  };
}

module.exports = {
  resolveScope,
  roleAtLeast,
  buildCrmReadFilter,
  canMutateCrmRow,
  requireRole,
  ROLE_RANK,
};
