// Behavior modules A (customers, products, prices, payment methods): the real templates #1–#4, #11, #12 run
// in-process, checked against the sandbox observations in docs/plan/impl/templates-validation.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCorpus } from "../src/bench/corpus.ts";
import { encodeForm, resolveRefs } from "../src/bench/run.ts";
import { createTwin } from "../src/twin/server.ts";
import { TEMPLATES } from "../templates/index.ts";

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;
type Res = { status: number; body: Obj };

const CORPUS = buildCorpus(TEMPLATES, [1, 2]);
const SEEDS = [1, 2];

const call = (t: Twin, method: string, path: string, params?: Obj, headers: Obj = {}) => {
  const form = params ? encodeForm(params) : "";
  const post = method === "POST";
  const req = { method, path, query: post ? "" : form, body: post ? form : "", headers: { Authorization: "Bearer sk_test_parity", ...headers } };
  return t.handle(req) as Promise<Res>;
};

/** Runs one template sequence the way the harness does: refs resolve from earlier response bodies. */
async function run(id: string) {
  const seq = CORPUS.find((s) => s.id === id) ?? assert.fail(`no sequence ${id}`);
  const twin = createTwin();
  const bound: Obj = {};
  const steps: (Res & { method: string; path: string })[] = [];
  for (const s of seq.steps) {
    const path = String(resolveRefs(s.path, bound, "nonce"));
    // A pinned clock keeps same-second assumptions (list order, product `updated`) from flaking.
    const headers = { "Parity-Now": "1790379195", ...(s.headers && (resolveRefs(s.headers, bound, "nonce") as Obj)) };
    const r = await call(twin, s.method, path, s.params && (resolveRefs(s.params, bound, "nonce") as Obj), headers);
    if (s.ref) bound[s.ref] = r.body;
    steps.push({ ...r, method: s.method, path });
  }
  const events = twin.store.events;
  return { twin, bound, steps, events, types: events.map((e) => e.type).sort() };
}

/** A status cell as the validation notes write it: `status`, or `status code` (`status type` without a code). */
const cell = (r: Res) => (r.body.error ? `${r.status} ${r.body.error.code ?? r.body.error.type}` : String(r.status));

for (const seed of SEEDS) {
  test(`#1 customer-crud#${seed}: CRUD, tombstone, update of a deleted customer`, async () => {
    const { steps, events, types } = await run(`customer-crud#${seed}`);
    assert.deepEqual(steps.map(cell), ["200", "200", "200", "200", "200", "400 resource_missing"]);
    assert.deepEqual(types, ["customer.created", "customer.deleted", "customer.updated"]);
    const [created, , , deleted, tombstone, ghost] = steps;
    assert.deepEqual(deleted!.body, { deleted: true, id: created!.body.id, object: "customer" });
    assert.deepEqual(tombstone!.body, deleted!.body);
    assert.equal(ghost!.body.error.param, "id");
    const updated = events.find((e) => e.type === "customer.updated")!;
    assert.deepEqual(updated.data.previous_attributes, { metadata: { tier: null }, name: created!.body.name });
    // The deleted event carries the full last customer, not the tombstone.
    const del = events.find((e) => e.type === "customer.deleted")!;
    assert.equal(del.data.object.deleted, undefined);
    assert.equal(del.data.object.name, `${created!.body.name} renamed`);
  });

  test(`#2 customer-list-pagination#${seed}: email + created[gte] pages of 2 via starting_after`, async () => {
    const { steps, types } = await run(`customer-list-pagination#${seed}`);
    assert.ok(steps.every((s) => s.status === 200));
    const created = steps.filter((s) => s.method === "POST").map((s) => s.body.id);
    const pages = steps.filter((s) => s.method === "GET").map((s) => s.body);
    // Same-second creates list newest first (reverse insertion), so the pages walk the creates backwards.
    assert.deepEqual(pages.flatMap((p) => p.data.map((c: Obj) => c.id)), created.reverse());
    assert.deepEqual(pages.map((p) => p.has_more), pages.map((_, i) => i < pages.length - 1));
    assert.ok(pages.every((p) => p.object === "list" && p.url === "/v1/customers"));
    assert.deepEqual(types, created.map(() => "customer.created"));
  });

  test(`#3 product-price-crud#${seed}: product, recurring price, deactivate, list, product update`, async () => {
    const { steps, events, types, bound } = await run(`product-price-crud#${seed}`);
    assert.deepEqual(steps.map(cell), ["200", "200", "200", "200", "200", "200"]);
    assert.deepEqual(types, ["plan.created", "plan.updated", "price.created", "price.updated", "product.created", "product.updated"]);
    const [, price, retrieved, deactivated, listed, product] = steps;
    assert.equal(price!.body.type, "recurring");
    assert.equal(price!.body.recurring.interval_count, 1);
    assert.equal(price!.body.unit_amount_decimal, String(price!.body.unit_amount));
    assert.deepEqual(retrieved!.body, price!.body); // the plan event did not overwrite the stored price
    assert.equal(deactivated!.body.active, false);
    assert.deepEqual(listed!.body.data.map((p: Obj) => p.id), [price!.body.id]);
    assert.equal(product!.body.name, `${bound.p1.name} v2`);
    assert.match(product!.body.description, /^Revision \d$/);
    const prev = { active: true, metadata: { retired: null } };
    assert.deepEqual(events.find((e) => e.type === "price.updated")!.data.previous_attributes, prev);
    assert.deepEqual(events.find((e) => e.type === "plan.updated")!.data.previous_attributes, prev);
    const plan = events.find((e) => e.type === "plan.created")!.data.object;
    assert.equal(plan.object, "plan");
    assert.equal(plan.id, price!.body.id);
    assert.equal(plan.amount, price!.body.unit_amount);
    assert.equal(plan.interval, price!.body.recurring.interval);
    const productPrev = events.find((e) => e.type === "product.updated")!.data.previous_attributes;
    assert.deepEqual(productPrev, { description: null, name: bound.p1.name });
  });

  test(`#4 payment-method-attach#${seed}: attach, default, second card, detach the default`, async () => {
    const { steps, events, types, twin, bound } = await run(`payment-method-attach#${seed}`);
    assert.deepEqual(steps.map(cell), ["200", "200", "200", "200", "200", "200", "200"]);
    assert.deepEqual(types, ["customer.created", "customer.updated", "customer.updated", "payment_method.attached", "payment_method.attached", "payment_method.detached"]);
    const [, pm1, list1, , pm2, detached, list2] = steps;
    assert.equal(pm1!.body.customer, bound.c1.id);
    assert.equal(pm1!.body.type, "card");
    assert.ok(["4242", "4444"].includes(pm1!.body.card.last4));
    assert.deepEqual(list1!.body.data.map((p: Obj) => p.id), [pm1!.body.id]);
    assert.equal(detached!.body.customer, null);
    assert.deepEqual(list2!.body.data.map((p: Obj) => p.id), [pm2!.body.id]);
    const [setDefault, clearDefault] = events.filter((e) => e.type === "customer.updated");
    assert.deepEqual(setDefault!.data.previous_attributes, { invoice_settings: { default_payment_method: null } });
    assert.deepEqual(clearDefault!.data.previous_attributes, { invoice_settings: { default_payment_method: pm1!.body.id } });
    assert.deepEqual(events.find((e) => e.type === "payment_method.detached")!.data.previous_attributes, { customer: bound.c1.id });
    const customer = (await call(twin, "GET", `/v1/customers/${bound.c1.id}`)).body;
    assert.equal(customer.invoice_settings.default_payment_method, null);
  });

  test(`#11 resource-missing#${seed}: customer and price steps`, async () => {
    const { steps, types } = await run(`resource-missing#${seed}`);
    const mine = steps.filter((s) => /^\/v1\/(customers|prices)\//.test(s.path));
    assert.equal(mine.length, 5);
    assert.deepEqual(mine.map(cell), mine.map(() => "404 resource_missing"));
    assert.deepEqual(mine.map((s) => s.body.error.param), ["id", "id", "id", "price", "price"]);
    assert.deepEqual(types, []);
  });

  test(`#12 invalid-params#${seed}: customer and price steps`, async () => {
    const { steps, types, bound } = await run(`invalid-params#${seed}`);
    const [ok, unknown, noCurrency, badInterval, , negative] = steps;
    assert.deepEqual([ok, unknown, noCurrency, badInterval, negative].map((s) => cell(s!)), [
      "200",
      "400 parameter_unknown",
      "400 parameter_missing",
      "400 invalid_request_error",
      "400 invalid_request_error",
    ]);
    assert.ok(["nickname", "colour", "loyalty_tier"].includes(unknown!.body.error.param));
    assert.equal(noCurrency!.body.error.param, "currency");
    assert.equal(badInterval!.body.error.param, "recurring[interval]");
    assert.equal(negative!.body.error.param, "unit_amount");
    assert.deepEqual(types, ["customer.created"]); // failed price creates leave no product behind
    assert.equal(bound.c1.object, "customer");
  });
}

// The subscription and invoice steps of #11/#12 run in test/twin-resources-b.test.ts.

test("attaching a token that declines on verification is a 402 card error and stores nothing", async () => {
  const t = createTwin();
  const c = (await call(t, "POST", "/v1/customers", { email: "a@example.com" })).body;
  for (const [token, decline_code] of [
    ["pm_card_chargeDeclined", "generic_decline"],
    ["pm_card_visa_chargeDeclinedInsufficientFunds", "insufficient_funds"],
  ]) {
    const r = await call(t, "POST", `/v1/payment_methods/${token}/attach`, { customer: c.id });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.type, "card_error");
    assert.equal(r.body.error.code, "card_declined");
    assert.equal(r.body.error.decline_code, decline_code);
  }
  // chargeCustomerFail attaches; it only fails when charged.
  const ok = await call(t, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: c.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.card.last4, "0341");
  assert.deepEqual(t.store.events.map((e) => e.type), ["customer.created", "payment_method.attached"]);
  const bogus = await call(t, "POST", "/v1/payment_methods/pm_card_bogus/attach", { customer: c.id });
  assert.equal(cell(bogus), "404 resource_missing");
  const noCustomer = await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: "cus_Missing12345678" });
  assert.equal(cell(noCustomer), "400 resource_missing");
  assert.equal(noCustomer.body.error.param, "customer");
});

test("every attachable test card's display_brand is in the spec's display_brand enum", async () => {
  const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
  const desc: string = json("../src/twin/spec/openapi.pruned.json").components.schemas.payment_method_card.properties.display_brand.description;
  const allowed = [...desc.matchAll(/`(\w+)`/g)].map((m) => m[1]);
  const t = createTwin();
  const c = (await call(t, "POST", "/v1/customers")).body;
  for (const [token, card] of Object.entries(json("../src/twin/cards.json") as Obj)) {
    if (card.behavior === "attach_declined") continue;
    const pm = (await call(t, "POST", `/v1/payment_methods/${token}/attach`, { customer: c.id })).body;
    assert.ok(allowed.includes(pm.card.display_brand), `${token}: ${card.brand} -> ${pm.card.display_brand}`);
  }
});

test("default_payment_method must be attached to the customer", async () => {
  const t = createTwin();
  const [a, b] = [(await call(t, "POST", "/v1/customers")).body, (await call(t, "POST", "/v1/customers")).body];
  const pmB = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: b.id })).body;
  const param = "invoice_settings[default_payment_method]";
  const foreign = await call(t, "POST", `/v1/customers/${a.id}`, { invoice_settings: { default_payment_method: pmB.id } });
  assert.deepEqual([foreign.status, foreign.body.error.code, foreign.body.error.param], [400, "resource_missing", param]);
  const missing = await call(t, "POST", `/v1/customers/${a.id}`, { invoice_settings: { default_payment_method: "pm_Missing1234567890" } });
  assert.deepEqual([missing.status, missing.body.error.code, missing.body.error.param], [400, "resource_missing", param]);
  const onCreate = await call(t, "POST", "/v1/customers", { invoice_settings: { default_payment_method: pmB.id } });
  assert.equal(onCreate.status, 400);
  const own = await call(t, "POST", `/v1/customers/${b.id}`, { invoice_settings: { default_payment_method: pmB.id } });
  assert.equal(own.body.invoice_settings.default_payment_method, pmB.id);
  // A no-op update emits nothing.
  await call(t, "POST", `/v1/customers/${b.id}`, { invoice_settings: { default_payment_method: pmB.id } });
  assert.equal(t.store.events.filter((e) => e.type === "customer.updated").length, 1);
});

test("customers: search, delete twice, payment method sub-list with type", async () => {
  const t = createTwin();
  const c = (await call(t, "POST", "/v1/customers", { email: "x@example.com", metadata: { k: "v" } })).body;
  await call(t, "POST", "/v1/customers", { email: "y@example.com" });
  const found = await call(t, "GET", "/v1/customers/search", { query: "email:'x@example.com' AND metadata['k']:'v'" });
  assert.equal(found.body.object, "search_result");
  assert.deepEqual(found.body.data.map((x: Obj) => x.id), [c.id]);
  const pm = (await call(t, "POST", "/v1/payment_methods/pm_card_amex/attach", { customer: c.id })).body;
  const sub = await call(t, "GET", `/v1/customers/${c.id}/payment_methods`, { type: "card" });
  assert.deepEqual(sub.body.data.map((x: Obj) => x.id), [pm.id]);
  assert.equal(sub.body.url, `/v1/customers/${c.id}/payment_methods`);
  assert.deepEqual((await call(t, "GET", `/v1/customers/${c.id}/payment_methods`, { type: "sepa_debit" })).body.data, []);
  assert.equal((await call(t, "DELETE", `/v1/customers/${c.id}`)).status, 200);
  assert.equal(cell(await call(t, "DELETE", `/v1/customers/${c.id}`)), "404 resource_missing");
  assert.deepEqual((await call(t, "GET", "/v1/customers")).body.data.map((x: Obj) => x.email), ["y@example.com"]);
  assert.equal(cell(await call(t, "POST", `/v1/payment_methods/${pm.id}/attach`, { customer: c.id })), "400 resource_missing"); // customer gone
});

test("prices: product_data, one-time prices, list filters; products: updated moves with the clock", async () => {
  const t = createTwin();
  const at = (s: number) => ({ "Parity-Now": String(s) });
  const inline = await call(t, "POST", "/v1/prices", { currency: "EUR", unit_amount: 0, product_data: { name: "Inline" } }, at(1000));
  assert.equal(inline.status, 200);
  assert.equal(inline.body.currency, "eur");
  assert.equal(inline.body.type, "one_time");
  assert.equal(inline.body.recurring, null);
  assert.deepEqual(t.store.events.map((e) => e.type), ["product.created", "price.created"]); // no plan.* for one-time
  const product = (await call(t, "GET", `/v1/products/${inline.body.product}`)).body;
  assert.deepEqual([product.name, product.active, product.created], ["Inline", true, 1000]);
  const monthly = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 500, recurring: { interval: "month" }, product: product.id })).body;
  const byType = await call(t, "GET", "/v1/prices", { product: product.id, type: "recurring", active: true, currency: "usd" });
  assert.deepEqual(byType.body.data.map((p: Obj) => p.id), [monthly.id]);
  assert.deepEqual((await call(t, "GET", "/v1/prices", { active: false })).body.data, []);
  assert.equal(cell(await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 1 })), "400 parameter_missing");
  assert.equal(cell(await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 1, product: "prod_Missing123456" })), "400 resource_missing");

  const upd = await call(t, "POST", `/v1/products/${product.id}`, { name: "Renamed", active: false }, at(2000));
  assert.equal(upd.body.updated, 2000);
  const evt = t.store.events.at(-1)!;
  assert.equal(evt.type, "product.updated");
  assert.deepEqual(evt.data.previous_attributes, { active: true, name: "Inline", updated: 1000 });
  assert.deepEqual((await call(t, "GET", "/v1/products", { active: false })).body.data.map((p: Obj) => p.id), [product.id]);
  assert.equal(cell(await call(t, "GET", "/v1/products/prod_Missing123456")), "404 resource_missing");
});
