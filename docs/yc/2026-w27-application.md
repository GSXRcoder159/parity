> **DRAFT — not for publication before the launch gate (docs/plan/STATUS.md)**

# YC W27 application (draft)

**Batch:** Winter 2027. On-time deadline Nov 2 at 8pm PT; decisions by Dec 11 ([ycombinator.com/apply](https://www.ycombinator.com/apply), fetched 2026-09-26).

**Where the questions come from.** The live form is behind a login at apply.ycombinator.com, and ycombinator.com/apply does not list the questions. The questions below, in order, come from Round Funded, "YC Application 2026: Every Question" ([roundfunded.com/en/blogs/how-to-apply-to-y-combinator-2026](https://www.roundfunded.com/en/blogs/how-to-apply-to-y-combinator-2026)). It says it covers W27 and was last updated 2026-09-20; fetched 2026-09-26. That page says YC edits the form between batches. Cross-checked against a first-hand Spring 2026 submission ([homoky.cz/blog/yc-spring-2026-everything-i-submitted](https://homoky.cz/blog/yc-spring-2026-everything-i-submitted), fetched 2026-09-26), which has the same core questions. The live form may ask follow-up questions that this list does not show.

**Numbers.** Every number is as of 2026-09-26, and the file it comes from is named next to it. A `{{TBD}}` placeholder marks what is not measured yet or what only Adam knows. The checklist at the end lists each one and where to get it.

---

## Founders

### 1. Who writes code, or does other technical work on your product? Was any of it done by a non-founder? Please explain.

I (Adam) do all of it: harness, twin, align loop, reports and outreach. I write the code with Claude Code as my coding agent, and the commits carry its co-author line (`git log`). No non-founder has written code.

### 2. Are you looking for a cofounder?

{{TBD: cofounder answer (Adam)}}. The plan assumes one founder at about 35 hours a week (`docs/plan/2026-09-25-parity-mvp-plan.md`, header).

### Founder video (1 minute)

Script: [`founder-video-script.md`](founder-video-script.md).

---

## Company

### 3. Company name

Parity. The CLI and npm package are `paritybench` (`docs/plan/STATUS.md`, kickoff decisions).

### 4. Describe what your company does in 50 characters or less.

Stripe Billing mock, scored against the real API

(48 characters.)

### 5. Company URL, if any

{{TBD: public repo URL, after the launch gate}}

### 6. Please provide a link to the product, if any.

{{TBD: score page URL, after the launch gate}}. The repo stays private until counsel has reviewed the Stripe terms (decision 0001 C7).

### 7. What is your company going to make? Please describe your product and what it does or will do.

Teams test code and AI agents that write to Stripe Billing against mocks of the Stripe API. Nobody measures how far those mocks are from the real API. Parity measures it, and ships a mock that is measured.

- **ParityBench** runs the same sequences of API calls against the real Stripe sandbox and against any Stripe-compatible server. It scores agreement at four levels: HTTP status, response shape, values after normalization, and whole sequences. Each score comes with a 95% interval and with the noise floor of the sandbox itself, measured by running the same sequences on the sandbox twice.
- **The Parity twin** is an open-source, stateful mock of the Stripe Billing API. Its scope is the calls support and billing agents make: look up a customer and subscription, preview a plan change, apply it, cancel, refund (plan §2.1). Today it serves customers, products, prices, payment methods, subscription create and cancel, invoices, refunds, events and webhooks; proration, plan changes and test clocks are being added in W4 (`docs/plan/STATUS.md`, W2 and W4). It boots in about 0.1 s, and a reset takes about 2 ms with 1,000 objects in it (`docs/plan/STATUS.md`, W2).
- **The align loop** turns each divergence between the twin and the sandbox into a patch. Each patch is logged as automatic (data files only, applied if a held-out gate passes) or assisted (an LLM proposes a code change and I review it), in a hash-chained log (decision 0002 §3).
- **Paid:** private alignment to a customer's own account settings and call shapes, plus `paritybench agree` (being built in W4), which runs the customer's own test or eval suite on the twin and on their sandbox and reports how often pass/fail matches.

The claim we are testing (plan §0): "A public, reproducible fidelity number, kept true nightly against the real Stripe sandbox, is worth more to agent teams than another twin."

### 8. Where do you live now, and where would the company be based after YC?

{{TBD: where Adam lives now and where the company would be based (Adam)}}

### 9. Explain your decision regarding location.

{{TBD: location reasoning (Adam)}}

---

## Progress

### 10. How far along are you?

Work started on 2026-09-25 (`docs/plan/STATUS.md`, log).

- **The gap is real (hypothesis H1, confirmed).** On sequences recorded from the real sandbox, the best existing open mock matches 0% of whole sequences (`reports/2026-09-26-baseline.md`):
  - stripe-mock: 0.0% [0.0–4.2] over 88 sequences, with 80.9% of HTTP statuses right. Its README says it is stateless, so this measures its documented design, not a defect.
  - localstripe: 0.0% [0.0–16.1] over the 20 sequences inside the routes it serves.
  - The oracle holds 88 of the 600 planned sequences (30 templates × 20 seeds). The sandbox key stopped answering before the rest were recorded; claiming the sandbox (B1) unblocks it. H1 does not depend on corpus size.
- **The real sandbox is measured against itself.** Two sandbox runs of the same 60 sequences, 28 minutes apart, differed on 7.6% [5.4–10.6] of steps after normalization v1.1 (`reports/2026-09-25-w0-oracle.md`). All 32 differing steps traced to 6 causes. Under v1.2 the same pair agrees on every step, but v1.2 was written from that pair, so this is in-sample (`reports/2026-09-26-baseline.md`). Proration and boundary templates have no noise pair yet. Throughput: 3,950 and 4,436 sequences per hour in two clean runs (`reports/2026-09-25-w0-oracle.md`).
- **The twin, day 0.** Scored on the 88-sequence oracle, the frozen scaffold returns the right status on 93.8% of steps and every value right (after normalization) on 3.1%, and matches 0 whole sequences (`reports/2026-09-26-twin-day0.md`). Test clocks are refused on the current sandbox key, so the twin's clock behavior cannot be checked against the sandbox until B1.
- **The first align run.** The loop landed 174 automatic patches, all data-file edits that passed the held-out gate (`reports/2026-09-26-align-first-run.md`):
  - train: steps with every value right 3.8% → 18.8%, whole sequences 0% → 5.6%, divergences 8,881 → 1,423;
  - held-out: steps with every value right 0.0% → 8.8%, whole sequences 0% → 0%.
  - Held-out is only partly held out at day 0: the scaffold's own tests used 2 of the then 5 held-out templates (#7, #9), so held-out measures generalization after the freeze only. Later an implementer's context contained the validation notes of #7, #9 and #12 (the align loop never saw them; disclosed in `reports/2026-09-26-twin-day0.md`). Six templates are held out now: `clock-trial-end` was added with the test clocks.
- **Automation so far: 174 automatic, 0 assisted.** The assisted path (an LLM proposes a code change from a minimized counterexample) is built and tested, but it has not run live: it needs an API key (B2). 72 train divergence sites are waiting for it (`reports/2026-09-26-align-first-run.md`). So there is no automation ratio yet. The target, at least 60% of patches automatic, is decided at the end of W4 (plan §1, H2). Counts at W4 exit: {{TBD: automatic and assisted patch counts at W4 exit}}.
- **Nightly pipeline.** Built. Its fallback path ran live on 2026-09-26: the sandbox refused, so it scored the twin, ran the align loop and published a curve point (`docs/plan/STATUS.md`, W3). The cron starts once the repo secrets (B2) and a claimed sandbox key (B1) are in place. Then the twin is scored nightly against an oracle that is at most 7 days old, and drift on any sequence is detected within 7 days (decision 0002 §1).
- **Latest numbers:** {{TBD: latest held-out values-right and whole-sequence scores from the nightly curve}}. Sim-to-real agreement: {{TBD: sim-to-real pass/fail agreement from the W4 H4 run}}.
- **Users:** GitHub stars {{TBD: GitHub stars}}, CI installs {{TBD: CI installs}}, conversations {{TBD: conversations}}, LOIs {{TBD: LOIs at $200/month or more}}. Twenty outreach messages are drafted (`docs/demand/funnel.md`).

### 11. How long have each of you been working on this? How much of that has been full-time? Please explain.

One founder. Research for the thesis came first (`parity-research.md`); building started on 2026-09-25 (`docs/plan/STATUS.md`). The plan budgets about 35 hours a week through Nov 2 (plan header). {{TBD: full-time or part-time, and what else Adam is doing (Adam)}}

### 12. What tech stack are you using, or planning to use, to build this product? Include AI models and AI coding tools you use.

- TypeScript on Node 22, with no runtime dependencies (`package.json`). The twin is a plain Node HTTP server over an event-sourced in-memory store. Its object templates are generated from the public Stripe OpenAPI spec (MIT, pinned by commit).
- Python only for a thin wrapper that exposes the twin as a Prime Intellect `verifiers` environment (planned, plan §3.5).
- Docker image (`node:22-alpine`), GitHub Actions for CI and the nightly run, GitHub Pages for the score page (after the launch gate).
- AI coding tool: Claude Code, with Anthropic Claude models.
- AI in the product: the align loop's assisted path calls the Anthropic Messages API, default model `claude-sonnet-5` (`src/align/llm.ts`), with a $15/day cap (plan §9). Automatic patches use no model: they are decided by rules over the recordings.

### 13. Are people using your product?

Not yet. The repo is private and the npm package is not published until counsel's review (`docs/plan/STATUS.md`, launch gate). Installs: {{TBD: CI installs}}.

### 14. Do you have revenue?

No. The paid SKU is private alignment plus `paritybench agree` in the customer's CI, at $99–$299/month, delivery starting after Nov 2 (plan §6.3). LOIs: {{TBD: LOIs at $200/month or more}}.

### 15. If you are applying with the same idea as a previous batch, did anything change? If you applied with a different idea, why did you pivot and what did you learn from the last idea?

{{TBD: previous YC applications (Adam)}}

### 16. If you have already participated or committed to participate in an incubator, "accelerator" or "pre-accelerator" program, please tell us about it.

{{TBD: incubator or accelerator programs (Adam)}}

---

## Idea

### 17. Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you're making?

**Why this idea.** Mocks of SaaS APIs ("twins") are getting cheap to build. Arga says it will generate them "in minutes", and WonderTwin says its open-source twins are "frozen" while its paid ones "stay current" (`parity-research.md`, Key Findings 1). What is not cheap is evidence that a twin behaves like the real API off the happy path, and keeping that evidence current as the API changes. We found no one who publishes that number for SaaS APIs. The closest precedent is a Microsoft Research study of cloud emulators, which found 94 of 255 APIs discrepant (`docs/research/2026-09-25-evidence.md` §2).

**Why Stripe Billing first.** Money moves, so a wrong refund or proration costs real dollars. The logic is stateful and depends on time (proration, invoices, test clocks), which is where stateless mocks are furthest off. And the oracle is cheap: the sandbox allows 25 requests per second (`docs/research/2026-09-25-evidence.md` §1), and we ran about 4,000 sequences an hour on it (`reports/2026-09-25-w0-oracle.md`).

**Why now.** Agents now write to Stripe: support agents issue refunds and change plans (`docs/research/2026-09-25-evidence.md` §4). And YC's "Self-Maintaining APIs" RFS asks for the product this kind of sensor feeds: "When Stripe ships a breaking change or a new feature, an agent should scan customer codebases, identify affected usages, and open a PR with the fix... or as a neutral third-party service tracking changes across vendors, like Dependabot but for APIs." ([ycombinator.com/rfs](https://www.ycombinator.com/rfs), excerpt in `docs/research/2026-09-25-evidence.md` §3). Re-recording a fixed corpus against the real API detects changes in behavior, including undocumented ones, and the twin is the first consumer of that signal.

**Domain expertise.** The engine is differential testing plus a repair loop. The thesis names the earlier work behind it: my differential testing in Slim, and my τ²-bench retail work on refund and order policies (`parity-research.md` §5, §8). {{TBD: one or two lines of Adam's background (Adam)}}. Advisors: {{TBD: confirm that Ang Chen (Vera/CloudEmu) and Gabriel Poesia agree to be named (Adam)}}.

**How we know people need it.**
- The official mock says it will not model behavior: "stripe-mock is stateless. Data you send on a POST request will be validated, but it will be completely ignored beyond that." and "We are currently not planning to add statefulness or more sophisticated testing features to stripe-mock." ([github.com/stripe/stripe-mock](https://github.com/stripe/stripe-mock), in `docs/research/2026-09-25-evidence.md` §1).
- The Stripe rate-limits page discourages load tests in a sandbox and recommends "a configurable system for mocking out requests to the Stripe API" (`docs/research/2026-09-25-evidence.md` §1).
- The Stripe blog post on AI agents building integrations says "a mostly correct integration is a failure; payments require 100% accuracy." (`docs/research/2026-09-25-evidence.md` §4).
- Teams already pay for twins: Arga Pro is $1,250/month (`docs/research/2026-09-25-evidence.md` §2).
- We have not yet heard it from a customer: {{TBD: conversations}} so far. The named list of agent teams that write to Stripe is short (about 6–8 strong fits, `docs/research/2026-09-25-evidence.md` §4), so outreach also covers any team that tests Stripe Billing in CI.

### 18. Who are your competitors? What do you understand about your business that they don't?

**Competitors** (`docs/research/2026-09-25-evidence.md` §2, `parity-research.md` §1):
- **Arga Labs** (YC P26): closed, hosted twins of 13+ apps; $10M seed; Pro $1,250/month. It says its twins have "100% fidelity" (TechCrunch) and publishes no method to check it. ArgaBench benchmarks agents, not twins. We have not scored it and will only with its written agreement (decision 0001 C5).
- **WonderTwin / LocalStack** (LocalStack acquired WonderTwin on 2026-09-14): open-source twins, a paid tier that keeps twins aligned (price not verified). Its Stripe twin covers Connect (accounts, transfers, payouts), not Billing. LocalStack terms forbid benchmarking without written consent, so we have not scored it.
- **stripe-mock**: official, stateless by design. Measured as documented above.
- **localstripe**: open-source, stateful, GPL-3.0; no proration or test clocks documented. Measured above on the routes it serves.
- Also: hand-written mocks, and the shared sandbox itself (25 requests per second, no reset).

**What we understand that they don't.**
1. The twin is not the asset; the measured score and its history are. Twins are getting cheaper to generate. Proof that a twin matches the real API does not, and it goes stale as the API changes.
2. The incumbents cannot publish an open score cheaply. WonderTwin charges for alignment, and a self-graded "100%" is a liability once a public referee exists. We give alignment and the score away, and charge for aligning to a customer's own account.
3. The real API is not a fixed target. The sandbox disagrees with itself until the comparison is normalized, so a score without a measured noise floor means nothing. We measure it and publish the rules.
4. History cannot be backfilled. The oracle is rate-limited (at most 10,000 sandbox reads per 30 days until Stripe says otherwise, decision 0001 C2), so a divergence record built night after night is hard to reproduce later. It matters more on the next APIs (Slack, GitHub, HubSpot, Salesforce), where sandboxes are scarcer (`parity-research.md` §7, §9).

### 19. How do or will you make money? How much could you make?

Proposed pricing; nothing is for sale yet:
- **Open source, free forever:** the twin, ParityBench, the score and the alignment loop, under Apache-2.0 with a public pledge that the loop and the score stay open (plan §2.2).
- **Private alignment + `paritybench agree` in your CI: $99–$299/month.** We align the twin to the customer's own account settings and call shapes, using the customer's own sandbox key (decision 0001 C8), and report sim-to-real agreement on their suite. This is the SKU in the LOIs (plan §6.3). Delivery starts after Nov 2.
- **Later, not offered yet:** Drift Guard ($299/org/month: alerts and PRs when the real API changes) and Parity Cloud (1,000 hosted runs/month free, then $0.10/run). The plan cuts both until a customer asks (plan §2.3).

**How much.** Beachhead, as an assumption: about 5,000 agent teams writing to SaaS APIs by 2027, at $3.6k/year, is about $18M ARR (`parity-research.md` §9). The larger market is the same measurement on each next API, sold to teams, to environment vendors and to API providers. One analyst tally puts environment vendors at about $8.5B combined revenue (secondary source, `parity-research.md` §9).

### 20. If you had any other ideas you considered applying with, please list them.

{{TBD: other ideas (Adam)}}

---

## Equity

### 21. Have you formed ANY legal entity yet?

{{TBD: legal entity (Adam)}}

### 22. Have you taken any investment yet?

{{TBD: investment (Adam)}}

### 23. Are you currently fundraising?

{{TBD: fundraising (Adam)}}

---

## Curious

### 24. What convinced you to apply to Y Combinator? Did someone encourage you to apply? Have you been to any YC events?

Suggested start: YC's "Self-Maintaining APIs" RFS describes the product that a nightly fidelity score is the sensor for, and several of the agent teams we are contacting are YC companies (Parahelp, Fini, Dimely: `docs/research/2026-09-25-evidence.md` §4). {{TBD: who encouraged Adam and which YC events (Adam)}}

### 25. How did you hear about Y Combinator?

{{TBD: how Adam heard about YC (Adam)}}

---

## Batch

### 26. What batch do you want to apply for?

Winter 2027.

---

## Numbers to refresh on Nov 1

Re-check the question wording and any follow-up questions against the live form at apply.ycombinator.com (Adam, logged in). Then fill each placeholder, or cut its sentence.

| Placeholder | Source |
|---|---|
| `{{TBD: GitHub stars}}` | the public repo, on Nov 1 |
| `{{TBD: CI installs}}` | `docs/demand/funnel.md`, install column |
| `{{TBD: conversations}}` | `docs/demand/funnel.md`, summary |
| `{{TBD: LOIs at $200/month or more}}` | `docs/demand/funnel.md`, LOI column |
| `{{TBD: latest held-out values-right and whole-sequence scores from the nightly curve}}` | `site/data/curve.json`, latest point (held-out L3 and L4) |
| `{{TBD: sim-to-real pass/fail agreement from the W4 H4 run}}` | the W4 `paritybench agree` report in `reports/` |
| `{{TBD: automatic and assisted patch counts at W4 exit}}` | sealed align log (`align/log.jsonl`, private data repo) and the W4 reports |
| `{{TBD: public repo URL, after the launch gate}}` | `docs/plan/STATUS.md`, launch gate |
| `{{TBD: score page URL, after the launch gate}}` | `docs/plan/STATUS.md`, launch gate |
| `{{TBD: cofounder answer (Adam)}}` | Adam |
| `{{TBD: where Adam lives now and where the company would be based (Adam)}}` | Adam (the thesis flags an F-1 to OPT visa question: `parity-research.md`, Caveats) |
| `{{TBD: location reasoning (Adam)}}` | Adam |
| `{{TBD: full-time or part-time, and what else Adam is doing (Adam)}}` | Adam |
| `{{TBD: previous YC applications (Adam)}}` | Adam |
| `{{TBD: incubator or accelerator programs (Adam)}}` | Adam |
| `{{TBD: one or two lines of Adam's background (Adam)}}` | Adam (also used in `founder-video-script.md`) |
| `{{TBD: confirm that Ang Chen (Vera/CloudEmu) and Gabriel Poesia agree to be named (Adam)}}` | Adam, with each advisor |
| `{{TBD: other ideas (Adam)}}` | Adam |
| `{{TBD: legal entity (Adam)}}` | Adam |
| `{{TBD: investment (Adam)}}` | Adam |
| `{{TBD: fundraising (Adam)}}` | Adam |
| `{{TBD: who encouraged Adam and which YC events (Adam)}}` | Adam |
| `{{TBD: how Adam heard about YC (Adam)}}` | Adam |

If the oracle has grown past 88 sequences by Nov 1, also re-run the baselines and update the H1 numbers in question 10 (`docs/plan/impl/baselines.md`). Once W4 lands, also rewrite three statements that will then be wrong, not just old: in question 7, the list of what the twin serves today and "`paritybench agree` (being built in W4)"; in question 12, "(planned)" for the `verifiers` wrapper.
