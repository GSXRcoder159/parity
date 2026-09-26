# Day-1 outreach messages

**Sender:** Adam Kuca, University of Michigan · **Drafted:** 2026-09-25 · **Targets:** rows 1–20 of `cohorts.md` · **Tracker:** `funnel.md`

**The ask (plan §6.2, verbatim):**
> "I'm measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior. Send me your Stripe integration tests or 5 eval scenarios your agent runs. This week I'll run them against the real sandbox and the existing mocks and send you every divergence; from mid-October I'll run them on our twin and send the agreement number within 48 hours."

**Rules applied**
- Body ≤120 words (greeting and sign-off included). Each names one fact about the target, and its source URL is listed under the message.
- "This week" is written as "within a week" so the promise holds whichever day a message goes out.
- For public repos (cohort B) there is nothing to send, so the ask becomes "pick 5 scenarios or point me to your tests".
- If a target touches surface outside twin v0 (§2.1), the twin promise is limited to the in-scope steps.
- **Channels:** email, X DM, GitHub Discussion, or the company's own contact form where it has no public email. Bookface is not used because it needs a YC founder account. X DMs can be closed to non-followers; each X message lists a fallback. The subject line doubles as the first line of an X DM.
- Before sending, open the source URL once more. Pages change.

---

## 1. Autumn (channel)

**Channel:** email hey@useautumn.com; post the same text in the Autumn Discord (https://discord.gg/53emPtY9tA)
**Subject:** PR #3491 and a Stripe twin for Autumn's tests

> Hi Ayush and John,
>
> Autumn PR #3491 describes a sandbox customer over-invoiced by about $1.7k after a 429 rate_limit and a replayed lock_timeout, and #3585 paces sandbox calls to 5 req/s of 25. I'm Adam Kuca (University of Michigan), building ParityBench, an open harness that scores Stripe mocks against the real sandbox, plus an open-source stateful Billing twin it scores nightly.
>
> Two asks. Point me at your Stripe billing tests: within a week I'll run them against the sandbox and existing mocks and send every divergence. And once the twin's number is public in mid-October, would you consider an integration PR running Autumn's tests against it, or a joint post on the results?
>
> Adam Kuca, University of Michigan

Sources: https://github.com/useautumn/autumn/pull/3491 · https://github.com/useautumn/autumn/pull/3585

## 2. LedgerUp

**Channel:** email founders@ledgerup.ai
**Subject:** Testing Ari's Stripe subscription + invoice step against real Stripe

> Hi Bailey,
>
> Your homepage shows Ari creating a Stripe subscription and invoice right after DocuSign contract terms are extracted. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 eval scenarios Ari runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.ledgerup.ai/ ("Stripe Subscription + invoice created")

## 3. Parahelp

**Channel:** X DM to @ankerbachryhl (fallback: @MadsLunau, then the demo link https://cal.com/mads/parahelp-demo)
**Subject:** Parahelp's Stripe refund actions vs real Stripe

> Hi Anker,
>
> Your YC page says teams can "connect Stripe so your agent can resolve billing questions and refund requests." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 eval scenarios your agent runs? A refund request is a good one. Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.ycombinator.com/companies/parahelp

## 4. Fini

**Channel:** "Get in touch" form, usefini.com/company/contact (attn Deepak Singla, Hakim K)
**Subject:** Fini's stripe.refunds.create path vs real Stripe

> Hi Deepak and Hakim,
>
> Your homepage demo resolves a duplicate charge with stripe.customers.search, stripe.charges.list and stripe.refunds.create. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 eval scenarios your agent runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.usefini.com/

## 5. Duckie

**Channel:** email founders@duckie.ai
**Subject:** Duckie's "update it in Stripe" workflows vs real Stripe

> Hi Joel and Valerie,
>
> Your homepage example tells the agent: "When a customer asks to change their plan, update it in Stripe and confirm with them once it's done." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior, plan changes included.
>
> Could you send your Stripe integration tests, or 5 eval scenarios your agents run? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://duckie.ai/

## 6. FlyCode

**Channel:** email hello@flycode.com
**Subject:** Backup-card recovery before cancellation, tested against real Stripe

> Hi Etai, Jake and Tzachi,
>
> Your YC launch says FlyCode "automatically attempts payment recovery using backup cards during that 30-day window, before the subscription gets cancelled." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior on paths like that one.
>
> Could you send your Stripe integration tests, or 5 recovery scenarios your product runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.ycombinator.com/companies/flycode

## 7. Fazeshift

**Channel:** email sales@fazeshift.com (attn Caitlin Leksana, Timmy Galvin)
**Subject:** Contract-to-Stripe subscription writes, tested against real Stripe

> Hi Caitlin and Timmy,
>
> Your product page says the billing agent will "turn sales contracts into subscriptions or invoices within your billing systems, including Stripe". I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 contract-to-Stripe scenarios your agent runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.fazeshift.com/product

## 8. Speakeasy (speakeasy-api/gram)

**Channel:** GitHub Discussion on speakeasy-api/gram (fallback: team@speakeasy.com)
**Subject:** Scripting the Stripe M3 sandbox runbook as a divergence check

> Hi Gram team,
>
> Your runbook validates PAYG conversion, metering, invoice allocation and subscription loss in a Stripe sandbox by hand, and says "Run it twice from a clean test clock." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> The runbook is public, so there is nothing to send unless you have other Stripe tests. Within a week I'll script its Stripe calls, run them against the real sandbox and the existing mocks (stripe-mock, localstripe), and send you every divergence. From mid-October I'll run the subscription and invoice steps on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://github.com/speakeasy-api/gram/blob/bcc995244dd613369e92c5a91a8960251b8a1b41/docs/runbooks/stripe-m3-sandbox-validation.md

## 9. Butter Payments

**Channel:** X DM to @ButterPayments (fallback: contact on butterpayments.com)
**Subject:** Butter's end-of-dunning cancel vs real Stripe

> Hi Butter team,
>
> Your Stripe Billing docs say that at the end of the dunning cycle "Butter will cancel the subscription, triggering the customer.subscription.deleted webhook in Stripe." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior, including which events fire.
>
> Could you send your Stripe integration tests, or 5 dunning scenarios your product runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://docs.services.butterpayments.com/stripe-billing

## 10. Macha

**Channel:** demo/contact form on getmacha.com
**Subject:** Macha's Create Refund action vs real Stripe

> Hi Macha team,
>
> Your blog says the agent issues a refund itself "for narrow cases like a confirmed duplicate charge", through a Create Refund action that "issues a full or partial refund on a completed payment." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 eval scenarios your agent runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.getmacha.com/blog/handling-subscription-billing-questions-stripe-connected-agent

## 11. LiveX AI

**Channel:** X DM to @LiveX_ai (fallback: https://livex.ai/contact-us)
**Subject:** LiveX plan changes in customers' Stripe accounts vs real Stripe

> Hi LiveX team,
>
> Stripe's case study says your agents use the Stripe agent toolkit to "negotiate offers, apply discounts, and resolve customer issues automatically" in customers' Stripe accounts. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 eval scenarios your agents run? A mid-cycle plan change is a good one. Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run the plan-change and refund steps on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://stripe.com/customers/livex-ai

## 12. Unkey (unkeyed/unkey)

**Channel:** GitHub Discussion on unkeyed/unkey (fallback: support@unkey.com)
**Subject:** verify-compute-checkout.ts: real Stripe vs mocks

> Hi Unkey team,
>
> verify-compute-checkout.ts creates a fresh test clock per plan "so the created subscription is isolated and time-travelable." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> The script is public, so the ask is small: tell me which 5 billing scenarios matter most, or point me to your Stripe tests. Within a week I'll run them against the real sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run the subscription and test-clock steps on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://github.com/unkeyed/unkey/blob/a2ce9d0ba96d416b7adbe3f6bb419e6e3b8d1705/web/apps/dashboard/scripts/verify-compute-checkout.ts

## 13. elizaOS (elizaOS/eliza)

**Channel:** GitHub Discussion on elizaOS/eliza (fallback: inquiries@elizalabs.ai)
**Subject:** certify-generic-billing-stripe.ts: real Stripe vs mocks

> Hi elizaOS team,
>
> certify-generic-billing-stripe.ts creates a Stripe test clock and advances it past trial end to certify cloud billing. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> The script is public, so the ask is small: tell me which 5 billing scenarios matter most, or point me to your Stripe tests. Within a week I'll run them against the real sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://github.com/elizaOS/eliza/blob/6b29fba8fc62774bb14b52be774725778b7f3164/packages/cloud/scripts/shared/certify-generic-billing-stripe.ts

## 14. Chobble Tickets (chobbledotcom/tickets)

**Channel:** email hello@chobble.com (attn Stefan Burke)
**Subject:** stripe-mock in your CI: #2225 and #2296

> Hi Stefan,
>
> Issues #2225 (a merge-queue run hung for an hour with nc decoys alive) and #2296 (two tests receiving the same port) both surface in your stripe-mock lifecycle tests. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe behavior.
>
> Your suite is public, so the ask is small: which 5 payment or refund scenarios matter most? Within a week I'll run them against the real Stripe sandbox and stripe-mock and send you every divergence. From mid-October I'll run the in-scope steps on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Sources: https://github.com/chobbledotcom/tickets/issues/2225 · https://github.com/chobbledotcom/tickets/issues/2296

## 15. Okou (okou-ai/okou)

**Channel:** email contact@okou.ai
**Subject:** Your deploy-stripe-listener CI job

> Hi Okou team,
>
> Your turbo.yml has a deploy-stripe-listener job that starts a Stripe CLI listener on a metal host for every PR preview. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior, webhooks included.
>
> Could you send your Stripe integration tests, or 5 billing scenarios your previews exercise? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://github.com/okou-ai/okou/blob/c1469bbd47aeea42ceaedc53c270923a82e46f16/.github/workflows/turbo.yml

## 16. Decagon

**Channel:** email support@decagon.ai, asking for it to be forwarded to Gram Liu (low reach; no direct route found)
**Subject:** For Gram Liu: Decagon's Stripe subscription and refund actions vs real Stripe

> Hi Gram (via support; please forward),
>
> Stripe's case study describes Decagon agents that help customers "manage their subscriptions, access invoices, deliver refunds, and more," and quotes you on the subscription lookups. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 eval scenarios your agents run? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://stripe.com/customers/decagon

## 17. Dimely

**Channel:** X DM to @UseDimely (fallback: founders' LinkedIn, linkedin.com/in/davidnpang)
**Subject:** Dimely's contract-to-Stripe sync vs real Stripe

> Hi David and Peter,
>
> Your YC page says Dimely's agents extract terms from Order Forms, MSAs and POs and "sync this information to core finance systems like NetSuite and Stripe." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 contract-to-Stripe scenarios your agents run? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.ycombinator.com/companies/dimely

## 18. Alguna

**Channel:** email founders@alguna.io
**Subject:** Alguna's Stripe Invoicing path vs real Stripe

> Hi Aleks and Jamie,
>
> Your YC page says customers can bill "directly via Alguna or ERP tools of your choice (Stripe Invoicing, Netsuite, Xero, Quickbooks, Bill)." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior, invoices included.
>
> Could you send your Stripe integration tests, or 5 quote-to-Stripe scenarios your product runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.ycombinator.com/companies/alguna

## 19. Chipp

**Channel:** Contact Sales form linked from https://chipp.ai/integrations/stripe
**Subject:** Chipp's Stripe refunds and plan changes vs real Stripe

> Hi Chipp team,
>
> Your Stripe integration page says the AI can "take actions like refunds and plan changes," within refund limits and approval workflows the merchant controls. I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 eval scenarios your agents run? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://chipp.ai/integrations/stripe

## 20. JustPaid

**Channel:** email sales@justpaid.ai (attn Daniel Kivatinos; fallback X DM @danielkivatinos)
**Subject:** JustPaid's Stripe payment matching vs real Stripe

> Hi Daniel,
>
> Your homepage says JustPaid will "automatically match payments from Stripe, bank accounts, and QuickBooks to invoices." I'm Adam Kuca (University of Michigan), measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior.
>
> Could you send your Stripe integration tests, or 5 Stripe sync scenarios your product runs? Within a week I'll run them against the real Stripe sandbox and the existing mocks (stripe-mock, localstripe) and send you every divergence. From mid-October I'll run them on our open-source twin and send the agreement number within 48 hours.
>
> Adam Kuca, University of Michigan

Source: https://www.justpaid.ai/

---

## Follow-up cadence (template)

Send in the same thread and channel. Stop on any reply, including a "no". Three follow-ups at most, then mark the row `closed – no reply` in `funnel.md`.

**F1, day 3 after the first message: one concrete divergence**
> Hi {name}, a small example of what the report looks like: stripe-mock v0.204.0 (released 2026-09-24) returns 400 for `payment_method_types` on PaymentIntents and SetupIntents, v0.203.0 returned 200, and the reporter notes real Stripe still accepts it (stripe/stripe-mock#1648). That is the kind of divergence I'd send you for your own {refund/subscription} calls. The offer from my first note stands. Adam

Source: https://github.com/stripe/stripe-mock/issues/1648 . Before sending, check whether a later stripe-mock release fixed it (v0.205.0 shipped 2026-09-25); if it did, say so in the message.

**F2, day 7: a number, only once one exists**
> Hi {name}, first numbers from the harness: {N} Billing sequences run against the real sandbox; the sandbox disagrees with itself on {noise floor}% of them after normalization, and {mock} disagrees with it on {X}%. Method and seeds: {link}. Five of your scenarios would show you the same numbers for your own calls. Adam

Fill every `{}` from a real run (W1 noise floor, plan §3). Do not send F2 with placeholders or estimates. If no number exists by day 7, skip to F3.

**F3, day 14: close the loop with the trigger question**
> Hi {name}, last note from me. If Stripe testing isn't a problem for you, one line would still help: when a Stripe test last cost you time, was it 429s, shared-state flakiness, a wrong refund in prod, or "how do you test this?" Thanks, Adam

## Trigger question (plan §6.3)

Plan text, verbatim: "Ask every installer the trigger question: 429s, shared-state flakiness, wrong refund in prod, or "how do you test this?""

As asked on a call or in F3:
> "When a Stripe test last cost you time, what was it: 429s, shared-state flakiness, a wrong refund in prod, or 'how do you test this?'"

Log the answer word for word in the `trigger answer` column of `funnel.md`.

## Follow-up with numbers (gated)

> **DRAFT — not for publication before the launch gate (docs/plan/STATUS.md). GATED: do not send before B5, counsel review (decision 0001 C7), clears sharing these numbers.**

A second touch for a target who has not replied. Once B5 clears, it takes F2's place in the cadence above: day 7, same thread and channel, same stop rules. Until then F2 stays unsent, even though a number now exists.

> Hi {name}, one number since my first note. I ran 88 Billing sequences from 26 templates (proration, cancellation, refunds, error paths, idempotency, among others) against the real Stripe sandbox and the two open mocks. Sequence-level agreement was 0% for both: stripe-mock 0.205.0 on all 88, localstripe 1.15.10 on the 20 inside its surface. That is as documented: its README says stripe-mock is stateless. The sandbox agreed with itself on 60 of 60 repeated sequences. Method and rerun steps: {{TBD: public report URL, after the launch gate}}. The offer stands: send your tests or 5 scenarios, run on a sandbox key of your own, and within a week you get every divergence on your calls. Adam

Source: `reports/2026-09-26-baseline.md` (H1 verdict: stripe-mock 0.0% [0.0–4.2] over 88 sequences, localstripe 0.0% [0.0–16.1] over 20; sandbox against itself 100.0% [94.0–100.0] over 60 pairs).

Before sending:
- The numbers come from oracle v0 (88 of 520 planned sequences). If a later report replaces it, take the numbers from that report.
- Fill the URL from the public report. If there is none, do not send (the F2 rule: no placeholders).
