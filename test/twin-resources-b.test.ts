// Behavior modules B (subscriptions, invoices, payment intents, charges, refunds): the real templates #5–#10,
// #13–#15 (plus the subscription/invoice steps of #11/#12) run in-process, checked against the sandbox
// observations in docs/plan/impl/templates-validation.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpus } from "../src/bench/corpus.ts";
import { encodeForm, resolveRefs } from "../src/bench/run.ts";
import { addInterval } from "../src/twin/billing.ts";
import { CATALOG } from "../src/twin/errors.ts";
import { createTwin } from "../src/twin/server.ts";
import { TEMPLATES } from "../templates/index.ts";

/** The catalog's current message for `key`: messages are the align loop's to seed (decision 0002 §4.3), so tests never pin the placeholder. */
const msg = (key: string): string => CATALOG[key]!.message;

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;
type Res = { status: number; body: Obj; headers: Record<string, string> };

// Seed 3 is the card-declined template's error_if_incomplete branch (seeds 1 and 2 take the default one).
const CORPUS = buildCorpus(TEMPLATES, [1, 2, 3]);
const NOW = 1790379195;

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
    const headers = { "Parity-Now": String(NOW), ...(s.headers && (resolveRefs(s.headers, bound, "nonce") as Obj)) };
    const r = await call(twin, s.method, path, s.params && (resolveRefs(s.params, bound, "nonce") as Obj), headers);
    if (s.ref) bound[s.ref] = r.body;
    steps.push({ ...r, method: s.method, path });
  }
  const events = twin.store.events;
  return { twin, bound, steps, events, types: events.map((e) => e.type).sort() };
}

/** A status cell as the validation notes write it: `status`, or `status code` (`status type` without a code). */
const cell = (r: Res) => (r.body.error ? `${r.status} ${r.body.error.code ?? r.body.error.type}` : String(r.status));
const ok = (n: number) => Array<string>(n).fill("200");

// Event sets from the validation notes. The subscribed() prefix and a successful first payment:
const PREFIX = ["customer.created", "payment_method.attached", "plan.created", "price.created", "product.created"];
const PAID = ["charge.succeeded", "customer.subscription.created", "invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded", "payment_intent.created", "payment_intent.succeeded"];
/** Whether the prefix set the default payment method on the customer (vs on the subscription). */
const onCustomer = (steps: { method: string; path: string }[]) => steps.some((s) => s.method === "POST" && /^\/v1\/customers\/cus_/.test(s.path));
/** Expected types: prefix + `extra` + one customer.updated per default-PM-on-customer step and `fromSub` from the subscription. */
function expected(steps: { method: string; path: string }[], extra: string[], fromSub = 1): string[] {
  return [...PREFIX, ...extra, ...Array<string>(Number(onCustomer(steps)) + fromSub).fill("customer.updated")].sort();
}
/** The prefix's step count: customer, attach, (default PM on the customer), price, subscription. */
const prefixLen = (steps: { method: string; path: string }[]) => steps.findIndex((s) => s.method === "POST" && s.path === "/v1/subscriptions") + 1;

test("period math: calendar months with day clamping, years, weeks, days, interval_count", () => {
  const t = (iso: string) => Date.parse(iso) / 1000;
  assert.equal(addInterval(t("2026-01-31T10:20:30Z"), "month"), t("2026-02-28T10:20:30Z"));
  assert.equal(addInterval(t("2028-01-31T00:00:00Z"), "month"), t("2028-02-29T00:00:00Z"));
  assert.equal(addInterval(t("2026-03-31T00:00:00Z"), "month"), t("2026-04-30T00:00:00Z"));
  assert.equal(addInterval(t("2026-12-31T00:00:00Z"), "month"), t("2027-01-31T00:00:00Z"));
  assert.equal(addInterval(t("2026-11-30T00:00:00Z"), "month", 3), t("2027-02-28T00:00:00Z"));
  assert.equal(addInterval(t("2028-02-29T00:00:00Z"), "year"), t("2029-02-28T00:00:00Z"));
  assert.equal(addInterval(t("2026-09-26T00:01:45Z"), "month"), t("2026-10-26T00:01:45Z")); // the sandbox's 30 days
  assert.equal(addInterval(t("2026-09-26T00:01:45Z"), "year"), t("2027-09-26T00:01:45Z")); // the sandbox's 365 days
  assert.equal(addInterval(t("2026-01-01T00:00:00Z"), "week", 2), t("2026-01-15T00:00:00Z"));
  assert.equal(addInterval(t("2026-01-01T00:00:00Z"), "day"), t("2026-01-02T00:00:00Z"));
});

for (const seed of [1, 2]) {
  test(`#5 subscription-create#${seed}: active, paid first invoice, flexible billing_mode, periods on items`, async () => {
    const { steps, types, events, bound } = await run(`subscription-create#${seed}`);
    const n = prefixLen(steps);
    assert.deepEqual(steps.map(cell), ok(n + 2));
    assert.deepEqual(types, expected(steps, PAID));
    const [sub, retrieved, invoices] = [steps[n - 1]!.body, steps[n]!.body, steps[n + 1]!.body];
    assert.equal(sub.status, "active");
    assert.deepEqual(sub.billing_mode, { flexible: { proration_discounts: "included" }, type: "flexible", updated_at: NOW });
    assert.equal("current_period_end" in sub, false);
    const [item] = sub.items.data;
    assert.equal(item.price.id, bound.pr1.id);
    assert.equal(item.quantity, 1);
    assert.equal(item.current_period_start, NOW);
    assert.equal(item.current_period_end, addInterval(NOW, bound.pr1.recurring.interval));
    // The payment method is on the subscription only when it was not the customer's default.
    assert.equal(sub.default_payment_method, onCustomer(steps) ? null : bound.pm1.id);
    assert.equal(sub.currency, bound.pr1.currency);

    const inv = retrieved.latest_invoice; // expanded
    assert.equal(inv.id, sub.latest_invoice);
    assert.equal(inv.status, "paid");
    assert.equal(inv.billing_reason, "subscription_create");
    const amount = bound.pr1.unit_amount;
    assert.deepEqual([inv.amount_due, inv.amount_paid, inv.amount_remaining, inv.subtotal, inv.total], [amount, amount, 0, amount, amount]);
    assert.equal(inv.status_transitions.paid_at, NOW);
    assert.equal(inv.lines.data.length, 1);
    assert.deepEqual(inv.lines.data[0].period, { end: item.current_period_end, start: NOW });
    assert.equal(inv.lines.data[0].parent.subscription_item_details.subscription_item, item.id);
    assert.deepEqual(invoices.data.map((i: Obj) => i.id), [inv.id]);

    const currency = events.filter((e) => e.type === "customer.updated").at(-1)!;
    assert.deepEqual(currency.data.previous_attributes, { currency: null });
    const pi = events.find((e) => e.type === "payment_intent.succeeded")!.data.object as Obj;
    assert.deepEqual([pi.amount, pi.amount_received, pi.customer, pi.payment_details.order_reference], [amount, amount, bound.c1.id, inv.id]);
    assert.equal(pi.latest_charge, events.find((e) => e.type === "charge.succeeded")!.data.object.id);
  });

  test(`#6 subscription-cancel-now#${seed}: cancel, retrieve canceled, cancel again is 404`, async () => {
    const { steps, types, bound } = await run(`subscription-cancel-now#${seed}`);
    const n = prefixLen(steps);
    assert.deepEqual(steps.map(cell), [...ok(n + 2), "404 resource_missing"]);
    assert.deepEqual(types, expected(steps, [...PAID, "customer.subscription.deleted"]));
    const [canceled, retrieved, again] = steps.slice(n);
    assert.equal(canceled!.body.status, "canceled");
    assert.deepEqual([canceled!.body.canceled_at, canceled!.body.ended_at], [NOW, NOW]);
    assert.equal(canceled!.body.cancellation_details.reason, "cancellation_requested");
    assert.deepEqual(retrieved!.body, canceled!.body);
    assert.equal(again!.body.error.param, "id");
  });

  test(`#7 subscription-cancel-at-period-end#${seed}: sets cancel_at to the item period end, then clears it`, async () => {
    const { steps, types, events, bound } = await run(`subscription-cancel-at-period-end#${seed}`);
    const n = prefixLen(steps);
    assert.deepEqual(steps.map(cell), ok(n + 3));
    assert.deepEqual(types, expected(steps, [...PAID, "customer.subscription.updated", "customer.subscription.updated"]));
    const [on, retrieved, off] = steps.slice(n).map((s) => s.body);
    const end = bound.s1.items.data[0].current_period_end;
    assert.deepEqual([on!.cancel_at, on!.cancel_at_period_end, on!.canceled_at, on!.status], [end, true, NOW, "active"]);
    assert.equal(on!.cancellation_details.reason, "cancellation_requested");
    assert.deepEqual(retrieved, on);
    assert.deepEqual([off!.cancel_at, off!.cancel_at_period_end, off!.canceled_at, off!.cancellation_details.reason], [null, false, null, null]);
    const [first, second] = events.filter((e) => e.type === "customer.subscription.updated");
    assert.deepEqual(first!.data.previous_attributes, { cancel_at: null, cancel_at_period_end: false, canceled_at: null, cancellation_details: { reason: null } });
    assert.deepEqual(second!.data.previous_attributes, { cancel_at: end, cancel_at_period_end: true, canceled_at: NOW, cancellation_details: { reason: "cancellation_requested" } });
  });

  test(`#8 refund-full#${seed}: full refund by payment intent updates the charge`, async () => {
    const { steps, types, events, bound } = await run(`refund-full#${seed}`);
    const n = prefixLen(steps);
    assert.deepEqual(steps.map(cell), ok(n + 4));
    assert.deepEqual(types, expected(steps, [...PAID, "charge.refund.updated", "charge.refunded", "refund.created", "refund.updated"]));
    const [pis, refund, charge, refunds] = steps.slice(n).map((s) => s.body);
    assert.equal(pis!.data.length, 1);
    const pi = pis!.data[0];
    assert.deepEqual([pi.status, pi.latest_charge], ["succeeded", charge!.id]);
    assert.deepEqual([refund!.status, refund!.amount, refund!.charge, refund!.payment_intent], ["succeeded", bound.pr1.unit_amount, charge!.id, pi.id]);
    assert.ok(["requested_by_customer", "duplicate"].includes(refund!.reason));
    assert.deepEqual([charge!.amount_refunded, charge!.refunded], [bound.pr1.unit_amount, true]);
    assert.deepEqual(refunds!.data.map((r: Obj) => r.id), [refund!.id]);
    assert.deepEqual(events.find((e) => e.type === "charge.refunded")!.data.previous_attributes, { amount_refunded: 0, refunded: false });
  });

  test(`#9 refund-partial-then-rest#${seed}: partial, remainder, then charge_already_refunded`, async () => {
    const { steps, types, twin, bound } = await run(`refund-partial-then-rest#${seed}`);
    const n = prefixLen(steps);
    assert.deepEqual(steps.map(cell), [...ok(n + 3), "400 charge_already_refunded"]);
    const refundEvents = ["charge.refund.updated", "charge.refunded", "refund.created", "refund.updated"];
    assert.deepEqual(types, expected(steps, [...PAID, ...refundEvents, ...refundEvents]));
    assert.equal(steps.at(-1)!.body.error.param, undefined);
    const [part, rest] = [steps[n + 1]!.body, steps[n + 2]!.body];
    assert.equal(part.amount + rest.amount, bound.pr1.unit_amount);
    const charge = (await call(twin, "GET", `/v1/charges/${bound.pis.data[0].latest_charge}`)).body;
    assert.deepEqual([charge.amount_refunded, charge.refunded], [bound.pr1.unit_amount, true]);
  });

  test(`#10 refund-over-and-negative#${seed}: over the charge (no code), negative, then a valid partial`, async () => {
    const { steps, types, bound } = await run(`refund-over-and-negative#${seed}`);
    const n = prefixLen(steps);
    assert.deepEqual(steps.map(cell), [...ok(n + 1), "400 invalid_request_error", "400 parameter_invalid_integer", "200"]);
    assert.deepEqual(types, expected(steps, [...PAID, "charge.refund.updated", "charge.refunded", "refund.created", "refund.updated"]));
    assert.deepEqual(steps.slice(n + 1, n + 3).map((s) => [s.body.error.param, s.body.error.code]), [["amount", undefined], ["amount", "parameter_invalid_integer"]]);
  });

  test(`#14 idempotency-replay#${seed}: replay, mismatch, new key`, async () => {
    const { steps, types } = await run(`idempotency-replay#${seed}`);
    assert.deepEqual(steps.map(cell), ["200", "200", "400 idempotency_error", "200"]);
    assert.equal(steps[0]!.headers["Idempotent-Replayed"], undefined);
    assert.equal(steps[1]!.headers["Idempotent-Replayed"], "true");
    assert.deepEqual(steps[1]!.body, steps[0]!.body);
    assert.notEqual(steps[3]!.body.id, steps[0]!.body.id);
    assert.deepEqual(types, ["customer.created", "customer.created"]);
  });

  test(`#15 subscription-events#${seed}: the event set of create + cancel`, async () => {
    const { steps, types } = await run(`subscription-events#${seed}`);
    assert.ok(steps.every((s) => s.status === 200));
    assert.deepEqual(types, expected(steps, [...PAID, "customer.subscription.deleted"]));
  });

  test(`#11/#12 resource-missing#${seed} and invalid-params#${seed}: subscription and invoice steps`, async () => {
    const missing = (await run(`resource-missing#${seed}`)).steps.filter((s) => /^\/v1\/(subscriptions|invoices)\//.test(s.path));
    assert.deepEqual(missing.map((s) => `${s.method} ${cell(s)} ${s.body.error.param}`), [
      "GET 404 resource_missing id",
      "POST 404 resource_missing id",
      "DELETE 404 resource_missing id",
      "GET 404 resource_missing invoice",
      "POST 404 resource_missing id",
      "DELETE 404 resource_missing invoice",
    ]);
    const noItems = (await run(`invalid-params#${seed}`)).steps.find((s) => s.path === "/v1/subscriptions")!;
    assert.deepEqual([cell(noItems), noItems.body.error.param], ["400 parameter_missing", "items"]);
  });
}

for (const seed of [1, 2]) {
  test(`#13 card-declined#${seed} (default payment_behavior): incomplete subscription, open invoice`, async () => {
    const { steps, types, events, bound } = await run(`card-declined#${seed}`);
    const n = prefixLen(steps);
    assert.deepEqual(steps.map(cell), ok(n + 1));
    const failed = ["charge.failed", "customer.subscription.created", "invoice.created", "invoice.finalized", "invoice.payment_failed", "payment_intent.created", "payment_intent.payment_failed"];
    assert.deepEqual(types, expected(steps, failed));
    assert.equal(bound.s1.status, "incomplete");
    const [inv] = steps[n]!.body.data;
    assert.deepEqual([inv.id, inv.status, inv.amount_paid, inv.amount_remaining, inv.attempted], [bound.s1.latest_invoice, "open", 0, bound.pr1.unit_amount, true]);
    const pi = events.find((e) => e.type === "payment_intent.payment_failed")!.data.object as Obj;
    const charge = events.find((e) => e.type === "charge.failed")!.data.object as Obj;
    assert.equal(pi.status, "requires_payment_method");
    assert.deepEqual([pi.last_payment_error.type, pi.last_payment_error.code, pi.last_payment_error.charge], ["card_error", "card_declined", charge.id]);
    assert.deepEqual([charge.status, charge.paid, charge.failure_code], ["failed", false, "card_declined"]);
  });
}

test("#13 card-declined#3 (error_if_incomplete): 402 card error, no invoice or subscription persists", async () => {
  const { steps, types, twin, bound } = await run("card-declined#3");
  const n = prefixLen(steps);
  assert.deepEqual(steps.map(cell), [...ok(n - 1), "402 card_declined", "200"]);
  const failed = ["charge.failed", "payment_intent.canceled", "payment_intent.created", "payment_intent.payment_failed"];
  assert.deepEqual(types, expected(steps, failed, 0));
  const { error } = steps[n - 1]!.body;
  assert.equal(error.type, "card_error");
  assert.equal(error.decline_code, "generic_decline");
  assert.match(error.charge, /^ch_/);
  assert.equal(error.payment_method.id, bound.pm1.id);
  assert.equal("payment_intent" in error, false);
  assert.deepEqual(steps[n]!.body.data, []); // GET /v1/invoices?customer=
  assert.deepEqual((await call(twin, "GET", "/v1/subscriptions", { customer: bound.c1.id, status: "all" })).body.data, []);
  const [pi] = (await call(twin, "GET", "/v1/payment_intents", { customer: bound.c1.id })).body.data;
  assert.deepEqual([pi.status, pi.cancellation_reason, pi.latest_charge], ["canceled", "failed_invoice", error.charge]);
  assert.equal((await call(twin, "GET", `/v1/customers/${bound.c1.id}`)).body.currency, null); // not set by the failed create
});

/** A customer with pm_card_visa as the default payment method, and a monthly price. */
async function setup(t: Twin, headers: Obj = {}) {
  const c = (await call(t, "POST", "/v1/customers", {}, headers)).body;
  const pm = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: c.id }, headers)).body;
  await call(t, "POST", `/v1/customers/${c.id}`, { invoice_settings: { default_payment_method: pm.id } }, headers);
  const price = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 1500, recurring: { interval: "month" }, product_data: { name: "P" } }, headers)).body;
  return { c, pm, price };
}
const since = (t: Twin, i: number) => t.store.events.slice(i).map((e) => e.type).sort();

test("Jan 31 monthly subscription: item period ends Feb 28, cancel_at follows it", async () => {
  const t = createTwin();
  const at = { "Parity-Now": String(Date.parse("2026-01-31T12:00:00Z") / 1000) };
  const { c, price } = await setup(t, at);
  const sub = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id, quantity: 3 }] }, at)).body;
  const end = Date.parse("2026-02-28T12:00:00Z") / 1000;
  assert.equal(sub.items.data[0].current_period_end, end);
  const inv = (await call(t, "GET", `/v1/invoices/${sub.latest_invoice}`)).body;
  assert.deepEqual([inv.amount_paid, inv.lines.data[0].quantity], [4500, 3]);
  const upd = (await call(t, "POST", `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: true, metadata: { k: "v" } }, at)).body;
  assert.deepEqual([upd.cancel_at, upd.metadata], [end, { k: "v" }]);
  const again = t.store.events.length;
  await call(t, "POST", `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: true }, at); // no change, no event
  assert.equal(t.store.events.length, again);
  const atCreate = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }], cancel_at_period_end: true, metadata: { m: "1" } }, at)).body;
  assert.deepEqual([atCreate.cancel_at, atCreate.canceled_at, atCreate.cancellation_details.reason, atCreate.metadata], [end, Number(at["Parity-Now"]), "cancellation_requested", { m: "1" }]);
});

test("send_invoice: draft invoice with a due date, no payment, active subscription", async () => {
  const t = createTwin();
  const { c, price } = await setup(t, { "Parity-Now": String(NOW) });
  const i = t.store.events.length;
  const noDays = await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }], collection_method: "send_invoice" });
  assert.deepEqual([cell(noDays), noDays.body.error.param], ["400 parameter_missing", "days_until_due"]);
  const params = { customer: c.id, items: [{ price: price.id }], collection_method: "send_invoice", days_until_due: 14 };
  const sub = (await call(t, "POST", "/v1/subscriptions", params, { "Parity-Now": String(NOW) })).body;
  assert.deepEqual([sub.status, sub.collection_method, sub.days_until_due], ["active", "send_invoice", 14]);
  const inv = (await call(t, "GET", `/v1/invoices/${sub.latest_invoice}`)).body;
  assert.deepEqual([inv.status, inv.amount_remaining, inv.due_date, inv.attempted], ["draft", 1500, NOW + 14 * 86400, false]);
  assert.deepEqual(since(t, i), ["customer.subscription.created", "customer.updated", "invoice.created"]);
  assert.deepEqual((await call(t, "GET", "/v1/payment_intents", { customer: c.id })).body.data, []);
});

test("default_incomplete: incomplete subscription, payment intent awaiting a payment method, no charge", async () => {
  const t = createTwin();
  const { c, price } = await setup(t);
  const i = t.store.events.length;
  const sub = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }], payment_behavior: "default_incomplete" })).body;
  assert.equal(sub.status, "incomplete");
  assert.deepEqual(since(t, i), ["customer.subscription.created", "customer.updated", "invoice.created", "invoice.finalized", "payment_intent.created"]);
  const [pi] = (await call(t, "GET", "/v1/payment_intents", { customer: c.id })).body.data;
  assert.deepEqual([pi.status, pi.latest_charge], ["requires_payment_method", null]);
  assert.deepEqual((await call(t, "GET", "/v1/charges", { customer: c.id })).body.data, []);
  // A second subscription does not touch the customer's currency again.
  const j = t.store.events.length;
  await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }] });
  assert.equal(since(t, j).includes("customer.updated"), false);
});

test("subscription create validation: nothing persists on a failed create", async () => {
  const t = createTwin();
  const { c, price } = await setup(t);
  const other = (await call(t, "POST", "/v1/customers")).body;
  const foreign = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: other.id })).body;
  const oneTime = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 5, product: price.product })).body;
  const bad = async (params: Obj) => {
    const r = await call(t, "POST", "/v1/subscriptions", params);
    return `${cell(r)} ${r.body.error?.param}`;
  };
  const items = [{ price: price.id }];
  assert.equal(await bad({ items }), "400 parameter_missing customer");
  assert.equal(await bad({ customer: "cus_Missing123456", items }), "400 resource_missing customer");
  assert.equal(await bad({ customer: c.id, items, default_payment_method: foreign.id }), "400 resource_missing default_payment_method");
  assert.equal(await bad({ customer: c.id, items: [{ price: "price_Missing123456789012" }] }), "400 resource_missing items[0][price]");
  assert.equal(await bad({ customer: c.id, items: [{ quantity: 2 }] }), "400 parameter_missing items[0][price]");
  assert.equal(await bad({ customer: c.id, items: [{ price: oneTime.id }] }), "400 invalid_request_error items[0][price]");
  assert.equal(await bad({ customer: other.id, items, payment_behavior: "error_if_incomplete" }), "400 resource_missing undefined"); // no payment method
  const bogus = { currency: "usd", product: "prod_Missing123456", recurring: { interval: "month" } };
  assert.equal(await bad({ customer: c.id, items: [{ price_data: bogus }] }), "400 resource_missing items[0][price_data][product]");
  // Spec-valid params the create does not implement (W4) fail instead of being dropped into a wrong state.
  const w4 = async (params: Obj) => (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items, ...params })).body.error?.message;
  const inline = { currency: "usd", product: price.product, unit_amount: 700, recurring: { interval: "month" } };
  for (const params of [
    { trial_end: 1900000000 },
    { cancel_at: 1900000000 },
    { billing_mode: { type: "classic" } },
    { proration_behavior: "none" },
    { items: [{ price: price.id, tax_rates: ["txr_Missing123456"] }] },
    { items: [{ price_data: { ...inline, tax_behavior: "exclusive" } }] },
    { items: [{ price_data: { ...inline, unit_amount: undefined, unit_amount_decimal: "700" } }] },
  ])
    assert.equal(await w4(params), msg("not_implemented"), JSON.stringify(params));
  const types = [...t.store.objects.values()].map((o) => o.object);
  assert.deepEqual([types.includes("subscription"), types.includes("invoice"), types.includes("payment_intent")], [false, false, false]);
});

test("error_if_incomplete with expand[]: still 402 card_declined, and the payment events persist", async () => {
  const t = createTwin();
  const { c, price } = await setup(t);
  const sub = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }], expand: ["latest_invoice"] })).body;
  assert.equal(sub.latest_invoice.status, "paid"); // expand is allowed on create
  const fails = (await call(t, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: c.id })).body;
  const j = t.store.events.length;
  const params = { customer: c.id, items: [{ price: price.id }], default_payment_method: fails.id, payment_behavior: "error_if_incomplete", expand: ["latest_invoice"] };
  const r = await call(t, "POST", "/v1/subscriptions", params);
  assert.equal(cell(r), "402 card_declined");
  assert.deepEqual(since(t, j), ["charge.failed", "payment_intent.canceled", "payment_intent.created", "payment_intent.payment_failed"]);
});

test("price_data items, subscription and invoice list filters, W4 endpoints answer not_implemented", async () => {
  const t = createTwin();
  const { c, price } = await setup(t);
  const inline = { currency: "usd", product: price.product, unit_amount: 700, recurring: { interval: "week", interval_count: 2 } };
  const a = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price_data: inline }] }, { "Parity-Now": String(NOW) })).body;
  const p = a.items.data[0].price;
  assert.deepEqual([p.active, p.unit_amount, p.recurring.interval_count, a.items.data[0].current_period_end], [false, 700, 2, NOW + 14 * 86400]);
  assert.equal((await call(t, "GET", `/v1/prices/${p.id}`)).body.id, p.id);
  const b = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }] })).body;
  await call(t, "DELETE", `/v1/subscriptions/${a.id}`);

  const ids = async (path: string, params: Obj) => (await call(t, "GET", path, params)).body.data.map((x: Obj) => x.id);
  assert.deepEqual(await ids("/v1/subscriptions", { customer: c.id }), [b.id]); // canceled ones are excluded by default
  assert.deepEqual((await ids("/v1/subscriptions", { status: "all" })).sort(), [a.id, b.id].sort());
  assert.deepEqual(await ids("/v1/subscriptions", { status: "canceled" }), [a.id]);
  assert.deepEqual(await ids("/v1/subscriptions", { price: price.id }), [b.id]);
  assert.deepEqual(await ids("/v1/invoices", { subscription: a.id }), [a.latest_invoice]);
  assert.deepEqual((await ids("/v1/invoices", { customer: c.id, status: "paid" })).sort(), [a.latest_invoice, b.latest_invoice].sort());
  assert.deepEqual(await ids("/v1/invoices", { status: "open" }), []);

  const w4 = [
    await call(t, "POST", `/v1/subscriptions/${b.id}`, { items: [{ price: price.id, quantity: 2 }] }),
    await call(t, "DELETE", `/v1/subscriptions/${b.id}`, { invoice_now: true }),
    await call(t, "POST", `/v1/invoices/${b.latest_invoice}`, { metadata: { k: "v" } }),
    await call(t, "POST", `/v1/invoices/${b.latest_invoice}/pay`),
    await call(t, "POST", `/v1/invoices/${b.latest_invoice}/finalize`),
  ];
  assert.deepEqual(w4.map((r) => `${r.status} ${r.body.error.message}`), w4.map(() => `400 ${msg("not_implemented")}`));
  assert.equal((await call(t, "POST", "/v1/invoices/in_Missing1234567890/pay")).status, 404);
  assert.equal((await call(t, "GET", `/v1/subscriptions/${b.id}`)).body.status, "active");
});

test("refunds by charge, validation, retrieve and lists; payment intent and charge lookups", async () => {
  const t = createTwin();
  const { c, price } = await setup(t);
  const sub = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }] })).body;
  const [pi] = (await call(t, "GET", "/v1/payment_intents", { customer: c.id })).body.data;
  const [ch] = (await call(t, "GET", "/v1/charges", { customer: c.id })).body.data;
  assert.deepEqual([pi.latest_charge, ch.payment_intent, ch.status, ch.paid, ch.amount], [ch.id, pi.id, "succeeded", true, 1500]);
  assert.deepEqual((await call(t, "GET", `/v1/payment_intents/${pi.id}`)).body, pi);
  assert.deepEqual((await call(t, "GET", "/v1/charges", { payment_intent: pi.id })).body.data.map((x: Obj) => x.id), [ch.id]);

  const refund = (await call(t, "POST", "/v1/refunds", { charge: ch.id, amount: 500, metadata: { why: "test" } })).body;
  assert.deepEqual([refund.amount, refund.payment_intent, refund.metadata], [500, pi.id, { why: "test" }]);
  const after = (await call(t, "GET", `/v1/charges/${ch.id}`)).body;
  assert.deepEqual([after.amount_refunded, after.refunded], [500, false]);
  const rest = (await call(t, "POST", "/v1/refunds", { charge: ch.id })).body; // no amount: the remaining 1000
  assert.equal(rest.amount, 1000);
  assert.deepEqual((await call(t, "GET", `/v1/refunds/${refund.id}`)).body, refund);
  assert.deepEqual((await call(t, "GET", "/v1/refunds", { charge: ch.id })).body.data.map((r: Obj) => r.id), [rest.id, refund.id]);

  const err = async (method: string, path: string, params?: Obj) => {
    const r = await call(t, method, path, params);
    return `${cell(r)} ${r.body.error?.param}`;
  };
  assert.equal(await err("POST", "/v1/refunds", { amount: 5 }), "400 invalid_request_error undefined");
  assert.equal(await err("POST", "/v1/refunds", { charge: ch.id, amount: 0 }), "400 parameter_invalid_integer amount");
  assert.equal(await err("POST", "/v1/refunds", { payment_intent: "pi_Missing123456789012" }), "400 resource_missing payment_intent");
  assert.equal(await err("POST", "/v1/refunds", { charge: "ch_Missing123456789012" }), "400 resource_missing charge");
  assert.equal(await err("GET", "/v1/refunds/re_Missing123456789012"), "404 resource_missing refund");
  assert.equal(await err("GET", "/v1/charges/ch_Missing123456789012"), "404 resource_missing charge");
  assert.equal(await err("GET", "/v1/payment_intents/pi_Missing123456789012"), "404 resource_missing intent");
  assert.equal(await err("GET", `/v1/invoices/${sub.latest_invoice}`), "200 undefined");

  // A payment intent whose only charge failed has nothing to refund.
  const d = (await call(t, "POST", "/v1/customers")).body;
  const pm = (await call(t, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: d.id })).body;
  await call(t, "POST", "/v1/subscriptions", { customer: d.id, items: [{ price: price.id }], default_payment_method: pm.id });
  const [failed] = (await call(t, "GET", "/v1/payment_intents", { customer: d.id })).body.data;
  assert.equal(await err("POST", "/v1/refunds", { payment_intent: failed.id }), "400 invalid_request_error undefined");
});
