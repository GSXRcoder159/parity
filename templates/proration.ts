import type { Gen, Step, Template } from "../src/types.ts";
import { amount, subscribed } from "./common.ts";

/** Price B for s1's swap: pr1's product and currency, and pr1's interval unless another is given; the amount differs. */
const priceB = (g: Gen, interval = "$pr1.recurring.interval"): Step => ({
  ref: "pr2",
  method: "POST",
  path: "/v1/prices",
  params: { product: "$pr1.product", currency: "$pr1.currency", unit_amount: amount(g), recurring: { interval } },
});

/** s1's only item moved to price B. */
const swapToB = [{ id: "$s1.items.data.0.id", price: "$pr2.id" }];

// #16
export const invoicePreviewProration: Template = {
  name: "invoice-preview-proration",
  stratum: "proration",
  build(g) {
    return [
      ...subscribed(g, "invoice-preview-proration").steps,
      priceB(g),
      {
        method: "POST",
        path: "/v1/invoices/create_preview",
        params: { subscription: "$s1.id", subscription_details: { items: swapToB, proration_behavior: "create_prorations" } },
      },
      // Removed at basil: `customer` alone is not enough for create_preview, and GET upcoming is gone.
      { method: "POST", path: "/v1/invoices/create_preview", params: { customer: "$c1.id" } },
      { method: "GET", path: "/v1/invoices/upcoming", params: { customer: "$c1.id" } },
    ];
  },
};

// #17
export const subscriptionUpdatePrice: Template = {
  name: "subscription-update-price",
  stratum: "proration",
  build(g) {
    return [
      ...subscribed(g, "subscription-update-price").steps,
      priceB(g),
      {
        method: "POST",
        path: "/v1/subscriptions/$s1.id",
        params: { items: swapToB, proration_behavior: g.pick(["create_prorations", "none", "always_invoice"]) },
      },
      { method: "GET", path: "/v1/invoices", params: { customer: "$c1.id" } },
    ];
  },
};

// #18 (held out)
export const subscriptionUpdateQuantity: Template = {
  name: "subscription-update-quantity",
  stratum: "proration",
  heldOut: true,
  build(g) {
    return [
      ...subscribed(g, "subscription-update-quantity").steps,
      {
        method: "POST",
        path: "/v1/subscriptions/$s1.id",
        params: { items: [{ id: "$s1.items.data.0.id", quantity: g.int(2, 9) }], proration_behavior: "create_prorations" },
      },
      { method: "POST", path: "/v1/invoices/create_preview", params: { subscription: "$s1.id" } },
    ];
  },
};

// #31: a monthly subscription moved to an annual price with no billing_cycle_anchor (H4's switch-to-annual).
export const subscriptionIntervalSwap: Template = {
  name: "subscription-interval-swap",
  stratum: "proration",
  build(g) {
    return [
      ...subscribed(g, "subscription-interval-swap", { interval: "month" }).steps,
      priceB(g, "year"),
      {
        method: "POST",
        path: "/v1/subscriptions/$s1.id",
        params: { items: swapToB, proration_behavior: g.pick(["create_prorations", "always_invoice", "none"]) },
      },
      { method: "GET", path: "/v1/subscriptions/$s1.id" },
      { method: "GET", path: "/v1/invoices", params: { customer: "$c1.id" } },
    ];
  },
};
