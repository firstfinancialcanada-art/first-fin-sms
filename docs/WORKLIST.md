# First-Fin — current worklist

**Updated 2026-10-09.** This is the live list. `TODO-PLAN-v16.md` is the April 2026 product roadmap and is kept for reference only — it was never ticked off, so don't read it as current status.

---

## Right now

Car side is **House of Cars + Automaxx + SmartBuy**, posted from the **kevlarkarz** account. STC is history. The CRM is now the real book: 23 live leads, every one with notes, and the fake seed data is gone.

**The only thing with a clock on it — SaaS prospects.** CASL implied consent runs six months from the enquiry, and the April batch is expiring now:

| Lapses | |
|---|---|
| **Oct 11** | 1 — contacted |
| **Oct 14** | 4 — **1 never contacted** |
| **Oct 15** | 2 — **both never contacted** |
| **Oct 27** | 3 — 2 never contacted |

Five have never been contacted at all; three go dark inside a week. 33 of 46 inquiries still sit `pending`. Untouched since Sept 21.

**Live deals**
- **Saurabh Joshi** (CRM 891, Hot) — Bromwich & Smith referral from Paddy. Consumer proposal; Franco is their car broker. Draft proposal documents came from Paddy Oct 8, approval being sought off them. OPEN: the trustee says he is keeping the Ford, Franco thinks that is stale — settle it first. RISK: two scheduled calls have already failed on Franco's Freedom line and the client has chased once.
- **Michael Vance** (859, Hot) — Tekion deal 5140, pending finance.
- **Herman Mann** (867) — sitting Warm, should be Hot: said he would call the night of Oct 5 and did not, $40K across cards and a line of credit.
- **Lisa Laskowski** (857) — emailed Oct 8. Her Jetta is SOLD; the email deliberately does not say so.
- **F-150 A05848** — in inventory with 10 photos, Marketplace ad written and Auto-Fill verified.

## Shipped 2026-10-08 → 10-09

**The CRM became the book.** Temperature ladder (Dead · Cold · Warm · Hot · Sold) tinting whole rows, a **Master CRM** and a **Monthly Tracker**, drag-to-reorder in both, search across every field including notes, "Sort by heat" per month, bigger bold type. Temperature is a SEPARATE axis from status, so nothing was lost. (f265182, 0390b24, 54c80e2, f1d046e)

**Leads in.** 9 from Tekion, 12 that only existed on the Google Sheet, Saurabh Joshi, Michael Walkey — all with real notes, not just provenance. The sheet got the 7 it was missing. **236 fake seed contacts deleted**, 258 → 22.

**Tekion.** Walkey never reached it from Canada Drives so he was created by hand; Rob Robinson DID arrive 12 minutes after assignment — so that feed drops some and carries others, which is their integration problem, not hand-entry forever.

**Vehicle photos you took yourself** (b341a16, 9910b4f). Until now every photo came from a scrape. Bytes live in `desk_vehicle_photos` (BYTEA, mirroring the tenant logo), only URLs on the vehicle, public GET with CORS so the poster and the photo editor can both fetch. Camera button on every inventory row. **37 MB per truck at full phone resolution — Franco's call to leave it; downscale-in-browser is the lever if it ever bites.**

**Bugs found and fixed, all of them customer-facing:**
- **The demo was seeding itself into real accounts.** It writes its data into localStorage, which is per-ORIGIN, and two paths migrated that as "legacy data": loadCRM uploaded 12 fake leads into the signed-in tenant, and REGISTER would have given a brand-new customer fake leads, fake cars and a dealership called Maple Auto Group. That is where the 236 came from, and where MAG came from. (f1d046e)
- **A page reload took away paid features.** `_user` is only set by login(), so on resume feature gating read "entitled to nothing" and locked SARAH, DT Sync and FB Poster behind the add-on modal. (99e2a59)
- **Billing check threw for every signed-in user** — `FF.isLoggedIn` is a getter, called as a method. The renewal countdown and the arrival overlay have never run for anyone. (a2e49ad)
- **Two sign-out bugs:** a DOMContentLoaded handler raced _init and binned valid tokens, and _tryRefresh logged out on any non-OK response including a 502 mid-deploy. (2b8b515, 89a5a4b)
- **The demo showed prospects a raw auth error** where the pitch belongs. (64580f2, a708e06)
- **New leads sorted to the BOTTOM** — board_rank was only filled at boot. Now a BEFORE INSERT trigger, because five paths create leads and patching five leaves the sixth. (64f2a6c)
- `POST /api/desk/inventory` never wrote colour, trim, cost or the five spec columns a VIN decode fills. (ae83802)
- **`desk_inventory.photos` is TEXT, not JSONB** — the schema file says JSONB but the column pre-existed so `IF NOT EXISTS` skipped it. Cost three attempts. **Cleanup: the file and the live table still disagree.** (2ce3beb)

## Shipped 2026-09-26 → 10-08

**House of Cars imported (kevlarkarz / tenant 1).** All stores, 1,048 units merged in. The first three scans only found 7 pages / ~240 vehicles: House of Cars' pagination truncates the page list, so page discovery in `chrome-extension/content.js` (~line 1153, after the slug block at 1086) now **fills the gaps** between the highest visible page and the real last page — 32 pages after that. **Reloading the extension does not refresh an already-open tab** — that cost two round trips; tell Franco to reload the page too. A `$500` floor guard was added after some cards imported at a model-year-ish junk price. ~465 of the House of Cars units are still **untagged for wholesale** — photo host can't tell them apart (everything is HomeNet), so they were deliberately left alone rather than mis-tagged.

**Bi-weekly payments advertised in the listing title.** Franco's call, after seeing better click-through on payment-led posts: `FB_PAYMENT` in `public/platform.html` — **6.99%, 84 months as the FLOOR** (an older unit is never shortened below it), **96 months** for units ≤2 years old so the headline number drops, `minPrice 1000`. The payment goes in the **Model** field, not Trim — Franco's screenshot settled that; I had it in Trim first and he was re-typing it by hand. `fbpTitleModel()` builds it; `fbpPaymentLine()` writes `$X bi-weekly · N months OAC` into the description. **No interest rate is published anywhere** (1ccec72) — "OAC" carries it, and a published rate is the thing AMVIC would bite on. Open question nobody can answer yet: putting text in the Model field means it no longer matches Facebook's own dictionary, which **may** cost structured-filter visibility. It survives publishing; whether it hurts reach is unknown.

**Listing descriptions individualised.** `FB_LINE_VARIANTS` rotates four wordings for each of the three lines, and `fbpVehicleNote()` adds one sentence specific to the vehicle. A line Franco wrote himself is used exactly as typed. Franco: *"gives each add a little bit of indivuality with out over stating anything."*

**Lead-intake mailbox moved to `rollingwithfranco@gmail.com`** — the old `firstfinancialcanada` mailbox was mixing car leads into the SaaS inbox. 2FA + Gmail app password set by Franco, pasted into Railway by him. Verified live: `✅ lead-intake polling every 120s`, zero errors.

**Tekion — dead end, don't rebuild it.** The House of Cars Tekion instance is **theirs**, not ours (1,281 leads, their salespeople), so dealership-wide lead routing isn't Franco's to change. Leads reach him at `ffannin@houseofcars.com` through Outlook and the notification email contains **only a client name and the assigned rep** — nothing to parse, so the ADF/IMAP pipe can't work on it. I proposed an extension capture button; Franco: *"thats to convoluted."* Leads get hand-entered. A reply email to the first lead (Elizabeth Remmers — her 2017 Beetle was already sold) was written and sent 2026-10-07.

## Open — Franco only

| | Item |
|---|---|
| ✅ | ~~**Domain auto-renew**~~ — firstfinancialcanada.com (expires 2026-10-24). Franco set auto-renew ON 2026-09-25. |
| ✅ | ~~**Twilio auto-recharge**~~ — card + auto-recharge set by Franco 2026-09-25. Dead numbers released; bill $4.20 → ~$1.15/mo. |
| ➖ | ~~STC line test~~ — moot, Franco is out at STC and the number is released. |
| 🔴 | **DMARC** — add `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:First@FirstFinancialCanada.com`. SPF and DKIM are already in place. |
| 🔴 | **Rotate `META_APP_SECRET`** — reset in Meta, then paste into Railway immediately; Facebook lead deliveries fail in between. |
| | **Replace-mode inventory sync** still fails (Merge works). Next re-scrape, hit Replace first so the exact Postgres error lands in the logs. |
| ➖ | ~~STC stock 8689645 body style~~ — moot, STC tenant is gone. |
| ✅ | ~~**fintest@fintest.com password reset**~~ — done 2026-09-25; billing overlay driven end-to-end on a real login. |
| ➖ | ~~**Wholesale signage — option A** (paid vision model)~~ — **killed 2026-09-25.** Superseded by the cover-the-sign editor (`public/js/photo-cleaner.js`): drag a box over the sign, box stored as fractions of the image in `photo_edits`, filled with the surrounding colour. Runs in the browser, no API key, no per-photo cost. **Do not re-pitch the vision model.** |
| | **Indeed ad** (commission-only associate) — LIVE 9/22, free 30 days; decide on sponsoring around **2026-10-22**. |
| 🔴 | **Five April SaaS prospects never contacted** — three lapse Oct 14–15 on CASL. The only dated item on this list. |
| | **Stock A05848** — the F-150's stock number is the VIN's last six, invented because none was given. Swap for House of Cars' real one when it is stocked in; photos travel with the vehicle row, not the stock string, so a rename is free. |
| | **Michael Walkey** — his note says 10 years at address, the Canada Drives form says 5. Settle before it goes on an application. |
| | **Nakan** (858) — Franco texting and calling; Tekion holds no vehicle, so it is cold discovery. |
| | **Pick the day the Google Sheet stops being updated.** Leads now live in both; the sheet is only right while someone remembers to type twice. |

## Found by audit 2026-09-22 — your call

- ✅ ~~Spend cap per user~~ — FIXED 2026-09-25 (109cb1b). One allowance per dealership; reconcileSpend was correcting the sender's row too.
- ✅ ~~Lender rate sheets per user~~ — FIXED 2026-09-25 (4e2de6a). Tenant-scoped + manager-gated. Also fixed: the reset route threw ReferenceError, and rate history archived the wrong rows.
- ✅ ~~Customer texts bypassing the opt-out list~~ — FIXED 2026-09-25 (3a499a9). Four paths could text someone who replied STOP; all now go through lib/customer-sms.js, which fails closed. Staff alerts deliberately still uncapped.
- ✅ ~~Unsigned Twilio callbacks~~ — FIXED 2026-09-25 (8f76f79). Both signed; verified live, unsigned POSTs now 403. They feed reconcileSpend, so a forged Price could have inflated a dealer's usage until the cap silenced Sarah.
- ✅ ~~Compare All mileage mismatch~~ — CLOSED 2026-09-25 (f5a490f), and it was not what the audit called it. The per-tier `maxMile` strings in the CLIENT lender table are never rendered by anything — the lender table draws the lender-level `maxMileage`, tier cards draw only tier/rate/fico/maxLtv. Only the SERVER reads per-tier maxMile. So the two sides could not conflict on that field and no user ever saw 140,000. `npm run check-lenders` now compares only fields both sides consume and passes clean across 12 lenders. **The real point (Franco):** lender criteria "constantly change as new and updated rate sheets are provided by the lenders" — so these hardcoded tables are only a FALLBACK. An uploaded sheet already overrides the engine (`getQualifyingProgram` tries tenant rates first) and the display (★ badge). Keeping current is the upload's job.
- ✅ ~~Bulk send not crash-safe~~ — FIXED 2026-09-25 (bda55cd). Worse than described: setInterval doesn't await, so a slow batch put two runs in flight and double-texted with no crash involved. Rows are claimed atomically (FOR UPDATE SKIP LOCKED), marked sent before the bookkeeping, and an interrupted row is parked as 'unknown' rather than resent. Also fixed the cooldown path stranding claimed rows and the spend-cap pause missing the in-flight one.
- ✅ ~~No limit on buying Twilio numbers~~ — FIXED 2026-09-25 (0b95c6e). TIER_NUMBER_CAPS 2/5/15, counted from Twilio by friendlyName so it reflects what we're billed. Re-provisioning a number you already hold is never blocked. NOT auto-releasing the replaced number — irreversible, and a customer texting the old line would vanish.
- ⚠ **Stripe upgrade path** — still open, and not fixable from code: needs a live checkout event to confirm whether `session.subscription_data` exists on `checkout.session.completed`.
- ✅ ~~Stale chrome-extension/*.src.js~~ — HANDLED 2026-09-25 (4f406c6). The build now reports how many days behind each one is (155–159). **Memory had this backwards:** the tracked .js files ARE the readable source, not minified builds. Verified no function in any .src.js is missing from its .js, so they're disposable — deleting them is Franco's call, they're untracked local files.

## Shipped Fri 2026-09-25

- **Wholesale sign: covered, not hidden.** Hiding whole photos cost the best angles (the sign sits at the edge of the rear 3/4 and side shots). Click a photo, drag a box over the sign, done — remembered per car forever. Runs in the browser, no API key needed.
- **Billing enforcement**: exempt accounts could not be shut off at all; 11 write routes had no guard; a lapsed account got no overlay and no warning. All closed, plus a reminder in the 7 days *before* payment is due.
- **Four customer texts could reach someone who replied STOP.** All now go through one guard that fails closed.
- **Spend cap** is one allowance per dealership, not per seat. **Lender rate sheets** reach the whole dealership and are manager-gated.
- **Bulk send** can no longer double-text: rows are claimed atomically, and overlapping ticks were the real cause, not crashes.
- **Twilio status callbacks signed**; **number purchases capped** per tier.
- **Wholesale cost could be quoted to a customer** — clicking an inventory row loaded the supplier's price into Selling Price, one click from Present. Fixed, plus a WHOLESALE chip and retail editing in the list.
- **"Dealer Platform" → "Dealer System"** everywhere it is the product's name, including the Terms of Service defined term.
- **Extension download rebuilt** — the served zip was the 09-21 build and was missing the price-parsing fix. Anyone who downloaded it since then should re-download and reload it; Chrome does not auto-update a manually-loaded extension.

## Cleanups from 2026-10-09 — none blocking

- **`desk_inventory.photos` is TEXT while the schema file declares JSONB.** Converting is a migration across 1,389 rows with the poster reading it live — not a mid-session job.
- **37 MB of photos per vehicle** at full phone resolution. Downscaling in the browser before upload is ~400KB a photo with no visible loss at Marketplace sizes. Franco's call to leave it.
- **~465 House of Cars units still untagged** for wholesale — photo host cannot tell them apart.
- **Replace-mode inventory sync still fails.** Next re-scrape, hit Replace FIRST so the Postgres error lands in the logs.
- **Canada Drives → Tekion drops some leads.** Carried Robinson, dropped Walkey. If it recurs, that is their integration ticket.

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
