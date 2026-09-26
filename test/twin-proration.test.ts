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
  // proration_date 20 days in, sent on day 25: 10 of 30 days left, inside the pending C debit [HALF, END] (flexible mode
  // credits what was billed): -3001/3 = -1000.33 -> -1000; A's debit 1000/3 = 333.33 -> 333.
  const next = t.store.events.length;
  const [date, day25] = [T0 + 20 * 86400, T0 + 25 * 86400];
  await update(t, sub, { items: [{ id: si, price: A.id }], proration_date: date }, day25);
  const [credit, debit] = created(t, next);
  assert.deepEqual([credit!.amount, debit!.amount, credit!.period], [-1000, 333, { end: END, start: date }]);
  assert.deepEqual(credit!.proration_details.credited_items, { invoice_item: created(t, from)[1]!.id, type: "invoice_item" });
  // A preview with the same proration_date prorates the same way (A's pending 333 credited, C debited).
  const p = (await call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id, subscription_details: { items: [{ id: si, price: C.id }], proration_date: date } }, at(day25))).body;
  assert.equal(p.parent.subscription_details.subscription_proration_date, date);
  assert.deepEqual(lineAmounts(p).slice(-3), [[-333, true], [1000, true], [3001, false]]);
  // A proration_date before the last debit's start spans two debits (docs: one credit per original debit): refused.
  const early = await update(t, sub, { items: [{ id: si, price: C.id }], proration_date: T0 + 10 * 86400 }, day25);
  assert.equal(early.body.error.message, "parity: not_implemented");
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

test("billing_cycle_anchor=now: with item changes, unused time is credited and the new period invoiced in full now", async () => {
  const t = createTwin();
  const { B, sub, si } = await subscribed(t);
  const up = (await update(t, sub, { items: [{ id: si, price: B.id }], billing_cycle_anchor: "now" })).body;
  const newEnd = addInterval(HALF, "month");
  assert.deepEqual([up.billing_cycle_anchor, up.items.data[0].current_period_start, up.items.data[0].current_period_end], [HALF, HALF, newEnd]);
  const inv = (await call(t, "GET", `/v1/invoices/${up.latest_invoice}`)).body;
  assert.deepEqual(lineAmounts(inv), [[-500, true], [2000, false]]);
  assert.deepEqual([inv.lines.data[1].period, inv.status, inv.amount_paid, inv.billing_reason], [{ end: newEnd, start: HALF }, "paid", 1500, "subscription_update"]);
  // Without item changes, flexible mode nets the credit and the debit (docs: billing-mode/compare). With none: no
  // invoice items and no invoice, only the new period.
  const day2 = HALF + 86400;
  const from = t.store.events.length;
  const u2 = (await update(t, sub, { billing_cycle_anchor: "now", proration_behavior: "none" }, day2)).body;
  const [item] = u2.items.data;
  assert.deepEqual([u2.latest_invoice, u2.billing_cycle_anchor, item.current_period_start, item.current_period_end], [up.latest_invoice, day2, day2, addInterval(day2, "month")]);
  assert.deepEqual(types(t, from), ["customer.subscription.updated"]);
  // Its preview is the renewal at the new period end, not an immediate invoice.
  const day3 = day2 + 86400;
  const preview = (sd: Obj) => call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id, subscription_details: sd }, at(day3));
  const p = (await preview({ billing_cycle_anchor: "now", proration_behavior: "none" })).body;
  assert.deepEqual([p.created, lineAmounts(p)], [addInterval(day3, "month"), [[2000, false]]]);
  // The netted proration's amount is unobserved: create_prorations and always_invoice are refused (a metadata-only item
  // edit is no item change), in a preview too.
  const refused = [
    await update(t, sub, { billing_cycle_anchor: "now" }, day3),
    await update(t, sub, { billing_cycle_anchor: "now", items: [{ id: si, metadata: { k: "v" } }], proration_behavior: "always_invoice" }, day3),
    await preview({ billing_cycle_anchor: "now" }),
  ];
  assert.deepEqual(refused.map(cell), Array(3).fill("400 invalid_request_error"));
  assert.deepEqual(refused.map((r) => r.body.error.message), Array(3).fill("parity: not_implemented"));
  assert.equal(t.store.events.length, from + 1);
});

test("a credit needs one debit that billed the whole credited span; otherwise refused (docs: no debit, no credit)", async () => {
  const t = createTwin();
  const { B, C, sub, si } = await subscribed(t);
  // A none anchor reset restarts the period at HALF and bills nothing: A's only debit is [T0, END], not the item's
  // new period [HALF, HALF + 1 month]. A later credit of A over that period would credit unbilled time.
  await update(t, sub, { billing_cycle_anchor: "now", proration_behavior: "none" });
  const day = HALF + 5 * 86400;
  // An item added under none is never billed.
  const added = (await update(t, sub, { items: [{ price: C.id }], proration_behavior: "none" }, day)).body.items.data[1];
  const from = t.store.events.length;
  const refused = [
    await update(t, sub, { items: [{ id: si, price: B.id }] }, day),
    await update(t, sub, { items: [{ id: si, price: B.id }], billing_cycle_anchor: "now" }, day),
    await call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id, subscription_details: { items: [{ id: si, price: B.id }] } }, at(day)),
    await update(t, sub, { items: [{ id: added.id, deleted: true }] }, day),
  ];
  assert.deepEqual(refused.map((r) => r.body.error?.message), Array(4).fill("parity: not_implemented"));
  assert.equal(t.store.events.length, from);
  // Changes without prorations still go through.
  const up = (await update(t, sub, { items: [{ id: si, price: B.id }], proration_behavior: "none" }, day)).body;
  assert.deepEqual([up.items.data[0].price.id, types(t, from)], [B.id, ["customer.subscription.updated"]]);
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

test("create_preview: an anchor timestamp is refused, not read as unchanged; a new subscription takes no anchor or proration_date", async () => {
  const t = createTwin();
  const { c, B, sub, si } = await subscribed(t);
  const from = t.store.events.length;
  const preview = (params: Obj) => call(t, "POST", "/v1/invoices/create_preview", params, at(HALF));
  const anchor = HALF + 10 * 86400; // docs (prorations): a future anchor debits the time up to it; unobserved
  const items = [{ price: B.id }];
  const refused = [
    await preview({ subscription: sub.id, subscription_details: { billing_cycle_anchor: anchor } }),
    await preview({ subscription: sub.id, subscription_details: { items: [{ id: si, price: B.id }], billing_cycle_anchor: anchor } }),
    await preview({ customer: c.id, subscription_details: { items, billing_cycle_anchor: anchor } }),
    await preview({ customer: c.id, subscription_details: { items, billing_cycle_anchor: "now" } }),
    await preview({ customer: c.id, subscription_details: { items, proration_date: HALF } }),
  ];
  assert.deepEqual(refused.map((r) => [r.status, r.body.error?.message]), Array(5).fill([400, "parity: not_implemented"]));
  // unchanged is the renewal preview; proration_behavior without an anchor changes nothing on a new subscription.
  const renewal = (await preview({ subscription: sub.id })).body;
  const unchanged = (await preview({ subscription: sub.id, subscription_details: { billing_cycle_anchor: "unchanged" } })).body;
  assert.deepEqual([unchanged.created, lineAmounts(unchanged)], [renewal.created, lineAmounts(renewal)]);
  const fresh = (await preview({ customer: c.id, subscription_details: { items, proration_behavior: "none" } })).body;
  assert.deepEqual(lineAmounts(fresh), [[2000, false]]);
  assert.equal(t.store.events.length, from);
});

test("a price on another billing period: only with billing_cycle_anchor=now (flexible mode never resets it by itself)", async () => {
  const t = createTwin();
  const { A, sub, si } = await subscribed(t);
  const yearly = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 12000, recurring: { interval: "year" }, product: A.product }, at(T0))).body;
  const from = t.store.events.length;
  // Without the reset, how the yearly period would align is undocumented: refused, in a preview too.
  const refused = [
    await update(t, sub, { items: [{ id: si, price: yearly.id }] }),
    await update(t, sub, { items: [{ id: si, price: yearly.id }], billing_cycle_anchor: "unchanged" }),
    await call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id, subscription_details: { items: [{ id: si, price: yearly.id }] } }, at(HALF)),
  ];
  assert.deepEqual(refused.map((r) => r.body.error?.message), Array(3).fill("parity: not_implemented"));
  assert.equal(t.store.events.length, from);

  // With it: A's unused half month credited, the year billed in full now; the preview shows the same invoice.
  const swap = { items: [{ id: si, price: yearly.id }], billing_cycle_anchor: "now" };
  const p = (await call(t, "POST", "/v1/invoices/create_preview", { subscription: sub.id, subscription_details: swap }, at(HALF))).body;
  const up = (await update(t, sub, swap)).body;
  const yearEnd = addInterval(HALF, "year");
  const [item] = up.items.data;
  assert.deepEqual([up.billing_cycle_anchor, item.price.id, item.current_period_start, item.current_period_end], [HALF, yearly.id, HALF, yearEnd]);
  const inv = (await call(t, "GET", `/v1/invoices/${up.latest_invoice}`)).body;
  assert.deepEqual([lineAmounts(inv), lineAmounts(p)], [[[-500, true], [12000, false]], [[-500, true], [12000, false]]]);
  assert.deepEqual([inv.lines.data[1].period, inv.billing_reason, inv.status, inv.amount_paid], [{ end: yearEnd, start: HALF }, "subscription_update", "paid", 11500]);
});

test("a period change by deleting the item and adding one (Python's items[0][deleted]=True); mixed periods refused", async () => {
  const t = createTwin();
  const { A, B, sub, si } = await subscribed(t);
  const yearly = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 12000, recurring: { interval: "year" }, product: A.product }, at(T0))).body;
  // Two monthly items, one moved to yearly: the result mixes periods, refused.
  const [, extra] = (await update(t, sub, { items: [{ price: B.id }], proration_behavior: "none" }, T0)).body.items.data;
  const mixed = await update(t, sub, { items: [{ id: extra.id, price: yearly.id }], billing_cycle_anchor: "now" });
  assert.equal(mixed.body.error?.message, "parity: not_implemented");
  const items = [{ id: si, deleted: "True" }, { id: extra.id, deleted: "True" }, { price: yearly.id }];
  const up = (await update(t, sub, { items, billing_cycle_anchor: "now", proration_behavior: "none" })).body;
  assert.deepEqual([up.items.data.length, up.items.data[0].price.id, up.items.data[0].current_period_end, up.quantity], [1, yearly.id, addInterval(HALF, "year"), 1]);
  const inv = (await call(t, "GET", `/v1/invoices/${up.latest_invoice}`)).body;
  assert.deepEqual([lineAmounts(inv), inv.status], [[[12000, false]], "paid"]); // none: no credit, the year in full
});
