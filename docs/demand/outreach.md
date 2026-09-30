# Outreach, round 1

**Sender:** Adam · **Rewritten:** 2026-09-30 · **Targets:** `cohorts.md` rows 1–20 · **Tracker:** `funnel.md`

## How to use this

1. Send top to bottom: best fit first. Use the one channel on each Channel line (the fallback is only for a bounce or a closed DM). Never pitch in a GitHub Issue or Discussion.
2. On the day you send, reopen the "Why this hook" link. If the detail has changed, fix the message or skip the target.
3. Each message is written for one reader. Don't copy a sentence from one into another.
4. Email follow-ups go in the same thread on day 4 and day 10; X DMs get one nudge between day 5 and day 7. Stop at any reply, including a no. After the last follow-up, mark the row closed in `funnel.md`.
5. Log each send date and reply in `funnel.md`, and copy any answer about what their billing tests cost them word for word into the "trigger answer" column.
6. Anything you offer after a yes must fit decision 0001 C8: their tests never run on your Stripe account or key (see "After a yes").
7. No score, rate, count or timing for Parity, stripe-mock or any other tool goes out before B5, including `partner-offer.md` "Measured so far". Describing a behaviour, like FlyCode's fixed two-day retry, is fine.
8. There's nothing public to link: the repo is private and the package isn't on npm. If someone asks to see it, offer to add them to the private repo. Whether a short unlisted screen recording counts as public release under B5 is your call.
9. Your signature carries "University of Michigan". Each body has one short line on who's writing, worded differently each time.

---

## 1. Autumn (cohorts #1)

**Channel:** email hey@useautumn.com, for Ayush and John (fallback: the Autumn Discord, https://discord.gg/53emPtY9tA)
**Subject:** billing tests at Autumn

> Hi Ayush and John,
>
> I'm Adam, at Michigan. Owen's write-up in #3491 taught me that Stripe can replay a cached lock_timeout under the same idempotency key.
>
> His test drives a draft invoice through a sandbox clock. I've been building a local Stripe Billing server with its own clocks, so a renewal can happen in a test without a sandbox. It has no invoice items yet, so his test itself wouldn't run.
>
> Does a test like his run on every PR, or only by hand?
>
> Adam

Why this hook: https://github.com/useautumn/autumn/pull/3491 (merged 2026-09-18, author og2701, "Owen"; its Tests section: "real draft cycle invoice via test clock", "Passed on a dw stack"). The handler it fixes calls `invoices.addLines` and creates invoice items, which the server answers 404, hence the caveat.

## 2. Chobble Tickets (cohorts #14)

**Channel:** email hello@chobble.com, for Stefan Burke
**Subject:** why stripe-mock?

> Hi Stefan,
>
> It's early and it's just me, but I've built a Stripe server that remembers state and runs next to your tests. Your #2225 and #2296, the hung merge-queue run and the two tests handed one port, are what I'd like it to avoid. Each test can start its own copy on port 0 and ask which port it got.
>
> What made you keep stripe-mock for the main suite instead of the sandbox? Even a one-line answer would help me.
>
> Adam

Why this hook: https://github.com/chobbledotcom/tickets/issues/2225 · https://github.com/chobbledotcom/tickets/issues/2296 (both open, last updated 2026-08-29 and 2026-09-07). Port 0: `listen(port = 0)` in `src/twin/server.ts`. No coverage claim on purpose: `src/shared/stripe/client.ts` calls Checkout Sessions and `/v1/balance` (both 404 on the server) and refunds payment intents that Checkout creates.

## 3. Okou (cohorts #15)

**Channel:** email contact@okou.ai, for Ethan Zhang
**Subject:** the Stripe listener in PR previews

> Hi Ethan,
>
> In turbo.yml, deploy-stripe-listener exists just to get Stripe webhooks to PR previews. I'm at Michigan, working on a stand-in for Stripe Billing that signs and sends its own webhooks, retries included. If a preview's Stripe client pointed at it, there'd be no listener in between.
>
> Has that listener ever been the reason a preview's payment test failed, or does it just quietly work?
>
> Adam

Why this hook: https://github.com/okou-ai/okou/blob/main/.github/workflows/turbo.yml (job `deploy-stripe-listener`: "Runs in parallel with deploy-api whenever a deployed E2E consumer may exercise a payment flow", rechecked 2026-09-30). Leave #37324/#37313 (the stale-webhook race) for a reply: the server can't promise to reproduce it.

## 4. Duckie (cohorts #5)

**Channel:** email founders@duckie.ai, for Joel
**Subject:** testing plan changes in Stripe

> Hi Joel,
>
> The example on your homepage, "When a customer asks to change their plan, update it in Stripe and confirm with them once it's done," is what I'm trying to make testable. It's just me so far, but I've built a fake Stripe your agent can change plans on as many times as it likes. Each eval starts from an empty account, and afterwards you can read back the subscription and its proration.
>
> When a Duckie agent changes a plan, what do your evals check?
>
> Adam

Why this hook: https://duckie.ai/ (quote rechecked 2026-09-30)

## 5. Fini (cohorts #4)

**Channel:** "Get in touch" form, https://www.usefini.com/company/contact (check the form's fields before pasting). Deepak Singla and Hakim K are named on https://www.ycombinator.com/companies/fini, but no personal route is verified, so the form stays the channel.
**Subject:** your duplicate-charge demo

> Hi Deepak and Hakim,
>
> In the duplicate-charge demo on your homepage, Fini finds the second charge and refunds it. The case I keep coming back to is the customer who really did buy twice.
>
> At Michigan I've been building a local Stripe for testing agents. You seed a customer with both charges, and after the agent runs you can read back whether anything got refunded.
>
> Would it help if I wrote both versions of your demo as tests and showed you them running?
>
> Adam

Why this hook: https://www.usefini.com/ ("stripe.customers.search 200 OK stripe.charges.list 200 OK stripe.refunds.create refunded"; "Fini hits your Stripe, finds the duplicate charge, and refunds- with a full audit trail", rechecked 2026-09-30). All three calls are served, and `/_parity/seed` can set up both charges.

## 6. Parahelp (cohorts #3)

**Channel:** X DM @ankerbachryhl (fallback: @MadsLunau)

> Hi Anker, how do you test Parahelp's refund path before it runs on a real customer's Stripe? I've been working alone on a fake Stripe for agent evals: every run gets a fresh account, and your checker can see exactly what was refunded. I'm trying to learn how teams handle this now.

Why this hook: https://www.ycombinator.com/companies/parahelp ("you can connect Stripe so your agent can resolve billing questions and refund requests", rechecked 2026-09-30)

## 7. LedgerUp (cohorts #2)

**Channel:** email founders@ledgerup.ai, for Bailey
**Subject:** testing the Stripe step after DocuSign

> Hi Bailey,
>
> I'm working on a local copy of the Stripe billing API, still early, and the step on your homepage where Ari turns DocuSign terms into a Stripe subscription and invoice is the flow I most want it to handle. A test can add seats to a 40-seat subscription mid-term and then check the invoice that comes out. Backdated starts aren't in yet.
>
> Want me to make up a contract like the ones Ari handles and send you that test running?
>
> Adam

Why this hook: https://www.ledgerup.ai/ (steps 02 and 03, rechecked 2026-09-30). Seats, not start dates: a backdated start or a custom anchor answers `not_implemented`. Don't lead with the compare page's "posts to Stripe": that line is about usage metering, which Parity doesn't cover.

## 8. Fazeshift (cohorts #7)

**Channel:** email sales@fazeshift.com, for Timmy Galvin
**Subject:** contracts into Stripe subscriptions

> Hi Timmy,
>
> Sending this to the sales inbox since it's the only address I could find. My name's Adam, and I'm building a stand-in for the Stripe billing API that runs in CI, so contract-to-subscription code can be tested without a sandbox. Every night its answers are checked against a real Stripe sandbox.
>
> When Fazeshift writes a contract into Stripe, is that step covered by automated tests?
>
> Adam

Why this hook: https://www.fazeshift.com/product ("Turn sales contracts into subscriptions or invoices within your billing systems, including Stripe, NetSuite, and Sage Intacct.", rechecked 2026-09-30). No mid-month example: a custom anchor or backdated start answers `not_implemented`.

## 9. FlyCode (cohorts #6)

**Channel:** email hello@flycode.com, for Jake Vacovec
**Subject:** testing backup-card recovery

> Hi Jake,
>
> Over the past week I've been building a local Stripe Billing server, test clocks included. Recovery like FlyCode's, retrying a backup card in the 30 days before cancellation, is what I want it to get right. A renewal can decline and retry in a test without waiting on a sandbox clock. Two gaps: retries run on a fixed two-day schedule, and it can't yet pay an invoice with a chosen card.
>
> How do you test the backup-card retry today, before it runs on a merchant's account?
>
> Adam

Why this hook: https://www.ycombinator.com/companies/flycode ("FlyCode automatically attempts payment recovery using backup cards during that 30-day window, before the subscription gets cancelled.", rechecked 2026-09-30; the launch post shows no date, so the message doesn't cite it). Gaps: README clock row ("a fixed 2-day payment retry"); invoice pay takes only `expand` and `paid_out_of_band`.

## 10. Butter Payments (cohorts #9)

**Channel:** X DM @ButterPayments (fallback: contact form on butterpayments.com)

> Hi, I'm Adam. I'm building a local Stripe for tests that sends signed webhooks, and I'd like to try it on a flow like the end of Butter's dunning cycle, where the subscription is cancelled and customer.subscription.deleted fires. Who on your side owns the Stripe integration?

Why this hook: https://docs.services.butterpayments.com/stripe-billing ("At the end of the dunning cycle, Butter will cancel the subscription, triggering the customer.subscription.deleted webhook in Stripe.", rechecked 2026-09-30)

## 11. Speakeasy, Gram (cohorts #8)

**Channel:** email team@speakeasy.com, for Alex Martin (his GitHub profile names no employer; #6401 links Speakeasy's Linear issue GRW-90)
**Subject:** billing tests in Gram

> Hi Alex,
>
> Your #6401 took most of the fiddliness out of local billing. M3 still needs the sandbox, run twice from a clean test clock.
>
> I've been building a Stripe Billing server you launch alongside your tests, clocks included, so there's no CLI or sandbox to set up. It's a solo project, and it has no Checkout or meters yet, so M3 itself is out of reach.
>
> Is running M3 by hand a real cost, or rare enough not to matter?
>
> Adam

Why this hook: https://github.com/speakeasy-api/gram/pull/6401 (merged 2026-09-16, author alx-xo, Alex Martin) · runbook: https://github.com/speakeasy-api/gram/blob/main/docs/runbooks/stripe-m3-sandbox-validation.md ("Run it twice from a clean test clock."). M3 starts with PAYG Checkout, anchors at the next 00:00Z and holds a metered draft, so none of it runs on the server yet. Sent late for that reason.

## 12. Dimely (cohorts #17)

**Channel:** X DM @davidnpang (fallback: @UseDimely)

> Hi David. When Dimely's agents sync contract terms into Stripe, what do you test that sync against? I'm Adam, building a test double for Stripe Billing at Michigan, and looking for real flows to try it on.

Why this hook: https://www.ycombinator.com/companies/dimely ("sync this information to core finance systems like NetSuite and Stripe", rechecked 2026-09-30)

## 13. Macha (cohorts #10)

**Channel:** demo/contact form on getmacha.com (no named person found, so it goes late)
**Subject:** testing Cancel Subscription and Create Refund

> Hi,
>
> Of the ten Stripe tools in your multi-instance connectors post, Cancel Subscription and Create Refund are the two that change what a customer pays. I'm building a fake Stripe, on my own for now, to test exactly those. An agent cancels and refunds against it, and the test reads back what actually changed in the account.
>
> Who looks after the Stripe connector at Macha?
>
> Adam

Why this hook: https://www.getmacha.com/blog/multi-instance-connectors-connect-two-zendesks-three-stripes (lists all ten tools, rechecked 2026-09-30)

## 14. Chipp (cohorts #19)

**Channel:** Contact Sales form linked from https://chipp.ai/integrations/stripe (no named person found, so it goes last)
**Subject:** testing refund limits

> Hi,
>
> On your Stripe page, merchants set refund limits and approval workflows for what the AI can do. I'm Adam. I'm working on a local Stripe that agents can be tested against, and limits like those are what I'd want a test to prove: a refund over the cap stops, and one under it lands in the account.
>
> How do you check those limits hold before a release?
>
> Adam

Why this hook: https://chipp.ai/integrations/stripe ("You control what actions the AI can take, including refund limits and approval workflows.", rechecked 2026-09-30). Don't use the Stripe customer story: it is about usage-based billing, which Parity doesn't cover.

## Not sending this round

- **Decagon (cohorts #16):** there's no route to Gram Liu, and a support inbox is the wrong door. Send only if someone can introduce you.
- **JustPaid (cohorts #20):** its pages describe matching Stripe payments to invoices, which is reading. Nothing public shows it writing to Stripe.
- **Unkey (cohorts #12):** the hook, https://github.com/unkeyed/unkey/blob/main/web/apps/dashboard/scripts/verify-compute-checkout.ts, needs Checkout, meter prices, a day-1 timestamp anchor and prices found by `lookup_keys`. The server lacks the first three and ignores `lookup_keys` (a 200 with every price), so a run could look right and be wrong. Send when the anchor lands and `lookup_keys` is applied or refused, open with the script's day-1 question and its result, and use support@unkey.com, not the personal address.
- **elizaOS (cohorts #13):** https://github.com/elizaOS/eliza/blob/develop/packages/cloud/scripts/shared/certify-generic-billing-stripe.ts checks that a no-card trial pauses. Its subscription sets `trial_end` with a pause end-behaviour (`generic-billing-provider.ts` ~L1230), which answers `not_implemented`, and it calls `balance.retrieve`, which 404s. When it can run, describe #32910 as writing the Plus/Pro and pay-as-you-go pricing policy into code (the subscriptions came from #32838/#32854), and try the X DM @shawmakesmagic first.
- **LiveX AI (cohorts #11):** https://stripe.com/customers/livex-ai is about agents that "negotiate offers, apply discounts". Discounts answer `not_implemented`. Send when they land, and lead with them.
- **Alguna (cohorts #18):** Stripe Invoicing means creating invoices and invoice items directly (https://www.ycombinator.com/companies/alguna). The server only has invoices that subscriptions create; `POST /v1/invoices` and `/v1/invoiceitems` 404. Send when invoice creation exists.

---

## Follow-ups

Same thread and channel. Replace `{name}` in the day-10 email before sending.

**Email, day 4**

- Autumn:
  > Hi Ayush and John, quick nudge. Even "we only run it by hand" is a useful answer. Adam
- Okou:
  > Hi Ethan, quick nudge. Even "the listener just works" is a useful answer. Adam
- Speakeasy:
  > Hi Alex, one thing I should have said: M3's 00:00Z anchor is the kind of parameter the server refuses with not_implemented instead of faking an answer. Adam
- Chobble:
  > Hi Stefan, quick nudge. Even a one-line answer on why stripe-mock over the sandbox would help me a lot. Adam
- Duckie:
  > Hi Joel, if it's useful, I can write a mid-cycle plan change, with the proration checked, as a test against it and send you what happens. No call needed. Adam
- Fazeshift:
  > Hi Timmy, if it's useful, I can write a signed contract becoming a Stripe subscription as a test against it and send you what happens. No call needed. Adam
- FlyCode:
  > Hi Jake, quick nudge. Even a one-line answer on how you test that retry today would help. Adam
- LedgerUp (the first message already offers the test):
  > Hi Bailey, one more detail: after a run you can read back the whole account, so a test can check each invoice line Ari's step produced. Adam

**Email, day 10 (all)**

> Hi {name}, I'll stop here. If testing the Stripe side isn't a headache for you, a quick no helps me too. If it is, what broke the last time? Adam

**X DMs (Parahelp, Butter, Dimely): one nudge, day 5 to 7**

> Also: there's nothing new to wire up. Your existing Stripe SDK talks to it once you change the host.

**Contact forms (Fini, Macha, Chipp)**

Forms have no thread. If the form sent a confirmation email, reply there once on day 7; otherwise don't resubmit. Mark the row closed on day 14.

> Hi, I wrote through your contact form last week about testing the Stripe side of {flow}. If it landed in the wrong inbox, could you pass it to whoever owns that integration? Adam

`{flow}`: Fini "your duplicate-charge refund", Macha "Cancel Subscription and Create Refund", Chipp "your refund limits".

---

## After a yes

Send this, trimmed to fit the thread. It keeps decision 0001 C8: Parity runs on your machine with no Stripe account, and the real side always runs on theirs.

> Great, thanks. Here's how it would work:
>
> 1. Send me billing tests you already have, or describe five cases in a sentence each ("customer upgrades mid-cycle, then asks for a refund"). I'll write them up and show you before running anything.
> 2. I run them on Parity on my machine. You run the same tests against your own sandbox and send me the pass/fail list.
> 3. Within 48 hours you get a table of where the two sides differ.
>
> Nothing about you or your tests gets published without your written OK.

Once they send tests, say that their Stripe client needs a configurable host (most SDKs have one).

If they'd rather not run their side: they create a throwaway sandbox in their own account (an account can hold up to five) and share a restricted test key through a secret-sharing tool, not email or chat (https://docs.stripe.com/keys-best-practices). They delete the sandbox afterward. Never your key. Run `paritybench agree` from a directory with no `.env` (the CLI loads `./.env`, which holds your key) with their key in `STRIPE_API_KEY`, and set `PARITY_DATA_DIR` outside any git repository. Decision 0001 "Revisit if" lists running ParityBench for a partner, so confirm C8 is the only condition before the first run.

Don't forward `partner-offer.md` "What you get" as it stands: it still promises runs against stripe-mock and localstripe (C5) and a "mid-October" date.

## Held until B5

The agent result is the most relevant number for agent teams, and it can't go out yet: `partner-offer.md` gates everything in "Measured so far" on B5. Whether a one-to-one email counts as public release is your call, not this file's. If it clears, this is the wording, and the caveats travel with it:

> I had an AI agent do 80 everyday billing-support jobs (refunds, cancellations, upgrades, seat changes, switching to annual) on Parity and again on a real Stripe sandbox. In 79 of the 80 it succeeded or failed the same way on both. That's pass/fail only. The response bodies still differ a lot, and the server is checked against a real sandbox every night to close that gap.

Source: `reports/2026-09-30-h4-v2.md` (79/80, 95% interval 93.3–99.8%). The previous run scored 75/80, and the jump came from a change to the agent's tools, not the server. On the same day, responses matched field for field on 39% of calls in scenarios the server was never tuned on, and 0 of 120 of those multi-step scenarios matched end to end (`site/data/curve.json`).

## Editor notes

- Held Unkey, elizaOS, LiveX and Alguna: each hook needs something the server refuses or 404s (see "Not sending this round"). Facts beat the rewrite suggestions there.
- Autumn: I didn't run their test-clock tests (they need Autumn's stack, and #3491's handler uses invoice items, which 404), so there's no "here's what broke" offer.
- The "not implemented instead of a guess" line is narrowed to subscription parameters: `GET /v1/prices` ignores `lookup_keys` and returns 200. Make list routes refuse filters they don't apply before claiming it broadly.
- `funnel.md` was not edited: its send order ("Send Nth"), the four held rows, and the Autumn and Speakeasy "Ask" notes are now stale.
