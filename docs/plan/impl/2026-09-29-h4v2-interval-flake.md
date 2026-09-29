# Implementation plan: H4 v2 preparation, interval swap on the sandbox, flaky test, stale docs

Spec: `docs/plan/2026-09-25-parity-mvp-plan.md` §1 H4, §2.1, §3.3. Binding: decisions 0001 (C2 10k GETs/30d binding; C3) and 0002, `docs/plan/rulings.md`. Evidence: `reports/2026-09-28-h4.md`, `reports/2026-09-28-h4-80.md`.

## Global Constraints

- **No LLM spend in this plan.** Today's (2026-09-29 UTC) ledger already holds $12.31. The H4 v2 LLM run is queued for 2026-09-30, and only after that day's nightly `publish` entry exists in the sealed log: pull `../parity-data`, then `grep -c '"kind":"publish","data":{"label":"nightly","date":"2026-09-30"' ../parity-data/align/log.jsonl` must print at least 1. Not by the clock: the schedule is 07:23 UTC with a 10:47 UTC backup, GitHub can start either late, and the run takes about 13 minutes. The LLM ledger (`budget/llm.jsonl`) and its daily cap are shared by every purpose, so H4 spend before the nightly starves that day's assisted pass, as H4 did on 2026-09-29 (no B7 PR that day).
- Sandbox reads: pull `../parity-data` first, project, and stop if rolling30 would pass 8,000.
- Engineering rules and commits as in earlier plans. Stage only your paths. Pull with rebase and push after each task, keeping CI green. Never merge, approve or close PRs.
- Held-out templates #7, #9, #12, #18, #21 and #28: never open their recordings.

## Task 1: H4 v2 harness (agent tools), no LLM run

**Paths:** `evals/h4/toolkit.py`, `evals/h4/run.ts`, `evals/h4/README.md`, `test/h4.test.ts`

- On 80 tasks, all 5 twin-vs-sandbox and all 4 twin-vs-control disagreements came from the 12 tasks that need `cancel_at_period_end`. The ported `update_subscription` tool has no such parameter, so the agent improvises.
- **v2 change:** expose `cancel_at_period_end` on `update_subscription` (and `billing_cycle_anchor`, which the interval swap needs), with honest descriptions. Log each tool call's name and input keys (not values) per task in the run's output. That makes attribution checkable without guesses.
- **Honesty:** the change is agent-side and identical for the twin, the control and the sandbox. It is motivated by the v1 result, and the README says so. v1's numbers stay published next to v2's.
- Validate with the scripted agent on the twin: all tasks except the known `switch-to-annual` gap. Add a test that the tool schema carries both parameters and that the tool log records keys only.
- Add the queued command to the README: `node evals/h4/run.ts --agent llm --cap-usd 14 --out reports/<date>-h4-v2`, to be run only once that UTC day's nightly `publish` entry exists (Global Constraints).

## Task 2: Interval swap without an anchor, recorded on the sandbox

**Paths:** `templates/`, `docs/plan/impl/templates-validation.md`, `test/corpus.test.ts`, `docs/plan/STATUS.md` (interval row only)

- Add train template **#31 `subscription-interval-swap`** (proration stratum; not held out).
  - A monthly subscription swaps to an annual price with `proration_behavior` ∈ {create_prorations, always_invoice, none}, chosen by the generator. There is no `billing_cycle_anchor`.
  - Retrieve the subscription and list invoices for the customer.
  - Validate live for seeds 1–3, about 30 GETs.
- Record in `templates-validation.md` what the sandbox does:
  - item periods;
  - `billing_cycle_anchor`;
  - the invoices and their `billing_reason`;
  - the proration lines.
- Record #31 × seeds 1–20 into the data repo, then run `oracle build`, so the next nightly scores the twin on it and the align loop sees it.
- Do **not** change the twin by hand. The twin's current `not_implemented` refusal becomes a scored divergence for the assisted pass.
- Update the STATUS interval row.

## Task 3: Flaky test hunt

**Paths:** `test/*.test.ts`, and `src/**` only for a root-cause fix a flaky test reveals

- One full-suite run on 2026-09-28 had 1 unidentified failure. The nightly's test guard runs this suite before landing align commits, so a flaky test would drop commits at random.
- Run `node --test test/*.test.ts` at least 15 times, sequentially and with `--test-concurrency` variations. Save each TAP output under `/private/tmp`. Name every test that fails at least once.
- Fix the root cause: timing bounds, port reuse, shared temp dirs, order dependence. If a failure cannot be reproduced after 30 runs, report that plainly.

## Task 4: Stale docs

**Paths:** `README.md`, `docs/yc/2026-w27-application.md`, `evals/h4/run.ts` (header comment only), `site/index.html` (text only)
**Depends on:** Tasks 1–3.

- Bring every public-facing status sentence in line with `docs/plan/STATUS.md`:
  - the nightly is scheduled and live;
  - the assisted pass is live, with the first merged PR (#1);
  - H4 v1: 20 tasks, 100%, CI 83.9–100;
  - the 80-task run: 93.8% (CI 86.2–97.3), with the control at 95.0%.
- The YC draft's numbers carry "as of <date>" and cite the reports.
- The `run.ts` header says 80 tasks.
- No possessive "Stripe's", and no raw values.
