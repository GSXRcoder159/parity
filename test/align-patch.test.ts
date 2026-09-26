import { test } from "node:test";
import assert from "node:assert/strict";
import { propose, type Catalog } from "../src/align/patch.ts";
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
const data = { shape: (t: string) => t === "customer", catalog };

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

test("placeholders are never seeded: ids, times, run nonces and opaques in a field or a message are computed", () => {
  const oracle = [1, 2].map((n) =>
    rec(`a#${n}`, false, [
      st(0, 200, customer({ default_source: "<id:card>", period: { end: "<t:+720h>" }, invoice_prefix: "<opaque>" })),
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
    ...seqs.map((s) => div(s, 1, "$.error.message", "VALUE_MISMATCH", error("idempotency_mismatch", "message"))),
    ...seqs.map((s) => div(s, 2, "$.error.message", "VALUE_MISMATCH", error("resource_missing", "message"))),
  ];
  const { candidates, notMechanical } = propose(divergences, oracle, twin, new Set(), data);
  assert.deepEqual(candidates, []);
  assert.deepEqual(notMechanical.map((n) => n.reason), [
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
  // The declined message quotes no request value (short and boolean leaves never count); the address is API semantics.
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
    "one binding: every occurrence renders the same {param}, so the message is shown for one use of the key only",
    "context text: only enum-like tokens are type defaults", // prose
    "context text: only enum-like tokens are type defaults", // an uppercase code inside a seeded parent
  ]);
});
