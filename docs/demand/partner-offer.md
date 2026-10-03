> **DRAFT — not for publication before the launch gate (docs/plan/STATUS.md)**

# Design partner offer

**For:** targets in `cohorts.md` who replied to the day-1 ask in `outreach.md` · **Tracker:** `funnel.md` · **Drafted:** 2026-09-26

Before sending:
- [ ] "Measured so far" is gated on B5, counsel review (decision 0001 C7). Until B5 clears, send the offer without that section.
- [x] `paritybench agree` has landed (W4, Task 5 in `docs/plan/impl/2026-09-26-w4-surface-agree-wrappers.md`); its sandbox half ran live on 2026-09-28 (`reports/2026-09-27-agree-example.md`).
- [ ] Re-read each number in its cited report. The twin numbers move with every align run.
- [ ] For partner runs, set `PARITY_DATA_DIR` to a directory outside any git repository. The default is `../parity-data`, a git repo (README, Reproduce).
- [ ] Check `docs/plan/STATUS.md` (W4) and the README's "Not yet" list. Move what has landed out of the "Not in the twin yet" bullet.
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

## The twin's v0 surface

- **In scope (plan §2.1):** Customers, PaymentMethods (`pm_card_*` test tokens), Products and Prices, Subscriptions, Invoices (preview, pay, void), Refunds, Charges and PaymentIntents (retrieve only), Events and webhook endpoints, and test clocks. Also idempotency keys and the error envelope.
- **Added since v0, and scored against the sandbox on oracle v1:** proration (subscription price and quantity changes), invoice preview, the invoice lifecycle (finalize, pay, void) and test clocks.
- **Not in the twin yet:** the README's "Not yet" list, for example a change of billing interval without an anchor reset, items on mixed intervals, and cancel with a final invoice. They answer `not_implemented`, and calls to them count as out of scope.
- **Not covered:** Quotes, Subscription Schedules, Coupons and Promotion codes, Tax, Checkout, Connect, Billing Portal, Meters, Disputes.

## Measured so far

Gated on B5 (see "Before sending"). Intervals are 95% Wilson. Train sequences are the ones the align loop learns from; held-out ones the align loop is never shown. "Sequence agreement" means every step matches the sandbox after normalization, the sequence emits the same event types, and no event comes before one the sandbox always emits first.

Every number below comes from **oracle v1: all 600 planned sandbox sequences (30 templates × 20 seeds), recorded by 2026-09-28**, unless it says otherwise.

- **Existing mocks: 0% sequence agreement.** Source: `reports/2026-09-27-baseline-v1.md`.
  - stripe-mock 0.205.0 (pinned image): 0.0% [0.0–0.6] over 600 sequences. Its status codes match on 83.7% of steps. This is as documented: its README says it is stateless.
  - localstripe 1.15.10: 0.0% [0.0–3.1] over the 120 sequences inside the routes it serves (6 of 30 templates).
- **The sandbox against itself:** over 60 pairs covering all 30 templates, recorded after normalization v1.3 was frozen (out of sample), 0.7% [0.2–1.9] of steps differ. Sequence agreement is 95.0% [86.3–98.3], or 93.3% [84.1–97.4] with the other run as the expected one. Source: `reports/2026-09-27-baseline-v1.md`.
- **Parity twin on oracle v1** (the first full nightly, 2026-09-28): on train sequences, 24.6% of steps match on value (26.8% after that night's 6 automatic patches) and 4.2% of sequences [2.7–6.3]; on held-out, 18.1% of steps and 0 of 120 sequences (0.0% [0.0–3.1]). 180 automatic patches so far, all data-file edits. Source: `reports/2026-09-27-twin-v1.md`.
- **`agree` on our example suite, not yours:** 8 of 8 tests pass on the twin and 8 of 8 on the sandbox, agreement 100.0% [67.6–100.0]. Source: `reports/2026-09-27-agree-example.md`.
- **Earlier, on oracle v0** (88 sequences; not comparable with the numbers above): the twin at day 0 (tag `twin-scaffold-v0`) had 0.0% sequence agreement [0.0–4.2] and 3.1% of steps matching on value (`reports/2026-09-26-twin-day0.md`). After the first align run's 174 automatic patches: train 18.8% of steps (from 3.8%) and 5.6% of sequences [2.2–13.4], held-out 8.8% of steps [4.9–15.5] and 0 of 16 sequences (`reports/2026-09-26-align-first-run.md`).

The limits of these numbers:
- **Held-out is only partly held out at day 0.** The scaffold's own tests exercised two held-out templates (#7, #9), so held-out measures generalization after the freeze only. Later an implementer's context contained the validation notes of held-out #7, #9 and #12, and then the intended steps and step and event counts of held-out #28, with no results; the align loop never saw them, and they stay held out (`reports/2026-09-26-twin-day0.md`).
- **The LLM-assisted patch path has not run live.** It is built and its key is set, but the first real nightly ran it at a $0 cap pending the LLM budget, so all 180 patches are automatic (`docs/plan/STATUS.md`, `reports/2026-09-27-twin-v1.md`).
- **Test clocks are new to the measurement.** They were built from the docs and first scored on oracle v1: every clock status matches, but no clock sequence does yet. The sandbox itself varies on a declined renewal's retry time, so the clock stratum's sequence ceiling is 75.0% [40.9–92.9] (`reports/2026-09-27-twin-v1.md`, `reports/2026-09-27-baseline-v1.md`).
- **The noise floor is at normalization v1.3.** The harness is now at v1.7: v1.4's two new rules were written from that same pair, v1.5's two from the first drift reports, v1.6's two from the 2026-10-01 drift report and v1.7's extension of the month rule from the 2026-10-02 and 2026-10-03 reports, so the current rules' own floor waits for the next pair (`src/bench/normalize.ts`).
- **The `agree` result is not a fidelity number.** The example suite was written next to the twin and was known to pass on it, it checks outcomes rather than responses, and 8 tests give a lower bound of 67.6% (`reports/2026-09-27-agree-example.md`).

Plainly: the twin does not pass a held-out sequence yet. What is ready today is the measurement. The twin number is the thing the align loop is moving.
