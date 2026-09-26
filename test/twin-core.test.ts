import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { encodeForm } from "../src/bench/run.ts";
import { build } from "../src/twin/build.ts";
import { CATALOG, TwinError, renderError } from "../src/twin/errors.ts";
import { expand } from "../src/twin/expand.ts";
import { parseForm } from "../src/twin/form.ts";
import { list, search } from "../src/twin/list.ts";
import { type Route, createTwin } from "../src/twin/server.ts";

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;

const AUTH = { Authorization: "Bearer sk_test_parity" };

// Fake handlers on real spec operations, so validation runs against the real request schemas.
const FAKE: Route[] = [
  [
    "POST",
    /^\/v1\/customers$/,
    (ctx, { params }) => {
      const tmpl = ctx.build("customer");
      const c = ctx.build("customer", {
        id: ctx.id("cus"),
        created: ctx.now(),
        email: params.email ?? null,
        balance: params.balance ?? 0,
        metadata: params.metadata ?? {},
        invoice_settings: { ...(tmpl.invoice_settings as Obj), ...(params.invoice_settings as Obj) },
      });
      return { body: c, emits: [{ type: "customer.created", object: c }] };
    },
    "post /v1/customers",
  ],
  ["POST", /^\/v1\/customers\/(?<customer>[^/]+)$/, (ctx) => ctx.fail("resource_missing", { param: "id" }), "post /v1/customers/{customer}"],
];

const twin = () => createTwin({ routes: FAKE });
const call = (t: Twin, method: string, path: string, params?: Obj, headers: Obj = {}) => {
  const form = params ? encodeForm(params) : "";
  const post = method === "POST";
  return t.handle({ method, path, query: post ? "" : form, body: post ? form : "", headers: { ...AUTH, ...headers } }) as Promise<{
    status: number;
    headers: Record<string, string>;
    body: Obj;
  }>;
};
const seed = (t: Twin, objects: Obj[]) => t.handle({ method: "POST", path: "/_parity/seed", body: JSON.stringify({ objects }) });
const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TwinError, `expected a TwinError, got ${e}`);
    return { key: e.key, vars: e.vars };
  }
  assert.fail("expected a TwinError");
};

test("parseForm inverts the harness's encodeForm", () => {
  const params = {
    email: "a+b@example.com",
    description: null,
    balance: -12,
    metadata: { plan: "pro", "odd key": "x y&z=[1]" },
    items: [{ price: "price_1", quantity: 2 }, { price: "price_2", tax_rates: ["txr_1", "txr_2"] }],
    address: { line1: "1 Main & Co" },
    expand: ["customer", "data.latest_invoice"],
  };
  // Leaves come back as strings; null is sent as "" (unset).
  const expected = JSON.parse(JSON.stringify(params, (_, v) => (v === null ? "" : typeof v === "number" ? String(v) : v)));
  assert.deepEqual(parseForm(encodeForm(params)), expected);
  assert.deepEqual(parseForm("expand[]=x&expand[]=y"), { expand: ["x", "y"] });
  assert.deepEqual(parseForm("a[b][0][c]=x"), { a: { b: [{ c: "x" }] } });
  assert.deepEqual(parseForm("name=&metadata[k]="), { name: "", metadata: { k: "" } });
  assert.deepEqual(parseForm("0=a"), { 0: "a" });
  assert.deepEqual(parseForm("__proto__[polluted]=1&a=1"), { a: "1" });
  assert.equal(({} as Obj).polluted, undefined);
});

test("build copies the template and lets fields win", () => {
  const a = build("customer", { email: "x@example.com" });
  assert.equal(a.object, "customer");
  assert.equal(a.email, "x@example.com");
  (a.metadata as Obj).k = "v";
  assert.deepEqual(build("customer").metadata, {});
  assert.throws(() => build("nope"), /no template/);
});

test("auth: missing and invalid keys are 401; Bearer and Basic keys pass", async () => {
  const t = twin();
  const missing = await t.handle({ method: "GET", path: "/v1/events" });
  assert.equal(missing.status, 401);
  const { error } = missing.body as Obj;
  assert.deepEqual(Object.keys(error), ["type", "message", "request_log_url"]);
  assert.equal(error.type, "invalid_request_error");
  assert.equal(error.message, "parity: api_key_missing");
  assert.equal(error.request_log_url, `https://dashboard.stripe.com/test/logs/${missing.headers["Request-Id"]}`);

  const live = await call(t, "GET", "/v1/events", undefined, { Authorization: "Bearer sk_live_nope" });
  assert.equal(live.status, 401);
  assert.equal(live.body.error.message, "parity: api_key_invalid");

  const basic = await call(t, "GET", "/v1/events", undefined, { Authorization: `Basic ${Buffer.from("rk_test_x:").toString("base64")}` });
  assert.equal(basic.status, 200);
});

test("unmatched method or path is unrecognized_url (404, no code)", async () => {
  const t = twin();
  for (const [m, p] of [["GET", "/v1/nope"], ["DELETE", "/v1/events"], ["GET", "/_parity/nope"]] as const) {
    const r = await call(t, m, p);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.body.error.message, "parity: unrecognized_url");
    assert.equal(r.body.error.code, undefined);
  }
});

test("unknown parameters are rejected at any depth with bracket names", async () => {
  const t = twin();
  const cases: [string, string, Obj, string][] = [
    ["POST", "/v1/customers", { foo: "1" }, "foo"],
    ["POST", "/v1/customers", { address: { city: "Brno", foo: "x" } }, "address[foo]"],
    ["POST", "/v1/customers", { tax_id_data: [{ type: "eu_vat", value: "x", foo: "y" }] }, "tax_id_data[0][foo]"],
    ["GET", "/v1/events", { created: { gte: 1, foo: 2 } }, "created[foo]"],
  ];
  for (const [m, p, params, param] of cases) {
    const r = await call(t, m, p, params);
    assert.equal(r.status, 400, param);
    assert.deepEqual(r.body.error, {
      type: "invalid_request_error",
      code: "parameter_unknown",
      param,
      message: "parity: parameter_unknown",
      doc_url: "https://stripe.com/docs/error-codes/parameter-unknown",
      request_log_url: `https://dashboard.stripe.com/test/logs/${r.headers["Request-Id"]}`,
    });
  }
  assert.equal(t.store.objects.size, 0);
});

/** The top-level argument texts of the call whose "(" is at `src[open]`. */
function callArgs(src: string, open: number): string[] {
  const out: string[] = [];
  let [depth, start, quote] = [0, open + 1, ""];
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (`"'\``.includes(c)) quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return [...out, src.slice(start, i)];
    else if (c === "," && depth === 1) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  throw new Error(`unbalanced call at ${open}`);
}

test("every catalog key the twin raises renders with the vars its call sites pass", () => {
  // Scans src/twin for fail("key", vars) and TwinError("key", vars): a template placeholder its call site does
  // not fill now throws, so a missing var here would be a 500 at runtime.
  const dir = new URL("../src/twin/", import.meta.url);
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && f !== "errors.ts");
  const rendered = new Set<string>();
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/\b(?:fail|TwinError)\(/g)) {
      const [arg0 = "", vars = "{}"] = callArgs(src, m.index + m[0].length - 1);
      const keys = [...arg0.matchAll(/(?:^|[?:])\s*"(\w+)"/g)].map((k) => k[1]!); // a literal, or both arms of a ternary
      assert.ok(keys.length > 0, `${f}: no literal catalog key in ${m[0]}${arg0}`);
      // The vars: an object literal, or a const holding one (validate.ts passes `param`).
      const obj = /^\s*\{/.test(vars) ? vars : new RegExp(`const ${vars.trim()} = (\\{[^}]*\\})`).exec(src)?.[1];
      assert.ok(obj, `${f}: cannot read the vars of ${m[0]}${arg0}, ${vars})`);
      const names = [...obj.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').matchAll(/[{,]\s*(\w+)/g)].map((n) => n[1]!);
      for (const key of keys) {
        assert.ok(Object.hasOwn(CATALOG, key), `${f}: "${key}" is not in errors.json`);
        const { error } = renderError(new TwinError(key, Object.fromEntries(names.map((n) => [n, "x"]))), "req_1").body;
        assert.doesNotMatch(JSON.stringify(error), /\{\w+\}/, `${f}: ${key}`);
        rendered.add(key);
      }
    }
  }
  // The scan is not vacuous: core, validation and resource keys, the ternary's both arms, and the direct TwinError.
  for (const k of ["parameter_unknown", "parameter_invalid", "expand_invalid", "resource_missing_400", "payment_method_unattachable", "card_declined", "api_error"])
    assert.ok(rendered.has(k), k);
});

test("renderError: doc_url hyphenates the code; an unfilled placeholder is a bug, not text", async (t) => {
  const e = renderError(new TwinError("parameter_invalid_integer", { param: "limit" }), "req_1").body.error;
  assert.equal(e.doc_url, "https://stripe.com/docs/error-codes/parameter-invalid-integer");
  assert.equal(renderError(new TwinError("card_declined"), "req_1").body.error.doc_url, "https://stripe.com/docs/error-codes/card-declined");
  assert.throws(() => renderError(new TwinError("resource_missing"), "req_1"), /errors.json "resource_missing": no value for \{param\}/);

  // Through the server it is a logged 500, like any other handler bug.
  const logged = t.mock.method(console, "error", () => {});
  const tw = createTwin({ routes: [["GET", /^\/v1\/events$/, (ctx) => ctx.fail("resource_missing"), "get /v1/events"]] });
  const r = await call(tw, "GET", "/v1/events");
  assert.equal(r.status, 500);
  assert.equal(r.body.error.type, "api_error");
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /no value for \{param\}/);
});

test("form strings are coerced to the schema's types; bad integers, enums and booleans are 400", async () => {
  const t = twin();
  const ok = await call(t, "POST", "/v1/customers", { balance: -12, metadata: { 0: "zero" }, expand: [] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.balance, -12);
  assert.deepEqual(ok.body.metadata, { 0: "zero" });

  const bad = async (m: string, p: string, params: Obj) => (await call(t, m, p, params)).body.error;
  assert.deepEqual(
    [await bad("POST", "/v1/customers", { balance: "abc" }), await bad("GET", "/v1/events", { limit: "1.5" }), await bad("GET", "/v1/events", { created: "soon" })].map(
      (e) => [e.code, e.param],
    ),
    [
      ["parameter_invalid_integer", "balance"],
      ["parameter_invalid_integer", "limit"],
      ["parameter_invalid_integer", "created"],
    ],
  );
  const e = await bad("POST", "/v1/customers", { tax_exempt: "sometimes" });
  assert.deepEqual([e.code, e.param, e.message], [undefined, "tax_exempt", "parity: parameter_invalid_enum"]);
  const b = await bad("GET", "/v1/events", { delivery_success: "maybe" });
  assert.deepEqual([b.code, b.param, b.message], [undefined, "delivery_success", "parity: parameter_invalid"]);
});

test("idempotency: replay, mismatch, replayed errors, validation errors not stored, 24 h expiry", async () => {
  const t = twin();
  const K = { "Idempotency-Key": "k1" };
  const first = await call(t, "POST", "/v1/customers", { email: "a@example.com" }, K);
  assert.equal(first.status, 200);
  assert.equal(first.headers["Idempotent-Replayed"], undefined);
  const replay = await call(t, "POST", "/v1/customers", { email: "a@example.com" }, K);
  assert.equal(replay.headers["Idempotent-Replayed"], "true");
  assert.deepEqual(replay.body, first.body);
  const O = { "Idempotency-Key": "k-order" };
  const ab = await call(t, "POST", "/v1/customers", { email: "o@example.com", metadata: { a: "1", b: "2" } }, O);
  const ba = await call(t, "POST", "/v1/customers", { metadata: { b: "2", a: "1" }, email: "o@example.com" }, O);
  assert.equal(ba.headers["Idempotent-Replayed"], "true", "param order does not matter");
  assert.equal(ba.body.id, ab.body.id);
  assert.equal(t.store.objects.size, 2);
  assert.equal(t.store.events.length, 2);

  const mismatch = await call(t, "POST", "/v1/customers", { email: "b@example.com" }, K);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.type, "idempotency_error");
  assert.equal(mismatch.body.error.code, undefined);

  // A handler error is stored and replayed as is.
  const E = { "Idempotency-Key": "k2" };
  const err = await call(t, "POST", "/v1/customers/cus_missing", { email: "x@example.com" }, E);
  assert.equal(err.status, 404);
  assert.equal(err.body.error.code, "resource_missing");
  const errReplay = await call(t, "POST", "/v1/customers/cus_missing", { email: "x@example.com" }, E);
  assert.equal(errReplay.headers["Idempotent-Replayed"], "true");
  assert.equal(errReplay.status, 404);
  assert.deepEqual(errReplay.body, err.body);

  // A validation error is not stored: the key is still free.
  const V = { "Idempotency-Key": "k3" };
  assert.equal((await call(t, "POST", "/v1/customers", { foo: "1" }, V)).status, 400);
  const fresh = await call(t, "POST", "/v1/customers", { email: "c@example.com" }, V);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers["Idempotent-Replayed"], undefined);

  // Keys expire after 24 h of the twin's clock.
  const T = { "Idempotency-Key": "k4" };
  const t0 = await call(t, "POST", "/v1/customers", {}, { ...T, "Parity-Now": "1700000000" });
  const t1 = await call(t, "POST", "/v1/customers", {}, { ...T, "Parity-Now": String(1700000000 + 86399) });
  const t2 = await call(t, "POST", "/v1/customers", {}, { ...T, "Parity-Now": String(1700000000 + 86400) });
  assert.equal(t1.body.id, t0.body.id);
  assert.notEqual(t2.body.id, t0.body.id);
  assert.equal(t2.headers["Idempotent-Replayed"], undefined);
});

test("list: newest first, same-second ties newest-inserted first, cursors, limit, created filter", () => {
  const items = [100, 100, 101, 102, 103].map((created, i) => ({ id: `c${i + 1}`, created }));
  const ids = (params: Obj) => {
    const r = list(items, params, "/v1/things");
    return [r.data.map((o) => o.id).join(","), r.has_more];
  };
  assert.deepEqual(ids({}), ["c5,c4,c3,c2,c1", false]);
  assert.deepEqual(ids({ limit: 2 }), ["c5,c4", true]);
  assert.deepEqual(ids({ limit: 2, starting_after: "c4" }), ["c3,c2", true]);
  assert.deepEqual(ids({ limit: 2, starting_after: "c2" }), ["c1", false]);
  assert.deepEqual(ids({ limit: 2, ending_before: "c1" }), ["c3,c2", true]);
  assert.deepEqual(ids({ limit: 2, ending_before: "c4" }), ["c5", false]);
  assert.deepEqual(ids({ created: { gte: 101 } }), ["c5,c4,c3", false]);
  assert.deepEqual(ids({ created: { gt: 100, lt: 103 } }), ["c4,c3", false]);
  assert.deepEqual(ids({ created: 100 }), ["c2,c1", false]);
  assert.deepEqual(list(items, {}, "/v1/things").url, "/v1/things");
  assert.equal(list(items, {}, "/v1/things").object, "list");
  for (const limit of [0, 101]) assert.deepEqual(errorOf(() => list(items, { limit }, "/x")), { key: "list_limit_invalid", vars: {} });
  assert.deepEqual(errorOf(() => list(items, { starting_after: "nope" }, "/x")), { key: "resource_missing", vars: { param: "starting_after" } });
  assert.deepEqual(errorOf(() => list(items, { ending_before: "nope" }, "/x")), { key: "resource_missing", vars: { param: "ending_before" } });
});

test("list limit errors render as 400 parameter_invalid_integer on limit", async () => {
  const r = await call(twin(), "GET", "/v1/events", { limit: 101 });
  assert.equal(r.status, 400);
  assert.deepEqual([r.body.error.code, r.body.error.param], ["parameter_invalid_integer", "limit"]);
});

test("search: field and metadata clauses joined by AND", () => {
  const items = [
    { id: "a", created: 1, email: "x@example.com", metadata: { tier: "gold" } },
    { id: "b", created: 2, email: "x@example.com", metadata: { tier: "free" } },
    { id: "c", created: 3, email: "y@example.com", metadata: {} },
  ];
  const ids = (q: string) => search(items, q, "/v1/customers/search").data.map((o) => o.id);
  assert.deepEqual(ids("email:'x@example.com'"), ["b", "a"]);
  assert.deepEqual(ids(`email:'x@example.com' AND metadata['tier']:'gold'`), ["a"]);
  assert.deepEqual(ids(`metadata["tier"]:"free"`), ["b"]);
  assert.deepEqual(ids("email:'nobody@example.com'"), []);
  assert.deepEqual(search(items, "email:'x@example.com'", "/v1/customers/search", 1), {
    object: "search_result",
    data: [items[1]],
    has_more: true,
    next_page: null,
    url: "/v1/customers/search",
  });
  for (const q of ["email=x", "email:x", "", "email:'x' OR name:'y'"]) assert.equal(errorOf(() => search(items, q, "/x")).key, "search_query_invalid", q);

  // 'null' is a literal string: it never matches a null or absent field, only a field holding "null".
  const nulls = [
    { id: "n", created: 1, email: null, metadata: { tier: "null" } },
    { id: "s", created: 2, email: "null", metadata: {} },
  ];
  const hits = (q: string) => search(nulls, q, "/x").data.map((o) => o.id);
  assert.deepEqual(hits("email:'null'"), ["s"]);
  assert.deepEqual(hits("metadata['tier']:'null'"), ["n"]);
  assert.deepEqual(hits("phone:'undefined'"), []);
  assert.deepEqual(hits("metadata['nope']:'undefined'"), []);
});

test("expand: single path, list data. path, nested, too deep, invalid", () => {
  const pm = { id: "pm_1A2b3C4d5E6f7G8h", object: "payment_method" };
  const cus = { id: "cus_1A2b3C4d5E6f7G", object: "customer", email: "a@example.com", created: 1, default_payment_method: pm.id, owner: null };
  const store = new Map<string, Obj>([
    [pm.id, pm],
    [cus.id, cus],
  ]);
  const get = (id: string) => store.get(id);

  const one = expand(cus, ["default_payment_method"], get) as Obj;
  assert.deepEqual(one.default_payment_method, pm);
  assert.equal(cus.default_payment_method, pm.id, "the input body is not mutated");

  const page = { object: "list", data: [{ customer: cus.id }, { customer: null }] };
  const out = expand(page, ["data.customer.default_payment_method"], get) as Obj;
  assert.deepEqual(out.data[0].customer, { ...cus, default_payment_method: pm });
  assert.equal(out.data[1].customer, null);

  assert.equal(errorOf(() => expand(page, ["data.customer.a.b.c"], get)).key, "expand_too_deep");
  for (const p of ["email", "created", "nope"]) assert.equal(errorOf(() => expand(cus, [p], get)).key, "expand_invalid", p);
  assert.equal(errorOf(() => expand(page, ["customer"], get)).key, "expand_invalid", "list paths start with data.");

  // Only a string that resolves to a stored object expands: never `id`, an unknown id, or a nested hash.
  const withHash = { ...cus, invoice_settings: { default_payment_method: pm.id }, latest_invoice: "in_1A2b3C4d5E6f7G8h9I0j1K2l" };
  for (const p of ["id", "latest_invoice", "invoice_settings", "data"]) assert.equal(errorOf(() => expand(withHash, [p], get)).key, "expand_invalid", p);
  assert.deepEqual((expand(withHash, ["invoice_settings.default_payment_method"], get) as Obj).invoice_settings.default_payment_method, pm);
  // A list of ids (`discounts`) expands each element; `[]` stays `[]`; one unknown id fails the path.
  assert.deepEqual((expand({ ...cus, discounts: [] }, ["discounts"], get) as Obj).discounts, []);
  assert.deepEqual((expand({ ...cus, discounts: [pm.id, cus.id] }, ["discounts"], get) as Obj).discounts, [pm, cus]);
  assert.equal(errorOf(() => expand({ ...cus, discounts: [pm.id, "di_1A2b3C4d5E6f7G8h"] }, ["discounts"], get)).key, "expand_invalid");
  // A path given twice, or a prefix of another path in either order, expands once.
  assert.deepEqual(expand(cus, ["default_payment_method", "default_payment_method"], get), one);
  assert.deepEqual(expand(page, ["data.customer.default_payment_method", "data.customer"], get), out);
});

test("expand through the server resolves nested ids and an invalid path leaves no state", async () => {
  const t = twin();
  const pm = build("payment_method", { id: "pm_1A2b3C4d5E6f7G8h9I0j1K2l" });
  await seed(t, [pm]);
  const r = await call(t, "POST", "/v1/customers", {
    invoice_settings: { default_payment_method: pm.id },
    expand: ["invoice_settings.default_payment_method"],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.invoice_settings.default_payment_method, pm);
  assert.equal((t.store.objects.get(r.body.id as string)!.invoice_settings as Obj).default_payment_method, pm.id, "stored unexpanded");
  assert.equal((t.store.events[0]!.data.object.invoice_settings as Obj).default_payment_method, pm.id);

  const bad = await call(t, "POST", "/v1/customers", { email: "a@example.com", expand: ["email"] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.message, "parity: expand_invalid");
  assert.equal(t.store.objects.size, 2);
  assert.equal(t.store.events.length, 1);
});

test("Parity-Now sets created on objects and events; ids have the real API's shape", async () => {
  const t = twin();
  const r = await call(t, "POST", "/v1/customers", {}, { "Parity-Now": "1700000000" });
  assert.equal(r.body.created, 1700000000);
  assert.equal(t.store.events[0]!.created, 1700000000);
  assert.match(r.body.id, /^cus_[0-9A-Za-z]{14}$/);
  assert.match(t.store.events[0]!.id, /^evt_[0-9A-Za-z]{24}$/);
  assert.match(r.headers["Request-Id"]!, /^req_[0-9A-Za-z]{24}$/);

  const before = Math.floor(Date.now() / 1000);
  const wall = await call(t, "POST", "/v1/customers", {});
  assert.ok(wall.body.created >= before && wall.body.created <= Math.floor(Date.now() / 1000));
});

test("events: list after a seed and emitting requests, filters, retrieve, state", async () => {
  const t = twin();
  const endpoint = (id: string, status: string, enabled_events: string[]) => build("webhook_endpoint", { id, status, enabled_events });
  await seed(t, [
    endpoint("we_1A2b3C4d5E6f7G8h9I0j1K2l", "enabled", ["customer.created"]),
    endpoint("we_2A2b3C4d5E6f7G8h9I0j1K2l", "enabled", ["*"]),
    endpoint("we_3A2b3C4d5E6f7G8h9I0j1K2l", "disabled", ["*"]),
    endpoint("we_4A2b3C4d5E6f7G8h9I0j1K2l", "enabled", ["invoice.paid"]),
  ]);
  assert.equal((await call(t, "GET", "/v1/events")).body.data.length, 0, "seeding emits no events");

  const now = { "Parity-Now": "1700000000" };
  const c1 = await call(t, "POST", "/v1/customers", { email: "a@example.com" }, now);
  const c2 = await call(t, "POST", "/v1/customers", { email: "b@example.com" }, { ...now, "Idempotency-Key": "k-events" });

  const page = await call(t, "GET", "/v1/events");
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.object, page.body.url, page.body.has_more], ["list", "/v1/events", false]);
  const [e2, e1] = page.body.data;
  assert.deepEqual([e2.data.object.id, e1.data.object.id], [c2.body.id, c1.body.id], "same second: newest first");
  assert.deepEqual(e1, {
    ...build("event"),
    id: e1.id,
    api_version: "2026-08-26.dahlia",
    created: 1700000000,
    data: { object: c1.body },
    livemode: false,
    object: "event",
    pending_webhooks: 2,
    request: { id: c1.headers["Request-Id"], idempotency_key: null },
    type: "customer.created",
  });
  assert.deepEqual(e2.request, { id: c2.headers["Request-Id"], idempotency_key: "k-events" });

  const count = async (params: Obj) => (await call(t, "GET", "/v1/events", params)).body.data.length;
  assert.equal(await count({ type: "customer.*" }), 2);
  assert.equal(await count({ type: "customer.created" }), 2);
  assert.equal(await count({ type: "customer" }), 0);
  assert.equal(await count({ type: "product.*" }), 0);
  assert.equal(await count({ types: ["invoice.paid", "customer.created"] }), 2);
  assert.equal(await count({ types: ["invoice.paid"] }), 0);
  assert.equal(await count({ created: { gt: 1700000000 } }), 0);
  assert.equal(await count({ limit: 1, starting_after: e2.id }), 1);

  const one = await call(t, "GET", `/v1/events/${e1.id}`);
  assert.deepEqual(one.body, e1);
  for (const id of ["evt_missing", c1.body.id]) {
    const miss = await call(t, "GET", `/v1/events/${id}`);
    assert.equal(miss.status, 404);
    assert.deepEqual([miss.body.error.code, miss.body.error.param], ["resource_missing", "id"]);
  }

  const state = (await t.handle({ method: "GET", path: "/_parity/state" })).body as Obj;
  assert.deepEqual([state.objects.length, state.deleted.length, state.events], [6, 0, 2]);
});

test("reset clears 1,000 objects in under 50 ms", async () => {
  const t = twin();
  const objects = Array.from({ length: 1000 }, (_, i) => build("customer", { id: `cus_${String(i).padStart(14, "0")}`, created: i }));
  await seed(t, objects);
  await call(t, "POST", "/v1/customers", {}, { "Idempotency-Key": "k" });
  const t0 = performance.now();
  const r = await t.handle({ method: "POST", path: "/_parity/reset" });
  const ms = performance.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(ms < 50, `reset took ${ms} ms`);
  assert.deepEqual((await t.handle({ method: "GET", path: "/_parity/state" })).body, { objects: [], deleted: [], events: 0 });
  assert.equal(t.store.idem.size, 0);
});

test("seed rejects objects without ids", async () => {
  const r = await seed(twin(), [{ object: "customer" }]);
  assert.equal(r.status, 400);
});

test("listen serves the pipeline over HTTP with the API headers", async () => {
  const server = await twin().listen(0);
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(`${base}/v1/customers`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeForm({ email: "http@example.com", metadata: { k: "v" } }),
    });
    assert.equal(created.status, 200);
    assert.match(created.headers.get("request-id")!, /^req_/);
    assert.equal(created.headers.get("stripe-version"), "2026-08-26.dahlia");
    assert.equal(created.headers.get("content-type"), "application/json");
    const body = (await created.json()) as Obj;
    assert.deepEqual([body.email, body.metadata], ["http@example.com", { k: "v" }]);

    const res = await fetch(`${base}/v1/events?${encodeForm({ limit: 1, types: ["customer.created"] })}`, {
      headers: { ...AUTH, "Stripe-Version": "2020-08-27" },
    });
    assert.equal(res.headers.get("stripe-version"), "2020-08-27", "echoed; behavior stays dahlia");
    const events = (await res.json()) as Obj;
    assert.deepEqual([events.data.length, events.data[0].data.object.id], [1, body.id]);
  } finally {
    server.close();
  }
});
