// Payment intents and charges: retrieve and list. Both are created by payment attempts (billing.ts) and
// changed by refunds (refunds.ts).
import { list } from "../list.ts";
import type { Route } from "../server.ts";
import { live } from "../util.ts";

type Obj = Record<string, unknown>;

function enrichIntent(ctx: any, pi: Obj | null): Obj | null {
  if (!pi) return pi;
  const computed: Obj = {};
  if (pi.client_secret == null) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
    computed.client_secret = `${pi.id as string}_secret_${s}`;
  }
  if (pi.description == null) {
    const orderRef = (pi.payment_details as Obj | undefined)?.order_reference as string | undefined;
    const invoice = orderRef ? ctx.all("invoice").find((i: Obj) => i.id === orderRef) : null;
    if (invoice && invoice.billing_reason === "subscription_create") computed.description = "Subscription creation";
  }
  if (!Array.isArray(pi.payment_method_types) || (pi.payment_method_types as unknown[]).length === 0) {
    computed.payment_method_types = ["amazon_pay", "card", "cashapp", "klarna", "link"];
  }
  if (pi.payment_method_options == null) {
    computed.payment_method_options = {
      amazon_pay: { express_checkout_element_session_id: null },
      card: { installments: null, mandate_options: null, network: null, request_three_d_secure: "automatic" },
      cashapp: {},
      klarna: { preferred_locale: null },
      link: { persistent_token: null },
    };
  }
  if (pi.setup_future_usage == null && pi.customer) computed.setup_future_usage = "off_session";
  return Object.keys(computed).length ? ctx.build("payment_intent", { ...pi, ...computed }) : pi;
}

export const routes: Route[] = [
  [
    "GET",
    /^\/v1\/payment_intents$/,
    (ctx, { params }) => ({
      body: list(
        ctx.all("payment_intent").filter((p) => !params.customer || p.customer === params.customer).map((p) => enrichIntent(ctx, p) as Obj),
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
      body: enrichIntent(ctx, live(ctx, pathParams.intent, "payment_intent")) ?? ctx.fail("resource_missing", { param: "intent" }),
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
