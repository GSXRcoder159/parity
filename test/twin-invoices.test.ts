// Invoice lifecycle (W4 Task 3, surface-added): the train templates #19 and #11 run in-process against the sandbox
// observations (templates-validation.md), then the state machine off the observed path (drafts, refused transitions,
// updates, paying with the default payment method, balances) and the Python booleans True/False.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpus } from "../src/bench/corpus.ts";
import { encodeForm, resolveRefs } from "../src/bench/run.ts";
import { CATALOG, TwinError } from "../src/twin/errors.ts";
import { createTwin } from "../src/twin/server.ts";
import { validate } from "../src/twin/validate.ts";
import { TEMPLATES } from "../templates/index.ts";

/** The catalog's current message for `key`: messages are the align loop's to seed (decision 0002 §4.3), so tests never pin the placeholder. */
const msg = (key: string): string => CATALOG[key]!.message;

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;
type Res = { status: number; body: Obj };

const T0 = Date.parse("2026-09-26T00:00:00Z") / 1000;
const DAY = 86400;
const at = (t: number) => ({ "Parity-Now": String(t) });

const call = (t: Twin, method: string, path: string, params?: Obj, headers: Obj = at(T0)) => {
  const form = params ? encodeForm(params) : "";
  const post = method === "POST";
  const req = { method, path, query: post ? "" : form, body: post ? form : "", headers: { Authorization: "Bearer sk_test_parity", ...headers } };
  return t.handle(req) as Promise<Res>;
};
const cell = (r: Res) => (r.body.error ? `${r.status} ${r.body.error.code ?? r.body.error.type}` : String(r.status));
const types = (t: Twin, from = 0) => t.store.events.slice(from).map((e) => e.type).sort();
const objects = (t: Twin, type: string, from = 0) => t.store.events.slice(from).filter((e) => e.type === type).map((e) => e.data.object as Obj);

const CORPUS = buildCorpus(
  TEMPLATES.filter((t) => t.name === "invoice-send-invoice" || t.name === "resource-missing"),
  [1, 2, 3, 4],
);
async function run(id: string) {
  const seq = CORPUS.find((s) => s.id === id) ?? assert.fail(`no sequence ${id}`);
  const twin = createTwin();
  const bound: Obj = {};
  const steps: (Res & { path: string })[] = [];
  for (const s of seq.steps) {
    const path = String(resolveRefs(s.path, bound, "nonce"));
    const r = await call(twin, s.method, path, s.params && (resolveRefs(s.params, bound, "nonce") as Obj));
    if (s.ref) bound[s.ref] = r.body;
    steps.push({ ...r, path });
  }
  return { twin, bound, steps };
}

// The event sets of #19 in templates-validation.md, per branch.
const SETUP = ["customer.created", "customer.subscription.created", "customer.updated", "invoice.created", "plan.created", "price.created", "product.created"];
const FINALIZED = ["invoice.finalized", "invoice.updated", "payment_intent.created"];

for (const seed of [1, 2, 3, 4]) {
  test(`#19 invoice-send-invoice#${seed}: draft, finalize, pay out of band or void, then the other action is refused`, async () => {
    const { twin, bound, steps } = await run(`invoice-send-invoice#${seed}`);
    assert.deepEqual(steps.map(cell), ["200", "200", "200", "200", "200", "200", "400 invalid_request_error"]);
    const [amount, days] = [bound.pr1.unit_amount, bound.s1.days_until_due];
    assert.deepEqual([bound.s1.status, bound.s1.collection_method], ["active", "send_invoice"]);

    // The first invoice is left a draft: due in days_until_due, finalized automatically 72 h after creation.
    const [draft] = objects(twin, "invoice.created");
    assert.deepEqual([draft!.id, draft!.status, draft!.auto_advance, draft!.amount_due, draft!.due_date], [bound.s1.latest_invoice, "draft", true, amount, T0 + days * DAY]);
    assert.deepEqual([draft!.automatically_finalizes_at, draft!.effective_at, draft!.ending_balance, draft!.status_transitions.finalized_at], [T0 + 3 * DAY, null, null, null]);

    const fin = steps[3]!.body;
    assert.deepEqual([fin.status, fin.effective_at, fin.status_transitions.finalized_at, fin.automatically_finalizes_at, fin.ending_balance], ["open", T0, T0, null, 0]);
    assert.deepEqual([fin.amount_due, fin.amount_remaining, fin.due_date, fin.billing_reason], [amount, amount, T0 + days * DAY, "subscription_create"]);
    const finalizing = twin.store.events.find((e) => e.type === "invoice.updated")!.data.previous_attributes as Obj;
    assert.deepEqual([finalizing.status, finalizing.status_transitions, finalizing.automatically_finalizes_at], ["draft", { finalized_at: null }, T0 + 3 * DAY]);
    const [pi] = objects(twin, "payment_intent.created");
    assert.deepEqual([pi!.amount, pi!.status, pi!.payment_details.order_reference], [amount, "requires_payment_method", fin.id]);

    const paidFirst = steps[4]!.path.endsWith("/pay");
    const after = steps[4]!.body;
    assert.deepEqual(steps[5]!.body, after); // the retrieve sees the transition
    assert.deepEqual([after.auto_advance, after.attempted, after.attempt_count], [false, false, 0]);
    const [cancel] = objects(twin, "payment_intent.canceled");
    assert.deepEqual([cancel!.id, cancel!.status, cancel!.canceled_at], [pi!.id, "canceled", T0]);
    const err = steps[6]!.body.error;
    assert.deepEqual([err.code, err.param], [undefined, undefined]);
    if (paidFirst) {
      assert.deepEqual([after.status, after.amount_paid, after.amount_remaining, after.status_transitions.paid_at, after.status_transitions.voided_at], ["paid", amount, 0, T0, null]);
      assert.equal(cancel!.cancellation_reason, "duplicate");
      assert.equal(err.message, msg("invoice_void_paid"));
      assert.deepEqual(types(twin), [...SETUP, ...FINALIZED, "invoice.paid", "invoice.payment_succeeded", "invoice.updated", "payment_intent.canceled"].sort());
    } else {
      assert.deepEqual([after.status, after.amount_paid, after.amount_remaining, after.status_transitions.voided_at, after.status_transitions.paid_at], ["void", 0, amount, T0, null]);
      assert.equal(cancel!.cancellation_reason, "void_invoice");
      assert.equal(err.message, msg("invoice_pay_voided"));
      assert.deepEqual(types(twin), [...SETUP, ...FINALIZED, "invoice.updated", "invoice.voided", "payment_intent.canceled"].sort());
    }
    // The refused action changed nothing.
    assert.deepEqual((await call(twin, "GET", `/v1/invoices/${fin.id}`)).body, after);
  });
}

for (const seed of [1, 2]) {
  test(`#11 resource-missing#${seed}: missing invoices answer 404 resource_missing, param invoice (id on POST)`, async () => {
    const { steps } = await run(`resource-missing#${seed}`);
    assert.deepEqual(steps.map(cell), Array(11).fill("404 resource_missing"));
    assert.deepEqual(steps.slice(-3).map((s) => s.body.error.param), ["invoice", "id", "invoice"]);
  });
}

/** A customer (optionally with a default card and a balance), a 1500/month price, and a subscription on it. */
async function subscribe(t: Twin, opts: { card?: string; balance?: number; collection?: "send_invoice"; behavior?: string } = {}) {
  const c = (await call(t, "POST", "/v1/customers", opts.balance ? { balance: opts.balance } : {})).body;
  if (opts.card) {
    const pm = (await call(t, "POST", `/v1/payment_methods/${opts.card}/attach`, { customer: c.id })).body;
    await call(t, "POST", `/v1/customers/${c.id}`, { invoice_settings: { default_payment_method: pm.id } });
  }
  const price = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 1500, recurring: { interval: "month" }, product_data: { name: "P" } })).body;
  const extra = opts.collection ? { collection_method: opts.collection, days_until_due: 14 } : opts.behavior ? { payment_behavior: opts.behavior } : {};
  const sub = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }], ...extra })).body;
  return { c, sub, inv: sub.latest_invoice as string };
}
const act = (t: Twin, inv: string, a: string, params?: Obj) => call(t, "POST", `/v1/invoices/${inv}/${a}`, params);

test("paying a draft out of band finalizes it first, without a payment intent (observed)", async () => {
  const t = createTwin();
  const { inv } = await subscribe(t, { collection: "send_invoice" });
  const from = t.store.events.length;
  const r = await act(t, inv, "pay", { paid_out_of_band: true });
  assert.deepEqual([r.body.status, r.body.status_transitions.finalized_at, r.body.status_transitions.paid_at, r.body.amount_paid], ["paid", T0, T0, 1500]);
  assert.deepEqual(types(t, from), ["invoice.finalized", "invoice.paid", "invoice.payment_succeeded", "invoice.updated"]);
});

test("refused transitions leave no state behind: void a draft, pay/void/finalize twice, unimplemented params", async () => {
  const t = createTwin();
  const { inv } = await subscribe(t, { collection: "send_invoice" });
  const from = t.store.events.length;
  const draftVoid = await act(t, inv, "void");
  assert.deepEqual([cell(draftVoid), draftVoid.body.error.message], ["400 invalid_request_error", msg("invoice_not_open")]);
  const payMethod = await act(t, inv, "pay", { payment_method: "pm_card_visa" }); // only the default payment method
  assert.equal(payMethod.body.error.message, msg("not_implemented"));
  assert.equal(t.store.events.length, from);

  const { inv: a } = await subscribe(t, { collection: "send_invoice" });
  const { inv: b } = await subscribe(t, { collection: "send_invoice" });
  await act(t, a, "finalize");
  await act(t, a, "pay", { paid_out_of_band: true });
  await act(t, b, "finalize");
  await act(t, b, "void");
  const n = t.store.events.length;
  const refused = [await act(t, a, "finalize"), await act(t, a, "pay", { paid_out_of_band: true }), await act(t, b, "void"), await act(t, b, "finalize")];
  assert.deepEqual(refused.map((r) => [r.status, r.body.error.message]), Array(4).fill([400, msg("not_implemented")]));
  assert.equal(t.store.events.length, n);
  // Missing invoices: 404 with param invoice on every action.
  const missing = await Promise.all(["finalize", "pay", "void"].map((x) => act(t, "in_Missing1234567890", x)));
  assert.deepEqual(missing.map((r) => [cell(r), r.body.error.param]), Array(3).fill(["404 resource_missing", "invoice"]));
});

test("update: metadata and description on draft and open invoices; DELETE refuses subscription invoices (docs)", async () => {
  const t = createTwin();
  const { inv } = await subscribe(t, { collection: "send_invoice" });
  const from = t.store.events.length;
  const up = (await call(t, "POST", `/v1/invoices/${inv}`, { metadata: { k: "v" }, description: "memo" })).body;
  assert.deepEqual([up.metadata, up.description, up.status], [{ k: "v" }, "memo", "draft"]);
  assert.deepEqual(t.store.events.at(-1)!.data.previous_attributes, { description: null, metadata: { k: null } });
  await call(t, "POST", `/v1/invoices/${inv}`, { metadata: { k: "v" } }); // no change, no event
  assert.deepEqual(types(t, from), ["invoice.updated"]);
  await act(t, inv, "finalize");
  const open = (await call(t, "POST", `/v1/invoices/${inv}`, { metadata: { k: "" }, description: "" })).body;
  assert.deepEqual([open.metadata, open.description, open.status], [{}, null, "open"]);

  const del = await call(t, "DELETE", `/v1/invoices/${inv}`);
  assert.deepEqual([cell(del), del.body.error.message], ["400 invalid_request_error", msg("invoice_not_deletable")]);
  assert.equal((await call(t, "GET", `/v1/invoices/${inv}`)).body.status, "open");
  const footer = await call(t, "POST", `/v1/invoices/${inv}`, { footer: "x" });
  await act(t, inv, "pay", { paid_out_of_band: true });
  const n = t.store.events.length;
  const onPaid = await call(t, "POST", `/v1/invoices/${inv}`, { metadata: { k: "v" } });
  assert.deepEqual([footer, onPaid].map((r) => [r.status, r.body.error.message]), Array(2).fill([400, msg("not_implemented")]));
  assert.equal(t.store.events.length, n);
});

test("pay with the default payment method confirms the intent created at finalization", async () => {
  const t = createTwin();
  const { inv } = await subscribe(t, { card: "pm_card_visa", collection: "send_invoice" });
  const before = t.store.events.length;
  await act(t, inv, "finalize");
  const [pi] = objects(t, "payment_intent.created", before);
  const from = t.store.events.length;
  const r = (await act(t, inv, "pay")).body;
  assert.deepEqual([r.status, r.amount_paid, r.attempt_count, r.attempted, r.status_transitions.paid_at], ["paid", 1500, 1, true, T0]);
  assert.deepEqual(types(t, from), ["charge.succeeded", "invoice.paid", "invoice.payment_succeeded", "invoice.updated", "payment_intent.succeeded"]);
  const [succeeded] = objects(t, "payment_intent.succeeded", from);
  assert.deepEqual([succeeded!.id, succeeded!.amount_received, succeeded!.status], [pi!.id, 1500, "succeeded"]);
});

test("an incomplete subscription: a declined pay answers 402, a pay with a new default card activates it", async () => {
  const t = createTwin();
  const { c, sub, inv } = await subscribe(t, { card: "pm_card_chargeCustomerFail" });
  assert.equal(sub.status, "incomplete");
  const from = t.store.events.length;
  const declined = await act(t, inv, "pay");
  assert.equal(cell(declined), "402 card_declined");
  assert.deepEqual(types(t, from), ["charge.failed", "invoice.payment_failed", "invoice.updated", "payment_intent.payment_failed"]);
  const failed = (await call(t, "GET", `/v1/invoices/${inv}`)).body;
  assert.deepEqual([failed.status, failed.attempt_count, failed.amount_paid], ["open", 2, 0]);

  const visa = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: c.id })).body;
  await call(t, "POST", `/v1/customers/${c.id}`, { invoice_settings: { default_payment_method: visa.id } });
  const next = t.store.events.length;
  const r = (await act(t, inv, "pay")).body;
  assert.deepEqual([r.status, r.attempt_count], ["paid", 3]);
  assert.deepEqual(types(t, next), ["charge.succeeded", "customer.subscription.updated", "invoice.paid", "invoice.payment_succeeded", "invoice.updated", "payment_intent.succeeded"]);
  const [intent] = objects(t, "payment_intent.succeeded", next);
  assert.deepEqual([intent!.id, intent!.payment_method, intent!.last_payment_error], [objects(t, "payment_intent.created")[0]!.id, visa.id, null]);
  assert.deepEqual(t.store.events.find((e) => e.type === "customer.subscription.updated")!.data.previous_attributes, { status: "incomplete" });
  assert.equal((await call(t, "GET", `/v1/subscriptions/${sub.id}`)).body.status, "active");
  // No payment method at all: the subscription create's error.
  const { inv: bare } = await subscribe(t, { behavior: "default_incomplete" });
  const none = await act(t, bare, "pay");
  assert.deepEqual([cell(none), none.body.error.message], ["400 resource_missing", msg("customer_no_payment_method")]);
});

test("the customer's balance is consumed at finalization, not by the draft; nothing due -> paid at once", async () => {
  const t = createTwin();
  const { c, inv } = await subscribe(t, { balance: -500, collection: "send_invoice" });
  const draft = (await call(t, "GET", `/v1/invoices/${inv}`)).body;
  assert.deepEqual([draft.starting_balance, draft.amount_due, draft.ending_balance], [-500, 1000, null]);
  assert.equal((await call(t, "GET", `/v1/customers/${c.id}`)).body.balance, -500);
  const from = t.store.events.length;
  const fin = (await act(t, inv, "finalize", { auto_advance: false })).body;
  assert.deepEqual([fin.amount_due, fin.ending_balance, fin.auto_advance], [1000, 0, false]);
  assert.deepEqual(objects(t, "customer.updated", from).map((x) => x.balance), [0]);

  const { c: rich, inv: covered } = await subscribe(t, { balance: -5000, collection: "send_invoice" });
  const next = t.store.events.length;
  const zero = (await act(t, covered, "finalize")).body;
  assert.deepEqual([zero.status, zero.amount_due, zero.ending_balance], ["paid", 0, -3500]);
  assert.deepEqual(types(t, next), ["customer.updated", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded", "invoice.updated"]);
  assert.equal((await call(t, "GET", `/v1/customers/${rich.id}`)).body.balance, -3500);
});

test("form booleans accept Python's True/False (stripe-python), nothing else (unvalidated until B1)", async () => {
  const op = "post /v1/invoices/{invoice}/pay";
  assert.deepEqual([validate(op, { paid_out_of_band: "True" }), validate(op, { paid_out_of_band: "False" })], [{ paid_out_of_band: true }, { paid_out_of_band: false }]);
  for (const v of ["TRUE", "1", "yes"]) assert.throws(() => validate(op, { paid_out_of_band: v }), (e) => e instanceof TwinError && e.key === "parameter_invalid");
  const t = createTwin();
  const { inv } = await subscribe(t, { collection: "send_invoice" });
  assert.equal((await act(t, inv, "pay", { paid_out_of_band: "True" })).body.status, "paid");
});
