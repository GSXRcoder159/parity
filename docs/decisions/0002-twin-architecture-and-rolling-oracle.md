# 0002 — Twin architecture, rolling oracle, and what counts as "automatic"

**Date:** 2026-09-25 · **Plan refs:** §1 H0/H2, §3.2, §3.3, §5 W2–W3 · **Status:** accepted

## 1. Rolling oracle (resolves the read budget vs "nightly")

Decision 0001 C2 caps sandbox GETs at 10,000 per rolling 30 days until Stripe answers B4. A full corpus (≥500 sequences × ~3 GETs) re-recorded every night would use ~45,000/month.

- The **oracle store** keeps the latest sandbox recording per sequence (`recordings/oracle/`, private, never in git per 0001 C3).
- **Nightly:** re-record a rotating **slice** of the corpus on the sandbox (sequence index mod 7 = day-of-week → the whole corpus refreshes weekly), then score the twin (free, local) on the **whole** corpus against the latest oracle recording of each sequence.
- **Noise floor:** a fixed 50-sequence subset recorded twice back-to-back, weekly.
- **Drift:** today's slice vs the previous recording of the same sequences, on paths not in the noise set.
- Budget: ~75 sequences/night × ~3 GETs + sweep ≈ 250 GETs/night ≈ 7,500/30 days.
- **Honest wording:** "the twin is scored nightly against an oracle that is at most 7 days old; drift on any sequence is detected within 7 days." If B4 says sandboxes are exempt, the slice becomes the whole corpus.

## 2. Twin = code + data

- **Code** (`src/twin/*.ts`): HTTP layer, event-sourced store, and one behavior module per resource exporting pure handlers `(ctx, req) → { status, body, events }`. Semantics live here: state machines, proration math, which events fire.
- **Data** (`src/twin/shapes/*.json`, `src/twin/errors.json`): one object template per Stripe object type (every field with its default value) and an error catalog (key → status, type, code, param, message template). Handlers build objects as `template ⊕ computed fields` and raise errors by catalog key.

## 3. What counts as automatic (H2's automation ratio)

- **Automatic (mechanical):** align-loop patches that edit only data files: seed or remove a field, or fix a constant, enum, status, code, param or message in a template or catalog entry. The oracle must show the value deterministically: the same normalized value across every sequence where the path appears, and the path is not in the noise set. These are applied without review when the held-out gate passes.
- **Assisted (semantic):** any change to `src/twin/*.ts` proposed by the LLM from a minimized counterexample and merged after review.
- **Scaffold:** everything built before the scaffold freeze (tag `twin-scaffold-v0`). It counts as neither; it is the baseline.
- **Surface added:** later expansions of scope (test clocks, proration, subscription updates in W4) are also scaffold work. They are annotated on the curve so a coverage jump is never read as alignment.

## 4. Scaffold honesty rules (W2)

1. Object templates are **generated from the OpenAPI spec** (MIT, pinned SHA) by a script with generic defaults: nullable → `null`, boolean → `false`, integer → `0`, array → `[]`, and nested objects recursed. Observed field values are **not** hand-copied into templates; seeding them is the align loop's mechanical job, and it is measured.
2. Implementers may use oracle recordings to get **statuses, error types/codes/params, event sets, and state transitions** right; those are semantics.
3. **Error catalog:** `status`, `type`, `code` and `param` of each entry are semantics and belong to the scaffold. `message` starts as a generic placeholder (`"parity: <key>"`). Real messages are the align loop's mechanical job, like template values.
4. **Clock:** the twin's clock can be injected per request with the header `Parity-Now: <unix seconds>`. `bench` against a rolling oracle sets it to the oracle recording's start time. Without it, a subscription created on a different day falls in a different month, and `current_period_end` diverges without any bug. Test clocks (W4) reuse the same mechanism.
5. After the freeze, every twin change goes through the align loop's sealed log (automatic or assisted) or is annotated "surface added". A change that fits neither category needs a ledger ruling.

## 5. Where data lives

- **Public repo** (after counsel, 0001 C7): code, templates, error catalog, scores, normalized divergence classes and counts, hashes of recordings.
- **Private repo** `GSXRcoder159/parity-data`: oracle store, twin recordings, and the sealed align log (append-only JSONL, hash-chained). The nightly GitHub Action checks it out with a fine-grained token (HUMAN: B2).
- **Data files are a gray zone.** Templates seeded from observations contain field *defaults* such as `"tax_exempt": "none"`, not recordings. Decision 0001 R1 treats observation-derived behavior as permitted input. Counsel's review (B5) covers publishing them.

## Revisit if
- B4 answer (sandboxes exempt → full nightly re-record).
- The mechanical class stops being majority (<30% at W4 → report honestly per plan §10).
- Templates prove too coarse (e.g. one field's default differs by context) → per-context overrides in data, still mechanical.
