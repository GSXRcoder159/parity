# Parity MVP/POC — Execution Plan

**Date:** 2026-09-25 · **Owner:** Adam · **Deadline:** YC W27 application, Nov 2 2026 8pm PT (38 days) · **Capacity:** solo, ~35 h/wk ≈ 190 h · **Cash cap:** <$1,000
**Source thesis:** `parity-research.md` (direction, not constraint). **Evidence base:** `docs/research/2026-09-25-evidence.md`.

---

## 0. What this MVP is for

One sentence being tested: **"A public, reproducible fidelity number, kept true nightly against the real Stripe sandbox, is worth more to agent teams than another twin."**

The MVP therefore has three parts, built in this order:

1. **ParityBench** — a probe harness that scores *any* Stripe-compatible server against the real sandbox and publishes the method, the noise floor, and the score.
2. **Parity twin** — an open-source, stateful Stripe *Billing-write-path* twin (scope in §2), scored nightly by ParityBench.
3. **Align loop** — the nightly job that turns divergences into patches, with graduated automation (§3.3), plus a free drift instrument.

Everything else in the research doc (hosted parallel cloud, private alignment, auto-PR drift guard, Slack twin, leaderboard for third-party twins) is **out of scope before Nov 2**.

---

## 1. Hypotheses, ordered by kill-power per hour

| # | Hypothesis | Confirm | Kill / pivot | When | Cost |
|---|---|---|---|---|---|
| **H0 Oracle** | The real sandbox is usable as an oracle: noise floor (real-vs-real disagreement on identical sequences) is low, and throughput supports a nightly corpus. | Throughput (W0): ≥500 non-clock sequences/hour; ≥20 clock sequences/hour in parallel. Noise floor (end W1, once normalization v1 exists): ≤3% at value level after normalization. | Noise floor >10% → score must be reported per stratum and time-dependent paths excluded; <100 seq/h → corpus shrinks, "nightly" becomes "weekly" and the plan says so. | W0 (throughput), W1 (noise floor) | ~8 h |
| **H1 Gap** | Existing Stripe mocks are materially wrong off the happy path. | Best existing twin <80% sequence-level agreement on the stateful/error corpus. | ≥95% → no fidelity gap to sell; pivot to drift-only (research option C). *Expected: confirm trivially; stripe-mock is stateless by design and localstripe lacks proration/test clocks.* | W1 | ~10 h |
| **H2 Loop** | An align loop raises the Parity twin from scaffold baseline to ≥90% held-out value-level agreement on the scoped surface, with mechanical divergence classes patched automatically and semantic ones founder+LLM-assisted, at ≤$15/day. | Curve reaches ≥90% held-out by end of W4; ≥60% of applied patches are auto-synthesized (mechanical classes). | Plateau <80% by end W4, or <30% of patches automated → the automation thesis is unproven; YC pitch becomes "ParityBench + drift feed" and the twin is a hand-maintained reference. | W2–W4 | ~90 h |
| **H3 Demand** | Teams whose code/agents write to Stripe Billing will install in CI and pay. Track two cohorts: **A** agent startups (Parahelp, Fini, Decagon, Dimely, LedgerUp, JustPaid, +Autumn as channel), **B** any Stripe-Billing team with CI. | ≥20 conversations, ≥5 CI installs within 14 days of first contact, ≥2 LOIs ≥$200/mo (or ≥1 paying) by Nov 2; ≥150 GitHub stars in 7 days post-launch. | <2 installs by Nov 2 → cohort A is a construct; if cohort B converts, reposition to "stateful Stripe testing for everyone" with agents as narrative; if neither, API choice is wrong (try Slack/GitHub after Nov 2). | Day 1 → W5 | ~35 h |
| **H4 Sim-to-real** | Pass/fail of an eval suite on the twin predicts pass/fail on the sandbox. | ≥95% pass/fail agreement on a partner suite or on the Stripe-gym fallback (§5.4). | <90% → stop and fix before any pricing conversation. | W4 | ~15 h |
| **H5 Drift** | Nightly probing catches real behavioral changes. | Instrument only; a real event in 5 weeks is a bonus (Stripe ships ~2 breaking releases/yr, monthly additive). | Not a kill criterion before Nov 2. | W3+ | ~4 h |

---

## 2. Scope

### 2.1 Twin surface v0 (the ICP call graph, not "all of Billing")

What support/billing agents actually call: look up customer and subscription → preview a prorated plan change → apply it → cancel → refund. That fixes the surface:

| Resource | Endpoints | Behaviors that must be right |
|---|---|---|
| Customers | create / retrieve / update / delete / list / search | id format, `deleted` tombstone, `expand[]`, list pagination (`starting_after`, `limit`) |
| PaymentMethods | attach / detach / list; `pm_card_*` test tokens | default_payment_method on customer/subscription; declines via `pm_card_chargeDeclined` |
| Products, Prices | create / retrieve / update / list | recurring intervals, `unit_amount`, `active` toggles |
| Subscriptions | create / retrieve / update / cancel / list | `proration_behavior`, quantity/price changes, `cancel_at_period_end`, `status` machine (`active`, `past_due`, `canceled`, `incomplete`), `latest_invoice` |
| Invoices | retrieve / list / preview (`create_preview` or `upcoming`, whichever the pinned version uses) / pay / void | proration line items, `amount_due`, `status` machine (`draft`→`open`→`paid`/`void`), finalization on subscription create |
| Refunds, Charges, PaymentIntents | refunds create/retrieve/list; charges/PIs retrieve only | full/partial refund, `amount_refunded`, over-refund error |
| Events, Webhook endpoints | events list/retrieve; webhook endpoint CRUD; delivery | correct event *set* per action, signature header, retries |
| Test clocks | create / advance / retrieve / delete | frozen time, async advance status, 3-customer cap, period rollover creating invoices |
| Cross-cutting | idempotency keys, error envelope (`invalid_request_error` codes, `resource_missing` 404, `card_error` 402), API-version pin, `Stripe-Account` ignored | replay identical status+body within 24h; same key + different params → error |

**Explicitly excluded v0:** Quotes, Subscription Schedules, Coupons/Promotion codes, Tax, Checkout, Connect, Billing Portal, Meters/usage-based billing, Disputes. Surface widens only when a partner's recorded call shapes need it.

### 2.2 Deliverables by Nov 2

- `parity` repo (Apache-2.0, plus a public pledge: alignment loop and score stay open).
- `parity bench <baseURL>`: score any Stripe-compatible server; JSON + Markdown report.
- `parity twin`: `npx parity twin` / Docker; `POST /_parity/reset` (<50 ms), `POST /_parity/seed`.
- `parity align`: nightly job; sealed append-only log of probes/diffs/patches/scores.
- `parity agree <suite>`: run a customer's test/eval suite twice (twin, sandbox) and report pass/fail agreement.
- Nightly score page (GitHub Pages): curve, per-stratum scores with CIs, noise floor, normalization-rules version, drift feed.
- GitHub Action (`parity/twin-action`) that boots the twin in CI.
- MCP server (same handlers) and a thin Prime Intellect `verifiers` environment (Python package over HTTP) — both are ≤1 day each and only if W3 is on schedule.
- YC application with: stars, installs, the daily fidelity curve, sim-to-real number, LOIs.

### 2.3 Cut list (and when each comes back)

| Cut | Comes back when |
|---|---|
| Hosted parallel cloud / usage metering | A paying team asks for >50 parallel instances; until then Docker + Action + `reset` cover it |
| Third-party leaderboard | Arga/LocalStack ToS read and a vendor agrees to be scored |
| Private alignment to a customer's account config | First LOI mentions Connect/tax/custom settings |
| Drift auto-PRs | A real drift event is caught |
| Slack twin | After Nov 2; it is the cost-to-API-#2 receipt for the interview |
| Poesia-style max-entropy probe search | v1 spec-driven random walks plateau on coverage |

---

## 3. Architecture

Language: **TypeScript on Node 22** for harness, twin, and align loop (reuse Slim: `fuzz/gen.ts` seeded generator, `fuzz/minimize.ts` delta-debugging, `fuzz/equal.ts` deep-equal with tolerance flags, `generate/llm.ts` + `generate/repair.ts` LLM repair loop, `evidence/report.ts`, `github/pr.ts`). Python only for the `verifiers` wrapper. Single binary later via `bun build --compile` if distribution demands it.

### 3.1 ParityBench (probe harness)

- **Sequences.** A probe = ordered list of HTTP steps with symbolic references (`$c1.id`) resolved from earlier responses. Sources, in order of build: (v0) ~30 hand-authored **scenario templates** across MIRAGE-style categories — lifecycle, proration, cancellation, refunds, error paths, boundaries (limits, negative amounts, currency minimums), idempotency, events/webhooks, pagination, test clocks — each parameterized and instantiated with Slim's seeded generator; (v1, W3) spec-driven random walks using producer/consumer edges from Stripe's OpenAPI (`x-resourceId`, RESTler-style), weighted toward uncovered (endpoint, state) pairs; (v2, post-MVP) intrinsic-motivation search with Poesia.
- **Dual execution.** Same sequence against the sandbox and the target base URL; each run gets a fresh customer namespace (sandbox) or `reset` (twin). Recordings are stored as JSONL with request, raw response, headers, timing, and the event set observed via `GET /v1/events` polling (webhooks compared as sets plus causal-order constraints, never as strict sequences — Stripe does not guarantee ordering).
- **Normalization (versioned, published).** Rules by JSON path: object ids by prefix → `<id:cus>`, timestamps → bucketed relative offsets, `livemode`, `request_id`, `client_secret`, list order canonicalized by `created` then id, `idempotency_key` echoes. Over-normalization hides bugs, so every rule carries a rationale and the rule-set version is part of the score.
- **Score (four levels, each with Wilson 95% CI, per stratum and overall):**
  - L1 status agreement (HTTP status per step),
  - L2 shape agreement (keys, types, nesting),
  - L3 value agreement after normalization (MIRAGE "total pass"),
  - L4 sequence pass (every step L3).
  Reported alongside the **noise floor** (L1–L4 for sandbox-vs-sandbox on the same sequences) and the **ceiling** = 100 − noise floor. Any published score without these two numbers is invalid.
- **Held-out.** Two sets: (a) 6 of the ~30 templates held out of repair, refreshed monthly; report CI width honestly; (b) the harder one: partner call shapes never used in repair.
- **Sim-to-real agreement** (`parity agree`): the customer's own suite, run twice; report per-test pass/fail agreement. This is the number buyers care about.

### 3.2 Twin

- **Event-sourced store.** Every write appends Stripe-shaped events to an append-only log; objects are projections. This gives `/v1/events`, webhook delivery, idempotency replay (key → stored status+body, 24 h), and test clocks (advance = replay scheduled transitions to the frozen time) from one mechanism. State is in memory with optional JSONL snapshot; `reset` is a log truncate.
- **HTTP layer.** Form-encoded request parsing (Stripe's nested `a[b][0]` style), OpenAPI-driven parameter validation and unknown-parameter rejection (stripe-mock already proves this is spec-derivable), `expand[]`, pagination, error envelope, API-version pin (start on the version the sandbox reports; `2026-08-26.dahlia` at time of writing).
- **Behavior modules.** One module per resource (`subscriptions.ts`, `invoices.ts`, …) exporting pure transition functions `(state, request) → (events, response)`. This is the unit the align loop patches and the unit an LLM can regenerate with counterexamples.
- **Clean room.** Behavior is derived from the public OpenAPI spec and observed sandbox responses to our own probes; no verbatim copy of Stripe fixtures, no fork of localstripe (GPL-3.0 is incompatible with Apache-2.0).

### 3.3 Align loop (graduated automation, stated honestly)

Nightly, capped at $15 in LLM spend:

1. Run corpus on sandbox + twin; store recordings in the sealed log.
2. **Triage** each divergence deterministically first: `STATUS_MISMATCH`, `MISSING_FIELD`, `EXTRA_FIELD`, `VALUE_MISMATCH`, `EVENT_SET_MISMATCH`, `NONDETERMINISTIC` (present in noise-floor set). Only ambiguous value mismatches go to a mid-tier LLM (Jev typed-decision as an optional cheaper classifier later).
3. **Localize** to the behavior module and the earliest divergent step; **minimize** the sequence with delta debugging (Slim's `minimize` pattern applied to steps).
4. **Patch:**
   - *Automatic (mechanical classes):* missing/extra field with a deterministic value seen in the oracle → response seeding; wrong status → status map fix; enum/constant mismatches. Applied without review if the held-out gate passes.
   - *Assisted (semantic classes):* proration math, state-machine transitions, event sets. LLM proposes a patch to the module with the minimized counterexample; founder reviews and merges. Target: ≥60% of applied patches automatic by W4; report the real ratio.
5. **Held-out gate:** a patch lands only if held-out L3 does not drop and the training-set divergence count falls.
6. **Publish:** score, curve, changelog, normalization version. The sealed log (JSONL, append-only, hashed) is the audit trail; exo's event-log design is the reference, not a dependency.

### 3.4 Drift instrument (free by-product)

Nightly, compare today's *sandbox* recordings to yesterday's on the stable (non-noise) subset. Any normalized diff is a drift candidate: publish to `drift/YYYY-MM-DD.md` with the affected endpoints and probe. No PRs, no alerts before Nov 2.

### 3.5 Distribution wrappers

MCP server over the same handlers (tool per endpoint); `verifiers` environment: `load_environment()` returns a `ToolEnv` whose tools hit the twin, with a rubric that checks final state via the twin's `/_parity/state` endpoint. Each ≤1 day, W3/W4 only if on schedule.

---

## 4. Sandbox realities that shape the corpus (verified in evidence doc)

| Fact | Consequence |
|---|---|
| 25 req/s global in sandbox; per-endpoint 25 req/s | Cap harness at 20 req/s with a token bucket; measure real sequences/hour in W0 |
| Subscriptions: 10 new invoices per sub per minute, 20 per day; 200 quantity updates per sub per hour | Fresh subscriptions per probe; no probe creates >5 invoices on one subscription per day |
| Test clocks: ≤3 customers per clock, advance ≤2 periods per call, async "a few seconds" | Clock probes are a separate stratum (~30% of corpus), run in parallel across clocks; measure wall-clock per advance in W0 |
| Up to 5 sandboxes per account (unverified); `stripe sandbox create` provisions anonymous sandboxes | **W0 must verify** whether anonymous sandboxes count against the cap; if capped, parallel clocks per sandbox is the throughput lever |
| Webhook ordering not guaranteed; sandbox retries 3× over a few hours | Compare event sets + causal constraints; poll `/v1/events` rather than depend on delivery timing |
| Idempotency: 24 h key window, same key + different params → error | Idempotency probes both within and across the window are cheap and high-signal |
| Stripe explicitly discourages load-testing the sandbox and recommends mocking | Quote this in the README; keep harness well under limits |
| API version cadence: monthly additive, two breaking releases per year | Pin the twin to the sandbox's default version; drift feed watches the pinned version |

---

## 5. Timeline (Sep 26 → Nov 2)

Hours are estimates against ~190 h (W0–W5 sum to ~180 h; ~10 h unallocated, and W5 absorbs slippage by cutting MCP/verifiers first).

### W0 — Sep 26–28 (≈15 h): gates and measurements
- Create Stripe account + sandboxes (`stripe sandbox create`; verify cap). Pin API version. Pull `stripe/openapi` `spec3.json` (check its license).
- **Legal gate:** read `stripe.com/legal/ssa` and services terms directly; record the clean-room decision in `docs/decisions/`. No Arga numbers until its ToS is read.
- Throughput measurement: sequences/hour non-clock; seconds per clock advance; parallel clocks.
- Noise-floor measurement: 50 sequences run twice on the sandbox.
- Scenario templates v0 (first 15 of 30).
- **Outreach starts day 1** (§6). 
- *Exit:* throughput measured and raw (un-normalized) noise floor recorded; go/no-go on "nightly". Normalized noise floor is decided at W1 exit with the baseline report.

### W1 — Sep 29–Oct 5 (≈35 h): ParityBench + H1
- Harness: sequence runner, symbolic refs, dual execution, recordings, normalization v1, four-level score with CIs, Markdown/JSON report.
- Templates 16–30; corpus ≥500 sequences.
- Baselines: stripe-mock (all surfaces), localstripe (surfaces it claims), Arga free tier only if ToS permits.
- Publish `reports/2026-10-05-baseline.md`: noise floor, ceiling, per-twin scores on the surfaces each claims.
- *Exit:* H1 decided. **YC line:** "Progress: first measured fidelity of Stripe mocks, N sequences."

### W2 — Oct 6–12 (≈35 h): twin scaffold + first curve points
- Event store, form parser, spec-driven validation, error envelope, idempotency, `/v1/events`, webhook delivery, `reset`/`seed`.
- Behavior modules: customers, products, prices, payment methods, subscriptions (create/cancel), invoices (retrieve/list), refunds.
- Run ParityBench nightly from day 1 of W2; curve starts (expected 30–50% L3). The curve is published **per stratum**, with "surface added" events annotated (test clocks and proration land in W4), so a jump from new coverage is never read as alignment. The automation ratio covers the patch side; this covers the coverage side.
- *Exit:* twin boots in <1 s, passes L1 on ≥80% of non-clock steps. **YC line:** "Demo: `npx parity twin`, curve day 1–7."

### W3 — Oct 13–19 (≈35 h): align loop + launch
- Triage classes, localization, minimization, mechanical auto-patch, LLM-assisted semantic patch, held-out gate, nightly GitHub Actions cron, sealed log.
- Score page on GitHub Pages with curve + drift feed stub. The nightly cron reads the sandbox key from a repo secret; forks run the harness against their own sandbox (documented in README).
- GitHub Action for CI; README with quickstart and the Stripe "we recommend mocking" quote.
- **Launch** (Show HN + X, Thursday Oct 15): "ParityBench: measuring how wrong Stripe mocks are, and a twin that gets less wrong every night." Head-to-head is a footnote; method, noise floor, and the curve are the story. Invite vendors to run the harness.
- v1 spec-driven random-walk probes if time allows.
- *Exit:* H3 star/signup thresholds measured over 7 days. **YC line:** "Users: stars, installs, signups."

### W4 — Oct 20–26 (≈35 h): time, sim-to-real, fidelity push
- Test clocks + proration + subscription update paths in the twin; clock stratum scored.
- `parity agree`: run a partner suite (or the Stripe-gym fallback, §6.4) on twin vs sandbox; publish agreement.
- MCP server; `verifiers` wrapper + Hub listing if W3 landed on time.
- Push held-out L3 toward ≥90%; publish the automatic-vs-assisted patch ratio.
- *Exit:* H2, H4 decided. **YC line:** "Sim-to-real: X% agreement on N tasks; automation ratio."

### W5 — Oct 27–Nov 2 (≈25 h + buffer): application
- YC application, 1-minute demo video (`npx parity twin` → CI run → score page → curve), founder video.
- Drift instrument live; LOIs chased; pricing page (usage tiers from research §5, marked "proposed").
- Freeze: no new surface; only bugs and docs.

### Post-deadline (W6–8): private alignment (first LOI-driven), Slack twin v0 to measure cost-to-API-#2, leaderboard once vendor terms are cleared.

---

## 6. Demand plan (starts day 1)

### 6.1 Cohorts and targets
- **A — agent teams writing to Stripe (6–8 named):** Parahelp, Fini, Decagon, Dimely, LedgerUp, JustPaid; adjacent: Crossmint, Chargebee (MCP roadmap). Source more via YC directory filters (Customer Support, Finance/Accounting, Dev Tools; batches S25–P26) — manual pass, ≈2 h.
- **B — Stripe-Billing teams with CI (any):** GitHub code search for workflows referencing `stripe-mock`, `localstripe`, `stripe listen` in CI; Autumn's users (~40 YC startups); Stripe Discord (137k members) and r/stripe; Lovable/Bolt/Replit users whose Stripe integrations break on regeneration.
- **Channel:** Autumn (OSS billing layer over Stripe, ~2.6k stars). One integration PR or a joint post reaches more of the ICP than 20 cold emails.

### 6.2 The day-1 ask (cheap for them, useful for us)
> "I'm measuring how faithfully Stripe mocks reproduce real Stripe Billing behavior. Send me your Stripe integration tests or 5 eval scenarios your agent runs. This week I'll run them against the real sandbox and the existing mocks and send you every divergence; from mid-October I'll run them on our twin and send the agreement number within 48 hours."

The early runs harvest call shapes for the partner held-out set (§3.1); the 48-hour agreement-number promise starts in W4 when `parity agree` exists. This is also the H4 input.

### 6.3 Funnel targets and tracking
20 conversations → ≥5 CI installs within 14 days → ≥2 LOIs ≥$200/mo by Nov 2. **The LOI names a SKU:** private alignment to the partner's own call shapes plus `parity agree` running in their CI, at $99–$299/mo (research §5 pricing), delivery starting W6. Nothing on the cut list is sold; this is. Track in `docs/demand/funnel.md`: date, company, cohort, ask sent, reply, suite received, agreement number sent, install, LOI. Ask every installer the trigger question: 429s, shared-state flakiness, wrong refund in prod, or "how do you test this?"

### 6.4 Fallback for H4 if no partner suite by Oct 20
Stripe's own post "Can AI agents build real Stripe integrations?" ships eval environments and states that a mostly correct integration is a failure. Run `stripe/agent-toolkit` with a mid-tier model on 20 refund/cancel/proration tasks against twin and sandbox; report pass/fail agreement. This yields a sim-to-real number and a launch hook without a partner.

---

## 7. Launch framing

For developers the protagonist is **fast, isolated, trustworthy Billing tests**; for YC the receipt is the **curve**. The post leads with: (1) nobody publishes how wrong Stripe mocks are, here is a method and a harness anyone can run; (2) the noise floor of real Stripe itself; (3) our twin's nightly curve and the automation ratio; (4) `npx parity twin` in CI in 60 seconds. Competitor scores appear only for surfaces the vendor claims, with rerun instructions, and only where terms allow. stripe-mock's low stateful score is **by design and documented** (its README says it is stateless and does not reproduce behavior); present it as "as documented," never as a failure. Stripe DevRel is a later channel.

---

## 8. Legal and fairness gates

- Read Stripe SSA and services terms directly in W0 (research relied on a summarizer). Record the clean-room design: public OpenAPI spec + our own probe observations; no fixture copying; no localstripe fork.
- Keep probing far below rate limits; never load-test.
- Publish competitor numbers only after reading each vendor's terms; publish methodology, seeds, and the harness so any score is reproducible.
- Do not name Arga's "100% fidelity" claim in the launch; let the harness speak.

---

## 9. Budget and cost discipline

| Item | Cap |
|---|---|
| Stripe sandbox | $0 |
| LLM (triage + patch synthesis, mid-tier model via Slim's `llm.ts`; per-call cost logged, hard daily cap) | $15/day, $400 total |
| Optional Jev typed-decision triage | ≤$20 trial |
| Domain, GitHub Pages, Actions cron | ≤$30 |
| Stripe-gym fallback runs | ≤$50 |
| **Total** | **≤$500** of the $1,000 cap |

Every loop run logs `cost_usd`, tokens, and stops at the cap. No larger run without a written plan.

---

## 10. Risks and fallbacks

| Risk | Signal | Fallback |
|---|---|---|
| Sandbox noise too high for time-dependent paths | H0 noise floor >10% on clock stratum | Score clock stratum separately with wider tolerance; twin stays deterministic; say so |
| Twin scope creep | Any endpoint outside §2.1 before W4 | Refuse; log in `docs/decisions/` |
| Align loop mostly manual | Automation ratio <30% at W4 | Report honestly; pitch ParityBench + drift; keep twin as reference implementation |
| Thin cohort A | <5 replies by Oct 10 | Shift outreach to cohort B and Autumn channel; agents stay the narrative |
| Launch flops | <40 stars, <10 signups in 7 days | Second post at W5 with sim-to-real result; ask Stripe DevRel for a mention only after the number exists |
| Legal objection | Any clause found in W0 | Reduce to spec-derived validation + behavior observed from own account; consult counsel before launch |
| Time | Behind by >1 week at W3 checkpoint | Drop MCP/verifiers/v1 probes; protect harness, twin core, curve, application |
| Competitor response | Arga publishes fidelity numbers | Good: the metric wins either way; invite them onto the harness |

---

## 11. Decision log (made now, revisit only with new evidence)

1. **Stripe Billing write path, scoped to the support/billing-agent call graph** (§2.1), not all of Billing.
2. **TypeScript, reuse Slim**, event-sourced twin, behavior module per resource.
3. **Score = four levels + noise floor + ceiling + CIs**, normalization rules versioned and public.
4. **Graduated automation**: mechanical classes automatic, semantic classes assisted; ratio published.
5. **No hosted cloud, no third-party leaderboard, no Slack** before Nov 2.
6. **Outreach from day 1** with the 48-hour agreement-number ask; Autumn as first channel.
7. **Launch leads with method and curve**, not head-to-head.
8. **Clean room from public spec; no GPL forks; legal read in W0.**

## 12. Verify in W0 (unknowns that change the plan)

- Do `stripe sandbox create` anonymous sandboxes count against the 5-per-account cap? Is there a cap on concurrent test clocks?
- Which invoice-preview endpoint the pinned version uses (`create_preview` vs `upcoming`).
- License of `stripe/openapi`.
- Arga and LocalStack terms on benchmarking.
- Real seconds per test-clock advance and sequences/hour at 20 req/s.
- Whether Stripe's `/v1/events` in a sandbox reliably lists events for test-clock-driven transitions within polling windows.
