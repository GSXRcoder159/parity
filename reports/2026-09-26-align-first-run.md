# First align run (oracle v0, 88 seq)

Date: 2026-09-26 (UTC) · Twin: `twin-scaffold-v0` · Harness: `paritybench align` at the commit that last changed this report (fix round 1: the two "constant only in this oracle" guards) · Oracle: **oracle v0 (88 seq)**, sha256 `d7a7839ebbd788d3c67585d592eab39d25af959a621c3a8ab07ec5fc37595b51` · Normalization v1.2

The report lists data-file paths, JSON pointers, operations, loci, classes, counts and scores. It contains no response values or seeded values (decision 0001 C3).

## Result: 180 automatic patches pass the gate, and none has landed yet

- **What ran.** `paritybench align` ran on oracle v0 in plan mode. Wall time was 8.5 s, including 13 `score-twin` runs in temp copies of the repo: 1 baseline and 12 gate runs.
- **The gate result.** Triage produced 180 mechanical candidates. The held-out gate accepted all 180, blocked 0 as blocked-by-code, and rejected 0.
- **Why `align --apply` was not run on the repo.** Applying any template patch fails an existing scaffold test. The test is `test/twin-shapes.test.ts`, "generator is deterministic and the committed templates are current". It asserts that `src/twin/shapes/*.json` equals `scripts/gen-shapes.ts` output byte for byte. That was the W2 invariant, from decision 0002 §4.1. After the freeze, the align loop edits these files by design (0002 §3), so the invariant has to become "the generator reproduces the templates at `twin-scaffold-v0`". That test, and the data files `--apply` writes, are outside this task's paths, and the sealed log is append-only. So the apply waits for a ruling. After the ruling it takes one command: `node src/cli.ts align --apply`.
- **Dry run of the apply.**
  - The 180 accepted edits were written into a scratch copy of the repo.
  - `score-twin` there reproduces the gate's "after" exactly: 1,337 train divergences, held-out L3 at 10 of 113 steps, train L4 at 4 of 72.
  - The full suite there (162 tests, `site/` included) fails exactly one test: the shapes-generator test above.

## Curve, before → after the gated patches (projected; not landed)

| Split | When | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| train | day 0 | 94.3% [91.9–96.1] (495) | 20.0% [16.7–23.7] (495) | 3.8% [2.5–5.9] (495) | 0.0% [0.0–5.1] (72) |
| train | after | 94.3% [91.9–96.1] (495) | 34.9% [30.9–39.3] (495) | 19.6% [16.3–23.3] (495) | 5.6% [2.2–13.4] (72) |
| held-out | day 0 | 91.2% [84.5–95.1] (113) | 21.2% [14.7–29.7] (113) | 0.0% [0.0–3.3] (113) | 0.0% [0.0–19.4] (16) |
| held-out | after | 91.2% [84.5–95.1] (113) | 30.1% [22.4–39.1] (113) | 8.8% [4.9–15.5] (113) | 0.0% [0.0–19.4] (16) |

Train divergences fall from 8,881 to 1,337. Held-out divergences, which the gate reports but does not use, fall from 1,927 to 278. L1 does not move, because data files cannot change a status. L3 per stratum:

| Stratum | Train L3 | Held-out L3 |
|---|---|---|
| boundaries | 0.0% → 25.0% (16) | 0.0% → 0.0% (12) |
| cancellation | 4.8% → 19.0% (42) | 0.0% → 13.3% (30) |
| errors | 1.5% → 7.5% (67) | 0.0% → 0.0% (24) |
| events | 24.2% → 36.4% (33) | — |
| idempotency | 0.0% → 0.0% (28) | — |
| lifecycle | 4.7% → 26.0% (169) | — |
| pagination | 0.0% → 0.0% (25) | — |
| proration | 0.0% → 26.1% (46) | 0.0% → 15.4% (13) |
| refunds | 0.0% → 17.4% (69) | 0.0% → 11.8% (34) |

The 5 loci the fix-round guards moved out of the automatic set (below) leave every L1–L4 figure unchanged. They sit in steps that diverge elsewhere too, so they only show in the divergence count: 1,181 → 1,337 train and 258 → 278 held-out after the gate.

## The 180 candidates

Every candidate is a JSON-pointer edit of a data file, derived from train sequences only. The rule, from 0002 §3: the oracle's normalized value is identical at every train occurrence of the object type, and no occurrence is in the noise set. On top of that, a candidate must hold beyond this one oracle:
- A value holding a normalization placeholder (`<id:…>`, `<t:…>`, `<run>`, `<opaque>`, `<secret>`, `<url:…>`, `<number:…>`) is never seeded.
- A field set by the sandbox account or by the recording date is never seeded: `account_country`, `account_name`, `calculated_statement_descriptor`, `exp_month`, `exp_year`, at any depth, and also inside a seeded parent object.
- An error message that quotes a value the request sent is never seeded: any request-parameter value of 3 or more characters, compared case-insensitively. An example is the expand path in the max-depth message.

The gate judged them in 12 per-file batches, and every batch passed whole.

| File | set | delete |
|---|---|---|
| `src/twin/shapes/payment_method.json` | 7 | 58 |
| `src/twin/shapes/refund.json` | 3 | 42 |
| `src/twin/shapes/invoice.json` | 7 | 5 |
| `src/twin/shapes/payment_intent.json` | 4 | 8 |
| `src/twin/shapes/charge.json` | 7 | 4 |
| `src/twin/shapes/customer.json` | 3 | 8 |
| `src/twin/shapes/subscription.json` | 6 | 2 |
| `src/twin/shapes/line_item.json` | 3 | 1 |
| `src/twin/shapes/price.json` | 1 | 2 |
| `src/twin/shapes/subscription_item.json` | 2 | 1 |
| `src/twin/shapes/product.json` | 3 | 0 |
| `src/twin/errors.json` | 3 (2 messages, 1 code) | 0 |

Most deletes remove spec fields that the API omits for these objects, such as the per-payment-method-type sub-objects of a card PaymentMethod or refund. Most sets replace a generic spec default (`null`, `0`, `""`) with the constant the API returns.

## Not mechanical: 67 train loci, left for the assisted pass

| Reason | Loci |
|---|---|
| varies across sequences | 33 |
| status decided by handler code (route) | 8 |
| value holds a normalization placeholder (computed) | 7 |
| event set emitted by handler code | 4 |
| account- or time-derived (`payment_method` `card.exp_month`, `card.exp_year`; `charge.calculated_statement_descriptor`; `invoice.account_country`) | 4 |
| no template for the type (`list`: `total_count`, `count`, `data`) | 3 |
| error message holds `<id:…>`/`<run>` tokens no twin var renders | 3 |
| error message quotes a request value (`expand_too_deep`, `expand_invalid`) | 2 |
| error field not in the catalog (`advice_code`, `network_decline_code`) | 2 |
| absent from some occurrences | 1 |

`expand_invalid`'s message was already not mechanical, because it varies across sequences. It is now reported under the more specific reason.

## Honesty caveats (these belong on the curve)

1. **Guarded since fix round 1: values that are constant only within this oracle.** Before the guards, 5 of the 185 candidates were of this kind: a test card's expiry, which follows the recording month; two account settings; and the max-depth message, which embeds the one expand path the corpus uses. They passed the determinism check only because oracle v0 is one day old, comes from one account, and exercises one expand path. They are now routed to the assisted pass and do not count toward the automation ratio.
   - Remaining gap: the guards are a fixed name list and a request-value match. A new account- or date-derived field, or a message that names the parameter rather than quoting its value (for example "unknown parameter" with a single parameter name in the corpus), would still pass while it is constant. Today, both parameter messages vary across the train sequences and so are not mechanical.
2. **Held-out L3 is a per-step measure.** A patch that breaks a held-out field in a step that already diverges elsewhere does not lower held-out L3. Held-out is also only partly held out at day 0: see `2026-09-26-twin-day0.md`.
3. **The noise set is empty.** The 60 back-to-back sandbox pairs (W0 A/D, templates #1–#15) agree 100% under v1.2, and #16–#26 have no pair yet. No divergence was marked NONDETERMINISTIC. So the determinism check rested on the oracle's own consistency alone.
4. **Once seeded, a value stays.** If a seeded constant later varies in the rolling oracle, the divergence comes back and goes to the assisted pass. Nothing un-patches it automatically.
5. **Oracle v0 has 88 sequences.** When oracle v1 (520) lands, the curve is annotated "oracle expanded", and the align loop re-derives every candidate against it.

## Reproduce

```
node src/cli.ts align                    # plan: triage, candidates, gate; writes nothing
node src/cli.ts align --apply            # writes the accepted edits, logs them in <dataDir>/align/log.jsonl, commits
```
