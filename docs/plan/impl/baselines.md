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
# NOT YET RUN (quota): the rest of the corpus, one run per cleared quota window (see "Pacing" below):
#   #16-#26 x seeds 1-4 again, then:
#   node src/cli.ts record --target sandbox --name w1-s<k>of7 --seeds 5-20 --slice <k>/7     # k = 0..6

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
