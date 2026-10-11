import { test } from "node:test";
import assert from "node:assert/strict";
import { gate } from "../src/align/gate.ts";
import { propose, type Catalog, type Edit } from "../src/align/patch.ts";
import { wilson } from "../src/bench/score.ts";
import type { Locus, Triaged } from "../src/align/triage.ts";
import type { DivergenceClass, Recording, StepRecord } from "../src/types.ts";

// Normalized oracle recordings: one customer body per sequence, plus one error step.
const rec = (seq: string, heldOut: boolean, steps: StepRecord[]): Recording => ({
  seq,
  template: seq.split("#")[0]!,
  stratum: "lifecycle",
  seed: Number(seq.split("#")[1]),
  heldOut,
  target: "sandbox",
  runId: "r",
  startedAt: "2026-09-26T00:00:00.000Z",
  ms: 1,
  steps,
  events: [],
});
const st = (i: number, status: number, body: unknown, errorKey?: string): StepRecord => ({
  i,
  method: "POST",
  path: "/v1/x",
  status,
  body,
  resHeaders: errorKey ? { "parity-error-key": errorKey } : {},
  ms: 1,
});
const customer = (fields: Record<string, unknown>) => ({ id: "<id:cus>", object: "customer", ...fields });
const div = (seq: string, step: number, path: string, cls: DivergenceClass, locus: Locus, heldOut = false): Triaged => ({
  seq,
  step,
  path,
  cls,
  template: seq.split("#")[0]!,
  heldOut,
  locus,
});
const field = (fieldPath: string): Locus => ({ kind: "field", objectType: "customer", fieldPath });
const error = (errorKey: string, f: string): Locus => ({ kind: "error", errorKey, field: f });
const catalog: Catalog = {
  card_declined: { status: 402, type: "card_error", code: "card_declined", message: "parity: card_declined" },
  resource_missing: { status: 404, type: "invalid_request_error", code: "resource_missing", param: "{param}", message: "parity: resource_missing" },
  idempotency_mismatch: { status: 400, type: "idempotency_error", message: "parity: idempotency_mismatch" },
};
const data = { shape: (t: string) => (t === "customer" ? {} : undefined), catalog };

/** One divergence per (sequence, path) for the given sequences, all at step 0 under `$`. */
const at = (seqs: string[], path: string, cls: DivergenceClass, locus: Locus, heldOut = false) => seqs.map((s) => div(s, 0, path, cls, locus, heldOut));

test("determinism: a value identical at every train occurrence is a candidate; one that varies, or is in the noise set, is not", () => {
  const oracle = [
    rec("a#1", false, [st(0, 200, customer({ tax_exempt: "none", locale: "en", name: "x", legacy: undefined }))]),
    rec("a#2", false, [st(0, 200, customer({ tax_exempt: "none", locale: "fr", name: "x" }))]),
    rec("b#1", false, [st(0, 200, { object: "list", data: [customer({ tax_exempt: "none", locale: "en", name: "x" })] })]),
  ];
  const seqs = ["a#1", "a#2"];
  const divergences = [
    ...at(seqs, "$.tax_exempt", "VALUE_MISMATCH", field("tax_exempt")),
    div("b#1", 0, "$.data[0].tax_exempt", "VALUE_MISMATCH", field("tax_exempt")),
    ...at(seqs, "$.locale", "MISSING_FIELD", field("locale")),
    ...at(seqs, "$.name", "VALUE_MISMATCH", field("name")),
    ...at(seqs, "$.sources", "EXTRA_FIELD", field("sources")),
  ];
  // b#1's name (inside a list) is in the noise set: the whole locus is not deterministic.
  const noise = new Set(["b|0|$.data[0].name"]);
  const { candidates, notMechanical } = propose(divergences, oracle, [], noise, data);
  assert.deepEqual(
    candidates.map((c) => [c.file, c.pointer, c.op, c.value, c.evidence, c.ids.length]),
    [
      ["src/twin/shapes/customer.json", "/tax_exempt", "set", "none", { occurrences: 3, seqs: ["a#1", "a#2", "b#1"] }, 3],
      ["src/twin/shapes/customer.json", "/sources", "delete", undefined, { occurrences: 3, seqs: ["a#1", "a#2", "b#1"] }, 2],
    ],
  );
  assert.deepEqual(
    notMechanical.map((n) => [n.locus, n.reason]),
    [
      [field("locale"), "varies across sequences"],
      [field("name"), "noise: an occurrence is in the noise set"],
    ],
  );
  // A divergence already marked NONDETERMINISTIC by triage blocks its locus too.
  const marked = propose([div("a#1", 0, "$.tax_exempt", "NONDETERMINISTIC", field("tax_exempt"))], oracle, [], new Set(), data);
  assert.deepEqual([marked.candidates, marked.notMechanical.map((n) => n.reason)], [[], ["noise: a divergence at this locus is in the noise set"]]);
});

test("placeholders are never seeded: ids, times, dates in text, run nonces and opaques in a field or a message are computed", () => {
  const oracle = [1, 2].map((n) =>
    rec(`a#${n}`, false, [
      st(0, 200, customer({ default_source: "<id:card>", period: { end: "<t:+720h>" }, invoice_prefix: "<opaque>", description: "Unused time on Plan after <date>" })),
      st(1, 400, { error: { type: "idempotency_error", message: "Keys for idempotent requests ... other than 'parity-<run>-k1' ..." } }),
      st(2, 404, { error: { type: "invalid_request_error", message: "No such customer: '<id:cus>'", param: "id" } }),
    ]),
  );
  const twin = [1, 2].map((n) =>
    rec(`a#${n}`, false, [st(0, 200, {}), st(1, 400, {}, "idempotency_mismatch"), st(2, 404, { error: { param: "id" } }, "resource_missing")]),
  );
  const seqs = ["a#1", "a#2"];
  const divergences = [
    ...at(seqs, "$.default_source", "VALUE_MISMATCH", field("default_source")),
    ...at(seqs, "$.period.end", "VALUE_MISMATCH", field("period.end")),
    ...at(seqs, "$.invoice_prefix", "VALUE_MISMATCH", field("invoice_prefix")),
    ...at(seqs, "$.description", "VALUE_MISMATCH", field("description")),
    ...seqs.map((s) => div(s, 1, "$.error.message", "VALUE_MISMATCH", error("idempotency_mismatch", "message"))),
    ...seqs.map((s) => div(s, 2, "$.error.message", "VALUE_MISMATCH", error("resource_missing", "message"))),
  ];
  const { candidates, notMechanical } = propose(divergences, oracle, twin, new Set(), data);
  assert.deepEqual(candidates, []);
  assert.deepEqual(notMechanical.map((n) => n.reason), [
    "computed: the value holds a normalization placeholder",
    "computed: the value holds a normalization placeholder",
    "computed: the value holds a normalization placeholder",
    "computed: the value holds a normalization placeholder",
    "computed: the message holds placeholders no twin var renders",
    // Constant after normalization, but the twin's only var (param "id") never rendered that id: never seeded literally.
    "computed: the message holds placeholders no twin var renders",
  ]);

  // When the twin's rendered var is the id, the token becomes that catalog placeholder.
  const twinWithId = twin.map((r, n) => ({ ...r, steps: r.steps.map((s) => (s.i === 2 ? { ...s, body: { error: { param: `cus_Twin${n}Abcdefgh12` } } } : s)) }));
  const byVar = propose(divergences.filter((d) => d.step === 2), oracle, twinWithId, new Set(), data);
  assert.deepEqual(byVar.candidates.map((c) => [c.file, c.pointer, c.value]), [["src/twin/errors.json", "/resource_missing/message", "No such customer: '{param}'"]]);
});

test("error catalog fields: constant status/type/message are set, a code the oracle never sends is deleted, a varying one is not", () => {
  const oracle = [1, 2, 3].map((n) =>
    rec(`d#${n}`, false, [st(0, 402, { error: { type: "card_error", message: "Your card was declined.", param: n === 3 ? "b" : "a", decline_code: "generic_decline" } })]),
  );
  const twin = [1, 2, 3].map((n) => rec(`d#${n}`, false, [st(0, 400, {}, "card_declined")]));
  const seqs = ["d#1", "d#2", "d#3"];
  const on = (f: string, path: string, cls: DivergenceClass) => seqs.map((s) => div(s, 0, path, cls, error("card_declined", f)));
  const { candidates, notMechanical } = propose(
    [...on("status", "$", "STATUS_MISMATCH"), ...on("message", "$.error.message", "VALUE_MISMATCH"), ...on("code", "$.error.code", "EXTRA_FIELD"), ...on("param", "$.error.param", "MISSING_FIELD"), ...on("decline_code", "$.error.decline_code", "MISSING_FIELD")],
    oracle,
    twin,
    new Set(),
    data,
  );
  assert.deepEqual(
    candidates.map((c) => [c.pointer, c.op, c.value, c.evidence.occurrences]),
    [
      ["/card_declined/status", "set", 402, 3],
      ["/card_declined/message", "set", "Your card was declined.", 3],
      ["/card_declined/code", "delete", undefined, 3],
    ],
  );
  assert.deepEqual(notMechanical.map((n) => n.reason), ["varies across sequences", "not a catalog field (status, type, code, param, message)"]);
});

test("held-out sequences never feed candidates: not their divergences, not their values", () => {
  const oracle = [
    rec("t#1", false, [st(0, 200, customer({ tax_exempt: "none" }))]),
    rec("t#2", false, [st(0, 200, customer({ tax_exempt: "none" }))]),
    rec("h#1", true, [st(0, 200, customer({ tax_exempt: "exempt", delinquent: false }))]),
  ];
  const divergences = [
    ...at(["t#1", "t#2"], "$.tax_exempt", "VALUE_MISMATCH", field("tax_exempt")),
    div("h#1", 0, "$.tax_exempt", "VALUE_MISMATCH", field("tax_exempt"), true),
    div("h#1", 0, "$.delinquent", "MISSING_FIELD", field("delinquent"), true), // held-out only: never a candidate
  ];
  const { candidates, notMechanical } = propose(divergences, oracle, [], new Set(), data);
  assert.deepEqual(candidates.map((c) => [c.pointer, c.value, c.evidence, c.ids]), [["/tax_exempt", "none", { occurrences: 2, seqs: ["t#1", "t#2"] }, ["t#1|0|$.tax_exempt", "t#2|0|$.tax_exempt"]]]);
  assert.deepEqual(notMechanical, []);
});

test("not mechanical: no template for the type, a field inside an array element, present in only some occurrences", () => {
  const oracle = [
    rec("a#1", false, [st(0, 200, { object: "list", total_count: 1, data: [customer({ tags: ["x"], phone: "1" })] })]),
    rec("a#2", false, [st(0, 200, { object: "list", total_count: 1, data: [customer({ tags: ["x"] })] })]),
  ];
  const seqs = ["a#1", "a#2"];
  const { candidates, notMechanical } = propose(
    [
      ...at(seqs, "$.total_count", "EXTRA_FIELD", { kind: "field", objectType: "list", fieldPath: "total_count" }),
      ...at(seqs, "$.data[0].tags[0]", "VALUE_MISMATCH", field("tags[0]")),
      div("a#1", 0, "$.data[0].phone", "MISSING_FIELD", field("phone")),
    ],
    oracle,
    [],
    new Set(),
    data,
  );
  assert.deepEqual(candidates, []);
  assert.deepEqual(notMechanical.map((n) => n.reason), ["no template src/twin/shapes/list.json", "inside an array element", "absent from some occurrences"]);
});

test("constant only in this oracle: a message quoting the request, an account- or date-derived field are never seeded", () => {
  const path = "a.b.c.d.e";
  const oracle = [1, 2].map((n) =>
    rec(`e#${n}`, false, [
      { ...st(0, 400, { error: { type: "invalid_request_error", message: `Too deep: ${path}` } }), params: { expand: [path] } },
      { ...st(1, 402, { error: { type: "card_error", message: "Your card was declined." } }), params: { customer: `cus_${n}abc`, confirm: true, metadata: { tag: "de" } } },
      st(2, 200, customer({ address: { country: null }, invoice_settings: { card: { exp_month: 12 } }, account_country: "ZZ" })),
    ]),
  );
  const twin = [1, 2].map((n) => rec(`e#${n}`, false, [st(0, 400, {}, "expand_too_deep"), st(1, 402, {}, "card_declined"), st(2, 200, {})]));
  const cat: Catalog = { ...catalog, expand_too_deep: { status: 400, type: "invalid_request_error", message: "parity: expand_too_deep" } };
  const seqs = ["e#1", "e#2"];
  const { candidates, notMechanical } = propose(
    [
      ...seqs.map((s) => div(s, 0, "$.error.message", "VALUE_MISMATCH", error("expand_too_deep", "message"))),
      ...seqs.map((s) => div(s, 1, "$.error.message", "VALUE_MISMATCH", error("card_declined", "message"))),
      ...seqs.map((s) => div(s, 2, "$.address", "MISSING_FIELD", field("address"))),
      ...seqs.map((s) => div(s, 2, "$.invoice_settings", "MISSING_FIELD", field("invoice_settings"))), // parent holding exp_month
      ...seqs.map((s) => div(s, 2, "$.account_country", "MISSING_FIELD", field("account_country"))),
    ],
    oracle,
    twin,
    new Set(),
    { ...data, catalog: cat },
  );
  // The declined message quotes no request value (short and boolean leaves never count; its twin body renders no
  // sub-code, so the one-binding rule does not apply); the address is API semantics.
  assert.deepEqual(candidates.map((c) => [c.pointer, c.value]), [
    ["/card_declined/message", "Your card was declined."],
    ["/address", { country: null }],
  ]);
  assert.deepEqual(notMechanical.map((n) => n.reason), [
    "request-derived: the message quotes a request parameter value",
    "account- or time-derived: constant only within one account or month",
    "account- or time-derived: constant only within one account or month",
  ]);
});

test("request vars: the request's value at the param, the object of the path's id, and a call-site var that varies become {vars}", () => {
  const msgs = [
    ["No such customer: '<id:cus>'", "Received unknown parameter: colour", "At most 99 (it currently is '1000')."],
    ["No such invoice: '<id:in>'", "Received unknown parameter: nickname", "At most 99 (it currently is '1000')."],
  ];
  const oracle = msgs.map((m, n) => rec(`r#${n + 1}`, false, m.map((message, i) => ({ ...st(i, 400, { error: { type: "invalid_request_error", message } }), params: { amount: 1000 } }))));
  // The twin's own requests: renderError reads its vars from these, so the patcher does too.
  const tw = (i: number, key: string, param: string, path: string, params: Record<string, unknown>) => ({ ...st(i, 400, { error: { param } }, key), path, params });
  const twin = [
    rec("r#1", false, [tw(0, "resource_missing", "id", "/v1/customers/cus_1AbCdEfGhIjK", {}), tw(1, "unknown", "colour", "/v1/customers", { colour: "x" }), tw(2, "too_large", "amount", "/v1/prices", { amount: 1000 })]),
    rec("r#2", false, [tw(0, "resource_missing", "invoice", "/v1/invoices/in_2AbCdEfGhIjK", {}), tw(1, "unknown", "nickname", "/v1/customers", { nickname: "x" }), tw(2, "too_large", "amount", "/v1/prices", { amount: 1000 })]),
  ];
  const keys = ["resource_missing", "unknown", "too_large"];
  const { candidates, notMechanical } = propose(
    keys.flatMap((k, i) => ["r#1", "r#2"].map((s) => div(s, i, "$.error.message", "VALUE_MISMATCH", error(k, "message")))),
    oracle,
    twin,
    new Set(),
    {
      ...data,
      catalog: {
        ...catalog,
        unknown: { status: 400, type: "invalid_request_error", param: "{param}", message: "parity: unknown" },
        too_large: { status: 400, type: "invalid_request_error", param: "amount", message: "parity: too_large" },
      },
    },
  );
  // "1000" is the same in both: a constant, yet the request's own value at the param, so {value} (no request-derived refusal).
  assert.deepEqual(candidates.map((c) => [c.pointer, c.value]), [
    ["/resource_missing/message", "No such {object}: '{value}'"],
    ["/unknown/message", "Received unknown parameter: {param}"],
    ["/too_large/message", "At most 99 (it currently is '{value}')."],
  ]);
  assert.deepEqual(notMechanical, []);
});

test("constant only for what the corpus covers: free text in a field, a generic key's message seen with one binding", () => {
  const oracle = [1, 2].map((n) =>
    rec(`g#${n}`, false, [
      st(0, 400, { error: { type: "invalid_request_error", message: "Must be at least one.", param: "q" } }),
      st(1, 400, { error: { type: "invalid_request_error", message: "Not a number.", param: n === 1 ? "q" : "r" } }),
      st(2, 200, customer({ note: "made by flow", mode: "auto_x", settings: { label: "TIER1", kind: "basic" }, level: { kind: "basic", n: 2 } })),
    ]),
  );
  // Both keys are generic ({param}); the twin raises the first for one parameter only, the second for two.
  const twin = [1, 2].map((n) =>
    rec(`g#${n}`, false, [st(0, 400, { error: { param: "q" } }, "bad_min"), st(1, 400, { error: { param: n === 1 ? "q" : "r" } }, "bad_number"), st(2, 200, {})]),
  );
  const generic = (key: string) => ({ status: 400, type: "invalid_request_error", param: "{param}", message: `parity: ${key}` });
  const seqs = ["g#1", "g#2"];
  const { candidates, notMechanical } = propose(
    [
      ...seqs.map((s) => div(s, 0, "$.error.message", "VALUE_MISMATCH", error("bad_min", "message"))),
      ...seqs.map((s) => div(s, 1, "$.error.message", "VALUE_MISMATCH", error("bad_number", "message"))),
      ...["note", "mode", "settings", "level"].flatMap((f) => seqs.map((s) => div(s, 2, `$.${f}`, "MISSING_FIELD", field(f)))),
    ],
    oracle,
    twin,
    new Set(),
    { ...data, catalog: { ...catalog, bad_min: generic("bad_min"), bad_number: generic("bad_number") } },
  );
  assert.deepEqual(candidates.map((c) => [c.pointer, c.value]), [
    ["/bad_number/message", "Not a number."],
    ["/mode", "auto_x"],
    ["/level", { kind: "basic", n: 2 }],
  ]);
  assert.deepEqual(notMechanical.map((n) => n.reason), [
    "one binding: every occurrence renders the same {param} or sub-code, so the message is shown for one use of the key only",
    "context text: only enum-like tokens are type defaults", // prose
    "context text: only enum-like tokens are type defaults", // an uppercase code inside a seeded parent
  ]);
});

test("one binding by sub-code: a key's message seen with one decline-code-like extra is held; two are seeded; ids never count", () => {
  const oracle = [1, 2].map((n) =>
    rec(`s#${n}`, false, [0, 1].map((i) => st(i, 402, { error: { type: "card_error", message: "Declined." } }))),
  );
  // No {param} on either key. The first renders one sub-code, next to renderError's own fields (a per-request log url),
  // a per-sequence id and an object; the second renders two sub-codes.
  const rendered = (n: number) => ({ type: "card_error", code: "x", message: "parity: declined_one", request_log_url: `https://example.test/req_${n}` });
  const twin = [1, 2].map((n) =>
    rec(`s#${n}`, false, [
      st(0, 402, { error: { ...rendered(n), charge: `ch_${n}234567890AbC`, reason: "reason_a", payment_method: { id: "pm_x" } } }, "declined_one"),
      st(1, 402, { error: { reason: n === 1 ? "reason_a" : "reason_b" } }, "declined_two"),
    ]),
  );
  const plain = (key: string) => ({ status: 402, type: "card_error", code: "x", message: `parity: ${key}` });
  const seqs = ["s#1", "s#2"];
  const { candidates, notMechanical } = propose(
    [
      ...seqs.map((s) => div(s, 0, "$.error.message", "VALUE_MISMATCH", error("declined_one", "message"))),
      ...seqs.map((s) => div(s, 1, "$.error.message", "VALUE_MISMATCH", error("declined_two", "message"))),
    ],
    oracle,
    twin,
    new Set(),
    { ...data, catalog: { ...catalog, declined_one: plain("declined_one"), declined_two: plain("declined_two") } },
  );
  assert.deepEqual(candidates.map((c) => [c.pointer, c.value]), [["/declined_two/message", "Declined."]]);
  assert.deepEqual(notMechanical.map((n) => [n.locus, n.reason]), [
    [error("declined_one", "message"), "one binding: every occurrence renders the same {param} or sub-code, so the message is shown for one use of the key only"],
  ]);
});

test("never seeded: a fraud or risk field (the key, a path under it, a key inside the value); a literal over a catalog {var}", () => {
  const oracle = [1, 2].map((n) =>
    rec(`f#${n}`, false, [
      st(0, 200, customer({ outcome: "basic", checks: { cvc: "pass" }, card: { kind: "basic", risk_score: 1 }, tier: "basic" })),
      st(1, 404, { error: { type: "invalid_request_error", code: "gone", param: "p" } }),
      st(2, 404, { error: { type: "invalid_request_error" } }),
    ]),
  );
  // The twin renders a different {param} than the oracle (one call site's bug), and one the oracle omits.
  const twin = [1, 2].map((n) => rec(`f#${n}`, false, [st(0, 200, {}), st(1, 404, { error: { param: "q" } }, "resource_missing"), st(2, 404, { error: { param: "q" } }, "gone_var")]));
  const seqs = ["f#1", "f#2"];
  const { candidates, notMechanical } = propose(
    [
      ...["outcome", "checks.cvc", "card", "tier"].flatMap((f) => seqs.map((s) => div(s, 0, `$.${f}`, "MISSING_FIELD", field(f)))),
      ...seqs.map((s) => div(s, 0, "$.fraud_details", "EXTRA_FIELD", field("fraud_details"))), // a delete seeds nothing
      ...seqs.map((s) => div(s, 1, "$.error.param", "VALUE_MISMATCH", error("resource_missing", "param"))),
      ...seqs.map((s) => div(s, 1, "$.error.code", "VALUE_MISMATCH", error("resource_missing", "code"))), // a literal field of the same entry
      ...seqs.map((s) => div(s, 2, "$.error.param", "EXTRA_FIELD", error("gone_var", "param"))),
    ],
    oracle,
    twin,
    new Set(),
    { ...data, catalog: { ...catalog, gone_var: { status: 404, type: "invalid_request_error", param: "{param}", message: "parity: gone_var" } } },
  );
  assert.deepEqual(candidates.map((c) => [c.pointer, c.op, c.value]), [
    ["/tier", "set", "basic"],
    ["/fraud_details", "delete", undefined],
    ["/resource_missing/code", "set", "gone"],
  ]);
  assert.deepEqual(notMechanical.map((n) => [n.locus, n.reason]), [
    ...["outcome", "checks.cvc", "card"].map((f) => [field(f), "fraud or risk data: never seeded into a public template"]),
    [error("resource_missing", "param"), "call-site var: the entry's {var} renders per call site (assisted)"],
    [error("gone_var", "param"), "call-site var: the entry's {var} renders per call site (assisted)"],
  ]);
});

test("nested defaults: a pointer the nearest template lacks is proposed in the enclosing template that has it, when every divergence sits under it", () => {
  // build() deep-merges subscription_item.json#/price over the stored price: its `tiers` and `currency_options` show on
  // every item's price, while price.json has neither (nor `foo`, which only handler code could add).
  const shapes: Record<string, unknown> = { price: { object: "price" }, subscription_item: { object: "subscription_item", price: { tiers: [], currency_options: {}, bar: 1 } } };
  const nested = { shape: (t: string) => shapes[t], catalog };
  const price = (fields: Record<string, unknown> = {}) => ({ id: "<id:price>", object: "price", ...fields });
  const sub = (p: Record<string, unknown>) => ({ object: "subscription", items: { object: "list", data: [{ object: "subscription_item", price: p }] } });
  const oracle = [
    rec("t#1", false, [st(0, 200, sub(price())), st(1, 200, price())]),
    rec("t#2", false, [st(0, 200, sub(price()))]),
    // Held out: an item price that has tiers (the delete would be wrong if it were read), and a divergence of its own.
    rec("h#1", true, [st(0, 200, sub(price({ tiers: [{ up_to: 1 }] })))]),
  ];
  const item = (f: string) => "$.items.data[0].price." + f;
  const loc = (f: string): Locus => ({ kind: "field", objectType: "price", fieldPath: f });
  const divergences = [
    ...at(["t#1", "t#2"], item("tiers"), "EXTRA_FIELD", loc("tiers")),
    ...at(["t#1", "t#2"], item("foo"), "EXTRA_FIELD", loc("foo")),
    // One divergence on a price no subscription_item encloses: the item template's copy is not what all of them share.
    div("t#1", 0, item("currency_options"), "EXTRA_FIELD", loc("currency_options")),
    div("t#1", 1, "$.currency_options", "EXTRA_FIELD", loc("currency_options")),
    div("h#1", 0, item("bar"), "EXTRA_FIELD", loc("bar"), true), // held-out only: never a candidate
  ];
  const { candidates, notMechanical } = propose(divergences, oracle, [], new Set(), nested);
  assert.deepEqual(
    candidates.map((c) => [c.file, c.pointer, c.op, c.evidence, c.ids]),
    [
      [
        "src/twin/shapes/subscription_item.json",
        "/price/tiers",
        "delete",
        { occurrences: 2, seqs: ["t#1", "t#2"], template: "src/twin/shapes/subscription_item.json#/price/tiers", nearest: "src/twin/shapes/price.json#/tiers" },
        ["t#1|0|$.items.data[0].price.tiers", "t#2|0|$.items.data[0].price.tiers"],
      ],
      // Neither template has it: the nearest edit stays, and the gate finds it changes nothing (blocked-by-code).
      ["src/twin/shapes/price.json", "/foo", "delete", { occurrences: 3, seqs: ["t#1", "t#2"] }, ["t#1|0|$.items.data[0].price.foo", "t#2|0|$.items.data[0].price.foo"]],
      ["src/twin/shapes/price.json", "/currency_options", "delete", { occurrences: 3, seqs: ["t#1", "t#2"] }, ["t#1|0|$.items.data[0].price.currency_options", "t#1|1|$.currency_options"]],
    ],
  );
  assert.deepEqual(notMechanical, []);

  // The gate on a twin where only the item template's copy matters: the enclosing edit is accepted, the others blocked.
  const pool = divergences.filter((d) => !d.heldOut).map((d) => `${d.seq}|${d.step}|${d.path}`);
  const L = (k: number) => ({ L1: wilson(k, 10), L2: wilson(k, 10), L3: wilson(k, 10), L4: wilson(k, 10) });
  const evaluate = (edits: Edit[]) => {
    const gone = edits.some((e) => e.file.endsWith("subscription_item.json") && e.pointer === "/price/tiers") ? candidates[0]!.ids : [];
    const ids = new Set(pool.filter((id) => !gone.includes(id)));
    return { train: L(10 - ids.size), heldOut: L(5), trainDivergences: ids.size, ids };
  };
  const g = gate(candidates, evaluate);
  assert.deepEqual(
    [g.accepted, g.blocked, g.rejected].map((js) => js.map((j) => `${j.candidate.file}#${j.candidate.pointer}`)),
    [["src/twin/shapes/subscription_item.json#/price/tiers"], ["src/twin/shapes/price.json#/foo", "src/twin/shapes/price.json#/currency_options"], []],
  );
});
