// Shared step builders for templates. Everything derives from the generator; `$run` is never used here.
import type { Gen, Step } from "../src/types.ts";

/** Per-sequence number used in emails/names so list calls can be scoped to this sequence. */
export const tag = (g: Gen): number => g.int(100_000_000, 999_999_999);
export const email = (template: string, n: number): string => `parity+${template}-${n}@example.com`;
export const amount = (g: Gen): number => g.int(500, 50_000);
export const currency = (g: Gen): string => g.pick(["usd", "usd", "usd", "eur"]);

export function customer(template: string, n: number, ref = "c1", name = `Parity ${n}`): Step {
  return { ref, method: "POST", path: "/v1/customers", params: { email: email(template, n), name, metadata: { parity: template } } };
}

export const attach = (card: string, ref = "pm1"): Step => ({
  ref,
  method: "POST",
  path: `/v1/payment_methods/${card}/attach`,
  params: { customer: "$c1.id" },
});

/**
 * Customer + attached card + inline-product price + subscription, refs c1, pm1, pr1, s1.
 * The default payment method goes on the customer or the subscription (generator's choice).
 */
export function subscribed(
  g: Gen,
  template: string,
  opts: { card?: string; paymentBehavior?: string; interval?: string } = {},
): { steps: Step[]; amount: number } {
  const n = tag(g);
  const card = opts.card ?? g.pick(["pm_card_visa", "pm_card_mastercard"]);
  const onCustomer = g.bool();
  const cur = currency(g);
  const amt = amount(g);
  const steps: Step[] = [customer(template, n), attach(card)];
  if (onCustomer) {
    steps.push({ method: "POST", path: "/v1/customers/$c1.id", params: { invoice_settings: { default_payment_method: "$pm1.id" } } });
  }
  steps.push(
    {
      ref: "pr1",
      method: "POST",
      path: "/v1/prices",
      params: {
        currency: cur,
        unit_amount: amt,
        recurring: { interval: opts.interval ?? g.pick(["month", "year"]) },
        product_data: { name: `Parity plan ${n}` },
      },
    },
    {
      ref: "s1",
      method: "POST",
      path: "/v1/subscriptions",
      params: {
        customer: "$c1.id",
        items: [{ price: "$pr1.id" }],
        default_payment_method: onCustomer ? undefined : "$pm1.id",
        payment_behavior: opts.paymentBehavior,
      },
    },
  );
  return { steps, amount: amt };
}

/** The first-invoice PaymentIntent of c1 (invoice.payment_intent is gone on dahlia). */
export const findPaymentIntent = (): Step => ({ ref: "pis", method: "GET", path: "/v1/payment_intents", params: { customer: "$c1.id" } });
