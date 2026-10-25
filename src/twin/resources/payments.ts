// Payment intents and charges: retrieve and list. Both are created by payment attempts (billing.ts) and
// changed by refunds (refunds.ts).
import { list } from "../list.ts";
import type { Route } from "../server.ts";
import { live } from "../util.ts";

type Obj = Record<string, unknown>;

function enrichPaymentIntent(ctx: Parameters<Route[2]>[0], pi: Obj | undefined): Obj | undefined {
  if (!pi) return pi;
  const details = pi.payment_details as Obj | undefined;
  const invoiceId = details?.order_reference as string | undefined;
  const invoice = invoiceId ? ctx.all("invoice").find((i: Obj) => i.id === invoiceId) : undefined;
  const billingReason = invoice?.billing_reason as string | undefined;
  const isSubscriptionInvoice = billingReason === "subscription_create" || billingReason === "subscription_cycle" || billingReason === "subscription_update";
  const existingTypes = pi.payment_method_types as string[] | undefined;
  return ctx.build("payment_intent", {
    ...pi,
    description: pi.description ?? (isSubscriptionInvoice ? "Subscription creation" : pi.description ?? null),
    client_secret: pi.client_secret ?? `${pi.id}_secret_${String(pi.id).slice(3)}`,
    payment_method_types: existingTypes && existingTypes.length ? existingTypes : ["amazon_pay", "card", "cashapp", "klarna", "link"],
    setup_future_usage: pi.setup_future_usage ?? (isSubscriptionInvoice ? "off_session" : null),
  });
}

export const routes: Route[] = [
  [
    "GET",
    /^\/v1\/payment_intents$/,
    (ctx, { params }) => ({
      body: list(
        ctx
          .all("payment_intent")
          .filter((p) => !params.customer || p.customer === params.customer)
          .map((p) => enrichPaymentIntent(ctx, p) as Obj),
        params,
        "/v1/payment_intents",
      ),
    }),
    "get /v1/payment_intents",
  ],
  [
    "GET",
    /^\/v1\/payment_intents\/(?<intent>[^/]+)$/,
    (ctx, { pathParams }) => ({
      body: enrichPaymentIntent(ctx, live(ctx, pathParams.intent, "payment_intent")) ?? ctx.fail("resource_missing", { param: "intent" }),
    }),
    "get /v1/payment_intents/{intent}",
  ],
  [
    "GET",
    /^\/v1\/charges$/,
    (ctx, { params }) => {
      const { customer, payment_intent } = params;
      const hit = (c: Obj) => (!customer || c.customer === customer) && (!payment_intent || c.payment_intent === payment_intent);
      return { body: list(ctx.all("charge").filter(hit), params, "/v1/charges") };
    },
    "get /v1/charges",
  ],
  [
    "GET",
    /^\/v1\/charges\/(?<charge>[^/]+)$/,
    (ctx, { pathParams }) => ({ body: live(ctx, pathParams.charge, "charge") ?? ctx.fail("resource_missing", { param: "charge" }) }),
    "get /v1/charges/{charge}",
  ],
];
