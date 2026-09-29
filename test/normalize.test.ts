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
  assert.equal(NORMALIZATION_VERSION, "v1.5");
  assert.equal(RULES.length, 14);
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
      [{ id: "evt_1AbcDEFghijk", type: "customer.created", created: T0 + 10, data: { object: { created: T0 + 10 } } }],
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
  // An event's own created stays raw (compare's causal-order check, method m2); its object's is normalized.
  assert.equal(r.events[0]!.created, T0 + 10);
  assert.equal(r.events[0]!.data.object.created, "<t:~0>");
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
        card: { fingerprint: "FpAaaaaaaaaaaaaa" }, // made up: any value normalizes
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

test("v1.3: a test clock's deletes_after and status_details.advancing.target_frozen_time are timestamps", () => {
  // Two faithful runs three days apart: every clock timestamp moves with created, so they compare equal.
  const clock = (t: number) =>
    rec([step(0, { id: "clock_Abcdefghij12", object: "test_helpers.test_clock", created: t, deletes_after: t + 30 * 86400, frozen_time: t, status: "advancing", status_details: { advancing: { target_frozen_time: t + 86400 } } })]);
  const [a, b] = [normalizeRecording(clock(T0)), normalizeRecording(clock(T0 + 3 * 86400))];
  assert.deepEqual(body(a, 0), body(b, 0));
  assert.equal(body(a, 0).deletes_after, "<t:+720h>");
  assert.equal(body(a, 0).status_details.advancing.target_frozen_time, "<t:+24h>");
});

test("v1.4: a declined invoice's next_payment_attempt is a day offset; before any attempt, and on other objects, it stays hourly", () => {
  // The sandbox attempts at t0 + 33 days and retries 42–46 h later: both ends of that spread compare equal.
  const at = T0 + 33 * 86400;
  const run = (retryH: number) =>
    normalizeRecording(
      rec([
        step(0, { object: "price", created: T0 }),
        step(1, { object: "list", data: [{ object: "invoice", attempt_count: 1, attempted: true, next_payment_attempt: at + retryH * 3600 }, { object: "invoice", attempt_count: 0, next_payment_attempt: at + 3600 }] }),
        step(2, { object: "subscription", attempt_count: 1, next_payment_attempt: at + retryH * 3600 }),
      ]),
    );
  const [a, b] = [run(42), run(46)];
  assert.deepEqual(body(a, 1), body(b, 1));
  assert.equal(body(a, 1).data[0].next_payment_attempt, "<t:+35d>");
  assert.equal(body(a, 1).data[1].next_payment_attempt, "<t:+793h>"); // no attempt yet: hour-granular
  assert.equal(body(a, 2).next_payment_attempt, "<t:+834h>"); // not an invoice: hour-granular
  assert.notDeepEqual(body(a, 2), body(b, 2));
  // A retry a day later is still a divergence.
  assert.equal(body(run(70), 1).data[0].next_payment_attempt, "<t:+36d>");
});

test("v1.4: payment_method_details.card.electronic_commerce_indicator is opaque unless null; 3DS's is compared", () => {
  // Made-up values: any non-null value normalizes.
  const charge = (eci: string | null) => ({ object: "charge", payment_method_details: { card: { brand: "visa", electronic_commerce_indicator: eci, three_d_secure: { electronic_commerce_indicator: eci } } } });
  const [a, b] = [normalizeRecording(rec([step(0, charge("e1")), step(1, { object: "list", data: [{ latest_charge: charge("e1") }] })])), normalizeRecording(rec([step(0, charge("e2")), step(1, { object: "list", data: [{ latest_charge: charge("e2") }] })]))];
  assert.equal(body(a, 0).payment_method_details.card.electronic_commerce_indicator, "<opaque>");
  assert.equal(body(a, 1).data[0].latest_charge.payment_method_details.card.electronic_commerce_indicator, "<opaque>");
  assert.equal(body(a, 0).payment_method_details.card.three_d_secure.electronic_commerce_indicator, "e1");
  assert.notDeepEqual(body(a, 0), body(b, 0), "the 3DS ECI still differs");
  assert.equal(body(normalizeRecording(rec([step(0, charge(null))])), 0).payment_method_details.card.electronic_commerce_indicator, null);
});

test("v1.5: a D Mon YYYY date in text is <date> (steps, lists, events); the line's period is still compared", () => {
  // Made-up text: the same proration line recorded on two days.
  const line = (day: number) => ({ object: "line_item", description: `Unused time on Plan after ${day} Sep 2026`, period: { start: T0 + day * 86400, end: T0 + 30 * 86400 } });
  const run = (day: number) => normalizeRecording(rec([step(0, { object: "invoice", created: T0, lines: { object: "list", data: [line(day)] } })], [{ id: "evt_1AbcDEFghijk", type: "invoice.created", created: T0, data: { object: line(day) } } as unknown as StripeEvent]));
  const [a, b] = [run(28), run(29)];
  assert.equal(body(a, 0).lines.data[0].description, "Unused time on Plan after <date>");
  assert.equal((a.events[0] as any).data.object.description, "Unused time on Plan after <date>");
  assert.notDeepEqual(body(a, 0), body(b, 0), "the period start still differs by a day");
  assert.deepEqual(body(a, 0).lines.data[0].period, { start: "<t:+672h>", end: "<t:+720h>" });
  // Other text with digits and months stays: only the `D Mon YYYY` form.
  const keep = ["Plan 29 Sept 2026", "2026-09-29", "Sep 29, 2026", "129 Sep 20260"];
  assert.deepEqual(keep.map((d) => body(normalizeRecording(rec([step(0, { description: d })])), 0).description), keep);
  assert.equal(body(normalizeRecording(rec([step(0, { description: "1 Jan 2027 to 31 Dec 2027" })])), 0).description, "<date> to <date>");
});

test("v1.5: account_name is opaque, null included (unclaimed vs claimed sandbox); account_country is compared", () => {
  const inv = (name: string | null, country: string) => ({ object: "invoice", account_name: name, account_country: country });
  const [a, b] = [normalizeRecording(rec([step(0, inv(null, "US"))])), normalizeRecording(rec([step(0, { object: "subscription", latest_invoice: inv("Acme", "US") })]))];
  assert.deepEqual(body(a, 0), { object: "invoice", account_name: "<opaque>", account_country: "US" });
  assert.deepEqual(body(b, 0).latest_invoice, body(a, 0));
  assert.notDeepEqual(body(normalizeRecording(rec([step(0, inv("Acme", "GB"))])), 0), body(a, 0));
});

test("v1.2: refund destination_details.card reference keys dropped (steps, lists, events); other objects keep them", () => {
  const refund = (card: Record<string, unknown>) => ({ id: "re_Abcdefghij12", object: "refund", created: T0, destination_details: { type: "card", card } });
  const pending = refund({ reference_status: "pending", reference_type: "acquirer_reference_number", type: "refund" });
  const available = refund({ reference: "1234567890123456", reference_status: "available", reference_type: "acquirer_reference_number", type: "refund" });
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
