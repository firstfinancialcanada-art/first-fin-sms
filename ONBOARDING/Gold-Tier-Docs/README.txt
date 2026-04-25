First Fin — Gold Tier Documentation
====================================

Three docs in this folder, all readable in any browser:

  01 — Sarah Messaging Usage.html
       Plain-English breakdown of how the included monthly messaging
       allowance works, top-up options, and what a "typical conversation"
       uses. INTENTIONALLY does not name the $18.50/mo dollar credit
       value — customers should think of it as an "allowance" not a
       precise budget they can do math against. Internal value is
       \$18.50/mo (1850 cents in lib/constants.js TENANT_CAPS).

  02 — Hunt Chrysler Onboarding Runbook.html
       Step-by-step walkthrough for getting a new Gold-tier dealership
       live. Includes pre-call setup, demo-call script, post-call
       follow-up, and escalation contacts. Customizable for any new
       dealer — Hunt Chrysler details are placeholders.

  03 — How First Fin Works (No Secret Sauce).html
       Plain-English feature guide covering all 5 Gold-tier features,
       branding/watermarking, data ownership, and multi-tenant isolation.
       Hand to dealership owners during the sales conversation.


WHO GETS WHICH DOC
==================

Sales prospect (pre-purchase):
  - 03 — How First Fin Works
  Helps them understand exactly what they're buying. No surprises later.

Newly-paid Gold-tier owner (post-purchase, pre-onboarding):
  - 01 — Sarah Messaging Costs
  - 03 — How First Fin Works
  Sets cost expectations and explains the platform. Read these before
  the kickoff call.

Internal use (you, during onboarding):
  - 02 — Hunt Chrysler Onboarding Runbook
  Your script. Print it, follow it, customize per dealer.


HOW TO CUSTOMIZE FOR A NEW DEALERSHIP
=====================================

The runbook (02) has Hunt Chrysler details hardcoded as a template.
For each new dealership:

  1. Copy '02 — Hunt Chrysler Onboarding Runbook.html' to
     '02 — {Dealer Name} Onboarding Runbook.html'

  2. Find/replace these strings:
     - "Hunt Chrysler" / "Hunt Chrysler Dodge Jeep Ram"
     - "Mil Radenkovic" / "mil@huntchrysler.com"
     - "huntchrysler.ca"
     - "huntchrysler@firstfinancialcanada.com"
     - "Robbie Hunt" / "robhunt@huntchrysler.com"
     - "Wes Olsen" / "wolsen@huntchrysler.com"
     - "905 area code" / "+19058782580"
     - Demo date

  3. Save. Use during their kickoff call.


First Fin Canada · Gold Tier Onboarding Package · 2026-04-25
