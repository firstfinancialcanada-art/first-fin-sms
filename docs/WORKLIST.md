# First-Fin — current worklist

**Updated 2026-09-22.** This is the live list. `TODO-PLAN-v16.md` is the April 2026 product roadmap and is kept for reference only — it was never ticked off, so don't read it as current status.

---

## This week

Franco is selling cars at South Trail Chrysler to get sharp on the phone. SaaS prospect **calls are held until Friday 25 Sept**; Monday to Thursday is written outreach only (text / Messenger / email), every message asking for a Friday time. Per-person drafts: `Desktop\FIRST-FIN SaaS Prospects\THIS-WEEK-2026-09-21.md`. Every touch gets logged in **/admin → Prospects**; the prospect CSV is retired.

**Wednesday 23rd:** 40+ STC car-sales calls.

## Open — Franco only

| | Item |
|---|---|
| ✅ | ~~**Domain auto-renew**~~ — firstfinancialcanada.com (expires 2026-10-24). Franco set auto-renew ON 2026-09-25. |
| ✅ | ~~**Twilio auto-recharge**~~ — card + auto-recharge set by Franco 2026-09-25. Dead numbers released; bill $4.20 → ~$1.15/mo. |
| ➖ | ~~STC line test~~ — moot, Franco is out at STC and the number is released. |
| | **DMARC** — add `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:First@FirstFinancialCanada.com`. SPF and DKIM are already in place. |
| | **Rotate `META_APP_SECRET`** — reset in Meta, then paste into Railway immediately; Facebook lead deliveries fail in between. |
| | **Replace-mode inventory sync** still fails (Merge works). Next re-scrape, hit Replace first so the exact Postgres error lands in the logs. |
| ➖ | ~~STC stock 8689645 body style~~ — moot, STC tenant is gone. |
| | **fintest@fintest.com password reset** (admin PW button) — needed to drive the new billing overlay end-to-end on a real login. |
| | **Wholesale signage — option A**: swap text OCR for an image-understanding model to catch small signs (~$3–4 one-time, needs an API key). Hides are already remembered either way. |
| | **Indeed ad** (commission-only associate) — LIVE 9/22, free 30 days; decide on sponsoring around **2026-10-22**. |

## Found by audit 2026-09-22 — your call

- ✅ ~~Spend cap per user~~ — FIXED 2026-09-25 (109cb1b). One allowance per dealership; reconcileSpend was correcting the sender's row too.
- ✅ ~~Lender rate sheets per user~~ — FIXED 2026-09-25 (4e2de6a). Tenant-scoped + manager-gated. Also fixed: the reset route threw ReferenceError, and rate history archived the wrong rows.
- ✅ ~~Customer texts bypassing the opt-out list~~ — FIXED 2026-09-25 (3a499a9). Four paths could text someone who replied STOP; all now go through lib/customer-sms.js, which fails closed. Staff alerts deliberately still uncapped.
- **Two Twilio status callbacks aren't signature-checked** (`/api/sms-status`, `/api/voice-status`). Exploitable only by someone who already knows a message ID.
- ✅ ~~Compare All mileage mismatch~~ — CLOSED 2026-09-25 (f5a490f), and it was not what the audit called it. The per-tier `maxMile` strings in the CLIENT lender table are never rendered by anything — the lender table draws the lender-level `maxMileage`, tier cards draw only tier/rate/fico/maxLtv. Only the SERVER reads per-tier maxMile. So the two sides could not conflict on that field and no user ever saw 140,000. `npm run check-lenders` now compares only fields both sides consume and passes clean across 12 lenders. **The real point (Franco):** lender criteria "constantly change as new and updated rate sheets are provided by the lenders" — so these hardcoded tables are only a FALLBACK. An uploaded sheet already overrides the engine (`getQualifyingProgram` tries tenant rates first) and the display (★ badge). Keeping current is the upload's job.
- **Bulk send isn't crash-safe:** a redeploy between sending and recording could re-send that message.
- **No limit on buying Twilio numbers** per account.
- **Stripe upgrade path may not activate** a logged-in user's subscription (needs a live event to confirm).
- **`chrome-extension/*.src.js` are stale April copies**, not build inputs — editing them does nothing.

## Known gaps — deliberately not built

- **Multi-rooftop / parent-child tenants.** Platinum exists in Stripe (50 seats) but there is no store dimension anywhere: a manager at rooftop A is texted for every lead at B and C. Waiting for a real Platinum customer (Terry Robinson / Landry Auto Group is the likely first). Workaround today: one account per rooftop.
- **US dealers.** Mileage is km everywhere; timezone defaults to America/Edmonton; US texting needs A2P 10DLC registration per number and TCPA rules are stricter than CASL.
- **Sarah's script and persona are the same for every dealer.** Per-dealer city, delivery area, hours and {dealership}/{city} fill-ins are done; the wording is not per-tenant.
- **Full CSP enforcement** — inline scripts still need `'unsafe-inline'`; report-only policy runs alongside, 6 inline blocks to hash.

## Recently shipped (Sept 20–22)

- Sarah: per-tenant business hours, delivery area, {dealership}/{city} placeholders, discovery stage before payment talk, leads routed + reps texted, alert when the spend cap silences her.
- Voice: after-hours greeting leads with "press 1 for an advisor", every inbound call alerts the owner/managers, and a missed forward now says "Sorry we missed you" instead of "no one is available".
- FB Poster: Not-posted view, New/Used filter, inline editing of the three description lines, contact-scrubbed descriptions, pace warnings (rolling 24h per browser, traffic-light bubble, donut panel), per-post history and a manager activity tracker.
- Admin: SaaS prospect tracker with per-channel touch logging (41 prospects imported), `/admin` locked behind a sign-in, audit log table created.
- Security: public pages scrubbed of internal comments, real names and dead email links; extension download rebuilt (minified, current); Stellantis audit fully closed.
- STC exempted from the $18.50 monthly texting allowance 2026-09-22 (Railway `EXEMPT_EMAILS`), so Franco's own store can't be cut off mid-day.
- Caps by tier (this file's date): Solo 1000, Gold 2500, Platinum 5000 vehicles and CRM contacts, counted per tenant rather than per user.
- **Franco is out at South Trail Chrysler (2026-09-25).** Terms not agreed. STC tenant cancelled + suspended, their Sarah number released. Anything in here about STC car sales is history. Rolling with Franco is unaffected.
- **Billing enforcement rebuilt (2026-09-25).** A lapsed account kept working and said nothing about it. Fixed: exempt accounts could not be suspended or cancelled at all (the guard returned before those checks — this is why cancelling STC did nothing); 11 write routes had no billing guard, including the deal desk calculator and Compare All; the client never surfaced BILLING_REQUIRED or SUSPENDED, so buttons silently did nothing. Now: a lock overlay (dismissable to read-only) and a countdown banner in the **last 7 days before money is due** — "Your subscription renews in 3 days" / "Your trial ends in 3 days". A failed payment locks immediately; the reminder's job is to stop the miss, not to soften it. Renewal date comes from Stripe into desk_users.current_period_end. Rules live once in lib/billing-state.js.
- **Do not 'fix' Hunt Chrysler being suspended** — Mil cannot use the system until Stellantis vetting clears.
- Wholesale photo signage (2026-09-23, revised 09-25): SmartBuy's shop sign shows in some of their vehicle photos. The scan reads a LARGE sign and MISSES a small one — Franco's screenshot showed SMARTBUY AUTO LTD on a shop door that the scanner passed as clean (red letters on black; text OCR cannot read it at any setting tried, and that is a dead end, not a tuning problem). What ships: the scan still catches the obvious signs on wholesale cars, and the photos you hide by hand are now REMEMBERED (photo_hides, per tenant) — so a supplier gallery is reviewed once, ever. Your decision beats the scan in both directions. Auto-Fill still won't send a wholesale listing whose scan hasn't finished. OPEN — Franco's call: pay ~$3–4 one-time for an image-understanding model to catch small signs automatically.
- Audit fixes (2026-09-22): importer no longer reads a model year as the price (a "Call for price" card imported at $2,019 and was postable); funded-deal texts use the dealer's own Google review link instead of a dead placeholder; un-posting a vehicle no longer errors; approval probability works again (was silently unauthenticated); Sarah and Compare All see the whole dealership's inventory, not one user's; photo-request callbacks are no longer invisible; four manager checks that could be skipped are now enforced; buying a number and changing branding require manager; email-lead poller reports failures instead of dying quietly; CSP reports are no longer rejected.
- Phone pass (2026-09-22): payment grid fits a 375px screen (it carried min-width 420 and the 84-month column sat off the edge), FB Poster stacks instead of collapsing its vehicle panel to zero width, tap targets 30-32px across deal desk, Sarah, poster and admin Prospects. Desktop verified unchanged.

---

*Detail for each item lives in Claude's memory notes; this file is the shared summary so any session, on any device, sees the same list.*
