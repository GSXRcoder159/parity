# Implementation plan: W5: pricing page, demand collateral, YC application draft

Spec (authority): `docs/plan/2026-09-25-parity-mvp-plan.md` §2.2, §5 W5, §6.3, §7, §9. Pricing source: `parity-research.md` §5 ("Parity Cloud", "Private alignment", "Drift Guard"). Binding: decision 0001 (C4 naming, no possessive "Stripe's"; C5 competitor framing; C7 nothing public before counsel) and decision 0002 §1 (oracle-age wording).

## Global Constraints

- **Every number is sourced.** Each number comes from a committed report in `reports/` or a doc in `docs/`, and you cite the file next to it. Anything not yet measured is `{{TBD: what, when}}`. Never invent traction: stars, installs, LOIs and conversations are `{{TBD}}` unless `docs/demand/funnel.md` records them.
- Nothing is published or sent. Every draft opens with "DRAFT — not for publication before the launch gate (docs/plan/STATUS.md)".
- **Plain prose.** No hype words. Name each known limitation once, where the reader needs it: oracle v0 has 88 sequences, held-out is only partly held out at day 0, the LLM-assisted path has not run live, and clocks are unvalidated until B1.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only your paths.

## Task 1: Pricing page (proposed)

**Paths:** `site/pricing.html`, `site/style.css` (additions only), `site/index.html` (one nav link), `test/site.test.ts` (one check that the page exists and carries the "proposed" banner)

- A static page in the same design system as `site/index.html` (tokens, light/dark, phone width), with a banner: "Proposed pricing. Nothing is for sale yet."
- Tiers:
  - **Open source, free forever:** twin, ParityBench, the score, and the alignment loop, with the plan §2.2 pledge.
  - **Private alignment + `paritybench agree` in your CI:** $99–$299/month. This is the LOI SKU (plan §6.3). Delivery starts after Nov 2.
  - **Later, listed as "not offered yet":** Drift Guard ($299/org/month) and Parity Cloud (1,000 hosted runs/month free, then $0.10/run). Plan §2.3 cuts both.
- An FAQ covering: what "private alignment" means (aligning to the customer's own call shapes, with the customer's own sandbox key: decision 0001 C8, the SKU of plan §6.3; account-config alignment is on the §2.3 cut list); why the open score is free; and how the rolling oracle works (0002 §1 wording).

## Task 2: Demand collateral

**Paths:** `docs/demand/partner-offer.md`, `docs/demand/loi-template.md`, `docs/demand/outreach.md` (append a follow-up section only)

- `partner-offer.md` is a one-page offer for design partners. It covers:
  - what they send: tests, or 5 eval scenarios;
  - what they get: a divergence report within a week, and from mid-October the `agree` number within 48 h;
  - what we never do: run their workloads on our Stripe account (0001 C8), or publish their data;
  - the current measured facts: H1 numbers from `reports/2026-09-26-baseline.md`, and the twin day-0 and first-align numbers from `reports/2026-09-26-twin-day0.md` and `reports/2026-09-26-align-first-run.md`.
- `loi-template.md` is a non-binding letter of intent for the SKU in plan §6.3, at $99–$299/month, delivery from W6. It has placeholders for company, signer, price and scope (APIs, call shapes). Include a line recommending that counsel review it before use.
- In `outreach.md`, append "Follow-up with numbers": a second-touch message template that cites the H1 result (0% sequence-level agreement for the existing mocks), for use after counsel clears public numbers. Mark it gated.

## Task 3: YC W27 application draft

**Paths:** `docs/yc/2026-w27-application.md`, `docs/yc/founder-video-script.md`

- First fetch the current YC application questions: the ycombinator.com apply page, or a reliable recent public copy. Cite the URL and the fetch date. Answer every question in order.
- Ground everything in the plan and the reports:
  - the one-sentence test (plan §0);
  - the wedge;
  - why now: twins are commoditizing; YC RFS "Self-Maintaining APIs" (verbatim excerpt in `docs/research/2026-09-25-evidence.md`);
  - competitors: Arga, WonderTwin/LocalStack, stripe-mock, localstripe;
  - the business model (Task 1 tiers);
  - progress: H1 confirmed; twin day-0 → first align; the automation ratio so far (174 automatic, 0 assisted live); nightly pipeline; `{{TBD}}` for stars, installs and LOIs;
  - the known limitations.
- Keep the 50-character "what does your company do" line to 50 characters or fewer.
- Include a short "Numbers to refresh on Nov 1" checklist listing every `{{TBD}}` and its source.
- `founder-video-script.md` is 60 s: who, the insight (a number beats another twin), and what was built in the first week. Plain speech.
