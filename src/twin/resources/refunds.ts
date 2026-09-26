// Refunds: create (by payment intent or charge; succeed synchronously and update the charge), retrieve, list.
import { list } from "../list.ts";
import type { Route } from "../server.ts";
import { assign, diff, live } from "../util.ts";

type Obj = Record<string, unknown>;

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/refunds$/,
    (ctx, { params }) => {
      const amount = typeof params.amount === "number" ? params.amount : undefined;
      if (amount !== undefined && amount < 1) ctx.fail("parameter_invalid_integer", { param: "amount" });
      let charge: Obj | undefined;
      if (params.payment_intent) {
        const pi = live(ctx, params.payment_intent, "payment_intent") ?? ctx.fail("resource_missing_400", { param: "payment_intent" });
        charge = live(ctx, pi.latest_charge, "charge");
      } else if (params.charge) charge = live(ctx, params.charge, "charge") ?? ctx.fail("resource_missing_400", { param: "charge" });
      else ctx.fail("refund_target_missing");
      if (charge?.status !== "succeeded") return ctx.fail("refund_no_successful_charge");

      const refundable = (charge.amount as number) - (charge.amount_refunded as number);
      if (refundable === 0) ctx.fail("charge_already_refunded");
      if (amount !== undefined && amount > refundable) ctx.fail("refund_amount_exceeds");
      const refunded = (charge.amount_refunded as number) + (amount ?? refundable);
      const after = { ...charge, amount_refunded: refunded, refunded: refunded === charge.amount };
      const refund = assign(
        ctx.build("refund", {
          id: ctx.id("re"),
          amount: amount ?? refundable,
          charge: charge.id,
          created: ctx.now(),
          currency: charge.currency,
          customer: charge.customer,
          payment_intent: charge.payment_intent,
          payment_method: charge.payment_method,
          status: "succeeded",
        }),
        params,
        ["metadata", "reason"],
      );
      return {
        body: refund,
        emits: [
          { type: "refund.created", object: refund },
          { type: "charge.refunded", object: after, previous_attributes: diff(charge, after) },
          // ponytail: the real API sends these two about a second later (request id null) when the card network
          // reference arrives; the twin has no async work, so they fire with the request.
          { type: "refund.updated", object: refund },
          { type: "charge.refund.updated", object: refund },
        ],
      };
    },
    "post /v1/refunds",
  ],
  [
    "GET",
    /^\/v1\/refunds$/,
    (ctx, { params }) => {
      const { charge, payment_intent } = params;
      const hit = (r: Obj) => (!charge || r.charge === charge) && (!payment_intent || r.payment_intent === payment_intent);
      return { body: list(ctx.all("refund").filter(hit), params, "/v1/refunds") };
    },
    "get /v1/refunds",
  ],
  [
    "GET",
    /^\/v1\/refunds\/(?<refund>[^/]+)$/,
    (ctx, { pathParams }) => ({ body: live(ctx, pathParams.refund, "refund") ?? ctx.fail("resource_missing", { param: "refund" }) }),
    "get /v1/refunds/{refund}",
  ],
];
