// Twin fixes from the final review (2026-09-26): customer delete cancels its subscriptions (#26), decimal prices
// (#20), detached payment methods are never charged, month-end anchors keep their day, search range clauses (#23),
// expanding a field removed at basil (#22), handler validation errors free the idempotency key, UTF-8 bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeForm } from "../src/bench/run.ts";
import { createTwin } from "../src/twin/server.ts";

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;
type Res = { status: number; body: Obj; headers: Record<string, string> };

const T0 = Date.parse("2026-09-26T00:00:00Z") / 1000;
const DAY = 86400;
const HOUR = 3600;

const call = (t: Twin, method: string, path: string, params?: Obj, headers: Obj = {}) => {
  const form = params ? encodeForm(params) : "";
  const post = method === "POST";
  const h = { Authorization: "Bearer sk_test_parity", "Parity-Now": String(T0), ...headers };
  return t.handle({ method, path, query: post ? "" : form, body: post ? form : "", headers: h }) as Promise<Res>;
};
const key = (r: Res) => r.headers["Parity-Error-Key"];
const price = async (t: Twin, p: Obj) => call(t, "POST", "/v1/prices", { currency: "usd", product_data: { name: "P" }, ...p });

/** A customer with pm_card_visa as its default, and a monthly subscription at `unit` (or `p`) on it. */
async function subscribed(t: Twin, p: Obj = { unit_amount: 1000 }, customer: Obj = {}) {
  const c = (await call(t, "POST", "/v1/customers", customer)).body;
  const pm = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: c.id })).body;
  await call(t, "POST", `/v1/customers/${c.id}`, { invoice_settings: { default_payment_method: pm.id } });
  const pr = (await price(t, { recurring: { interval: "month" }, ...p })).body;
  const s = await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: pr.id }], expand: ["latest_invoice"] });
  return { c, pm, pr, s };
}

test("deleting a customer cancels its subscriptions first (observed #26); the stale subscription cannot bill the tombstone", async () => {
  const t = createTwin();
  const { c, s } = await subscribed(t);
  const from = t.store.events.length;
  assert.equal((await call(t, "DELETE", `/v1/customers/${c.id}`)).status, 200);
  assert.deepEqual(t.store.events.slice(from).map((e) => e.type), ["customer.subscription.deleted", "customer.deleted"]);
  const sub = (await call(t, "GET", `/v1/subscriptions/${s.body.id}`)).body;
  assert.deepEqual([sub.status, sub.canceled_at, sub.ended_at, sub.cancellation_details.reason], ["canceled", T0, T0, "cancellation_requested"]);
  // An item swap with an immediate invoice on it is refused, and nothing is written back.
  const other = (await price(t, { unit_amount: 2000, recurring: { interval: "month" } })).body;
  const r = await call(t, "POST", `/v1/subscriptions/${sub.id}`, { items: [{ id: sub.items.data[0].id, price: other.id }], proration_behavior: "always_invoice" });
  assert.equal(r.status, 400);
  assert.equal((await call(t, "GET", "/v1/customers")).body.data.length, 0, "the deleted customer is not back in the list");
});

test("decimal prices (observed #20): stored as sent, billed from the decimal; one of the two, max amount, 12 places", async () => {
  const t = createTwin();
  const d = await price(t, { unit_amount_decimal: "1234.56" });
  assert.deepEqual([d.status, d.body.unit_amount, d.body.unit_amount_decimal], [200, null, "1234.56"]);
  const i = await price(t, { unit_amount: 99_999_999_999_999 });
  assert.deepEqual([i.status, i.body.unit_amount_decimal], [200, "99999999999999"]);
  const errs = [
    [{ unit_amount: 100_000_000_000_000 }, "unit_amount_too_large", "parameter_invalid_integer", "unit_amount"],
    [{ unit_amount_decimal: "0.0000000000001" }, "decimal_too_precise", undefined, "unit_amount_decimal"],
    [{ unit_amount: 5, unit_amount_decimal: "7.5" }, "unit_amount_exclusive", undefined, "unit_amount"],
  ] as const;
  for (const [p, k, code, param] of errs) {
    const r = await price(t, p);
    assert.deepEqual([r.status, key(r), r.body.error.code, r.body.error.param], [400, k, code, param], k);
  }
  // A subscription on a decimal-only price bills it (rounded to the minor unit) and charges the card.
  const { s } = await subscribed(t, { unit_amount_decimal: "1999.4" });
  const inv = s.body.latest_invoice;
  assert.deepEqual([s.body.status, inv.total, inv.amount_paid, inv.status], ["active", 1999, 1999, "paid"]);
  assert.equal(t.store.events.filter((e) => e.type === "charge.succeeded").at(-1)!.data.object.amount, 1999);
});

test("a detached payment method is never charged: a clock renewal fails over it, pay refuses it", async () => {
  const t = createTwin();
  const F0 = Date.parse("2026-10-01T00:00:00Z") / 1000;
  const ck = (await call(t, "POST", "/v1/test_helpers/test_clocks", { frozen_time: F0 })).body;
  const c = (await call(t, "POST", "/v1/customers", { test_clock: ck.id })).body;
  const pm = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: c.id })).body;
  const pr = (await price(t, { unit_amount: 1000, recurring: { interval: "month" } })).body;
  const s = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: pr.id }], default_payment_method: pm.id })).body;
  assert.equal((await call(t, "POST", `/v1/payment_methods/${pm.id}/detach`)).status, 200);
  const charges = () => t.store.events.filter((e) => e.type === "charge.succeeded").length;
  const before = charges();
  const end = s.items.data[0].current_period_end;
  assert.equal((await call(t, "POST", `/v1/test_helpers/test_clocks/${ck.id}/advance`, { frozen_time: end + 2 * HOUR })).status, 200);
  assert.equal(charges(), before, "no charge on the detached card");
  const renewal = (await call(t, "GET", "/v1/invoices", { customer: c.id })).body.data[0];
  assert.deepEqual([renewal.billing_reason, renewal.status], ["subscription_cycle", "open"]);
  assert.equal((await call(t, "GET", `/v1/subscriptions/${s.id}`)).body.status, "past_due");
  const pay = await call(t, "POST", `/v1/invoices/${renewal.id}/pay`);
  assert.deepEqual([pay.status, key(pay)], [400, "customer_no_payment_method"]);
  assert.equal(charges(), before);
});

test("a month-end anchor keeps its day across renewals (docs): Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31", async () => {
  const t = createTwin();
  const at = (d: string) => Date.parse(`2026-${d}T12:00:00Z`) / 1000;
  const ck = (await call(t, "POST", "/v1/test_helpers/test_clocks", { frozen_time: at("01-31") })).body;
  const c = (await call(t, "POST", "/v1/customers", { test_clock: ck.id })).body;
  const pm = (await call(t, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: c.id })).body;
  const pr = (await price(t, { unit_amount: 1000, recurring: { interval: "month" } })).body;
  const s = (await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: pr.id }], default_payment_method: pm.id })).body;
  const ends = [s.items.data[0].current_period_end];
  for (let i = 0; i < 3; i++) {
    // The renewal preview projects the same next end the renewal will set.
    const preview = (await call(t, "POST", "/v1/invoices/create_preview", { subscription: s.id })).body;
    const projected = preview.lines.data.at(-1).period.end;
    await call(t, "POST", `/v1/test_helpers/test_clocks/${ck.id}/advance`, { frozen_time: ends.at(-1) + 2 * HOUR });
    const next = (await call(t, "GET", `/v1/subscriptions/${s.id}`)).body.items.data[0].current_period_end;
    assert.equal(projected, next);
    ends.push(next);
  }
  assert.deepEqual(ends, [at("02-28"), at("03-31"), at("04-30"), at("05-31")]);
});

test("customer search: numeric range clauses (created>=<epoch>, observed #23) with AND", async () => {
  const t = createTwin();
  const mk = async (email: string, now: number) => (await call(t, "POST", "/v1/customers", { email }, { "Parity-Now": String(now) })).body;
  const a = await mk("x@example.com", T0);
  const b = await mk("x@example.com", T0 + 10);
  await mk("y@example.com", T0 + 20);
  const ids = async (query: string) => {
    const r = await call(t, "GET", "/v1/customers/search", { query });
    assert.equal(r.status, 200, query);
    return r.body.data.map((o: Obj) => o.id);
  };
  assert.deepEqual(await ids(`email:'x@example.com' AND created>=${T0 + 10}`), [b.id]);
  assert.deepEqual(await ids(`email:'x@example.com' AND created>${T0}`), [b.id]);
  assert.deepEqual(await ids(`email:'x@example.com' AND created<${T0 + 10}`), [a.id]);
  assert.deepEqual(await ids(`email:'x@example.com' AND created<=${T0 + 10}`), [b.id, a.id]);
  assert.equal(key(await call(t, "GET", "/v1/customers/search", { query: "created>=abc" })), "search_query_invalid");
});

test("expand: a field removed at basil is ignored (observed #22); other missing fields stay 400; depth checked first", async () => {
  const t = createTwin();
  const { c, pr } = await subscribed(t);
  const r = await call(t, "POST", "/v1/subscriptions", { customer: c.id, items: [{ price: pr.id }], expand: ["latest_invoice.payment_intent"] });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.latest_invoice, "object");
  assert.equal(Object.hasOwn(r.body.latest_invoice, "payment_intent"), false);
  assert.equal((await call(t, "GET", "/v1/subscriptions", { customer: c.id })).body.data.length, 2, "the subscription was created");
  for (const p of ["plan_details", "latest_invoice.plan_details"]) {
    assert.equal(key(await call(t, "GET", `/v1/subscriptions/${r.body.id}`, { expand: [p] })), "expand_invalid", p);
  }
  // An invalid path and a too-deep one: the depth error, whichever comes first.
  for (const expand of [["plan_details", "a.b.c.d.e"], ["a.b.c.d.e", "plan_details"]]) {
    assert.equal(key(await call(t, "GET", `/v1/subscriptions/${r.body.id}`, { expand })), "expand_too_deep");
  }
});

test("idempotency: a handler's parameter error is not stored, so a fixed retry with the same key runs", async () => {
  const t = createTwin();
  const K = { "Idempotency-Key": "k-price" };
  const bad = await call(t, "POST", "/v1/prices", { product_data: { name: "P" }, unit_amount: 100 }, K); // no currency
  assert.deepEqual([bad.status, key(bad)], [400, "parameter_missing"]);
  const ok = await call(t, "POST", "/v1/prices", { currency: "usd", product_data: { name: "P" }, unit_amount: 100 }, K);
  assert.deepEqual([ok.status, ok.headers["Idempotent-Replayed"]], [200, undefined]);
});

test("HTTP: a multi-byte character split across body chunks decodes whole", async () => {
  const t = createTwin();
  const server = await t.listen(0);
  try {
    const body = Buffer.from("name=Zoë+Ångström"); // raw UTF-8, not percent-encoded (clients may send either)
    const cut = body.indexOf(Buffer.from("ë")) + 1; // inside the two bytes of ë
    const res = await new Promise<Obj>((resolve, reject) => {
      const req = request({ port: (server.address() as AddressInfo).port, method: "POST", path: "/v1/customers", headers: { authorization: "Bearer sk_test_parity", "content-type": "application/x-www-form-urlencoded" } }, (r) => {
        let s = "";
        r.setEncoding("utf8").on("data", (d) => (s += d)).on("end", () => resolve(JSON.parse(s)));
      });
      req.on("error", reject);
      req.write(body.subarray(0, cut));
      setTimeout(() => req.end(body.subarray(cut)), 20);
    });
    assert.equal(res.name, "Zoë Ångström");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
