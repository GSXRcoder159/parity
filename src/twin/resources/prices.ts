// Prices: create (with `product` or inline `product_data`), retrieve, update, list. Recurring prices also
// emit the legacy plan.created / plan.updated events.
import { list } from "../list.ts";
import type { Ctx, Route } from "../server.ts";
import type { Emit } from "../store.ts";
import { assign, diff, live } from "./customers.ts";
import { newProduct } from "./products.ts";

type Obj = Record<string, unknown>;

/**
 * The legacy plan view of a recurring price. There is no plan template: the pruned spec has no plan schema
 * (no in-scope operation references it), so this is a computed projection of the price.
 */
const plan = (p: Obj): Obj => {
  const r = p.recurring as Obj;
  return {
    id: p.id,
    object: "plan",
    active: p.active,
    amount: p.unit_amount,
    amount_decimal: p.unit_amount_decimal,
    billing_scheme: p.billing_scheme,
    created: p.created,
    currency: p.currency,
    interval: r.interval,
    interval_count: r.interval_count,
    livemode: p.livemode,
    metadata: p.metadata,
    meter: r.meter,
    nickname: p.nickname,
    product: p.product,
    tiers_mode: p.tiers_mode,
    transform_usage: p.transform_quantity,
    trial_period_days: r.trial_period_days,
    usage_type: r.usage_type,
  };
};

/**
 * price.* plus, for recurring prices, plan.* with the same previous_attributes.
 * ponytail: the plan shares the price's id and store.apply projects every emit by id, so plan.* goes FIRST
 * and the price event overwrites it; a per-type projection would lift that ordering constraint.
 */
const priceEvents = (verb: string, p: Obj, previous_attributes?: Obj): Emit[] => [
  ...(p.type === "recurring" ? [{ type: `plan.${verb}`, object: plan(p), previous_attributes }] : []),
  { type: `price.${verb}`, object: p, previous_attributes },
];

const find = (ctx: Ctx, id: string | undefined) => live(ctx, id, "price") ?? ctx.fail("resource_missing", { param: "price" });
const ID = /^\/v1\/prices\/(?<price>[^/]+)$/;

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/prices$/,
    (ctx, { params }) => {
      if (!params.currency) ctx.fail("parameter_missing", { param: "currency" });
      const unit = typeof params.unit_amount === "number" ? params.unit_amount : undefined;
      if (unit !== undefined && unit < 0) ctx.fail("invalid_non_negative_integer", { param: "unit_amount" });
      const r = params.recurring && typeof params.recurring === "object" ? (params.recurring as Obj) : undefined;
      if (r && !r.interval) ctx.fail("parameter_missing", { param: "recurring[interval]" });

      const emits: Emit[] = [];
      let product: unknown = params.product;
      if (product) {
        if (!live(ctx, product, "product")) ctx.fail("resource_missing_400", { param: "product" });
      } else if (params.product_data && typeof params.product_data === "object") {
        const p = newProduct(ctx, params.product_data as Obj, "product_data[name]");
        emits.push({ type: "product.created", object: p });
        product = p.id;
      } else ctx.fail("parameter_missing", { param: "product" });

      const price = ctx.build("price", {
        id: ctx.id("price"),
        active: true,
        created: ctx.now(),
        currency: String(params.currency).toLowerCase(),
        product,
        type: r ? "recurring" : "one_time",
        // Documented defaults: interval_count 1, usage_type licensed.
        recurring: r ? { interval: r.interval, interval_count: r.interval_count ?? 1, meter: r.meter ?? null, trial_period_days: null, usage_type: r.usage_type ?? "licensed" } : null,
        unit_amount: unit ?? null,
        unit_amount_decimal: unit === undefined ? null : String(unit),
      });
      assign(price, params, ["active", "lookup_key", "metadata", "nickname", "tax_behavior"]);
      return { body: price, emits: [...emits, ...priceEvents("created", price)] };
    },
    "post /v1/prices",
  ],
  [
    "GET",
    /^\/v1\/prices$/,
    (ctx, { params }) => {
      const { product, active, type, currency } = params;
      const hit = (p: Obj) =>
        (!product || p.product === product) && (typeof active !== "boolean" || p.active === active) && (!type || p.type === type) && (!currency || p.currency === currency);
      return { body: list(ctx.all("price").filter(hit), params, "/v1/prices") };
    },
    "get /v1/prices",
  ],
  ["GET", ID, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.price) }), "get /v1/prices/{price}"],
  [
    "POST",
    ID,
    (ctx, { pathParams, params }) => {
      const before = find(ctx, pathParams.price);
      const after = assign(structuredClone(before), params, ["active", "lookup_key", "metadata", "nickname"]);
      const prev = diff(before, after);
      return { body: after, emits: Object.keys(prev).length > 0 ? priceEvents("updated", after, prev) : [] };
    },
    "post /v1/prices/{price}",
  ],
];
