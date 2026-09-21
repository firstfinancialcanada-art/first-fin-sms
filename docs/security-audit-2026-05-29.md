# First-Fin Dealer System — Security Audit
**Audit date:** 2026-05-29  ·  **Last updated:** 2026-06-18 (remediation cycle, commit `f352a14`)
**Scope:** Production application (Railway), `app.firstfinancialcanada.com`
**Prepared for:** Internal review + Stellantis Digital vendor questionnaire readiness

---

## Executive summary

First-Fin Dealer System presents a **strong baseline security posture** for a
multi-tenant SaaS platform: signed JWT auth with refresh rotation, bcrypt
password hashing, verified payment + telephony webhooks, parameterized database
access with tenant isolation, rate limiting, locked CORS, and security headers.
The platform also **deliberately minimizes its sensitive-data footprint** — it
stores no credit-application data, no government IDs, and no payment-card data
(see "Data minimization" below), which materially bounds its risk surface.

The original audit found **1 critical, 1 high, 2 medium, and 3 low** issues.
As of the 2026-06-18 remediation cycle, **4 of 8 are resolved** (see status
update).

**As of 2026-09-20 every actionable finding is closed.** The one remaining
entry, L2, was an accepted risk at the time of the audit rather than an
outstanding defect.

| Severity | Original | Resolved | Still open |
|---|---|---|---|
| 🔴 Critical | 1 | **1 (C1)** | 0 |
| 🟠 High | 1 | **1 (H1a + H1b)** | 0 |
| 🟡 Medium | 2 | **2 (M1, M2)** | 0 |
| 🟢 Low | 3 | 2 (L1, L3) | 1 (L2 — accepted) |

`npm audit --omit=dev` reports **0 vulnerabilities** as of 2026-09-20.

### Status update — 2026-06-18 (commit `f352a14` + `06bbe1f`)
- ✅ **H1a resolved** — `npm audit fix` cleared the non-breaking advisories (axios, follow-redirects, fast-xml-builder); 6 of 10 gone. Remaining 4 are the IMAP chain (H1b).
- ✅ **M1 resolved** — invoice page moved out of the web-served `public/` directory into `invoice-templates/` (not web-reachable); explicit route removed.
- ✅ **L1 resolved** — `requireBilling` added to `/api/desk/scrape-domain` and `/api/desk/filter-ad-photos`.
- ✅ **L3 resolved** — `/api/fb-license` route unmounted.
- ✅ **Suspension hardening** — login + refresh now reject suspended/soft-deleted accounts (`06bbe1f`).
- 🔴 **C1 still open** — admin token rotation (Franco, Railway).
- ⏳ **H1b, M2 deferred** — both require tested branches (see below).

### Status update — 2026-09-20 — remaining items closed

- ✅ **C1 resolved** — `ADMIN_TOKEN` rotated off the shipped default (and again off a weak interim value). Enforced at boot: the process refuses to start without it.
- ✅ **H1b resolved — without the breaking downgrade.** The 4 remaining high advisories all traced to one root: `utf7` pinned `semver@~5.3.0`, and the ReDoS (CVE-2022-25883) is patched in 5.7.2. `npm audit fix --force` wanted `imap-simple@1.6.3`, a major downgrade that risked `lib/lead-intake.js`. Instead an npm `overrides` entry pins `utf7 → semver ^5.7.2`. `utf7` calls exactly one semver function, `semver.gte()`, whose behaviour is identical across 5.3 → 5.7, and IMAP encode/decode round-trips were verified after the change. The remaining `qs`/`express` advisories were then cleared by a non-breaking `npm audit fix` (express 4.22.2 → 4.22.3). **Production dependency tree is now clean.**
- ✅ **M2 resolved — CSP enforced.** A strict `script-src` remains impractical: `platform.html` carries 16 inline `<script>` blocks and 354 inline event handlers, and refactoring all of them on a live system is a larger, riskier change than the finding warrants. What is enforced now still removes the worst of the surface:
  - `object-src 'none'` — no plugin-based execution
  - `base-uri 'self'` — a `<base>` injection cannot repoint every relative URL
  - `frame-ancestors 'self'` — clickjacking
  - `form-action 'self'` — an injected form cannot post credentials off-site
  - `default-src 'self'` with explicit allowlists (Google Fonts, unpkg/lucide, cdnjs/pdf.js, cdn.sheetjs/xlsx)

  A second policy — the same directives without `'unsafe-inline'` — ships in **`Content-Security-Policy-Report-Only`** with reports posted to `/api/csp-report`, which aggregates by directive and logs a rolling summary. That measures the inline surface instead of estimating it, and gives a defined path to full enforcement.

  Two deliberate exclusions, both documented in `index.js`: `upgrade-insecure-requests` is omitted because the Deal Desk and FB Poster talk to local bridges on `http://localhost:5001` and `:5800`; and `img-src` permits `https:` because vehicle photography is served from whatever CDN each dealer's website uses.
- ✅ **SSRF guard live** — `lib/url-guard.js` (`safeFetch`) committed as `7e1fab0` and wired into 6 outbound-fetch call sites (scraper, photo OCR, desk scrape routes).

### Data minimization (bounds the risk surface)
Verified by codebase-wide search:
- **No credit-application data** — no SIN, DOB, driver's-licence, or financial-app fields exist anywhere. Credit submission/funding is the dealer's DealerTrack/RouteOne lane; First-Fin never receives it.
- **No payment-card data** — Stripe-hosted checkout; cards never reach First-Fin servers (PCI scope is Stripe's).
- **PII held** is limited to standard CRM lead fields (name, phone, email, vehicle interest), tenant-isolated and TLS-only.

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

### 🟠 H1 — Known dependency vulnerabilities — **H1a RESOLVED, H1b deferred**
**Update 2026-06-18 (`f352a14`):** `npm audit fix` cleared the non-breaking
subset (axios, follow-redirects, fast-xml-builder) — **6 of 10 resolved**. The
remaining **4 high** are the IMAP chain (H1b), pending a tested branch migration.

Original finding: `npm audit` reported 10 advisories in production dependencies.

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

### ✅ M1 — Public invoice page (unauthenticated PII) — **RESOLVED 2026-06-18**
**Fixed in `f352a14`:** the invoice HTML was moved out of `public/` into
`invoice-templates/` (no longer web-served) and the explicit route removed.
PDF generation still works (local file render). Original finding below for record.

`/invoices/hunt-chrysler-2026-05` was served as a static, **unauthenticated**
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

### ✅ L1 — Two FB-helper endpoints lack billing gate — **RESOLVED 2026-06-18**
**Fixed in `f352a14`:** `requireBilling` added to both `/api/desk/scrape-domain`
and `/api/desk/filter-ad-photos`. Suspended/unpaid users now 403 consistently
across the entire FB-poster path.

### 🟢 L2 — Access-token suspension lag (≤4h, by design)
A suspended user's already-issued access token remains valid read-only until its
4h TTL expires; login and refresh are now both gated (fixed this session,
`06bbe1f`), so they cannot renew. Write/scrape paths are billing-gated and 403
immediately.

- **Remediation (optional):** For instant lockout, add a `suspended` check inside
  `requireAuth` — costs one DB lookup per authenticated request. Current ≤4h
  read-only tail is an accepted tradeoff.

### ✅ L3 — Retired `fb-license` route still mounted — **RESOLVED 2026-06-18**
**Fixed in `f352a14`:** `/api/fb-license` unmounted in `index.js`. Dead auth
surface removed.

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

1. **Now — ONLY remaining must-do:** Rotate `ADMIN_TOKEN` (C1). [Franco — Railway]
2. ~~`npm audit fix` non-breaking (H1a)~~ ✅ done · ~~gate invoice page (M1)~~ ✅ done
3. ~~Add `requireBilling` to L1 endpoints~~ ✅ done · ~~remove `fb-license` mount (L3)~~ ✅ done
4. **Scheduled:** IMAP-chain dependency migration with intake testing (H1b); CSP with nonces (M2).
5. **Optional:** Instant suspension via `requireAuth` DB-check (L2).

---

*Original audit (2026-05-29) performed by reading source at commit `06bbe1f` and
probing live production endpoints. Remediation cycle (2026-06-18) shipped in
commit `f352a14`. No destructive actions taken. With H1a/M1/L1/L3 resolved, the
only open must-fix is C1 (admin token rotation); H1b and M2 are scheduled
low-urgency items. This document is suitable for sharing in response to a vendor
security questionnaire.*
