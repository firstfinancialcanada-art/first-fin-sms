# First Fin v16 — TODO Plan

Organized by priority. Last updated 2026-04-25 after Phase 6 ship + pricing-model lockdown.

**Legend:**
- 🚨 P0 — blocks Mil's demo or first paying Gold customer
- ⚡ P1 — ship before second paying Gold customer
- 🛠 P2 — roadmap / nice-to-have
- 🐛 TECH-DEBT — code health

---

## 🚨 P0 — BEFORE MIL'S CALL (Hunt Chrysler)

### Tenant provisioning
- [ ] Create Hunt Chrysler tenant in admin panel (10-seat Gold tier)
- [ ] Set Hunt's `lead_intake_email` = `huntchrysler@firstfinancialcanada.com`
- [ ] Verify Gmail Workspace forwarding rule (huntchrysler@... → firstfinancialcanada@gmail.com)
- [ ] Test inbound — send a fake ADF email, confirm CRM row creation

### Inventory pre-import
- [ ] Log in as Mil's owner account (or admin impersonate)
- [ ] Install Chrome extension on demo machine
- [ ] Scan `huntchrysler.ca/vehicles/used` (Convertus, ~5-7 min)
- [ ] Scan `huntchrysler.ca/vehicles/new` (Convertus, ~5-7 min)
- [ ] Sync both via ADD mode → expect ~250 vehicles total
- [ ] Verify in Inventory tab: 250 vehicles each with 18-25 photos

### Sarah / Twilio provisioning
- [ ] Buy a Twilio number in Milton 905 area code
- [ ] Set webhook to `https://app.firstfinancialcanada.com/twilio/sms-incoming`
- [ ] Update Hunt's tenant settings: `twilioNumber = +1905XXXXXXX`
- [ ] Test: send SMS from personal phone → confirm Sarah replies with dealership-branded greeting

### Demo prep
- [ ] Re-read `ONBOARDING/Gold-Tier-Docs/02 — Hunt Chrysler Onboarding Runbook.html`
- [ ] Email Mil `ONBOARDING/Gold-Tier-Docs/03 — How First Fin Works (No Secret Sauce).html` 24h before demo
- [ ] Charge laptop, test screen-share

---

## 🚨 P0 — DURING MIL'S DEMO

Walk through these in order (60-90 sec each):
- [ ] **Inventory tab** — "All 250 of your vehicles, full photo galleries, 5 min import"
- [ ] **FB Poster** — pick a vehicle, click Auto-Fill Facebook, watch 14 fields populate + 25 photos
- [ ] **Deal Desk** — show lender comparison side-by-side
- [ ] **CRM** — show synced vehicles + a test lead
- [ ] **Lead Routing** — show intake email + routing rules
- [ ] **Sarah** — show an SMS conversation
- [ ] **Team panel** — show seat usage, invite Robbie + Wes live
- [ ] **Usage panel** — point at vague allowance language ("monthly messaging allowance")
- [ ] Quote $525 CAD/mo Gold tier
- [ ] **Close**

---

## 🚨 P0 — POST-DEMO (within 24h)

- [ ] From Team panel, copy each rep's setup URL → email each one to the actual person
- [ ] Email Mil `01 — Sarah Messaging Usage.html` (the customer-facing usage doc)
- [ ] Day-2 check-in call: "Any leads come in? Reps logging in OK?"
- [ ] Day-7: pull Team Activity panel, surface insights to Mil ("Robbie's posted 23 vehicles, Wes 0 — wanna chat?")
- [ ] Day-30: pull Usage panel, confirm spend vs cap

---

## ⚡ P1 — BEFORE SECOND GOLD CUSTOMER

### Onboarding friction reduction
- [ ] **Email automation for invites** — when manager clicks "Send Invite" in Team modal, automatically email the setup URL to the invitee via SMTP. No more manager-copy-paste. (Use SendGrid or similar; Gmail SMTP fine for low volume.)
- [ ] **Twilio number self-provisioning** — Settings → "Provision a number" button that calls Twilio API to buy a number in dealership's area code. Auto-set webhook. Auto-update tenant settings. Or at minimum a "Request a Twilio number" form that emails the request to me.
- [ ] **Welcome wizard step 5** — embed Chrome extension install link + 2-min walkthrough video

### Visibility / reporting
- [ ] **Per-rep SMS usage** in Team Activity panel (currently only FB posts tracked) — query `feature_events` filtered by `feature='sms'` per `user_id` per tenant
- [ ] **Soft-warn email** at 80% messaging usage (currently UI-only; manager might not log in for days)
- [ ] **Top-up confirmation modal** — "You're buying $25 of capacity = roughly X conversations" instead of just $ amount (vague but motivating)

### UX polish
- [ ] **REPLACE mode confirmation** — Replace mode silently wipes inventory; should require typing "REPLACE" to confirm
- [ ] **Settings → Branding section** — consolidate logo upload + dealership name + city into one tab (currently scattered)
- [ ] **Stale popup rescue** — show a "scan stuck?" recovery button after 90 seconds of no progress

---

## ⚡ P1 — POLISH / SALES SURFACE

- [ ] **Public landing page** — currently at `index.html`, refresh with Gold tier sales pitch + screenshots
- [ ] **Buy Now CTA** → Stripe checkout → setup → welcome wizard (verify whole funnel works for cold customer)
- [ ] **Sales one-pager PDF** — for Mil-style sales calls, can be left behind
- [ ] **Pricing page** on landing (currently buried)

---

## 🛠 P2 — ROADMAP

### Tier expansion
- [ ] Tier-aware caps: Solo 500 / Gold 1000 / Enterprise 2500
- [ ] Enterprise tier ($1,200/mo CAD?) for dealer groups (multiple rooftops under one billing)
- [ ] Multi-rooftop tenant model (parent + child tenants)

### Integrations
- [ ] DMS integrations (Reynolds & Reynolds, CDK, Dealertrack)
- [ ] Equifax credit pull (Gold+ add-on)
- [ ] Kijiji auto-post (similar to FB Poster)
- [ ] AutoTrader auto-post
- [ ] Custom Sarah persona/scripts per dealership
- [ ] Multi-language Sarah (French — for Quebec dealers)

### Mobile
- [ ] Mobile-responsive deal desk (currently desktop-only)
- [ ] Native mobile app for reps (iOS/Android)

### Reporting
- [ ] Dealer dashboard with weekly digest email
- [ ] Comparative benchmarks ("your dealership vs avg Gold dealer")
- [ ] Export reports to CSV/Excel

---

## 🐛 TECH-DEBT

### Code structure
- [ ] **Split `platform-main.js`** (currently >6000 lines) — atomic PR per "Monolith file split strategy" memory. Do NOT split incrementally. Pick a low-traffic window and ship the full split in one commit.
- [ ] **Migration framework** — current `setup-database-v2.js` + idempotent `init()` blocks in route files is messy. Move to Knex or Prisma migrations.
- [ ] **Per-tier Twilio cap** — currently shared 1850 cents constant. If Gold dealers stress the limit, split into `TENANT_CAPS.byTier.{single,gold,enterprise}.smsVoiceCombinedCents`.

### Testing
- [ ] E2E tests for critical paths: checkout → setup → welcome → first lead → first SMS → first FB post
- [ ] ADF parser test fixtures for all 7 supported sources (currently only Hunt Chrysler/CarCostCanada)
- [ ] Chrome extension import tests with mocked dealer site fixtures

### Cloudflare resilience
- [ ] If Cloudflare gets more aggressive vs the deep photo scan, explore using a real headless browser (Playwright) for the scan instead of Chrome's `chrome.scripting.executeScript()`
- [ ] Or: build a server-side scanner that uses residential proxies to mimic real browser sessions

---

## ✅ COMPLETED IN PHASE 6 (2026-04-25)

(For reference — don't re-do these.)

- [x] Convertus listing-card handler (skip VDP entirely on supported platforms)
- [x] Pathname dedup for paired VDP links (158 → 79)
- [x] Server-scrape short-circuit when Convertus cards detected
- [x] Version-tagged content.js guard (extension reload picks up new code)
- [x] Deep photo scan via VDP lightbox click (24-26 photos/vehicle)
- [x] Cloudflare cooldown + 60s retry pass
- [x] Status='done' hotfix for stuck popups
- [x] MV3 service-worker keepalive (chunked sleeps)
- [x] Photo cap raised 10 → 25 across full pipeline
- [x] Tenant-shared inventory (Phase 6 commit `7178357`)
- [x] Reps role-gated from inventory delete (`8e1f8ad`)
- [x] Manager Team modal + self-serve member endpoints (`0c9c2e0`)
- [x] Gold-tier post-checkout welcome wizard (`4520f8b`)
- [x] Per-rep FB Marketplace post tracking (`96bb484`)
- [x] Inventory + CRM caps 500 → 1000 (`16e042d`)
- [x] Customer-facing $ amounts scrubbed (`d61673b`)
- [x] Twilio cost estimates inflated for hidden-cost buffer (`875593c`)
- [x] Pricing model locked in `lib/constants.js` comments (`3c2b32d`)
- [x] Gold-tier docs package: 3 HTML docs + README (`c719c63`, `d61673b`)
- [x] Hunt Chrysler runbook locked at $525 Gold tier price

---

**Next gating event:** Mil's demo. Everything in 🚨 P0 must be done before that call.
