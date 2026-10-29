// ============================================================
// lib/refresh-cookie.js — where the browser keeps its refresh token
// ============================================================
//
// It used to come back in the login JSON body and sit in sessionStorage.
// That store is per-tab: closing the tab ended the session and a second tab
// was never signed in — four sign-ins in one day for one user, and seven
// users at Hunt would each hit it every time. Any script on the page could
// also read the token, and since it rotates forward on every use, three days
// of expiry makes it a standing credential rather than a short-lived one.
//
// It travels as an httpOnly cookie instead, so page scripts cannot read it at
// all and it outlives the tab. Rotation, sha256 storage and the suspension
// check in routes/desk.js are untouched — this only changes custody.
const { REFRESH_TTL_DAYS } = require('../middleware/auth');

const RT_COOKIE = 'ff_rt';

// Scoped to /api/desk so it rides along on desk API calls only, not on every
// request for an image. SameSite=Strict because cookies are sent
// automatically: without it a cross-site POST would reach the rotation
// endpoint and spend the token, logging the user out from anywhere on the web.
function refreshCookieOptions(req) {
  return {
    httpOnly: true,
    // trust proxy is set in index.js, so req.secure is accurate behind
    // Railway's TLS terminator. Off for plain-http local dev, where the
    // browser would drop a Secure cookie and nobody could stay signed in.
    secure: Boolean(req.secure || (req.headers && req.headers['x-forwarded-proto'] === 'https')),
    sameSite: 'strict',
    path: '/api/desk',
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  };
}

function setRefreshCookie(req, res, token) {
  res.cookie(RT_COOKIE, token, refreshCookieOptions(req));
}

// Same attributes minus maxAge — a browser only matches a deletion to the
// cookie when the name and path line up.
function clearRefreshCookie(req, res) {
  const opts = refreshCookieOptions(req);
  delete opts.maxAge;
  res.clearCookie(RT_COOKIE, opts);
}

// cookie-parser is not a dependency and this is the only cookie the API ever
// reads, so parse the one header rather than add middleware to every route.
function readRefreshCookie(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    // Trim before comparing, and compare in full: neither "xff_rt" nor
    // "ff_rt_old" may stand in for the real name.
    if (part.slice(0, eq).trim() !== RT_COOKIE) continue;
    const val = part.slice(eq + 1).trim();
    if (!val) return null;
    try { return decodeURIComponent(val); } catch (e) { return val; }
  }
  return null;
}

module.exports = {
  RT_COOKIE,
  refreshCookieOptions,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie
};
