# Implementation plan: assisted-pass output budget, STATUS refresh, H4 suite expansion

Spec: `docs/plan/2026-09-25-parity-mvp-plan.md` §1 (H2, H4), §3.3, §6.4, §9. Binding: decisions 0001 (C2: 10k GETs/30 days, binding; C3) and 0002 (§3 classes), `docs/plan/rulings.md`. LLM budget approved by Adam on 2026-09-28: $150/month key limit, $15/day hard cap in code, CI nightly `PARITY_LLM_CAP_USD` default $3.

## Global Constraints

- Engineering: Node ≥22.18, `npx tsc -p tsconfig.json`, `node --test test/*.test.ts`, no new runtime deps, ponytail minimalism. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only your paths. Push the parity repo after each task: pull with rebase first, and keep CI green.
- **Pull `../parity-data` before any LLM or sandbox run.** The CI nightly writes the same ledgers.
- Merging assisted PRs is Adam's step (the permission classifier refuses self-approval). Never merge, approve or close PRs.
- Held-out templates #7, #9, #12, #18, #21 and #28: never open their recordings.

## Task 1: Assisted-pass output budget

**Paths:** `src/align/llm.ts`, `src/align/assist.ts`, `test/align-assist.test.ts`

- The 2026-09-28 CI nightly's assisted pass lost one of its 3 loci to `stop_reason: max_tokens`. The fixed 8,192 `max_tokens` includes Sonnet 5's adaptive thinking, and a full-file replacement of a large module does not fit.
- Raise `max_tokens` for assist calls to a value the model supports and the cap estimate accounts for. The worst-case estimate uses `max_tokens`, so check that it still fits inside the $3 CI cap for 3 loci, or explain the choice.
- A `max_tokens` stop stays a logged `bad-reply` with its cost. It is never retried automatically in the same run.
- Tests against the fake Messages API cover the new limit in the request and the estimate.

## Task 2: STATUS refresh after the first live CI nightly and H4

**Paths:** `docs/plan/STATUS.md`, `docs/plan/rulings.md`

- **B2 row:** done. The three secrets are set, and the nightly workflow is active (Adam enabled it 2026-09-28).
  - The first CI nightly ran as dispatched run 36425251963: sandbox slice clean, no drift, $0.23 spent on the assisted pass, both repos pushed.
  - The cron runs at 07:00 UTC.
- **New recurring row B7, HUMAN:** merge or close the assisted draft PRs after Claude's two-reviewer check. The classifier refuses self-approval; Claude posts one command per PR.
  - First: #1 merged 2026-09-28. It changed customer `invoice_prefix` and `next_invoice_sequence`. On oracle v1 it moved train L3 26.8→47.5% and held-out L3 18.1→39.1% (review numbers).
  - #2 was closed as superseded.
- **W3/W4 lines, H2 row:**
  - LLM-assisted patches are live.
  - Automation ratio so far: 180 automatic JSON-pointer edits vs 1 merged assisted PR. Point to the changelog for divergences removed.
  - Held-out L3 is still far from the ≥90% target.
- **H4 row:** confirm on the point estimate (20/20, CI 83.9–100, control 20/20, $2.75). The CI lower bound is below 90%, so the suite expansion (Task 3) is under way.
- **`rulings.md`:** add the rulings from 2026-09-27/28:
  - B4/B4b cap binding;
  - budget-sized nightly;
  - #28 exposure;
  - self-approval refused → Adam merges;
  - PR #1 over #2;
  - H4 `switch-to-annual` check left unchanged after seeing the sandbox result, because changing it would tune H4 to the sandbox.

## Task 3: H4 suite expansion to tighten the CI

**Paths:** `evals/h4/tasks.json`, `evals/h4/README.md`, `test/h4.test.ts`, `reports/`, `docs/plan/STATUS.md` (H4 row only)
**Depends on:** Tasks 1–2.

- Add 60 tasks, for 80 in total, spread over the ICP call graph (plan §2.1): refunds (full, partial, over-refund error, refund of a refunded charge), cancellations (now, at period end, reactivate before period end), prorations (price swap up and down, quantity change, preview-then-apply), invoice lookups (list, retrieve, pay an open send_invoice invoice), and customer lookups by email.
- Each task needs a setup, an instruction and checks in the existing format, plus a scripted solution.
- **Write the tasks before seeing any twin or sandbox result for them.** Validate with the **scripted** agent on the **sandbox** first; that is the ground truth. A task whose scripted solution fails on the sandbox has a wrong check or setup: fix the task. Then run scripted on the twin. A scripted failure on the twin is a **twin gap**: record it in `TWIN_GAPS`, and never change the task to fit the twin.
- **Sandbox reads:** project first (about 6 GETs per task per run; the scripted sandbox pass is about 360). Stop if rolling30 would pass 8,000.
- **LLM run:** `node evals/h4/run.ts --agent llm --cap-usd 14 --out reports/2026-09-28-h4-80` (twin, control, sandbox). Expect about $11. Check the day's spend first: $2.97 has already been spent today, so if the run would pass the $15/day cap, run it after 00:00 UTC.
- **Report:** agreement with its Wilson CI, the control, the verdict, cost, and every disagreement, each attributed to a twin gap or to agent variance using the control. Public-safe (C3).
- Update the H4 row in STATUS and the README Status section.
