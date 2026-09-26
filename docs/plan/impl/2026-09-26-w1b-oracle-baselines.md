# Implementation plan: W1 completion — oracle store, templates 16–26, baselines, H1

Spec (authority): `docs/plan/2026-09-25-parity-mvp-plan.md` §3.1, §5 W1, §7, §8. Binding decisions: `docs/decisions/0001-clean-room-and-legal-gate.md` (C2 read budget, C3 no raw Stripe data in any repo that will become public, C5 third parties), `docs/decisions/0002-twin-architecture-and-rolling-oracle.md` (§1 rolling oracle, §4.4 `Parity-Now`, §5 data locations). Prior harness plan and ledger: `docs/plan/impl/2026-09-25-w0-w1-harness.md`. Sandbox knowledge: `docs/plan/impl/templates-validation.md`, `reports/2026-09-25-w0-oracle.md`.

## Global Constraints

- Same engineering constraints as the harness plan's Global Constraints (Node ≥22.18 type stripping, `.ts` imports, `import type`, `npx tsc` passes, `node --test`, no new runtime deps, ponytail minimalism, commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, stage only your paths, retry on `index.lock`).
- **Data location:** raw recordings live in the private data repo checked out at `PARITY_DATA_DIR` (env), defaulting to `../parity-data` relative to the repo root when that directory exists, else `recordings/` (gitignored). Never write raw recordings into the parity repo's tracked files. Do not edit `.env`.
- **Read budget:** every sandbox run goes through the CLI's budget gate and appends to `budget/reads.jsonl`. Stop and report if a run would exceed it.
- **Sandbox hygiene:** ≤20 req/s via the shared limiter; unique `runId` per run.
- Another workflow (twin scaffold) commits `src/twin/*`, `scripts/*`, `Dockerfile`, `test/twin-*.test.ts` in the same tree concurrently. Never touch those.

## Task 1: Oracle store, incremental sweep, per-sequence headers, slices

**Paths:** `src/bench/run.ts`, `src/bench/oracle.ts`, `src/bench/normalize.ts`, `src/cli.ts`, `test/run.test.ts`, `test/oracle.test.ts`, `test/normalize.test.ts`, `test/cli.test.ts`, `test/compare.test.ts`, `test/score.test.ts`

1. **Incremental event sweep.** The corpus sweep's first pass lists all events since `corpusStartSec-60`; each repeat pass fetches only events newer than the newest seen (`ending_before=<newest event id>`, following pagination), stopping when a repeat pass returns nothing new twice in a row or 30 s elapse. Report `eventSweepGets` in the run summary (it must be ≈ pages of events, not pages × repeats). Test against the local fake server.
2. **Per-sequence headers.** `runCorpus` accepts `headersFor?: (seq: Sequence) => Record<string, string>`; those headers are sent on every step of that sequence and recorded like step headers.
3. **Clock from oracle.** `paritybench bench <url> --oracle <file>` sends `Parity-Now: <epoch seconds of the oracle recording's startedAt>` per sequence (via `headersFor`). Other targets ignore the header.
4. **Oracle store** (`src/bench/oracle.ts`): `dataDir()` resolves `PARITY_DATA_DIR` per Global Constraints; `record` against the sandbox writes to `<dataDir>/runs/<YYYY-MM-DD>/<name>-<runId>.jsonl` by default; `paritybench oracle build [--max-age-days N]` scans `<dataDir>/runs/**` sandbox recordings and writes `<dataDir>/oracle.jsonl` = the newest recording per `seq` (optionally only those newer than N days), printing counts per template and the oldest/newest dates. Migrate any existing sandbox recordings under `recordings/` into `<dataDir>/runs/<date>/` (copy, keep names).
5. **Slices.** `record --slice k/n` keeps only corpus sequences whose index (in `buildCorpus` order) ≡ k (mod n).
6. **Circuit breaker and pacing** (W0 report "Harness follow-ups"): abort a corpus after 10 consecutive steps that ended 429 after all retries (still ledger what was sent; recordings of unfinished sequences are written but flagged); record `Stripe-Rate-Limited-Reason` and `Retry-After` response headers when present. `record --chunk <n> --chunk-wait <minutes>` runs the corpus in chunks of n sequences with a wait between chunks (for the claimable key's undocumented quota: ~460 requests per ~20 min is safe). The pre-run GET projection scales with expected events: template GET steps + ceil(10.5 × sequences / 100) × 5 sweep passes.
7. **Normalization v1.2** (W0 report "Nondeterministic paths"; bump `NORMALIZATION_VERSION`, update RULES rationales): (a) drop the key `error.request_log_url` (dashboard link; absent on responses that carry the unclaimed-sandbox banner); (b) `updated` is a timestamp key; (c) opaque values: `payment_method_details.card.authorization_code`, `network_transaction_id`, `transaction_link_id`, and `outcome.risk_score` (fraud/risk field; never published); (d) drop the keys `reference`, `reference_status`, `reference_type` under `destination_details.card` of refunds (random and assigned asynchronously); (e) **remove the list-order sort (rule 7) entirely** — Ruling: Stripe lists are deterministic (created desc, same-second ties in reverse insertion order, per templates-validation.md); the W0 pagination noise was created by the sort's tie-break reordering same-second elements, so comparing lists as returned is both stricter and quieter. Keep the rule list documenting that list order is compared as-is. Re-run `compare` on the W0 A/D recordings (under `recordings/` or the data dir) and put the new normalized floor in your report.
8. **Oracle build excludes contaminated runs:** a recording with any step `status` 0 or 429, or with `eventsError`, is never selected as the oracle for its sequence.
9. **Twin subcommand wiring is NOT in this task** (the twin workflow's `src/twin/main.ts` may not exist yet).
10. After finishing, commit the data repo changes too: `git -C <dataDir> add -A && git -C <dataDir> commit -m "..." && git -C <dataDir> push` (private repo; recordings only).

Tests: incremental sweep page count, `headersFor` applied and recorded, `oracle build` picks newest per seq from fixture runs, slice filter, `dataDir` resolution.

## Task 2: Scenario templates #16–#26 and validation

**Paths:** `templates/*.ts`, `test/corpus.test.ts`, `docs/plan/impl/templates-validation.md`
**Depends on:** Task 1.

Implement catalog rows #16–#26 from the harness plan (`docs/plan/impl/2026-09-25-w0-w1-harness.md`, Task 2 catalog), keeping all the template rules there (fresh objects, scoped lists, `created[gte]=$c1.created` guard with any `email=` list, `$run` only in idempotency keys, ≤5 invoices per subscription, no clocks). Additions from W0 research:
- #16 also probes `POST /v1/invoices/create_preview` with `customer` only (expect 400) and `GET /v1/invoices/upcoming?customer=` (expect the deprecation error).
- #20: pass any decimal amounts (e.g. `unit_amount_decimal`) as **strings**, never JS numbers.
- #24: never list webhook endpoints unscoped (the list is account-global): create → retrieve → update → delete → retrieve deleted.
- #23: customer search is eventually consistent; put a `waitMs` before the search step and document the observed lag; it is expected to be noisy.
Validate live: each of #16–#26 × seeds 1–2 via `paritybench record --templates … --seeds 1-2` (budget-gated) and confirm each step's intended status; extend `docs/plan/impl/templates-validation.md` with rows and new behavior learned. Update `test/corpus.test.ts` counts.

## Task 3: Oracle v1, baselines, and the W1 baseline report (H1)

**Paths:** `reports/`, `budget/`, `docs/plan/STATUS.md`, `docs/plan/impl/baselines.md`
**Depends on:** Tasks 1–2.

0. **Key check:** if `.env` now holds a claimed `sk_test_` key (B1 done), run without chunking and also run the W0 clock checks listed in `docs/research/2026-09-25-w0-verifications.md` (clock advance seconds, parallel clocks, events for clock transitions) and record them in the report. Otherwise use `--chunk 50 --chunk-wait 20` (the claimable-key quota) and run long recordings in the background, polling for completion.
1. **Oracle v1 on the sandbox:** the non-clock corpus = templates #1–#26 × seeds 1–20 (≈520 sequences). Reuse existing W0 recordings of #1–#15 seeds 1–4 (already in the data dir); record the rest (budget-gated; expect ~1,500 GETs). Then `oracle build`.
2. **Noise:** templates #16–#26 × seeds 1–2 recorded a second time back-to-back with their Task 2 validation run or a fresh pair (W0 A/B already covers #1–#15); normalized noise floor per stratum over all 26 templates.
3. **Baselines** (plan §7, decision 0001 C5):
   - stripe-mock pinned by digest (see `docs/research/2026-09-25-w0-verifications.md` for the digest and run command; `:latest` moves to the next major version): `bench http://localhost:12111 --oracle <dataDir>/oracle.jsonl --noise …` over the whole corpus.
   - localstripe 1.15.10 via `uvx --from localstripe==1.15.10 localstripe` (port 8420): score only templates whose every endpoint is in its documented surface (compute from each template's steps; list included/excluded templates in the report). Record and compare the same day as the oracle refresh (localstripe uses the wall clock).
   - Stop all containers/processes afterwards.
4. **Report** `reports/2026-09-26-baseline.md` (use the actual date): method (corpus, seeds, strata, normalization version and rule names), oracle date range, noise floor and ceiling per level and stratum, per-target scores per stratum on the surfaces each claims with Wilson CIs, top divergence classes per target **without raw values** (C3: paths, classes and counts only), stripe-mock framed "as documented" (quote its README: stateless by design), each target's API version, reproduce instructions (anyone with their own sandbox key can re-run `paritybench record` + `bench`), and the **H1 verdict** (best existing twin <80% sequence-level agreement on the stateful/error corpus → confirmed). Save the machine-readable output as `reports/2026-09-26-baseline.json` with values stripped.
5. `docs/plan/impl/baselines.md`: exact commands used for each baseline (reproducible).
6. Tick the W1 lines in `docs/plan/STATUS.md` with measured numbers; H1 decided.
