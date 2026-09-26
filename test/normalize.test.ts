import { test } from "node:test";
import assert from "node:assert/strict";
import { NORMALIZATION_VERSION, normalizeRaw, normalizeRecording, RULES } from "../src/bench/normalize.ts";
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
  assert.equal(NORMALIZATION_VERSION, "v1.2");
  assert.equal(RULES.length, 11);
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

test("ids embedded in longer strings normalize word-bounded; enums, short tails and `_`-joined tokens stay", () => {
  const nonce = runNonce("run1", "tmpl#1");
  const r = normalizeRecording(
    rec([
      step(0, {
        error: {
          message: "No such customer: 'cus_T8aBcDeFgHiJkL'",
          detail: "Invoice in_1AbcDEFghij12 for sub_sched_1AbcDEFghij, not cus_Ab1 (create_prorations)",
          note: "pi_3AbcDEF12345_secret_XyZ12345678", // `_` after the tail is a word char: no match
          key: `${nonce}-cus_T8aBcDeFgHiJkL`,
        },
      }),
    ]),
  );
  assert.deepEqual(body(r, 0).error, {
    message: "No such customer: '<id:cus>'",
    detail: "Invoice <id:in> for <id:sub_sched>, not cus_Ab1 (create_prorations)",
    note: "pi_3AbcDEF12345_secret_XyZ12345678",
    key: "<run>-<id:cus>",
  });
});

test("sandbox banner: the exact unclaimed-sandbox prefix is stripped, elsewhere it stays", () => {
  const banner = "This is an unclaimed Stripe sandbox. Dashboard links in this error message will not work until the sandbox is claimed. ";
  const r = normalizeRecording(
    rec([
      step(0, { error: { message: `${banner}No such customer: 'cus_T8aBcDeFgHiJkL'` } }, 404),
      step(1, { error: { message: `Oops. ${banner}` } }, 400),
    ]),
  );
  assert.equal(body(r, 0).error.message, "No such customer: '<id:cus>'");
  assert.equal(body(r, 1).error.message, `Oops. ${banner}`);
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

test("lists: data compared in the order returned (v1.2 has no list-order sort)", () => {
  const c = (id: string, email: string) => ({ id, created: T0, email });
  const list = (data: unknown[]) => ({ object: "list", livemode: false, has_more: false, data });
  const x = c("cus_Aaaaaaaaaa1", "a@x");
  const y = c("cus_Bbbbbbbbbb2", "b@x");
  const a = normalizeRecording(rec([step(0, list([x, y]))]));
  const b = normalizeRecording(rec([step(0, list([y, x]))]));
  assert.deepEqual(body(a, 0).data.map((e: any) => e.email), ["a@x", "b@x"]);
  assert.deepEqual(body(b, 0).data.map((e: any) => e.email), ["b@x", "a@x"]);
  assert.notDeepEqual(body(a, 0), body(b, 0));
  assert.equal(body(a, 0).livemode, false);
});

test("v1.2: request_log_url dropped under error only; updated is a timestamp; card-network values opaque unless null", () => {
  const r = normalizeRecording(
    rec([
      step(0, { object: "product", created: T0, updated: T0 + 7200, request_log_url: "https://x.example/keep" }),
      step(1, { error: { type: "invalid_request_error", request_log_url: "https://dashboard.stripe.com/acct_1/test/logs?object=req_1" } }, 400),
      step(2, {
        object: "charge",
        outcome: { risk_level: "normal", risk_score: 42 },
        payment_method_details: { card: { authorization_code: "123456", network_transaction_id: "5550001112223", transaction_link_id: null, brand: "visa" } },
      }),
    ]),
  );
  assert.deepEqual(body(r, 0), { object: "product", created: "<t:~0>", updated: "<t:+2h>", request_log_url: "https://x.example/keep" });
  assert.deepEqual(body(r, 1), { error: { type: "invalid_request_error" } });
  assert.deepEqual(body(r, 2), {
    object: "charge",
    outcome: { risk_level: "normal", risk_score: "<opaque>" },
    payment_method_details: { card: { authorization_code: "<opaque>", network_transaction_id: "<opaque>", transaction_link_id: null, brand: "visa" } },
  });
});

test("v1.2: refund destination_details.card reference keys dropped (steps, lists, events); other objects keep them", () => {
  const refund = (card: Record<string, unknown>) => ({ id: "re_Abcdefghij12", object: "refund", created: T0, destination_details: { type: "card", card } });
  const pending = refund({ reference_status: "pending", reference_type: "acquirer_reference_number", type: "refund" });
  const available = refund({ reference: "2263411961024116", reference_status: "available", reference_type: "acquirer_reference_number", type: "refund" });
  const other = { object: "payout", destination_details: { card: { reference: "r1" } } };
  const ev = { id: "evt_1AbcDEFghijk", type: "charge.refund.updated", created: T0, data: { object: available } };
  const a = normalizeRecording(rec([step(0, pending), step(1, { object: "list", data: [pending] }), step(2, other)], [ev]));
  const b = normalizeRecording(rec([step(0, available), step(1, { object: "list", data: [available] }), step(2, other)], [ev]));
  assert.deepEqual(body(a, 0), body(b, 0));
  assert.deepEqual(body(a, 0).destination_details, { type: "card", card: { type: "refund" } });
  assert.deepEqual(body(a, 1), body(b, 1));
  assert.deepEqual(body(a, 2), other);
  assert.deepEqual(a.events[0]!.data.object.destination_details, { type: "card", card: { type: "refund" } });
});

test("normalizeRecording and normalizeRaw do not mutate the input", () => {
  const r = rec([
    step(0, { id: "cus_Ab12Cd34Ef", created: T0 }),
    step(1, { error: { request_log_url: "https://dashboard.stripe.com/x" } }, 400),
    step(2, { object: "refund", destination_details: { card: { reference: "1", reference_status: "available" } } }),
  ]);
  const before = structuredClone(r);
  normalizeRecording(r);
  const raw = normalizeRaw(r);
  assert.deepEqual(r, before);
  assert.deepEqual(raw, before);
  assert.notEqual(raw.steps[0], r.steps[0]);
});
