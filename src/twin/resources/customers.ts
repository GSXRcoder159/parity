// Customers: create/retrieve/update/delete (tombstones), list, search. Also exports the small helpers the
// other resource modules share (live lookup, param assignment, previous_attributes diff).
import { list, search } from "../list.ts";
import type { Ctx, Route } from "../server.ts";

type Obj = Record<string, unknown>;
const isHash = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The live (not deleted) object `id` of `type`, else undefined. */
export function live(ctx: Ctx, id: unknown, type: string): Obj | undefined {
  const o = typeof id === "string" && id ? ctx.get(id) : undefined;
  return o?.object === type && !o.deleted ? o : undefined;
}

/**
 * Writes form params onto `o` (only `keys` at the top level, when given): "" unsets (null), hashes merge
 * into hashes, `metadata` merges and drops keys set to "" (metadata="" clears it).
 */
export function assign(o: Obj, params: Obj, keys?: string[]): Obj {
  for (const [k, v] of Object.entries(params)) {
    if (keys && !keys.includes(k)) continue;
    if (k === "metadata") {
      o.metadata = v === "" ? {} : Object.fromEntries(Object.entries({ ...(o.metadata as Obj), ...(v as Obj) }).filter(([, x]) => x !== ""));
    } else if (isHash(v)) o[k] = assign(isHash(o[k]) ? o[k] : {}, v);
    else o[k] = v === "" ? null : v;
  }
  return o;
}

/** `previous_attributes`: the old value of each changed key (null if it did not exist); hashes recurse. */
export function diff(before: Obj, after: Obj): Obj {
  const prev: Obj = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [b, a] = [before[k], after[k]];
    if (JSON.stringify(b) !== JSON.stringify(a)) prev[k] = isHash(b) && isHash(a) ? diff(b, a) : (b ?? null);
  }
  return prev;
}

/** A payment method id param must name a payment method attached to `customer` (undefined: not created yet). */
function checkAttached(ctx: Ctx, pm: unknown, customer: string | undefined, param: string): void {
  if (typeof pm !== "string" || pm === "") return;
  const o = live(ctx, pm, "payment_method") ?? ctx.fail("resource_missing_400", { param });
  if (o.customer !== customer) ctx.fail("default_payment_method_not_attached", { param });
}

const FIELDS = [
  "address",
  "balance",
  "business_name",
  "description",
  "email",
  "individual_name",
  "invoice_prefix",
  "invoice_settings",
  "metadata",
  "name",
  "next_invoice_sequence",
  "phone",
  "preferred_locales",
  "shipping",
  "tax_exempt",
];
const DEFAULT_PM = "invoice_settings[default_payment_method]";
const defaultPm = (params: Obj) => (isHash(params.invoice_settings) ? params.invoice_settings.default_payment_method : undefined);
const ID = /^\/v1\/customers\/(?<customer>[^/]+)$/;

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/customers$/,
    (ctx, { params }) => {
      checkAttached(ctx, defaultPm(params), undefined, DEFAULT_PM);
      const c = assign(ctx.build("customer", { id: ctx.id("cus"), created: ctx.now() }), params, FIELDS);
      return { body: c, emits: [{ type: "customer.created", object: c }] };
    },
    "post /v1/customers",
  ],
  [
    "GET",
    /^\/v1\/customers$/,
    (ctx, { params }) => ({
      body: list(ctx.all("customer").filter((c) => !params.email || c.email === params.email), params, "/v1/customers"),
    }),
    "get /v1/customers",
  ],
  // Before the {customer} route, which would take "search" as an id.
  [
    "GET",
    /^\/v1\/customers\/search$/,
    (ctx, { params }) => ({ body: search(ctx.all("customer"), params.query, "/v1/customers/search", params.limit as number | undefined) }),
    "get /v1/customers/search",
  ],
  [
    "GET",
    ID,
    (ctx, { pathParams }) => {
      const c = ctx.get(pathParams.customer!); // a deleted customer returns its tombstone
      return { body: c?.object === "customer" ? c : ctx.fail("resource_missing", { param: "id" }) };
    },
    "get /v1/customers/{customer}",
  ],
  [
    "POST",
    ID,
    (ctx, { pathParams, params }) => {
      const before = ctx.get(pathParams.customer!);
      if (before?.object !== "customer") return ctx.fail("resource_missing", { param: "id" });
      if (before.deleted) return ctx.fail("resource_missing_400", { param: "id" });
      checkAttached(ctx, defaultPm(params), before.id as string, DEFAULT_PM);
      const after = assign(structuredClone(before), params, FIELDS);
      const previous_attributes = diff(before, after);
      const changed = Object.keys(previous_attributes).length > 0;
      return { body: after, emits: changed ? [{ type: "customer.updated", object: after, previous_attributes }] : [] };
    },
    "post /v1/customers/{customer}",
  ],
  [
    "DELETE",
    ID,
    (ctx, { pathParams }) => {
      const c = live(ctx, pathParams.customer, "customer") ?? ctx.fail("resource_missing", { param: "id" });
      const tombstone = ctx.build("deleted_customer", { id: c.id });
      // The event carries the last full customer; the response and later retrieves the tombstone.
      return { body: tombstone, emits: [{ type: "customer.deleted", object: c }], deletes: [tombstone] };
    },
    "delete /v1/customers/{customer}",
  ],
];
