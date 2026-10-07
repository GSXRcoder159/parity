# 0003 — Oracle account state: no webhook endpoints

**Date:** 2026-10-07 · **Plan refs:** §3.3; decision 0002 §1 (rolling oracle); decision 0001 C2 (read budget) · **Status:** accepted

## 1. Rule

- The sandbox account that the oracle is recorded on has **no webhook endpoints**. Template #24 (webhook-endpoint-crud) is the one exception: within its own sequence, it creates an endpoint subscribed only to event types that no template produces, and then deletes it.
- **The nightly checks this before every slice** (`noWebhookEndpoint` in `src/nightly.ts`). It sends one `GET /v1/webhook_endpoints?limit=1`. That GET goes through the read budget's gate together with the slice's projection, and it is written to `budget/reads.jsonl` before it is sent, the same as a recording's GETs. If the list has an endpoint, nothing is recorded that night: no slice, no noise pair, and the rotation cursor does not move. A sealed-log note names the endpoint (id, url, status, enabled_events). The night then scores the existing oracle and publishes with `oracleRefreshed: false`, which is the degraded path. A non-2xx answer fails the night, because the account state is then unknown.
- An endpoint that someone adds by hand (a Dashboard test, `stripe listen`) stops recording until it is deleted. So does an endpoint that #24 left behind when a run aborted. The note gives the id and url so the endpoint can be deleted.

## 2. Why

Stripe ties an invoice's timing to webhook delivery. Stripe's documentation is quoted in the triage section of `drift/2026-10-05.md`.

| | With an endpoint listening to invoice events | No endpoint |
|---|---|---|
| `pending_webhooks` on every event | ≥ 1 | 0 |
| An invoice's `webhooks_delivered_at` | null until delivery is acknowledged | its own `created`, set at creation |
| A renewal draft is finalized | 1 h after every listener acknowledges `invoice.created`, else after 72 h | 1 h after creation |

If the endpoint is never acknowledged (as with example.com), the oracle records a 72-hour wait. That wait comes from our own leftover probe, not from the API. A fresh account has no endpoint. The twin also starts with none: it counts `pending_webhooks` from its own enabled endpoints (§5).

## 3. The incident

- **Created** on 2026-09-25 by the orchestrator's first key-coverage probe (W0: "webhook endpoints … all work"), with url `https://example.com/wh` and `enabled_events` `*`. It was never deleted.
- **Effect.** Every recorded event, from W0 through the 2026-10-04 noise pair, carried `pending_webhooks` 1. `templates-validation.md` ("Observed `pending_webhooks`") saw this and could not name the cause. Every invoice's `webhooks_delivered_at` was null, and Stripe held renewal invoices about 72 h waiting for delivery (`templates-validation.md`, #27–#30 fact 5: `automatically_finalizes_at` = `created` + 3 days).
- **Disabled by Stripe** after repeated delivery failures, between 2026-10-04 13:44 and 2026-10-05 16:09 UTC. Since then, events carry `pending_webhooks` 0, `webhooks_delivered_at` is set at creation, and renewals finalize about 1 h after creation. On each of 2026-10-05 and 2026-10-06, all 28 train drift rows were of these two kinds (the triage sections of `drift/2026-10-05.md` and `drift/2026-10-06.md`).
- **Deleted** by the orchestrator on 2026-10-07 (read ledger: `orchestrator-webhook-check`, `orchestrator-webhook-cleanup`). The account now has 0 endpoints.
- **Superseded:** the statement in `templates-validation.md` that "a twin should emit 1 here, not 0", and its 3-day finalization (#27–#30 fact 5). Both describe the account while it had that endpoint, which is not the state this decision sets.

## 4. Oracle v1 is mixed until the rotation refreshes it

- The oracle keeps the newest clean recording of each sequence. Sequences last recorded up to 2026-10-04 hold the old state (the endpoint, null, 72 h). Sequences recorded since 2026-10-05 hold the new state (creation time, 1 h). This applies to train and held-out sequences alike, since both are in the same rotation.
- After the 2026-10-06 night, the rotation cursor is at 264 of 620: 2 of the 7 slices (178 sequences) have been recorded again since the change. If every night records a full seventh, the 2026-10-11 night records the rest, and its point is the first one scored on an oracle in one state. That moves to about 2026-10-12 if a night records less or is missed (this check refusing a night is one way that happens).
- **Noise ceiling:** the latest pair (2026-10-04) has both sides in the old state, so it still compares like with like. The next pair (Sunday 2026-10-11) will be the first one in the new state.

## 5. How scores are affected (the twin against a mixed oracle)

- **The twin has no endpoint by default.** It emits `pending_webhooks` 0, because `src/twin/store.ts` counts the twin's own enabled endpoints for each event type; `src/twin/shapes/event.json`'s 0 is the spec-generated placeholder, which is overwritten. It finalizes renewal drafts 1 h after creation (`DRAFT_S` in `src/twin/resources/test_clocks.ts`). It keeps `webhooks_delivered_at` null (`src/twin/shapes/invoice.json`). `pending_webhooks` itself is not scored: compare looks at event types only.
- **On old-state sequences**, the twin agrees on `webhooks_delivered_at` (null) but not on finalization timing in the clock renewal templates. **On new-state sequences** it is the other way round: it agrees on timing, and it diverges on `webhooks_delivered_at` in every sequence that returns an invoice (null against `created`).
- **So the scores move this week with no twin change.** The twin, the normalization (v1.7) and the method (m2) are the same for the points of 2026-10-04, 10-05 and 10-06, and train L3 went from 60.2% to 60.5% to 60.8% (2,273, then 2,283, then 2,295 of 3,773 steps). That gain belongs to the oracle: it is the net of the timing agreement gained and the `webhooks_delivered_at` agreement lost. Points from 2026-10-05 through the refresh each compare the twin against a different mix of the two states.
- **After the refresh**, the twin's null `webhooks_delivered_at` is a real divergence on every invoice. Fixing it belongs in twin code: set the field to `created` when no enabled endpoint subscribes to `invoice.created`. That is an assisted change through the align loop, not a hand edit.
- **Align while the oracle is mixed.** The mechanical pass needs the same normalized value in every sequence where a path appears, so it cannot seed either state on these paths. An assisted PR that touches `webhooks_delivered_at` or the finalization delay was gated against a mixed oracle. It should wait for the refresh (B7 review).

## 6. Curve annotation

The first curve point published on or after 2026-10-07 carries the annotation "account change: webhook endpoint removed 2026-10-05; oracle mixed until refreshed", once (`ACCOUNT_CHANGE` in `src/nightly.ts`). "Once" is checked against the curve itself: if no earlier point carries the annotation, this point gets it, and a same-date rerun keeps the events of the point it replaces. So if a night on or after the date published before this code landed, the annotation goes on the next point rather than being lost. The points for 2026-10-05 and 2026-10-06 were published before this decision and do not carry it.

## Revisit if

- The behaviour with an endpoint (finalization gated on delivery) needs to be scored. That would be its own stratum, recorded on a separate sandbox with an endpoint that acknowledges deliveries. This account would not change.
- Drift after the 2026-10-11 night still shows these two kinds, or `pending_webhooks` 1 comes back. Then the account changed again, and the check should have named the endpoint; if it found none, look for another cause.
