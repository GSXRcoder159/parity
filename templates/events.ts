import type { Template } from "../src/types.ts";
import { subscribed } from "./common.ts";

// #15: the probe's value is the event set the runner collects.
export const subscriptionEvents: Template = {
  name: "subscription-events",
  stratum: "events",
  build(g) {
    return [...subscribed(g, "subscription-events").steps, { method: "DELETE", path: "/v1/subscriptions/$s1.id" }];
  },
};
