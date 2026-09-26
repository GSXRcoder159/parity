# Parity MVP: execution status

Authority: `docs/plan/2026-09-25-parity-mvp-plan.md`. This file is the live checklist; every session starts here.
Legend: `[x]` done and verified by running · `[~]` in progress · `[ ]` not started · **HUMAN** = only Adam can do it.

## Decisions taken at kickoff (2026-09-25)

- npm/CLI name: **`paritybench`** (`npx paritybench twin`, `npx paritybench bench <url>`). npm `parity` is an Ethereum lib and the GitHub `parity` org is taken. Brand stays "Parity".
- Repo: private `GSXRcoder159/parity` now; public at launch (ask Adam first).
- Stripe: claimable sandbox `acct_1UJKSxBXgzwfQJL7` provisioned via `stripe sandbox create --from-git` (email gsprog159@gmail.com). Key in `.env` (gitignored). **Expires 2026-10-02 unless claimed.**
- Outreach: Claude drafts, Adam sends.

## Blockers and HUMAN actions

| # | Action | Why | Deadline |
|---|---|---|---|
| B1 | **HUMAN:** claim the sandbox (`stripe sandbox claim` or the claim URL), then create a full `sk_test_` key and put it in `.env` as `STRIPE_API_KEY` | Claimable key (`rkcs_test_`) is refused on `/v1/test_helpers/test_clocks` and `/v1/account`; **it also has an undocumented request quota (tripped after ~577 requests in ~2 min on 2026-09-25; lifted within 18 min) that caps sustained throughput at roughly one 60-sequence corpus per window** (`reports/2026-09-25-w0-oracle.md`); sandbox is deleted 2026-10-02 | before W0 clock measurement; hard stop 2026-10-02 |
| B2 | **HUMAN:** add `STRIPE_API_KEY` (and later an LLM key) as GitHub repo secrets | Nightly cron (W3) | W2 end |
| B3 | **HUMAN:** send the 20 drafted messages in `docs/demand/outreach.md` (14 cohort A, 5 cohort B, Autumn); paste replies into `docs/demand/funnel.md` | H3; ≥5 replies by Oct 10 or shift to cohort B | now |
| B4 | **HUMAN:** ask Stripe Support (from the claimed account) whether the read-API allocation ("must not exceed an average of 500 per transaction", floor 10,000/30 days) applies to sandboxes, and whether sandbox test charges count as transactions. Draft: `docs/decisions/0001-clean-room-and-legal-gate.md` C2 | Until answered, the harness hard-caps sandbox GETs at 10,000 per rolling 30 days, which limits the nightly corpus size. Increases need ~6 weeks' notice | after B1 |
| B5 | **HUMAN:** counsel review of SSA §2.4 (reverse engineering), §4.2 + "Stripe Data" (our recordings), §1.2(a)(vi) (republication) before ANY public release (public repo, npm publish, score page, launch post). Option: Michigan Law's Zell Entrepreneurship Clinic (free for UM student ventures; check eligibility). Questions are listed in decision 0001 C7 | Legal gate verdict: GO WITH CONDITIONS for private work only | before Oct 15 launch; start by Oct 1 |

## W0 (Sep 26–28): gates and measurements

- [x] Stripe sandbox provisioned; API version reported by sandbox: `2026-08-26.dahlia`
- [x] Claimable-key coverage: customers, payment methods (`pm_card_visa` attach), prices/products, subscriptions, refunds, idempotency (same key + different params → error), customer search, webhook endpoints, events all work; **test clocks and `/v1/account` refused**
- [x] Invoice preview endpoint for the pinned version: `POST /v1/invoices/create_preview` (`GET /v1/invoices/upcoming` returns "deprecated")
- [x] `stripe/openapi` license: MIT; vendor only `/latest/openapi.spec3.json` pinned by commit SHA with the MIT notice (spec version = `2026-08-26.dahlia`)
- [x] Legal gate: SSA + Services Terms + Marks + rate-limits read from raw HTML → `docs/decisions/0001-clean-room-and-legal-gate.md`: **GO WITH CONDITIONS** (private work only; counsel before public release; ≤10,000 sandbox GETs/30 days; no raw Stripe data in git; no "Stripe" in product names)
- [x] Competitor terms: LocalStack ToS/MSA forbid benchmarking without written consent → not scored; Arga has no ToS → not scored without written permission; WonderTwin OSS twin is Connect-only → nothing to score. W1 baselines = stripe-mock (pinned digest) + localstripe 1.15.10
- [~] Sandbox cap: "up to five sandboxes" per account (verified). Concurrent test-clock cap: none documented, measure after B1. Claimable-sandbox counting: open (B1)
- [x] Throughput: non-clock sequences/hour at ≤20 req/s — c=8, two clean runs: **3,950/h and 4,436/h wall** (7,786 / 7,070 steps-phase), 7.5–7.7 req/seq, 1.95–2.18 GETs/seq, 0 429s. c=16 and a c=8 run 3 min later hit the claimable-key quota (450 / 516 429 retries); sustained volume capped by that quota until B1. `reports/2026-09-25-w0-oracle.md`
- [ ] Throughput: seconds per test-clock advance; parallel clocks (blocked on B1)
- [x] Raw noise floor: 60 sequences run twice (A vs D, c=8, 28 min apart; event sets 60/60 equal). Raw: L1 100%, L2 96.9%, L3 0.2%, L4 0%. Normalized v1.1: L3 92.4% [89.4–94.6] → **floor 7.6% [5.4–10.6]** (pagination 16%, errors 8.8%), L4 floor 35%. All 32 divergent steps trace to 6 causes (5 normalization gaps → v1.2; 1 async refund reference). Fails ≤3% under v1.1; re-measure at W1 exit
- [ ] Scenario templates 1–15
- [x] Outreach: 34 targets in `docs/demand/cohorts.md`, 20 fact-checked messages in `docs/demand/outreach.md`, tracker `docs/demand/funnel.md` (sending = B3)
- [x] Exit: go/no-go on "nightly" — **no-go today**: read budget allows ~150–170 seqs/night (1.95–2.18 GETs/seq; a 500-seq run ≈ 950–1,060 GETs → weekly), and the claimable key cannot sustain a corpus. Go after B1 (quota) + B4 (read cap). Throughput itself passes H0 ~8×

## Plan changes from W0 research (see `docs/research/2026-09-25-w0-verifications.md` §"Plan changes implied")
- Read-API allocation added to §4/§10: per-sequence event polling replaced by one sweep per corpus; GET ledger `budget/reads.jsonl`; nightly corpus sized to the budget until B4 is answered.
- Stripe's **endive** major release is expected ~2026-09-30: keep the pinned `Stripe-Version`; pin stripe-mock by image digest; H5 may see a real event in W1.
- H4 fallback estimate is ~2 days, not ≤1: pinned Python `stripe-agent-toolkit==0.6.1` with `stripe.api_base`.
- Raw recordings stay out of git (C3); public artifacts are scores, normalized divergence classes, and hashes.

## W1 (Sep 29–Oct 5): ParityBench + H1
- [ ] Harness: runner, refs, dual execution, recordings, normalization v1, four-level score with Wilson CIs, JSON + Markdown report
- [ ] Templates 16–30; corpus ≥500 sequences
- [ ] Baselines: stripe-mock, localstripe (surfaces each claims); Arga only if ToS permits
- [ ] `reports/2026-10-05-baseline.md` with noise floor + ceiling
- [ ] H1 decided

## W2 (Oct 6–12): twin scaffold + first curve points
- [ ] Event store, form parser, spec validation, error envelope, idempotency, `/v1/events`, webhooks, `/_parity/reset` (<50 ms), `/_parity/seed`
- [ ] Behavior modules: customers, products, prices, payment methods, subscriptions (create/cancel), invoices (retrieve/list), refunds
- [ ] Twin boots <1 s; L1 ≥80% on non-clock steps
- [ ] Nightly ParityBench run; per-stratum curve with "surface added" annotations

## W3 (Oct 13–19): align loop + launch
- [ ] Triage, localization, step minimization, mechanical auto-patch, LLM-assisted patch, held-out gate, sealed log
- [ ] Nightly GitHub Actions cron; score page on GitHub Pages; drift feed stub
- [ ] GitHub Action (boot twin in CI); README quickstart + Stripe "we recommend mocking" quote
- [ ] **HUMAN:** launch Show HN + X, Thu Oct 15 (Claude drafts)

## W4 (Oct 20–26): time, sim-to-real, fidelity push
- [ ] Test clocks + proration + subscription updates in twin; clock stratum scored
- [ ] `paritybench agree`; partner suite or Stripe-gym fallback; publish agreement
- [ ] MCP server; `verifiers` wrapper (only if W3 on time)
- [ ] H2, H4 decided; automation ratio published

## W5 (Oct 27–Nov 2): application
- [ ] Drift instrument live
- [ ] YC application draft (Claude); **HUMAN:** demo video, founder video, submit by Nov 2 8pm PT
- [ ] Pricing page ("proposed")

## Log
- 2026-09-25: kickoff; repo scaffolded; sandbox provisioned; W0 started.
- 2026-09-25: W0 research workflow done (legal gate, verifications, demand). Harness Tasks 1–3 done and reviewed; Task 4 (oracle hygiene) inserted; Tasks 4–5 running.
- 2026-09-25: Task 5: `paritybench` CLI (record/compare/bench/help, budget-gated sandbox runs, ledger `budget/reads.jsonl`). W0 runs: throughput passes on rate (~4,000 seq/h at c=8); claimable-key quota discovered (caps sustained volume → B1); noise floor 7.6% at L3 under v1.1 (v1.2 gaps listed); nightly no-go on read budget + quota. `reports/2026-09-25-w0-oracle.md`.
