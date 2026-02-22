// ============================================================
// middleware/auth.js — JWT Authentication for Desk Routes
// ============================================================
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ff-default-secret-change-me';
const ACCESS_TTL = '4h';
const REFRESH_TTL_DAYS = 7;

function generateAccessToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, name: user.display_name, role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
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
    req.user = decoded; // { userId, email, name, role }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

module.exports = { generateAccessToken, generateRefreshToken, requireAuth, JWT_SECRET, REFRESH_TTL_DAYS };

