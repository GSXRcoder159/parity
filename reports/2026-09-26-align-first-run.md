# First align run (oracle v0, 88 seq)

Date: 2026-09-26 (UTC) · Twin: `twin-scaffold-v0` · Harness: `paritybench align` at the commit that last changed this report (review-2 fix round 1: a fraud/risk denylist and a call-site `{var}` guard, and `--apply` commits before it appends to the sealed log; on top of fix round 3's sub-code guard, fix round 2's free-text and one-binding guards and fix round 1's account/date and request-echo guards) · Oracle: **oracle v0 (88 seq)**, sha256 `d7a7839ebbd788d3c67585d592eab39d25af959a621c3a8ab07ec5fc37595b51` · Normalization v1.2

The report lists data-file paths, JSON pointers, operations, loci, classes, counts and scores. It contains no response values or seeded values (decision 0001 C3).

## Result: 174 automatic patches pass the gate, and none has landed yet

- **What ran.** `paritybench align` ran on oracle v0 in plan mode. Wall time was 7.5 s, including 13 `score-twin` runs in temp copies of the repo: 1 baseline and 12 gate runs.
- **The gate result.** Triage produced 175 mechanical candidates. The held-out gate accepted 174, blocked 0 as blocked-by-code, and rejected 1 (see "The 175 candidates").
- **Why `align --apply` was not run on the repo.** Applying any template patch fails an existing scaffold test. The test is `test/twin-shapes.test.ts`, "generator is deterministic and the committed templates are current". It asserts that `src/twin/shapes/*.json` equals `scripts/gen-shapes.ts` output byte for byte. That was the W2 invariant, from decision 0002 §4.1. After the freeze, the align loop edits these files by design (0002 §3), so the invariant has to become "the generator reproduces the templates at `twin-scaffold-v0`". That test, and the data files `--apply` writes, are outside this task's paths, and the sealed log is append-only. So the apply waits for a ruling. After the ruling it takes one command: `node src/cli.ts align --apply`. It runs only after this round's guards, because every entry it appends is permanent.
- **Dry run of the apply.**
  - The 174 accepted edits were applied in a temp copy of the repo (the gate's own `score-twin` path).
  - `score-twin` there reproduces the gate's "after" exactly: 1,423 train divergences, train L3 at 93 of 495 steps, held-out L3 at 10 of 113, train L4 at 4 of 72.
  - An earlier full rehearsal of the apply (176 edits, before this round's guards) ran the whole suite in a scratch clone: it failed exactly one test, the shapes-generator test above. It was not repeated for the 174-edit set.
  - After the ruling, `--apply` should first commit `align: 174 automatic patches (train Δ -7458 divergences, L3 +14.9 pts; held-out Δ L3 +8.8 pts)`, then append 175 sealed-log entries (174 `patch` + 1 `gate`, each naming that commit), 176 in total with the day-0 `score` entry. The `gate` entry records the rejected candidate with its scores.

## Curve, before → after the gated patches (projected; not landed)

| Split | When | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| train | day 0 | 94.3% [91.9–96.1] (495) | 20.0% [16.7–23.7] (495) | 3.8% [2.5–5.9] (495) | 0.0% [0.0–5.1] (72) |
| train | after | 94.3% [91.9–96.1] (495) | 34.9% [30.9–39.3] (495) | 18.8% [15.6–22.5] (495) | 5.6% [2.2–13.4] (72) |
| held-out | day 0 | 91.2% [84.5–95.1] (113) | 21.2% [14.7–29.7] (113) | 0.0% [0.0–3.3] (113) | 0.0% [0.0–19.4] (16) |
| held-out | after | 91.2% [84.5–95.1] (113) | 30.1% [22.4–39.1] (113) | 8.8% [4.9–15.5] (113) | 0.0% [0.0–19.4] (16) |

Train divergences fall from 8,881 to 1,423. Held-out divergences, which the gate reports but does not use, fall from 1,927 to 288. L1 does not move, because data files cannot change a status. L3 per stratum:

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
| refunds | 0.0% → 11.6% (69) | 0.0% → 11.8% (34) |

The fix-round guards moved 10 loci out of the automatic set (caveat 1 and the fraud/risk rule below), and one candidate that used to pass is now rejected by the gate.
- Fix round 1's 5 loci left every L1–L4 figure unchanged. They sit in steps that diverge elsewhere too, so they only show in the divergence count: 1,181 → 1,337 train and 258 → 278 held-out after the gate.
- Fix round 2's 2 loci cost 4 train refund steps at L3: 97 → 93 of 495 (19.6% → 18.8%), and refunds 17.4% → 11.6%. In those 4 steps, the held-back message is the only divergence the other patches leave. The held-back charge field sits in steps that diverge elsewhere. Train divergences after the gate go 1,337 → 1,349. Held-out is unchanged.
- Fix round 3's 1 locus (the card-declined message, 5 train divergences) left every L1–L4 figure unchanged: its 5 steps still diverge on two error fields outside the catalog. Train divergences after the gate go 1,349 → 1,354. Held-out is unchanged.
- Also in fix round 3, the max-depth error's `code` is rejected by the gate. On its own it is net zero: it removes 4 missing-`code` divergences and adds 4 extra-`doc_url` divergences, because the twin's error renderer writes a `doc_url` for every entry with a code and the oracle's max-depth error has none. In round 2 it was accepted only because it shared the `errors.json` batch with the card-declined message, which carried the batch's net fall (caveat 6). The fix is in handler code, so it is left for the assisted pass.
- Review-2 fix round 1's 2 loci (fraud/risk: `payment_method` `card.checks`, `charge` `fraud_details`) left every L1–L4 figure unchanged: their steps diverge elsewhere too. Train divergences after the gate go 1,354 → 1,423 (61 + 8), and held-out 278 → 288. The call-site `{var}` guard fires on no locus today.

## The 175 candidates

Every candidate is a JSON-pointer edit of a data file, derived from train sequences only. The rule, from 0002 §3: the oracle's normalized value is identical at every train occurrence of the object type, and no occurrence is in the noise set. On top of that, a candidate must hold beyond this one oracle:
- A value holding a normalization placeholder (`<id:…>`, `<t:…>`, `<run>`, `<opaque>`, `<secret>`, `<url:…>`, `<number:…>`) is never seeded.
- A field set by the sandbox account or by the recording date is never seeded: `account_country`, `account_name`, `calculated_statement_descriptor`, `exp_month`, `exp_year`, at any depth, and also inside a seeded parent object.
- An error message that quotes a value the request sent is never seeded: any request-parameter value of 3 or more characters, compared case-insensitively. An example is the expand path in the max-depth message.
- Free text is never seeded into a template. Every string in a seeded value must be an enum-like token (lowercase letters, digits, `_`, `.`, `-`). Prose, labels and uppercase codes are set by the request, the account or the context. An example is a charge's description, which likely follows its invoice's billing reason (not verified live).
- A fraud or risk field is never seeded into a template, in any form (decision 0001 §(c), R8): `fraud_details`, `outcome`, `risk_level`, `risk_score`, `checks` (card verification results) and `radar_options`, at any depth, and also inside a seeded parent object. The templates are public, and "information Stripe uses for security or fraud prevention" is never published. A delete of such a field publishes nothing and stays mechanical.
- A catalog field whose value is a `{var}` template (such as a generic entry's `param`) is never set or deleted. The var renders per call site, so a wrong rendered value is a call-site bug, and a literal would break the entry's other call sites.
- An error message on a generic catalog entry is seeded only when the corpus shows it with at least two different bindings. An entry is generic when its `param` is a `{var}`, so it serves every parameter and call site that raises the key, or when the twin renders it with a call site's sub-code: a string extra in the error body that is not an id, such as a decline code. Examples: the integer-parameter message, which the corpus raises for one parameter only while the twin raises that key from two call sites with different meanings; and the card-declined message, which the corpus shows for one decline code only while the twin's test cards carry five.

The gate judged them in 12 per-file batches. The 11 shape batches passed whole. The `errors.json` batch holds one edit, the max-depth error's `code`, and the gate rejected it: train divergences did not strictly fall (see the curve section).

| File | set | delete |
|---|---|---|
| `src/twin/shapes/payment_method.json` | 6 | 58 |
| `src/twin/shapes/refund.json` | 3 | 42 |
| `src/twin/shapes/invoice.json` | 7 | 5 |
| `src/twin/shapes/payment_intent.json` | 4 | 8 |
| `src/twin/shapes/charge.json` | 5 | 4 |
| `src/twin/shapes/customer.json` | 3 | 8 |
| `src/twin/shapes/subscription.json` | 6 | 2 |
| `src/twin/shapes/line_item.json` | 3 | 1 |
| `src/twin/shapes/price.json` | 1 | 2 |
| `src/twin/shapes/subscription_item.json` | 2 | 1 |
| `src/twin/shapes/product.json` | 3 | 0 |
| `src/twin/errors.json` | 0 (1 code, rejected by the gate) | 0 |
| **accepted** | **43** | **131** |

Most deletes remove spec fields that the API omits for these objects, such as the per-payment-method-type sub-objects of a card PaymentMethod or refund. Most sets replace a generic spec default (`null`, `0`, `""`) with the constant the API returns.

## Not mechanical: 72 train loci, left for the assisted pass

| Reason | Loci |
|---|---|
| varies across sequences | 32 |
| status decided by handler code (route) | 8 |
| value holds a normalization placeholder (computed) | 6 |
| fraud or risk data (`payment_method` `card.checks`; `charge` `fraud_details`, `outcome`, `payment_method_details`) | 4 |
| event set emitted by handler code | 4 |
| account- or time-derived (`payment_method` `card.exp_month`, `card.exp_year`; `charge.calculated_statement_descriptor`; `invoice.account_country`) | 4 |
| no template for the type (`list`: `total_count`, `count`, `data`) | 3 |
| error message holds `<id:…>`/`<run>` tokens no twin var renders | 3 |
| error message quotes a request value (`expand_too_deep`, `expand_invalid`) | 2 |
| context text: a string that is not an enum-like token (`charge` `description`) | 1 |
| error message on a generic key seen with one binding (`parameter_invalid_integer`: one `{param}`; `card_declined`: one decline code) | 2 |
| error field not in the catalog (`advice_code`, `network_decline_code`) | 2 |
| absent from some occurrences | 1 |

`expand_invalid`'s message was already not mechanical, because it varies across sequences. It is now reported under the more specific reason.

## Honesty caveats (these belong on the curve)

1. **Guarded since the fix rounds: values that are constant only within this oracle or its coverage.** Before the guards, 8 of the 185 candidates were of this kind. They passed the determinism check only because oracle v0 is one day old, comes from one account, and exercises one path for each. They are now routed to the assisted pass and do not count toward the automation ratio.
   - Fix round 1 (5): a test card's expiry, which follows the recording month; two account settings; and the max-depth message, which embeds the one expand path the corpus uses.
   - Fix round 2 (2): a charge's description, which likely follows the invoice's billing reason (not verified live). Every train charge shows the same one, while the twin builds every charge, renewals and updates included, from the same template; and the integer-parameter error message, which the corpus shows for one parameter and one call site, while the twin raises that key from two call sites with different meanings.
   - Fix round 3 (1): the card-declined error message, which the corpus shows for one decline code at both call sites (a failed charge and a declined attach), while the twin's test cards carry five decline codes; the API's message is documented to follow the decline code (not verified live: the corpus records one code).
   - Review-2 fix round 1 (0 today, guarded ahead): a `status`, `type`, `code` or `param` set or deleted over a catalog `{var}`. A key raised at one call site where the twin renders a different var than the oracle would get the corpus literal, and every other call site of the entry would then render it wrong. No such locus diverges today, because these keys' params vary by resource in the corpus.
   - Remaining gap: the guards are fixed name lists (account/date fields; fraud/risk fields, where a fraud field under a name not on the list would still pass), a request-value match, an enum-token rule and a two-binding rule. They do not catch a number, boolean or enum token that is constant only because the corpus exercises one path. One accepted candidate is of this kind: `subscription` `/quantity`, which follows the request's item quantity, and every train subscription shows the same quantity. Nor do they catch a key with a literal `param` that the twin raises from several call sites, or a generic key whose two bindings share one call site. On a path the corpus does not cover, such a value can be wrong, and the gate cannot see it. It still counts toward the automation ratio.
2. **Held-out L3 is a per-step measure.** A patch that breaks a held-out field in a step that already diverges elsewhere does not lower held-out L3. Held-out is also only partly held out at day 0: see `2026-09-26-twin-day0.md`.
3. **The noise set is empty.** The 60 back-to-back sandbox pairs (W0 A/D, templates #1–#15) agree 100% under v1.2, and #16–#26 have no pair yet. No divergence was marked NONDETERMINISTIC. So the determinism check rested on the oracle's own consistency alone.
4. **Once seeded, a value stays.** If a seeded constant later varies in the rolling oracle, the divergence comes back and goes to the assisted pass. Nothing un-patches it automatically.
5. **Oracle v0 has 88 sequences.** When oracle v1 (520) lands, the curve is annotated "oracle expanded", and the align loop re-derives every candidate against it.
6. **A batch is judged as a whole.** The gate accepts a per-file batch when each edit removes at least one of its own divergences and the batch's train count strictly falls. An edit that is net zero on its own can therefore pass inside a batch that falls, as the max-depth `code` did in round 2. It is only split out when the batch as a whole fails. This is the brief's batch rule, and it is not changed here.

## Reproduce

```
node src/cli.ts align                    # plan: triage, candidates, gate; writes nothing
node src/cli.ts align --apply            # writes the accepted edits, logs them in <dataDir>/align/log.jsonl, commits
```
