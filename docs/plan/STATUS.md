# Parity MVP: execution status

Authority: `docs/plan/2026-09-25-parity-mvp-plan.md`. This file is the live checklist; every session starts here.
Legend: `[x]` done and verified by running · `[~]` in progress · `[ ]` not started · **HUMAN** = only Adam can do it.

## Decisions taken at kickoff (2026-09-25)

- npm/CLI name: **`paritybench`** (`npx paritybench twin`, `npx paritybench bench <url>`). npm `parity` is an Ethereum lib and the GitHub `parity` org is taken. Brand stays "Parity".
- Repo: private `GSXRcoder159/parity` now; public at launch (ask Adam first).
- Stripe: claimable sandbox provisioned via `stripe sandbox create --from-git` (its account id and email are kept out of this repo: the read ledger in `../parity-data/budget/` names the account). Key in `.env` (gitignored). **Expires 2026-10-02 unless claimed.**
- Outreach: Claude drafts, Adam sends.

## Blockers and HUMAN actions

| # | Action | Why | Deadline |
|---|---|---|---|
| B1 | **HUMAN — NOW THE CRITICAL PATH:** claim the sandbox (`stripe sandbox claim` or the claim URL), then create a full `sk_test_` key and put it in `.env` as `STRIPE_API_KEY` | Claimable key (`rkcs_test_`) is refused on `/v1/test_helpers/test_clocks` and `/v1/account`; **it also has an undocumented request quota (tripped after ~577 requests in ~2 min on 2026-09-25; lifted within 18 min) that caps sustained throughput at roughly one 60-sequence corpus per window** (`reports/2026-09-25-w0-oracle.md`); sandbox is deleted 2026-10-02. **Since 2026-09-26 01:56 UTC the claimable key is refused on every request (still 429 at 04:09), so no sandbox recording is possible at all:** the 520-sequence oracle, the #16–#26 noise pair, clock templates #27–#30, clock throughput and the nightly slice all wait on this | **now**; hard stop 2026-10-02 |
| B2 | **HUMAN:** GitHub repo secrets on `GSXRcoder159/parity`: `STRIPE_API_KEY` (claimed `sk_test_`), `ANTHROPIC_API_KEY`, `PARITY_DATA_TOKEN` (fine-grained PAT, contents read/write on `GSXRcoder159/parity-data`). Also put `ANTHROPIC_API_KEY` in local `.env` | Nightly cron + LLM-assisted patches (W3) | before first nightly |
| B3 | **HUMAN:** send the 20 drafted messages in `docs/demand/outreach.md` (14 cohort A, 5 cohort B, Autumn); paste replies into `docs/demand/funnel.md` | H3; ≥5 replies by Oct 10 or shift to cohort B | now |
| B4 | **HUMAN:** ask Stripe Support (from the claimed account) whether the read-API allocation ("must not exceed an average of 500 per transaction", floor 10,000/30 days) applies to sandboxes, and whether sandbox test charges count as transactions. Draft: `docs/decisions/0001-clean-room-and-legal-gate.md` C2 | Until answered, the harness hard-caps sandbox GETs at 10,000 per rolling 30 days, which limits the nightly corpus size. Increases need ~6 weeks' notice | after B1 |
| B5 | **HUMAN:** counsel review of SSA §2.4 (reverse engineering), §4.2 + "Stripe Data" (our recordings), §1.2(a)(vi) (republication) before ANY public release (public repo, npm publish, score page, launch post). Option: Michigan Law's Zell Entrepreneurship Clinic (free for UM student ventures; check eligibility). Questions are listed in decision 0001 C7 | Legal gate verdict: GO WITH CONDITIONS for private work only | before Oct 15 launch; start by Oct 1 |

## Launch gate (all must hold before anything goes public)
- [ ] B5 counsel review cleared (decision 0001 C7)
- [ ] Git history scrubbed of raw Stripe values (a W1b fixture commit contained one; fixed at HEAD, still in history) → publish from a fresh squashed repo, then grep the whole tree for `rkcs_`/`sk_`/`cus_`/`pi_`/`ch_` real ids
- [ ] Compiled JS build + npm publish of `paritybench` (name currently unclaimed on npm; anyone could take it)
- [ ] Draft PRs from `align --assist` carry normalized sandbox values in their bodies → delete or scrub them; the read ledger's early lines name the sandbox account id → gone with the squashed history
- [ ] Repo made public (ask Adam), GitHub Pages enabled for `site/`

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
- [x] Scenario templates 1–15 (validated live; `docs/plan/impl/templates-validation.md`)
- [x] Outreach: 34 targets in `docs/demand/cohorts.md`, 20 fact-checked messages in `docs/demand/outreach.md`, tracker `docs/demand/funnel.md` (sending = B3)
- [x] Exit: go/no-go on "nightly" — **no-go today**: read budget allows ~150–170 seqs/night (1.95–2.18 GETs/seq; a 500-seq run ≈ 950–1,060 GETs → weekly), and the claimable key cannot sustain a corpus. Go after B1 (quota) + B4 (read cap). Throughput itself passes H0 ~8×

## Plan changes from W0 research (see `docs/research/2026-09-25-w0-verifications.md` §"Plan changes implied")
- Read-API allocation added to §4/§10: per-sequence event polling replaced by one sweep per corpus; GET ledger `budget/reads.jsonl`; nightly corpus sized to the budget until B4 is answered.
- Stripe's **endive** major release is expected ~2026-09-30: keep the pinned `Stripe-Version`; pin stripe-mock by image digest; H5 may see a real event in W1.
- H4 fallback estimate is ~2 days, not ≤1: pinned Python `stripe-agent-toolkit==0.6.1` with `stripe.api_base`.
- Raw recordings stay out of git (C3); public artifacts are scores, normalized divergence classes, and hashes.

## W1 (Sep 29–Oct 5): ParityBench + H1
- [x] Harness: runner, refs, dual execution, recordings, normalization v1.2, four-level score with Wilson CIs, JSON + Markdown report, oracle store (`oracle build`), slices, chunk pacing, circuit breaker
- [~] Templates 16–30; corpus ≥500 sequences: #16–#26 done and validated live; #27–#30 (clocks) blocked on B1. Corpus defined = 26 × 20 = 520 sequences, but the **oracle holds 88** (all 26 templates, seeds 1–4/1–2). The claimable-key quota refused both W1 recording attempts on 2026-09-26 (01:56, 02:00 UTC; breaker aborted, 0 clean sequences) and every probe 02:05–04:08 UTC returned 429, so the rest waits for the quota or B1
- [x] Baselines (2026-09-26, `docs/plan/impl/baselines.md`): **stripe-mock** (digest `ff3264…`, v0.205.0, dahlia) on 88 seqs: L1 80.9%, L3 1.3%, **L4 0.0% [0.0–4.2]**; **localstripe 1.15.10** on its served surface (6 of 26 templates, 20 seqs; no Prices route): L1 58.1%, L3 3.4%, **L4 0.0% [0.0–16.1]**. Arga not scored (C5)
- [~] `reports/2026-09-26-baseline.md` (+ `.json`, values stripped) with noise floor + ceiling: floor 0.0% at L1–L4 (L3 [0.0–0.9], L4 [0.0–6.0]) over 60 pairs (#1–#15, W0 A vs D, in-sample for v1.2); proration/boundaries noise (#16–#26 × 1–2 fresh run vs `uxv2`) pending the quota; after a 404 probe it is one `record` + `pair` + `compare`, no code change
- [x] H1 decided: **confirmed** — best existing twin 0% sequence-level agreement (<80%); every upper bound ≤16.1%. PM ruling 2026-09-26: accepted on the 88-sequence oracle (H1 does not depend on corpus size); the 520-sequence oracle and the #16–#26 noise pair are **W1-residual, gated on B1** (commands ready in `docs/plan/impl/baselines.md`)

## W2 (Oct 6–12): twin scaffold + first curve points
- [x] Event store, form parser, spec validation, error envelope, idempotency, `/v1/events`, webhooks, `/_parity/reset` (<50 ms; ~2 ms over HTTP with 1,000 objects), `/_parity/seed` (`test/twin-core`, `test/twin-webhooks`, `test/twin-main`)
- [x] Behavior modules: customers, products, prices, payment methods, subscriptions (create/cancel), invoices (retrieve/list), refunds (`test/twin-resources-a`, `test/twin-resources-b`)
- [~] Twin boots <1 s: **done**, spawn to first 200 in ~0.1 s (`node src/twin/main.ts`, `test/twin-main`); image `docker build -t parity-twin .` (node:22-alpine, 166 MB) serves on 12111 and exits 0 on `docker stop` in 0.2 s. L1 ≥80% on non-clock steps: **100% (420/420) on #1–#15 × seeds 1–4** — caveat: in-sample (the scaffold was built with those statuses visible) and L1 only; the day-0 L1–L4 score on the full 88-sequence oracle comes with the align task
- [ ] Nightly ParityBench run; per-stratum curve with "surface added" annotations

## W3 (Oct 13–19): align loop + launch
- [x] Align loop (`paritybench align`): triage → locus → mechanical data-file candidates (train only) → held-out gate → sealed hash-chained log with oracle provenance (`../parity-data/align/log.jsonl`). Day-0 (`reports/2026-09-26-twin-day0.md`, tag `twin-scaffold-v0`) → first apply: **174 automatic patches**, train L3 3.8%→18.8%, L4 0→5.6%; held-out L3 0→8.8% (`reports/2026-09-26-align-first-run.md`, caveats listed there). Minimization = prefix truncation (step dropping deferred until the read budget allows)
- [~] LLM-assisted patches (`align --assist`, draft PRs, $15/day cap, `budget/llm.jsonl`): built and tested against a fake Messages API only — **no live run yet (needs `ANTHROPIC_API_KEY`, B2)**
- [~] Nightly (`paritybench nightly` + `.github/workflows/nightly.yml`, `ci.yml`): degraded path verified live 2026-09-26 (sandbox refused → twin scored, align, drift no-op, curve point published to `site/data/curve.json`). Cron not active until B2 secrets; Pages waits for the launch gate. Drift instrument (`src/drift.ts`, `drift/`) built; first real drift needs B1
- [x] GitHub Action `action.yml` (composite; boots the twin, exports `PARITY_TWIN_URL`) + self-test workflow; `README.md` (quickstart, method, rate-limits quote, non-affiliation, supported surface). `npx paritybench` needs a compiled JS build + npm publish (launch checklist)
- [x] Score page `site/` (curve per stratum with CI bands, ceiling line, train/held-out table, automation ratio, drift feed; phone width, light/dark); runs on sample data until the nightly writes `site/data/`
- [x] Launch drafts `docs/launch/` (Show HN, X thread, demo script, vendor invite), each gated "DO NOT POST before B5"
- [ ] **HUMAN:** launch Show HN + X (target Thu Oct 15) — only after the launch gate

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
- 2026-09-26: W1 closed on H1 (confirmed; 88-seq oracle, residual gated on B1). Twin scaffold (W2) complete: 6 tasks + cleanup batch, all reviewed. W3 part A done (integration, `score-twin`, score page, README, CI action). Claimable key refused continuously since 01:56 UTC → B1 is the critical path. W3 part B (align loop, nightly, launch drafts) starting on oracle v0 (88 seq).
- 2026-09-26: W3 complete: align loop live (174 automatic patches; held-out L3 0→8.8%), assisted path built (not live: no LLM key), nightly degraded path verified, launch drafts. W4 started (surface-added proration/invoices/clocks, agree, MCP, verifiers, H4 harness).
