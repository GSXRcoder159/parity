// Subscription updates, flexible-mode proration and create_preview (W4 Task 2, surface-added): the train templates
// #16 and #17 run in-process against the sandbox observations (templates-validation.md), then the proration math
// off the observed path (mid-period dates, rounding, quantities, added and deleted items, anchor resets, balances).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpus } from "../src/bench/corpus.ts";
import { encodeForm, resolveRefs } from "../src/bench/run.ts";
import { addInterval } from "../src/twin/billing.ts";
import { createTwin } from "../src/twin/server.ts";
import { TEMPLATES } from "../templates/index.ts";

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;
type Res = { status: number; body: Obj };

const T0 = Date.parse("2026-09-26T00:00:00Z") / 1000;
const END = Date.parse("2026-10-26T00:00:00Z") / 1000; // one month: 30 days
const HALF = T0 + (END - T0) / 2;
const at = (t: number) => ({ "Parity-Now": String(t) });

const call = (t: Twin, method: string, path: string, params?: Obj, headers: Obj = {}) => {
  const form = params ? encodeForm(params) : "";
  const post = method === "POST";
  const req = { method, path, query: post ? "" : form, body: post ? form : "", headers: { Authorization: "Bearer sk_test_parity", ...headers } };
  return t.handle(req) as Promise<Res>;
};
const cell = (r: Res) => (r.body.error ? `${r.status} ${r.body.error.code ?? r.body.error.type}` : String(r.status));
const types = (t: Twin, from = 0) => t.store.events.slice(from).map((e) => e.type).sort();
const lineAmounts = (inv: Obj) => inv.lines.data.map((l: Obj) => [l.amount, l.parent.subscription_item_details.proration]);

/** Train templates only (#18 is held out and never run here). */
const CORPUS = buildCorpus(
  TEMPLATES.filter((t) => t.name === "invoice-preview-proration" || t.name === "subscription-update-price"),
  [1, 2, 3, 4],
);
async function run(id: string) {
  const seq = CORPUS.find((s) => s.id === id) ?? assert.fail(`no sequence ${id}`);
  const twin = createTwin();
  const bound: Obj = {};
  const steps: (Res & { method: string; path: string; params: Obj })[] = [];
  for (const s of seq.steps) {
    const path = String(resolveRefs(s.path, bound, "nonce"));
    const params = (s.params && (resolveRefs(s.params, bound, "nonce") as Obj)) ?? {};
    const r = await call(twin, s.method, path, params, at(T0));
    if (s.ref) bound[s.ref] = r.body;
    steps.push({ ...r, method: s.method, path, params });
  }
  return { twin, bound, steps };
}
const PREFIX = ["customer.created", "payment_method.attached", "plan.created", "price.created", "product.created"];
const PAID = ["charge.succeeded", "customer.subscription.created", "invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded", "payment_intent.created", "payment_intent.succeeded"];
/** Prefix + first payment + price B + `extra`, and one customer.updated per default-PM step plus the currency one. */
function expected(steps: { method: string; path: string }[], extra: string[]): string[] {
  const onCustomer = steps.some((s) => s.method === "POST" && /^\/v1\/customers\/cus_/.test(s.path));
  return [...PREFIX, ...PAID, "plan.created", "price.created", ...extra, ...Array<string>(Number(onCustomer) + 1).fill("customer.updated")].sort();
}

for (const seed of [1, 2]) {
  test(`#16 invoice-preview-proration#${seed}: swap preview, customer-only 400, upcoming 404`, async () => {
    const { twin, bound, steps } = await run(`invoice-preview-proration#${seed}`);
    const n = steps.length;
    assert.deepEqual(steps.slice(-3).map(cell), ["200", "400 invalid_request_error", "404 invalid_request_error"]);
    assert.deepEqual(steps.slice(-2).map((s) => [s.body.error.code, s.body.error.param]), [[undefined, undefined], [undefined, undefined]]);
    assert.deepEqual(types(twin), expected(steps, [])); // a preview stores nothing and emits nothing

    const p = steps[n - 3]!.body;
    const [a, b, sub] = [bound.pr1.unit_amount, bound.pr2.unit_amount, bound.s1];
    const item = sub.items.data[0];
    const end = item.current_period_end;
    assert.match(p.id, /^upcoming_in_/);
    assert.deepEqual([p.object, p.status, p.billing_reason, p.auto_advance, p.effective_at], ["invoice", "draft", "upcoming", true, null]);
    // The renewal invoice: created at the period end, the item's current period, finalized an hour after creation.
    assert.deepEqual([p.created, p.period_start, p.period_end, p.next_payment_attempt], [end, T0, end, end + 3600]);
    assert.deepEqual(p.parent.subscription_details, { metadata: {}, subscription: sub.id, subscription_proration_date: T0 });
    // Credit for A's unused time, debit for B's remaining time (the whole period at Parity-Now = start), B's next period.
    assert.deepEqual(lineAmounts(p), [[-a, true], [b, true], [b, false]]);
    assert.deepEqual([p.subtotal, p.total, p.amount_due, p.starting_balance, p.ending_balance], [2 * b - a, 2 * b - a, Math.max(2 * b - a, 0), 0, Math.min(2 * b - a, 0)]);
    const [credit, debit, next] = p.lines.data;
    for (const l of p.lines.data) assert.match(l.id, /^il_tmp_/);
    assert.deepEqual([p.lines.total_count, p.lines.url, credit.invoice], [3, `/v1/invoices/${p.id}/lines`, p.id]);
    assert.deepEqual([credit.pricing.price_details.price, debit.pricing.price_details.price, next.pricing.price_details.price], [bound.pr1.id, bound.pr2.id, bound.pr2.id]);
    assert.deepEqual([credit.period, debit.period], [{ end, start: T0 }, { end, start: T0 }]);
    assert.deepEqual(next.period, { end: addInterval(end, bound.pr1.recurring.interval), start: end });
    assert.deepEqual([credit.discountable, next.discountable], [false, true]);
    const firstInvoice = (await call(twin, "GET", `/v1/invoices/${sub.latest_invoice}`)).body;
    const credited = { invoice: firstInvoice.id, invoice_line_items: [firstInvoice.lines.data[0].id] };
    assert.deepEqual(credit.parent.subscription_item_details.proration_details.credited_items, credited);
    assert.equal(debit.parent.subscription_item_details.proration_details.credited_items, null);
    assert.match(credit.parent.subscription_item_details.invoice_item, /^ii_/);
    // Nothing changed: the subscription is still on A, and the preview is not listed.
    assert.equal((await call(twin, "GET", `/v1/subscriptions/${sub.id}`)).body.items.data[0].price.id, bound.pr1.id);
    assert.deepEqual((await call(twin, "GET", "/v1/invoices", { customer: bound.c1.id })).body.data.map((i: Obj) => i.id), [firstInvoice.id]);
  });
}

for (const seed of [1, 2, 3, 4]) {
  test(`#17 subscription-update-price#${seed}: the swap's events and invoices per proration_behavior`, async () => {
    const { twin, bound, steps } = await run(`subscription-update-price#${seed}`);
    const n = steps.length;
    assert.deepEqual(steps.map(cell), Array<string>(n).fill("200"));
    const upd = steps[n - 2]!;
    const behavior = upd.params.proration_behavior;
    const [a, b] = [bound.pr1.unit_amount, bound.pr2.unit_amount];
    const sub = upd.body;
    const [item] = sub.items.data;
    assert.deepEqual([item.id, item.created, item.price.id, sub.quantity, sub.billing_cycle_anchor], [bound.s1.items.data[0].id, T0, bound.pr2.id, 1, T0]);
    assert.deepEqual([item.current_period_start, item.current_period_end], [T0, bound.s1.items.data[0].current_period_end]);
    const invoices = steps[n - 1]!.body.data;
    const updated = twin.store.events.find((e) => e.type === "customer.subscription.updated")!;
    assert.deepEqual(Object.keys(updated.data.previous_attributes!).sort(), behavior === "always_invoice" ? ["items", "latest_invoice"] : ["items"]);
    assert.equal((updated.data.previous_attributes as Obj).items.data[0].price.id, bound.pr1.id);
    const items = twin.store.events.filter((e) => e.type === "invoiceitem.created").map((e) => e.data.object as Obj);

    if (behavior === "none") {
      assert.deepEqual(types(twin), expected(steps, ["customer.subscription.updated"]));
      assert.equal(invoices.length, 1);
    } else if (behavior === "create_prorations") {
      assert.deepEqual(types(twin), expected(steps, ["customer.subscription.updated", "invoiceitem.created", "invoiceitem.created"]));
      assert.equal(invoices.length, 1); // the prorations stay pending
      assert.deepEqual(items.map((i) => [i.amount, i.invoice, i.proration, i.pricing.price_details.price]), [[-a, null, true, bound.pr1.id], [b, null, true, bound.pr2.id]]);
      assert.deepEqual(items[0]!.proration_details.credited_items, {
        invoice_line_item_details: { invoice: invoices[0].id, invoice_line_items: [invoices[0].lines.data[0].id] },
        type: "invoice_line_items",
      });
    } else {
      // always_invoice: a second invoice, finalized and paid now (#17 seed 3 is a downgrade: negative total, paid).
      assert.equal(behavior, "always_invoice");
      assert.ok(b < a, "seed 3 is the observed downgrade");
      assert.deepEqual(types(twin), expected(steps, ["customer.subscription.updated", "customer.updated", ...PAID.filter((x) => x.startsWith("invoice.")), "invoiceitem.created", "invoiceitem.created"]));
      const [inv, first] = invoices;
      assert.deepEqual([invoices.length, sub.latest_invoice, first.billing_reason], [2, inv.id, "subscription_create"]);
      assert.deepEqual([inv.billing_reason, inv.status, inv.total, inv.amount_due, inv.amount_paid, inv.ending_balance], ["subscription_update", "paid", b - a, 0, 0, b - a]);
      assert.deepEqual([inv.attempted, inv.attempt_count, inv.period_start, inv.period_end, inv.status_transitions.paid_at], [true, 0, T0, T0, T0]);
      assert.deepEqual(lineAmounts(inv), [[-a, true], [b, true]]);
      assert.deepEqual(items.map((i) => i.invoice), [inv.id, inv.id]);
      const cu = twin.store.events.filter((e) => e.type === "customer.updated").at(-1)!;
      assert.deepEqual([(cu.data.object as Obj).balance, cu.data.previous_attributes], [b - a, { balance: 0 }]);
    }
  });
}

/** A customer with a default card, prices of 1000 and 2000 a month on one product, and a subscription on the first. */
async function subscribed(t: Twin, items: Obj[] = [{ price: "A" }]) {
  const c = (await call(t, "POST", "/v1/customers", {}, at(T0))).body;
  const pm = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: c.id }, at(T0))).body;
  await call(t, "POST", `/v1/customers/${c.id}`, { invoice_settings: { default_payment_method: pm.id } }, at(T0));
  const A = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 1000, recurring: { interval: "month" }, product_data: { name: "P" } }, at(T0))).body;
  const price = (unit_amount: number) => call(t, "POST", "/v1/prices", { currency: "usd", unit_amount, recurring: { interval: "month" }, product: A.product }, at(T0));
  const B = (await price(2000)).body;
  const C = (await price(3001)).body;
  const ids: Obj = { A: A.id, B: B.id, C: C.id };
  const sub = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: items.map((i) => ({ ...i, price: ids[i.price] })) }, at(T0))).body;
  return { c, A, B, C, sub, si: sub.items.data[0].id as string };
}
const update = (t: Twin, sub: Obj, params: Obj, now = HALF) => call(t, "POST", `/v1/subscriptions/${sub.id}`, params, at(now));
const created = (t: Twin, from: number) => t.store.events.slice(from).filter((e) => e.type === "invoiceitem.created").map((e) => e.data.object as Obj);

test("mid-period proration: by the second over the item period, each amount rounded half up; proration_date", async () => {
  const t = createTwin();
  const { A, C, sub, si } = await subscribed(t);
  const from = t.store.events.length;
  // Half the period left: credit 1000/2 = 500, debit 3001/2 = 1500.5 -> 1501.
  await update(t, sub, { items: [{ id: si, price: C.id }] });
  assert.deepEqual(created(t, from).map((i) => [i.amount, i.period]), [[-500, { end: END, start: HALF }], [1501, { end: END, start: HALF }]]);
  // proration_date 10 days in, 20 of 30 days left: the last debit was the pending C proration (flexible mode credits
  // what was billed): -3001 * 2/3 = -2000.67 -> -2001; A's debit 1000 * 2/3 = 666.67 -> 667.
  const next = t.store.events.length;
  const date = T0 + 10 * 86400;
  await update(t, sub, { items: [{ id: si, price: A.id }], proration_date: date });
  const [credit, debit] = created(t, next);
  assert.deepEqual([credit!.amount, debit!.amount, credit!.period], [-2001, 667, { end: END, start: date }]);
  assert.deepEqual(credit!.proration_details.credited_items, { invoice_item: created(t, from)[1]!.id, type: "invoice_item" });
  // A preview with the same proration_date prorates the same way.
  const p = (await call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id, subscription_details: { items: [{ id: si, price: C.id }], proration_date: date } }, at(HALF))).body;
  assert.equal(p.parent.subscription_details.subscription_proration_date, date);
  assert.deepEqual(lineAmounts(p).slice(-3), [[-667, true], [2001, true], [3001, false]]);
  // A proration date outside the item's current period is refused.
  const late = await update(t, sub, { items: [{ id: si, price: C.id }], proration_date: END + 1 });
  assert.equal(late.body.error.message, "parity: not_implemented");
});

test("flexible mode: the credit follows the last billed price (docs example: none, then always_invoice back nets 0)", async () => {
  const t = createTwin();
  const { c, A, B, sub, si } = await subscribed(t);
  const from = t.store.events.length;
  const up = (await update(t, sub, { items: [{ id: si, price: B.id }], proration_behavior: "none" }, T0 + 86400)).body;
  assert.deepEqual([up.items.data[0].price.id, types(t, from)], [B.id, ["customer.subscription.updated"]]);
  const back = (await update(t, sub, { items: [{ id: si, price: A.id }], proration_behavior: "always_invoice" })).body;
  const inv = (await call(t, "GET", `/v1/invoices/${back.latest_invoice}`)).body;
  assert.deepEqual(lineAmounts(inv), [[-500, true], [500, true]]); // A's 1000 credited, not B's 2000
  assert.deepEqual([inv.total, inv.status, inv.amount_paid], [0, "paid", 0]);
  assert.equal((await call(t, "GET", `/v1/customers/${c.id}`)).body.balance, 0);
});

test("quantity changes: credit the old quantity, debit the new; legacy subscription.quantity follows the item", async () => {
  const t = createTwin();
  const { sub, si } = await subscribed(t);
  assert.equal(sub.quantity, 1);
  const from = t.store.events.length;
  const up = (await update(t, sub, { items: [{ id: si, quantity: 3 }] })).body;
  assert.deepEqual([up.quantity, up.items.data[0].quantity], [3, 3]);
  assert.deepEqual(created(t, from).map((i) => [i.amount, i.quantity]), [[-500, 1], [1500, 3]]);
  // Metadata only: no proration, and the event carries only the metadata change.
  const next = t.store.events.length;
  await update(t, sub, { items: [{ id: si, metadata: { k: "v" } }] });
  assert.deepEqual(types(t, next), ["customer.subscription.updated"]);
  // Two items at create: no legacy quantity.
  assert.equal((await subscribed(createTwin(), [{ price: "A" }, { price: "B", quantity: 2 }])).sub.quantity, null);
});

test("added and deleted items: a debit only for the new item, a credit only for the deleted one", async () => {
  const t = createTwin();
  const { B, sub, si } = await subscribed(t);
  const from = t.store.events.length;
  const added = (await update(t, sub, { items: [{ price: B.id, quantity: 2 }] })).body;
  const [, item] = added.items.data;
  assert.deepEqual([added.items.data.length, added.quantity], [2, null]);
  assert.deepEqual([item.current_period_start, item.current_period_end, item.created, item.subscription], [T0, END, HALF, sub.id]);
  assert.deepEqual(created(t, from).map((i) => [i.amount, i.parent.subscription_details.subscription_item]), [[2000, item.id]]);
  const next = t.store.events.length;
  const removed = (await update(t, sub, { items: [{ id: si, deleted: true }] }, T0 + 20 * 86400)).body;
  assert.deepEqual([removed.items.data.map((i: Obj) => i.id), removed.quantity], [[item.id], 2]);
  assert.deepEqual(created(t, next).map((i) => i.amount), [-333]); // 10 of 30 days of A's 1000
  // Refused: an unknown item id, a second item on the same price, deleting the last item.
  const bad = [
    await update(t, sub, { items: [{ id: "si_Missing123456", price: B.id }] }),
    await update(t, sub, { items: [{ price: B.id }] }),
    await update(t, sub, { items: [{ id: item.id, deleted: true }] }),
  ];
  assert.deepEqual(bad.map((r) => [cell(r), r.body.error.param]), [
    ["400 resource_missing", "items[0][id]"],
    ["400 invalid_request_error", undefined],
    ["400 invalid_request_error", undefined],
  ]);
});

test("always_invoice upgrade: charged now; pending items are swept into that invoice", async () => {
  const t = createTwin();
  const { B, C, sub, si } = await subscribed(t);
  await update(t, sub, { items: [{ id: si, price: B.id }] }); // pending: -500, +1000
  const pending = created(t, 0);
  const from = t.store.events.length;
  const up = (await update(t, sub, { items: [{ id: si, price: C.id }], proration_behavior: "always_invoice" })).body;
  assert.deepEqual(types(t, from), [
    "charge.succeeded",
    "customer.subscription.updated",
    "invoice.created",
    "invoice.finalized",
    "invoice.paid",
    "invoice.payment_succeeded",
    "invoiceitem.created",
    "invoiceitem.created",
    "payment_intent.created",
    "payment_intent.succeeded",
  ]);
  const inv = (await call(t, "GET", `/v1/invoices/${up.latest_invoice}`)).body;
  // Pending -500 and +1000, then B's pending debit credited (-1000) and C's debit (+1501).
  assert.deepEqual(lineAmounts(inv).map(([x]: number[]) => x), [-500, 1000, -1000, 1501]);
  assert.deepEqual([inv.amount_due, inv.amount_paid, inv.attempt_count, inv.status, inv.period_start, inv.period_end], [1001, 1001, 1, "paid", T0, HALF]);
  assert.deepEqual(inv.lines.data.slice(0, 2).map((l: Obj) => l.parent.subscription_item_details.invoice_item), pending.map((i) => i.id));
  const pi = t.store.events.find((e) => e.type === "payment_intent.succeeded" && e.created === HALF)!.data.object as Obj;
  assert.deepEqual([pi.amount, pi.payment_details.order_reference], [1001, inv.id]);
  // Nothing pending is left: the renewal preview has only the next period.
  const p = (await call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id }, at(HALF))).body;
  assert.deepEqual([lineAmounts(p), p.created, "subscription_proration_date" in p.parent.subscription_details], [[[3001, false]], END, false]);
});

test("a credit balance from a downgrade is consumed by the customer's next invoice", async () => {
  const t = createTwin();
  const { c, A, B, sub } = await subscribed(t, [{ price: "B" }]);
  await update(t, sub, { items: [{ id: sub.items.data[0].id, price: A.id }], proration_behavior: "always_invoice" }); // -1000 + 500
  assert.equal((await call(t, "GET", `/v1/customers/${c.id}`)).body.balance, -500);
  const from = t.store.events.length;
  const second = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: B.id }] }, at(HALF))).body;
  const inv = (await call(t, "GET", `/v1/invoices/${second.latest_invoice}`)).body;
  assert.deepEqual([inv.starting_balance, inv.ending_balance, inv.total, inv.amount_due, inv.amount_paid], [-500, 0, 2000, 1500, 1500]);
  const cu = t.store.events.slice(from).find((e) => e.type === "customer.updated")!;
  assert.deepEqual([(cu.data.object as Obj).balance, cu.data.previous_attributes], [0, { balance: -500 }]);
});

test("billing_cycle_anchor=now: the period restarts now, unused time is credited and the new period invoiced in full", async () => {
  const t = createTwin();
  const { B, sub, si } = await subscribed(t);
  const up = (await update(t, sub, { items: [{ id: si, price: B.id }], billing_cycle_anchor: "now" })).body;
  const newEnd = addInterval(HALF, "month");
  assert.deepEqual([up.billing_cycle_anchor, up.items.data[0].current_period_start, up.items.data[0].current_period_end], [HALF, HALF, newEnd]);
  const inv = (await call(t, "GET", `/v1/invoices/${up.latest_invoice}`)).body;
  assert.deepEqual(lineAmounts(inv), [[-500, true], [2000, false]]);
  assert.deepEqual([inv.lines.data[1].period, inv.status, inv.amount_paid, inv.billing_reason], [{ end: newEnd, start: HALF }, "paid", 1500, "subscription_update"]);
  // With proration_behavior=none there is no credit, only the full new period.
  const u2 = (await update(t, sub, { billing_cycle_anchor: "now", proration_behavior: "none" }, HALF + 86400)).body;
  assert.deepEqual(lineAmounts((await call(t, "GET", `/v1/invoices/${u2.latest_invoice}`)).body), [[2000, false]]);
});

test("create_preview: a new subscription's first invoice, validation, and GET /v1/invoices/upcoming", async () => {
  const t = createTwin();
  const { c, A, B, sub } = await subscribed(t);
  const before = t.store.events.length;
  const p = (await call(t, "POST", "/v1/invoices/create_preview", { customer: c.id, subscription_details: { items: [{ price: B.id, quantity: 2 }] } }, at(HALF))).body;
  assert.deepEqual([p.status, p.billing_reason, p.created, p.amount_due, lineAmounts(p)], ["draft", "upcoming", HALF, 4000, [[4000, false]]]);
  assert.deepEqual(p.lines.data[0].period, { end: addInterval(HALF, "month"), start: HALF });
  assert.equal(t.store.events.length, before);
  const bad = [
    await call(t, "POST", "/v1/invoices/create_preview", { customer: c.id }),
    await call(t, "POST", "/v1/invoices/create_preview", { subscription_details: { items: [{ price: A.id }] } }),
    await call(t, "POST", "/v1/invoices/create_preview", { subscription: "sub_Missing1234567890" }),
    await call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id, invoice_items: [{ amount: 100, currency: "usd" }] }),
    await call(t, "GET", "/v1/invoices/upcoming", { customer: c.id }),
  ];
  assert.deepEqual(bad.map((r) => [cell(r), r.body.error.param, r.body.error.message]), [
    ["400 invalid_request_error", undefined, "parity: invoice_preview_target_missing"],
    ["400 parameter_missing", "customer", "parity: parameter_missing"],
    ["400 resource_missing", "subscription", "parity: resource_missing_400"],
    ["400 invalid_request_error", undefined, "parity: not_implemented"],
    ["404 invalid_request_error", undefined, "parity: invoice_upcoming_deprecated"],
  ]);
});
