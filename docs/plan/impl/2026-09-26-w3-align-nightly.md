# Implementation plan: W3: align loop, nightly pipeline, score page, CI action, launch kit

Spec (authority): `docs/plan/2026-09-25-parity-mvp-plan.md` §3.3–§3.5, §5 W3, §7, §9. Binding decisions: `docs/decisions/0001-clean-room-and-legal-gate.md`, `docs/decisions/0002-twin-architecture-and-rolling-oracle.md` (§1 rolling oracle, §3 what counts as automatic, §5 data locations). Earlier plans: `docs/plan/impl/2026-09-25-w0-w1-harness.md`, `2026-09-25-w2-twin-scaffold.md`, `2026-09-26-w1b-oracle-baselines.md`.

## Global Constraints

- Engineering: Node ≥22.18 type stripping, explicit `.ts` imports, `import type`, `npx tsc -p tsconfig.json` passes, `node --test test/*.test.ts`, no new runtime dependencies, ponytail minimalism with `// ponytail:` ceilings. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only your paths.
- **Honesty of the curve and ratio (0002 §3).** Automatic means the patch edits only `src/twin/shapes/*.json` or `src/twin/errors.json`, the value is deterministic in the oracle (the same normalized value in every train sequence where that path appears, and the path is not in the noise set), and the held-out gate passes. Assisted means any code change proposed by the LLM and merged after review. Every twin change after the tag `twin-scaffold-v0` is recorded in the sealed log as `automatic`, `assisted` or `surface-added`.
- **Held-out integrity.** Templates with `heldOut: true` are never shown to patch synthesis, neither the LLM prompt nor the mechanical determinism check. They are used only by the gate.
- **Data (0001 C3).** Raw recordings, the oracle and the sealed log live in the private data repo (`PARITY_DATA_DIR`, default `../parity-data`). The parity repo gets only public-safe artifacts: scores, counts, class and path names, normalization version, and hashes. Nothing public contains response values, fraud or risk fields, or ids.
- **LLM cost discipline (plan §9).** Default model `claude-sonnet-5` (mid-tier), set by env `PARITY_LLM_MODEL`. Every call's tokens and `cost_usd` go to `budget/llm.jsonl`. There is a hard cap of $15 per UTC day, with an env override for a lower cap only. The loop stops at the cap. No LLM call runs when `ANTHROPIC_API_KEY` is absent; the assisted path is then skipped and the log says so.
- **Sandbox (0001 C2).** Every sandbox traffic path uses the budget gate and the circuit breaker, and runs at ≤10 req/s on the nightly path.
- Do not create public resources: no npm publish, no public Pages, no repo visibility changes. Everything public waits for counsel (B5).

## Task 1: Integration: twin subcommand, error-key header, scaffold freeze

**Paths:** `src/cli.ts`, `src/bench/run.ts`, `src/twin/server.ts`, `test/cli.test.ts`, `test/run.test.ts`, `test/twin-core.test.ts`, `docs/plan/STATUS.md`

1. Add a `paritybench twin [--port] [--host]` subcommand that calls `main` from `src/twin/main.ts`. Add a `README` usage line in `help`.
2. The twin adds the response header `Parity-Error-Key: <catalog key>` on every error response. The runner adds `parity-error-key` to its recorded `resHeaders` subset. Real Stripe never sends it, so it can never be a divergence: headers are not compared.
3. Add `paritybench score-twin --oracle <file> [--templates …] [--json out.json]`. It starts the twin in-process on an ephemeral port, runs the oracle's corpus against it with `Parity-Now` per sequence (the W1b `headersFor`), compares against the oracle (normalized, with `--noise` optional), and writes the SeqResults plus the Score as JSON (values kept, because this file is private working data) plus a Markdown summary to stdout. On the full ~520-sequence corpus it must finish in under 60 s on a laptop. Measure it and put the timing in the report.
4. Run `score-twin` on oracle v1 and record the **day-0 scaffold score** (L1–L4 per stratum, train vs held-out) in `reports/<date>-twin-day0.md`, public-safe. Then tag `twin-scaffold-v0` with `git tag -a`.

## Task 2: Align core: triage, localization, mechanical patches, held-out gate, sealed log

**Paths:** `src/align/triage.ts`, `src/align/patch.ts`, `src/align/gate.ts`, `src/align/log.ts`, `src/align/index.ts`, `src/cli.ts`, `test/align-*.test.ts`

- **Triage** (deterministic, `triage.ts`). Input: SeqResults of twin vs oracle, plus noise keys. For each divergence, record its class (existing classes; `NONDETERMINISTIC` if in noise) and its **locus**:
  - **Object field:** walk the oracle body from the divergent path up to the nearest object with an `object` field. That gives `{objectType, fieldPath}`, e.g. `subscription` + `billing_mode.type`.
  - **Error field:** the twin's `parity-error-key` header plus the error field (`message`, `code`, `param`, `type`, status).
  - **Event set:** the template step and its missing/extra event types.
  - **Status:** handler route (method + path pattern).
  - Also record the **earliest divergent step** of each sequence.
- **Mechanical candidates** (`patch.ts`), from **train sequences only**:
  - (a) `MISSING_FIELD` / `VALUE_MISMATCH` / `EXTRA_FIELD` at an object-field locus. The oracle's normalized value at `{objectType, fieldPath}` must be identical in every train occurrence, with none of those occurrences NONDETERMINISTIC. Candidate: set (or delete, for `EXTRA_FIELD` absent from every oracle occurrence) that field in `shapes/<objectType>.json`. Nested paths are set inside the template. Values containing normalization placeholders (`<id:…>`, `<t:…>`, `<run>`, `<opaque>`) are never seeded: they are computed fields, so the case is assisted.
  - (b) Error fields at an error locus. The catalog entry's `status`, `type`, `code` and `param` are set to the oracle's value if it is constant across occurrences. For `message`: if the oracle's normalized message is constant, set it as the template. If it varies only by `<id:PREFIX>` tokens, replace each token with the catalog placeholder whose rendered value produced it (the twin knows the vars; compare against the twin's rendered message). Otherwise the case is assisted.
  - Every candidate is a JSON-pointer edit `{file, pointer, op: "set" | "delete", value?, evidence: {occurrences, seqs}}`.
- **Gate** (`gate.ts`):
  - Evaluate candidate edits by copying `src/` to a temp dir, applying the edits, and running `node <tmp>/src/cli.ts score-twin --json …` in a child process.
  - Accept iff **held-out L3 does not drop** AND **the train divergence count strictly falls**.
  - Apply candidates greedily in batches per file; bisect a failing batch down to single edits.
  - Return accepted edits with before/after scores (train and held-out, L1–L4).
- **Sealed log** (`log.ts`): append-only JSONL at `<dataDir>/align/log.jsonl`. Each entry is `{ts, runId, kind: "score" | "patch" | "gate" | "publish" | "note", data, prev, hash}` where `hash = sha256(prev + JSON(data) + ts + kind)`. A `verifyLog()` function recomputes the chain. Patch entries carry `class: "automatic" | "assisted" | "surface-added"`, the edit or diff, the evidence, and the gate scores.
- **`paritybench align [--apply] [--max-batches N]`**. It scores the twin against the latest oracle, triages, builds mechanical candidates, and gates them. Without `--apply` it prints the plan. With `--apply` it writes the accepted edits to the data files, logs them, and commits the parity repo (`align: N automatic patches (train Δ, held-out Δ)`).
- **Tests:** triage locus on fixtures; the determinism check rejects a field that varies across sequences and one present in noise; placeholder values are never seeded; held-out sequences never feed candidates; gate acceptance and rejection with fake scores; log chain verifies and detects tampering.
- **Live check:** run `align --apply` once on oracle v1 and report how many automatic patches landed and the train/held-out curve before and after, in `reports/<date>-align-first-run.md` (public-safe).

## Task 3: Assisted patches (LLM) with cost ledger and PRs

**Paths:** `src/align/llm.ts`, `src/align/assist.ts`, `src/align/index.ts`, `src/cli.ts`, `budget/`, `test/align-assist.test.ts`

- `llm.ts`: a minimal Anthropic Messages API client over `fetch`. Follow the pattern of Slim's `src/generate/llm.ts` at `~/dev/projects/slim`; copy the idea, not the file. Use temperature 0 and max_tokens 8192. Compute `cost_usd` from the response's `usage` with a per-model price table checked against current Anthropic pricing (state the source and date in a comment). Append to `budget/llm.jsonl`. Refuse the call if today's spend plus the estimate would exceed the cap.
- `assist.ts`:
  - For the top K non-mechanical divergence clusters (default 3 per run), each grouped by locus, pick the smallest train sequence showing it.
  - Truncate that sequence after its earliest divergent step. `// ponytail:` step-dropping minimization needs new oracle runs and is deferred until the read budget allows.
  - Build a prompt: the behavior module source (the file owning the route); the normalized oracle vs twin step bodies up to the divergence; the divergence list; the relevant `templates-validation.md` notes; the instruction to return a full replacement of exactly one file under `src/twin/` (resources or `billing.ts`); and the clean-room rule (no third-party twin code).
  - Apply the reply in a temp copy and run the gate. On pass: create a branch `align/assisted-<date>-<n>`, commit, and open a **draft PR** with `gh pr create --draft` (private repo) carrying the counterexample (normalized), the before/after scores and `cost_usd`. Log a `patch` entry with `class: "assisted", status: "proposed"`. **Never merge.**
  - Merging is a review step; see `docs/plan/STATUS.md` for who reviews.
- `paritybench align --assist` runs the mechanical pass, then the assisted pass within the cost cap.
- **Tests:** against a local fake Messages API server: cost accounting, cap refusal, file-replacement parsing, the gate invoked, and no PR when the gate fails (the `gh` call goes through an injectable command runner).
- **Live check:** only if `ANTHROPIC_API_KEY` is set. Run `align --assist` once with the cap at $3 and report the outcome. If unset, say so plainly in the report and leave the path verified by tests only.

## Task 4: Nightly pipeline, drift instrument, GitHub Actions

**Paths:** `src/nightly.ts`, `src/drift.ts`, `src/cli.ts`, `.github/workflows/nightly.yml`, `.github/workflows/ci.yml`, `site/data/`, `drift/`, `test/nightly.test.ts`, `test/drift.test.ts`

- `paritybench nightly [--dry-run]`, in order:
  1. Record today's sandbox slice (`--slice <dayOfWeek>/7`, budget-gated, ≤10 req/s).
  2. Run `oracle build`.
  3. Run `score-twin` on the full corpus: log a `score` entry and append a public-safe point to `site/data/curve.json` of the form `{date, normalization, overall: {L1..L4 p/lo/hi/n}, byStratum, heldOut, train, events: [annotations such as "surface-added: …"]}`.
  4. Run `align --apply` (mechanical).
  5. Run `align --assist` if a key is present.
  6. Run drift.
  7. Commit and push the data repo, then commit the public-safe artifacts to the parity repo.
  8. Print a summary.
- `drift.ts` compares today's slice against the previous recording of the same sequences, normalized, excluding paths in the noise set. For any remaining divergence it writes `drift/YYYY-MM-DD.md`: endpoints, templates, paths and classes only, no values. It also appends to `site/data/drift.json`. If there is nothing to report, it writes no file and records a `note` entry.
- `.github/workflows/ci.yml` runs `npm ci`, `npx tsc`, and `node --test` on push and PR.
- `.github/workflows/nightly.yml` is a cron at 07:00 UTC plus `workflow_dispatch`. It uses secrets `STRIPE_API_KEY`, `ANTHROPIC_API_KEY` (optional) and `PARITY_DATA_TOKEN` (a fine-grained PAT with contents read/write on `GSXRcoder159/parity-data`). It checks out both repos, runs `paritybench nightly`, and pushes. Commits from the workflow use a bot identity.
- **Local verification:** run `paritybench nightly --dry-run` end to end locally; it records nothing and writes nothing outside a temp dir. Run it once for real if the budget allows (slice ≈ 75 sequences). Validate the workflow YAML with `actionlint` if available via `npx` or `brew`; otherwise run a careful manual review and say so.

## Task 5: Score page, README, CI Action

**Paths:** `site/index.html`, `site/app.js`, `site/style.css`, `README.md`, `action.yml`, `.github/workflows/action-selftest.yml`, `test/site.test.ts`

- **Score page** (static, no build step, no external scripts except one pinned chart library from cdn.jsdelivr.net if needed). It reads `site/data/curve.json`, `site/data/drift.json` and the latest `site/data/scores/<date>.json`. It shows:
  - the nightly curve per stratum (L3 and L4) with Wilson CI bands, "surface added" annotations, and the noise-floor ceiling line;
  - the per-stratum table, train vs held-out;
  - the automation ratio (automatic vs assisted patches over time);
  - the normalization version with a link to its rules;
  - the drift feed.
  It must work at phone width. Include a light and dark theme.
- It states: "Any score without the noise floor and ceiling is invalid", the oracle-age statement from 0002 §1, and the non-affiliation line. There is no "Stripe" in the page title (0001 C4).
- `README.md` covers:
  - what Parity is (ParityBench + twin);
  - a quickstart (`npx paritybench twin`, `paritybench bench <url>`, Docker);
  - the method: the four levels, noise floor, ceiling, CIs, normalization, and the rolling oracle;
  - the verbatim Stripe rate-limits quote recommending mocking;
  - stripe-mock framed "as documented";
  - how to reproduce with your own sandbox key;
  - the license (Apache-2.0) and the pledge that the alignment loop and the score stay open;
  - the non-affiliation line;
  - the list of the twin's supported surface.
- `action.yml` is a composite action. It sets up Node 22, starts the twin from the action's own checkout (`node $GITHUB_ACTION_PATH/src/twin/main.ts --port <input> &`), waits until the port answers, and exports `PARITY_TWIN_URL`. Inputs: `port` (default 12111). `.github/workflows/action-selftest.yml` uses `./` and runs a customer create + retrieve against it.
- `test/site.test.ts` checks that the page's data loaders handle an empty curve and a one-point curve (the JS module is imported in Node).
- Publish a **private preview** of the page is not this task. The orchestrator handles previews.

## Task 6: Launch kit drafts

**Paths:** `docs/launch/show-hn.md`, `docs/launch/x-thread.md`, `docs/launch/demo-script.md`, `docs/launch/vendor-invite.md`

- **Show HN** (plan §7 order):
  - (1) nobody publishes how wrong Stripe API mocks are; here is a method and a harness anyone can run;
  - (2) the noise floor of the real sandbox;
  - (3) the twin's nightly curve and the automation ratio;
  - (4) `npx paritybench twin` in CI in 60 seconds.
  Competitor numbers appear only as a footnote and only for stripe-mock and localstripe (0001 C5). Use real measured numbers from the reports, with a placeholder marked `{{…}}` wherever the number comes after launch day.
- **X thread**, 6–8 posts.
- **Demo video script**, 60–90 s: `npx paritybench twin` → CI run → score page → curve.
- **Vendor invite** to run the harness on their twin (neutral tone).
- Every draft carries the counsel gate at the top ("DO NOT POST before B5 clears"), 0001 C4 naming, and no possessive "Stripe's".
