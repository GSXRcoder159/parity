// Invoices: retrieve, list, create_preview, and the lifecycle draft -> open -> paid | void (finalize, pay, void,
// update). Invoices are created by subscriptions (billing.ts). `uncollectible` has no route (mark_uncollectible is not
// in the pruned spec); pay and void accept it like `open`, per the docs.
import { addInterval, applyBalance, attemptPayment, invoiceItem, invoiceItemLine, itemLine, paid, pendingItems, subInvoice } from "../billing.ts";
import { list } from "../list.ts";
import type { Ctx, Handler, Route } from "../server.ts";
import type { Emit } from "../store.ts";
import { assign, diff, isHash, live } from "../util.ts";
import { ITEM, change, itemPrice, newItem, only } from "./subscriptions.ts";

type Obj = Record<string, unknown>;

// The missing-invoice param is "invoice", except on POST /v1/invoices/{invoice}, where it is "id" (observed).
const find = (ctx: Ctx, id: string | undefined, param = "invoice") => live(ctx, id, "invoice") ?? ctx.fail("resource_missing", { param });
const ID = /^\/v1\/invoices\/(?<invoice>[^/]+)$/;
const action = (a: string) => new RegExp(`^/v1/invoices/(?<invoice>[^/]+)/${a}$`);

/** The invoice's payment intent still awaiting payment: created at finalization, or left by a failed attempt. */
const openIntent = (ctx: Ctx, inv: Obj) =>
  ctx.all("payment_intent").findLast((pi) => (pi.payment_details as Obj).order_reference === inv.id && pi.status === "requires_payment_method");
const canceled = (pi: Obj, reason: string, now: number): Emit => ({
  type: "payment_intent.canceled",
  object: { ...pi, canceled_at: now, cancellation_reason: reason, status: "canceled" },
});

/** `types` and an `invoice.updated` with what changed since `before`, all carrying the invoice's final state. */
const invoiceEmits = (before: Obj, after: Obj, types: string[]): Emit[] => [
  ...types.map((type) => ({ type, object: after })),
  { type: "invoice.updated", object: after, previous_attributes: diff(before, after) },
];

/** Draft `inv` finalized now (`open`), with the customer's balance applied then (a customer.updated if it moves). */
function finalize(ctx: Ctx, inv: Obj): { invoice: Obj; emits: Emit[] } {
  const now = ctx.now();
  const customer = ctx.get(inv.customer as string)!;
  const transitions = { ...(inv.status_transitions as Obj), finalized_at: now };
  const open = { ...inv, automatically_finalizes_at: null, effective_at: now, status: "open", status_transitions: transitions };
  const invoice = applyBalance(open, customer.balance as number);
  const moved = invoice.ending_balance !== customer.balance;
  const emits: Emit[] = moved ? [{ type: "customer.updated", object: { ...customer, balance: invoice.ending_balance }, previous_attributes: { balance: customer.balance } }] : [];
  return { invoice, emits };
}

const subscriptionOf = (ctx: Ctx, inv: Obj) => live(ctx, ((inv.parent as Obj | null)?.subscription_details as Obj | null)?.subscription, "subscription");

/** Paying a subscription's latest invoice makes an incomplete or past_due subscription active (docs: subscription statuses). */
function activate(ctx: Ctx, inv: Obj): Emit[] {
  const sub = subscriptionOf(ctx, inv);
  if (!sub || sub.latest_invoice !== inv.id || !["incomplete", "past_due"].includes(sub.status as string)) return [];
  return [{ type: "customer.subscription.updated", object: { ...sub, status: "active" }, previous_attributes: { status: sub.status } }];
}

/**
 * Finalizes a draft: `open`, the balance applied, and a payment intent for the amount due that nothing confirms yet
 * (observed, #19); nothing due -> paid at once, as when a subscription update invoices nothing (billing.ts collect).
 */
const finalizeRoute: Handler = (ctx, { pathParams, params }) => {
  const inv = find(ctx, pathParams.invoice);
  if (inv.status !== "draft") ctx.fail("not_implemented"); // ponytail: re-finalizing (the real API's error is unobserved)
  const { invoice, emits } = finalize(ctx, inv);
  let after = typeof params.auto_advance === "boolean" ? { ...invoice, auto_advance: params.auto_advance } : invoice;
  const types = ["invoice.finalized"];
  if (after.amount_due === 0) {
    after = { ...paid(after, ctx.now()), attempted: true };
    types.push("invoice.paid", "invoice.payment_succeeded");
  } else emits.push(...attemptPayment(ctx, after, undefined).emits);
  return { body: after, emits: [...emits, ...invoiceEmits(inv, after, types)] };
};

/**
 * Pays an open (or uncollectible) invoice; a draft is finalized first (observed: invoice.finalized). Out of band
 * (`paid_out_of_band`), or with nothing due: paid, and the open payment intent canceled as a duplicate (observed, #19).
 * Otherwise one charge of the invoice's, else the subscription's, else the customer's default payment method (docs),
 * confirming the open payment intent: a decline answers the 402 card error and leaves the invoice open.
 */
const payRoute: Handler = (ctx, { pathParams, params }) => {
  const inv = find(ctx, pathParams.invoice);
  only(ctx, params, ["expand", "paid_out_of_band"]);
  if (inv.status === "void") ctx.fail("invoice_pay_voided");
  if (inv.status === "paid") ctx.fail("not_implemented"); // ponytail: paying twice (the real API's error is unobserved)
  const now = ctx.now();
  const emits: Emit[] = [];
  const types: string[] = [];
  let open = inv;
  if (inv.status === "draft") {
    const f = finalize(ctx, inv);
    open = f.invoice;
    emits.push(...f.emits);
    types.push("invoice.finalized");
  }
  const intent = openIntent(ctx, open); // none for a draft just finalized here (observed: no payment_intent.* out of band)
  if (params.paid_out_of_band === true || open.amount_due === 0) {
    if (intent) emits.push(canceled(intent, "duplicate", now));
  } else {
    const sub = subscriptionOf(ctx, open);
    const customer = ctx.get(open.customer as string)!;
    const pmId = open.default_payment_method || sub?.default_payment_method || (customer.invoice_settings as Obj | null)?.default_payment_method;
    // ponytail: no payment method -> the subscription create's error (for an invoice, unobserved).
    const pm = live(ctx, pmId, "payment_method") ?? ctx.fail("customer_no_payment_method");
    const attempt = attemptPayment(ctx, open, pm, intent);
    emits.push(...attempt.emits);
    open = { ...open, attempt_count: (open.attempt_count as number) + 1, attempted: true };
    if (attempt.declined) return { ...attempt.declined, emits: [...emits, ...invoiceEmits(inv, open, [...types, "invoice.payment_failed"])] };
  }
  const after = paid(open, now);
  types.push("invoice.paid", "invoice.payment_succeeded");
  return { body: after, emits: [...emits, ...activate(ctx, after), ...invoiceEmits(inv, after, types)] };
};

/** Voids an open (or uncollectible) invoice and cancels its open payment intent (observed, #19). */
const voidRoute: Handler = (ctx, { pathParams }) => {
  const inv = find(ctx, pathParams.invoice);
  if (inv.status === "paid") ctx.fail("invoice_void_paid");
  if (inv.status === "draft") ctx.fail("invoice_not_open");
  if (inv.status === "void") ctx.fail("not_implemented"); // ponytail: voiding twice (the real API's error is unobserved)
  const now = ctx.now();
  const after = { ...inv, auto_advance: false, status: "void", status_transitions: { ...(inv.status_transitions as Obj), voided_at: now } };
  const intent = openIntent(ctx, inv);
  return { body: after, emits: [...(intent ? [canceled(intent, "void_invoice", now)] : []), ...invoiceEmits(inv, after, ["invoice.voided"])] };
};

/** `metadata` and `description` of a draft or open invoice. */
const updateRoute: Handler = (ctx, { pathParams, params }) => {
  const inv = find(ctx, pathParams.invoice, "id");
  only(ctx, params, ["description", "expand", "metadata"]);
  // ponytail: other statuses are refused. The docs lock only monetary values and collection_method once finalized, so
  // these edits likely succeed on paid and void invoices too; unobserved.
  if (inv.status !== "draft" && inv.status !== "open") ctx.fail("not_implemented");
  const after = assign(structuredClone(inv), params, ["description", "metadata"]);
  const previous_attributes = diff(inv, after);
  return { body: after, emits: Object.keys(previous_attributes).length > 0 ? [{ type: "invoice.updated", object: after, previous_attributes }] : [] };
};

/**
 * The next invoice of a subscription (`subscription`, optionally with `subscription_details` changes applied as an
 * update would), or the first invoice of a new one (`customer` + `subscription_details[items]`). A preview is a draft
 * that is never stored: id `upcoming_in_…`, line ids `il_tmp_…`, `billing_reason: upcoming`. The next invoice is the
 * one the change creates now (always_invoice with prorations, `billing_cycle_anchor=now` with item changes), else the
 * renewal at the current period end: pending invoice items, the change's prorations, and every item's next period.
 */
const preview: Handler = (ctx, { params }) => {
  only(ctx, params, ["customer", "expand", "subscription", "subscription_details"]);
  const sd = isHash(params.subscription_details) ? params.subscription_details : {};
  only(ctx, sd, ["billing_cycle_anchor", "items", "proration_behavior", "proration_date"]);
  if (!params.subscription && !Array.isArray(sd.items)) ctx.fail("invoice_preview_target_missing");
  const now = ctx.now();
  const id = ctx.id("upcoming_in");
  const draft = (sub: Obj, customer: Obj, lines: Obj[], at: number, fields: Obj) => {
    const next_payment_attempt = sub.collection_method === "charge_automatically" ? at + 3600 : null; // finalized an hour after creation
    const transitions = { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null };
    const inv = subInvoice(ctx, sub, customer, id, lines, { auto_advance: true, billing_reason: "upcoming", effective_at: null, next_payment_attempt, status: "draft", status_transitions: transitions, ...fields }, at);
    return { body: applyBalance(inv, customer.balance as number) };
  };

  if (!params.subscription) {
    const customer = live(ctx, params.customer, "customer") ?? ctx.fail(params.customer ? "resource_missing_400" : "parameter_missing", { param: "customer" });
    // ponytail: a new subscription's anchor (any value) and proration_date are refused (unobserved; docs: a future
    // anchor debits the time up to it). proration_behavior only governs the anchor's prorations, so it changes nothing.
    only(ctx, sd, ["items", "proration_behavior"]);
    const items = (sd.items as Obj[]).map((it, i) => {
      only(ctx, it, ITEM);
      return newItem(ctx, it, itemPrice(ctx, it, i, []), null);
    });
    const sub = { id: null, collection_method: "charge_automatically", currency: (items[0]!.price as Obj).currency, metadata: {} };
    const lines = items.map((item) => itemLine(ctx, id, sub, item, { end: item.current_period_end as number, start: now }, "il_tmp"));
    return draft(sub, customer, lines, now, {});
  }

  const sub = live(ctx, params.subscription, "subscription") ?? ctx.fail("resource_missing_400", { param: "subscription" });
  const { after, prorations, reset, immediate, date } = change(ctx, sub, sd, []);
  // ponytail: a canceled subscription, or a renewal preview of one that ends at the period end, is refused (no
  // upcoming invoice; the real API's error is unobserved).
  if (sub.status === "canceled" || (!immediate && after.cancel_at_period_end)) ctx.fail("not_implemented");
  const customer = ctx.get(sub.customer as string)!;
  const items = (after.items as Obj).data as Obj[];
  const lines = [...pendingItems(ctx, sub.id), ...prorations.map((p) => invoiceItem(ctx, after, p, id))].map((ii) => invoiceItemLine(ctx, id, ii, "il_tmp"));
  const parent = {
    quote_details: null,
    subscription_details: { metadata: after.metadata, subscription: sub.id, ...(prorations.length > 0 ? { subscription_proration_date: date } : {}) },
    type: "subscription_details",
  };
  if (immediate) {
    if (reset) for (const item of items) lines.push(itemLine(ctx, id, after, item, { end: item.current_period_end as number, start: now }, "il_tmp"));
    return draft(after, customer, lines, now, { parent, period_start: ctx.get(sub.latest_invoice as string)?.period_end ?? now });
  }
  for (const item of items) {
    const [end, r] = [item.current_period_end as number, (item.price as Obj).recurring as Obj];
    lines.push(itemLine(ctx, id, after, item, { end: addInterval(end, r.interval as string, r.interval_count as number), start: end }, "il_tmp"));
  }
  const [first] = items as [Obj];
  return draft(after, customer, lines, first.current_period_end as number, { parent, period_start: first.current_period_start });
};

export const routes: Route[] = [
  [
    "GET",
    /^\/v1\/invoices$/,
    (ctx, { params }) => {
      const { customer, status, subscription } = params;
      const hit = (i: Obj) =>
        (!customer || i.customer === customer) &&
        (!status || i.status === status) &&
        (!subscription || ((i.parent as Obj | null)?.subscription_details as Obj | null | undefined)?.subscription === subscription);
      return { body: list(ctx.all("invoice").filter(hit), params, "/v1/invoices") };
    },
    "get /v1/invoices",
  ],
  // Before the {invoice} routes, which would take "create_preview" and "upcoming" as ids.
  ["POST", /^\/v1\/invoices\/create_preview$/, preview, "post /v1/invoices/create_preview"],
  // Removed at basil (observed 404). The pruned spec has no such operation: params validate as the list's.
  ["GET", /^\/v1\/invoices\/upcoming$/, (ctx) => ctx.fail("invoice_upcoming_deprecated"), "get /v1/invoices"],
  ["GET", ID, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.invoice) }), "get /v1/invoices/{invoice}"],
  ["POST", ID, updateRoute, "post /v1/invoices/{invoice}"],
  // Docs: a subscription's invoice cannot be deleted, not even a draft (void it); the twin has no other invoices.
  [
    "DELETE",
    ID,
    (ctx, { pathParams }) => {
      find(ctx, pathParams.invoice);
      return ctx.fail("invoice_not_deletable");
    },
    "delete /v1/invoices/{invoice}",
  ],
  ["POST", action("finalize"), finalizeRoute, "post /v1/invoices/{invoice}/finalize"],
  ["POST", action("pay"), payRoute, "post /v1/invoices/{invoice}/pay"],
  ["POST", action("void"), voidRoute, "post /v1/invoices/{invoice}/void"],
];
