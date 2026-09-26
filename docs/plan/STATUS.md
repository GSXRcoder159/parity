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
| B1 | **HUMAN — NOW THE CRITICAL PATH:** claim the sandbox (`stripe sandbox claim` or the claim URL), then create a full `sk_test_` key and put it in `.env` as `STRIPE_API_KEY` | Claimable key (`rkcs_test_`) is refused on `/v1/test_helpers/test_clocks` and `/v1/account`; **it also has an undocumented request quota (tripped after ~577 requests in ~2 min on 2026-09-25; lifted within 18 min) that caps sustained throughput at roughly one 60-sequence corpus per window** (`reports/2026-09-25-w0-oracle.md`); sandbox is deleted 2026-10-02. **Since 2026-09-26 01:56 UTC the claimable key is refused on every request (still 429 at 04:09), so no sandbox recording is possible at all:** the full oracle (30 templates in 10 strata, 6 held out, 600 sequences at seeds 1–20; oracle v0 records 26 templates, 88 sequences), the #16–#26 noise pair, clock templates #27–#30, clock throughput and the nightly slice all wait on this | **now**; hard stop 2026-10-02 |
| B2 | **HUMAN:** GitHub repo secrets on `GSXRcoder159/parity`: `STRIPE_API_KEY` (claimed `sk_test_`), `ANTHROPIC_API_KEY`, `PARITY_DATA_TOKEN` (fine-grained PAT, contents read/write on `GSXRcoder159/parity-data`). Also put `ANTHROPIC_API_KEY` in local `.env`. **And** repo Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" (today `can_approve_pull_request_reviews: false`, so every assisted PR would fail at `gh pr create`; the branch is then deleted again), or give the nightly a GitHub App / bot token for the PR step, which also makes `ci.yml` run on assisted PRs (GitHub starts no workflow for a PR opened with `GITHUB_TOKEN`) | Nightly cron + LLM-assisted patches (W3) | before first nightly |
| B6 | **HUMAN:** the `nightly` workflow is **active** on GitHub (cron `0 7 * * *`) and every run fails at the `parity-data` checkout until B2 (no `PARITY_DATA_TOKEN`). Disable it until B2 (`gh workflow disable nightly`) or accept a red run each morning | Red runs hide real failures | now |
| B3 | **HUMAN:** send the 20 drafted messages in `docs/demand/outreach.md` (14 cohort A, 5 cohort B, Autumn); paste replies into `docs/demand/funnel.md` | H3; ≥5 replies by Oct 10 or shift to cohort B | now |
| B4 | **HUMAN:** ask Stripe Support (from the claimed account) whether the read-API allocation ("must not exceed an average of 500 per transaction", floor 10,000/30 days) applies to sandboxes, and whether sandbox test charges count as transactions. Draft: `docs/decisions/0001-clean-room-and-legal-gate.md` C2 | Until answered, the harness hard-caps sandbox GETs at 10,000 per rolling 30 days, which limits the nightly corpus size. Increases need ~6 weeks' notice | after B1 |
| B5 | **HUMAN:** counsel review of SSA §2.4 (reverse engineering), §4.2 + "Stripe Data" (our recordings), §1.2(a)(vi) (republication) before ANY public release (public repo, npm publish, score page, launch post). Option: Michigan Law's Zell Entrepreneurship Clinic (free for UM student ventures; check eligibility). Questions are listed in decision 0001 C7 | Legal gate verdict: GO WITH CONDITIONS for private work only | before Oct 15 launch; start by Oct 1 |

## Launch gate (all must hold before anything goes public)
- [ ] B5 counsel review cleared (decision 0001 C7)
- [ ] Git history scrubbed of raw Stripe values (a W1b fixture commit contained one; fixed at HEAD, still in history; the sandbox account id and email were in tracked files until 652eb34) → publish from a fresh squashed repo, then grep the whole tree for `rkcs_`/`sk_`/`rk_`/`cus_`/`pi_`/`ch_`/`acct_` real ids and the sandbox account's email
- [ ] Compiled JS build + npm publish of `paritybench` (name currently unclaimed on npm; anyone could take it). `package.json` has a `files` allowlist (src, templates, README, LICENSE): check `npm pack --dry-run` again before publishing
- [ ] Draft PRs from `align --assist` carry normalized sandbox values in their bodies → delete or scrub them. The read ledger names the sandbox account: it moved to `../parity-data/budget/` and is untracked here since 652eb34 (still in this repo's history → the squashed repo)
- [ ] Files that ship with the repo name the Arga "100% fidelity" claim (`docs/yc/2026-w27-application.md`, `parity-research.md`, `docs/research/2026-09-25-evidence.md`); decision 0001 (e) says never name it → remove or keep those files out of the public repo
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
- Read-API allocation added to §4/§10: per-sequence event polling replaced by one sweep per corpus; GET ledger `<dataDir>/budget/reads.jsonl` (in the private data repo); nightly corpus sized to the budget until B4 is answered.
- Stripe's **endive** major release is expected ~2026-09-30: keep the pinned `Stripe-Version`; pin stripe-mock by image digest; H5 may see a real event in W1.
- H4 fallback estimate is ~2 days, not ≤1: pinned Python `stripe-agent-toolkit==0.6.1` with `stripe.api_base`.
- Raw recordings stay out of git (C3); public artifacts are scores, normalized divergence classes, and hashes.

## W1 (Sep 29–Oct 5): ParityBench + H1
- [x] Harness: runner, refs, dual execution, recordings, normalization v1.2, four-level score with Wilson CIs, JSON + Markdown report, oracle store (`oracle build`), slices, chunk pacing, circuit breaker
- [~] Templates 16–30; corpus ≥500 sequences: #16–#26 done and validated live; #27–#30 (clocks) written from the docs (W4 Task 4), unrecorded and unvalidated until B1. Corpus defined = 30 templates in 10 strata × 20 seeds = 600 sequences, 6 held out, but the **oracle holds 88** (all 26 templates, seeds 1–4/1–2). The claimable-key quota refused both W1 recording attempts on 2026-09-26 (01:56, 02:00 UTC; breaker aborted, 0 clean sequences) and every probe 02:05–04:08 UTC returned 429, so the rest waits for the quota or B1
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
- [~] LLM-assisted patches (`align --assist`, draft PRs, $15/day cap, ledger `<dataDir>/budget/llm.jsonl`): built and tested against a fake Messages API only — **no live run yet (needs `ANTHROPIC_API_KEY`, B2)**
- [~] Nightly (`paritybench nightly` + `.github/workflows/nightly.yml`, `ci.yml`): degraded path verified live 2026-09-26 (sandbox refused → twin scored, align, drift no-op, curve point published to `site/data/curve.json`). The cron is **active** on GitHub but every run fails at the `parity-data` checkout until B2 (B6). Pages waits for the launch gate. Drift instrument (`src/drift.ts`, `drift/`) built; first real drift needs B1
- [x] GitHub Action `action.yml` (composite; boots the twin, exports `PARITY_TWIN_URL`) + self-test workflow; `README.md` (quickstart, method, rate-limits quote, non-affiliation, supported surface). `npx paritybench` needs a compiled JS build + npm publish (launch checklist)
- [x] Score page `site/` (curve per stratum with CI bands, ceiling line, train/held-out table, automation ratio, drift feed; phone width, light/dark). Reads `site/data/`: one point (2026-09-26), backfilled with the 174 automatic patches the page had missed; a point's noise ceiling shows only where its pair covers the scored templates, with the coverage and in-sample flag printed
- [x] Launch drafts `docs/launch/` (Show HN, X thread, demo script, vendor invite), each gated "DO NOT POST before B5"
- [ ] **HUMAN:** launch Show HN + X (target Thu Oct 15) — only after the launch gate

## W4 (Oct 20–26): time, sim-to-real, fidelity push
- [~] Test clocks + proration + subscription updates in twin; clock stratum scored: **built**, each logged as surface-added in the sealed log: subscription updates, flexible proration and `create_preview` (2914c99), invoice lifecycle and `send_invoice` drafts (bcec25c), test clocks, trials and templates #27–#30 (d32db08). The clock stratum is **not scored**: no sandbox recording of a clock exists (B1). Still refused (`not_implemented`, README "Not yet"): a billing-interval change without `billing_cycle_anchor=now` (H4's switch-to-annual; owner: the first post-B1 recording task), mixed intervals, cancel with `invoice_now`/`prorate`
- [ ] Interval swap without anchor: verify on sandbox after B1. Owner: the first post-B1 recording task. Record a price swap across billing intervals (monthly → annual) without `billing_cycle_anchor` on a flexible-mode subscription (H4's switch-to-annual): the twin answers `not_implemented` until then (ruled behavior, W4 plan Task 3(b); with `billing_cycle_anchor=now` it resets and prorates). Then implement what the sandbox does, gate it on the recording, and log it as surface-added
- [~] `paritybench agree`; partner suite or Stripe-gym fallback; publish agreement: `agree` built (9a2ae0e; sandbox half through a metered proxy, 2294645); the example suite passes 8/8 on the twin. The sandbox half, a partner suite and a published agreement wait on B1 and B3. Fallback: the H4 harness (below)
- [x] MCP server (87c5cff; `ping` answered since the final review); `verifiers` ToolEnv (56fc35d, `python/parity_verifiers`, pytest in CI)
- [~] H2, H4 decided; automation ratio published: the ratio is **published** on the page (174 automatic, 0 assisted). **H2 cannot be decided** until the assisted pass runs live (B2). **H4**: harness built (4fff9ba; scripted agent twin 19/20, control 19/20); no H4 number until B1 (sandbox half) and B2 (LLM key)

## W5 (Oct 27–Nov 2): application
- [ ] Drift instrument live: built (`src/drift.ts`); no real drift until B1
- [~] YC application draft (Claude): `docs/yc/2026-w27-application.md` + founder video script (961e4cb); **HUMAN:** demo video, founder video, submit by Nov 2 8pm PT
- [x] Pricing page ("proposed"): `site/pricing.html` (d12d7f7, 85927d2); partner offer and LOI template in `docs/demand/` (dde9c4c)

## Log
- 2026-09-25: kickoff; repo scaffolded; sandbox provisioned; W0 started.
- 2026-09-25: W0 research workflow done (legal gate, verifications, demand). Harness Tasks 1–3 done and reviewed; Task 4 (oracle hygiene) inserted; Tasks 4–5 running.
- 2026-09-25: Task 5: `paritybench` CLI (record/compare/bench/help, budget-gated sandbox runs, ledger `budget/reads.jsonl`). W0 runs: throughput passes on rate (~4,000 seq/h at c=8); claimable-key quota discovered (caps sustained volume → B1); noise floor 7.6% at L3 under v1.1 (v1.2 gaps listed); nightly no-go on read budget + quota. `reports/2026-09-25-w0-oracle.md`.
- 2026-09-26: W1 closed on H1 (confirmed; 88-seq oracle, residual gated on B1). Twin scaffold (W2) complete: 6 tasks + cleanup batch, all reviewed. W3 part A done (integration, `score-twin`, score page, README, CI action). Claimable key refused continuously since 01:56 UTC → B1 is the critical path. W3 part B (align loop, nightly, launch drafts) starting on oracle v0 (88 seq).
- 2026-09-26: W3 complete: align loop live (174 automatic patches; held-out L3 0→8.8%), assisted path built (not live: no LLM key), nightly degraded path verified, launch drafts. W4 started (surface-added proration/invoices/clocks, agree, MCP, verifiers, H4 harness).
- 2026-09-26: W4 Tasks 1–8 and W5 Tasks 1–3 committed (see W4/W5 above for what is verified vs blocked). Held-out exposure of #7, #9, #12 ruled: they stay held out, disclosed.
- 2026-09-26: Final review wave, fixes (`.superpowers/sdd/final-review/fix-report.md`): normalization v1.3 (clock timestamps); a target's failed event collection fails L4; `--noise` takes a partial pair and reports coverage; the page's automation ratio uses sealed-log totals (174 backfilled) and publishes a ceiling only where the noise pair covers the corpus; the nightly pushes the align commit first and the data repo last, persists the LLM ledger in the data repo, rebases concurrent pushes; the gate's child runs under Node's permission model and the nightly keeps no credentials on disk; CI gets uv, pytest and the R4/R5 gates; twin fixes logged as one surface-added entry (customer delete cascade, decimal prices, detached cards, month-end anchors, search ranges, basil-removed expands, clocks ready at once); read ledger moved to the data repo and the account id/email redacted; README, launch drafts and this file brought to HEAD. The data repo's log entry and ledger copy are **staged, not committed** in `../parity-data` (HUMAN: commit and push).
