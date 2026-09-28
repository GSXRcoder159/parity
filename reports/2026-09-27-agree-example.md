# ParityBench agree: twin vs sandbox on the example suite

**Example suite, not a partner suite.** This is **not the H4 number**: H4 is the LLM-agent evaluation, which waits on the LLM budget confirmation.

**Headline.** The 8-test example suite (`examples/agree-suite/billing.test.mjs`) gives the same outcome on the twin and on the real sandbox for every test: **8/8 pass on each, agreement 100.0% (8/8; 95% Wilson CI 67.6%–100.0%)**. With 8 tests, the interval's lower bound is 67.6%, so this result shows that `agree` works end to end on both targets. It is not evidence of 100% fidelity.

| | |
|---|---|
| Date | 2026-09-28, 03:54:25–03:54:32 UTC (the filename's 2026-09-27 is the plan's date) |
| Command | `PARITY_DATA_DIR=../parity-data node src/cli.ts agree --cmd "node --test --test-reporter=tap examples/agree-suite/billing.test.mjs" --runs twin,sandbox --out reports/2026-09-27-agree-example`, run from the repo root (`.env`) |
| Twin | in process, on an ephemeral port, at `602d95a` (after the 2026-09-28 align commit `ae1343c`), key `sk_test_parity` |
| Sandbox | `https://api.stripe.com` through `agree`'s metered proxy: the shared 20 req/s limiter, counted by method, budget-gated, ledgered. The key is `.env`'s `STRIPE_API_KEY`, the claimed `sk_test_` key (B1). API version `2026-08-26.dahlia` is sent by the suite |
| Sandbox traffic | **1 GET**, 9 POST, 1 DELETE (run `20260928T035425-rmuk`, ledger `../parity-data/budget/reads.jsonl`). 1 GET was projected, and it matched. The rolling 30-day GETs went from 3,725 to **3,726 / 10,000**. There were no 429s and the proxy did not halt the run |
| LLM spend | $0 (no LLM in `agree`) |

What the suite does: create a customer, attach `pm_card_visa` as the default payment method, create a monthly price, subscribe and charge the first invoice, preview a price change with proration (`create_preview`), apply it, cancel, and refund the first payment. Each test asserts the HTTP status and a few fields.

The report holds only test names and outcomes. Nothing the command printed is kept (decision 0001 C3).

## Result

8 tests · twin: 8 pass, 0 fail, 0 skip · sandbox: 8 pass, 0 fail, 0 skip

**Agreement: 100.0%** (8/8 tests; 95% Wilson CI 67.6%–100.0%)

## Disagreeing tests (0)

none

## Tests

| test | twin | sandbox |
|---|---|---|
| creates a customer | pass | pass |
| attaches a card as the default payment method | pass | pass |
| creates a monthly price | pass | pass |
| subscribes the customer and charges the first invoice | pass | pass |
| previews a price change with a credit for unused time | pass | pass |
| applies the price change | pass | pass |
| cancels the subscription | pass | pass |
| refunds the first payment | pass | pass |

## Caveats

1. **Not independent.** The example suite was written in this repo next to the twin, and it was known to pass 8/8 on the twin before this run. A partner's own suite is the real test (B3).
2. **Outcome-level only.** A test that passes on both targets means that its few assertions hold on both, not that the responses match. Response-level fidelity is ParityBench's L1–L4. On oracle v1 (`reports/2026-09-27-twin-v1.md`) the twin scores train L3 26.8% after the align run, and held-out L3 18.1%.
3. **Small n, one run per target.** 8 tests give a Wilson lower bound of 67.6%. The sandbox's run-to-run flakiness on this suite is not measured.
4. **Not H4, and not published.** The score page does not carry this number. Publishing an agreement waits on a partner suite (B3) and the launch gate (B5).
