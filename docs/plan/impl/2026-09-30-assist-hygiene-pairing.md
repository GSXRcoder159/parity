# Implementation plan: assisted-pass hygiene (C3 params) and code+data pairing

Spec: `docs/plan/2026-09-25-parity-mvp-plan.md` §3.3 (assisted patches, held-out gate). Binding: decisions 0001 (C3) and 0002 (§3 classes, §4 clean room), `docs/plan/rulings.md`. Evidence: the reviews of PRs #3 and #4, 2026-09-30.

## Global Constraints

- No LLM spend. Tests use the fake Messages API server. No sandbox calls.
- Never merge, approve or close PRs.
- Held-out templates #7, #9, #12, #18, #21 and #28: never open their recordings.
- Engineering rules as in earlier plans. Pull with rebase and push after each task, keeping CI green.

## Task 1: Normalize step params in counterexamples (C3)

**Paths:** `src/align/assist.ts`, `test/align-assist.test.ts`

- `assist.ts` (around line 96) passes step `params` through `scrub` only, which drops fraud and risk keys. Bodies go through `normalizeRecording`. As a result, the PR body's "Counterexample (normalized)" and the LLM prompt carry raw object ids (`cus_…`, `price_…`, `pm_…`) and run-nonce emails.
- Normalize params with the same rules as bodies: ids → `<id:prefix>`, run nonce → `<run>`, and so on.
- Tests:
  - a counterexample whose params hold real-looking ids and a run-nonce email renders them normalized, in both the PR body and the prompt;
  - a grep-style assertion that no `/(cus|sub|pi|ch|price|pm|prod|in|re)_[A-Za-z0-9]{10,}/` survives.

## Task 2: Code+data pairing in the assisted gate

**Paths:** `src/align/assist.ts`, `src/align/gate.ts`, `src/align/index.ts`, `test/align-assist.test.ts`, `test/align-gate.test.ts`

- **Problem (PR #4 review):** a correct code change can expose new mechanically fixable divergences. Example: emitting the subscription's legacy `plan` through the `plan` template adds `tiers`, which the oracle never returns. A strict-improvement gate then rejects the honest version and rewards hard-coding the observed field set in code, which books an automatic data fix as assisted.
- **Change:** in the assisted gate, after applying the LLM's code change in the Docker-isolated temp copy:
  1. run the mechanical candidate pass on top of it: train only, the same determinism rules, applied to data files only;
  2. gate the combination;
  3. if it passes, the PR carries the code change and the data edits as separate commits.
- **Sealed log and changelog:** the code change is logged `assisted` with its own before/after. The data edits are logged `automatic`, each with its evidence, as they are today. Record "divergences removed" per class using the gate's intermediate score (after code, before data), so the ratio stays honest.
- Keep everything else unchanged: the single-file LLM replacement, the Docker isolation, and never merging.
- **Tests with fake scores:**
  - a code change that fails alone but passes with the paired data edits gives one PR with two commits;
  - the log entries are classed correctly;
  - held-out still never feeds candidates.
- **The assist prompt:** tell the model to prefer reusing template builders (`ctx.build(...)`) over literal object shapes, because the data pass will fix template fields.

## Task 3: STATUS and rulings

**Paths:** `docs/plan/STATUS.md`, `docs/plan/rulings.md`, `README.md` (the schedule sentence only)

- **H4 row:** v2 is 98.8%, 79/80 (CI 93.3–99.8). The control is 100%, 80/80. Cost $11.94. It confirms on the point estimate, and the CI's lower bound now clears the 90% stop line. Link `reports/2026-09-30-h4-v2.md`.
- **B7:**
  - PR #3 approved by both reviewers; the merge command was given to Adam.
  - PR #4 blocked by both reviewers: the plan shape is hard-coded in code, and 4 tests are outdated. Close command given, to be re-proposed after Task 2.
- **W3 nightly line:** four scheduled attempts per UTC day with `--once-per-day`. GitHub's scheduler dropped the 07:23 slot and ran 10:47 about 3 h late on 2026-09-30, then skipped correctly because the day was already published.
- **Rulings:**
  - PR #4 blocked (automation-ratio honesty);
  - code+data pairing;
  - the schedule finding;
  - H4 v2 tool change (agent-side, identical across the twin, the control and the sandbox; motivated by v1; both runs published).
