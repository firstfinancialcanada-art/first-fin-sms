// Refresh-token cookie.
//
// The session used to die with the tab, because the refresh token lived in
// sessionStorage. Moving it into a cookie fixes that, but a cookie is sent
// automatically — so the attributes below are the only thing standing between
// "stays signed in" and "any site on the web can spend your refresh token".
// Each one is pinned here rather than left to a code reader to notice.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  RT_COOKIE, refreshCookieOptions, setRefreshCookie, clearRefreshCookie, readRefreshCookie
} = require(path.join(ROOT, 'lib', 'refresh-cookie'));
const { REFRESH_TTL_DAYS } = require(path.join(ROOT, 'middleware', 'auth'));

// Minimal stand-ins for the bits of Express these helpers touch.
const mkRes = () => ({
  cookies: [], cleared: [],
  cookie(name, value, opts) { this.cookies.push({ name, value, opts }); },
  clearCookie(name, opts) { this.cleared.push({ name, opts }); }
});
const httpsReq  = (extra) => Object.assign({ headers: { 'x-forwarded-proto': 'https' } }, extra || {});
const plainReq  = (extra) => Object.assign({ headers: {} }, extra || {});
const withCookie = (cookie) => ({ headers: { cookie } });

const checks = [];
const T = (label, fn) => checks.push({ label, fn });

// ── the attributes that make this safe ───────────────────────────
T('the cookie cannot be read by page scripts', () =>
  refreshCookieOptions(httpsReq()).httpOnly === true);

T('a cross-site request never carries it', () =>
  // Without SameSite=Strict, any page on the web could POST to the rotation
  // endpoint, spend the token and sign the user out. This attribute is the
  // CSRF defence for that endpoint — there is no separate token.
  refreshCookieOptions(httpsReq()).sameSite === 'strict');

T('it is only sent over https in production', () =>
  refreshCookieOptions(httpsReq()).secure === true);

T('req.secure is honoured as well as the proxy header', () =>
  refreshCookieOptions({ secure: true, headers: {} }).secure === true);

T('but NOT over plain http, so local dev still signs in', () =>
  // A Secure cookie is dropped by the browser on http://localhost, which
  // would make every local session unresumable.
  refreshCookieOptions(plainReq()).secure === false);

T('it rides along only on desk API calls', () =>
  refreshCookieOptions(httpsReq()).path === '/api/desk');

T('it expires with the refresh token, not later', () =>
  refreshCookieOptions(httpsReq()).maxAge === REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

// ── setting ──────────────────────────────────────────────────────
T('setting it writes the token under the expected name', () => {
  const res = mkRes();
  setRefreshCookie(httpsReq(), res, 'tok.en.value');
  return res.cookies.length === 1
      && res.cookies[0].name === RT_COOKIE
      && res.cookies[0].value === 'tok.en.value';
});

// ── clearing ─────────────────────────────────────────────────────
T('clearing it drops maxAge but keeps name and path', () => {
  // A browser only matches a deletion to the cookie when the attributes line
  // up; a mismatched path leaves the original cookie in place, which would
  // mean Sign out did not actually sign anyone out.
  const res = mkRes();
  clearRefreshCookie(httpsReq(), res);
  const c = res.cleared[0];
  return res.cleared.length === 1
      && c.name === RT_COOKIE
      && c.opts.path === '/api/desk'
      && c.opts.sameSite === 'strict'
      && c.opts.httpOnly === true
      && !('maxAge' in c.opts);
});

T('clearing does not mutate the shared options object', () => {
  const res = mkRes();
  clearRefreshCookie(httpsReq(), res);
  return refreshCookieOptions(httpsReq()).maxAge === REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
});

// ── reading ──────────────────────────────────────────────────────
T('it is found among the other cookies on the page', () =>
  readRefreshCookie(withCookie('ffTheme=dark; ff_rt=a.b.c; ff_billing=x')) === 'a.b.c');

T('leading whitespace in the header does not hide it', () =>
  readRefreshCookie(withCookie('ffTheme=dark;   ff_rt=a.b.c')) === 'a.b.c');

T('it is found when it is the only cookie', () =>
  readRefreshCookie(withCookie('ff_rt=a.b.c')) === 'a.b.c');

T('a name that merely contains ff_rt is not accepted', () =>
  // "xff_rt" and "ff_rt_old" are different cookies. Matching loosely would
  // let an attacker-set cookie stand in for the real credential.
  readRefreshCookie(withCookie('xff_rt=evil; ff_rt_old=stale')) === null);

T('a JWT survives the round trip intact', () => {
  const jwtish = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.c2lnbmF0dXJl-_x';
  return readRefreshCookie(withCookie('ff_rt=' + jwtish)) === jwtish;
});

T('a percent-encoded value is decoded', () =>
  readRefreshCookie(withCookie('ff_rt=a%2Eb%2Ec')) === 'a.b.c');

T('a malformed encoding returns the raw value instead of throwing', () =>
  // decodeURIComponent throws on a lone %. Letting that escape would turn a
  // junk cookie into a 500 on every refresh.
  readRefreshCookie(withCookie('ff_rt=100%')) === '100%');

T('an empty value reads as absent, not as an empty token', () =>
  readRefreshCookie(withCookie('ff_rt=')) === null);

T('no cookie header at all is handled', () =>
  readRefreshCookie({ headers: {} }) === null
  && readRefreshCookie({}) === null
  && readRefreshCookie(null) === null);

T('a junk header without any = is handled', () =>
  readRefreshCookie(withCookie('nonsense')) === null);

// ── runner ───────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const c of checks) {
  let ok = false, err = null;
  try { ok = c.fn(); } catch (e) { err = e.message; }
  if (ok) { pass++; console.log('  PASS  ' + c.label); }
  else    { fail++; console.log('  FAIL  ' + c.label + (err ? ' — ' + err : '')); }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
