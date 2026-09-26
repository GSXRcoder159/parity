// Products: create/retrieve/update/list. `newProduct` also serves prices' `product_data`.
import { list } from "../list.ts";
import type { Ctx, Route } from "../server.ts";
import { assign, diff, live } from "../util.ts";

type Obj = Record<string, unknown>;

const FIELDS = [
  "active",
  "description",
  "images",
  "marketing_features",
  "metadata",
  "name",
  "package_dimensions",
  "shippable",
  "statement_descriptor",
  "tax_code",
  "unit_label",
  "url",
];
const ID = /^\/v1\/products\/(?<id>[^/]+)$/;

/** A new active product from create params; `nameParam` names `name` in errors (`product_data[name]` for prices). */
export function newProduct(ctx: Ctx, params: Obj, nameParam = "name"): Obj {
  if (!params.name) ctx.fail("parameter_missing", { param: nameParam });
  const now = ctx.now();
  return assign(ctx.build("product", { id: ctx.id("prod"), active: true, created: now, updated: now }), params, FIELDS);
}

const find = (ctx: Ctx, id: string | undefined) => live(ctx, id, "product") ?? ctx.fail("resource_missing", { param: "id" });

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/products$/,
    (ctx, { params }) => {
      const p = newProduct(ctx, params);
      return { body: p, emits: [{ type: "product.created", object: p }] };
    },
    "post /v1/products",
  ],
  [
    "GET",
    /^\/v1\/products$/,
    (ctx, { params }) => ({
      body: list(ctx.all("product").filter((p) => typeof params.active !== "boolean" || p.active === params.active), params, "/v1/products"),
    }),
    "get /v1/products",
  ],
  ["GET", ID, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.id) }), "get /v1/products/{id}"],
  [
    "POST",
    ID,
    (ctx, { pathParams, params }) => {
      const before = find(ctx, pathParams.id);
      const after = assign(structuredClone(before), params, FIELDS);
      if (Object.keys(diff(before, after)).length === 0) return { body: after };
      after.updated = ctx.now();
      return { body: after, emits: [{ type: "product.updated", object: after, previous_attributes: diff(before, after) }] };
    },
    "post /v1/products/{id}",
  ],
];
