# Parity

Parity measures how faithfully a Stripe-compatible server reproduces the real Stripe API, and ships an open-source twin of the Stripe Billing API that is measured the same way.

- **ParityBench** replays a corpus of API sequences (customers, subscriptions, refunds, errors, idempotency, events, …) against any Stripe-compatible base URL. It compares every response with a recording of the same sequence on the real Stripe sandbox, and reports agreement at four levels, with 95% confidence intervals and the noise floor of the sandbox itself.
- **The Parity twin** is a stateful Billing server in plain Node, with no dependencies, for fast and isolated tests. ParityBench scores it against sandbox recordings, and an alignment loop patches it toward them.
- **`paritybench agree`** runs your own test suite twice, once against the twin and once against your sandbox, and reports which tests agree.

**Status: pre-release.** The oracle holds the full corpus: 620 sandbox-recorded sequences (2026-09-29: the 600 of oracle v1 plus template #31). The alignment loop has landed 180 automatic patches and 1 merged assisted pull request (#1, 2026-09-28). The nightly pipeline is scheduled and live: its workflow runs daily at 07:23 UTC, with a 10:47 UTC backup that does nothing once the night is published (GitHub skipped the earlier 07:00 UTC schedule on 2026-09-29), and its first run on GitHub (dispatched on 2026-09-28) recorded that night's slice, found no drift, and made the assisted pass's first LLM calls ($0.23). It has published three points: one on the earlier 88-sequence oracle, one on oracle v1 ([report](reports/2026-09-27-twin-v1.md)), and one on the 620-sequence oracle (2026-09-29). Numbers not measured yet are marked `{{TBD}}`.

## Quickstart

### Run the twin

```sh
npx paritybench twin                  # http://127.0.0.1:12111
```

That line works from npm once the package is published, which is a launch-gate item: it is not on the registry yet. Until then, the same package runs from a tarball. In a checkout, `npm pack` compiles `src/` and `templates/` to `dist/` (the `prepack` script, with the `typescript` devDependency, so run `npm ci` first):

```sh
npm ci && npm pack                                  # paritybench-0.0.1.tgz
npx --yes ./paritybench-0.0.1.tgz twin --port 12111 # the relative ./ path matters: npx runs an absolute path as a command
```

From a checkout without building (Node ≥ 22.18, nothing to install), run `node src/cli.ts twin [--port 12111] [--host 127.0.0.1]`. Or use Docker or the Action below.

With Docker:

```sh
docker build -t parity-twin .
docker run --rm -p 12111:12111 parity-twin
```

Any API key that starts with `sk_test_` or `rk_test_` is accepted:

```sh
curl -u sk_test_parity: http://127.0.0.1:12111/v1/customers -d email=jenny@example.com
```

With stripe-node, pass `new Stripe("sk_test_parity", { host: "127.0.0.1", port: 12111, protocol: "http" })`. Between tests, `POST /_parity/reset` clears all state.

### Use the twin from an agent (MCP)

`node src/cli.ts mcp` serves an in-process twin over MCP on stdio. It speaks protocol `2025-11-25` and earlier, with the `initialize` handshake; the stateless `2026-07-28` handshake (no `initialize`) is not implemented. Add it to an MCP client config:

```json
{ "mcpServers": { "parity-twin": { "command": "node", "args": ["/path/to/parity/src/cli.ts", "mcp"] } } }
```

Once the package is on npm, `"command": "npx", "args": ["-y", "paritybench", "mcp"]` does the same without a checkout.

- Each twin route is one tool, named from its API operation: `post_v1_customers`, `get_v1_customers_customer`, `post_v1_subscriptions`, and so on.
- A tool takes the route's path, query and body parameters as JSON. Its input schema comes from the vendored OpenAPI spec.
- A tool returns the response's `{status, body}` as JSON text. API errors come back as tool results with `isError: true`.
- `parity_reset` clears all state, and `parity_state` shows the store. State lives in memory and ends with the server process.

### In GitHub Actions

The action starts the twin from its own checkout and exports `PARITY_TWIN_URL`:

```yaml
- uses: GSXRcoder159/parity@main
  with:
    port: 12111 # the default
- run: npm test # reads PARITY_TWIN_URL=http://127.0.0.1:12111
```

It sets up Node 22 for the rest of the job. `.github/workflows/action-selftest.yml` runs it on every push.

### Score a server

```sh
node src/cli.ts bench http://127.0.0.1:12111 --oracle oracle.jsonl --noise noise.jsonl
```

(`npx paritybench bench …` from npm once the package is published, or from a packed tarball now; see "Run the twin".) `--oracle` is a sandbox recording of the corpus, and `--noise` is a second recording of some or all of the same sequences, for the noise floor. The floor is measured on the oracle sequences the noise recording covers, and the report says how many that is. Recordings are not distributed: they are data from a Stripe account. Record your own with your own sandbox key (see [Reproduce](#reproduce-with-your-own-sandbox-key)).

### Check your own test suite: `agree`

```sh
node src/cli.ts agree --cmd "node --test --test-reporter=tap examples/agree-suite/billing.test.mjs" --runs twin,sandbox --out reports/agree
```

`agree` runs the command once per target, with `STRIPE_API_BASE` and `STRIPE_API_KEY` set, and pairs the outcomes by test name. The suite's only contract is to send its requests to `STRIPE_API_BASE`.
- **twin:** an in-process twin on an ephemeral port, with the key `sk_test_parity`.
- **sandbox:** your `STRIPE_API_KEY` from `.env`, through a local proxy to the real API. The proxy holds 20 requests per second and ledgers every request against the read budget. It halts the run (no report) when the rolling 30-day GETs reach the budget, or after 10 consecutive 429s.
- **Outcomes:** from the JUnit XML the command writes to `--junit <path>`, else from `node --test` TAP on stdout. With TAP, a test inside a `describe` block or a subtest is named `block > test`.
- **Report:** per-test outcomes, the agreement with a 95% Wilson interval, and the disagreeing tests. It holds test names and outcomes only, never the command's output.

`examples/agree-suite/billing.test.mjs` is an 8-test example (customer, card, price, subscription, a previewed and applied price change, cancel, refund). The sandbox half needs a claimed sandbox's `sk_test_` key. On 2026-09-28 it passed 8/8 on the twin and 8/8 on the sandbox: agreement 100.0% (8/8, 95% Wilson interval 67.6–100.0%) ([report](reports/2026-09-27-agree-example.md)). That shows `agree` works on both targets, not that the twin is faithful. The suite was written next to the twin and was known to pass on it, it checks outcomes and not responses, and 8 tests give a lower bound of 67.6%.

### Train agents on the twin: `verifiers`

`python/parity_verifiers` is a [`verifiers`](https://github.com/PrimeIntellect-ai/verifiers) `ToolEnv` of billing-support tasks (refunds, cancellations, plan changes) over a running twin. Each rollout seeds its own customer through the API, and the rubric checks the final state through `/_parity/state`.

```sh
node src/twin/main.ts &                         # the twin on 127.0.0.1:12111
cd python/parity_verifiers && uv run --locked pytest -q
```

`load_environment(base_url="http://127.0.0.1:12111", tasks=None)` returns the environment; `tasks` picks a subset by name.

## Method

**Corpus.** 31 templates in 10 strata: lifecycle, pagination, cancellation, refunds, errors, idempotency, events, proration, boundaries and clocks. The full corpus runs each template with seeds 1–20: 620 sequences. The recorded oracle holds all 620, each the newest clean sandbox recording of its sequence: oracle v1 (2026-09-28) holds the first 600 ([baseline report](reports/2026-09-27-baseline-v1.md)), and #31 `subscription-interval-swap` (a monthly subscription moved to a yearly price without `billing_cycle_anchor`) was added on 2026-09-29 ([validation notes](docs/plan/impl/templates-validation.md)). The oracle v1 scores below are on those 600. The four test-clock templates (#27–#30) were validated on the sandbox on 2026-09-27 ([clock report](reports/2026-09-27-clocks.md)). Six templates are **held out** (120 sequences): `subscription-cancel-at-period-end`, `refund-partial-then-rest`, `invalid-params`, `subscription-update-quantity`, `boundaries-list-limits` and `clock-trial-end`. They never feed the alignment loop; they only gate its patches. (Disclosure: an implementer's context once contained the validation notes of held-out #7, #9 and #12, and later the intended steps and step and event counts of #28, with no results; the align loop never saw them. See the [day-0 report](reports/2026-09-26-twin-day0.md) limitations.)

**Four levels.**

| Level | Agreement means | Unit |
|---|---|---|
| L1 status | same HTTP status | step |
| L2 shape | same type skeleton of the body | step |
| L3 value | same normalized body | step |
| L4 sequence | every step agrees at L3, the same multiset of event types, and no causal-order violation (below) | sequence |

**Event order (compare method m2).** Stripe does not guarantee event order, so events are compared as sets plus causal-order constraints, never as a strict sequence. From the oracle recording, event type A precedes type B when every A event was created strictly before every B event; the target violates that pair when it creates some B strictly before some A (divergence class `EVENT_ORDER_MISMATCH`). Events created in the same second never violate. The method version (m1: event-type sets only; m2: plus causal order) is published next to the normalization version with every score, and the curve marks the change.

**Confidence intervals.** Every number is a 95% Wilson interval, reported with its n. L1–L3 pool steps across sequences as if they were independent; steps of one sequence are correlated (one wrong state affects later steps), so those intervals are narrower than they should be. L4 counts whole sequences and has no such bias.

**Noise floor and ceiling.** Two real sandbox recordings of the same sequences are compared with the same harness. The noise floor is 1 − their agreement. The ceiling is their agreement: the best score any server can reach against that oracle. **Any score without the noise floor and ceiling is invalid.**

**Normalization.** Versioned rules rewrite run-specific values so that two faithful runs compare equal: ids, timestamps, a declined invoice's retry time (compared to the day), run nonces, secrets, hosted URLs, per-account and card-network opaques (including a Visa charge's ECI), dashboard links and the unclaimed-sandbox banner. List order is compared as returned. Each rule states what it can hide. The rules and their rationale are in [`src/bench/normalize.ts`](src/bench/normalize.ts) (currently v1.4), and every score carries its normalization version.

**Rolling oracle.** The sandbox read allocation (10,000 GETs per rolling 30 days) does not allow re-recording the whole corpus every night. Each night re-records the next part of a rotation through the corpus, at most a seventh of it and only as much as that night's share of the read budget allows, and scores the twin on the whole corpus against the latest recording of each sequence. When every night can afford a seventh, the oracle is at most 7 days old and drift on any sequence is detected within 7 days; a night that affords less continues the rotation the next night. Each curve point records the oracle's actual maximum age (`oracleMaxAgeDays` in `site/data/curve.json`, from the 2026-09-28 point on). Drift compares a night's slice with the previous recording of the same sequences, on paths outside the noise set.

**Alignment loop and automation ratio.** After the scaffold freeze (tag `twin-scaffold-v0`), every change to the twin is logged in a hash-chained log as one of three classes:
- **automatic:** it edits only data files (`src/twin/shapes/*.json`, `src/twin/errors.json`), for a value the oracle shows deterministically. It is applied when the held-out gate passes.
- **assisted:** a code change proposed by the loop and merged after review.
- **surface added:** new scope, such as test clocks. It is annotated on the curve so that a coverage jump is never read as alignment.

The automation ratio is counted from the log since the freeze, in two units per class. Patches: one automatic patch is one JSON-pointer edit to a data file, and one assisted patch is one merged pull request (H2's target, at least 60% of patches automatic, counts these). Because one pull request can fix what many pointer edits fix, each class also reports the train divergences it removed.

### Measured so far

**Noise floor, W0 (2026-09-25), normalization v1.1.** Templates 1–15 × seeds 1–4 (60 sequences, 420 steps), two clean sandbox runs 28 minutes apart ([report](reports/2026-09-25-w0-oracle.md)):

| Level | Agreement = ceiling | Floor |
|---|---|---|
| L1 status | 100.0% [99.1–100.0] (420) | 0.0% |
| L2 shape | 96.9% [94.8–98.2] (420) | 3.1% |
| L3 value | 92.4% [89.4–94.6] (420) | 7.6% |
| L4 sequence | 65.0% [52.4–75.8] (60) | 35.0% |

All 32 steps that disagree trace to 6 causes, and normalization v1.2 addresses them. On that same pair v1.2 agrees at every level (floor 0.0%; L3 [0.0–0.9], L4 [0.0–6.0]), but that is in-sample, because v1.2 was written from it ([baseline report](reports/2026-09-26-baseline.md)).

**Noise floor, out of sample (2026-09-28), normalization v1.3.** All 30 templates × seeds 1–2 (60 pairs, 449 steps, all 10 strata), recorded twice back to back after v1.3 was frozen, so no rule was written from them ([baseline report on oracle v1](reports/2026-09-27-baseline-v1.md)):

| Level | Agreement = ceiling | Floor |
|---|---|---|
| L1 status | 100.0% [99.2–100.0] (449) | 0.0% |
| L2 shape | 100.0% [99.2–100.0] (449) | 0.0% |
| L3 value | 99.3% [98.1–99.8] (449) | **0.7% [0.2–1.9]** |
| L4 sequence, oracle as expected | 95.0% [86.3–98.3] (60) | 5.0% [1.7–13.7] |
| L4 sequence, nightly's direction | 93.3% [84.1–97.4] (60) | 6.7% [2.6–15.9] |

The L3 floor is under the plan's 3% bar. The highest stratum is 2.0% at L3 (clocks and refunds), and none is above 10%. L4 depends on which recording is the expected one, because causal-order constraints come from the expected side. Three things vary between the two runs: a declined renewal's retry time (so the clock stratum's L4 ceiling is 75.0% [40.9–92.9]), a Visa charge's ECI, and the event order of one held-out refunds sequence. Normalization v1.4 adds rules for the first two. They were written from this pair, so v1.4 is in-sample on it; the next weekly pair measures v1.4 out of sample.

**Throughput, W0.** 3,950 and 4,436 sequences per hour (wall time, concurrency 8, no 429s).

**The twin on oracle v1** (600 sequences, 2026-09-28, normalization v1.3, method m2), from the first full nightly, run locally ([report](reports/2026-09-27-twin-v1.md)). "Before" is the score before that night's align commit, and "after" adds its 6 automatic patches. The first run on GitHub later that day republished the 2026-09-28 curve point with the "after" scores, under normalization v1.4:

| Split | L1 | L3 before | L3 after | L4 after |
|---|---|---|---|---|
| train | 98.9% [98.5–99.2] (3605) | 24.6% [23.2–26.0] (3605) | 26.8% [25.4–28.3] (3605) | 4.2% [2.7–6.3] (480) |
| held-out | 93.2% [91.4–94.7] (886) | 18.1% [15.7–20.7] (886) | 18.1% [15.7–20.7] (886) | 0.0% [0.0–3.1] (120) |
| noise ceiling | 100.0% [99.2–100.0] (449) | 99.3% [98.1–99.8] (449) | | 93.3% [84.1–97.4] (60) |

The twin passes no held-out sequence yet. The test clocks, built from the docs, get their first score here: every status right (train L1 100%), train L3 38.5% [35.1–41.9] and L4 0.0% [0.0–6.0], with the gaps in values and event order. The noise pair covers 60 of the 600 sequences, all 30 templates. Cumulative as of that night (sealed log, since the scaffold freeze): 180 automatic patches and 0 assisted; train divergences removed 7,538 vs 0.

**The assisted pass is live** (2026-09-28). The first run on GitHub sent its first 3 loci to the LLM for $0.23 and opened draft pull requests #1 and #2. #1 was merged: the twin's customer create now sets `invoice_prefix` and `next_invoice_sequence`. On oracle v1 its review gate moved train L3 from 26.8% to 47.5% and held-out L3 from 18.1% to 39.1%. #2 was closed as superseded by #1. The page and its changelog count #1 from the next nightly on, which logs it in the sealed log.

**The twin on the earlier 88-sequence oracle v0** ([day 0](reports/2026-09-26-twin-day0.md), [first align run](reports/2026-09-26-align-first-run.md)). These scores are not comparable with oracle v1's: the curve marks `oracle expanded: 88→600`.

| Split | L3 at day 0 | L3 after 174 automatic patches | L4 after |
|---|---|---|---|
| train | 3.8% [2.5–5.9] (495) | 18.8% [15.6–22.5] (495) | 5.6% [2.2–13.4] (72) |
| held-out | 0.0% [0.0–3.3] (113) | 8.8% [4.9–15.5] (113) | 0.0% [0.0–19.4] (16) |

That noise pair covers templates #1–#15 only and is in-sample, so these scores have a floor and ceiling for part of the corpus only. Both nightly points are in `site/data/curve.json`; a scheduled nightly curve: `{{TBD: once the nightly runs on its schedule}}`.

**Sim-to-real (H4).** An LLM agent (`claude-sonnet-5`, with tools from the pinned Python agent toolkit) does billing-support tasks (refunds, cancellations, plan changes) once on the twin, once on a second twin run (the control: the agent's own run-to-run agreement) and once on the sandbox. H4 is the share of tasks where the twin and the sandbox agree on pass or fail ([`evals/h4`](evals/h4/README.md)).
- 20 tasks (2026-09-28): 100.0% (20/20; 95% Wilson interval 83.9–100.0%), control 100.0% ([report](reports/2026-09-28-h4.md)).
- 80 tasks (2026-09-29): the 20 plus 60 written before any result, because the 20-task lower bound was under 90%. **93.8% (75/80; 86.2–97.3%)**, control 95.0% (76/80; 87.8–98.0%), so the noise floor is 5.0% and the verdict is inconclusive (90–95%) ([report](reports/2026-09-28-h4-80.md)). All 5 disagreements are in the 12 tasks that need `cancel_at_period_end`, which the agent's tool did not offer. The control shows 3 of them are agent variance; a 4th is probably agent variance too, which the control cannot show (both twin runs pass; on the sandbox the agent stopped without writing); the 5th, `cancel-addon-at-period-end`, is unattributed, and a twin gap is not excluded.

### Other servers

stripe-mock, as documented. Its README says: "stripe-mock does not attempt to reproduce the behavior of the real Stripe API at all. It cannot reject all invalid requests, and its responses are completely hardcoded." ([github.com/stripe/stripe-mock](https://github.com/stripe/stripe-mock)). On stateful sequences its score measures that documented design, not a defect. From the [baseline report on oracle v1](reports/2026-09-27-baseline-v1.md) (2026-09-28, normalization v1.3, method m2):

| Server | Sequences | L1 | L3 | L4 |
|---|---|---|---|---|
| stripe-mock (pinned digest, v0.205.0) | 600 | 83.7% | 3.1% | 0.0% [0.0–0.6] |
| localstripe 1.15.10 (the 6 of 30 templates it serves) | 120 | 57.7% | 2.8% | 0.0% [0.0–3.1] |

localstripe's event collection fails (it rejects the sweep's `ending_before` with a 400), so its event check fails on every sequence; that does not move its L4, because none of its sequences agrees on every step. On the earlier 88-sequence oracle the result was the same: L4 0.0% [0.0–4.2] and 0.0% [0.0–16.1] ([report](reports/2026-09-26-baseline.md)).

## Why a twin

On load testing against a sandbox, the [Stripe rate-limits documentation](https://docs.stripe.com/rate-limits) says:

> "We generally discourage this practice because API limits are lower in a sandbox, so the load test is likely to hit limits that it wouldn't hit in production. ... As an alternative, we recommend building integrations so that they have a configurable system for mocking out requests to the Stripe API, which you can enable for load tests."

A mock is only as useful as it is faithful. Parity measures that fidelity and publishes it.

## Reproduce with your own sandbox key

Use a sandbox in your own Stripe account. Set `STRIPE_API_KEY=sk_test_…` in `.env`, then:

```sh
node src/cli.ts record --target sandbox --name oracle --seeds 1-4 --concurrency 8
node src/cli.ts record --target sandbox --name noise --seeds 1-4 --concurrency 8
node src/cli.ts compare --oracle <oracle.jsonl> --target <noise.jsonl> --out recordings/my-noise  # the noise floor
node src/cli.ts score-twin --oracle <oracle.jsonl> --noise <noise.jsonl>                         # the twin, in process
node src/cli.ts bench <baseURL> --oracle <oracle.jsonl> --noise <noise.jsonl>                    # any server
```

- `record` prints where it wrote each recording: under `$PARITY_DATA_DIR`, else `../parity-data` if it exists, else `recordings/`. From the npm package, which has no checkout to default into, set `PARITY_DATA_DIR`: the commands that need the data dir (sandbox `record`, `oracle build`, `agree --runs …sandbox`) refuse without it, and `align` and `nightly` run only from a checkout.
- The harness paces sandbox traffic at 20 requests per second or less. It counts every `GET` against `PARITY_READ_BUDGET` (default 10,000 per rolling 30 days, the minimum read allocation on the rate-limits page) in `<data dir>/budget/reads.jsonl`, which names your account: keep it private.
- On an unclaimed (claimable) sandbox key, leave about 20 minutes between the two runs: that key has an undocumented request quota.
- `node src/cli.ts help` lists every flag.
- The outputs of `record`, `compare`, `bench` and `score-twin` contain response values from your account. Keep them private.

## Supported surface of the twin

API version `2026-08-26.dahlia`.

| Resource | Supported |
|---|---|
| Customers | create (also on a test clock, at most 3 per clock), retrieve, update, delete (cancels the customer's subscriptions first), list, search (`field:'value'` and numeric `created>=<epoch>`-style clauses joined by `AND`); list a customer's payment methods |
| Products, prices | create, retrieve, update, list; prices with `unit_amount` or `unit_amount_decimal`, one-time or recurring (recurring ones also emit `plan.*` events) |
| Payment methods | retrieve, list, attach, detach; test ids such as `pm_card_visa` and `pm_card_chargeDeclined`. A detached payment method is never charged |
| Subscriptions | create (first invoice and synchronous payment, `payment_behavior`, `collection_method=send_invoice` with a draft first invoice, `trial_period_days`), retrieve, list, cancel; update items (price swaps, quantities, additions, deletions) with `proration_behavior` (`create_prorations`, `always_invoice`, `none`), `proration_date` and `billing_cycle_anchor=now`, and `cancel_at_period_end`, `default_payment_method`, `description`, `metadata` |
| Invoices | retrieve, list, update (`description`, `metadata`), finalize, pay (also `paid_out_of_band`), void, `create_preview` (the next invoice of a subscription, with or without changes, or the first invoice of a new one). Delete answers the API's error for subscription invoices |
| Payment intents, charges | retrieve, list (payment attempts create them) |
| Refunds | create, retrieve, list |
| Events | retrieve, list |
| Webhook endpoints | create, retrieve, update, delete, list; signed deliveries (`Stripe-Signature`) with 3 retries |
| Test clocks | create, retrieve, list, delete (deletes its customers, canceling their subscriptions), advance: renewals counted from the billing anchor, trial end and the `trial_will_end` notice, cancel at period end, a renewal draft finalized and charged an hour later, and payment retries. A clock's objects live at its frozen time. **Built from the public docs, then scored against sandbox recordings on oracle v1:** every status matches, but values and event order do not yet (train L3 38.5%, L4 0.0% [0.0–6.0], [report](reports/2026-09-27-twin-v1.md)). Known differences: events stamped at the frozen time (the sandbox uses the wall clock), no `invoice.upcoming` at renewal, a renewal draft that finalizes after 1 h (3 days on the sandbox), no `invoice.marked_uncollectible` at clock delete, and a fixed 2-day payment retry ([clock report](reports/2026-09-27-clocks.md)) |

Across every route:
- Form-encoded parameters are validated against the OpenAPI spec, and unknown ones are rejected.
- It supports `expand[]`, cursor pagination (`limit`, `starting_after`, `ending_before`), `Idempotency-Key` and the error envelope.
- Error responses carry a `Parity-Error-Key` header.
- The `Parity-Now: <unix seconds>` header sets the clock for a request.
- Control endpoints: `POST /_parity/reset`, `POST /_parity/seed`, `GET /_parity/state`.

**Not yet:** these answer `400 not_implemented` rather than guessing at behavior no recording shows.
- A subscription item on a price in another currency, a second item on a price the subscription already has, items on different billing intervals, and a change of billing interval (for example monthly to annual) without `billing_cycle_anchor=now`.
- A `billing_cycle_anchor` timestamp, a `proration_date` outside the current period, deleting every item, discounts, and any other subscription parameter not listed above.
- Changing a trialing or canceled subscription; previewing the renewal of a subscription set to cancel at period end.
- Cancel with `invoice_now` or `prorate`.
- Finalizing, paying or voiding an invoice twice, and updating a paid or void one.
- Webhook endpoints with `connect`, and a test clock created with `customer`.

Routes the twin does not serve at all, such as creating a payment intent directly, answer `404 unrecognized_url`.

## License and pledge

Apache-2.0 ([LICENSE](LICENSE)).

**Pledge: the alignment loop and the score stay open.** The code that aligns the twin, and the method and numbers of the score, will remain open source and public. Raw sandbox recordings are the one exception: they are data from a Stripe account, so they are never published. What is published is scores, counts, divergence paths and classes, the normalization version, and hashes of the recordings.

Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc. Stripe is a trademark of Stripe, Inc.
