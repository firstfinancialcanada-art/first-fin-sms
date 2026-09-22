# First-Fin — current worklist

**Updated 2026-09-22.** This is the live list. `TODO-PLAN-v16.md` is the April 2026 product roadmap and is kept for reference only — it was never ticked off, so don't read it as current status.

---

## This week

Franco is selling cars at South Trail Chrysler to get sharp on the phone. SaaS prospect **calls are held until Friday 25 Sept**; Monday to Thursday is written outreach only (text / Messenger / email), every message asking for a Friday time. Per-person drafts: `Desktop\FIRST-FIN SaaS Prospects\THIS-WEEK-2026-09-21.md`. Every touch gets logged in **/admin → Prospects**; the prospect CSV is retired.

**Wednesday 23rd:** 40+ STC car-sales calls.

## Open — Franco only

| | Item |
|---|---|
| 🔴 | **Domain auto-renew** — firstfinancialcanada.com expires **2026-10-24**. Confirm auto-renew and the card at the registrar. |
| 🔴 | **Twilio auto-recharge** — balance was $19.73 USD on 9/21. One wallet pays for every Sarah line and alert. |
| | **STC line test** (5 min, from the 6133 phone) before Wednesday — text 587-210-2129; call it, press 1, don't answer on 6308 (expect "Sorry we missed you" + transcript); call again and answer. |
| | **DMARC** — add `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:First@FirstFinancialCanada.com`. SPF and DKIM are already in place. |
| | **STC's $18.50 monthly texting allowance** — keep it, or exempt STC like First-Fin Auto? |
| | **Rotate `META_APP_SECRET`** — reset in Meta, then paste into Railway immediately; Facebook lead deliveries fail in between. |
| | **Replace-mode inventory sync** still fails (Merge works). Next re-scrape, hit Replace first so the exact Postgres error lands in the logs. |
| | **STC stock 8689645** has no body style. |
| | **Indeed ad** (commission-only associate) — in review 9/22, free 30 days, decide on sponsoring around **2026-10-22**. |

## Known gaps — deliberately not built

- **Multi-rooftop / parent-child tenants.** Platinum exists in Stripe (50 seats) but there is no store dimension anywhere: a manager at rooftop A is texted for every lead at B and C. Waiting for a real Platinum customer (Terry Robinson / Landry Auto Group is the likely first). Workaround today: one account per rooftop.
- **US dealers.** Mileage is km everywhere; timezone defaults to America/Edmonton; US texting needs A2P 10DLC registration per number and TCPA rules are stricter than CASL.
- **Sarah's script and persona are the same for every dealer.** Per-dealer city, delivery area, hours and {dealership}/{city} fill-ins are done; the wording is not per-tenant.
- **Mobile.** The deal desk has 8 responsive rules but has never had a full phone pass.
- **Full CSP enforcement** — inline scripts still need `'unsafe-inline'`; report-only policy runs alongside, 6 inline blocks to hash.

## Recently shipped (Sept 20–22)

- Sarah: per-tenant business hours, delivery area, {dealership}/{city} placeholders, discovery stage before payment talk, leads routed + reps texted, alert when the spend cap silences her.
- Voice: after-hours greeting leads with "press 1 for an advisor", every inbound call alerts the owner/managers, and a missed forward now says "Sorry we missed you" instead of "no one is available".
- FB Poster: Not-posted view, New/Used filter, inline editing of the three description lines, contact-scrubbed descriptions, pace warnings (rolling 24h per browser, traffic-light bubble, donut panel), per-post history and a manager activity tracker.
- Admin: SaaS prospect tracker with per-channel touch logging (41 prospects imported), `/admin` locked behind a sign-in, audit log table created.
- Security: public pages scrubbed of internal comments, real names and dead email links; extension download rebuilt (minified, current); Stellantis audit fully closed.
- Caps by tier (this file's date): Solo 1000, Gold 2500, Platinum 5000 vehicles and CRM contacts, counted per tenant rather than per user.

---

*Detail for each item lives in Claude's memory notes; this file is the shared summary so any session, on any device, sees the same list.*
