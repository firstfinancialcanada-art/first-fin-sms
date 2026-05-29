# First-Fin Dealer System — Security Audit
**Date:** 2026-05-29  ·  **Scope:** Production application (Railway), commit `06bbe1f`
**Prepared for:** Internal review + Stellantis Digital vendor questionnaire readiness

---

## Executive summary

First-Fin Dealer System presents a **strong baseline security posture** for a
multi-tenant SaaS platform: signed JWT auth with refresh rotation, bcrypt
password hashing, verified payment + telephony webhooks, parameterized database
access with tenant isolation, rate limiting, locked CORS, and security headers.

This audit found **1 critical**, **1 high**, **2 medium**, and **3 low** issues.
The single critical item (default admin token) is the only finding that
materially undermines the otherwise solid posture and should be remediated
immediately. Everything else is hardening or hygiene.

| Severity | Count | Status |
|---|---|---|
| 🔴 Critical | 1 | **Open — fix now** |
| 🟠 High | 1 | Open — partial auto-fix available |
| 🟡 Medium | 2 | Open |
| 🟢 Low | 3 | Open / accepted |

---

## Findings

### 🔴 C1 — Default admin token in production
**`ADMIN_TOKEN` is still set to its well-known placeholder default** (the value
shipped in setup docs — not rotated). Confirmed live during this audit: an admin
API call (`/api/admin/users`) authenticated successfully with the default value. The admin surface allows
suspend/delete/purge of users, reading all tenant data, replaying leads, and
issuing subscription-status changes.

- **Impact:** Anyone who guesses or observes the default token gains full
  operator control of the platform and all tenant data.
- **Remediation:** Rotate `ADMIN_TOKEN` in Railway → firstfin → Variables to a
  32+ char random secret. Re-authenticate `/admin` with the new value. ~60 sec.
- **Owner:** Franco. **Priority:** Immediate.

---

### 🟠 H1 — Known dependency vulnerabilities (6 high, 4 moderate)
`npm audit` reports 10 advisories in production dependencies.

- **Non-breaking subset** (axios prototype-pollution, follow-redirects header
  leak, fast-xml-builder): fixable with `npm audit fix` — no API changes.
- **Breaking subset** — the IMAP lead-polling chain
  (`imap-simple → imap → utf7 → semver` ReDoS): the only published fix is
  `imap-simple@1.6.3`, a **major downgrade** that could break `lib/lead-intake.js`.
  Do **not** blind-run `npm audit fix --force`.
- **Remediation:**
  1. Run `npm audit fix` now (safe, non-breaking) — clears axios / follow-redirects / fast-xml-builder.
  2. Schedule the IMAP-chain migration separately: test lead intake against
     `imap-simple@1.6.3` (or migrate to a maintained IMAP client) in a branch
     before shipping. The ReDoS requires a maliciously crafted server response —
     low real-world exposure since we control the polled inbox (Gmail).
- **Priority:** Medium-near-term.

---

### 🟡 M1 — Public invoice page (unauthenticated PII)
`/invoices/hunt-chrysler-2026-05` is served as a static, **unauthenticated**
page (route at `index.js:110` + `express.static`). It exposes Hunt Chrysler's
billing address, First-Fin's GST/HST registration number, payment instructions,
and Stripe references to anyone with the URL. The path pattern is predictable
(`/invoices/<dealer>-<yyyy>-<mm>`).

- **Impact:** Tenant + business PII disclosure to anyone who guesses the URL.
- **Remediation:** Move invoices behind auth, OR generate them at a long random
  unguessable slug (e.g. `/invoices/<uuid>`), OR serve as a one-time/expiring
  signed link. At minimum, don't use a guessable dealer-name + date pattern.
- **Priority:** Medium.

---

### 🟡 M2 — Content-Security-Policy disabled
Helmet is enabled but `contentSecurityPolicy: false` (`index.js:43`) to allow
inline scripts in `platform.html`. Without CSP, any reflected or stored XSS has
an unconstrained execution surface.

- **Remediation:** Adopt a CSP with nonces or hashes for the known inline
  scripts rather than disabling it wholesale. Medium effort (audit inline
  `<script>` blocks, add nonces).
- **Priority:** Medium.

---

### 🟢 L1 — Two FB-helper endpoints lack billing gate
`/api/desk/scrape-domain` and `/api/desk/filter-ad-photos` are `requireAuth`
only (no `requireBilling`). A suspended/unpaid user with a valid token could
still call them.

- **Impact:** Minimal — both are useless without the core scrape/sync endpoints,
  which **are** billing-gated (return 403 SUSPENDED). Defense-in-depth gap only.
- **Remediation:** Add `requireBilling` to both for consistency.

### 🟢 L2 — Access-token suspension lag (≤4h, by design)
A suspended user's already-issued access token remains valid read-only until its
4h TTL expires; login and refresh are now both gated (fixed this session,
`06bbe1f`), so they cannot renew. Write/scrape paths are billing-gated and 403
immediately.

- **Remediation (optional):** For instant lockout, add a `suspended` check inside
  `requireAuth` — costs one DB lookup per authenticated request. Current ≤4h
  read-only tail is an accepted tradeoff.

### 🟢 L3 — Retired `fb-license` route still mounted
`/api/fb-license` (`routes/fb-license.js`) remains mounted (`index.js:172`)
though the FB-poster licensing model is retired. Dead/duplicate auth surface.

- **Remediation:** Remove the mount + file to reduce attack surface and
  maintenance confusion.

---

## Verified strengths (questionnaire-ready)

These were checked and confirmed during the audit:

- **Authentication:** JWT (HS256); `JWT_SECRET` mandatory — process refuses to
  boot without it. Access tokens 4h, refresh tokens 3 days with **rotation** and
  **SHA-256-hashed storage** (raw refresh tokens never stored).
- **Passwords:** bcrypt, cost factor 12.
- **Account suspension:** enforced at login, refresh, **and** the billing
  middleware — admin "Suspend" is a hard cut (verified this session).
- **Payment security:** Stripe webhook **signature verification**
  (`constructEvent` with raw body + `STRIPE_WEBHOOK_SECRET`). Card data never
  touches our servers (Stripe-hosted checkout).
- **Telephony security:** **all** Twilio SMS/voice webhooks pass through
  signature validation (`validateTwilio`).
- **SQL injection:** parameterized queries throughout. The two dynamic-update
  sites use **column whitelists** (`SAFE_FIELDS`) / hardcoded column literals
  with length caps and role + tenant scoping — no user-controlled identifiers.
- **Tenant isolation:** queries scoped by `tenant_id`; role gating
  (owner / manager / rep) on sensitive mutations.
- **Rate limiting:** login 10 / 15 min, register 5 / hr, change-password
  5 / 15 min, global API 200 / min, webhooks 60 / min — all per-IP.
- **CORS:** locked to known origins + chrome-extension scheme; webhooks exempt
  for server-to-server.
- **Security headers:** Helmet enabled (CSP excepted — see M2).
- **Self-registration:** disabled by default behind `SELF_REGISTRATION_ENABLED`.
- **Public inquiry form:** hardened with honeypot + bot-pattern rejection +
  per-IP rate limit + IP/UA capture.
- **Data lifecycle:** soft-delete with 30-day recovery window; audit logging on
  admin actions.
- **Secrets:** no hardcoded credentials in source; `.env` git-ignored.

---

## Remediation priority order

1. **Now:** Rotate `ADMIN_TOKEN` (C1). [Franco — Railway]
2. **This week:** `npm audit fix` non-breaking subset (H1a); gate invoice page (M1).
3. **Near-term:** Add `requireBilling` to L1 endpoints; remove `fb-license` mount (L3).
4. **Scheduled:** IMAP-chain dependency migration with intake testing (H1b); CSP with nonces (M2).
5. **Optional:** Instant suspension via `requireAuth` DB-check (L2).

---

*Audit performed by reading source at commit `06bbe1f` and probing the live
production endpoints. No destructive actions taken. Findings reflect state as of
2026-05-29.*
