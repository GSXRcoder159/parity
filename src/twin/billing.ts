// Shared billing semantics: calendar-correct periods, subscription invoices and their lines, proration invoice
// items, the customer balance, and one synchronous payment attempt (payment intent + charge) against a card whose
// behavior comes from cards.json.
import { readFileSync } from "node:fs";
import { TwinError, renderError } from "./errors.ts";
import type { Ctx } from "./server.ts";
import type { Emit } from "./store.ts";
import { attachedPm } from "./util.ts";

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

/**
 * A price's unit amount in minor units: `unit_amount`, else its `unit_amount_decimal` (a price created with the decimal
 * has unit_amount null, observed #20), else 0. Amounts computed from it are rounded to the minor unit.
 * ponytail: Math.round (half up); the real rounding of a fractional line amount is unobserved until B1.
 */
export const unitAmount = (price: Obj): number => (price.unit_amount as number | null) ?? Number(price.unit_amount_decimal ?? 0);

/**
 * The first period boundary after `t` of a billing cycle anchored at `anchor`: anchor + k intervals for the smallest
 * such k (k = 0 when the anchor is still ahead), each step counted from the anchor so a month-end anchor keeps its
 * day (docs: an anchor of January 31 bills February 28, then March 31, April 30, ...).
 */
export function nextBoundary(anchor: number, t: number, interval: string, count = 1): number {
  let k = 0;
  while (addInterval(anchor, interval, k * count) <= t) k++;
  return addInterval(anchor, interval, k * count);
}

/** A subscription item's line for `period` at its price (not a proration: discountable, unlike prorations per the docs). */
export function itemLine(ctx: Ctx, invoice: string, sub: Obj, item: Obj, period: { start: number; end: number }, prefix = "il"): Obj {
  const price = item.price as Obj;
  const quantity = item.quantity as number;
  const amount = Math.round(unitAmount(price) * quantity);
  return ctx.build("line_item", {
    id: ctx.id(prefix),
    amount,
    currency: price.currency,
    discountable: true,
    invoice,
    parent: {
      invoice_item_details: null,
      subscription_item_details: { invoice_item: null, proration: false, proration_details: { credited_items: null }, subscription: sub.id, subscription_item: item.id },
      type: "subscription_item_details",
    },
    period,
    pricing: { price_details: { price: price.id, product: price.product }, type: "price_details", unit_amount_decimal: price.unit_amount_decimal },
    quantity,
    quantity_decimal: String(quantity),
    subtotal: amount,
  });
}

/** A proration: `amount` (negative: a credit) for `period` of `price` x `quantity` on subscription item `item`. */
export interface Proration {
  item: string;
  price: Obj;
  quantity: number;
  amount: number;
  period: { start: number; end: number };
  /** The debit a credit credits (the invoice item's `proration_details.credited_items`); null for debits. */
  credited: Obj | null;
}

/** The pending (not yet invoiced) invoice items of subscription `sub`, oldest first. */
export const pendingItems = (ctx: Ctx, sub: unknown): Obj[] =>
  ctx.all("invoiceitem").filter((ii) => ii.invoice === null && ((ii.parent as Obj).subscription_details as Obj).subscription === sub);

/**
 * The last debit of subscription item `item`, which a flexible-mode credit is based on (docs: credits use "the original
 * debited amount"): a pending proration invoice item, else the newest invoice line, with the period it billed.
 */
export function lastDebit(ctx: Ctx, sub: unknown, item: unknown): { price: Obj; quantity: number; period: { start: number; end: number }; credited: Obj } | undefined {
  const debit = (o: Obj, parent: unknown) => (o.amount as number) >= 0 && (parent as Obj | null | undefined)?.subscription_item === item;
  const ii = pendingItems(ctx, sub).findLast((i) => debit(i, (i.parent as Obj).subscription_details));
  const price = (o: Obj) => ctx.get(((o.pricing as Obj).price_details as Obj).price as string)!;
  const period = (o: Obj) => o.period as { start: number; end: number };
  if (ii) return { price: price(ii), quantity: ii.quantity as number, period: period(ii), credited: { invoice_item: ii.id, type: "invoice_item" } };
  for (const inv of ctx.all("invoice").reverse()) {
    const line = ((inv.lines as Obj).data as Obj[]).findLast((l) => debit(l, (l.parent as Obj | null)?.subscription_item_details));
    if (line) {
      const credited = { invoice_line_item_details: { invoice: inv.id, invoice_line_items: [line.id] }, type: "invoice_line_items" };
      return { price: price(line), quantity: line.quantity as number, period: period(line), credited };
    }
  }
  return undefined;
}

// ponytail: invoice items carry computed fields only: the pruned spec has no invoiceitem schema, so there is no
// template (shapes/). Add `get /v1/invoiceitems/{invoiceitem}` to scripts/prune-spec.ts and regenerate when the
// invoice items API lands; events are scored by type only, so the body is not measured today.
/** The invoice item of a proration, pending (`invoice` null) or on `invoice`. */
export function invoiceItem(ctx: Ctx, sub: Obj, p: Proration, invoice: string | null): Obj {
  return {
    id: ctx.id("ii"),
    object: "invoiceitem",
    amount: p.amount,
    currency: p.price.currency,
    customer: sub.customer,
    date: ctx.now(),
    invoice,
    livemode: false,
    parent: { subscription_details: { subscription: sub.id, subscription_item: p.item }, type: "subscription_details" },
    period: p.period,
    pricing: { price_details: { price: p.price.id, product: p.price.product }, type: "price_details", unit_amount_decimal: null },
    proration: true,
    proration_details: { credited_items: p.credited },
    quantity: p.quantity,
    quantity_decimal: String(p.quantity),
  };
}

/** The invoice line of invoice item `ii` on `invoice`. A line can only credit invoice lines (not a pending item). */
export function invoiceItemLine(ctx: Ctx, invoice: string, ii: Obj, prefix = "il"): Obj {
  const { subscription, subscription_item } = (ii.parent as Obj).subscription_details as Obj;
  const credited = ((ii.proration_details as Obj).credited_items as Obj | null)?.invoice_line_item_details ?? null;
  return ctx.build("line_item", {
    id: ctx.id(prefix),
    amount: ii.amount,
    currency: ii.currency,
    invoice,
    parent: {
      invoice_item_details: null,
      subscription_item_details: { invoice_item: ii.id, proration: true, proration_details: { credited_items: credited }, subscription, subscription_item },
      type: "subscription_item_details",
    },
    period: ii.period,
    pricing: ii.pricing,
    quantity: ii.quantity,
    quantity_decimal: ii.quantity_decimal,
    subtotal: ii.amount,
  });
}

/**
 * An invoice of `sub` over `lines`, finalized (`open`) at `at`; `fields` override (a preview is a draft). The
 * invoice's own period defaults to the instant `at`; lines carry the item periods.
 */
export function subInvoice(ctx: Ctx, sub: Obj, customer: Obj, id: string, lines: Obj[], fields: Obj = {}, at = ctx.now()): Obj {
  const total = lines.reduce((s, l) => s + (l.amount as number), 0);
  const c = (k: string) => [`customer_${k}`, customer[k] ?? null];
  return ctx.build("invoice", {
    ...Object.fromEntries(["address", "email", "name", "phone", "shipping", "tax_exempt"].map(c)),
    id,
    amount_due: total,
    amount_remaining: total,
    auto_advance: true,
    collection_method: sub.collection_method,
    created: at,
    currency: sub.currency,
    customer: customer.id,
    due_date: sub.collection_method === "send_invoice" ? at + (sub.days_until_due as number) * DAY : null,
    effective_at: at,
    lines: { data: lines, has_more: false, object: "list", total_count: lines.length, url: `/v1/invoices/${id}/lines` },
    parent: { quote_details: null, subscription_details: { metadata: sub.metadata, subscription: sub.id }, type: "subscription_details" },
    period_end: at,
    period_start: at,
    status: "open",
    status_transitions: { finalized_at: at, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    subtotal: total,
    subtotal_excluding_tax: total,
    test_clock: customer.test_clock ?? null,
    total,
    total_excluding_tax: total,
    ...fields,
  });
}

/**
 * A subscription's first invoice, finalized (`open`), one line per item for its current period (a trial's: 0, per the
 * docs), with the customer's balance applied (its `ending_balance` is the customer's new balance).
 */
export function firstInvoice(ctx: Ctx, sub: Obj, customer: Obj): Obj {
  const id = ctx.id("in");
  const lines = ((sub.items as Obj).data as Obj[]).map((item) => {
    const line = itemLine(ctx, id, sub, item, { end: item.current_period_end as number, start: item.current_period_start as number });
    return sub.status === "trialing" ? { ...line, amount: 0, subtotal: 0 } : line;
  });
  return applyBalance(subInvoice(ctx, sub, customer, id, lines, { billing_reason: "subscription_create" }), customer.balance as number);
}

/**
 * `inv` with the customer's `balance` applied: a credit (negative) lowers `amount_due`, not below 0, and what is left
 * of it is `ending_balance` (the customer's new balance); an amount owed (positive) is added to `amount_due`.
 */
export function applyBalance(inv: Obj, balance: number): Obj {
  const net = (inv.total as number) + balance;
  return { ...inv, amount_due: Math.max(net, 0), amount_remaining: Math.max(net, 0), ending_balance: Math.min(net, 0), starting_balance: balance };
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
 * Creates a payment intent for the invoice's `amount_due` (or confirms `intent`, the invoice's open one) and, when
 * `pm` is given, charges it once. Without `pm` the intent stays `requires_payment_method` and nothing is charged.
 */
export function attemptPayment(ctx: Ctx, invoice: Obj, pm: Obj | undefined, intent?: Obj): Attempt {
  const now = ctx.now();
  const { amount_due: amount, currency, customer } = invoice as { amount_due: number; currency: unknown; customer: unknown };
  const created = intent ?? ctx.build("payment_intent", {
    id: ctx.id("pi"),
    amount,
    created: now,
    currency,
    customer,
    payment_details: { customer_reference: null, order_reference: invoice.id }, // dahlia's link from the intent to its invoice
    status: "requires_payment_method",
  });
  const emits: Emit[] = intent ? [] : [{ type: "payment_intent.created", object: created }];
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
    const pi = { ...created, amount_received: amount, last_payment_error: null, latest_charge: charge.id, payment_method: pm.id, status: "succeeded" };
    return { pi, ok, emits: [...emits, { type: "charge.succeeded", object: charge }, { type: "payment_intent.succeeded", object: pi }] };
  }
  const declined = renderError(new TwinError("card_declined", {}, { charge: charge.id, decline_code: token?.decline_code, payment_method: pm }), ctx.requestId);
  const { request_log_url: _, ...last_payment_error } = declined.body.error;
  const pi = { ...created, last_payment_error, latest_charge: charge.id };
  return { pi, ok, declined, emits: [...emits, { type: "charge.failed", object: charge }, { type: "payment_intent.payment_failed", object: pi }] };
}

/** The invoice's payment intent still awaiting payment: created at finalization, or left by a failed attempt. */
export const openIntent = (ctx: Ctx, inv: Obj): Obj | undefined =>
  ctx.all("payment_intent").findLast((pi) => (pi.payment_details as Obj).order_reference === inv.id && pi.status === "requires_payment_method");

/**
 * Collects a finalized invoice the way a subscription update does (payment_behavior allow_incomplete), and a test
 * clock's automatic collection and retries: nothing due -> paid; charge_automatically -> one attempt with the
 * subscription's, else the customer's, default payment method, confirming the invoice's open payment intent if it has
 * one (`failed` when it does not succeed); send_invoice stays open. `emits` are the payment events and the invoice
 * events: `types` (default: a mid-cycle invoice's created + finalized), then the payment's.
 */
export function collect(ctx: Ctx, sub: Obj, customer: Obj, inv: Obj, prefix = ["invoice.created", "invoice.finalized"]): { invoice: Obj; emits: Emit[]; failed: boolean } {
  const now = ctx.now();
  const types = [...prefix];
  const emits: Emit[] = [];
  let failed = false;
  if (inv.amount_due === 0) {
    inv = { ...paid(inv, now), attempted: true }; // attempt_count stays 0 (observed, #17 always_invoice downgrade)
    types.push("invoice.paid", "invoice.payment_succeeded");
  } else if (sub.collection_method === "charge_automatically") {
    const pm = attachedPm(ctx, sub.default_payment_method || (customer.invoice_settings as Obj | null)?.default_payment_method, customer.id);
    const attempt = attemptPayment(ctx, inv, pm, openIntent(ctx, inv));
    emits.push(...attempt.emits);
    if (pm) inv = { ...inv, attempt_count: (inv.attempt_count as number) + 1, attempted: true };
    if (attempt.ok) {
      inv = paid(inv, now);
      types.push("invoice.paid", "invoice.payment_succeeded");
    } else failed = true;
    if (attempt.declined) types.push("invoice.payment_failed");
  }
  return { invoice: inv, emits: [...emits, ...types.map((type) => ({ type, object: inv }))], failed };
}
