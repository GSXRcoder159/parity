// Subscriptions: create (first invoice + synchronous payment; send_invoice: a draft; trial_period_days: trialing on a $0
// first invoice; a test clock's customer's runs at the clock's time, server.ts), retrieve, list, update (items: price swaps,
// quantities, additions, deletions; proration_behavior, proration_date, billing_cycle_anchor=now;
// cancel_at_period_end, metadata, default_payment_method, description), cancel. `change` is shared with
// POST /v1/invoices/create_preview.
import {
  type Proration,
  addInterval,
  applyBalance,
  attemptPayment,
  collect,
  firstInvoice,
  invoiceItem,
  invoiceItemLine,
  itemLine,
  lastDebit,
  paid,
  pendingItems,
  subInvoice,
  unitAmount,
} from "../billing.ts";
import { list } from "../list.ts";
import type { Ctx, Route } from "../server.ts";
import type { Emit } from "../store.ts";
import { assign, checkAttached, diff, isHash, live } from "../util.ts";

type Obj = Record<string, unknown>;

const find = (ctx: Ctx, id: string | undefined) => live(ctx, id, "subscription") ?? ctx.fail("resource_missing", { param: "id" });
export const cancellation = (reason: string | null): Obj => ({ comment: null, feedback: null, feedback_option: null, reason });
const UPDATABLE = ["billing_cycle_anchor", "cancel_at_period_end", "default_payment_method", "description", "items", "metadata", "proration_behavior", "proration_date"];
const CREATABLE = [
  "cancel_at_period_end",
  "collection_method",
  "customer",
  "days_until_due",
  "default_payment_method",
  "description",
  "items",
  "metadata",
  "payment_behavior",
  "trial_period_days",
];
export const ITEM = ["metadata", "price", "price_data", "quantity"];

/** A spec-valid param the handler does not implement (trials, anchors, discounts, ...) fails instead of being dropped. */
export function only(ctx: Ctx, o: Obj, keys: string[]): void {
  if (Object.entries(o).some(([k, v]) => v !== "" && !keys.includes(k))) ctx.fail("not_implemented");
}

/** The fields `cancel_at_period_end` sets (cancel at the item period end) or clears. */
function periodEndCancel(sub: Obj, on: boolean, now: number): Obj {
  if (!on) return { cancel_at: null, cancel_at_period_end: false, canceled_at: null, cancellation_details: cancellation(null) };
  const end = ((sub.items as Obj).data as Obj[])[0]!.current_period_end;
  return { cancel_at: end, cancel_at_period_end: true, canceled_at: now, cancellation_details: cancellation("cancellation_requested") };
}

/** The legacy `plan` object mirroring a recurring price (kept for API back-compat: both the subscription's and each
 * subscription item's `plan` field track the same price). */
function legacyPlan(price: Obj): Obj {
  const r = price.recurring as Obj;
  return {
    id: price.id,
    object: "plan",
    active: price.active,
    amount: price.unit_amount,
    amount_decimal: price.unit_amount_decimal,
    billing_scheme: "per_unit",
    created: price.created,
    currency: price.currency,
    interval: r.interval,
    interval_count: r.interval_count,
    livemode: price.livemode,
    metadata: price.metadata,
    meter: r.meter,
    nickname: price.nickname ?? null,
    product: price.product,
    tiers_mode: null,
    transform_usage: null,
    trial_period_days: r.trial_period_days,
    usage_type: r.usage_type,
  };
}

/** The recurring price of `items[i]`: an existing price, or a new inactive one from `price_data` (pushed to `puts`). */
export function itemPrice(ctx: Ctx, item: Obj, i: number, puts: Obj[]): Obj {
  const param = `items[${i}][price]`;
  let price: Obj;
  if (item.price) price = live(ctx, item.price, "price") ?? ctx.fail("resource_missing_400", { param });
  else if (isHash(item.price_data)) {
    const pd = item.price_data;
    const p = `items[${i}][price_data]`;
    only(ctx, pd, ["currency", "product", "recurring", "unit_amount"]);
    for (const k of ["currency", "product", "recurring"]) if (!pd[k]) ctx.fail("parameter_missing", { param: `${p}[${k}]` });
    if (!live(ctx, pd.product, "product")) ctx.fail("resource_missing_400", { param: `${p}[product]` });
    const r = pd.recurring as Obj;
    if (!r.interval) ctx.fail("parameter_missing", { param: `${p}[recurring][interval]` });
    const unit = typeof pd.unit_amount === "number" ? pd.unit_amount : null;
    // ponytail: inline prices are stored without events (the real API's event set for them is unobserved).
    price = ctx.build("price", {
      id: ctx.id("price"),
      active: false,
      created: ctx.now(),
      currency: String(pd.currency).toLowerCase(),
      product: pd.product,
      recurring: { interval: r.interval, interval_count: r.interval_count ?? 1, meter: null, trial_period_days: null, usage_type: "licensed" },
      type: "recurring",
      unit_amount: unit,
      unit_amount_decimal: unit === null ? null : String(unit),
    });
    puts.push(price);
  } else return ctx.fail("parameter_missing", { param });
  if (price.type !== "recurring") ctx.fail("price_not_recurring", { param });
  return price;
}

/** A new item of subscription `sub` at `price` from `items[i]`; its period is `period`, else one interval from now. */
export function newItem(ctx: Ctx, it: Obj, price: Obj, sub: unknown, period?: { start: unknown; end: unknown }): Obj {
  const now = ctx.now();
  const r = price.recurring as Obj;
  const item = ctx.build("subscription_item", {
    id: ctx.id("si"),
    created: now,
    current_period_end: period?.end ?? addInterval(now, r.interval as string, r.interval_count as number),
    current_period_start: period?.start ?? now,
    plan: legacyPlan(price),
    price,
    quantity: it.quantity ?? 1,
    subscription: sub,
  });
  return assign(item, it, ["metadata"]);
}

/** The legacy `subscription.quantity`: the single item's quantity, null with several items. */
const legacyQuantity = (items: Obj[]) => (items.length === 1 ? items[0]!.quantity : null);

const recurrence = (price: Obj) => [(price.recurring as Obj).interval, (price.recurring as Obj).interval_count].join();

/**
 * `sub` after the changes in `p` at `now`, and the flexible-mode prorations they create. `p` holds an update's params
 * or a preview's `subscription_details`: `items` (`id` + `price`/`price_data`/`quantity`/`metadata`, `deleted`, or a
 * new item), `proration_behavior` (`none`: no prorations), `proration_date` (default now), `billing_cycle_anchor=now`.
 * Per changed item: a credit for the unused time of its last debit (flexible mode credits what was billed) and a
 * debit for the rest of its period at the new price and quantity, by the second over the item's current period,
 * each rounded to the nearest minor unit. `billing_cycle_anchor=now` restarts every item's period now, on its own
 * interval (a price on another billing period, e.g. monthly -> yearly, is accepted only with it). With item
 * changes, whatever `proration_behavior`, each item is credited (unless `none`) and the new period billed in full on
 * an immediate invoice (`reset`), so there are no debit prorations. Without item changes, flexible mode nets the credit
 * and debit (docs: billing-mode/compare): `none` creates nothing, the other behaviors are refused (below).
 * `immediate`: the change is invoiced now (an item-changing reset, or always_invoice with prorations).
 */
export function change(ctx: Ctx, sub: Obj, p: Obj, puts: Obj[]): { after: Obj; prorations: Proration[]; reset: boolean; immediate: boolean; date: number } {
  const now = ctx.now();
  const before = (sub.items as Obj).data as Obj[];
  const items = structuredClone(before);
  const raw = Array.isArray(p.items) ? (p.items as Obj[]) : [];
  // ponytail: an anchor timestamp (create_preview's spec allows one, the update's only now|unchanged) is refused: the
  // debit up to a future anchor (docs: prorations) is unobserved.
  if (![undefined, "", "now", "unchanged"].includes(p.billing_cycle_anchor as string)) ctx.fail("not_implemented");
  const reset = p.billing_cycle_anchor === "now";
  // ponytail: changing a canceled subscription is refused (the real API's error is unobserved), and so is changing a
  // trialing one (prorations during a trial are unobserved).
  if ((raw.length > 0 || reset) && ["canceled", "trialing"].includes(sub.status as string)) ctx.fail("not_implemented");
  const changed: [Obj | undefined, Obj | undefined][] = [];
  let moved = false; // a price on another billing period
  raw.forEach((it, i) => {
    only(ctx, it, ["deleted", "id", ...ITEM]);
    const at = it.id ? items.findIndex((x) => x.id === it.id) : -1;
    if (it.id && at < 0) ctx.fail("resource_missing_400", { param: `items[${i}][id]` });
    const old = items[at];
    if (it.deleted === true) {
      if (!old) ctx.fail("parameter_missing", { param: `items[${i}][id]` });
      changed.push([old, undefined]);
      items.splice(at, 1);
      return;
    }
    const price = old && !it.price && !isHash(it.price_data) ? (old.price as Obj) : itemPrice(ctx, it, i, puts);
    const like = (old ?? before[0]!).price as Obj;
    // ponytail: a price in another currency, or a new item on a price the subscription already has, is refused (the
    // real API's answers are unobserved). So is a price on another billing period without billing_cycle_anchor=now:
    // flexible mode never resets the anchor by itself (docs: billing-mode/compare), and how the new period then aligns
    // is undocumented; unobserved until B1. With the reset, every item restarts now on its own period (below).
    const dup = !old && items.some((x) => (x.price as Obj).id === price.id);
    const other = recurrence(price) !== recurrence(like);
    if (price.currency !== like.currency || dup || (other && !reset)) ctx.fail("not_implemented");
    moved ||= other;
    const next = old
      ? { ...assign({ ...old, price, quantity: it.quantity ?? old.quantity }, it, ["metadata"]), plan: legacyPlan(price) }
      : newItem(ctx, it, price, sub.id, { start: before[0]!.current_period_start, end: before[0]!.current_period_end });
    if (!old || (old.price as Obj).id !== price.id || old.quantity !== next.quantity) changed.push([old, next]);
    if (old) items[at] = next;
    else items.push(next);
  });
  if (items.length === 0) ctx.fail("not_implemented"); // ponytail: deleting every item (the real API's error is unobserved)
  // ponytail: a period change that leaves items on different periods is refused (mixed intervals: the docs' alignment
  // rules are unvalidated).
  if (moved && new Set(items.map((x) => recurrence(x.price as Obj))).size > 1) ctx.fail("not_implemented");
  // ponytail: an anchor reset without item changes nets the credit for [now, old end] against the new period's debit
  // into one proration=true item for [old end, new end] (pending, or invoiced now with always_invoice). Its amount is
  // unobserved when the old and new periods differ in length (the docs' example has equal ones): refused until B1.
  if (reset && changed.length === 0 && p.proration_behavior !== "none") ctx.fail("not_implemented");

  const date = typeof p.proration_date === "number" ? p.proration_date : now;
  const prorations: Proration[] = [];
  const part = (item: Obj, price: Obj, quantity: number) => {
    const [start, end] = [item.current_period_start as number, item.current_period_end as number];
    // ponytail: a proration_date outside the item's current period is refused (the real API's error is unobserved).
    if (date < start || date > end) ctx.fail("not_implemented");
    return { amount: Math.round((unitAmount(price) * quantity * (end - date)) / (end - start)), period: { end, start: date } };
  };
  const credit = (old: Obj) => {
    const d = lastDebit(ctx, sub.id, old.id);
    // ponytail: the credit assumes one debit billed all of [date, period end] (docs: one credit per original debit, and
    // no debit, no credit). Refused otherwise: an item never billed (added under none), a period restarted by a none
    // anchor reset, a proration_date before the last debit. Unobserved until B1.
    if (!d || d.period.start > date || d.period.end !== old.current_period_end) return ctx.fail("not_implemented");
    const { amount, period } = part(old, d.price, d.quantity);
    prorations.push({ item: old.id as string, price: d.price, quantity: d.quantity, amount: -amount, period, credited: d.credited });
  };
  const debit = (next: Obj) => {
    const [price, quantity] = [next.price as Obj, next.quantity as number];
    prorations.push({ item: next.id as string, price, quantity, ...part(next, price, quantity), credited: null });
  };
  if (p.proration_behavior !== "none") {
    if (reset) before.forEach(credit);
    else
      for (const [old, next] of changed) {
        if (old) credit(old);
        if (next) debit(next);
      }
  }
  if (reset)
    for (const item of items) {
      const r = (item.price as Obj).recurring as Obj;
      Object.assign(item, { current_period_end: addInterval(now, r.interval as string, r.interval_count as number), current_period_start: now });
    }
  const after: Obj = {
    ...structuredClone(sub),
    items: { ...(sub.items as Obj), data: items },
    plan: legacyPlan(items[0]!.price as Obj),
    quantity: legacyQuantity(items),
  };
  if (reset) after.billing_cycle_anchor = now;
  const billed = reset && changed.length > 0;
  return { after, prorations, reset: billed, immediate: billed || (p.proration_behavior === "always_invoice" && prorations.length > 0), date };
}

const ID = /^\/v1\/subscriptions\/(?<id>[^/]+)$/;

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/subscriptions$/,
    (ctx, { params }) => {
      only(ctx, params, ["expand", ...CREATABLE]);
      if (!params.customer) ctx.fail("parameter_missing", { param: "customer" });
      const rawItems = Array.isArray(params.items) ? (params.items as Obj[]) : [];
      if (rawItems.length === 0) ctx.fail("parameter_missing", { param: "items" });
      const collection = (params.collection_method as string) || "charge_automatically";
      if (collection === "send_invoice" && typeof params.days_until_due !== "number") ctx.fail("parameter_missing", { param: "days_until_due" });
      const customer = live(ctx, params.customer, "customer") ?? ctx.fail("resource_missing_400", { param: "customer" });
      checkAttached(ctx, params.default_payment_method, customer.id);

      const now = ctx.now();
      const id = ctx.id("sub");
      const puts: Obj[] = [];
      // A trial is the first period: it ends trial_period_days from now, where the paid periods start (docs: trials).
      const days = typeof params.trial_period_days === "number" ? params.trial_period_days : 0;
      if (days < 0) ctx.fail("not_implemented"); // ponytail: the real API's error is unobserved
      const trialEnd = days > 0 ? now + days * 86400 : null;
      const items = rawItems.map((it, i) => {
        only(ctx, it, ITEM);
        return newItem(ctx, it, itemPrice(ctx, it, i, puts), id, trialEnd ? { end: trialEnd, start: now } : undefined);
      });
      let sub = assign(
        ctx.build("subscription", {
          id,
          billing_cycle_anchor: trialEnd ?? now,
          billing_mode: { flexible: { proration_discounts: "included" }, type: "flexible", updated_at: now },
          cancellation_details: cancellation(null),
          collection_method: collection,
          created: now,
          currency: (items[0]!.price as Obj).currency,
          customer: customer.id,
          days_until_due: collection === "send_invoice" ? params.days_until_due : null,
          default_payment_method: params.default_payment_method || null,
          items: { data: items, has_more: false, object: "list", url: `/v1/subscription_items?subscription=${id}` },
          plan: legacyPlan(items[0]!.price as Obj),
          quantity: legacyQuantity(items),
          start_date: now,
          status: trialEnd ? "trialing" : "active",
          test_clock: customer.test_clock ?? null,
          trial_end: trialEnd,
          trial_start: trialEnd ? now : null,
        }),
        params,
        ["description", "metadata"],
      );
      if (params.cancel_at_period_end === true) sub = { ...sub, ...periodEndCancel(sub, true, now) };

      let invoice = firstInvoice(ctx, sub, customer);
      sub.latest_invoice = invoice.id;
      const invoiceEvents = collection === "send_invoice" ? ["invoice.created"] : ["invoice.created", "invoice.finalized"];
      const emits: Emit[] = [];
      if (collection === "send_invoice") {
        // The first invoice stays a draft, finalized automatically 72 h after creation (observed, #19); the customer's
        // balance is consumed when it is finalized (invoices.ts). ponytail: a zero-amount one stays a draft too (unobserved).
        const transitions = { ...(invoice.status_transitions as Obj), finalized_at: null };
        invoice = { ...invoice, automatically_finalizes_at: now + 72 * 3600, effective_at: null, ending_balance: null, status: "draft", status_transitions: transitions };
      } else if (invoice.amount_due === 0) {
        invoice = paid(invoice, now);
        invoiceEvents.push("invoice.paid", "invoice.payment_succeeded");
      } else {
        // ponytail: pending_if_incomplete is treated like allow_incomplete.
        const behavior = (params.payment_behavior as string) || "allow_incomplete";
        const pmId = params.default_payment_method || (customer.invoice_settings as Obj | null)?.default_payment_method;
        const pm = behavior === "default_incomplete" ? undefined : live(ctx, pmId, "payment_method");
        if (!pm && behavior === "error_if_incomplete") ctx.fail("customer_no_payment_method");
        const attempt = attemptPayment(ctx, invoice, pm);
        emits.push(...attempt.emits);
        if (attempt.declined && behavior === "error_if_incomplete") {
          // 402, and only the payment intent (canceled) and the failed charge persist: no invoice, no subscription.
          const pi = { ...attempt.pi, canceled_at: now, cancellation_reason: "failed_invoice", status: "canceled" };
          return { ...attempt.declined, emits: [...emits, { type: "payment_intent.canceled", object: pi }] };
        }
        if (attempt.ok) {
          invoice = paid(invoice, now);
          invoiceEvents.push("invoice.paid", "invoice.payment_succeeded");
        } else sub.status = "incomplete";
        if (attempt.declined) invoiceEvents.push("invoice.payment_failed");
        if (pm) invoice = { ...invoice, attempt_count: 1, attempted: true };
      }

      emits.push({ type: "customer.subscription.created", object: sub });
      // The first subscription fixes the customer's billing currency; the first invoice consumes the customer's balance
      // (a draft: not yet). ponytail: one customer.updated for both (a balance at subscription create is unobserved).
      const customerAfter = { ...customer, balance: invoice.ending_balance ?? customer.balance, currency: customer.currency || sub.currency };
      const customerPrev = diff(customer, customerAfter);
      if (Object.keys(customerPrev).length > 0) emits.push({ type: "customer.updated", object: customerAfter, previous_attributes: customerPrev });
      emits.push(...invoiceEvents.map((type) => ({ type, object: invoice })));
      return { body: sub, emits, puts };
    },
    "post /v1/subscriptions",
  ],
  [
    "GET",
    /^\/v1\/subscriptions$/,
    (ctx, { params }) => {
      const { customer, price, status, test_clock } = params;
      const hasStatus = (s: unknown) =>
        status === "all" || (status === "ended" ? s === "canceled" || s === "incomplete_expired" : status ? s === status : s !== "canceled");
      const hit = (s: Obj) =>
        (!customer || s.customer === customer) &&
        // Docs: a clock's subscriptions are listed only with its test_clock or their customer.
        (test_clock ? s.test_clock === test_clock : customer || !s.test_clock) &&
        hasStatus(s.status) &&
        (!price || ((s.items as Obj).data as Obj[]).some((i) => (i.price as Obj).id === price));
      return { body: list(ctx.all("subscription").filter(hit), params, "/v1/subscriptions") };
    },
    "get /v1/subscriptions",
  ],
  ["GET", ID, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.id) }), "get /v1/subscriptions/{subscription_exposed_id}"],
  [
    "POST",
    ID,
    (ctx, { pathParams, params }) => {
      const before = find(ctx, pathParams.id);
      only(ctx, params, ["expand", ...UPDATABLE]);
      checkAttached(ctx, params.default_payment_method, before.customer);
      const now = ctx.now();
      const puts: Obj[] = [];
      const { after: changed, prorations, reset, immediate } = change(ctx, before, params, puts);
      let after = assign(changed, params, ["default_payment_method", "description", "metadata"]);
      const cape = params.cancel_at_period_end;
      if (typeof cape === "boolean" && cape !== before.cancel_at_period_end) after = { ...after, ...periodEndCancel(after, cape, now) };

      // create_prorations leaves the prorations pending for the next invoice; always_invoice (with prorations) and an
      // item-changing anchor reset invoice now, sweeping in the subscription's pending items, and collect that invoice.
      const inId = immediate ? ctx.id("in") : null;
      const iis = prorations.map((p) => invoiceItem(ctx, after, p, inId));
      const tail: Emit[] = [];
      if (inId) {
        // ponytail: a deleted customer's subscriptions are canceled with it (customers.ts), so change() refuses them
        // before this; the refusal stays in case a path gets here (billing a tombstone has no observed answer).
        const customer = live(ctx, after.customer, "customer") ?? ctx.fail("not_implemented");
        const swept = pendingItems(ctx, after.id).map((ii) => ({ ...ii, invoice: inId }));
        puts.push(...swept); // ponytail: no invoiceitem.updated for swept items (unobserved)
        const lines = [...swept, ...iis].map((ii) => invoiceItemLine(ctx, inId, ii));
        if (reset) for (const item of (after.items as Obj).data as Obj[]) lines.push(itemLine(ctx, inId, after, item, { end: item.current_period_end as number, start: now }));
        const latest = ctx.get(before.latest_invoice as string);
        const fields = { billing_reason: "subscription_update", period_start: latest?.period_end ?? now };
        const inv = applyBalance(subInvoice(ctx, after, customer, inId, lines, fields), customer.balance as number);
        const collected = collect(ctx, after, customer, inv);
        after.latest_invoice = inId;
        if (collected.failed) after.status = "past_due"; // payment_behavior allow_incomplete (the update default)
        if (inv.ending_balance !== customer.balance) {
          tail.push({ type: "customer.updated", object: { ...customer, balance: inv.ending_balance }, previous_attributes: { balance: customer.balance } });
        }
        tail.push(...collected.emits);
      }
      const previous_attributes = diff(before, after);
      const emits: Emit[] = Object.keys(previous_attributes).length > 0 ? [{ type: "customer.subscription.updated", object: after, previous_attributes }] : [];
      emits.push(...iis.map((object) => ({ type: "invoiceitem.created", object })), ...tail);
      return { body: after, emits, puts };
    },
    "post /v1/subscriptions/{subscription_exposed_id}",
  ],
  [
    "DELETE",
    ID,
    (ctx, { pathParams, params }) => {
      const before = find(ctx, pathParams.id);
      if (before.status === "canceled") ctx.fail("resource_missing", { param: "id" });
      // ponytail: a final invoice and proration at cancel are refused: unobserved until B1 (no template covers them).
      if (params.invoice_now || params.prorate) ctx.fail("not_implemented");
      const now = ctx.now();
      const details = assign(cancellation("cancellation_requested"), isHash(params.cancellation_details) ? params.cancellation_details : {});
      const after = { ...before, canceled_at: now, cancellation_details: details, ended_at: now, status: "canceled" };
      return { body: after, emits: [{ type: "customer.subscription.deleted", object: after }] };
    },
    "delete /v1/subscriptions/{subscription_exposed_id}",
  ],
];
