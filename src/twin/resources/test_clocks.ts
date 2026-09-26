// Test clocks (test_helpers/test_clocks): create, retrieve, list, delete (the clock's customers deleted, their
// subscriptions canceled, docs), and advance. An advance runs, in time order, every transition of the clock's
// subscriptions and invoices due by the new frozen time: a period's end (a renewal draft; at a trial's end the
// subscription turns active), the trial_will_end notice 3 days before it, cancel at period end, the draft's
// finalization and charge an hour after its creation, and payment retries. Requests on a clock's objects run at its
// frozen time (server.ts); an advance's events carry each transition's time.
import { addInterval, applyBalance, attemptPayment, collect, invoiceItemLine, itemLine, nextBoundary, pendingItems, subInvoice } from "../billing.ts";
import { list } from "../list.ts";
import type { Ctx, Handler, Route } from "../server.ts";
import type { Emit } from "../store.ts";
import { diff, live } from "../util.ts";
import { cancellation } from "./subscriptions.ts";

type Obj = Record<string, unknown>;

const TYPE = "test_helpers.test_clock";
const DAY = 86400;
/** Docs: a subscription invoice stays a draft for an hour, then is finalized and charged. */
const DRAFT_S = 3600;
// ponytail: Smart Retries' documented default, "8 tries within 2 weeks", as a fixed schedule: a retry every 2 days
// after the first attempt, then the subscription is canceled (docs: "cancel automatically after up to eight
// unsuccessful attempts"). The real retries pick their own times; unobserved until B1.
const TRIES = 8;
const RETRY_S = 2 * DAY;
// ponytail: the advance response is `advancing`, and every later read is `ready` at the new frozen time: the twin
// advances at once, so it matches the oracle's reads after the templates' waits whether or not the waits run (score-twin
// skips them). The sandbox's advance time is unmeasured until B1.
const find = (ctx: Ctx, id: string | undefined) => live(ctx, id, TYPE) ?? ctx.fail("resource_missing", { param: "test_clock" });
const itemsOf = (sub: Obj) => (sub.items as Obj).data as Obj[];
const recurring = (item: Obj) => (item.price as Obj).recurring as { interval: string; interval_count: number };
/** Ids of the clock's live customers. */
const customersOf = (ctx: Ctx, clock: unknown) => new Set(ctx.all("customer").filter((c) => c.test_clock === clock).map((c) => c.id));

const create: Handler = (ctx, { params }) => {
  // ponytail: attaching an existing customer (`customer`) is refused (documented limits, unobserved behavior).
  if (params.customer) ctx.fail("not_implemented");
  if (typeof params.frozen_time !== "number") ctx.fail("parameter_missing", { param: "frozen_time" });
  const now = ctx.now();
  // Docs: simulations are deleted automatically 30 days after their creation.
  const fields = { id: ctx.id("clock"), created: now, deletes_after: now + 30 * DAY, frozen_time: params.frozen_time, name: params.name || null, status: "ready" };
  const clock = { ...ctx.build(TYPE, fields), status_details: {} };
  return { body: clock, emits: [{ type: `${TYPE}.created`, object: clock }] };
};

const advance: Handler = (ctx, { pathParams, params }) => {
  const clock = find(ctx, pathParams.test_clock);
  const [from, to] = [clock.frozen_time as number, params.frozen_time];
  if (typeof to !== "number") return ctx.fail("parameter_missing", { param: "frozen_time" });
  if (to <= from) ctx.fail("test_clock_frozen_time_not_after");
  const mine = customersOf(ctx, clock.id);
  // Docs: at most two intervals of the shortest subscription interval ahead, two years without subscriptions.
  const limits = ctx
    .all("subscription")
    .filter((s) => mine.has(s.customer) && s.status !== "canceled")
    .flatMap((s) => itemsOf(s).map((item) => addInterval(from, recurring(item).interval, 2 * recurring(item).interval_count)));
  if (to > (limits.length > 0 ? Math.min(...limits) : addInterval(from, "year", 2))) ctx.fail("test_clock_advance_too_far");

  // Transitions read the state earlier ones left: a view of the store with this advance's changes over it.
  const staged = new Map<string, Obj>();
  const emits: (Emit & { at: number })[] = [];
  const puts: Obj[] = [];
  const at = (t: number): Ctx => ({
    ...ctx,
    now: () => t,
    get: (id) => (staged.has(id) ? structuredClone(staged.get(id)) : ctx.get(id)),
    all: (type) => {
      const base = ctx.all(type).map((o) => staged.get(o.id as string) ?? o);
      const added = [...staged.values()].filter((o) => o.object === type && !base.some((b) => b.id === o.id));
      return structuredClone([...base, ...added]);
    },
  });
  // store.apply writes puts before emits: an object is put here only if no emit of this advance carries it (swept items).
  const apply = (t: number, r: { emits?: Emit[]; puts?: Obj[] }) => {
    for (const o of r.puts ?? []) {
      staged.set(o.id as string, o);
      puts.push(o);
    }
    for (const e of r.emits ?? []) {
      staged.set(e.object.id as string, e.object);
      emits.push({ ...e, at: t });
    }
  };

  /** A period's end: the next period starts, billed on a draft (with the pending invoice items) finalized an hour later. */
  const renew = (t: number, id: unknown) => {
    const c = at(t);
    const sub = c.get(id as string)!;
    const customer = c.get(sub.customer as string)!;
    const inId = c.id("in");
    // The next end counts from the billing cycle anchor, not from t: a month-end anchor keeps its day (Jan 31 -> Feb 28 -> Mar 31).
    const next = (item: Obj) => nextBoundary(sub.billing_cycle_anchor as number, t, recurring(item).interval, recurring(item).interval_count);
    const items = itemsOf(sub).map((item) => ({ ...item, current_period_end: next(item), current_period_start: t }));
    const after = { ...sub, items: { ...(sub.items as Obj), data: items }, latest_invoice: inId, status: sub.status === "trialing" ? "active" : sub.status };
    const swept = pendingItems(c, sub.id).map((ii) => ({ ...ii, invoice: inId }));
    const lines = [
      ...swept.map((ii) => invoiceItemLine(c, inId, ii)),
      ...items.map((item) => itemLine(c, inId, after, item, { end: item.current_period_end as number, start: t })),
    ];
    const draft = subInvoice(c, after, customer, inId, lines, {
      automatically_finalizes_at: t + DRAFT_S,
      billing_reason: "subscription_cycle",
      effective_at: null,
      ending_balance: null,
      next_payment_attempt: sub.collection_method === "charge_automatically" ? t + DRAFT_S : null,
      period_start: itemsOf(sub)[0]!.current_period_start,
      status: "draft",
      status_transitions: { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    }, t);
    apply(t, {
      puts: swept, // ponytail: no invoiceitem.updated for swept items (unobserved), as in a subscription update
      emits: [
        { type: "customer.subscription.updated", object: after, previous_attributes: diff(sub, after) },
        { type: "invoice.created", object: draft },
      ],
    });
  };

  /**
   * A due draft is finalized (the customer's balance applied) and collected; an open invoice's retry is collected. A
   * failed charge leaves it open, the subscription past_due and the next try scheduled; the last try cancels the
   * subscription. Paying the latest invoice makes a past_due subscription active.
   */
  const charge = (t: number, id: unknown) => {
    const c = at(t);
    const before = c.get(id as string)!;
    const sub = c.get(((before.parent as Obj).subscription_details as Obj).subscription as string)!;
    const customer = c.get(before.customer as string)!;
    const out: Emit[] = [];
    const types: string[] = [];
    let inv = before;
    if (before.status === "draft") {
      const transitions = { ...(before.status_transitions as Obj), finalized_at: t };
      inv = applyBalance({ ...before, automatically_finalizes_at: null, effective_at: t, status: "open", status_transitions: transitions }, customer.balance as number);
      if (inv.ending_balance !== customer.balance) {
        out.push({ type: "customer.updated", object: { ...customer, balance: inv.ending_balance }, previous_attributes: { balance: customer.balance } });
      }
      types.push("invoice.finalized");
      // Finalizing a send_invoice invoice creates its payment intent (observed, #19).
      if (sub.collection_method === "send_invoice" && (inv.amount_due as number) > 0) out.push(...attemptPayment(c, inv, undefined).emits);
    }
    const r = collect(c, sub, customer, inv, types);
    let after = r.invoice;
    let status = sub.status === "past_due" && after.status === "paid" && sub.latest_invoice === after.id ? "active" : sub.status;
    if (r.failed) {
      const retry = after.attempted === true && (after.attempt_count as number) < TRIES;
      // ponytail: no payment method -> no retries and the subscription stays past_due (docs: no retry without one).
      const last = after.attempted === true && !retry;
      after = { ...after, auto_advance: !last, next_payment_attempt: retry ? t + RETRY_S : null };
      status = last ? "canceled" : "past_due";
    } else if (after.status !== "open") after = { ...after, next_payment_attempt: null };
    const subEmits: Emit[] = [];
    if (status === "canceled") {
      const object = { ...sub, canceled_at: t, cancellation_details: cancellation("payment_failed"), ended_at: t, status };
      subEmits.push({ type: "customer.subscription.deleted", object });
    } else if (status !== sub.status) subEmits.push({ type: "customer.subscription.updated", object: { ...sub, status }, previous_attributes: { status: sub.status } });
    const invoiceEmits = r.emits.map((e) => (e.object.id === after.id ? { ...e, object: after } : e));
    apply(t, { emits: [...out, ...invoiceEmits, { type: "invoice.updated", object: after, previous_attributes: diff(before, after) }, ...subEmits] });
  };

  /** Cancel at period end: canceled then; `canceled_at` stays the request's time (docs). */
  const cancel = (t: number, id: unknown) => {
    const sub = at(t).get(id as string)!;
    apply(t, { emits: [{ type: "customer.subscription.deleted", object: { ...sub, ended_at: t, status: "canceled" } }] });
  };

  const warned = new Set<unknown>(); // subscriptions whose trial_will_end this advance sent
  for (;;) {
    const c = at(from);
    const due: [number, () => void][] = [];
    for (const s of c.all("subscription")) {
      if (!mine.has(s.customer) || !["trialing", "active", "past_due"].includes(s.status as string)) continue;
      const end = itemsOf(s)[0]!.current_period_end as number;
      const cancelAt = s.cancel_at as number | null;
      due.push(cancelAt !== null && cancelAt <= end ? [cancelAt, () => cancel(cancelAt, s.id)] : [end, () => renew(end, s.id)]);
      // Docs: 3 days before a trial ends. ponytail: a trial of 3 days or less gets none (sent at creation? unobserved).
      const warn = (s.trial_end as number) - 3 * DAY;
      if (s.status === "trialing" && warn > from && warn > (s.trial_start as number) && !warned.has(s.id)) {
        const notice = () => {
          warned.add(s.id);
          apply(warn, { emits: [{ type: "customer.subscription.trial_will_end", object: s }] });
        };
        due.push([warn, notice]);
      }
    }
    for (const inv of c.all("invoice")) {
      const t = (inv.status === "draft" ? inv.automatically_finalizes_at : inv.status === "open" ? inv.next_payment_attempt : null) as number | null;
      // Only invoices still collected automatically: auto_advance, and a subscription not canceled (docs: canceling
      // stops collection; ponytail: the invoice's own fields are left as they were, unobserved).
      const sub = c.get(((inv.parent as Obj | null)?.subscription_details as Obj | null)?.subscription as string);
      if (mine.has(inv.customer) && t !== null && inv.auto_advance === true && sub?.status !== "canceled") due.push([t, () => charge(t, inv.id)]);
    }
    const next = due.filter(([t]) => t <= to).sort(([a], [b]) => a - b)[0];
    if (!next) break;
    next[1]();
  }

  const body = { ...clock, status: "advancing", status_details: { advancing: { target_frozen_time: to } } };
  const ready = { ...clock, frozen_time: to, status: "ready", status_details: {} };
  return {
    body,
    puts,
    // ponytail: `ready` is sent with the advance (the twin advances at once), not after the sandbox's delay.
    emits: [{ type: `${TYPE}.advancing`, object: body }, ...emits, { type: `${TYPE}.ready`, object: ready }],
  };
};

const remove: Handler = (ctx, { pathParams }) => {
  const clock = find(ctx, pathParams.test_clock);
  const mine = customersOf(ctx, clock.id);
  const t = clock.frozen_time as number;
  // Like deleting each customer (observed, #26): its subscriptions are canceled, then the customer is deleted.
  const subs = ctx
    .all("subscription")
    .filter((s) => mine.has(s.customer) && s.status !== "canceled")
    .map((s) => ({ ...s, canceled_at: t, cancellation_details: cancellation("cancellation_requested"), ended_at: t, status: "canceled" }));
  const customers = ctx.all("customer").filter((c) => mine.has(c.id));
  const tombstone = ctx.build(`deleted_${TYPE}`, { id: clock.id });
  return {
    body: tombstone,
    emits: [
      ...subs.map((object) => ({ type: "customer.subscription.deleted", object })),
      ...customers.map((object) => ({ type: "customer.deleted", object })),
      { type: `${TYPE}.deleted`, object: clock },
    ],
    deletes: [...customers.map((c) => ctx.build("deleted_customer", { id: c.id })), tombstone],
  };
};

const ID = /^\/v1\/test_helpers\/test_clocks\/(?<test_clock>[^/]+)$/;

export const routes: Route[] = [
  ["POST", /^\/v1\/test_helpers\/test_clocks$/, create, "post /v1/test_helpers/test_clocks"],
  ["GET", /^\/v1\/test_helpers\/test_clocks$/, (ctx, { params }) => ({ body: list(ctx.all(TYPE), params, "/v1/test_helpers/test_clocks") }), "get /v1/test_helpers/test_clocks"],
  ["GET", ID, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.test_clock) }), "get /v1/test_helpers/test_clocks/{test_clock}"],
  ["DELETE", ID, remove, "delete /v1/test_helpers/test_clocks/{test_clock}"],
  ["POST", /^\/v1\/test_helpers\/test_clocks\/(?<test_clock>[^/]+)\/advance$/, advance, "post /v1/test_helpers/test_clocks/{test_clock}/advance"],
];
