import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRecordings, noiseKeys } from "../src/bench/compare.ts";
import type { Recording, StepRecord, StripeEvent } from "../src/types.ts";

const step = (i: number, status: number, body: unknown): StepRecord => ({
  i,
  method: "POST",
  path: "/v1/x",
  status,
  body,
  resHeaders: {},
  ms: 1,
});
const ev = (type: string): StripeEvent => ({ id: "<id:evt>", type, created: 0, data: { object: {} } });
const rec = (steps: StepRecord[], events: StripeEvent[] = []): Recording => ({
  seq: "tmpl#1",
  template: "tmpl",
  stratum: "refunds",
  seed: 1,
  heldOut: true,
  target: "sandbox",
  runId: "run1",
  startedAt: "2026-09-25T00:00:00Z",
  ms: 1,
  steps,
  events,
});

const sub = {
  id: "<id:sub>",
  status: "active",
  items: { object: "list", data: [{ price: { unit_amount: 500, currency: "usd" } }] },
};

test("identical recordings pass every level", () => {
  const a = rec([step(0, 200, sub)], [ev("customer.created"), ev("invoice.paid")]);
  const b = rec([step(0, 200, structuredClone(sub))], [ev("invoice.paid"), ev("customer.created")]);
  const r = compareRecordings(a, b);
  assert.deepEqual(r.steps, [{ i: 0, L1: true, L2: true, L3: true }]);
  assert.equal(r.L4, true);
  assert.equal(r.eventsMatch, true);
  assert.deepEqual(r.divergences, []);
  assert.deepEqual([r.seq, r.template, r.stratum, r.heldOut], ["tmpl#1", "tmpl", "refunds", true]);
});

test("status mismatch: one STATUS_MISMATCH at $, no body diff, fails L1-L3", () => {
  const r = compareRecordings(rec([step(0, 200, sub)]), rec([step(0, 400, { error: { type: "invalid_request_error" } })]));
  assert.deepEqual(r.steps, [{ i: 0, L1: false, L2: false, L3: false }]);
  assert.deepEqual(r.divergences, [{ seq: "tmpl#1", step: 0, path: "$", cls: "STATUS_MISMATCH", expected: 200, actual: 400 }]);
  assert.equal(r.L4, false);
});

test("missing, extra, value and type mismatches with JSON paths; L2 holds on value-only diffs", () => {
  const target = structuredClone(sub) as any;
  target.items.data[0].price.unit_amount = 600; // value → L2 ok, L3 fails
  const r1 = compareRecordings(rec([step(0, 200, sub)]), rec([step(0, 200, target)]));
  assert.deepEqual(r1.steps[0], { i: 0, L1: true, L2: true, L3: false });
  assert.deepEqual(r1.divergences, [
    { seq: "tmpl#1", step: 0, path: "$.items.data[0].price.unit_amount", cls: "VALUE_MISMATCH", expected: 500, actual: 600 },
  ]);

  const t2 = structuredClone(sub) as any;
  delete t2.status;
  t2.extra = true;
  t2.items.data[0].price.currency = null; // string → null: type mismatch
  const r2 = compareRecordings(rec([step(0, 200, sub)]), rec([step(0, 200, t2)]));
  assert.deepEqual(r2.steps[0], { i: 0, L1: true, L2: false, L3: false });
  assert.deepEqual(
    r2.divergences.map((d) => [d.path, d.cls, d.expected, d.actual]),
    [
      ["$.status", "MISSING_FIELD", "active", undefined],
      ["$.items.data[0].price.currency", "VALUE_MISMATCH", "usd", null],
      ["$.extra", "EXTRA_FIELD", undefined, true],
    ],
  );
});

test("array length difference: one VALUE_MISMATCH at the array path; shape ignores element count", () => {
  const t = structuredClone(sub) as any;
  t.items.data.push(structuredClone(sub.items.data[0]));
  const r = compareRecordings(rec([step(0, 200, sub)]), rec([step(0, 200, t)]));
  assert.deepEqual(r.steps[0], { i: 0, L1: true, L2: true, L3: false });
  assert.deepEqual(r.divergences, [{ seq: "tmpl#1", step: 0, path: "$.items.data", cls: "VALUE_MISMATCH", expected: 1, actual: 2 }]);
});

test("L4 fails on events alone: EVENT_SET_MISMATCH at step -1 with sorted type lists", () => {
  const a = rec([step(0, 200, sub)], [ev("invoice.paid"), ev("customer.created"), ev("invoice.paid")]);
  const b = rec([step(0, 200, sub)], [ev("customer.created"), ev("invoice.paid")]);
  const r = compareRecordings(a, b);
  assert.equal(r.steps.every((s) => s.L3), true);
  assert.equal(r.eventsMatch, false);
  assert.equal(r.L4, false);
  assert.deepEqual(r.divergences, [
    {
      seq: "tmpl#1",
      step: -1,
      path: "$",
      cls: "EVENT_SET_MISMATCH",
      expected: ["customer.created", "invoice.paid", "invoice.paid"],
      actual: ["customer.created", "invoice.paid"],
    },
  ]);
});

test("noise keys relabel divergences NONDETERMINISTIC without changing the levels", () => {
  const t = structuredClone(sub) as any;
  t.status = "incomplete";
  const oracle = rec([step(0, 200, sub)]);
  const noise = noiseKeys([compareRecordings(oracle, rec([step(0, 200, t)]))]);
  assert.deepEqual([...noise], ["tmpl|0|$.status"]);

  const t2 = structuredClone(t);
  t2.items.data[0].price.unit_amount = 1;
  const r = compareRecordings(oracle, rec([step(0, 200, t2)]), noise);
  assert.deepEqual(
    r.divergences.map((d) => [d.path, d.cls]),
    [
      ["$.status", "NONDETERMINISTIC"],
      ["$.items.data[0].price.unit_amount", "VALUE_MISMATCH"],
    ],
  );
  assert.deepEqual(r.steps[0], { i: 0, L1: true, L2: true, L3: false });
  assert.equal(r.L4, false);
});

test("a missing target step fails L1 with a STATUS_MISMATCH", () => {
  const r = compareRecordings(rec([step(0, 200, sub), step(1, 200, sub)]), rec([step(0, 200, sub)]));
  assert.deepEqual(r.steps[1], { i: 1, L1: false, L2: false, L3: false });
  assert.deepEqual(r.divergences, [{ seq: "tmpl#1", step: 1, path: "$", cls: "STATUS_MISMATCH", expected: 200, actual: undefined }]);
});
