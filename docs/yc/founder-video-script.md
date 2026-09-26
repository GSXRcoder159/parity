> **DRAFT — not for publication before the launch gate (docs/plan/STATUS.md)**

# Founder video script (YC W27)

**Length:** 60 s. **Voice-over:** about 130 words plus the background line (keep that to 15 words or fewer), so about 145 words: 58–62 s at 140–150 words per minute. One take, webcam, plain speech. This is the one-minute founder video the application asks for, not the product demo (`docs/launch/demo-script.md`). The application draft is [`2026-w27-application.md`](2026-w27-application.md).

Before recording:
- [ ] The background placeholder in the first line is filled in (it is on the Nov 1 checklist in the application draft).
- [ ] If the numbers in the application draft were refreshed on Nov 1, the same numbers are used here.
- [ ] Nothing on screen but the founder: no terminal, no sandbox key, no recording file (decision 0001 C3), and no Stripe logo (decision 0001 C4).

---

| Time | Beat | Say |
|---|---|---|
| 0:00–0:09 | Who | "I'm Adam, solo founder of Parity. {{TBD: one or two lines of Adam's background (Adam)}}." |
| 0:09–0:26 | The insight | "Teams test AI agents that move money against Stripe API mocks, and nobody measures how wrong they are. Mocks are getting cheap. A number for how far to trust one, kept current against the real API, is worth more than another mock." |
| 0:26–0:57 | What I built in the first week | "I built that number first. ParityBench runs the same calls on the real Stripe sandbox and on any mock, and scores the match. Both open mocks matched zero whole sequences; the official one is stateless by design. Then I built an open-source Billing mock and a loop that patches it from each difference. After 174 automatic patches, it gets 8.8 percent of held-out steps fully right, up from zero; whole held-out sequences, still zero." |
| 0:57–1:00 | Close | "It's early, and it's measured. That's Parity." |

**Sources for what is said:** zero whole sequences for stripe-mock and localstripe, `reports/2026-09-26-baseline.md`; 174 automatic patches, held-out steps with every value right (L3) 0.0% → 8.8% and held-out whole sequences (L4) 0.0% → 0.0%, `reports/2026-09-26-align-first-run.md`. Both results come from the first two days of work, 2026-09-25 and 2026-09-26 (`docs/plan/STATUS.md`, log).
