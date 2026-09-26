// Test clocks (W4 Task 4, surface-added): CRUD and the customer cap, clock time for a clock's objects, advance limits,
// advancing -> ready, and each transition an advance runs (renewal, trial end, cancel at period end, declined renewal
// with retries), clock deletion, and the train clock templates #27, #29, #30 dry-run in-process. No sandbox clock data
// exists (B1): expectations follow the public test-clock docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildCorpus } from "../src/bench/corpus.ts";
import { encodeForm, resolveRefs } from "../src/bench/run.ts";
import { createTwin } from "../src/twin/server.ts";
import { TEMPLATES } from "../templates/index.ts";

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;
type Res = { status: number; body: Obj; headers: Record<string, string> };

const T0 = Date.parse("2026-09-26T00:00:00Z") / 1000; // Parity-Now: the wall clock of everything not on a clock
const F0 = Date.parse("2026-10-01T00:00:00Z") / 1000; // the clocks' starting frozen time
const END = Date.parse("2026-11-01T00:00:00Z") / 1000; // a monthly subscription's first period end
const DAY = 86400;
const HOUR = 3600;

const call = (t: Twin, method: string, path: string, params?: Obj) => {
  const form = params ? encodeForm(params) : "";
  const post = method === "POST";
  const headers = { Authorization: "Bearer sk_test_parity", "Parity-Now": String(T0) };
  return t.handle({ method, path, query: post ? "" : form, body: post ? form : "", headers }) as Promise<Res>;
};
const cell = (r: Res) => (r.body.error ? `${r.status} ${r.body.error.code ?? r.body.error.type} ${r.headers["Parity-Error-Key"]}` : String(r.status));
/** `type@created` of the events after the first `from`, in log order. */
const stamped = (t: Twin, from: number) => t.store.events.slice(from).map((e) => `${e.type}@${e.created}`);
const clock = (t: Twin, params: Obj = { frozen_time: F0 }) => call(t, "POST", "/v1/test_helpers/test_clocks", params);
const advance = (t: Twin, ck: Obj, frozen_time: number) => call(t, "POST", `/v1/test_helpers/test_clocks/${ck.id}/advance`, { frozen_time });
const get = async (t: Twin, path: string, params?: Obj) => (await call(t, "GET", path, params)).body;

/** A clock at F0, a customer on it with `card` attached, and a subscription to 1000 usd per `interval` paid by it. */
async function clockSub(t: Twin, sub: Obj = {}, opts: { card?: string; interval?: string } = {}) {
  const ck = (await clock(t)).body;
  const c = (await call(t, "POST", "/v1/customers", { test_clock: ck.id })).body;
  const pm = (await call(t, "POST", `/v1/payment_methods/${opts.card ?? "pm_card_visa"}/attach`, { customer: c.id })).body;
  const recurring = { interval: opts.interval ?? "month" };
  const price = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 1000, recurring, product_data: { name: "Plan" } })).body;
  const s = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: price.id }], default_payment_method: pm.id, ...sub })).body;
  return { ck, c, pm, price, s };
}

test("clocks: create, retrieve, list; a customer on a clock (at most 3) is listed only by its clock", async () => {
  const t = createTwin();
  const r = await clock(t, { frozen_time: F0, name: "Annual renewal" });
  const ck = r.body;
  assert.equal(r.status, 200);
  assert.match(ck.id, /^clock_[A-Za-z0-9]{24}$/);
  // The clock itself lives in real time: created now, deleted automatically 30 days later (docs).
  const fields = [ck.object, ck.created, ck.deletes_after, ck.frozen_time, ck.name, ck.status, ck.status_details, ck.livemode];
  assert.deepEqual(fields, ["test_helpers.test_clock", T0, T0 + 30 * DAY, F0, "Annual renewal", "ready", {}, false]);
  assert.deepEqual(stamped(t, 0), [`test_helpers.test_clock.created@${T0}`]);
  assert.deepEqual(await get(t, `/v1/test_helpers/test_clocks/${ck.id}`), ck);
  assert.deepEqual((await get(t, "/v1/test_helpers/test_clocks")).data, [ck]);
  assert.equal(cell(await clock(t, {})), "400 parameter_missing parameter_missing");
  assert.equal(cell(await call(t, "GET", "/v1/test_helpers/test_clocks/clock_Missing")), "404 resource_missing resource_missing");

  const make = () => call(t, "POST", "/v1/customers", { test_clock: ck.id, email: "clock@example.com" });
  const cs = [(await make()).body, (await make()).body, (await make()).body];
  // A clock's customer is created at the clock's frozen time.
  assert.deepEqual(cs.map((c) => [c.test_clock, c.created]), Array(3).fill([ck.id, F0]));
  const fourth = await make();
  assert.equal(cell(fourth), "400 invalid_request_error test_clock_customer_limit");
  assert.equal(fourth.body.error.param, "test_clock");
  const missing = await call(t, "POST", "/v1/customers", { test_clock: "clock_Missing" });
  assert.deepEqual([cell(missing), missing.body.error.param], ["400 resource_missing resource_missing_400", "test_clock"]);

  // Docs: the list leaves out a clock's customers unless given its test_clock.
  const plain = (await call(t, "POST", "/v1/customers", { email: "clock@example.com" })).body;
  assert.deepEqual([plain.test_clock, plain.created], [null, T0]);
  assert.deepEqual((await get(t, "/v1/customers", { email: "clock@example.com" })).data.map((c: Obj) => c.id), [plain.id]);
  assert.deepEqual((await get(t, "/v1/customers", { test_clock: ck.id })).data.map((c: Obj) => c.id).sort(), cs.map((c) => c.id).sort());
  // A deleted customer frees its place.
  await call(t, "DELETE", `/v1/customers/${cs[0]!.id}`);
  assert.equal((await make()).status, 200);
});

test("a clock's subscription, invoice and payment run at the clock's frozen time; other objects at Parity-Now", async () => {
  const t = createTwin();
  const { c, s, price } = await clockSub(t);
  assert.equal(price.created, T0);
  const item = s.items.data[0];
  assert.deepEqual([s.test_clock, s.created, s.start_date, s.billing_cycle_anchor, item.current_period_start, item.current_period_end], [c.test_clock, F0, F0, F0, F0, END]);
  const inv = await get(t, `/v1/invoices/${s.latest_invoice}`);
  assert.deepEqual([inv.test_clock, inv.created, inv.status, inv.status_transitions.paid_at], [c.test_clock, F0, "paid", F0]);
  const at = Object.fromEntries(t.store.events.map((e) => [e.type, e.created]));
  assert.deepEqual([at["product.created"], at["price.created"]], [T0, T0]);
  for (const type of ["customer.created", "payment_method.attached", "customer.subscription.created", "invoice.paid", "charge.succeeded"]) assert.equal(at[type], F0, type);
});

test("advance: later than the frozen time, at most two intervals of the shortest price ahead (two years without subscriptions)", async () => {
  const t = createTwin();
  const ck = (await clock(t)).body;
  assert.equal(cell(await advance(t, ck, F0)), "400 invalid_request_error test_clock_frozen_time_not_after");
  assert.equal(cell(await advance(t, ck, F0 - 1)), "400 invalid_request_error test_clock_frozen_time_not_after");
  assert.equal(cell(await call(t, "POST", `/v1/test_helpers/test_clocks/${ck.id}/advance`, {})), "400 parameter_missing parameter_missing");
  const twoYears = Date.parse("2028-10-01T00:00:00Z") / 1000;
  const far = await advance(t, ck, twoYears + 1);
  assert.deepEqual([cell(far), far.body.error.param], ["400 invalid_request_error test_clock_advance_too_far", "frozen_time"]);
  assert.equal((await advance(t, ck, twoYears)).status, 200);

  // A weekly and a monthly subscription on one clock: the week is the interval.
  const { ck: ck2, c } = await clockSub(t, {}, { interval: "week" });
  const monthly = (await call(t, "POST", "/v1/prices", { currency: "usd", unit_amount: 500, recurring: { interval: "month" }, product_data: { name: "M" } })).body;
  assert.equal((await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: monthly.id }] })).status, 200);
  assert.equal(cell(await advance(t, ck2, F0 + 14 * DAY + 1)), "400 invalid_request_error test_clock_advance_too_far");
  assert.equal((await advance(t, ck2, F0 + 14 * DAY)).status, 200);
});

test("an advance answers advancing at the old frozen time; reads show ready at the new one 1 s later (wall clock)", async () => {
  const t = createTwin();
  const ck = (await clock(t)).body;
  const r = await advance(t, ck, F0 + DAY);
  const advancing = { ...ck, status: "advancing", status_details: { advancing: { target_frozen_time: F0 + DAY } } };
  assert.deepEqual(r.body, advancing);
  assert.deepEqual(await get(t, `/v1/test_helpers/test_clocks/${ck.id}`), advancing);
  assert.deepEqual((await get(t, "/v1/test_helpers/test_clocks")).data, [advancing]);
  await sleep(1050);
  const ready = { ...ck, frozen_time: F0 + DAY, status: "ready", status_details: {} };
  assert.deepEqual(await get(t, `/v1/test_helpers/test_clocks/${ck.id}`), ready);
  assert.deepEqual(t.store.events.slice(1).map((e) => [e.type, e.data.object.status]), [["test_helpers.test_clock.advancing", "advancing"], ["test_helpers.test_clock.ready", "ready"]]);
});

test("renewal: a draft at the period end with the pending items swept in, finalized and paid an hour later; events at clock time", async () => {
  const t = createTwin();
  const { ck, s, pm } = await clockSub(t);
  // Quantity 2 at F0: a pending credit (-1000) and debit (+2000) for the first period.
  await call(t, "POST", `/v1/subscriptions/${s.id}`, { items: [{ id: s.items.data[0].id, quantity: 2 }], proration_behavior: "create_prorations" });
  const pending = t.store.events.filter((e) => e.type === "invoiceitem.created").map((e) => e.data.object.id as string);
  assert.equal(pending.length, 2);

  let from = t.store.events.length;
  assert.equal((await advance(t, ck, END)).status, 200);
  assert.deepEqual(stamped(t, from), [`test_helpers.test_clock.advancing@${T0}`, `customer.subscription.updated@${END}`, `invoice.created@${END}`, `test_helpers.test_clock.ready@${T0}`]);
  const sub = await get(t, `/v1/subscriptions/${s.id}`);
  const item = sub.items.data[0];
  assert.deepEqual([sub.status, item.current_period_start, item.current_period_end], ["active", END, Date.parse("2026-12-01T00:00:00Z") / 1000]);
  const draft = await get(t, `/v1/invoices/${sub.latest_invoice}`);
  const fields = [draft.status, draft.billing_reason, draft.created, draft.period_start, draft.period_end, draft.automatically_finalizes_at, draft.next_payment_attempt];
  assert.deepEqual(fields, ["draft", "subscription_cycle", END, F0, END, END + HOUR, END + HOUR]);
  assert.deepEqual([draft.total, draft.lines.data.map((l: Obj) => l.amount)], [3000, [-1000, 2000, 2000]]);
  assert.deepEqual([draft.status_transitions.finalized_at, draft.effective_at, draft.test_clock], [null, null, ck.id]);
  for (const id of pending) assert.equal(t.store.objects.get(id)!.invoice, draft.id);

  from = t.store.events.length;
  assert.equal((await advance(t, ck, END + HOUR)).status, 200);
  const at = END + HOUR;
  const paid = await get(t, `/v1/invoices/${draft.id}`);
  const after = [paid.status, paid.amount_paid, paid.attempt_count, paid.status_transitions.finalized_at, paid.status_transitions.paid_at, paid.automatically_finalizes_at, paid.next_payment_attempt];
  assert.deepEqual(after, ["paid", 3000, 1, at, at, null, null]);
  const events = t.store.events.slice(from + 1, -1);
  assert.deepEqual(events.map((e) => e.type).sort(), ["charge.succeeded", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded", "invoice.updated", "payment_intent.created", "payment_intent.succeeded"]);
  assert.ok(events.every((e) => e.created === at));
  const charge = events.find((e) => e.type === "charge.succeeded")!.data.object;
  assert.deepEqual([charge.amount, charge.payment_method, charge.created], [3000, pm.id, at]);
  assert.deepEqual(events.find((e) => e.type === "invoice.updated")!.data.previous_attributes!.status, "draft");
});

test("trial: trialing on a paid $0 invoice; trial_will_end 3 days before the end, then active on a draft", async () => {
  const t = createTwin();
  const { ck, s } = await clockSub(t, { trial_period_days: 7 });
  const end = F0 + 7 * DAY;
  const item = s.items.data[0];
  assert.deepEqual([s.status, s.trial_start, s.trial_end, s.billing_cycle_anchor, item.current_period_start, item.current_period_end], ["trialing", F0, end, end, F0, end]);
  const first = await get(t, `/v1/invoices/${s.latest_invoice}`);
  assert.deepEqual([first.status, first.total, first.billing_reason, first.lines.data[0].amount], ["paid", 0, "subscription_create", 0]);
  assert.equal(t.store.events.some((e) => e.type.startsWith("payment_intent.") || e.type.startsWith("charge.")), false);
  // Items cannot change during a trial (unobserved), cancel_at_period_end can.
  const swap = await call(t, "POST", `/v1/subscriptions/${s.id}`, { items: [{ id: item.id, quantity: 2 }] });
  assert.equal(cell(swap), "400 invalid_request_error not_implemented");

  let from = t.store.events.length;
  await advance(t, ck, F0 + 5 * DAY);
  assert.deepEqual(stamped(t, from).slice(1, -1), [`customer.subscription.trial_will_end@${end - 3 * DAY}`]);
  assert.equal((await get(t, `/v1/subscriptions/${s.id}`)).status, "trialing");

  from = t.store.events.length;
  await advance(t, ck, end);
  assert.deepEqual(stamped(t, from).slice(1, -1), [`customer.subscription.updated@${end}`, `invoice.created@${end}`]);
  const sub = await get(t, `/v1/subscriptions/${s.id}`);
  const next = sub.items.data[0];
  assert.deepEqual([sub.status, sub.trial_end, next.current_period_start, next.current_period_end], ["active", end, end, Date.parse("2026-11-08T00:00:00Z") / 1000]);
  assert.deepEqual(t.store.events.at(-3)!.data.previous_attributes!.status, "trialing");
  const draft = await get(t, `/v1/invoices/${sub.latest_invoice}`);
  assert.deepEqual([draft.status, draft.total, draft.billing_reason, draft.automatically_finalizes_at], ["draft", 1000, "subscription_cycle", end + HOUR]);
});

test("cancel_at_period_end: canceled at the period end (canceled_at stays the request's time), nothing renewed", async () => {
  const t = createTwin();
  const { ck, c, s } = await clockSub(t);
  const set = (await call(t, "POST", `/v1/subscriptions/${s.id}`, { cancel_at_period_end: true })).body;
  assert.deepEqual([set.cancel_at, set.canceled_at], [END, F0]);
  const from = t.store.events.length;
  await advance(t, ck, END + DAY);
  assert.deepEqual(stamped(t, from).slice(1, -1), [`customer.subscription.deleted@${END}`]);
  const sub = await get(t, `/v1/subscriptions/${s.id}`);
  assert.deepEqual([sub.status, sub.ended_at, sub.canceled_at, sub.cancellation_details.reason], ["canceled", END, F0, "cancellation_requested"]);
  assert.equal((await get(t, "/v1/invoices", { customer: c.id })).data.length, 1);
});

test("declined renewal: open, past_due, a retry every 2 days on the same payment intent; the 8th failure cancels", async () => {
  const t = createTwin();
  const { ck, c, s } = await clockSub(t);
  const bad = (await call(t, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: c.id })).body;
  await call(t, "POST", `/v1/subscriptions/${s.id}`, { default_payment_method: bad.id });
  const first = END + HOUR;

  // One advance runs both transitions in time order: the renewal draft at END, its failed charge an hour later.
  let from = t.store.events.length;
  await advance(t, ck, first);
  const log = stamped(t, from);
  assert.deepEqual(log.slice(1, 3), [`customer.subscription.updated@${END}`, `invoice.created@${END}`]);
  const failing = log.slice(3, -1);
  const expected = ["charge.failed", "customer.subscription.updated", "invoice.finalized", "invoice.payment_failed", "invoice.updated", "payment_intent.created", "payment_intent.payment_failed"];
  assert.deepEqual(failing.map((e) => e.split("@")[0]).sort(), expected);
  assert.ok(failing.every((e) => e.endsWith(`@${first}`)));
  let sub = await get(t, `/v1/subscriptions/${s.id}`);
  let inv = await get(t, `/v1/invoices/${sub.latest_invoice}`);
  assert.equal(sub.status, "past_due");
  assert.deepEqual([inv.status, inv.attempted, inv.attempt_count, inv.next_payment_attempt, inv.amount_remaining], ["open", true, 1, first + 2 * DAY, 1000]);

  from = t.store.events.length;
  await advance(t, ck, first + 14 * DAY);
  const retries = t.store.events.slice(from).filter((e) => e.type === "charge.failed").map((e) => e.created);
  assert.deepEqual(retries, [1, 2, 3, 4, 5, 6, 7].map((k) => first + k * 2 * DAY));
  assert.equal(t.store.events.slice(from).some((e) => e.type === "payment_intent.created"), false);
  sub = await get(t, `/v1/subscriptions/${s.id}`);
  inv = await get(t, `/v1/invoices/${inv.id}`);
  const ended = first + 14 * DAY;
  assert.deepEqual([sub.status, sub.canceled_at, sub.ended_at, sub.cancellation_details.reason], ["canceled", ended, ended, "payment_failed"]);
  assert.deepEqual([inv.status, inv.attempt_count, inv.next_payment_attempt, inv.auto_advance], ["open", 8, null, false]);
  assert.equal(t.store.events.at(-2)!.type, "customer.subscription.deleted");
});

test("declined renewal recovered: the next retry charges the subscription's new default card and makes it active", async () => {
  const t = createTwin();
  const { ck, c, s, pm } = await clockSub(t);
  const bad = (await call(t, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: c.id })).body;
  await call(t, "POST", `/v1/subscriptions/${s.id}`, { default_payment_method: bad.id });
  await advance(t, ck, END + HOUR);
  await call(t, "POST", `/v1/subscriptions/${s.id}`, { default_payment_method: pm.id });
  const retry = END + HOUR + 2 * DAY;
  const from = t.store.events.length;
  await advance(t, ck, retry);
  const sub = await get(t, `/v1/subscriptions/${s.id}`);
  const inv = await get(t, `/v1/invoices/${sub.latest_invoice}`);
  assert.deepEqual([sub.status, inv.status, inv.attempt_count, inv.next_payment_attempt, inv.status_transitions.paid_at], ["active", "paid", 2, null, retry]);
  const types = t.store.events.slice(from + 1, -1).map((e) => e.type).sort();
  assert.deepEqual(types, ["charge.succeeded", "customer.subscription.updated", "invoice.paid", "invoice.payment_succeeded", "invoice.updated", "payment_intent.succeeded"]);
});

test("a canceled subscription's open invoice is not retried", async () => {
  const t = createTwin();
  const { ck, c, s } = await clockSub(t);
  const bad = (await call(t, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: c.id })).body;
  await call(t, "POST", `/v1/subscriptions/${s.id}`, { default_payment_method: bad.id });
  await advance(t, ck, END + HOUR);
  assert.equal((await call(t, "DELETE", `/v1/subscriptions/${s.id}`)).status, 200);
  const from = t.store.events.length;
  await advance(t, ck, END + HOUR + 14 * DAY);
  assert.deepEqual(t.store.events.slice(from).map((e) => e.type), ["test_helpers.test_clock.advancing", "test_helpers.test_clock.ready"]);
});

test("deleting a clock deletes its customers and cancels their subscriptions; other clocks stay", async () => {
  const t = createTwin();
  const { ck, c, s } = await clockSub(t);
  const other = await clockSub(t);
  const from = t.store.events.length;
  const r = await call(t, "DELETE", `/v1/test_helpers/test_clocks/${ck.id}`);
  assert.deepEqual(r.body, { deleted: true, id: ck.id, object: "test_helpers.test_clock" });
  assert.deepEqual(stamped(t, from).map((e) => e.split("@")[0]), ["customer.subscription.deleted", "customer.deleted", "test_helpers.test_clock.deleted"]);
  assert.equal(cell(await call(t, "GET", `/v1/test_helpers/test_clocks/${ck.id}`)), "404 resource_missing resource_missing");
  assert.deepEqual(await get(t, `/v1/customers/${c.id}`), { deleted: true, id: c.id, object: "customer" });
  const sub = await get(t, `/v1/subscriptions/${s.id}`);
  assert.deepEqual([sub.status, sub.ended_at], ["canceled", F0]);
  assert.equal((await get(t, `/v1/subscriptions/${other.s.id}`)).status, "active");
  assert.deepEqual((await get(t, "/v1/subscriptions", { test_clock: other.ck.id })).data.map((x: Obj) => x.id), [other.s.id]);
  assert.deepEqual((await get(t, "/v1/test_helpers/test_clocks")).data.map((k: Obj) => k.id), [other.ck.id]);
});

// Train templates only: held-out #28 runs against the twin through score-twin alone (plan: held-out integrity).
const CORPUS = buildCorpus(TEMPLATES.filter((t) => ["clock-period-rollover", "clock-cancel-at-period-end", "clock-declined-renewal"].includes(t.name)), [1, 2, 3, 4]);
for (const seq of CORPUS) {
  test(`${seq.id}: dry-run against the twin (waits skipped): every step 200 and the documented end state`, async () => {
    const t = createTwin();
    const bound: Obj = {};
    const steps: Res[] = [];
    for (const s of seq.steps) {
      const r = await call(t, s.method, String(resolveRefs(s.path, bound, "nonce")), s.params && (resolveRefs(s.params, bound, "nonce") as Obj));
      if (s.ref) bound[s.ref] = r.body;
      steps.push(r);
    }
    assert.deepEqual(steps.map(cell), Array(steps.length).fill("200"));
    // The end state, from the template's last subscription retrieve and invoice list (the clock's delete comes last).
    const sub = steps.find((_, i) => seq.steps[i]!.path === "/v1/subscriptions/$s1.id" && seq.steps[i]!.method === "GET")!.body;
    const invoices = steps.findLast((_, i) => seq.steps[i]!.path === "/v1/invoices")!.body.data as Obj[];
    if (seq.template === "clock-period-rollover") {
      assert.deepEqual([sub.status, invoices.map((i) => [i.billing_reason, i.status])], ["active", [["subscription_cycle", "paid"], ["subscription_create", "paid"]]]);
    } else if (seq.template === "clock-cancel-at-period-end") {
      assert.deepEqual([sub.status, invoices.length], ["canceled", 1]);
    } else {
      assert.deepEqual([sub.status, invoices[0]!.status, invoices[0]!.attempt_count], ["past_due", "open", 1]);
    }
    assert.equal(steps.at(-1)!.body.deleted, true);
  });
}
