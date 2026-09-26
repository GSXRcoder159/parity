> **DO NOT POST before B5 clears.** Counsel review (decision 0001 C7) comes before any public release; see the launch gate in `docs/plan/STATUS.md`.

# X thread draft

**Planned:** Thursday 2026-10-15, after the Show HN is up. **Sources:** `reports/2026-09-25-w0-oracle.md`, `reports/2026-09-26-baseline.md`.

Before posting:
- [ ] Same checklist as `show-hn.md`: B5 cleared, `npx paritybench twin` works from npm, repo and score page public, the nightly run live, every `{{TBD: …}}` filled or its sentence cut.
- [ ] Each post is 280 characters or fewer once the placeholders are filled (X counts a link as 23).
- [ ] No @-mention of Stripe accounts and no Stripe logo in images (0001 C4; Stripe DevRel is a later channel, plan §7).

Competitor numbers stay out of the thread. Post 8 links to the footnote.

---

**1/**
How faithful are mocks of the Stripe API? As far as I can find, nobody publishes a number.

So I built ParityBench: an open harness that replays API sequences against any Stripe-compatible server and against the real Stripe sandbox, then scores the difference.

**2/**
Four levels, each a 95% Wilson interval: L1 status, L2 shape, L3 value after versioned normalization, L4 the whole sequence including its event types.

26 templates in 9 strata: lifecycle, cancellation, refunds, errors, idempotency, events, pagination, proration, boundaries.

**3/**
First, the sandbox against itself. Two clean runs of 60 sequences, 28 min apart: every status matched; raw bodies differed on 419 of 420 steps (ids, timestamps).

After normalization v1.1, 7.6% of steps still differed and 65% of sequences matched. That is the noise floor.

**4/**
All 32 of those steps traced to 6 causes, and normalization v1.2 addresses them. Its floor on a fresh pair: {{TBD: v1.2 L3 floor, out-of-sample}}.

The ceiling is 100% minus the floor. Any score without the noise floor and ceiling is invalid.

**5/**
Parity also ships a twin: an open-source, stateful twin of the Stripe Billing API. Plain Node, no dependencies.

It is scored nightly against an oracle that is at most 7 days old. Day 0: {{TBD: L4 train, held-out}}. Latest: {{TBD: L4 train, held-out}}.

**6/**
Every twin change after the scaffold freeze is logged. Automatic: a data-only fix for a value the oracle shows deterministically, landed if the held-out gate passes. Assisted: LLM-proposed code, human-reviewed.

Automation ratio: {{TBD: automatic ÷ (automatic + assisted)}}.

**7/**
Try it: npx paritybench twin serves on 127.0.0.1:12111 and boots in about 0.1 s. There is a GitHub Action for CI.

Apache-2.0. The alignment loop and the score stay open.

{{TBD: public repo URL}}
{{TBD: score page URL}}

**8/**
Footnote: existing mocks, measured the same way, with their versions and rerun steps: {{TBD: link to reports/2026-09-26-baseline.md}}

Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc.
