// ============================================================
// middleware/auth.js — JWT Authentication for Desk Routes
// ============================================================
const jwt = require('jsonwebtoken');
const tenants = require('../lib/tenants');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET environment variable is required. Set it in Railway.');
  process.exit(1);
}
const ACCESS_TTL = '4h';
const REFRESH_TTL_DAYS = 3;

// generateAccessToken is now async — it looks up the user's primary
// tenant membership (lib/tenants) so tenantId + memberRole + crmMode are
// baked into the JWT. Downstream requireAuth then exposes all of these on
// req.user without each route needing a per-request DB lookup.
//
// Existing old tokens (issued before Phase 2b) still verify — they just
// lack these fields. Routes that use req.user.tenantId need to fall back
// to looking it up via tenants.getPrimaryMembership(userId) for users on
// older tokens. Those tokens expire in 4h so the fallback only matters
// during a short rollover window.
async function generateAccessToken(user) {
  const payload = {
    userId: user.id,
    email:  user.email,
    name:   user.display_name,
    role:   user.role,
  };
  try {
    const m = await tenants.getPrimaryMembership(user.id);
    if (m) {
      payload.tenantId   = m.tenantId;
      payload.memberRole = m.memberRole;    // 'owner' | 'manager' | 'rep'
      payload.crmMode    = m.crmMode;       // 'private' | 'pool_plus_own' | 'team_read'
      payload.tier       = m.tier;          // 'single' | 'gold'
    }
  } catch (e) {
    // Non-fatal — issue a basic token if membership lookup fails.
    // Routes that need tenantId will fall back to a per-request lookup.
    console.warn('[auth] generateAccessToken membership lookup failed:', e.message);
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

function generateRefreshToken(user) {
  return jwt.sign(
    { userId: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: `${REFRESH_TTL_DAYS}d` }
  );
}

// Middleware: require valid JWT on request
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.user = decoded; // { userId, email, name, role, tenantId?, memberRole?, crmMode?, tier? }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

module.exports = { generateAccessToken, generateRefreshToken, requireAuth, JWT_SECRET, REFRESH_TTL_DAYS };

