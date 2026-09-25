# Parity MVP: execution status

Authority: `docs/plan/2026-09-25-parity-mvp-plan.md`. This file is the live checklist; every session starts here.
Legend: `[x]` done and verified by running · `[~]` in progress · `[ ]` not started · **HUMAN** = only Adam can do it.

## Decisions taken at kickoff (2026-09-25)

- npm/CLI name: **`paritybench`** (`npx paritybench twin`, `npx paritybench bench <url>`). npm `parity` is an Ethereum lib and the GitHub `parity` org is taken. Brand stays "Parity".
- Repo: private `GSXRcoder159/parity` now; public at launch (ask Adam first).
- Stripe: claimable sandbox `acct_1UJKSxBXgzwfQJL7` provisioned via `stripe sandbox create --from-git` (email gsprog159@gmail.com). Key in `.env` (gitignored). **Expires 2026-10-02 unless claimed.**
- Outreach: Claude drafts, Adam sends.

## Blockers and HUMAN actions

| # | Action | Why | Deadline |
|---|---|---|---|
| B1 | **HUMAN:** claim the sandbox (`stripe sandbox claim` or the claim URL), then create a full `sk_test_` key and put it in `.env` as `STRIPE_API_KEY` | Claimable key (`rkcs_test_`) is refused on `/v1/test_helpers/test_clocks` and `/v1/account`; sandbox is deleted 2026-10-02 | before W0 clock measurement; hard stop 2026-10-02 |
| B2 | **HUMAN:** add `STRIPE_API_KEY` (and later an LLM key) as GitHub repo secrets | Nightly cron (W3) | W2 end |
| B3 | **HUMAN:** send outreach drafts from `docs/demand/outreach.md`; paste replies into `docs/demand/funnel.md` | H3 | from day 1 |

## W0 (Sep 26–28): gates and measurements

- [x] Stripe sandbox provisioned; API version reported by sandbox: `2026-08-26.dahlia`
- [x] Claimable-key coverage: customers, payment methods (`pm_card_visa` attach), prices/products, subscriptions, refunds, idempotency (same key + different params → error), customer search, webhook endpoints, events all work; **test clocks and `/v1/account` refused**
- [x] Invoice preview endpoint for the pinned version: `POST /v1/invoices/create_preview` (`GET /v1/invoices/upcoming` returns "deprecated")
- [ ] `stripe/openapi` license; spec pulled
- [ ] Legal gate: Stripe SSA + services terms read directly → `docs/decisions/0001-clean-room.md`
- [ ] Arga and LocalStack/WonderTwin terms on benchmarking
- [ ] Sandbox cap (5/account?) and concurrent test-clock cap; do claimable sandboxes count
- [ ] Throughput: non-clock sequences/hour at ≤20 req/s
- [ ] Throughput: seconds per test-clock advance; parallel clocks (blocked on B1)
- [ ] Raw noise floor: 50 sequences run twice on the sandbox
- [ ] Scenario templates 1–15
- [ ] Outreach day-1 drafts + funnel tracker
- [ ] Exit: go/no-go on "nightly"

## W1 (Sep 29–Oct 5): ParityBench + H1
- [ ] Harness: runner, refs, dual execution, recordings, normalization v1, four-level score with Wilson CIs, JSON + Markdown report
- [ ] Templates 16–30; corpus ≥500 sequences
- [ ] Baselines: stripe-mock, localstripe (surfaces each claims); Arga only if ToS permits
- [ ] `reports/2026-10-05-baseline.md` with noise floor + ceiling
- [ ] H1 decided

## W2 (Oct 6–12): twin scaffold + first curve points
- [ ] Event store, form parser, spec validation, error envelope, idempotency, `/v1/events`, webhooks, `/_parity/reset` (<50 ms), `/_parity/seed`
- [ ] Behavior modules: customers, products, prices, payment methods, subscriptions (create/cancel), invoices (retrieve/list), refunds
- [ ] Twin boots <1 s; L1 ≥80% on non-clock steps
- [ ] Nightly ParityBench run; per-stratum curve with "surface added" annotations

## W3 (Oct 13–19): align loop + launch
- [ ] Triage, localization, step minimization, mechanical auto-patch, LLM-assisted patch, held-out gate, sealed log
- [ ] Nightly GitHub Actions cron; score page on GitHub Pages; drift feed stub
- [ ] GitHub Action (boot twin in CI); README quickstart + Stripe "we recommend mocking" quote
- [ ] **HUMAN:** launch Show HN + X, Thu Oct 15 (Claude drafts)

## W4 (Oct 20–26): time, sim-to-real, fidelity push
- [ ] Test clocks + proration + subscription updates in twin; clock stratum scored
- [ ] `paritybench agree`; partner suite or Stripe-gym fallback; publish agreement
- [ ] MCP server; `verifiers` wrapper (only if W3 on time)
- [ ] H2, H4 decided; automation ratio published

## W5 (Oct 27–Nov 2): application
- [ ] Drift instrument live
- [ ] YC application draft (Claude); **HUMAN:** demo video, founder video, submit by Nov 2 8pm PT
- [ ] Pricing page ("proposed")

## Log
- 2026-09-25: kickoff; repo scaffolded; sandbox provisioned; W0 started.
