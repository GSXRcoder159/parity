// Payment intents and charges: retrieve and list. Both are created by payment attempts (billing.ts) and
// changed by refunds (refunds.ts).
import { list } from "../list.ts";
import type { Route } from "../server.ts";
import { live } from "../util.ts";

type Obj = Record<string, unknown>;

function invoiceDescription(reason: unknown): string | null {
  switch (reason) {
    case "subscription_create":
      return "Subscription creation";
    case "subscription_cycle":
    case "subscription_update":
      return "Subscription update";
    default:
      return null;
  }
}

function withDescription(ctx: Parameters<Route[2]>[0], pi: Obj): Obj {
  const orderReference = (pi.payment_details as Obj | undefined)?.order_reference;
  const invoice = ctx.all("invoice").find((inv) => inv.id === orderReference);
  return ctx.build("payment_intent", { ...pi, description: invoiceDescription(invoice?.billing_reason) });
}

export const routes: Route[] = [
  [
    "GET",
    /^\/v1\/payment_intents$/,
    (ctx, { params }) => ({
      body: list(
        ctx.all("payment_intent")
          .filter((p) => !params.customer || p.customer === params.customer)
          .map((p) => withDescription(ctx, p)),
        params,
        "/v1/payment_intents",
      ),
    }),
    "get /v1/payment_intents",
  ],
  [
    "GET",
    /^\/v1\/payment_intents\/(?<intent>[^/]+)$/,
    (ctx, { pathParams }) => {
      const pi = live(ctx, pathParams.intent, "payment_intent");
      return { body: pi ? withDescription(ctx, pi) : ctx.fail("resource_missing", { param: "intent" }) };
    },
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
