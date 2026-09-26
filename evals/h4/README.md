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
- `run.ts` is the runner. It runs every task on the twin and on the sandbox, then reports:
  - per-task pass/fail on each target;
  - the agreement, with a Wilson 95% CI, and the verdict;
  - the model and the LLM cost.

```sh
node evals/h4/run.ts --runs twin --agent scripted          # harness validation: no LLM, no sandbox
node evals/h4/run.ts --runs twin --agent llm --cap-usd 10  # needs ANTHROPIC_API_KEY
node evals/h4/run.ts --agent llm --out reports/h4-<date>   # the H4 number: twin + sandbox (after B1)
```

## Status (2026-09-26)

- **Scripted agent on the twin: 19/20 pass.** `switch-to-annual` fails because the twin answers `not_implemented` to a
  price with a different interval (`src/twin/resources/subscriptions.ts`). This is a twin surface gap, and the task stays
  in the suite: removing it would tune H4 to the twin.
- **LLM agent: not run.** There is no `ANTHROPIC_API_KEY` in the environment or `.env`. The tool-use loop, the ledger and
  the caps are tested against a fake Messages API only.
- **Sandbox half: waits for B1.** The claimable key is refused, so there is no H4 number yet. The sandbox path is tested
  only against a local stand-in upstream, through the metered proxy.

## The agent

- **Model.** `claude-sonnet-5` by default (`PARITY_LLM_MODEL` overrides it). The loop allows at most 12 model calls. Every
  tool call the model makes is run. A reply without a tool call ends the task. The outcome is the checks on the final
  state, however the loop ended.
- **Temperature.** The brief asks for temperature 0, but `claude-sonnet-5` rejects sampling parameters (see `PRICES` in
  `src/align/llm.ts`), so temperature is not sent to it. Runs of that model are not deterministic.
- **Spend.** Every call is written to `budget/llm.jsonl` (purpose `h4`), using `src/align/llm.ts`'s prices, entry shape and
  daily cap. A call is refused before it is sent if it would pass any of three caps:
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

The agent toolkit is MIT, Copyright (c) 2024 Stripe (`stripe/ai`, formerly `stripe/agent-toolkit`). The task themes
(cancel, upgrade with immediate billing, downgrade, preview) follow the task names in its `benchmarks/subscription-gym`.
The task texts, setups and predicates here are our own. The refund tasks are new, because that repository has none.
