// lib/url-guard.js — SSRF protection for server-side URL fetches.
//
// The scrape / photo / OCR endpoints fetch URLs supplied (directly or
// indirectly) by the caller. Without validation, an authenticated user
// could point the server at internal addresses — cloud metadata
// (169.254.169.254), localhost, RFC1918 — and read the response. This
// module blocks that while still allowing ANY public host, so legitimate
// dealer/CDN scraping is unaffected (no domain allowlist to maintain).
//
// Security audit 2026-06-18.
'use strict';

const dns = require('dns').promises;
const net = require('net');

// True if an IP literal is in a non-public (blocked) range.
function isBlockedIp(ip) {
  if (!ip) return true;
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // ::ffff:1.2.3.4
  if (v4mapped) ip = v4mapped[1];

  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0)   return true;                              // 0.0.0.0/8
    if (o[0] === 10)  return true;                              // 10/8 private
    if (o[0] === 127) return true;                              // loopback
    if (o[0] === 169 && o[1] === 254) return true;              // link-local + 169.254.169.254 metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;  // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true;              // 192.168/16
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;  // 192.0.0/24
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT 100.64/10
    if (o[0] >= 224)  return true;                              // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lc = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lc === '::1' || lc === '::') return true;               // loopback / unspecified
    if (lc.startsWith('fe80')) return true;                     // link-local
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true;// unique-local fc00::/7
    if (lc.startsWith('ff')) return true;                       // multicast
    return false;
  }
  return true; // not a valid IP → block to be safe
}

// Validate a URL is safe to fetch. Throws Error('SSRF blocked: …') if not.
// Returns the parsed URL on success.
async function assertPublicUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('SSRF blocked: invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('SSRF blocked: only http(s) URLs allowed');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('SSRF blocked: private/internal IP literal');
    return u;
  }
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('SSRF blocked: internal hostname');
  }
  // Resolve and reject if ANY resolved address is non-public.
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error('SSRF blocked: DNS resolution failed'); }
  if (!addrs.length) throw new Error('SSRF blocked: no DNS records');
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error('SSRF blocked: resolves to private/internal IP');
  }
  return u;
}

// safeFetch — drop-in for fetch() that validates the target and every
// redirect hop. Follows redirects manually (up to maxRedirects) so callers
// that rely on redirect-following keep working, but re-validates each
// Location to stop redirect-based SSRF. Returns the final Response; caller
// reads .text()/.arrayBuffer() as usual. Throws on a blocked target — which
// callers already handle as a fetch failure (try/catch → fallback).
async function safeFetch(urlStr, opts = {}, maxRedirects = 4) {
  let current = urlStr;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current);
    const r = await fetch(current, { ...opts, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      if (i === maxRedirects) throw new Error('SSRF blocked: too many redirects');
      current = new URL(r.headers.get('location'), current).toString();
      continue;
    }
    return r;
  }
  throw new Error('SSRF blocked: redirect loop');
}

module.exports = { assertPublicUrl, safeFetch, isBlockedIp };
