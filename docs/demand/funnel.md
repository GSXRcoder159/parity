# Demand funnel (H3)

**Plan:** §6.3 · **Targets:** `cohorts.md` · **Messages:** `outreach.md` · **Last updated:** 2026-09-30 (round-1 rewrite)

## Summary

| Stage | Now | Target (plan §1 H3, §6.3) |
|---|---|---|
| Targets with a drafted message | 14 (A: 10 · B: 3 · channel: 1); 6 held (Decagon, JustPaid, Unkey, elizaOS, LiveX AI, Alguna; reasons in `outreach.md`) | n/a |
| Asks sent | 0 | all drafted targets, from day 1 (§11 item 6) |
| Replies | 0 | ≥5 by 2026-10-10, else shift to cohort B + Autumn (§10) |
| Conversations | 0 | **≥20** |
| Suites / scenarios received | 0 | ≥1 partner suite by 2026-10-20, else Stripe-gym fallback (§6.4) |
| Divergence reports sent | 0 | not offered this round: runs against stripe-mock or localstripe are a competitor score, held until B5 (decision 0001 C5/C7) |
| Agreement numbers sent | 0 | a pass/fail table within 48 h of receiving a suite and the partner's own sandbox results (`paritybench agree` exists now; C8) |
| CI installs | 0 | **≥5 within 14 days of first contact** |
| LOIs ≥$200/mo (or paying) | 0 | **≥2 by 2026-11-02** |
| GitHub stars, 7 days post-launch | n/a | ≥150 |

**Kill/pivot (H3):** <2 installs by Nov 2 means cohort A is a construct. If cohort B converts, reposition to "stateful Stripe testing for everyone".

**LOI SKU (§6.3):** private alignment to the partner's own call shapes plus `parity agree` running in their CI, $99–$299/mo, delivery from W6. An LOI counts toward the target only at ≥$200/mo.

**Coverage gap:** 14 drafted targets against a 20-conversation goal means even a reply from every one falls short. The next batch comes from `cohorts.md` rows 21–34 (after verification) and the plan §6.1 sources not yet worked: Stripe Discord, r/stripe, Autumn's users.

## Tracker

`#` matches `cohorts.md`; `outreach.md` lists the same targets in send order, each heading giving this number. Date = date the first message was sent. Record every trigger answer verbatim.

| # | date | company | cohort | channel | ask sent | reply | suite received | divergences sent | agreement number sent | install | LOI | trigger answer | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | Autumn | Channel | email hey@useautumn.com (fallback Discord) | draft ready | | | | | | | | Send 1st. Hook: #3491 (merged 2026-09-18, Owen) and #3881 (open, Charlie Lamb). Ask: 15 min on hardest flows to test. |
| 2 | | LedgerUp | A | email founders@ledgerup.ai | draft ready | | | | | | | | Send 11th. Hook: homepage step 03 "Stripe Subscription + invoice created". Compare page's "posts to Stripe" is metering (out of scope), not used. |
| 3 | | Parahelp | A | X DM @ankerbachryhl | draft ready | | | | | | | | Send 9th. Fallback @MadsLunau. |
| 4 | | Fini | A | contact form usefini.com/company/contact | draft ready | | | | | | | | Send 8th. Form fields not retrieved; check before sending. Forms: one follow-up only if a confirmation email gives a thread. |
| 5 | | Duckie | A | email founders@duckie.ai | draft ready | | | | | | | | Send 7th. Hook: homepage plan-change example. |
| 6 | | FlyCode | A | email hello@flycode.com | draft ready | | | | | | | | Send 13th. Addressed to Jake Vacovec. |
| 7 | | Fazeshift | A | email sales@fazeshift.com | draft ready | | | | | | | | Send 12th. Addressed to Timmy Galvin (CTO). $17M Series A reported 2026-05-11 (not used in the message). |
| 8 | | Speakeasy (gram) | B | email team@speakeasy.com (for Alex Martin) | draft ready | | | | | | | | Send 2nd. Hook: #6401 (local billing setup pain, merged 2026-09-16). Alex Martin's GitHub lists no employer; #6401 links Speakeasy's Linear. Not a GitHub Discussion. Metering and portal are outside the server. |
| 9 | | Butter Payments | A | X DM @ButterPayments | draft ready | | | | | | | | Send 14th. No named person found. |
| 10 | | Macha | A | demo form getmacha.com | draft ready | | | | | | | | Send 10th. Hook: the ten-tools post (2026-07-29, updated 2026-09-24). |
| 11 | | LiveX AI | A | X DM @LiveX_ai | draft ready | | | | | | | | Send 16th. Discounts are outside the server; the DM asks whether that's what they'd need first. Fallback livex.ai/contact-us. |
| 12 | | Unkey | B | email dave@davehawkins.co | draft ready | | | | | | | | Send 3rd. Address is on Dave Hawkins's own GitHub profile, not Unkey's site. Hook: #7625 (merged 2026-09-29) and the script header (manual aid, kept out of CI). Checkout and a timestamp anchor are outside the server. Fallback support@unkey.com. |
| 13 | | elizaOS | B | email inquiries@elizalabs.ai (for Shaw) | draft ready | | | | | | | | Send 6th. Hook: #32910 (merged 2026-09-28). Fallback X DM @shawmakesmagic. |
| 14 | | Chobble Tickets | B | email hello@chobble.com | draft ready | | | | | | | | Send 5th. Strongest B pain (#2225, #2296, still open). Their client calls Checkout Sessions, which the server doesn't serve; message says so. |
| 15 | | Okou | B | email contact@okou.ai (for Ethan Zhang) | draft ready | | | | | | | | Send 4th. Hook: #37324 (closed unmerged, folded into open #37313), a stale-webhook race. Pain upgraded from cost signal. |
| 16 | | Decagon | A | none | held | | | | | | | | Not sent: no route to Gram Liu; a support inbox is the wrong door. Send only via an introduction. |
| 17 | | Dimely | A | X DM @davidnpang | draft ready | | | | | | | | Send 18th. Fallback @UseDimely. |
| 18 | | Alguna | A | email founders@alguna.io | draft ready | | | | | | | | Send 17th. Addressed to Aleks Đekić. Stripe Invoicing is one of several billing engines. |
| 19 | | Chipp | A | Contact Sales form chipp.ai/integrations/stripe | draft ready | | | | | | | | Send 15th. Lead with refunds and plan changes, not the Stripe customer story (usage billing, out of scope). |
| 20 | | JustPaid | A | none | held | | | | | | | | Not sent: public pages show reconciliation (reads) only; no Stripe write found. |
