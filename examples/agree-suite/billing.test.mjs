// A tiny billing integration suite for `paritybench agree`: customer, card, price, subscription, a previewed and applied
// price change, cancellation and a refund, all through fetch.
//
// The one-line contract a real suite needs: send every request to process.env.STRIPE_API_BASE (and authenticate with
// process.env.STRIPE_API_KEY). With stripe-node, pass the base's host, port and protocol as the client's `host`, `port`
// and `protocol` options.
//
// Run it on the twin alone (the sandbox half needs a full sk_test_ key in .env):
//   paritybench agree --cmd "node --test --test-reporter=tap examples/agree-suite/billing.test.mjs" --runs twin
import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = process.env.STRIPE_API_BASE ?? "https://api.stripe.com";
const KEY = process.env.STRIPE_API_KEY;
const tag = Date.now().toString(36);

/** One API call; params are form fields with bracket keys (`items[0][price]`), sent as the query string on GET. */
async function call(method, path, params = {}) {
  const form = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}${method === "GET" && form ? `?${form}` : ""}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Stripe-Version": "2026-08-26.dahlia", "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : form,
  });
  const body = await res.json();
  assert.equal(res.status, 200, `${method} ${path} answered ${res.status} ${body.error?.code ?? body.error?.type ?? ""}`);
  return body;
}

let customer, priceA, priceB, sub;

test("creates a customer", async () => {
  customer = await call("POST", "/v1/customers", { email: `agree+${tag}@example.com`, name: `Agree ${tag}` });
  assert.match(customer.id, /^cus_/);
});

test("attaches a card as the default payment method", async () => {
  const pm = await call("POST", "/v1/payment_methods/pm_card_visa/attach", { customer: customer.id });
  const c = await call("POST", `/v1/customers/${customer.id}`, { "invoice_settings[default_payment_method]": pm.id });
  assert.equal(c.invoice_settings.default_payment_method, pm.id);
});

test("creates a monthly price", async () => {
  priceA = await call("POST", "/v1/prices", { currency: "usd", unit_amount: "2000", "recurring[interval]": "month", "product_data[name]": `Agree plan ${tag}` });
  assert.equal(priceA.recurring.interval, "month");
});

test("subscribes the customer and charges the first invoice", async () => {
  sub = await call("POST", "/v1/subscriptions", { customer: customer.id, "items[0][price]": priceA.id, "expand[0]": "latest_invoice" });
  assert.equal(sub.status, "active");
  assert.equal(sub.latest_invoice.status, "paid");
  assert.equal(sub.latest_invoice.amount_paid, 2000);
});

test("previews a price change with a credit for unused time", async () => {
  priceB = await call("POST", "/v1/prices", { currency: "usd", unit_amount: "5000", "recurring[interval]": "month", product: priceA.product });
  const preview = await call("POST", "/v1/invoices/create_preview", {
    subscription: sub.id,
    "subscription_details[items][0][id]": sub.items.data[0].id,
    "subscription_details[items][0][price]": priceB.id,
    "subscription_details[proration_behavior]": "create_prorations",
  });
  assert.equal(preview.object, "invoice");
  assert.ok(preview.lines.data.some((line) => line.amount < 0), "a negative proration line for the unused time on the old price");
});

test("applies the price change", async () => {
  const updated = await call("POST", `/v1/subscriptions/${sub.id}`, {
    "items[0][id]": sub.items.data[0].id,
    "items[0][price]": priceB.id,
    proration_behavior: "create_prorations",
  });
  assert.equal(updated.items.data[0].price.id, priceB.id);
});

test("cancels the subscription", async () => {
  const canceled = await call("DELETE", `/v1/subscriptions/${sub.id}`);
  assert.equal(canceled.status, "canceled");
});

test("refunds the first payment", async () => {
  const intents = await call("GET", "/v1/payment_intents", { customer: customer.id });
  const refund = await call("POST", "/v1/refunds", { payment_intent: intents.data[0].id });
  assert.equal(refund.status, "succeeded");
  assert.equal(refund.amount, 2000);
});
