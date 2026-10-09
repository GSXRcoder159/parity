// Payment intents and charges: retrieve and list. Both are created by payment attempts (billing.ts) and
// changed by refunds (refunds.ts).
import { list } from "../list.ts";
import type { Route } from "../server.ts";
import { live } from "../util.ts";

type Obj = Record<string, unknown>;

const DEFAULT_PAYMENT_METHOD_TYPES = ["amazon_pay", "card", "cashapp", "klarna", "link"];

function withTypes(ctx: Parameters<Route[number] extends never ? never : any>[0], pi: Obj): Obj {
  const types = Array.isArray(pi.payment_method_types) && (pi.payment_method_types as unknown[]).length > 0
    ? (pi.payment_method_types as unknown[])
    : DEFAULT_PAYMENT_METHOD_TYPES;
  return ctx.build("payment_intent", { ...pi, payment_method_types: types });
}

export const routes: Route[] = [
  [
    "GET",
    /^\/v1\/payment_intents$/,
    (ctx, { params }) => {
      const items = ctx.all("payment_intent").filter((p) => !params.customer || p.customer === params.customer).map((p) => withTypes(ctx, p));
      return { body: list(items, params, "/v1/payment_intents") };
    },
    "get /v1/payment_intents",
  ],
  [
    "GET",
    /^\/v1\/payment_intents\/(?<intent>[^/]+)$/,
    (ctx, { pathParams }) => {
      const pi = live(ctx, pathParams.intent, "payment_intent");
      return { body: pi ? withTypes(ctx, pi) : ctx.fail("resource_missing", { param: "intent" }) };
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
