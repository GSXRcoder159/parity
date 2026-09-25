import type { Step, Template } from "../src/types.ts";
import { amount, attach, currency, customer, email, subscribed, tag } from "./common.ts";

// #1
export const customerCrud: Template = {
  name: "customer-crud",
  stratum: "lifecycle",
  build(g) {
    const n = tag(g);
    return [
      customer("customer-crud", n),
      { method: "GET", path: "/v1/customers/$c1.id" },
      {
        method: "POST",
        path: "/v1/customers/$c1.id",
        params: { name: `Parity ${n} renamed`, metadata: { tier: g.pick(["gold", "silver", "bronze"]) } },
      },
      { method: "DELETE", path: "/v1/customers/$c1.id" },
      { method: "GET", path: "/v1/customers/$c1.id" },
      { method: "POST", path: "/v1/customers/$c1.id", params: { name: `Parity ${n} ghost` } },
    ];
  },
};

// #2
export const customerListPagination: Template = {
  name: "customer-list-pagination",
  stratum: "pagination",
  build(g) {
    const n = tag(g);
    const k = g.int(3, 5);
    const steps: Step[] = [];
    for (let i = 1; i <= k; i++) steps.push(customer("customer-list-pagination", n, `c${i}`, `Parity ${n} #${i}`));
    // created[gte] keeps earlier runs' customers (same deterministic email) out of the pages.
    const list = { email: email("customer-list-pagination", n), limit: 2, created: { gte: "$c1.created" } };
    for (let p = 1; p <= Math.ceil(k / 2); p++) {
      steps.push({
        ref: `l${p}`,
        method: "GET",
        path: "/v1/customers",
        params: p === 1 ? list : { ...list, starting_after: `$l${p - 1}.data.1.id` },
      });
    }
    return steps;
  },
};

// #3
export const productPriceCrud: Template = {
  name: "product-price-crud",
  stratum: "lifecycle",
  build(g) {
    const n = tag(g);
    return [
      { ref: "p1", method: "POST", path: "/v1/products", params: { name: `Parity product ${n}`, metadata: { parity: "product-price-crud" } } },
      {
        ref: "pr1",
        method: "POST",
        path: "/v1/prices",
        params: {
          product: "$p1.id",
          currency: currency(g),
          unit_amount: amount(g),
          recurring: { interval: g.pick(["week", "month", "year"]) },
        },
      },
      { method: "GET", path: "/v1/prices/$pr1.id" },
      { method: "POST", path: "/v1/prices/$pr1.id", params: { active: false, metadata: { retired: "yes" } } },
      { method: "GET", path: "/v1/prices", params: { product: "$p1.id" } },
      { method: "POST", path: "/v1/products/$p1.id", params: { name: `Parity product ${n} v2`, description: `Revision ${g.int(2, 9)}` } },
    ];
  },
};

// #4
export const paymentMethodAttach: Template = {
  name: "payment-method-attach",
  stratum: "lifecycle",
  build(g) {
    const [first, second] = g.bool() ? (["pm_card_visa", "pm_card_mastercard"] as const) : (["pm_card_mastercard", "pm_card_visa"] as const);
    const list: Step = { method: "GET", path: "/v1/payment_methods", params: { customer: "$c1.id" } };
    return [
      customer("payment-method-attach", tag(g)),
      attach(first),
      list,
      { method: "POST", path: "/v1/customers/$c1.id", params: { invoice_settings: { default_payment_method: "$pm1.id" } } },
      attach(second, "pm2"),
      { method: "POST", path: "/v1/payment_methods/$pm1.id/detach" },
      list,
    ];
  },
};

// #5
export const subscriptionCreate: Template = {
  name: "subscription-create",
  stratum: "lifecycle",
  build(g) {
    return [
      ...subscribed(g, "subscription-create").steps,
      { method: "GET", path: "/v1/subscriptions/$s1.id", params: { expand: ["latest_invoice"] } },
      { method: "GET", path: "/v1/invoices", params: { customer: "$c1.id" } },
    ];
  },
};
