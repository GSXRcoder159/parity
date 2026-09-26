# Parity

Parity measures how faithfully a Stripe-compatible server reproduces the real Stripe API, and ships an open-source twin of the Stripe Billing API that is measured the same way.

- **ParityBench** replays a corpus of API sequences (customers, subscriptions, refunds, errors, idempotency, events, …) against any Stripe-compatible base URL. It compares every response with a recording of the same sequence on the real Stripe sandbox, and reports agreement at four levels, with 95% confidence intervals and the noise floor of the sandbox itself.
- **The Parity twin** is a stateful Billing server in plain Node, with no dependencies, for fast and isolated tests. ParityBench scores it against the sandbox every night, and an alignment loop patches it toward the sandbox.

**Status: pre-release.** The nightly pipeline and the alignment loop are being built, and no score is published yet. The numbers below are the ones measured so far; the rest are marked `{{TBD}}`.

## Quickstart

### Run the twin

```sh
npx paritybench twin                  # http://127.0.0.1:12111
```

The package is not on npm yet. From a checkout (Node ≥ 22.18, nothing to install), run `node src/cli.ts twin [--port 12111] [--host 127.0.0.1]`.

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
paritybench bench http://127.0.0.1:12111 --oracle oracle.jsonl --noise noise.jsonl
```

`--oracle` is a sandbox recording of the corpus, and `--noise` is a second one, for the noise floor. Recordings are not distributed: they are data from a Stripe account. Record your own with your own sandbox key (see [Reproduce](#reproduce-with-your-own-sandbox-key)).

## Method

**Corpus.** 26 templates in 9 strata: lifecycle, pagination, cancellation, refunds, errors, idempotency, events, proration and boundaries. The full corpus runs each template with seeds 1–20: 520 sequences. Five templates are **held out**: `subscription-cancel-at-period-end`, `refund-partial-then-rest`, `invalid-params`, `subscription-update-quantity` and `boundaries-list-limits`. They never feed the alignment loop; they only gate its patches. Test-clock templates wait for a claimed sandbox.

**Four levels.**

| Level | Agreement means | Unit |
|---|---|---|
| L1 status | same HTTP status | step |
| L2 shape | same type skeleton of the body | step |
| L3 value | same normalized body | step |
| L4 sequence | every step agrees at L3, and the same multiset of event types | sequence |

**Confidence intervals.** Every number is a 95% Wilson interval, reported with its n.

**Noise floor and ceiling.** Two real sandbox recordings of the same sequences are compared with the same harness. The noise floor is 1 − their agreement. The ceiling is their agreement: the best score any server can reach against that oracle. **Any score without the noise floor and ceiling is invalid.**

**Normalization.** Versioned rules rewrite run-specific values so that two faithful runs compare equal: ids, timestamps, run nonces, secrets, hosted URLs, per-account and card-network opaques, dashboard links and the unclaimed-sandbox banner. List order is compared as returned. Each rule states what it can hide. The rules and their rationale are in [`src/bench/normalize.ts`](src/bench/normalize.ts) (currently v1.2), and every score carries its normalization version.

**Rolling oracle.** The sandbox read allocation does not allow re-recording the whole corpus every night. Each night re-records a rotating seventh of the corpus and scores the twin on the whole corpus against the latest recording of each sequence. So the twin is scored nightly against an oracle that is at most 7 days old; drift on any sequence is detected within 7 days. Drift compares a night's slice with the previous recording of the same sequences, on paths outside the noise set.

**Alignment loop and automation ratio.** After the scaffold freeze (tag `twin-scaffold-v0`), every change to the twin is logged in a hash-chained log as one of three classes:
- **automatic:** it edits only data files (`src/twin/shapes/*.json`, `src/twin/errors.json`), for a value the oracle shows deterministically. It is applied when the held-out gate passes.
- **assisted:** a code change proposed by the loop and merged after review.
- **surface added:** new scope, such as test clocks. It is annotated on the curve so that a coverage jump is never read as alignment.

The automation ratio is automatic ÷ (automatic + assisted).

### Measured so far

**Noise floor, W0 (2026-09-25), normalization v1.1.** Templates 1–15 × seeds 1–4 (60 sequences, 420 steps), two clean sandbox runs 28 minutes apart ([report](reports/2026-09-25-w0-oracle.md)):

| Level | Agreement = ceiling | Floor |
|---|---|---|
| L1 status | 100.0% [99.1–100.0] (420) | 0.0% |
| L2 shape | 96.9% [94.8–98.2] (420) | 3.1% |
| L3 value | 92.4% [89.4–94.6] (420) | 7.6% |
| L4 sequence | 65.0% [52.4–75.8] (60) | 35.0% |

All 32 steps that disagree trace to 6 causes, and normalization v1.2 addresses them. v1.2 on a pair recorded after it: `{{TBD: v1.2 noise floor on an out-of-sample pair}}`.

**Throughput, W0.** 3,950 and 4,436 sequences per hour (wall time, concurrency 8, no 429s).

**The twin.** Day-0 scaffold score: `{{TBD: score-twin on oracle v1, L1–L4 per stratum, train vs held-out}}`. Nightly curve and automation ratio: `{{TBD: first nightly run}}`.

### Other servers

stripe-mock, as documented. Its README says: "stripe-mock does not attempt to reproduce the behavior of the real Stripe API at all. It cannot reject all invalid requests, and its responses are completely hardcoded." ([github.com/stripe/stripe-mock](https://github.com/stripe/stripe-mock)). On stateful sequences its score measures that documented design, not a defect. Scores: `{{TBD: stripe-mock and localstripe from the final W1 baseline report}}`.

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
- The harness paces sandbox traffic at 20 requests per second or less. It counts every `GET` against `PARITY_READ_BUDGET` (default 10,000 per rolling 30 days, the minimum read allocation on the rate-limits page) in `budget/reads.jsonl`.
- On an unclaimed (claimable) sandbox key, leave about 20 minutes between the two runs: that key has an undocumented request quota.
- `node src/cli.ts help` lists every flag.
- The outputs of `record`, `compare`, `bench` and `score-twin` contain response values from your account. Keep them private.

## Supported surface of the twin

API version `2026-08-26.dahlia`.

| Resource | Supported |
|---|---|
| Customers | create, retrieve, update, delete, list, search; list a customer's payment methods |
| Products, prices | create, retrieve, update, list |
| Payment methods | retrieve, list, attach, detach; test ids such as `pm_card_visa` and `pm_card_chargeDeclined` |
| Subscriptions | create (first invoice and synchronous payment), retrieve, list, cancel; update `cancel_at_period_end`, `default_payment_method`, `description`, `metadata` |
| Invoices | retrieve, list (subscriptions create them) |
| Payment intents, charges | retrieve, list (payment attempts create them) |
| Refunds | create, retrieve, list |
| Events | retrieve, list |
| Webhook endpoints | create, retrieve, update, delete, list; signed deliveries (`Stripe-Signature`) with 3 retries |

Across every route:
- Form-encoded parameters are validated against the OpenAPI spec, and unknown ones are rejected.
- It supports `expand[]`, cursor pagination (`limit`, `starting_after`, `ending_before`), `Idempotency-Key` and the error envelope.
- Error responses carry a `Parity-Error-Key` header.
- The `Parity-Now: <unix seconds>` header sets the clock for a request.
- Control endpoints: `POST /_parity/reset`, `POST /_parity/seed`, `GET /_parity/state`.

**Not yet:** these answer `400 not_implemented` rather than dropping a parameter silently.
- Invoice update, delete, finalize, pay and void, and `create_preview`.
- Subscription item, price and quantity changes, proration, trials, billing anchors and discounts: any create or update parameter outside the lists above.
- Cancel with `invoice_now` or `prorate`.
- Webhook endpoints with `connect`.
- Test clocks.

## License and pledge

Apache-2.0 ([LICENSE](LICENSE)).

**Pledge: the alignment loop and the score stay open.** The code that aligns the twin, and the method and numbers of the score, will remain open source and public. Raw sandbox recordings are the one exception: they are data from a Stripe account, so they are never published. What is published is scores, counts, divergence paths and classes, the normalization version, and hashes of the recordings.

Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc. Stripe is a trademark of Stripe, Inc.
