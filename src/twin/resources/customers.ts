// Customers: create (on a test clock: at most 3 per clock, docs) / retrieve / update / delete (tombstones), list, search.
import { list, search } from "../list.ts";
import type { Route } from "../server.ts";
import { assign, checkAttached, diff, isHash, live } from "../util.ts";

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
const defaultPm = (params: Record<string, unknown>) => (isHash(params.invoice_settings) ? params.invoice_settings.default_payment_method : undefined);
const ID = /^\/v1\/customers\/(?<customer>[^/]+)$/;

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/customers$/,
    (ctx, { params }) => {
      checkAttached(ctx, defaultPm(params), undefined, DEFAULT_PM);
      const clock = params.test_clock ? (live(ctx, params.test_clock, "test_helpers.test_clock") ?? ctx.fail("resource_missing_400", { param: "test_clock" })) : undefined;
      if (clock && ctx.all("customer").filter((c) => c.test_clock === clock.id).length >= 3) ctx.fail("test_clock_customer_limit");
      const c = assign(ctx.build("customer", { id: ctx.id("cus"), created: ctx.now(), test_clock: clock?.id ?? null }), params, FIELDS);
      return { body: c, emits: [{ type: "customer.created", object: c }] };
    },
    "post /v1/customers",
  ],
  [
    "GET",
    /^\/v1\/customers$/,
    // Docs: a test clock's customers are listed only with its `test_clock`, which lists only them.
    (ctx, { params }) => ({
      body: list(
        ctx.all("customer").filter((c) => (!params.email || c.email === params.email) && (c.test_clock ?? null) === (params.test_clock || null)),
        params,
        "/v1/customers",
      ),
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
