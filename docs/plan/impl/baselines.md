# Baselines: exact commands (W1, 2026-09-26)

These are the commands behind `reports/2026-09-26-baseline.md`, run from the repo root.
- Raw recordings live in the private data dir (`PARITY_DATA_DIR`, here `../parity-data`).
- Every `compare`/`bench` output and oracle subset goes under the gitignored `recordings/<date>/`. They all hold Stripe response values (decision 0001 C3).
- Only `reports/2026-09-26-baseline.{md,json}` is committed.

```sh
P=../parity-data          # PARITY_DATA_DIR default when the sibling exists
D=recordings/2026-09-26   # gitignored
```

## 1. Oracle (sandbox, budget-gated)

The key is still the claimable `rkcs_test_…` key (B1 not done), so recording is paced (brief step 0).

```sh
# The attempt made (both aborted by the claimable-key quota; flagged recordings are excluded by oracle build):
node src/cli.ts record --target sandbox --name w1-late \
  --templates invoice-preview-proration,subscription-update-price,subscription-update-quantity,invoice-send-invoice,boundaries-amounts,boundaries-list-limits,expand-paths,customer-search,webhook-endpoint-crud,idempotency-errors,customer-delete-cascade \
  --seeds 1-4 --chunk 50 --chunk-wait 20
# Never run: the quota plan below was superseded by B1 (claimed key); oracle v1 was recorded unchunked (§6).

node src/cli.ts oracle build     # -> $P/oracle.jsonl, newest clean recording per sequence
```

The oracle behind the report is 88 sequences:
- W0 run D: #1–#15 × seeds 1–4.
- Task 2's `sandbox-20260926T012758-uxv2`: #16–#26 × 1–2.
- Task 2's `sandbox-20260926T012914-57wc`: #17, #19, #22 × 3–4.

**Pacing.** On the claimable key, the brief's `--chunk 50 --chunk-wait 20` (W0's "~460 requests per 20 min") is not enough. On 2026-09-26 the quota refused runs 27 min and 31 min after a clean run of 197 requests, and it did not reset on the clock hour.

Check first with one side-effect-free POST, which is not a read:
```sh
set -a; . ./.env; set +a      # STRIPE_API_KEY
curl -s -o /dev/null -w '%{http_code}\n' -X POST -u "$STRIPE_API_KEY:" -H 'Stripe-Version: 2026-08-26.dahlia' \
  https://api.stripe.com/v1/customers/cus_ParityQuotaProbe
```
404 means clear, 429 means wait. With a claimed `sk_test_` key none of this applies: run `record --target sandbox --seeds 1-20` once.

## 2. Noise floor (no sandbox traffic)

```sh
node reports/baseline.ts pair $P/oracle.jsonl $D/w1-noise-oracle.jsonl $D/w1-noise-partner.jsonl \
  $P/runs/2026-09-25/noise-a-20260925T233315-zdmc.jsonl \
  $P/runs/2026-09-26/sandbox-20260926T012758-uxv2.jsonl
node src/cli.ts compare --oracle $D/w1-noise-oracle.jsonl --target $D/w1-noise-partner.jsonl --out $D/w1-noise
```

`pair` keeps a partner only if it is a clean recording with a different `runId` than the oracle's recording of that sequence. With today's oracle that leaves 60 pairs: A vs D. (The data repo renamed the W0 runs A and D to `runs/2026-09-25/noise-a-20260925T233315-zdmc.jsonl` and `runs/2026-09-26/noise-b-20260926T000140-m0x6.jsonl`; the oracle holds D's recordings, so only A is named above.) The uxv2 recordings are themselves the oracle for #16–#26 × 1–2. Once a fresh #16–#26 × 1–2 run lands, the same command pairs it with uxv2.

When this was written, `bench --noise` needed a partner for every oracle sequence and the pair covers only a subset, so the noise floor was computed separately and `summarize` applied its `template|step|path` keys to the target divergences. Since the final review (2026-09-26), `bench`, `score-twin` and `compare` accept a noise recording that covers part of the oracle: the floor is measured on the covered sequences and the report states the coverage (`score-twin --noise $P/runs/2026-09-26/noise-b-20260926T000140-m0x6.jsonl` covers 60 of 88). Scores do not depend on the noise keys; they only relabel divergences as NONDETERMINISTIC.

## 3. stripe-mock (pinned by digest)

```sh
docker run --rm -d --name parity-stripe-mock -p 12111-12112:12111-12112 \
  stripe/stripe-mock@sha256:ff32647993847be491e68533e2881c90434fa8d5df40246ee5f7d41253422081
curl -s -D - -o /dev/null -u sk_test_parity: 'http://localhost:12111/v1/customers?limit=1' | grep Stripe-Mock-Version   # 0.205.0
node src/cli.ts bench http://localhost:12111 --oracle $P/oracle.jsonl --out $D/w1-bench-stripe-mock
docker rm -f parity-stripe-mock
```

To check the embedded API version, run the same image with `-strict-version-check` on another port. Then send `Stripe-Version: 2000-01-01`. The error names the spec version (`2026-08-26.dahlia`).

## 4. localstripe 1.15.10 (its surface only)

Run it on the same UTC day as the oracle recordings, because localstripe uses the wall clock.

```sh
uvx --from localstripe==1.15.10 localstripe --from-scratch &        # :8420, any sk_ key
# Its README lists no endpoints, so the surface is its served route table:
uvx --from localstripe==1.15.10 python -c "
from localstripe.server import app
for r in app.router.routes():
    p = r.resource.get_info().get('path') or r.resource.get_info().get('formatter')
    if p and p.startswith('/v1/'): print(r.method, p)
" | sort -u > $D/localstripe-routes.txt                              # 127 routes
node reports/baseline.ts surface $D/localstripe-routes.txt $P/oracle.jsonl $D/w1-oracle-localstripe.jsonl
node src/cli.ts bench http://localhost:8420 --oracle $D/w1-oracle-localstripe.jsonl --out $D/w1-bench-localstripe
pkill -f 'localstripe'
```

`surface` prints each excluded template with its missing endpoints. It writes the oracle restricted to the included templates: customer-crud, customer-list-pagination, payment-method-attach, idempotency-replay, boundaries-list-limits and idempotency-errors.

## 5. Report JSON (values stripped)

```sh
node reports/baseline.ts summarize --oracle $P/oracle.jsonl --noise $D/w1-noise.json \
  --out reports/2026-09-26-baseline.json \
  stripe-mock=$D/w1-bench-stripe-mock.json localstripe=$D/w1-bench-localstripe.json > $D/w1-summary.md
```

`summarize` refuses to write if any `expected`/`actual` key would reach the output. It prints the Markdown tables that the report uses.

Check the script's types. `reports/` is outside `tsconfig.json`'s `include`, so check it explicitly:

```sh
npx tsc --noEmit --strict --noUncheckedIndexedAccess --verbatimModuleSyntax --module nodenext --moduleResolution nodenext \
  --allowImportingTsExtensions --target es2023 --types node --skipLibCheck reports/baseline.ts
```

## 6. Oracle v1 and the full noise pair (2026-09-28 UTC, claimed key)

B1-unblock Task 2 (`docs/plan/impl/2026-09-27-b1-unblock.md`). The key is the claimed `sk_test_` key, so there is no chunking. Every run used concurrency 8, the sandbox's 20 req/s limiter, the circuit breaker (10 consecutive 429s), and the budget gate and ledger. The runs ran one after another and land in `$P/runs/2026-09-28/`.

**Missing set, projected first.** A scratch script (not committed) applied `oracle build`'s rule (the newest clean sandbox recording per sequence) and `score-twin`'s staleness check (step count and methods equal to today's template). It printed only template names, seeds and counts. The result: 96 clean and current recordings, 0 stale, so 504 missing.
- #1–#15, #17, #19, #22: seeds 5–20.
- #16, #18, #20, #21, #23–#30: seeds 3–20.

It used `recordCorpus`'s projection (GET steps + ceil(10.5 × n / 100) × 5 sweep pages). For the six runs below that is 1,462 GETs against a rolling total of 2,338, so 3,800 after, under the 8,000 stop line.

The clock templates ran separately from the fast ones. A circuit-breaker trip flags every recording of its run, and #30 is the one template with a known 429 source (DELETE of a clock still advancing), so it ran alone.

```sh
node src/cli.ts record --target sandbox --name oracle-v1 \
  --templates customer-crud,customer-list-pagination,product-price-crud,payment-method-attach,subscription-create,subscription-cancel-now,subscription-cancel-at-period-end,refund-full,refund-partial-then-rest,refund-over-and-negative,resource-missing,invalid-params,card-declined,idempotency-replay,subscription-events,subscription-update-price,invoice-send-invoice,expand-paths \
  --seeds 5-20 --concurrency 8
node src/cli.ts record --target sandbox --name oracle-v1 \
  --templates invoice-preview-proration,subscription-update-quantity,boundaries-amounts,boundaries-list-limits,customer-search,webhook-endpoint-crud,idempotency-errors,customer-delete-cascade \
  --seeds 3-20 --concurrency 8
node src/cli.ts record --target sandbox --name oracle-v1 \
  --templates clock-period-rollover,clock-trial-end,clock-cancel-at-period-end --seeds 3-20 --concurrency 8
node src/cli.ts record --target sandbox --name oracle-v1 --templates clock-declined-renewal --seeds 3-20 --concurrency 8
# Noise pair, after the oracle runs, back to back (the names nightly's noiseFloor pairs: newest noise-b, newest noise-a before it):
node src/cli.ts record --target sandbox --name noise-a --seeds 1-2 --concurrency 8
node src/cli.ts record --target sandbox --name noise-b --seeds 1-2 --concurrency 8
node src/cli.ts oracle build
```

| Run (`runs/2026-09-28/`) | Sequences | Clean | Projected GETs | GETs (ledger) | Requests | 429 retries | Wall |
|---|---|---|---|---|---|---|---|
| `oracle-v1-20260928T002614-7ffj` | 288 | 288 | 608 | 492 | 2,065 | 0 | 172 s |
| `oracle-v1-20260928T002937-309q` | 144 | 144 | 242 | 177 | 892 | 0 | 232 s |
| `oracle-v1-20260928T003341-c9tz` (#27–#29) | 54 | 54 | 228 | 215 | 629 | 0 | 415 s |
| `oracle-v1-20260928T004053-8kya` (#30) | 18 | 18 | 100 | 100 | 280 | 0 | 1,956 s |
| `noise-a-20260928T011354-l3w0` | 60 | 60 | 142 | 118 | 460 | 0 | 727 s |
| `noise-b-20260928T012601-q5kb` | 60 | 60 | 142 | 118 | 460 | 0 | 727 s |
| **Total** | 624 | 624 | 1,462 | 1,220 | 4,786 | 0 | 70 min |

Rolling 30-day sandbox GETs went from 2,338 to 3,558 of 10,000. There was no LLM spend. noise-b started as soon as noise-a ended (01:26:01 UTC, ~1 s after). Each noise run takes ~12 min, set by #30's waits (40 s after the first advance, 600 s after the declined one).

**`oracle build`:** 600 sequences, every template at 20, none unclean. It read 1,062 sandbox recordings in 16 files. It excluded 282 contaminated ones, all from the aborted claimable-key runs of 2026-09-25/26: W0 runs B and C (60 + 60), both `w1-late` attempts (44 + 44), and the nightly slice `v6sg` (74). The newest recording wins, so the oracle's seeds 1–2 are **noise-b's** recordings. Sources:
- noise-b-q5kb: 60 (all templates × 1–2).
- The four oracle-v1 runs: 504.
- Reused from oracle v0: 30 from W0 run D (`runs/2026-09-26/noise-b-20260926T000140-m0x6.jsonl`, #1–#15 × 3–4) and 6 from `sandbox-20260926T012914-57wc` (#17, #19, #22 × 3–4).

The oldest recording started 2026-09-26T00:01:40Z. `$P/oracle.jsonl` has sha256 `e1584d740e11aef1a7318a8868414b7891c68605404804acb225b81001fb1bff`. It spans all 10 strata and holds 120 held-out sequences (6 templates × 20).

**Checks beyond "clean".**
- Non-held-out templates only: every step-status vector of today's six runs also occurs in an earlier clean recording (oracle v0, W0 run A, or Task 1's clock validation run), except one, which is another seed branch of its template. The one new vector is card-declined seeds 10 and 20: no default-payment-method step and `payment_behavior=error_if_incomplete`, so the subscription create answers 402. The intended errors (400/402/404) sit where the templates put them.
- Every clock retrieve of #27, #29 and #30 read `ready`: seeds 3–20 in the oracle-v1 runs, and seeds 1–2 in both noise runs.
- The held-out templates (#7, #9, #12, #18, #21, #28) were checked only through `oracle build`'s contamination predicate, by sequence id.

**For Task 3's noise floor.** The pair is oracle vs `--noise $P/runs/2026-09-28/noise-a-20260928T011354-l3w0.jsonl`. It covers 60 of the 600 sequences, all 30 templates, and is out of sample for normalization v1.3. Nightly's `noiseFloor` pairs the same two files.
