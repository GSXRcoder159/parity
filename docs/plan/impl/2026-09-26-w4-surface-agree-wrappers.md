# Implementation plan: W4, surface expansion (proration, invoices, test clocks), sim-to-real, wrappers

Spec (authority): `docs/plan/2026-09-25-parity-mvp-plan.md` §2.1, §3.1 (`parity agree`), §3.5, §5 W4, §6.4. Binding decisions: `docs/decisions/0001-clean-room-and-legal-gate.md`, `docs/decisions/0002-twin-architecture-and-rolling-oracle.md` (§3 classes: this plan's twin changes are **surface-added**). Prior plans: `docs/plan/impl/2026-09-26-w3-align-nightly.md` (align, sealed log, nightly).

## Global Constraints

- Engineering: Node ≥22.18 type stripping, explicit `.ts` imports, `import type`, `npx tsc -p tsconfig.json` passes, `node --test test/*.test.ts`, no new runtime dependencies (Python wrapper: `uv`, `pytest`), ponytail minimalism with `// ponytail:` ceilings. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only your paths.
- **Surface-added honesty.**
  - Every twin behavior change here is scaffold-like work after the freeze. Record it in the sealed log with `paritybench align surface --note "<what>"` (Task 1): one entry per task, with the score before and after, oracle provenance, and the commit.
  - Hand-written behavior may follow public Stripe docs and the **train** oracle recordings (statuses, event sets, amounts, transitions).
  - Hand-copying observed field values into `src/twin/shapes/` or `errors.json` messages is still forbidden; that stays the align loop's job.
- **Held-out integrity.**
  - Implementers never open recordings of held-out templates #7, #9, #12, #18 or #21 (in `../parity-data` or `recordings/`), and never read their rows in `templates-validation.md` while implementing.
  - Tests may run held-out templates against the twin only through `score-twin`, and only to report the score, never to tune it.
- **Sealed log persistence:** after every `align surface`, commit and push the data repo (`git -C ../parity-data add align/log.jsonl && git -C ../parity-data commit -m ... && git -C ../parity-data push`). Otherwise the CI nightly forks the hash chain.
- **Sandbox:** the claimable key is refused until B1. Nothing in this plan records on the sandbox. Clock templates and live validations that need the sandbox are written and dry-run against the twin, then marked "unvalidated until B1" in their reports. The budget gate and circuit breaker stay in force.
- **LLM spend** (H4 only): every call goes through `src/align/llm.ts` and the ledger `budget/llm.jsonl`. H4's total cap is $50. Without `ANTHROPIC_API_KEY` there are no live runs; state that plainly.
- Nothing public: no npm publish, no Hub listing, no Pages. Everything public waits for the launch gate in `docs/plan/STATUS.md`.

## Task 1: Surface-added log entries and curve annotations

**Paths:** `src/align/*.ts`, `src/cli.ts`, `src/nightly.ts`, `test/align-*.test.ts`, `test/nightly.test.ts`, `test/twin-core.test.ts`

- `paritybench align surface --note "<text>" [--commit <sha>]`:
  1. Runs `score-twin` on the current oracle for the working tree, and on a temp checkout of `<commit>^` (default: HEAD's parent), to get before and after scores.
  2. Appends a sealed-log `patch` entry `{class: "surface-added", status: "applied", note, commit, before, after}` with provenance.
  3. Prints the deltas.
- The nightly curve writer adds each surface-added entry since the previous curve point as an `events` annotation (`"surface-added: <note>"`). The score page already renders annotations.
- Match the entry shape nightly already reads: W3 Task 4 defined `class: "surface-added"` with a `surface` field. Read `src/nightly.ts` and keep one shape.
- **W3 carry-overs** (from the W3 reviews; these are in this task because it owns `src/nightly.ts` and `src/align/*`):
  - (a) **Secrets never reach LLM-authored code.** The score-twin child process that the gate and the assist pass spawn gets a minimal env: `PATH`, `HOME`, `NODE_*`, `PARITY_DATA_DIR` and `CI` only. No `ANTHROPIC_API_KEY`, `GH_TOKEN`, `STRIPE_API_KEY` or `PARITY_DATA_TOKEN`. Add a test that asserts the child env.
  - (b) nightly's degraded path catches only sandbox-refusal errors (circuit breaker, budget gate, HTTP 429). A missing key or a programming error fails the run loudly.
  - (c) Tonight's read-ledger entry and slice file are persisted as soon as recording ends, not only at the final push.
  - (d) The curve point carries `oracleSeqs`. When it grows versus the previous point, nightly emits an `"oracle expanded: <old>→<new>"` annotation.
  - (e) Seed the noise pair from the W0 A and D recordings (`recordings/2026-09-2{5,6}/` or `../parity-data/runs`) under the names nightly recognizes, labelled as the 2026-09-25 pair covering templates #1–#15. Commit and push the data repo.
  - (f) The in-process twin reset bound in `test/twin-core.test.ts` gets the ×3 CI slack.
  - (g) `align --apply` refuses when `src/` or `templates/` has uncommitted changes, not only the data files.
- Tests: the entry shape, that the annotation is emitted once, and (a)–(d).

## Task 2 (surface-added): Subscription updates and proration

**Paths:** `src/twin/resources/subscriptions.ts`, `src/twin/resources/invoices.ts`, `src/twin/billing.ts`, `src/twin/errors.json` (status/type/code/param only), `test/twin-proration.test.ts`
**Depends on:** Task 1.

- `POST /v1/subscriptions/{id}` with item changes:
  - `items[i][id]` + `price` (swap), `quantity`, `items[i][deleted]`, new items;
  - `proration_behavior` ∈ `create_prorations` (default), `none`, `always_invoice`;
  - `proration_date`; `billing_cycle_anchor=unchanged|now`.
- Flexible billing mode (dahlia default) proration: credit for unused time on the old price and debit for the remaining time on the new one, computed by the second over the item's current period, with Stripe's documented rounding. Proration line items become pending invoice items (`create_prorations`), or an invoice created, finalized and paid immediately (`always_invoice`).
- The legacy `subscription.quantity` is computed from the single item's quantity. This overrides the automatic template default `1`, which the W3 align run seeded from quantity-1-only data.
- Events per branch follow the train recordings of #16 and #17.
- `POST /v1/invoices/create_preview`:
  - with `subscription` + `subscription_details[items]` (+ `proration_behavior`, `proration_date`), or `customer` + `subscription_details` for a new subscription → a preview invoice object (`id` absent per the docs, `lines` with proration lines);
  - `customer` alone → the observed 400.
  - `GET /v1/invoices/upcoming` → the observed deprecation error.
- Validate with `score-twin --templates` on train templates #16 and #17. Report before/after per step.
- Log: `align surface --note "subscription updates + proration + create_preview"`.

## Task 3 (surface-added): Invoice lifecycle

**Paths:** `src/twin/resources/invoices.ts`, `src/twin/billing.ts`, `src/twin/validate.ts`, `src/twin/resources/subscriptions.ts`, `src/twin/errors.json` (status/type/code/param only), `test/twin-invoices.test.ts`, `test/twin-proration.test.ts`
**Depends on:** Task 2.

- `POST /v1/invoices/{id}/finalize`, `/pay` (incl. `paid_out_of_band=true`; paying with the default payment method), `/void`; `send_invoice` subscriptions (`days_until_due`, `due_date`).
- `POST /v1/invoices/{id}` (update `metadata`/`description` on draft/open) and `DELETE` (draft only) where train #11 and #19 exercise them.
- Status machine: `draft` → `open` → `paid` | `void` | `uncollectible`, with error statuses for invalid transitions (train recordings or docs).
- Validate on train #19 and #11. Log surface-added.
- **Also (gaps found by H4, W4 Task 8):**
  - (a) Form booleans also accept `True`/`False`, which the official stripe-python 11.x sends (captured by H4). This change is in `src/twin/validate.ts`; add that file to your paths. Mark it "unvalidated until B1" in the report.
  - (b) Subscription price swaps across billing intervals (e.g. monthly → annual) reset the billing cycle anchor to now and prorate per the docs. This is in `src/twin/resources/subscriptions.ts` and `src/twin/billing.ts`; add those paths.
  - Log both in the same surface-added entry.

## Task 4 (surface-added): Test clocks and clock templates #27–#30

**Paths:** `src/twin/resources/test_clocks.ts`, `src/twin/billing.ts`, `src/twin/resources/subscriptions.ts`, `src/twin/resources/customers.ts`, `src/twin/server.ts` (clock time resolution only), `src/twin/errors.json` (status/type/code/param only), `templates/clocks.ts`, `templates/index.ts`, `test/twin-clocks.test.ts`, `test/corpus.test.ts`, `docs/plan/impl/templates-validation.md`
**Depends on:** Task 3.

- **Twin:**
  - CRUD + list for `test_helpers/test_clocks`; `advance` to `frozen_time` (must be later; at most 2 intervals of the longest subscription interval, per the docs).
  - The clock's `status` is `advancing`, then `ready`. After advance returns `advancing`, a retrieve 1 s or more later (wall clock) sees `ready`. `// ponytail:` fixed delay.
  - Customers created with `test_clock` are capped at 3 per clock. Subscriptions of clock customers use the clock's time.
  - Advancing runs every due transition in time order:
    - period rollover → renewal invoice (draft; auto-finalized and charged when the clock passes 1 hour after creation, as documented);
    - trial end;
    - `cancel_at_period_end` → `canceled`;
    - a failing payment method → invoice `open`, subscription `past_due`, retries per the documented smart-retry defaults (ponytail: the fixed schedule from the docs);
    - events are stamped with clock time;
    - `test_helpers.test_clock.advancing` / `.ready` events.
  - Deleting a clock deletes its customers and objects.
  - `Parity-Now` stays the wall-clock override for non-clock objects.
- **Templates #27–#30** (catalog in `docs/plan/impl/2026-09-25-w0-w1-harness.md`):
  - #28 is held out.
  - The clock stratum waits for `ready` with `waitMs` plus a retrieve loop: the runner has no loops, so use repeated retrieve steps with `waitMs`, per the docs' "a few seconds".
  - At most 3 customers per clock; at most 5 invoices per subscription.
  - Dry-run all four against the twin. Mark every row in `templates-validation.md` **"unvalidated until B1"** and list the facts the sandbox run must confirm: advance seconds, whether events for clock transitions appear in `/v1/events` within the sweep window, and whether `created` follows the frozen time.
- Log surface-added.

## Task 5: `paritybench agree`

**Paths:** `src/agree.ts`, `src/cli.ts`, `test/agree.test.ts`, `examples/agree-suite/`

- `paritybench agree --cmd "<test command>" [--junit <path>] [--runs twin,sandbox] [--out reports/<name>]`:
  - Runs the command once per target with env `STRIPE_API_BASE=<base>` (twin: an in-process twin on an ephemeral port; sandbox: `https://api.stripe.com`) and `STRIPE_API_KEY` (twin: `sk_test_parity`; sandbox: from `.env`, budget-gated).
  - Parses the JUnit XML the command writes to `--junit` (or `node --test` TAP from stdout if `--junit` is absent).
  - Reports per-test pass/fail on each target, agreement % with Wilson CI, and the disagreeing tests. The report contains test names and outcomes only, never response bodies.
- `examples/agree-suite/`: a tiny `node:test` suite (about 8 tests) exercising the ICP call graph through `fetch` against `process.env.STRIPE_API_BASE`: create customer + subscription, preview a price change, apply it, cancel, refund. It documents the one-line contract a real suite needs (respect `STRIPE_API_BASE`, or the SDK's host option).
- Run the twin half live, and include `--runs twin` output in the task report. The sandbox half is blocked on B1; say so.

## Task 6: MCP server over the twin

**Paths:** `src/mcp.ts`, `src/cli.ts`, `test/mcp.test.ts`, `README.md` (one section)
**Depends on:** Task 5 (shares `src/cli.ts`).

- `paritybench mcp` is a minimal stdio MCP server (JSON-RPC 2.0, protocol version per the current MCP spec; hand-rolled, no SDK dependency).
  - It supports `initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
  - It exposes one tool per twin route, named from the spec operation (e.g. `post_v1_subscriptions`), with an input JSON Schema from the pruned spec's request schema (path params plus body/query params). There are also `parity_reset` and `parity_state`.
  - Calls go to an in-process twin.
  - Results are the JSON response (status plus body) as text content. Errors are returned as tool results with `isError: true`, not as JSON-RPC errors.
- Test by spawning the server and driving it with JSON-RPC over stdio: initialize, list, call create customer, call retrieve, call reset.

## Task 7: Prime Intellect `verifiers` environment (Python)

**Paths:** `python/parity_verifiers/` (uv project: `pyproject.toml`, `parity_verifiers/__init__.py`, `tests/`)

- Check the current `verifiers` API from its docs or source; do not rely on memory.
- `load_environment(base_url="http://127.0.0.1:12111", tasks=None, **kwargs)` returns a `vf.ToolEnv`:
  - tools = thin HTTP wrappers over the twin: customer lookup, subscription retrieve/update/cancel, invoice preview, refund create;
  - a small built-in task set of 10 billing-support tasks, each with a setup seeded through `/_parity/seed` or API calls and a rubric that checks final state via `/_parity/state`.
- `pytest` spawns the twin (`node src/twin/main.ts --port 0`) and checks that a scripted, non-LLM tool sequence solves one task and fails another.
- No Hub publish (launch gate).

## Task 8: H4 sim-to-real harness (Stripe-gym fallback, plan §6.4)

**Paths:** `evals/h4/` (tasks, runner, README), `src/cli.ts` (subcommand `h4` only if simpler than a standalone script), `test/h4.test.ts`, `budget/`

- **Tasks:** 20 refund/cancel/proration tasks as JSON. Each has:
  - a setup sequence (reusing the template step format and runner);
  - a natural-language instruction for the agent;
  - a success predicate over final state, checked by API reads against the same target.
- **Agent:** Python `stripe-agent-toolkit==0.6.1` with `stripe.api_base` pointing at the target (per `docs/research/2026-09-25-w0-verifications.md`), driven by a minimal Anthropic tool-use loop. Model `claude-sonnet-5`, temperature 0, at most 12 turns, costs through the ledger.
  - `// ponytail:` an agent run, not a gym framework.
- **Runner:** runs every task on the twin and on the sandbox. It reports per-task pass/fail on each, the agreement (the H4 number: ≥95% confirm, <90% stop), the cost, and the model.
- **Now:**
  - Validate the harness with a scripted agent (fixed tool calls, no LLM) on the twin.
  - Run the LLM agent on the twin only if `ANTHROPIC_API_KEY` is present (cap $10 for this check).
  - The sandbox half waits for B1. Say so.
