> **DO NOT POST before B5 clears.** Counsel review (decision 0001 C7) comes before any public release; see the launch gate in `docs/plan/STATUS.md`. This covers uploading or embedding the video.

# Demo video script

**Length:** 85 s (the target is 60–90 s). **Order:** `npx paritybench twin`, then a CI run, the score page, and the curve. **Voice-over:** 187 words, 75–86 s at 150–130 words per minute.

Before recording:
- [ ] `npx paritybench twin` works from npm. Until then, shot 2 can run `node src/cli.ts twin` in a checkout, but the video cannot be published that way.
- [ ] A green `action-selftest` run exists on the public repo, and the score page serves nightly data, not `site/data/sample`.
- [ ] Every `{{TBD: …}}` is filled in.
- [ ] Only the twin and the score page are on screen. No terminal with the sandbox key or `.env`, no recording file, no `compare` output: those hold data from a Stripe account (0001 C3).
- [ ] No Stripe logo, and no "Stripe" in the title card or the video title (0001 C4).

---

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:08 | Title card: "Parity". Subtitle: "a Billing twin, scored against the real sandbox every night" | "Your tests and your agents talk to a mock of the Stripe API. How faithful is that mock? Parity measures it." |
| 0:08–0:25 | Terminal. Type `npx paritybench twin`. It prints `parity twin listening on http://127.0.0.1:12111 (API 2026-08-26.dahlia)`. In a second pane: `curl -u sk_test_parity: http://127.0.0.1:12111/v1/customers -d email=jenny@example.com` returns a `cus_` object. Then `curl -X POST http://127.0.0.1:12111/_parity/reset` | "One command starts a stateful Billing twin on localhost. It boots in about a fifth of a second and takes any test key. It keeps state across calls, like the real API, and one reset call clears everything between tests." |
| 0:25–0:42 | Editor: a workflow with the step `uses: {{TBD: owner/repo}}@main`. Cut to the Actions tab: a green run, a customer created and retrieved against `PARITY_TWIN_URL`, total time {{TBD: wall time of a green action-selftest run}} | "In CI, it's one step. The action starts the twin and exports its URL, and your suite runs against it. No sandbox key and no shared state." |
| 0:42–1:05 | Score page, {{TBD: score page URL}}. Point at the line "Any score without the noise floor and ceiling is invalid." Then the per-stratum table, train vs held-out, and the normalization version | "Every night, ParityBench scores the twin against recordings of the same API sequences on the real sandbox, never more than a week old, at four levels, from status codes to whole sequences. The sandbox is also measured against itself: that noise floor sets the ceiling, and a score without it is invalid. Held-out templates never feed the fixes." |
| 1:05–1:20 | The nightly curve, L3 and L4 per stratum, with its confidence bands and ceiling line. Hover a "surface added" marker. Then the automation ratio: {{TBD: ratio}} | "This is the curve: {{TBD: day-0 L4}} on day zero, {{TBD: latest L4}} tonight. Each fix is logged as automatic or human-reviewed, and new scope is marked, so coverage never passes for accuracy." |
| 1:20–1:25 | End card: {{TBD: public repo URL}} · Apache-2.0 · "Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc." | "Open source. Run it on your own mock." |

**Measured today:** the boot line and the "fifth of a second". Spawn to first `200` took 193 ms on a laptop on 2026-09-26, and the twin printed the listening line above. Everything in `{{TBD: …}}` depends on the first nightly run or the public repo.
