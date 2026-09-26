// Shared billing semantics: calendar-correct periods, a subscription's first invoice, and one synchronous
// payment attempt (payment intent + charge) against a card whose behavior comes from cards.json.
import { readFileSync } from "node:fs";
import { TwinError, renderError } from "./errors.ts";
import type { Ctx } from "./server.ts";
import type { Emit } from "./store.ts";

type Obj = Record<string, unknown>;

const DAY = 86400;
const CARDS: Record<string, { brand: string; last4: string; behavior: string; decline_code?: string }> = JSON.parse(
  readFileSync(new URL("./cards.json", import.meta.url), "utf8"),
);

/**
 * `t` plus `count` intervals. Month and year add calendar months in UTC and clamp the day to the target
 * month's length (Jan 31 + 1 month = Feb 28, or Feb 29 in a leap year).
 */
export function addInterval(t: number, interval: string, count = 1): number {
  if (interval === "day") return t + count * DAY;
  if (interval === "week") return t + count * 7 * DAY;
  const d = new Date(t * 1000);
  const [y, m] = [d.getUTCFullYear(), d.getUTCMonth() + count * (interval === "year" ? 12 : 1)];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // Date.UTC carries month overflow into the year
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

/** A subscription's first invoice, finalized (`open`), one line per item. */
export function firstInvoice(ctx: Ctx, sub: Obj, customer: Obj): Obj {
  const now = ctx.now();
  const id = ctx.id("in");
  const lines = ((sub.items as Obj).data as Obj[]).map((item) => {
    const price = item.price as Obj;
    const quantity = item.quantity as number;
    const amount = ((price.unit_amount as number | null) ?? 0) * quantity;
    return ctx.build("line_item", {
      id: ctx.id("il"),
      amount,
      currency: price.currency,
      invoice: id,
      parent: {
        invoice_item_details: null,
        subscription_item_details: { invoice_item: null, proration: false, proration_details: { credited_items: null }, subscription: sub.id, subscription_item: item.id },
        type: "subscription_item_details",
      },
      period: { end: item.current_period_end, start: item.current_period_start },
      pricing: { price_details: { price: price.id, product: price.product }, type: "price_details", unit_amount_decimal: price.unit_amount_decimal },
      quantity,
      quantity_decimal: String(quantity),
      subtotal: amount,
    });
  });
  const total = lines.reduce((s, l) => s + (l.amount as number), 0);
  const c = (k: string) => [`customer_${k}`, customer[k] ?? null];
  return ctx.build("invoice", {
    ...Object.fromEntries(["address", "email", "name", "phone", "shipping", "tax_exempt"].map(c)),
    id,
    amount_due: total,
    amount_remaining: total,
    auto_advance: true,
    billing_reason: "subscription_create",
    collection_method: sub.collection_method,
    created: now,
    currency: sub.currency,
    customer: customer.id,
    due_date: sub.collection_method === "send_invoice" ? now + (sub.days_until_due as number) * DAY : null,
    effective_at: now,
    lines: { data: lines, has_more: false, object: "list", url: `/v1/invoices/${id}/lines` },
    parent: { quote_details: null, subscription_details: { metadata: sub.metadata, subscription: sub.id }, type: "subscription_details" },
    period_end: now, // the first invoice's own period is the instant it was created; lines carry the item period
    period_start: now,
    status: "open",
    status_transitions: { finalized_at: now, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    subtotal: total,
    subtotal_excluding_tax: total,
    total,
    total_excluding_tax: total,
  });
}

/** The invoice after a successful (or zero-amount) payment. */
export const paid = (inv: Obj, now: number): Obj => ({
  ...inv,
  amount_paid: inv.amount_due,
  amount_remaining: 0,
  auto_advance: false,
  status: "paid",
  status_transitions: { ...(inv.status_transitions as Obj), paid_at: now },
});

export interface Attempt {
  /** Final state of the payment intent (also the last emit for it). */
  pi: Obj;
  ok: boolean;
  emits: Emit[];
  /** Set when the card declined: the rendered 402 card error (`{ status, body }`). */
  declined?: { status: number; body: { error: Obj } };
}

/**
 * Creates a payment intent for the invoice's `amount_due` and, when `pm` is given, charges it once. Without
 * `pm` the intent stays `requires_payment_method` and nothing is charged.
 */
export function attemptPayment(ctx: Ctx, invoice: Obj, pm: Obj | undefined): Attempt {
  const now = ctx.now();
  const { amount_due: amount, currency, customer } = invoice as { amount_due: number; currency: unknown; customer: unknown };
  const created = ctx.build("payment_intent", {
    id: ctx.id("pi"),
    amount,
    created: now,
    currency,
    customer,
    payment_details: { customer_reference: null, order_reference: invoice.id }, // dahlia's link from the intent to its invoice
    status: "requires_payment_method",
  });
  const emits: Emit[] = [{ type: "payment_intent.created", object: created }];
  if (!pm) return { pi: created, ok: false, emits };

  // The card number decides the outcome, as with the real test cards: match the stored card to its token.
  const card = pm.card as Obj;
  const token = Object.values(CARDS).find((c) => c.brand === card.brand && c.last4 === card.last4);
  const ok = token?.behavior !== "charge_fails";
  const charge = ctx.build("charge", {
    id: ctx.id("ch"),
    amount,
    amount_captured: ok ? amount : 0,
    captured: ok,
    created: now,
    currency,
    customer,
    failure_code: ok ? null : "card_declined",
    paid: ok,
    payment_intent: created.id,
    payment_method: pm.id,
    status: ok ? "succeeded" : "failed",
  });
  if (ok) {
    const pi = { ...created, amount_received: amount, latest_charge: charge.id, payment_method: pm.id, status: "succeeded" };
    return { pi, ok, emits: [...emits, { type: "charge.succeeded", object: charge }, { type: "payment_intent.succeeded", object: pi }] };
  }
  const declined = renderError(new TwinError("card_declined", {}, { charge: charge.id, decline_code: token?.decline_code, payment_method: pm }), ctx.requestId);
  const { request_log_url: _, ...last_payment_error } = declined.body.error;
  const pi = { ...created, last_payment_error, latest_charge: charge.id };
  return { pi, ok, declined, emits: [...emits, { type: "charge.failed", object: charge }, { type: "payment_intent.payment_failed", object: pi }] };
}
