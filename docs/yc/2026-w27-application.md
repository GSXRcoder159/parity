> **DRAFT — not for publication before the launch gate (docs/plan/STATUS.md)**

# YC W27 application (draft)

**Batch:** Winter 2027. On-time deadline Nov 2 at 8pm PT; decisions by Dec 11 ([ycombinator.com/apply](https://www.ycombinator.com/apply), fetched 2026-09-26).

**Where the questions come from.** The live form is behind a login at apply.ycombinator.com, and ycombinator.com/apply does not list the questions. The questions below, in order, come from Round Funded, "YC Application 2026: Every Question" ([roundfunded.com/en/blogs/how-to-apply-to-y-combinator-2026](https://www.roundfunded.com/en/blogs/how-to-apply-to-y-combinator-2026)). It says it covers W27 and was last updated 2026-09-20; fetched 2026-09-26. That page says YC edits the form between batches. Cross-checked against a first-hand Spring 2026 submission ([homoky.cz/blog/yc-spring-2026-everything-i-submitted](https://homoky.cz/blog/yc-spring-2026-everything-i-submitted), fetched 2026-09-26), which has the same core questions. The live form may ask follow-up questions that this list does not show.

**Numbers.** Every number is as of the date it states (2026-09-29 at the latest), and the file it comes from is named next to it. A `{{TBD}}` placeholder marks what is not measured yet or what only Adam knows. The checklist at the end lists each one and where to get it.

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

A Billing API mock scored against the Stripe API

(48 characters. Decision 0001 (f): no "Stripe"+word lockup in a tagline; "the Stripe API" is nominative use.)

### 5. Company URL, if any

{{TBD: public repo URL, after the launch gate}}

### 6. Please provide a link to the product, if any.

{{TBD: score page URL, after the launch gate}}. The repo stays private until counsel has reviewed the Stripe terms (decision 0001 C7).

### 7. What is your company going to make? Please describe your product and what it does or will do.

Teams test code and AI agents that write to Stripe Billing against mocks of the Stripe API. Nobody measures how far those mocks are from the real API. Parity measures it, and ships a mock that is measured.

- **ParityBench** runs the same sequences of API calls against the real Stripe sandbox and against any Stripe-compatible server. It scores agreement at four levels: HTTP status, response shape, values after normalization, and whole sequences. Each score comes with a 95% interval and with the noise floor of the sandbox itself, measured by running the same sequences on the sandbox twice.
- **The Parity twin** is an open-source, stateful mock of the Stripe Billing API. Its scope is the calls support and billing agents make: look up a customer and subscription, preview a plan change, apply it, cancel, refund (plan §2.1). Today it serves customers, products, prices, payment methods, subscriptions (create, cancel, and plan and quantity changes with proration), invoices (finalize, pay, void, preview), refunds, events, webhooks and test clocks (`README.md`, supported surface; `docs/plan/STATUS.md`, W2 and W4). Some cases still answer `not_implemented`, such as a change of billing interval without an anchor reset. It boots in about 0.1 s, and a reset takes about 2 ms with 1,000 objects in it (`docs/plan/STATUS.md`, W2).
- **The align loop** turns each divergence between the twin and the sandbox into a patch. Each patch is logged as automatic (data files only, applied if a held-out gate passes) or assisted (an LLM proposes a code change and I review it), in a hash-chained log (decision 0002 §3).
- **Paid:** private alignment to a customer's own account settings and call shapes, plus `paritybench agree` (built; its sandbox half ran live on 2026-09-28, `reports/2026-09-27-agree-example.md`), which runs the customer's own test or eval suite on the twin and on their sandbox and reports how often pass/fail matches.

The claim we are testing (plan §0): "A public, reproducible fidelity number, kept true nightly against the real Stripe sandbox, is worth more to agent teams than another twin."

### 8. Where do you live now, and where would the company be based after YC?

{{TBD: where Adam lives now and where the company would be based (Adam)}}

### 9. Explain your decision regarding location.

{{TBD: location reasoning (Adam)}}

---

## Progress

### 10. How far along are you?

Work started on 2026-09-25 (`docs/plan/STATUS.md`, log).

- **The gap is real (hypothesis H1, confirmed on 600 sequences).** On the full corpus recorded from the real sandbox (600 sequences: 30 templates × 20 seeds, 2026-09-28), the best existing open mock matches 0% of whole sequences (`reports/2026-09-27-baseline-v1.md`):
  - stripe-mock: 0.0% [0.0–0.6] over 600 sequences, with 83.7% of HTTP statuses right. Its README says it is stateless, so this measures its documented design, not a defect.
  - localstripe: 0.0% [0.0–3.1] over the 120 sequences inside the routes it serves (6 of 30 templates).
  - Every upper bound is ≤3.1%, against H1's 80% threshold. On the earlier 88-sequence oracle the verdict was the same (`reports/2026-09-26-baseline.md`).
- **The real sandbox is measured against itself.** Two sandbox runs of the same 60 sequences, 28 minutes apart, differed on 7.6% [5.4–10.6] of steps after normalization v1.1 (`reports/2026-09-25-w0-oracle.md`). All 32 differing steps traced to 6 causes. Under v1.2 the same pair agrees on every step, but v1.2 was written from that pair, so this is in-sample (`reports/2026-09-26-baseline.md`). **Out of sample:** on a new pair of all 30 templates (60 sequences, 449 steps), recorded after normalization v1.3 was frozen, the floor is **0.7% [0.2–1.9]** of steps, under the plan's 3% bar; whole sequences differ on 5.0% [1.7–13.7] (`reports/2026-09-27-baseline-v1.md`). What still varies is a declined renewal's retry time, a card's ECI and the event order of one held-out sequence. v1.4 normalizes the first two, but it was written from that pair, so the next pair measures it out of sample. Throughput: 3,950 and 4,436 sequences per hour in two clean runs (`reports/2026-09-25-w0-oracle.md`).
- **The twin, day 0.** Scored on the 88-sequence oracle, the frozen scaffold returns the right status on 93.8% of steps and every value right (after normalization) on 3.1%, and matches 0 whole sequences (`reports/2026-09-26-twin-day0.md`). That oracle had no test-clock sequences.
- **The first align run.** The loop landed 174 automatic patches, all data-file edits that passed the held-out gate (`reports/2026-09-26-align-first-run.md`):
  - train: steps with every value right 3.8% → 18.8%, whole sequences 0% → 5.6%, divergences 8,881 → 1,423;
  - held-out: steps with every value right 0.0% → 8.8%, whole sequences 0% → 0%.
  - Held-out is only partly held out at day 0: the scaffold's own tests used 2 of the then 5 held-out templates (#7, #9), so held-out measures generalization after the freeze only. Later an implementer's context contained the validation notes of #7, #9 and #12, and then the intended steps and step and event counts of `clock-trial-end` (#28), with no results (the align loop never saw them; disclosed in `reports/2026-09-26-twin-day0.md`). Six templates are held out now: `clock-trial-end` was added with the test clocks.
- **The twin on the full oracle (2026-09-28).** On all 600 sequences, from the first full nightly run: status right on 98.9% of train steps, every value right on 24.6% (26.8% after that night's 6 automatic patches), and 4.2% [2.7–6.3] of whole train sequences right. On held-out templates, every value right on 18.1% of steps and 0 of 120 whole sequences (0.0% [0.0–3.1]). The noise ceiling is 99.3% of steps and 93.3% of sequences. The test clocks, built from the docs, get every status right, but no clock sequence is fully right yet (`reports/2026-09-27-twin-v1.md`). These are not comparable with the 88-sequence numbers above: the oracle grew.
- **Automation as of 2026-09-28: 180 automatic patches and 1 merged assisted pull request** (`docs/plan/STATUS.md`, W4 H2 line and B7). The units differ (one JSON-pointer edit to a data file vs one merged pull request), so each class also reports the train divergences it removed: 7,538 for the automatic patches (`reports/2026-09-27-twin-v1.md`). The assisted path (an LLM proposes a code change from a minimized counterexample) is live: on 2026-09-28 the first nightly on GitHub sent its first 3 loci for $0.23 and opened draft pull requests #1 and #2 (`docs/plan/STATUS.md`, B2). I merged #1 (the customer create now sets `invoice_prefix` and `next_invoice_sequence`); on the 600-sequence oracle its review gate moved train steps with every value right from 26.8% to 47.5% and held-out from 18.1% to 39.1%. #2 was closed as superseded. The target, at least 60% of patches automatic, is decided at the end of W4 (plan §1, H2). Counts at W4 exit: {{TBD: automatic and assisted patch counts at W4 exit}}.
- **Nightly pipeline, scheduled and live.** Its full path first ran for real on 2026-09-28, locally: it recorded that night's slice on the sandbox, scored the twin on the whole oracle, landed 6 automatic patches, checked drift (2 paths, neither an API change) and published a curve point (`reports/2026-09-27-twin-v1.md`). The same day it ran on GitHub (dispatched by hand): sandbox slice clean, no drift, both repos pushed. Its cron runs daily at 07:00 UTC (`docs/plan/STATUS.md`, B2). Each night re-records at most a seventh of the corpus, sized to the sandbox read budget, so the twin is scored against an oracle that is at most 7 days old, and drift on any sequence is detected within 7 days, as long as every night can afford a seventh (decision 0002 §1, decision 0001 C2); each curve point publishes the oracle's age.
- **Latest numbers:** {{TBD: latest held-out values-right and whole-sequence scores from the nightly curve}}.
- **Sim-to-real (hypothesis H4).** An LLM agent (`claude-sonnet-5`) does refund, cancellation and plan-change tasks once on the twin, once on a second twin run (the control: the agent's own run-to-run agreement) and once on the sandbox; H4 is how often the twin and the sandbox agree on pass or fail (plan §6.4).
  - As of 2026-09-28, on 20 tasks: 100.0% (20/20; 95% interval 83.9–100.0%), control 100.0% (`reports/2026-09-28-h4.md`). The lower bound was under 90%, so the suite grew to 80 tasks, the 60 new ones written before any result.
  - As of 2026-09-29, on 80 tasks: **93.8% (75/80; 86.2–97.3%)**, with the control at 95.0% (76/80; 87.8–98.0%), so inconclusive (`reports/2026-09-28-h4-80.md`). All 5 disagreements are in the 12 tasks that need ending a subscription at period end, a parameter the agent's tool did not offer. The control shows 3 of them are the agent's own variance and a 4th probably is; the 5th is unattributed, and a twin gap is not excluded.
- **`agree`.** Not the H4 number, but a check that `paritybench agree` works: on the 8-test example suite, the twin and the sandbox both pass 8/8, agreement 100.0% [67.6–100.0] (`reports/2026-09-27-agree-example.md`). The suite was written next to the twin, so this is not evidence of fidelity.
- **Users:** GitHub stars {{TBD: GitHub stars}}, CI installs {{TBD: CI installs}}, conversations {{TBD: conversations}}, LOIs {{TBD: LOIs at $200/month or more}}. Twenty outreach messages are drafted (`docs/demand/funnel.md`).

### 11. How long have each of you been working on this? How much of that has been full-time? Please explain.

One founder. Research for the thesis came first (`parity-research.md`); building started on 2026-09-25 (`docs/plan/STATUS.md`). The plan budgets about 35 hours a week through Nov 2 (plan header). {{TBD: full-time or part-time, and what else Adam is doing (Adam)}}

### 12. What tech stack are you using, or planning to use, to build this product? Include AI models and AI coding tools you use.

- TypeScript on Node 22, with no runtime dependencies (`package.json`). The twin is a plain Node HTTP server over an event-sourced in-memory store. Its object templates are generated from the public Stripe OpenAPI spec (MIT, pinned by commit).
- Python only for a thin wrapper that exposes the twin as a Prime Intellect `verifiers` environment (built: `python/parity_verifiers`, with pytest in CI; plan §3.5).
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
4. History cannot be backfilled. The oracle is rate-limited (at most 10,000 sandbox reads per 30 days: per Stripe Support, sandbox test charges earn no extra reads, so the 10,000 minimum is the binding limit, decision 0001 C2), so a divergence record built night after night is hard to reproduce later. It matters more on the next APIs (Slack, GitHub, HubSpot, Salesforce), where sandboxes are scarcer (`parity-research.md` §7, §9).

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

The H1 and noise-floor numbers in question 10 are on the 600-sequence oracle (2026-09-28, normalization v1.3). The harness is now at v1.4, which the next weekly noise pair measures out of sample: if that number exists by Nov 1, add it next to the v1.3 floor. If the corpus changes, re-run the baselines and update them (`docs/plan/impl/baselines.md`). The twin numbers in question 10 are from 2026-09-28; replace them with the latest curve point. The H4 numbers are from 2026-09-28 (20 tasks) and 2026-09-29 (80 tasks); if a later H4 run exists (`reports/`), use its numbers and date. Question 7's list of what the twin serves was rewritten on 2026-09-28: check it against the README's supported surface.
