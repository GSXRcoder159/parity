# Parity

Parity measures how faithfully a Stripe-compatible server reproduces the real Stripe API, and ships an open-source twin of the Stripe Billing API that is measured the same way.

- **ParityBench** replays a corpus of API sequences (customers, subscriptions, refunds, errors, idempotency, events, …) against any Stripe-compatible base URL. It compares every response with a recording of the same sequence on the real Stripe sandbox, and reports agreement at four levels, with 95% confidence intervals and the noise floor of the sandbox itself.
- **The Parity twin** is a stateful Billing server in plain Node, with no dependencies, for fast and isolated tests. ParityBench scores it against sandbox recordings, and an alignment loop patches it toward them.
- **`paritybench agree`** runs your own test suite twice, once against the twin and once against your sandbox, and reports which tests agree.

**Status: pre-release.** The alignment loop has run (174 automatic patches) and the nightly pipeline has published one point, on an oracle of 88 recorded sequences. The nightly does not run on a schedule yet: it needs a claimed sandbox key and repository secrets. Numbers not measured yet are marked `{{TBD}}`.

## Quickstart

### Run the twin

```sh
npx paritybench twin                  # http://127.0.0.1:12111
```

This line does not work yet, and publishing alone will not fix it. The package is not on npm, and its `bin` is `src/cli.ts`: Node refuses to strip TypeScript types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so `npx` needs a compiled JavaScript build first. Today, from a checkout (Node ≥ 22.18, nothing to install), run `node src/cli.ts twin [--port 12111] [--host 127.0.0.1]`, or use Docker or the Action below.

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

(`npx paritybench bench …` once the package is published; see "Run the twin".) `--oracle` is a sandbox recording of the corpus, and `--noise` is a second recording of some or all of the same sequences, for the noise floor. The floor is measured on the oracle sequences the noise recording covers, and the report says how many that is. Recordings are not distributed: they are data from a Stripe account. Record your own with your own sandbox key (see [Reproduce](#reproduce-with-your-own-sandbox-key)).

### Check your own test suite: `agree`

```sh
node src/cli.ts agree --cmd "node --test --test-reporter=tap examples/agree-suite/billing.test.mjs" --runs twin,sandbox --out reports/agree
```

`agree` runs the command once per target, with `STRIPE_API_BASE` and `STRIPE_API_KEY` set, and pairs the outcomes by test name. The suite's only contract is to send its requests to `STRIPE_API_BASE`.
- **twin:** an in-process twin on an ephemeral port, with the key `sk_test_parity`.
- **sandbox:** your `STRIPE_API_KEY` from `.env`, through a local proxy to the real API. The proxy holds 20 requests per second and ledgers every request against the read budget. It halts the run (no report) when the rolling 30-day GETs reach the budget, or after 10 consecutive 429s.
- **Outcomes:** from the JUnit XML the command writes to `--junit <path>`, else from `node --test` TAP on stdout. With TAP, a test inside a `describe` block or a subtest is named `block > test`.
- **Report:** per-test outcomes, the agreement with a 95% Wilson interval, and the disagreeing tests. It holds test names and outcomes only, never the command's output.

`examples/agree-suite/billing.test.mjs` is an 8-test example (customer, card, price, subscription, a previewed and applied price change, cancel, refund). The sandbox half needs a claimed sandbox's `sk_test_` key.

### Train agents on the twin: `verifiers`

`python/parity_verifiers` is a [`verifiers`](https://github.com/PrimeIntellect-ai/verifiers) `ToolEnv` of billing-support tasks (refunds, cancellations, plan changes) over a running twin. Each rollout seeds its own customer through the API, and the rubric checks the final state through `/_parity/state`.

```sh
node src/twin/main.ts &                         # the twin on 127.0.0.1:12111
cd python/parity_verifiers && uv run --locked pytest -q
```

`load_environment(base_url="http://127.0.0.1:12111", tasks=None)` returns the environment; `tasks` picks a subset by name.

## Method

**Corpus.** 30 templates in 10 strata: lifecycle, pagination, cancellation, refunds, errors, idempotency, events, proration, boundaries and clocks. The full corpus runs each template with seeds 1–20: 600 sequences. The recorded oracle holds 88 of them so far (templates #1–#26, seeds 1–4 or 1–2): the rest waits for a claimed sandbox. The four test-clock templates (#27–#30) are in the corpus, but no sandbox has recorded them, so they are not validated yet. Six templates are **held out**: `subscription-cancel-at-period-end`, `refund-partial-then-rest`, `invalid-params`, `subscription-update-quantity`, `boundaries-list-limits` and `clock-trial-end`. They never feed the alignment loop; they only gate its patches. (Disclosure: an implementer's context once contained the validation notes of held-out #7, #9 and #12; the align loop never saw them. See the [day-0 report](reports/2026-09-26-twin-day0.md) limitations.)

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

**Normalization.** Versioned rules rewrite run-specific values so that two faithful runs compare equal: ids, timestamps, run nonces, secrets, hosted URLs, per-account and card-network opaques, dashboard links and the unclaimed-sandbox banner. List order is compared as returned. Each rule states what it can hide. The rules and their rationale are in [`src/bench/normalize.ts`](src/bench/normalize.ts) (currently v1.3), and every score carries its normalization version.

**Rolling oracle.** The sandbox read allocation does not allow re-recording the whole corpus every night. Each night re-records a rotating seventh of the corpus and scores the twin on the whole corpus against the latest recording of each sequence. So the twin is scored nightly against an oracle that is at most 7 days old; drift on any sequence is detected within 7 days. Drift compares a night's slice with the previous recording of the same sequences, on paths outside the noise set.

**Alignment loop and automation ratio.** After the scaffold freeze (tag `twin-scaffold-v0`), every change to the twin is logged in a hash-chained log as one of three classes:
- **automatic:** it edits only data files (`src/twin/shapes/*.json`, `src/twin/errors.json`), for a value the oracle shows deterministically. It is applied when the held-out gate passes.
- **assisted:** a code change proposed by the loop and merged after review.
- **surface added:** new scope, such as test clocks. It is annotated on the curve so that a coverage jump is never read as alignment.

The automation ratio is automatic ÷ (automatic + assisted), counted from the log since the freeze.

### Measured so far

**Noise floor, W0 (2026-09-25), normalization v1.1.** Templates 1–15 × seeds 1–4 (60 sequences, 420 steps), two clean sandbox runs 28 minutes apart ([report](reports/2026-09-25-w0-oracle.md)):

| Level | Agreement = ceiling | Floor |
|---|---|---|
| L1 status | 100.0% [99.1–100.0] (420) | 0.0% |
| L2 shape | 96.9% [94.8–98.2] (420) | 3.1% |
| L3 value | 92.4% [89.4–94.6] (420) | 7.6% |
| L4 sequence | 65.0% [52.4–75.8] (60) | 35.0% |

All 32 steps that disagree trace to 6 causes, and normalization v1.2 addresses them. On that same pair v1.2 agrees at every level (floor 0.0%; L3 [0.0–0.9], L4 [0.0–6.0]), but that is in-sample, because v1.2 was written from it ([baseline report](reports/2026-09-26-baseline.md)). On a pair recorded after it: `{{TBD: v1.2+ noise floor on an out-of-sample pair, after B1}}`.

**Throughput, W0.** 3,950 and 4,436 sequences per hour (wall time, concurrency 8, no 429s).

**The twin**, on the 88-sequence oracle ([day 0](reports/2026-09-26-twin-day0.md), [first align run](reports/2026-09-26-align-first-run.md)):

| Split | L3 at day 0 | L3 after 174 automatic patches | L4 after |
|---|---|---|---|
| train | 3.8% [2.5–5.9] (495) | 18.8% [15.6–22.5] (495) | 5.6% [2.2–13.4] (72) |
| held-out | 0.0% [0.0–3.3] (113) | 8.8% [4.9–15.5] (113) | 0.0% [0.0–19.4] (16) |

The noise pair covers templates #1–#15 only and is in-sample, so these scores have a floor and ceiling for part of the corpus only. Automation ratio so far: 174 automatic, 0 assisted (the assisted pass has not run live). The first nightly point is in `site/data/curve.json`; a scheduled nightly curve: `{{TBD: after B1 and B2}}`.

### Other servers

stripe-mock, as documented. Its README says: "stripe-mock does not attempt to reproduce the behavior of the real Stripe API at all. It cannot reject all invalid requests, and its responses are completely hardcoded." ([github.com/stripe/stripe-mock](https://github.com/stripe/stripe-mock)). On stateful sequences its score measures that documented design, not a defect. From the [baseline report](reports/2026-09-26-baseline.md) (normalization v1.2):

| Server | Sequences | L1 | L3 | L4 |
|---|---|---|---|---|
| stripe-mock (pinned digest, v0.205.0) | 88 | 80.9% | 1.3% | 0.0% [0.0–4.2] |
| localstripe 1.15.10 (the 6 templates it serves) | 20 | 58.1% | 3.4% | 0.0% [0.0–16.1] |

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

- `record` prints where it wrote each recording: under `$PARITY_DATA_DIR`, else `../parity-data` if it exists, else `recordings/`.
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
| Test clocks | create, retrieve, list, delete (deletes its customers, canceling their subscriptions), advance: renewals counted from the billing anchor, trial end and the `trial_will_end` notice, cancel at period end, a renewal draft finalized and charged an hour later, and payment retries. A clock's objects live at its frozen time. **Built from the public docs: no sandbox has recorded a clock yet, so this is not validated** |

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
