import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRaw, normalizeRecording, RULES } from "../src/bench/normalize.ts";
import { runNonce } from "../src/bench/run.ts";
import type { Recording, StepRecord, StripeEvent } from "../src/types.ts";

const T0 = 1_790_000_000;
const step = (i: number, body: unknown, status = 200): StepRecord => ({
  i,
  method: "POST",
  path: "/v1/x",
  status,
  body,
  resHeaders: {},
  ms: 1,
});
const rec = (steps: StepRecord[], events: StripeEvent[] = []): Recording => ({
  seq: "tmpl#1",
  template: "tmpl",
  stratum: "lifecycle",
  seed: 1,
  heldOut: false,
  target: "sandbox",
  runId: "run1",
  startedAt: "2026-09-25T00:00:00Z",
  ms: 1,
  steps,
  events,
});
const body = (r: Recording, i: number): any => r.steps[i]!.body;

test("every rule has a name and a rationale naming the bug class it could hide", () => {
  assert.equal(RULES.length, 7);
  for (const r of RULES) assert.match(r.rationale, /Hides:/, r.name);
});

test("ids: prefixed ids normalize, lowercase enums stay", () => {
  const r = normalizeRecording(
    rec([
      step(0, {
        id: "cus_Ab12Cd34Ef",
        sched: "sub_sched_1AbcDEFghij",
        proration_behavior: "create_prorations",
        collection_method: "charge_automatically",
        payment_behavior: "default_incomplete",
        short: "cus_Ab1",
      }),
    ]),
  );
  assert.deepEqual(body(r, 0), {
    id: "<id:cus>",
    sched: "<id:sub_sched>",
    proration_behavior: "create_prorations",
    collection_method: "charge_automatically",
    payment_behavior: "default_incomplete",
    short: "cus_Ab1",
  });
});

test("timestamps: hour offsets from t0 = first created in step order", () => {
  const r = normalizeRecording(
    rec(
      [
        step(0, { error: { message: "no created here" } }, 400),
        step(1, { object: "subscription", items: { data: [{ created: T0 + 5 }] }, created: T0 }),
        step(2, {
          created: T0 + 1800,
          current_period_end: T0 + 30 * 24 * 3600,
          trial_start: T0 - 7200,
          canceled_at: T0 + 5400,
          period: { start: T0, end: T0 + 3600 },
          due_date: null,
          amount: T0, // not a timestamp key: compared as-is
          expires_at: 42, // out of epoch range
        }),
      ],
      [{ id: "evt_1AbcDEFghijk", type: "customer.created", created: T0 + 10, data: { object: {} } }],
    ),
  );
  assert.equal(body(r, 1).created, "<t:~0>"); // own key before children: anchor is T0, not T0+5
  assert.equal(body(r, 1).items.data[0].created, "<t:~0>");
  assert.deepEqual(body(r, 2), {
    created: "<t:~0>",
    current_period_end: "<t:+720h>",
    trial_start: "<t:-2h>",
    canceled_at: "<t:+2h>",
    period: { start: "<t:~0>", end: "<t:+1h>" },
    due_date: null,
    amount: T0,
    expires_at: 42,
  });
  assert.equal(r.events[0]!.created as unknown, "<t:~0>");
  assert.equal(r.events[0]!.id, "<id:evt>");
});

test("run nonce, secrets, hosted urls, per-account opaques", () => {
  const nonce = runNonce("run1", "tmpl#1");
  const r = normalizeRecording(
    rec([
      step(0, {
        error: { message: `Keys for idempotent requests ... other than '${nonce}-k1' if ...` },
        client_secret: "pi_3Abc_secret_XyZ",
        hosted_invoice_url: "https://invoice.stripe.com/i/acct_1Abc/test_YWNjdF8x",
        receipt_url: "https://pay.stripe.network/receipts/x",
        other_url: "https://notstripe.com/x",
        card: { fingerprint: "Xt5EWLLDS7FJjR1c" },
        invoice_prefix: "A1B2C3D4",
        lines: { object: "list", data: [] },
      }),
      step(1, { object: "invoice", number: "A1B2C3D4-0002" }),
      step(2, { object: "charge", number: "A1B2C3D4-0002" }),
    ]),
  );
  assert.deepEqual(body(r, 0), {
    error: { message: "Keys for idempotent requests ... other than '<run>-k1' if ..." },
    client_secret: "<secret>",
    hosted_invoice_url: "<url:invoice.stripe.com>",
    receipt_url: "<url:pay.stripe.network>",
    other_url: "https://notstripe.com/x",
    card: { fingerprint: "<opaque>" },
    invoice_prefix: "<opaque>",
    lines: { object: "list", data: [] },
  });
  assert.equal(body(r, 1).number, "<number:-0002>");
  assert.equal(body(r, 2).number, "A1B2C3D4-0002"); // only invoice numbers
});

test("lists: data sorted by raw created desc, ties by normalized JSON; livemode compared as-is", () => {
  const list = (order: number[]) => ({
    object: "list",
    livemode: false,
    data: order.map((n) => [
      { id: "cus_Aaaaaaaaaa1", created: T0, email: "b@x" },
      { id: "cus_Bbbbbbbbbb2", created: T0 + 7200, email: "c@x" },
      { id: "cus_Cccccccccc3", created: T0, email: "a@x" },
    ][n]),
  });
  const a = normalizeRecording(rec([step(0, list([0, 1, 2]))]));
  const b = normalizeRecording(rec([step(0, list([2, 0, 1]))]));
  assert.deepEqual(body(a, 0), body(b, 0));
  assert.deepEqual(
    body(a, 0).data.map((c: any) => c.email),
    ["c@x", "a@x", "b@x"],
  );
  assert.equal(body(a, 0).livemode, false);


  // Ties ignore key order (a twin need not emit Stripe's): fields cross-ordered so a key-order-sensitive tie-break flips.
  const x = { email: "a@x", name: "z", created: T0 };
  const y = { email: "b@x", name: "a", created: T0 };
  const flip = (o: typeof x) => ({ name: o.name, email: o.email, created: o.created });
  const p = normalizeRecording(rec([step(0, { object: "list", data: [x, y] })]));
  const q = normalizeRecording(rec([step(0, { object: "list", data: [flip(y), flip(x)] })]));
  assert.deepEqual(body(p, 0), body(q, 0));
});

test("normalizeRecording and normalizeRaw do not mutate the input", () => {
  const r = rec([step(0, { id: "cus_Ab12Cd34Ef", created: T0 })]);
  const before = structuredClone(r);
  normalizeRecording(r);
  const raw = normalizeRaw(r);
  assert.deepEqual(r, before);
  assert.deepEqual(raw, before);
  assert.notEqual(raw.steps[0], r.steps[0]);
});
