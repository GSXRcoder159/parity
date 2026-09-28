# Implementation plan: post-oracle-v1 hardening (before CI nightly is enabled)

Spec (authority): `docs/plan/2026-09-25-parity-mvp-plan.md`. Binding: decision 0001 (C2 as amended 2026-09-27: **10,000 GETs per rolling 30 days is binding**, B4/B4b), decision 0002, `docs/plan/rulings.md`. Inputs: the B1-unblock ledger `.superpowers/sdd/2026-09-27-b1-unblock/progress.md` and task reports; `reports/2026-09-27-*.md`.

## Global Constraints

- **No LLM spend.** Keep `PARITY_LLM_CAP_USD=0` for any local nightly run. No sandbox recording except the smallest live check a task explicitly needs; every one goes through the budget gate.
- Held-out templates #7, #9, #12, #18, #21, #28: never open their recordings or validation rows.
- Twin behavior is not changed by hand (align's job).
- Engineering: Node ≥22.18, `npx tsc -p tsconfig.json`, `node --test test/*.test.ts`, no new runtime deps, ponytail minimalism. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only your paths. Tasks 1 and 2 run in parallel on disjoint paths, and Task 3 runs after both.

## Task 1: Nightly guards

**Paths:** `src/nightly.ts`, `src/agree.ts`, `src/bench/budget.ts`, `test/nightly.test.ts`, `test/agree.test.ts`, `test/budget.test.ts`

1. **Budget-sized slice** (decision 0001 C2 consequence).
   - Tonight's allowance = `min(projected GETs of one seventh of the corpus, floor((10,000 − 1,500 − rolling30) / 7))`, never negative.
   - Record the longest prefix of tonight's rotation that fits, and keep the rotation cursor (in the data repo) so tomorrow continues where tonight stopped. An allowance of 0 is the degraded path, logged.
   - The weekly noise pair runs only if its projection fits in what remains after the slice. Otherwise it waits for the next night, and this is logged.
   - The curve point carries `oracleMaxAgeDays`, computed from the oracle's recording dates, so the published "at most N days old" statement stays true.
2. **Tests guard align commits.** Before `land()` pushes an align commit, run `node --test test/*.test.ts` (and `npx tsc`) on the patched tree. If they fail, drop the align commit through the existing drop path, log a `note` with the failing test names, and continue the night. Motivation: on 2026-09-28 a mechanical patch turned CI red because tests pinned catalog placeholders.
3. `agree`'s metered proxy records `charges` in the ledger: count 2xx responses to charge-creating calls, or say why this cannot be counted.

Tests cover allowance math at the budget edges, the rotation cursor across nights, the noise pair deferred, a red suite dropping the align commit, and agree charges.

## Task 2: Harness corrections found on oracle v1

**Paths:** `src/bench/normalize.ts`, `src/align/triage.ts`, `src/cli.ts`, `src/bench/run.ts`, `templates/clocks.ts`, `test/normalize.test.ts`, `test/align-triage.test.ts`, `test/cli.test.ts`, `test/run.test.ts`, `test/corpus.test.ts`

1. **Normalization v1.4.**
   - (a) `next_payment_attempt` on invoices after a declined attempt gets a day bucket. The sandbox picks a random 42–46 h retry.
   - (b) `payment_method_details.card.electronic_commerce_indicator` becomes an opaque value. It takes one of two values and nothing in the sequence selects which.
   - Each new rule gets a rationale naming what it could hide. Bump the version.
   - Note in the report: the 2026-09-28 noise pair is in-sample for these two rules. The next weekly pair measures them out of sample.
2. `triage.ts endpoint()` renders test-clock routes correctly: `POST /v1/test_helpers/test_clocks/{id}/advance`, not the garbled form. Add a test.
3. `bench` against a non-sandbox target skips template `waitMs`, as `score-twin` does. Waits exist only for sandbox timing. Keep them for the sandbox. Add a test.
4. `templates/clocks.ts`: add a `// ponytail:` note on #30's 600 s wait naming the ceiling (1.5× the max seen over 6 clocks). `record` against the sandbox ends with a leak check: list test clocks created during the run, delete any left over, and report the count. Add a corpus test that #30's second advance is followed by a wait of at least 600,000 ms.

## Task 4: Nightly leftovers (orchestrator rulings after the Task 1 cap)

**Paths:** `src/nightly.ts`, `test/nightly.test.ts`

1. `IN_SAMPLE_RUNS` gains the 2026-09-28 pair (`20260928T011354-l3w0`, `20260928T012601-q5kb`). The v1.4 rules were written from it, so its published ceiling must say `inSample: true` until the next weekly pair replaces it.
2. The guard treats a run with `# tests 0` as a failure: a moved or renamed suite must not wave align commits through.
3. The guard's test and tsc runs get a timeout of 10 minutes. A hang means the align commit is dropped and a note is written, not a 120-minute job timeout.
4. With an empty oracle, `oracleMaxAgeDays` is `null` and the summary says "no oracle". It must not claim 0 days.
5. Ruling on record: the noise pair uses the 30-day headroom left after the slice, i.e. weekly cadence (1f9720c). Keep it.
6. Not in scope, needs the user: `.github/workflows/nightly.yml` needs `- uses: astral-sh/setup-uv@v6` with `enable-cache: false`, placed before the nightly step. An agent's edit to it was refused by the permission system (2026-09-28), so the orchestrator surfaces the patch to the user.

Tests for items 1–4.

## Task 3: Docs, status and rulings refresh

**Paths:** `docs/plan/STATUS.md`, `docs/plan/impl/templates-validation.md`, `reports/2026-09-27-clocks.md`, `README.md`, `site/index.html` (text only), `docs/launch/*.md`, `docs/yc/2026-w27-application.md`, `docs/demand/partner-offer.md`
**Depends on:** Tasks 1 and 2.

- **STATUS:**
  - Blocker rows: B1 done 2026-09-27; B4 and B4b answered; B6 done (`disabled_manually`); B2 all three secrets set. The remaining B2 step: enable the nightly **after** the user sets the LLM budget, or set the repo variable `PARITY_LLM_CAP_USD` to `0` to run without LLM spend.
  - Refresh the W0, W1 and W4 lines and the H0, H1 and H4 rows with the v1 numbers from `reports/2026-09-27-baseline-v1.md`, `reports/2026-09-27-clocks.md`, `reports/2026-09-27-twin-v1.md` and `reports/2026-09-27-agree-example.md`.
- **#28 exposure ruling:** same as the 2026-09-26 precedent. The rows printed were step intent and counts only; no results or bodies were printed. Record it in `templates-validation.md` and the day-0 limitations. The orchestrator appends the sealed-log note; do not append it yourself.
- **Minors from the Task 1 review:**
  - add the `invoice.updated` fact at #27's finalization;
  - name the source run for the retry-delay numbers;
  - in the clocks report, label counts that include #28 and cross-reference its exposure section.
- **Public-facing numbers** (README, score page text, launch drafts, YC draft, partner offer): use the v1 numbers.
  - H1 on 600 sequences.
  - The out-of-sample noise floor: L3 0.7% at v1.3.
  - The twin on v1.
  - The agree example: 8/8, CI 67.6–100.
  - Keep every limitation statement, and cite the report next to each number.
