> **DO NOT POST before B5 clears.** Counsel review (decision 0001 C7) comes before any public release; see the launch gate in `docs/plan/STATUS.md`.

# Show HN draft

**Planned:** Thursday 2026-10-15 (plan §5 W3). **Order:** plan §7. **Sources:** `reports/2026-09-25-w0-oracle.md`, `reports/2026-09-26-baseline.md`.

Before posting:
- [ ] B5 cleared, including the title's referential use of the mark.
- [ ] Compiled JS build and npm publish of `paritybench` are done, so `npx paritybench twin` works (the README says it does not today).
- [ ] The repo is public (from a fresh squashed history) and the score page is on GitHub Pages. The URLs below are filled in.
- [ ] Every `{{TBD: …}}` is replaced with a measured number, or its sentence is cut.
- [ ] The nightly run is live. If it is not, cut every "every night" and "nightly" claim.
- [ ] If the oracle has grown past 88 sequences, the baselines are re-run and the footnote is updated.
- [ ] No possessive, plural or altered form of the mark crept into an edit (0001 C4).

---

**Title:** Show HN: ParityBench – measuring how wrong Stripe API mocks are

**URL:** {{TBD: public repo URL}}

**Text** (plain text: Hacker News renders only *italics*, bare URLs and indented code, so paste everything below the next line as is):

---

Hi HN, I'm Adam. Test suites and agent evals run against mocks of the Stripe API every day, and the mock's fidelity is taken on faith. For load tests, the Stripe rate-limits docs (https://docs.stripe.com/rate-limits) say "we recommend building integrations so that they have a configurable system for mocking out requests to the Stripe API". A mock is only as useful as it is faithful.

1. As far as I can find, nobody publishes how wrong Stripe API mocks are. So here is a method and a harness anyone can run. ParityBench replays a corpus of API sequences against any Stripe-compatible base URL and against a recording of the same sequences on the real Stripe sandbox. The corpus is 30 templates in 10 strata (lifecycle, cancellation, refunds, errors, idempotency, events, pagination, proration, boundaries, test clocks), 600 sequences planned; the oracle holds {{TBD: oracle sequence count at launch (88 on 2026-09-26)}}. It scores four levels: L1 status, L2 shape, L3 value after normalization, and L4 the whole sequence (every step at L3, plus the same event types). Every number is a 95% Wilson interval with its n. The normalization rules are versioned, and each one says what it can hide.

2. The real sandbox has a noise floor. Two clean sandbox runs of the same 60 sequences (420 steps), 28 minutes apart, agreed on every status. Raw bodies differed on 419 of the 420 steps: ids and timestamps. After normalization v1.1, 7.6% [5.4-10.6] of steps still differed, and whole sequences matched only 65.0% [52.4-75.8] of the time (n=60). All 32 of those steps traced to 6 causes, such as simulated card-network identifiers, same-second list order and a dashboard link. Normalization v1.2 addresses all 6. On that same pair it measures 0.0% [0.0-0.9] at L3, but that is in-sample, because v1.2 was written from that pair. On a fresh pair: {{TBD: v1.2 noise floor, L3 and L4, on an out-of-sample pair}}. The ceiling (100% minus the floor) is the best score any server can reach. Any score without the noise floor and ceiling is invalid.

3. The twin, and its nightly curve. Parity also ships an open-source, stateful twin of the Stripe Billing API: plain Node, no dependencies. ParityBench scores it every night. The sandbox read allocation does not allow re-recording everything nightly, so the twin is scored nightly against an oracle that is at most 7 days old; drift on any sequence is detected within 7 days. Day-0 score: {{TBD: day-0 twin score, L1-L4, train vs held-out}}. Curve: {{TBD: L3 and L4 on the first and latest night}} ({{TBD: score page URL}}).

After the scaffold froze, every change to the twin goes into a hash-chained log as one of three kinds. Automatic: it edits only data files (a field default, an enum, an error message), for a value the oracle shows deterministically, and lands only if the held-out gate passes. Assisted: an LLM proposes a code change from a minimized counterexample, and a human reviews and merges it. Surface added: new scope, marked on the curve so that a coverage jump never reads as alignment. Automation ratio, automatic / (automatic + assisted): {{TBD: ratio and patch counts}}. Six templates are held out: they never feed the loop, they only gate it. (An implementer once saw the validation notes of three of them; the loop never did. The day-0 report discloses it.)

4. npx paritybench twin, in CI. Run it and the twin listens on http://127.0.0.1:12111. Any sk_test_ key works, and POST /_parity/reset clears state between tests. The twin boots in about 0.1 s, spawn to first response (measured on a laptop). For GitHub Actions, add one step, "uses: {{TBD: owner/repo}}@main", which exports PARITY_TWIN_URL. A green job end to end takes {{TBD: wall time of a green action-selftest run on GitHub}}. It covers customers, products, prices, payment methods, subscriptions (create with trials, cancel, item and price changes with proration), invoices (finalize, pay, void, preview), payment intents, charges, refunds, events, signed webhooks and test clocks (built from the docs; no sandbox has recorded a clock yet). Known gaps (a billing-interval change without an anchor reset, items on mixed intervals, cancel with a final invoice) answer 400 not_implemented; the README lists them. Some other parameters the spec allows are still ignored, such as payment_method on customer create.

If you maintain a Stripe-compatible server, you can run the harness on it with your own sandbox key: the README has the commands. Raw recordings are never published, because they are data from a Stripe account. Scores, counts, divergence paths and classes, the normalization version and recording hashes are published. Apache-2.0, and the alignment loop and the score stay open.

Existing mocks, measured the same way, are in the footnote [1].

[1] Measured 2026-09-26 on an 88-sequence oracle (all 26 templates, 2-4 seeds each), normalization v1.2. Noise floor for this oracle: 0.0% [0.0-0.9] at L3 and 0.0% [0.0-6.0] at L4, over the 60 of 88 sequences paired so far (templates 1-15, in-sample for v1.2), so the ceiling on that part is 100%. Proration and boundaries: {{TBD: noise pair for templates 16-26}}. Rerun steps: {{TBD: public repo URL}}/blob/main/reports/2026-09-26-baseline.md

- stripe-mock 0.205.0 (image sha256:ff3264..., embedded API version 2026-08-26.dahlia, the same as the twin), scored as documented. Its README says: "stripe-mock does not attempt to reproduce the behavior of the real Stripe API at all. It cannot reject all invalid requests, and its responses are completely hardcoded." On 88 sequences (608 steps): L1 80.9% [77.6-83.8], L3 1.3% [0.7-2.6], L4 0.0% [0.0-4.2]. On stateful sequences this measures its documented design, not a defect.

- localstripe 1.15.10, scored only on the routes it serves: 6 of 26 templates, 20 sequences (117 steps). Events were not compared. L1 58.1% [49.1-66.7], L3 3.4% [1.3-8.5], L4 0.0% [0.0-16.1].

Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc. Stripe is a trademark of Stripe, Inc.
