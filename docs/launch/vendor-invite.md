> **DO NOT POST before B5 clears.** Counsel review (decision 0001 C7) comes before any public release; see the launch gate in `docs/plan/STATUS.md`. This includes sending this invite.

# Vendor invite

An invite to maintainers of Stripe-compatible servers to run ParityBench on their own twin. It is a template: fill in the `{{…}}` fields for each recipient.

Rules for each send (decision 0001 C5, C8):
- The vendor runs the harness on their own Stripe account and key, never ours (C8).
- Nothing about their server is published without their written agreement. For a vendor whose terms restrict benchmarking, we do not score or name it until that consent exists (C5), and this invite is how we ask.
- A published score states the vendor version, the surface it claims and was scored on, the normalization version, and rerun steps.
- Keep the tone neutral. No comparison with the Parity twin and no claims about their product.

---

**Subject:** Would you run ParityBench on {{name of their server}}?

> Hi {{first name}},
>
> I'm Adam Kuca (University of Michigan). I maintain ParityBench, an open-source (Apache-2.0) harness that measures how closely a Stripe-compatible server matches the real Stripe sandbox. Since {{name of their server}} serves {{the part of the Stripe API it claims}}, I'd like to invite you to run it.
>
> It replays API sequences (30 templates in 10 strata, 6 of them held out: 600 sequences at seeds 1-20, all recorded on a Stripe sandbox) against your base URL and against recordings of the same sequences on a Stripe sandbox. It reports agreement at four levels (status, shape, normalized value, whole sequence) with 95% intervals, next to the sandbox's own noise floor and the resulting ceiling. The method, corpus and normalization rules are public: {{TBD: public repo URL}}.
>
> How it would work:
> - You run it with your own sandbox key. The commands are in the README under "Reproduce with your own sandbox key".
> - It scores only the surface you say you support, so tell me which endpoints to include.
> - The results are yours. I publish nothing about {{name of their server}} without your written agreement. If you want it listed, I'll show it with your version, the surface scored, and rerun steps, and send you the wording first.
> - If a divergence looks like a harness or normalization issue rather than a server one, please open an issue. Rules are versioned, and every score carries its version.
>
> Happy to help with setup.
>
> Adam Kuca, University of Michigan
>
> Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc.
