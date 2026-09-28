# Orchestrator rulings (2026-09-25 → 2026-09-28)

Every decision the orchestrator (Claude) made on Adam's behalf while executing the MVP plan, each with what it costs if it is wrong. The source ledgers are the SDD workspaces under `.superpowers/sdd/` (gitignored). The decision records are `docs/decisions/0001` and `0002`. Revisit any ruling you disagree with; each one names the files it touched.

## Plan-level decisions (also in STATUS/decisions)
- **Name:** `paritybench`. npm `parity` and the GitHub `parity` org are taken.
- **Stripe sandbox:** created via `stripe sandbox create --from-git`, which sent gsprog159@gmail.com.
- **Legal gate 0001: GO WITH CONDITIONS, private only.** Counsel is required before any public release. Sandbox reads are capped at 10,000 per 30 days. No raw Stripe data goes in any repo that will become public. No "Stripe" in product names.
- **Rolling oracle (0002 §1).** Each night re-records 1/7 of the corpus on the sandbox; the twin is scored against the whole corpus every night.
- **Twin = code + data (0002).** Only data-file patches count as automatic.
- **Held-out set:** #7, #9, #12, #18, #21, #28.

## Per-plan rulings (from the task ledgers)

### docs/plan/impl/2026-09-25-w0-w1-harness.md
- T1→T3 — Recording (types.ts), runNonce → normalize rule 3 — conflict: nonce sanitization duplicated. Ruling: T1 exports runNonce(), T3 imports it — single definition — cost if wrong: none
- T1/T3 id regex — tail `[A-Za-z0-9]{10,}` matches enums (create_prorations, charge_automatically) — Ruling: require ≥1 uppercase/digit in tail — Stripe ids are base62 mixed; enums lowercase — cost if wrong: a lowercase-only real id stays un-normalized → shows as noise
- T3 livemode — plan §3.1 lists livemode among normalized fields — Ruling: keep livemode compared (it is deterministic false in sandboxes; normalizing hides a twin bug) — cost: none
- T4 — noise runs — Ruling: throughput runs may double as noise A/B to save sandbox calls
- Branch — work on main — Ruling: user gave standing consent to atomic commits on this private greenfield repo; no feature branch — cost: none (private repo, revertible)
- Task 1: minor (deferred→Task 4): events poll failure invisible → Ruling: add Recording.eventsError, skip event compare — cost if wrong: masks real event-set bugs only when polling fails
- Task 1: minor (deferred): encodeForm exponent notation for tiny numbers → Ruling: templates pass decimals as strings (#20 author told) — cost: none
- Task 3: Ruling: L2/L3 gated on L1 (accepted) — status failures also count at L2/L3 — cost if wrong: L2/L3 slightly lower than un-gated reading
- Task 3: Ruling: toJson publishes RULES with rationales (accepted)
- Task 3: Ruling: ids embedded in strings → normalize word-bounded (Task 4, v1.1) — else every error-message step fails in the noise floor — cost if wrong: a message citing a wrong id of the same type is hidden
- Task 3: Ruling: strip "unclaimed sandbox" banner prefix (Task 4) — account-state text, not API behavior
### docs/plan/impl/2026-09-25-w2-twin-scaffold.md
- T6 ↔ harness cli.ts — twin main.ts only; cli.ts owned by harness workflow — Ruling: twin never edits cli.ts — cost: one-line wiring later
- Task 1: Ruling: templates emit every property (not required-only) — spec required lists too sparse; align removes extras mechanically — cost if wrong: more EXTRA_FIELD patches early (all automatic)
- Task 1: Ruling: enum-first for all types (deleted: true tombstones) — ratified
- Task 3: Ruling: widen scope — one fix agent owns Task 1 paths (+ tsconfig.json) and prices.ts: add `plan` extra root + POST/DELETE /v1/invoices/{invoice} ops, regenerate, gen-shapes clears only default dir, ponytail marker on MAX_DEPTH, tsconfig includes scripts/**; prices.ts builds plan via ctx.build — cost if wrong: none (spec-derived)
- Task 3: Ruling fix landed (plan root schema, invoice POST/DELETE ops, gen-shapes safe clear, tsconfig scripts); re-review 5/5 addressed; complete
### docs/plan/impl/2026-09-26-w1b-oracle-baselines.md
- T1 cli.ts vs twin workflow — twin never edits cli.ts; twin subcommand deferred to integration task — Ruling
- Ruling: normalization v1.2 removes the list-order sort — W0 showed the sort's tie-break manufactured pagination noise; Stripe list order is deterministic — cost if wrong: genuine order nondeterminism would surface as noise on list paths (visible, re-addable)
- Ruling: W1b Task 1 absorbs W0 follow-ups (circuit breaker, chunk pacing for claimable quota, sweep projection, v1.2, contaminated-run exclusion)
- Task 3: Ruling: H1 decided CONFIRMED on the 88-sequence oracle (stripe-mock L4 0.0% [0–4.2], localstripe 0.0% [0–16.1]; threshold <80%) — H1 does not depend on corpus size — cost if wrong: none (upper CIs far below 80%)
- Task 3: Ruling: the 520-sequence oracle, the #16–#26 noise pair and W0 clock checks become W1-residual, gated on B1; handoff commands in docs/plan/impl/baselines.md — cost: per-stratum CIs stay wide until then
### docs/plan/impl/2026-09-26-w3-align-nightly.md
- T1 vs W1b T3 — T1 edits cli.ts/run.ts; W1b T3 only runs the CLI — Ruling: T1 may run concurrently, but must not break record/bench/oracle CLI behavior (W1b T3 is mid-run)
- Ruling: W3 split into part A (T0,T1,T5) now and part B (T2,T3,T4,T6) after W1b — cost: none
- Task 5: OPEN_AT_CAP — finding was a plan defect (Task 4 data contract lacked noise/patches/scores file). Ruling: applied implementer's plan patch (task-5-plan-fix.patch); decision (b) accepted: merged assisted PRs counted via gh pr list --state merged → one sealed-log entry per PR — cost: none. Task 5: complete.
- Ruling: part B runs on oracle v0 (88 seq) until B1; day-0 + freeze now — cost if wrong: early mechanical patches derived from few occurrences (held-out gate still guards)
- Ruling (advisor): Task 2 step 0a = build() deep-merge + sweep window from Parity-Now (pre-freeze); held-out contamination stated in day-0; LLM prompt excludes templates-validation notes; oracle provenance on every log entry; blocked-by-code logging; nightly degraded path; CI timing bounds x3
- Task 2: OPEN_AT_CAP — shapes test pins working copy == generator; post-freeze patches break it by design. Ruling: invariant = generator reproduces tag twin-scaffold-v0; orchestrator-authorized fix agent runs align --apply, verifies log, pushes both repos with tags; also sweeps possessives (C4) and README clock wording — cost: none
- Task 2: Ruling fix landed (ea2103c shapes invariant pinned to tag; 8bbf612 align --apply 174 automatic patches; b022875 reports; both repos pushed, tag on origin). Remaining finding = orchestrator brief edit (fetch-depth: 0 in Task 4) → done by orchestrator. Task 2: complete.
### docs/plan/impl/2026-09-26-w4-surface-agree-wrappers.md
- Task 8: Ruling (a): src/align/llm.ts + test/align-assist.test.ts granted to Task 8 for the single-ledgered-client fix (task-8-fix3-llm.patch); no second Messages API client (plan §9 cap) — cost: none. If the loop returns OPEN_AT_CAP, orchestrator applies via ruling-fix step.
- Task 8: Ruling: H4 model = claude-sonnet-5 at default sampling (temperature 0 not accepted) — cost: agent nondeterminism enters the number
- Task 8: Ruling: twin-vs-twin control run REQUIRED (H4 noise floor; same principle as harness: no score without its floor) — cost: ~2x twin-side spend, within $50 cap
- Task 2: OPEN_AT_CAP — only item: ratify out-of-path deletion in 2914c99 (2 stale not_implemented assertions in test/twin-resources-b.test.ts for calls T2 now implements). Ruling: RATIFIED — the assertions contradicted the task; covered by test/twin-proration.test.ts — cost: none. Task 2: complete. Data-repo surface entry committed+pushed by orchestrator.
- Task 3: complete (fix round 1). Ruling: RATIFIED out-of-path test edits in bcec25c (send_invoice first invoice draft; paid-invoice delete/void errors) — contradicted by implemented behavior
- Task 4: OPEN_AT_CAP on held-out exposure (#7, #9, #12 rows in implementer context). Ruling: keep held-out set, disclose (templates-validation.md, day-0 report, sealed-log note) — cost: #7 generalization may read optimistic. RATIFIED test edit (trial_period_days→trial_end). Task 4: complete.
### docs/plan/impl/2026-09-26-w5-application-pricing.md

### Final review (whole project)
- **C1: LLM-authored code runs only in Docker** with `--network none`, `--read-only` and `--cap-drop ALL`, with the oracle mounted read-only and no host env. If Docker is unavailable, the assisted pass refuses. Cost if wrong: none (the assisted pass is only skipped).
- **E1: causal event order** (plan §3.1). Precedence pairs come from the oracle and ties never violate. The compare method is now published as `m2`, and the curve carries the annotation "method change". Cost: every published score moved once.
- **L1: public changelog.** `site/data/changelog.json` is backfilled from the sealed log and holds no values.
- **R1: automation ratio shows two units per class.** Patches are JSON-pointer edits for automatic and merged PRs for assisted. Train divergences removed are shown alongside, so the unlike units are explicit.
- **S1 (F15): one combined surface-added entry.** It covers the unlogged post-freeze twin commits f0365c0, 0dc6b2e, 0f7002c and 09dd79e.
- **Kept as known limits** rather than changed:
  - the sealed-log hash format (runId is outside the hash; changing it would invalidate the 187-entry chain);
  - L2 computed on normalized bodies;
  - `action.yml` pins Node 22 for the consumer.
- **N1: nightly landing order.** Pending branch → parity push → log main. `reland()` recovers entries if a push fails, including a push whose reply was lost.
- **Not done because a permission was denied: disabling the `nightly` workflow on GitHub** (the classifier refused it). It stays HUMAN B6.

### docs/plan/impl/2026-09-27-b1-unblock.md
- Ruling: B4 answered (Stripe Support restated the policy, 500 reads per transaction on average and at least 10,000 a month, without saying whether sandboxes are exempt) → keep the cap of 10,000 GETs per rolling 30 days; send the follow-up B4b; the nightly slice becomes budget-sized, and the weekly noise pair runs only if it fits (follow-up task) — cost if wrong: a slower full-corpus refresh while the 30-day window holds one-off runs
- Ruling: B4b answered (the ratio applies only to live-mode activity, sandbox test charges are not transactions, every account gets at least 10,000 reads a month) → **the 10,000 GETs per rolling 30 days is binding** for the sandbox, not a stand-in (decision 0001 C2; STATUS B4). Design unchanged; the budget-sized slice is confirmed necessary. Raising the cap needs a request to Support with ~6 weeks' notice — cost if wrong: none (the cap is the documented floor)
### docs/plan/impl/2026-09-28-post-v1-hardening.md
- Ruling: budget-sized nightly. Each night records `min(one seventh of the corpus, floor((10,000 − 1,500 − rolling30) / 7))` sequences, the longest prefix of the rotation that fits, with a rotation cursor in the data repo (02c6d18, `src/nightly.ts`). The weekly noise pair runs only if it fits the 30-day headroom left after the slice, else it waits for the next night (1f9720c) — cost if wrong: a full-corpus refresh takes more than 7 nights while the window holds one-off runs; none within budget at ~245 GETs a night on average
- Ruling: #28 exposure (B1-unblock Task 1 printed its step intent, step count and event count to an implementer; no results or bodies) → #28 stays held out and the exposure is disclosed, as in the 2026-09-26 precedent for #7, #9 and #12 (decision 0002 §4.5; `docs/plan/impl/templates-validation.md`, day-0 report limitations, a sealed-log note) — cost if wrong: the held-out clocks score may read optimistic; there is no before/after held-out score for #28, because it had no sandbox recording before oracle v1
### docs/plan/impl/2026-09-28-assist-status-h4-expand.md
- Ruling: self-approval refused → Adam merges. The permission classifier refuses a merge or approval of an assisted PR by Claude, so merging stays HUMAN (STATUS B7): Claude runs the two-reviewer check and posts one command per PR. Claude never merges, approves or closes a PR — cost: one human step per assisted PR
- Ruling: PR #1 over #2. Both came from the first CI nightly (run 36425251963) and patch the customer create in `src/twin/resources/customers.ts`. #1 sets both `invoice_prefix` and `next_invoice_sequence`, and #2 only `next_invoice_sequence`; the gain appears only with both fields (#2 alone left train L3 at 26.8%). #1 merged (f387152: train L3 26.8→47.5%, held-out L3 18.1→39.1% on oracle v1); #2 closed as superseded — cost if wrong: none (#2's change is contained in #1)
- Ruling: H4's `switch-to-annual` check stays unchanged after seeing the sandbox result (on the sandbox the interval swap succeeds and the task fails its check that the latest invoice is a `subscription_update` invoice). Changing the check after seeing the sandbox would tune H4 to the sandbox (`evals/h4/tasks.json` untouched; `reports/2026-09-28-h4.md`) — cost if wrong: the 20/20 includes one fail/fail agreement for different reasons; scored strictly without it, 19/19 (Wilson 95% CI 83.2–100.0%) gives the same verdict
