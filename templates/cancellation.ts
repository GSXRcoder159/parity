import type { Template } from "../src/types.ts";
import { subscribed } from "./common.ts";

// #6
export const subscriptionCancelNow: Template = {
  name: "subscription-cancel-now",
  stratum: "cancellation",
  build(g) {
    return [
      ...subscribed(g, "subscription-cancel-now").steps,
      { method: "DELETE", path: "/v1/subscriptions/$s1.id" },
      { method: "GET", path: "/v1/subscriptions/$s1.id" },
      { method: "DELETE", path: "/v1/subscriptions/$s1.id" },
    ];
  },
};

// #7 (held out)
export const subscriptionCancelAtPeriodEnd: Template = {
  name: "subscription-cancel-at-period-end",
  stratum: "cancellation",
  heldOut: true,
  build(g) {
    return [
      ...subscribed(g, "subscription-cancel-at-period-end").steps,
      { method: "POST", path: "/v1/subscriptions/$s1.id", params: { cancel_at_period_end: true } },
      { method: "GET", path: "/v1/subscriptions/$s1.id" },
      { method: "POST", path: "/v1/subscriptions/$s1.id", params: { cancel_at_period_end: false } },
    ];
  },
};
