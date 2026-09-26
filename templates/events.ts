import type { Template } from "../src/types.ts";
import { subscribed, tag } from "./common.ts";

// #15: the probe's value is the event set the runner collects.
export const subscriptionEvents: Template = {
  name: "subscription-events",
  stratum: "events",
  build(g) {
    return [...subscribed(g, "subscription-events").steps, { method: "DELETE", path: "/v1/subscriptions/$s1.id" }];
  },
};

/**
 * Event types no template produces: the endpoint never receives a delivery (no sandbox data sent to example.com) and
 * never raises `pending_webhooks` on the events of sequences running alongside.
 */
const UNUSED_EVENTS = ["charge.dispute.created", "charge.dispute.closed", "charge.dispute.updated", "radar.early_fraud_warning.created"];

// #24: webhook endpoints are account-global, so never listed.
// ponytail: an aborted run orphans its endpoint and Stripe caps an account at 16; delete leftovers if creates start failing.
export const webhookEndpointCrud: Template = {
  name: "webhook-endpoint-crud",
  stratum: "events",
  build(g) {
    const n = tag(g);
    return [
      {
        ref: "w1",
        method: "POST",
        path: "/v1/webhook_endpoints",
        params: {
          url: `https://example.com/parity/webhook-endpoint-crud/${n}`,
          enabled_events: [g.pick(UNUSED_EVENTS)],
          description: `Parity ${n}`,
          metadata: { parity: "webhook-endpoint-crud" },
        },
      },
      { method: "GET", path: "/v1/webhook_endpoints/$w1.id" },
      { method: "POST", path: "/v1/webhook_endpoints/$w1.id", params: { enabled_events: [g.pick(UNUSED_EVENTS)], disabled: true, description: `Parity ${n} v2` } },
      { method: "DELETE", path: "/v1/webhook_endpoints/$w1.id" },
      { method: "GET", path: "/v1/webhook_endpoints/$w1.id" },
    ];
  },
};
