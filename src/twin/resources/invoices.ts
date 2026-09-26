// Invoices: retrieve, list, and create_preview. Invoices are created by subscriptions (billing.ts); update, delete,
// pay, void and finalize are W4 and answer `not_implemented` (after the missing-invoice check).
import { addInterval, applyBalance, invoiceItem, invoiceItemLine, itemLine, pendingItems, subInvoice } from "../billing.ts";
import { list } from "../list.ts";
import type { Ctx, Handler, Route } from "../server.ts";
import { isHash, live } from "../util.ts";
import { ITEM, change, itemPrice, newItem, only } from "./subscriptions.ts";

type Obj = Record<string, unknown>;

// The missing-invoice param is "invoice", except on POST /v1/invoices/{invoice}, where it is "id" (observed).
const find = (ctx: Ctx, id: string | undefined, param = "invoice") => live(ctx, id, "invoice") ?? ctx.fail("resource_missing", { param });
const w4 = (param?: string): Handler => (ctx, { pathParams }) => {
  find(ctx, pathParams.invoice, param);
  return ctx.fail("not_implemented");
};
const ID = /^\/v1\/invoices\/(?<invoice>[^/]+)$/;

/**
 * The next invoice of a subscription (`subscription`, optionally with `subscription_details` changes applied as an
 * update would), or the first invoice of a new one (`customer` + `subscription_details[items]`). A preview is a draft
 * that is never stored: id `upcoming_in_…`, line ids `il_tmp_…`, `billing_reason: upcoming`. The next invoice is the
 * one the change creates now (always_invoice with prorations, `billing_cycle_anchor=now`), else the renewal at the
 * current period end: pending invoice items, the change's prorations, and every item's next period.
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
    const items = (sd.items as Obj[]).map((it, i) => {
      only(ctx, it, ITEM);
      return newItem(ctx, it, itemPrice(ctx, it, i, []), null);
    });
    const sub = { id: null, collection_method: "charge_automatically", currency: (items[0]!.price as Obj).currency, metadata: {} };
    const lines = items.map((item) => itemLine(ctx, id, sub, item, { end: item.current_period_end as number, start: now }, "il_tmp"));
    return draft(sub, customer, lines, now, {});
  }

  const sub = live(ctx, params.subscription, "subscription") ?? ctx.fail("resource_missing_400", { param: "subscription" });
  const { after, prorations, reset, date } = change(ctx, sub, sd, []);
  const immediate = reset || (sd.proration_behavior === "always_invoice" && prorations.length > 0);
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
  ["POST", ID, w4("id"), "post /v1/invoices/{invoice}"],
  ["DELETE", ID, w4(), "delete /v1/invoices/{invoice}"],
  ...["finalize", "pay", "void"].map((a): Route => ["POST", new RegExp(`^/v1/invoices/(?<invoice>[^/]+)/${a}$`), w4(), `post /v1/invoices/{invoice}/${a}`]),
];
