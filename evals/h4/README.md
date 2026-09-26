# H4 sim-to-real harness

H4 asks whether an agent task's pass/fail on the twin predicts its pass/fail on the real sandbox. The plan sets
≥95% agreement to confirm and <90% to stop before any pricing conversation. This directory is the fallback suite from
plan §6.4, for use when no partner suite exists. It is an agent run, not a gym framework.

- `tasks.json` holds 20 tasks: 6 refunds, 6 cancellations, 8 prorations. Each task has:
  - `setup`: steps in the harness's template format, run by `src/bench/run.ts`. A fixture name expands to its steps.
  - `instruction`: the request in plain language. It names the customer by email.
  - `checks`: API reads of the final state, made against the same target. A field path maps to its expected value,
    or to `{">": n}` or `{"<": n}`. Refs resolve from the setup and from earlier checks.
  - `scripted`: the fixed tool calls that solve the task, for validating the harness without an LLM.
- `toolkit.py` is the agent's tools. It runs the pinned Python `stripe-agent-toolkit==0.6.1` with `stripe.api_base`
  set to the target (W0 verifications §10), as a JSON-lines server under `uv run --script`.
- `run.ts` is the runner. It runs every task on the twin, on a second fresh twin (the control) and on the sandbox,
  then reports:
  - per-task pass, fail or error on each run;
  - the twin-vs-sandbox agreement (the H4 number), with a Wilson 95% CI, and the verdict;
  - the twin-vs-control agreement beside it: the agent's own run-to-run agreement, which is H4's noise ceiling
    (noise floor = 1 − it), as the harness reports its noise floor beside every score;
  - the model and the LLM cost.
- **No score without its floor.** Without the control run the verdict is `none`: the agreement is printed, but it is
  not the H4 number. With it, the thresholds apply to the twin-vs-sandbox agreement as the plan sets them; read it
  against the control. A twin-vs-sandbox agreement near the control's is mostly agent variance, not twin infidelity.
- **Errors are not outcomes.** A task is `error` when its setup failed or the harness or an LLM call threw (a 529 after
  two retries, a dead bridge): the agent's result is unknown. Such a task is listed under "Not measured" and left out of
  the k/n of each agreement whose pair of runs includes the error, and while any task errored on any run (the control
  included) there is no verdict, because H4 is defined over the whole suite.
  Re-run for the number.
- **Early stop.** An LLM cap refusal or a dead toolkit bridge stops the run; the tasks not reached are `error`
  ("not run"), the partial report is still printed and written, and the exit code is 1.
- **Preflight.** When the sandbox is in `--runs`, one authenticated `GET /v1/customers?limit=1` goes through the metered
  proxy before anything else. Any answer but 200 (a refused key, as until B1) refuses the run, so the twin half's LLM
  spend is not wasted.

```sh
node evals/h4/run.ts --runs twin,control --agent scripted  # harness validation: no LLM, no sandbox
node evals/h4/run.ts --runs twin --agent llm --cap-usd 10  # needs ANTHROPIC_API_KEY
node evals/h4/run.ts --runs twin,control --agent llm       # the agent's own agreement, no sandbox
node evals/h4/run.ts --agent llm --cap-usd 15 --out reports/h4-<date>
                                                           # the H4 number: twin, control, sandbox (after B1)
```

A full run (twin, control, sandbox) is up to 60 × 12 = 720 model calls, half again the 480 of twin + sandbox alone.
The per-run default of $10 may not cover it, and the daily cap ($15 per UTC day, which `PARITY_LLM_CAP_USD` can only
lower) may well stop it; the result is then a partial report with no verdict. The cap counts the spend in one ledger,
`<data dir>/budget/llm.jsonl`: it is shared with the nightly's assisted pass only if you pull the data repo before a
local run (the nightly pushes its spend there).

## Status (2026-09-26)

- **Scripted agent on the twin: 19/20 pass; twin vs control 20/20** (the scripted agent is deterministic, so this
  checks the control path, not an agent; rerun 2026-09-26 after the final-review fixes, same result).
  `switch-to-annual` fails because the twin answers `not_implemented` to a price on another billing interval without
  `billing_cycle_anchor=now` (`src/twin/resources/subscriptions.ts`). W4 Task 3 deliberately kept that refusal: how the
  real API aligns the new period when the anchor is not reset is unobserved. This is a twin surface gap, and the task
  stays in the suite: removing it would tune H4 to the twin. **Owner: the first post-B1 recording task** (record the
  monthly → annual swap on the claimed sandbox, then implement what it shows). `test/h4.test.ts` pins the failure in
  `TWIN_GAPS`; the fix removes it from there.
- **Booleans: fixed.** stripe-python 11.6 sends Python booleans as `True`/`False` (e.g. `items[0][deleted]=True`). W4
  Task 3 made the twin accept them (`src/twin/validate.ts`); the real API's acceptance is unverified until B1.
- **LLM agent: not run.** There is no `ANTHROPIC_API_KEY` in the environment or `.env`. The tool-use loop, the ledger and
  the caps are tested against a fake Messages API only, so there is no control number for the LLM agent yet either.
- **Sandbox half: waits for B1.** The claimable key is refused, so there is no H4 number yet. The sandbox path is tested
  only against a local stand-in upstream, through the metered proxy.

## The agent

- **Model.** The H4 number uses `claude-sonnet-5` (the default; `PARITY_LLM_MODEL` overrides it, and the report names
  the model it ran). The loop allows at most 12 model calls. Every tool call the model makes is run. A reply without a
  tool call ends the task. The outcome is the checks on the final state, however the loop ended.
- **Sampling, and why there is a control run.** The brief asks for temperature 0, but `claude-sonnet-5` rejects
  sampling parameters (see `PRICES` in `src/align/llm.ts`), so it runs at default sampling (W4 ruling) and its runs are
  not deterministic. Each task gets one independent attempt per run, so the twin-vs-sandbox agreement mixes the agent's
  own run-to-run variance with twin infidelity, and it biases H4 toward "stop": an agent that repeats its own outcome
  only 90% of the time reads "stop" even against a perfect twin. The control run measures that variance on the same
  tasks, and the report prints it beside the H4 number.
- **Spend.** Every call goes through `src/align/llm.ts`'s `complete()` and is written to `<data dir>/budget/llm.jsonl`
  (purpose `h4`), the ledger the nightly's assisted pass also writes and pushes to the data repo.
  A 429 or 529 is retried twice there; a third one errors that task. A call is refused before it is sent if it would
  pass any of three caps:
  - the daily cap;
  - $50 for all of H4;
  - `--cap-usd` for this run (default $10).
- **Tools.** 0.6.1 has no subscription tools. `list_subscriptions`, `cancel_subscription` and `update_subscription` are
  therefore ported into `toolkit.py` from `@stripe/agent-toolkit` 0.7.12, keeping their names, descriptions and
  parameters. The 0.6.1 tools on offer are customers, products, prices and invoices (read), payment intents (read) and
  refunds (create).
  - A failed call goes back to the model as an `is_error` result. (0.7.12's own subscription tools return a bare
    "Failed to …" string instead.)
- **Pins.** 0.6.1 declares no dependencies, so `stripe==11.6.0` (the release current when 0.6.1 shipped) is pinned in the
  script header and in `toolkit.py.lock`. Under stripe-python 15, the toolkit's `json.dumps` of API objects fails. Every
  request sends the harness's `Stripe-Version: 2026-08-26.dahlia`.

## Sandbox (after B1)

- **Proxy.** The sandbox half runs through `src/agree.ts`'s metered proxy, which does four things:
  - it refuses to start when the rolling 30-day GETs are at the read budget;
  - it holds 20 req/s;
  - it ledgers every request of the setup, the tools and the checks;
  - it halts the run at the budget or after 10 consecutive 429s, and a halted run produces no report.
- **What gets written.** The report (`--out`, `.md` and `.json`) holds task ids and outcomes only (decision 0001 C3). The
  stderr log explains each failure and may quote response values, so never commit it from a sandbox run.
- **For counsel (B5).** During a sandbox run, response bodies reach the model provider as tool results.

## Credits

The agent toolkit is MIT, Copyright (c) 2024 Stripe (`stripe/ai`, formerly `stripe/agent-toolkit`); its notice is in
`LICENSE-agent-toolkit`, which covers the three tool definitions ported into `toolkit.py`. The task themes
(cancel, upgrade with immediate billing, downgrade, preview) follow the task names in its `benchmarks/subscription-gym`.
The task texts, setups and predicates here are our own. The refund tasks are new, because that repository has none.
