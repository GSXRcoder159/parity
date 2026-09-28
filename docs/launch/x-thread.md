> **DO NOT POST before B5 clears.** Counsel review (decision 0001 C7) comes before any public release; see the launch gate in `docs/plan/STATUS.md`.

# X thread draft

**Planned:** Thursday 2026-10-15, after the Show HN is up. **Sources:** `reports/2026-09-25-w0-oracle.md` (posts 3–4), `reports/2026-09-27-baseline-v1.md` (posts 2, 4 and 8), `reports/2026-09-27-twin-v1.md` (posts 5–6).

Before posting:
- [ ] Same checklist as `show-hn.md`: B5 cleared, `npx paritybench twin` works from npm, repo and score page public, the nightly run live, the latest curve point's `oracleMaxAgeDays` 7 or less (else cut "at most 7 days old" in post 5), every `{{TBD: …}}` filled or its sentence cut.
- [ ] Each post is 280 characters or fewer once the placeholders are filled (X counts a link as 23).
- [ ] No @-mention of Stripe accounts and no Stripe logo in images (0001 C4; Stripe DevRel is a later channel, plan §7).

Competitor numbers stay out of the thread. Post 8 links to the footnote.

---

**1/**
How faithful are mocks of the Stripe API? As far as I can find, nobody publishes a number.

So I built ParityBench: an open harness that replays API sequences against any Stripe-compatible server and against the real Stripe sandbox, then scores the difference.

**2/**
Four levels, each a 95% Wilson interval: L1 status, L2 shape, L3 value after versioned normalization, L4 the whole sequence, event order too.

30 templates in 10 strata (6 held out), 600 sequences, all recorded on the real sandbox.

**3/**
First, the sandbox against itself. Two clean runs of 60 sequences, 28 min apart: every status matched; raw bodies differed on 419 of 420 steps (ids, timestamps).

After normalization v1.1, 7.6% of steps still differed and 65% of sequences matched. That is the noise floor.

**4/**
All 32 of those steps traced to 6 causes; normalization v1.2 addresses them. On a fresh pair of all 30 templates, recorded after v1.3 was frozen: 0.7% of steps [0.2–1.9].

The ceiling is 100% minus the floor. Any score without the noise floor and ceiling is invalid.

**5/**
Parity also ships a twin: an open-source, stateful twin of the Stripe Billing API. Plain Node, no dependencies.

Scored nightly against an oracle at most 7 days old. On 600 sequences (Sep 28): 4.2% of train sequences fully right, 0% held-out. Latest: {{TBD: L4 train, held-out}}.

**6/**
Every twin change after the scaffold freeze is logged. Automatic: a data-only fix for a value the oracle shows deterministically, landed if the held-out gate passes. Assisted: LLM-proposed code, human-reviewed.

So far: 180 automatic, 0 assisted. Ratio: {{TBD: automatic ÷ (automatic + assisted), once the assisted path has run}}.

**7/**
Try it: npx paritybench twin serves on 127.0.0.1:12111 and boots in about 0.1 s. There is a GitHub Action for CI.

Apache-2.0. The alignment loop and the score stay open.

{{TBD: public repo URL}}
{{TBD: score page URL}}

**8/**
Footnote: existing mocks, measured the same way, with their versions and rerun steps: {{TBD: link to reports/2026-09-27-baseline-v1.md}}

Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc.
