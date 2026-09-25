import type { Step, Template } from "../src/types.ts";
import { findPaymentIntent, subscribed } from "./common.ts";

const refund = (amount?: number): Step => ({
  method: "POST",
  path: "/v1/refunds",
  params: { payment_intent: "$pis.data.0.id", amount },
});

// #8
export const refundFull: Template = {
  name: "refund-full",
  stratum: "refunds",
  build(g) {
    return [
      ...subscribed(g, "refund-full").steps,
      findPaymentIntent(),
      { method: "POST", path: "/v1/refunds", params: { payment_intent: "$pis.data.0.id", reason: g.pick(["requested_by_customer", "duplicate"]) } },
      { method: "GET", path: "/v1/charges/$pis.data.0.latest_charge" },
      { method: "GET", path: "/v1/refunds", params: { payment_intent: "$pis.data.0.id" } },
    ];
  },
};

// #9 (held out)
export const refundPartialThenRest: Template = {
  name: "refund-partial-then-rest",
  stratum: "refunds",
  heldOut: true,
  build(g) {
    const { steps, amount } = subscribed(g, "refund-partial-then-rest");
    const part = g.int(100, amount - 100);
    return [...steps, findPaymentIntent(), refund(part), refund(amount - part), refund(1)];
  },
};

// #10
export const refundOverAndNegative: Template = {
  name: "refund-over-and-negative",
  stratum: "refunds",
  build(g) {
    const { steps, amount } = subscribed(g, "refund-over-and-negative");
    return [
      ...steps,
      findPaymentIntent(),
      refund(amount + g.int(1, 1000)),
      refund(-g.int(1, 1000)),
      refund(g.int(1, amount - 1)),
    ];
  },
};
