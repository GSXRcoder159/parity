> **DO NOT POST before B5 clears.** Counsel review (decision 0001 C7) comes before any public release; see the launch gate in `docs/plan/STATUS.md`.

# Show HN draft

**Planned:** Thursday 2026-10-15 (plan §5 W3). **Order:** plan §7. **Sources:** `reports/2026-09-25-w0-oracle.md`, `reports/2026-09-26-baseline.md`, `reports/2026-09-27-baseline-v1.md`, `reports/2026-09-27-twin-v1.md`.

Before posting:
- [ ] B5 cleared, including the title's referential use of the mark.
- [ ] npm publish of `paritybench` is done, so `npx paritybench twin` works from the registry (the compiled build is done; today it runs from a packed tarball, as the README says).
- [ ] The repo is public (from a fresh squashed history) and the score page is on GitHub Pages. The URLs below are filled in.
- [ ] Every `{{TBD: …}}` is replaced with a measured number, or its sentence is cut.
- [ ] The nightly run is live. If it is not, cut every "every night" and "nightly" claim.
- [ ] The latest curve point's `oracleMaxAgeDays` is 7 or less. If it is not, cut the "at most 7 days" and "within 7 days" claims (the slice is sized to the read budget, so a tight month can stretch the rotation).
- [x] The oracle grew to 600 sequences (oracle v1, 2026-09-28), and the baselines were re-run on it; the footnote uses them. If the oracle or the normalization version changes again before posting, re-run them and update the footnote.
- [ ] The twin numbers in paragraph 3 are from 2026-09-28. Replace them with the latest curve point, and keep its date and report.
- [ ] No possessive, plural or altered form of the mark crept into an edit (0001 C4).

---

**Title:** Show HN: ParityBench – measuring how wrong Stripe API mocks are

**URL:** {{TBD: public repo URL}}

**Text** (plain text: Hacker News renders only *italics*, bare URLs and indented code, so paste everything below the next line as is):

---

Hi HN, I'm Adam. Test suites and agent evals run against mocks of the Stripe API every day, and the mock's fidelity is taken on faith. For load tests, the Stripe rate-limits docs (https://docs.stripe.com/rate-limits) say "we recommend building integrations so that they have a configurable system for mocking out requests to the Stripe API". A mock is only as useful as it is faithful.

1. As far as I can find, nobody publishes how wrong Stripe API mocks are. So here is a method and a harness anyone can run. ParityBench replays a corpus of API sequences against any Stripe-compatible base URL and against a recording of the same sequences on the real Stripe sandbox. The corpus is 30 templates in 10 strata (lifecycle, cancellation, refunds, errors, idempotency, events, pagination, proration, boundaries, test clocks), 600 sequences, all of them recorded on the sandbox (the oracle, 2026-09-28). It scores four levels: L1 status, L2 shape, L3 value after normalization, and L4 the whole sequence (every step at L3, plus the same event types, none created before one the sandbox always creates first). Every number is a 95% Wilson interval with its n. The normalization rules are versioned, and each one says what it can hide.

2. The real sandbox has a noise floor. Two clean sandbox runs of the same 60 sequences (420 steps), 28 minutes apart, agreed on every status. Raw bodies differed on 419 of the 420 steps: ids and timestamps. After normalization v1.1, 7.6% [5.4-10.6] of steps still differed, and whole sequences matched only 65.0% [52.4-75.8] of the time (n=60). All 32 of those steps traced to 6 causes, such as simulated card-network identifiers, same-second list order and a dashboard link. Normalization v1.2 addresses all 6. On that same pair it measures 0.0% [0.0-0.9] at L3, but that is in-sample, because v1.2 was written from that pair. On a fresh pair of all 30 templates (60 sequences, 449 steps), recorded after normalization v1.3 was frozen, the floor is 0.7% [0.2-1.9] at L3 and 5.0% [1.7-13.7] at L4, or 6.7% [2.6-15.9] at L4 with the other run as the expected one (reports/2026-09-27-baseline-v1.md). What still varied: a declined renewal's retry time, a card's ECI, and the event order of one held-out sequence. v1.4 now normalizes the first two, but it was written from that pair, so it waits for the next pair to be measured out of sample. The ceiling (100% minus the floor) is the best score any server can reach. Any score without the noise floor and ceiling is invalid.

3. The twin, and its nightly curve. Parity also ships an open-source, stateful twin of the Stripe Billing API: plain Node, no dependencies. ParityBench scores it every night. The sandbox read allocation does not allow re-recording everything nightly, so each night re-records at most a seventh of the corpus, as much as the read budget allows, and the twin is scored against an oracle that is at most 7 days old; drift on any sequence is detected within 7 days (each curve point publishes the oracle's age). On the full 600-sequence oracle (2026-09-28), the twin gets the status right on 98.9% of train steps, every value right on 24.6% of them (26.8% after that night's align commit), and 4.2% [2.7-6.3] of whole train sequences right. On held-out templates: every value right on 18.1% of steps, and 0 of 120 whole sequences (reports/2026-09-27-twin-v1.md). The noise ceiling on that oracle is 99.3% at L3 and 93.3% at L4. Curve: {{TBD: L3 and L4 on the first and latest night}} ({{TBD: score page URL}}).

After the scaffold froze, every change to the twin goes into a hash-chained log as one of three kinds. Automatic: it edits only data files (a field default, an enum, an error message), for a value the oracle shows deterministically, and lands only if the held-out gate passes. Assisted: an LLM proposes a code change from a minimized counterexample, and a human reviews and merges it. Surface added: new scope, marked on the curve so that a coverage jump never reads as alignment. So far: 180 automatic patches and 0 assisted; the assisted path has not sent a request to an LLM yet (reports/2026-09-27-twin-v1.md). Automation ratio, automatic / (automatic + assisted): {{TBD: ratio and patch counts, once the assisted path has run}}. Six templates are held out: they never feed the loop, they only gate it. (An implementer once saw the validation notes of three of them, and later the intended steps and step and event counts of a fourth, with no results; the loop never did. The day-0 report discloses both.)

4. npx paritybench twin, in CI. Run it and the twin listens on http://127.0.0.1:12111. Any sk_test_ key works, and POST /_parity/reset clears state between tests. The twin boots in about 0.1 s, spawn to first response (measured on a laptop). For GitHub Actions, add one step, "uses: {{TBD: owner/repo}}@main", which exports PARITY_TWIN_URL. A green job end to end takes {{TBD: wall time of a green action-selftest run on GitHub}}. It covers customers, products, prices, payment methods, subscriptions (create with trials, cancel, item and price changes with proration), invoices (finalize, pay, void, preview), payment intents, charges, refunds, events, signed webhooks and test clocks (built from the docs; on the sandbox recordings every clock status matches, but no whole clock sequence does yet, reports/2026-09-27-twin-v1.md). Known gaps (a billing-interval change without an anchor reset, items on mixed intervals, cancel with a final invoice) answer 400 not_implemented; the README lists them. Some other parameters the spec allows are still ignored, such as payment_method on customer create.

If you maintain a Stripe-compatible server, you can run the harness on it with your own sandbox key: the README has the commands. Raw recordings are never published, because they are data from a Stripe account. Scores, counts, divergence paths and classes, the normalization version and recording hashes are published. Apache-2.0, and the alignment loop and the score stay open.

Existing mocks, measured the same way, are in the footnote [1].

[1] Measured 2026-09-28 on the 600-sequence oracle (30 templates in 10 strata, seeds 1-20), normalization v1.3, compare method m2. Noise floor for this oracle: 0.7% [0.2-1.9] at L3 and 5.0% [1.7-13.7] at L4, over 60 pairs covering all 30 templates, recorded after v1.3 was frozen (out of sample). Rerun steps: {{TBD: public repo URL}}/blob/main/reports/2026-09-27-baseline-v1.md

- stripe-mock 0.205.0 (image sha256:ff3264..., embedded API version 2026-08-26.dahlia, the same as the twin), scored as documented. Its README says: "stripe-mock does not attempt to reproduce the behavior of the real Stripe API at all. It cannot reject all invalid requests, and its responses are completely hardcoded." On 600 sequences (4,491 steps): L1 83.7% [82.6-84.7], L3 3.1% [2.6-3.7], L4 0.0% [0.0-0.6]. On stateful sequences this measures its documented design, not a defect.

- localstripe 1.15.10, scored only on the routes it serves: 6 of 30 templates, 120 sequences (705 steps). Its event collection fails (it rejects the harness's ending_before paging), so its event check fails on every sequence; no sequence agreed on every step either. L1 57.7% [54.1-61.3], L3 2.8% [1.8-4.3], L4 0.0% [0.0-3.1].

Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc. Stripe is a trademark of Stripe, Inc.
