import { test } from "node:test";
import assert from "node:assert/strict";
import { endpoint, triage } from "../src/align/triage.ts";
import { compareRecordings } from "../src/bench/compare.ts";
import { normalizeRecording } from "../src/bench/normalize.ts";
import type { Recording, StepRecord, StripeEvent } from "../src/types.ts";

const step = (i: number, method: StepRecord["method"], path: string, status: number, body: unknown, errorKey?: string): StepRecord => ({
  i,
  method,
  path,
  status,
  body,
  resHeaders: errorKey ? { "parity-error-key": errorKey } : {},
  ms: 1,
});
const rec = (target: string, steps: StepRecord[], events: StripeEvent[] = []): Recording => ({
  seq: "tmpl#1",
  template: "tmpl",
  stratum: "lifecycle",
  seed: 1,
  heldOut: false,
  target,
  runId: target,
  startedAt: "2026-09-26T00:00:00.000Z",
  ms: 1,
  steps,
  events,
});
const evt = (id: string, type: string, object: Record<string, unknown>): StripeEvent => ({ id, type, created: 1790000000, data: { object } });

// Oracle vs twin of one sequence, one divergence of each kind.
const sub = (tail: string, interval: string, billing: string) => ({
  id: `sub_${tail}`,
  object: "subscription",
  created: 1790000000,
  billing_mode: { type: billing },
  items: { object: "list", data: [{ id: `si_${tail}`, object: "subscription_item", price: { id: `price_${tail}`, object: "price", recurring: { interval } } }] },
});
const oracle = rec(
  "sandbox",
  [
    step(0, "POST", "/v1/subscriptions", 200, sub("Oracle12345678", "month", "flexible")),
    step(1, "GET", "/v1/customers", 200, { object: "list", data: [{ id: "cus_Oracle12345678", object: "customer", tax_exempt: "none" }] }),
    step(2, "DELETE", "/v1/customers/cus_Oracle12345678", 200, { id: "cus_Oracle12345678", object: "customer", deleted: true }),
    step(3, "GET", "/v1/customers/cus_Missing12345678", 404, { error: { type: "invalid_request_error", message: "No such customer: 'cus_Missing12345678'" } }),
    step(4, "POST", "/v1/customers/cus_Oracle12345678", 400, { error: { type: "invalid_request_error" } }),
    step(5, "POST", "/v1/subscriptions/sub_Oracle12345678", 402, { error: { type: "card_error", payment_method: { id: "pm_Oracle12345678", object: "payment_method", card: { exp_month: 9 } } } }),
    step(6, "GET", "/v1/prices/price_Missing12345678", 404, { error: { type: "invalid_request_error" } }),
  ],
  [evt("evt_1", "customer.subscription.created", { id: "sub_Oracle12345678" }), evt("evt_2", "invoice.paid", { id: "in_Oracle12345678" })],
);
oracle.steps[0]!.body = { ...(oracle.steps[0]!.body as object), latest_invoice: "in_Oracle12345678" };
const twin = rec(
  "twin",
  [
    step(0, "POST", "/v1/subscriptions", 200, { ...sub("Twin123456789A", "year", "classic"), latest_invoice: "in_Twin123456789A" }),
    step(1, "GET", "/v1/customers", 200, { object: "list", data: [{ id: "cus_Twin123456789A", object: "customer", tax_exempt: null }] }),
    step(2, "DELETE", "/v1/customers/cus_Twin123456789A", 200, { id: "cus_Twin123456789A", object: "customer", deleted: true, extra: 1 }),
    step(3, "GET", "/v1/customers/cus_Missing12345678", 404, { error: { type: "invalid_request_error", message: "parity: resource_missing" } }, "resource_missing"),
    step(4, "POST", "/v1/customers/cus_Twin123456789A", 200, { id: "cus_Twin123456789A", object: "customer" }),
    step(5, "POST", "/v1/subscriptions/sub_Twin123456789A", 402, { error: { type: "card_error", payment_method: { id: "pm_Twin123456789A", object: "payment_method", card: { exp_month: 0 } } } }, "card_declined"),
    step(6, "GET", "/v1/prices/price_Missing12345678", 400, { error: { type: "invalid_request_error" } }, "resource_missing_400"),
  ],
  [evt("evt_3", "customer.subscription.created", { id: "sub_Twin123456789A" }), evt("evt_4", "customer.updated", { id: "cus_Twin123456789A" })],
);

test("triage: every divergence gets its locus; noise keys become NONDETERMINISTIC; earliest divergent step excludes noise", () => {
  const result = compareRecordings(normalizeRecording(oracle), normalizeRecording(twin));
  const noise = new Set(["tmpl|0|$.billing_mode.type"]);
  const { divergences, earliest } = triage([result], noise, [oracle], [twin]);
  const got = Object.fromEntries(divergences.map((d) => [`${d.step} ${d.path}`, [d.cls, d.locus]]));
  assert.deepEqual(got, {
    "0 $.billing_mode.type": ["NONDETERMINISTIC", { kind: "field", objectType: "subscription", fieldPath: "billing_mode.type" }],
    "0 $.items.data[0].price.recurring.interval": ["VALUE_MISMATCH", { kind: "field", objectType: "price", fieldPath: "recurring.interval" }],
    "1 $.data[0].tax_exempt": ["VALUE_MISMATCH", { kind: "field", objectType: "customer", fieldPath: "tax_exempt" }],
    // A deleted object is built from deleted_<type>.
    "2 $.extra": ["EXTRA_FIELD", { kind: "field", objectType: "deleted_customer", fieldPath: "extra" }],
    // Error fields: the twin's Parity-Error-Key; a typed object inside an error is a field locus.
    "3 $.error.message": ["VALUE_MISMATCH", { kind: "error", errorKey: "resource_missing", field: "message" }],
    "5 $.error.payment_method.card.exp_month": ["VALUE_MISMATCH", { kind: "field", objectType: "payment_method", fieldPath: "card.exp_month" }],
    // Status: error vs error is the catalog entry's status; a twin success where the oracle failed is the handler route.
    "6 $": ["STATUS_MISMATCH", { kind: "error", errorKey: "resource_missing_400", field: "status" }],
    "4 $": ["STATUS_MISMATCH", { kind: "route", route: "POST /v1/customers/{id}" }],
    // Events: the missing/extra types, each at the step whose response first mentions the event's object.
    "-1 $": [
      "EVENT_SET_MISMATCH",
      {
        kind: "events",
        template: "tmpl",
        steps: [
          { step: 0, missing: ["invoice.paid"], extra: [] },
          { step: 1, missing: [], extra: ["customer.updated"] },
        ],
      },
    ],
  });
  assert.deepEqual(earliest, { "tmpl#1": 0 });
  assert.deepEqual(triage([result], new Set(["tmpl|0|$.billing_mode.type", "tmpl|0|$.items.data[0].price.recurring.interval"]), [oracle], [twin]).earliest, { "tmpl#1": 1 });
});

test("endpoint: ids and route params become {id}; named segments stay", () => {
  assert.equal(endpoint("POST", "/v1/payment_methods/pm_card_visa/attach"), "POST /v1/payment_methods/{id}/attach");
  assert.equal(endpoint("GET", "/v1/customers/search?query=x"), "GET /v1/customers/search");
  assert.equal(endpoint("POST", "/v1/invoices/create_preview"), "POST /v1/invoices/create_preview");
  assert.equal(endpoint("GET", "/v1/customers"), "GET /v1/customers");
});
