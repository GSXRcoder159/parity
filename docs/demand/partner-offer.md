> **DRAFT — not for publication before the launch gate (docs/plan/STATUS.md)**

# Design partner offer

**For:** targets in `cohorts.md` who replied to the day-1 ask in `outreach.md` · **Tracker:** `funnel.md` · **Drafted:** 2026-09-26

Before sending:
- [ ] "Measured so far" is gated on B5, counsel review (decision 0001 C7). Until B5 clears, send the offer without that section.
- [ ] `paritybench agree` has landed (W4, Task 5 in `docs/plan/impl/2026-09-26-w4-surface-agree-wrappers.md`). Until it has, cut the 48 h promise.
- [ ] Re-read each number in its cited report. The twin numbers move with every align run.
- [ ] For partner runs, set `PARITY_DATA_DIR` to a directory outside any git repository. The default is `../parity-data`, a git repo (README, Reproduce).
- [ ] Remove these sender notes, and the "Gated on B5" line, before sending.

---

## What you send

Either of:
- your Stripe integration tests, if the client they use can be pointed at another base URL (most SDKs have a host option), or
- 5 eval scenarios your agent runs, as plain steps ("customer upgrades mid-cycle, then asks for a refund"). I write them as request sequences and show them to you before running them.

For the sandbox half: a Stripe sandbox in your own account (see "What we never do").

## What you get

- **Within a week:** a divergence report. Every call your tests or scenarios make runs on a real Stripe sandbox in your account and on the existing mocks (stripe-mock, localstripe). The report lists every difference in status, shape and value, by JSON path.
- **From mid-October:** the same suite on the Parity twin and on your sandbox, and the `agree` number within 48 h: per-test pass/fail on each, and their agreement with a 95% interval.
- Only calls inside the twin's surface (below) count toward the twin number. The rest are listed as out of scope.

## What we never do

- **Run your workloads on our Stripe account.** Every sandbox run for you uses your account and your key (decision 0001 C8). Either you run the command I send, or you create a sandbox for this (an account can hold up to five, `docs/plan/STATUS.md`), give me its key, and delete the sandbox when we are done.
- **Publish your data.** Not your name, tests, scenarios, call shapes, recordings or results, unless you agree in writing. Recordings stay in a private store, never in a repository, and are deleted when you ask.
- **Patch the public twin from your calls.** With your OK, your call shapes join a private held-out set that the twin is scored on and never repaired against (plan §3.1). The twin's data files are public (decision 0002 §5), so a patch derived from your calls would publish them.

## The twin's v0 surface (plan §2.1)

Test clocks, proration and subscription updates are being added now (W4, `docs/plan/STATUS.md`). Check STATUS.md before sending.

- **Covered:** Customers, PaymentMethods (`pm_card_*` test tokens), Products and Prices, Subscriptions, Invoices (preview, pay, void), Refunds, Charges and PaymentIntents (retrieve only), Events and webhook endpoints, and test clocks. Also idempotency keys and the error envelope.
- **Not covered:** Quotes, Subscription Schedules, Coupons and Promotion codes, Tax, Checkout, Connect, Billing Portal, Meters, Disputes.

## Measured so far

Gated on B5 (see "Before sending"). Intervals are 95% Wilson. Train sequences are the ones the align loop learns from; held-out ones it is never shown. "Sequence agreement" means every step matches the sandbox after normalization and the sequence emits the same event types.

Every number below comes from **oracle v0: 88 sandbox sequences from 26 templates, out of 520 planned.** The rest wait on claiming our sandbox (B1), because the claimable key's quota stopped recording (`reports/2026-09-26-baseline.md`).

- **Existing mocks: 0% sequence agreement.** Source: `reports/2026-09-26-baseline.md`.
  - stripe-mock 0.205.0 (pinned image): 0.0% [0.0–4.2] over 88 sequences. Its status codes match on 80.9% of steps. This is as documented: its README says it is stateless.
  - localstripe 1.15.10: 0.0% [0.0–16.1] over the 20 sequences inside the routes it serves (6 of 26 templates).
- **The sandbox against itself:** 100.0% sequence agreement [94.0–100.0] over 60 pairs recorded 28 minutes apart (templates #1–#15), so the noise floor is 0.0%. This is in-sample: normalization v1.2 was written from this pair. Source: `reports/2026-09-26-baseline.md`.
- **Parity twin, day 0** (tag `twin-scaffold-v0`): 0.0% sequence agreement [0.0–4.2] over 88 sequences, and 3.1% of steps match on value. Source: `reports/2026-09-26-twin-day0.md`.
- **After the first align run:** 174 automatic patches, all data-file edits. On train sequences, 18.8% of steps match on value (from 3.8%) and 5.6% of sequences [2.2–13.4] (from 0.0%). On held-out, 8.8% of steps [4.9–15.5] (from 0.0%) and 0 of 16 sequences. Source: `reports/2026-09-26-align-first-run.md`.

The limits of these numbers:
- **Held-out is only partly held out at day 0.** The scaffold's own tests exercised two held-out templates (#7, #9), so held-out measures generalization after the freeze only (`reports/2026-09-26-twin-day0.md`).
- **The LLM-assisted patch path has not run live.** It is built, but no LLM key is set, so all 174 patches are automatic (`docs/plan/STATUS.md`).
- **Test clocks are unvalidated until B1.** The unclaimed sandbox key refuses them, so no clock sequence is in the oracle (`reports/2026-09-26-baseline.md`).

Plainly: the twin does not pass a held-out sequence yet. What is ready today is the measurement. The twin number is the thing the align loop is moving.
