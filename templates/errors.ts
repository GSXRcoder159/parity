import type { Step, Template } from "../src/types.ts";
import { amount, currency, customer, subscribed, tag } from "./common.ts";

// #11
export const resourceMissing: Template = {
  name: "resource-missing",
  stratum: "errors",
  build(g) {
    const n = tag(g);
    const steps: Step[] = [];
    // No DELETE for prices in the API (it would 404 as an unrecognized URL, not resource_missing).
    for (const [resource, prefix, canDelete] of [
      ["customers", "cus", true],
      ["subscriptions", "sub", true],
      ["prices", "price", false],
      ["invoices", "in", true],
    ] as const) {
      const path = `/v1/${resource}/${prefix}_ParityMissing${n}`;
      steps.push({ method: "GET", path }, { method: "POST", path, params: { metadata: { parity: "resource-missing" } } });
      if (canDelete) steps.push({ method: "DELETE", path });
    }
    return steps;
  },
};

// #12 (held out)
export const invalidParams: Template = {
  name: "invalid-params",
  stratum: "errors",
  heldOut: true,
  build(g) {
    const n = tag(g);
    const product_data = { name: `Parity invalid ${n}` };
    return [
      customer("invalid-params", n),
      { method: "POST", path: "/v1/customers", params: { name: `Parity ${n}`, [g.pick(["nickname", "colour", "loyalty_tier"])]: "x" } },
      { method: "POST", path: "/v1/prices", params: { unit_amount: amount(g), product_data } },
      {
        method: "POST",
        path: "/v1/prices",
        params: { currency: currency(g), unit_amount: amount(g), recurring: { interval: g.pick(["fortnight", "decade", "hourly"]) }, product_data },
      },
      { method: "POST", path: "/v1/subscriptions", params: { customer: "$c1.id" } },
      { method: "POST", path: "/v1/prices", params: { currency: currency(g), unit_amount: -amount(g), product_data } },
    ];
  },
};

// #13
export const cardDeclined: Template = {
  name: "card-declined",
  stratum: "errors",
  build(g) {
    const paymentBehavior = g.bool() ? undefined : "error_if_incomplete";
    return [
      ...subscribed(g, "card-declined", { card: "pm_card_chargeCustomerFail", paymentBehavior }).steps,
      { method: "GET", path: "/v1/invoices", params: { customer: "$c1.id" } },
    ];
  },
};
