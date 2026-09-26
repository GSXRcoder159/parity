// Subscriptions: create (first invoice + synchronous payment), retrieve, list, update (cancel_at_period_end,
// metadata, default_payment_method, description), cancel. Item/price/quantity changes and proration are W4.
import { addInterval, attemptPayment, firstInvoice, paid } from "../billing.ts";
import { list } from "../list.ts";
import type { Ctx, Route } from "../server.ts";
import type { Emit } from "../store.ts";
import { assign, diff, live } from "./customers.ts";

type Obj = Record<string, unknown>;
const isHash = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

const find = (ctx: Ctx, id: string | undefined) => live(ctx, id, "subscription") ?? ctx.fail("resource_missing", { param: "id" });
const cancellation = (reason: string | null): Obj => ({ comment: null, feedback: null, feedback_option: null, reason });
const UPDATABLE = ["cancel_at_period_end", "default_payment_method", "description", "metadata"];

/** A `default_payment_method` param must name a payment method attached to `customer`. */
function checkPm(ctx: Ctx, pm: unknown, customer: unknown): void {
  if (typeof pm !== "string" || pm === "") return;
  const param = { param: "default_payment_method" };
  const o = live(ctx, pm, "payment_method") ?? ctx.fail("resource_missing_400", param);
  if (o.customer !== customer) ctx.fail("default_payment_method_not_attached", param);
}

/** The fields `cancel_at_period_end` sets (cancel at the item period end) or clears. */
function periodEndCancel(sub: Obj, on: boolean, now: number): Obj {
  if (!on) return { cancel_at: null, cancel_at_period_end: false, canceled_at: null, cancellation_details: cancellation(null) };
  const end = ((sub.items as Obj).data as Obj[])[0]!.current_period_end;
  return { cancel_at: end, cancel_at_period_end: true, canceled_at: now, cancellation_details: cancellation("cancellation_requested") };
}

/** The recurring price of `items[i]`: an existing price, or a new inactive one from `price_data` (pushed to `puts`). */
function itemPrice(ctx: Ctx, item: Obj, i: number, puts: Obj[]): Obj {
  const param = `items[${i}][price]`;
  let price: Obj;
  if (item.price) price = live(ctx, item.price, "price") ?? ctx.fail("resource_missing_400", { param });
  else if (isHash(item.price_data)) {
    const pd = item.price_data;
    const p = `items[${i}][price_data]`;
    for (const k of ["currency", "product", "recurring"]) if (!pd[k]) ctx.fail("parameter_missing", { param: `${p}[${k}]` });
    if (!live(ctx, pd.product, "product")) ctx.fail("resource_missing_400", { param: `${p}[product]` });
    const r = pd.recurring as Obj;
    if (!r.interval) ctx.fail("parameter_missing", { param: `${p}[recurring][interval]` });
    const unit = typeof pd.unit_amount === "number" ? pd.unit_amount : null;
    // ponytail: inline prices are stored without events (the real API's event set for them is unobserved).
    price = ctx.build("price", {
      id: ctx.id("price"),
      active: false,
      created: ctx.now(),
      currency: String(pd.currency).toLowerCase(),
      product: pd.product,
      recurring: { interval: r.interval, interval_count: r.interval_count ?? 1, meter: null, trial_period_days: null, usage_type: "licensed" },
      type: "recurring",
      unit_amount: unit,
      unit_amount_decimal: unit === null ? null : String(unit),
    });
    puts.push(price);
  } else return ctx.fail("parameter_missing", { param });
  if (price.type !== "recurring") ctx.fail("price_not_recurring", { param });
  return price;
}

const ID = /^\/v1\/subscriptions\/(?<id>[^/]+)$/;

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/subscriptions$/,
    (ctx, { params }) => {
      if (!params.customer) ctx.fail("parameter_missing", { param: "customer" });
      const rawItems = Array.isArray(params.items) ? (params.items as Obj[]) : [];
      if (rawItems.length === 0) ctx.fail("parameter_missing", { param: "items" });
      const collection = (params.collection_method as string) || "charge_automatically";
      if (collection === "send_invoice" && typeof params.days_until_due !== "number") ctx.fail("parameter_missing", { param: "days_until_due" });
      const customer = live(ctx, params.customer, "customer") ?? ctx.fail("resource_missing_400", { param: "customer" });
      checkPm(ctx, params.default_payment_method, customer.id);

      const now = ctx.now();
      const id = ctx.id("sub");
      const puts: Obj[] = [];
      const items = rawItems.map((it, i) => {
        const price = itemPrice(ctx, it, i, puts);
        const r = price.recurring as Obj;
        const item = ctx.build("subscription_item", {
          id: ctx.id("si"),
          created: now,
          current_period_end: addInterval(now, r.interval as string, r.interval_count as number),
          current_period_start: now,
          price,
          quantity: it.quantity ?? 1,
          subscription: id,
        });
        return assign(item, it, ["metadata"]);
      });
      let sub = assign(
        ctx.build("subscription", {
          id,
          billing_cycle_anchor: now,
          billing_mode: { flexible: { proration_discounts: "included" }, type: "flexible", updated_at: now },
          cancellation_details: cancellation(null),
          collection_method: collection,
          created: now,
          currency: (items[0]!.price as Obj).currency,
          customer: customer.id,
          days_until_due: collection === "send_invoice" ? params.days_until_due : null,
          default_payment_method: params.default_payment_method || null,
          items: { data: items, has_more: false, object: "list", url: `/v1/subscription_items?subscription=${id}` },
          start_date: now,
          status: "active",
        }),
        params,
        ["description", "metadata"],
      );
      if (params.cancel_at_period_end === true) sub = { ...sub, ...periodEndCancel(sub, true, now) };

      let invoice = firstInvoice(ctx, sub, customer);
      sub.latest_invoice = invoice.id;
      const invoiceEvents = ["invoice.created", "invoice.finalized"];
      const emits: Emit[] = [];
      if (invoice.amount_due === 0) {
        invoice = paid(invoice, now);
        invoiceEvents.push("invoice.paid", "invoice.payment_succeeded");
      } else if (collection === "charge_automatically") {
        // ponytail: pending_if_incomplete is treated like allow_incomplete.
        const behavior = (params.payment_behavior as string) || "allow_incomplete";
        const pmId = params.default_payment_method || (customer.invoice_settings as Obj | null)?.default_payment_method;
        const pm = behavior === "default_incomplete" ? undefined : live(ctx, pmId, "payment_method");
        if (!pm && behavior === "error_if_incomplete") ctx.fail("customer_no_payment_method");
        const attempt = attemptPayment(ctx, invoice, pm);
        emits.push(...attempt.emits);
        if (attempt.declined && behavior === "error_if_incomplete") {
          // 402, and only the payment intent (canceled) and the failed charge persist: no invoice, no subscription.
          const pi = { ...attempt.pi, canceled_at: now, cancellation_reason: "failed_invoice", status: "canceled" };
          return { ...attempt.declined, emits: [...emits, { type: "payment_intent.canceled", object: pi }] };
        }
        if (attempt.ok) {
          invoice = paid(invoice, now);
          invoiceEvents.push("invoice.paid", "invoice.payment_succeeded");
        } else sub.status = "incomplete";
        if (attempt.declined) invoiceEvents.push("invoice.payment_failed");
        if (pm) invoice = { ...invoice, attempt_count: 1, attempted: true };
      }

      emits.push({ type: "customer.subscription.created", object: sub });
      // The first subscription fixes the customer's billing currency.
      if (!customer.currency) emits.push({ type: "customer.updated", object: { ...customer, currency: sub.currency }, previous_attributes: { currency: null } });
      emits.push(...invoiceEvents.map((type) => ({ type, object: invoice })));
      return { body: sub, emits, puts };
    },
    "post /v1/subscriptions",
  ],
  [
    "GET",
    /^\/v1\/subscriptions$/,
    (ctx, { params }) => {
      const { customer, price, status } = params;
      const hasStatus = (s: unknown) =>
        status === "all" || (status === "ended" ? s === "canceled" || s === "incomplete_expired" : status ? s === status : s !== "canceled");
      const hit = (s: Obj) =>
        (!customer || s.customer === customer) &&
        hasStatus(s.status) &&
        (!price || ((s.items as Obj).data as Obj[]).some((i) => (i.price as Obj).id === price));
      return { body: list(ctx.all("subscription").filter(hit), params, "/v1/subscriptions") };
    },
    "get /v1/subscriptions",
  ],
  ["GET", ID, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.id) }), "get /v1/subscriptions/{subscription_exposed_id}"],
  [
    "POST",
    ID,
    (ctx, { pathParams, params }) => {
      const before = find(ctx, pathParams.id);
      if (Object.keys(params).some((k) => k !== "expand" && !UPDATABLE.includes(k))) ctx.fail("not_implemented");
      checkPm(ctx, params.default_payment_method, before.customer);
      let after = assign(structuredClone(before), params, ["default_payment_method", "description", "metadata"]);
      const cape = params.cancel_at_period_end;
      if (typeof cape === "boolean" && cape !== before.cancel_at_period_end) after = { ...after, ...periodEndCancel(after, cape, ctx.now()) };
      const previous_attributes = diff(before, after);
      const changed = Object.keys(previous_attributes).length > 0;
      return { body: after, emits: changed ? [{ type: "customer.subscription.updated", object: after, previous_attributes }] : [] };
    },
    "post /v1/subscriptions/{subscription_exposed_id}",
  ],
  [
    "DELETE",
    ID,
    (ctx, { pathParams, params }) => {
      const before = find(ctx, pathParams.id);
      if (before.status === "canceled") ctx.fail("resource_missing", { param: "id" });
      if (params.invoice_now || params.prorate) ctx.fail("not_implemented"); // final invoice and proration: W4
      const now = ctx.now();
      const details = assign(cancellation("cancellation_requested"), isHash(params.cancellation_details) ? params.cancellation_details : {});
      const after = { ...before, canceled_at: now, cancellation_details: details, ended_at: now, status: "canceled" };
      return { body: after, emits: [{ type: "customer.subscription.deleted", object: after }] };
    },
    "delete /v1/subscriptions/{subscription_exposed_id}",
  ],
];
