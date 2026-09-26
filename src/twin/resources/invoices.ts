// Invoices: retrieve and list. Invoices are created by subscriptions (billing.ts); update, delete, pay, void,
// finalize and create_preview are W4 and answer `not_implemented` (after the missing-invoice check).
import { list } from "../list.ts";
import type { Ctx, Handler, Route } from "../server.ts";
import { live } from "./customers.ts";

type Obj = Record<string, unknown>;

// The missing-invoice param is "invoice", except on POST /v1/invoices/{invoice}, where it is "id" (observed).
const find = (ctx: Ctx, id: string | undefined, param = "invoice") => live(ctx, id, "invoice") ?? ctx.fail("resource_missing", { param });
const w4 = (param?: string): Handler => (ctx, { pathParams }) => {
  find(ctx, pathParams.invoice, param);
  return ctx.fail("not_implemented");
};
const ID = /^\/v1\/invoices\/(?<invoice>[^/]+)$/;

export const routes: Route[] = [
  [
    "GET",
    /^\/v1\/invoices$/,
    (ctx, { params }) => {
      const { customer, status, subscription } = params;
      const hit = (i: Obj) =>
        (!customer || i.customer === customer) &&
        (!status || i.status === status) &&
        (!subscription || ((i.parent as Obj | null)?.subscription_details as Obj | null | undefined)?.subscription === subscription);
      return { body: list(ctx.all("invoice").filter(hit), params, "/v1/invoices") };
    },
    "get /v1/invoices",
  ],
  // Before the {invoice} route, which would take "create_preview" as an id.
  ["POST", /^\/v1\/invoices\/create_preview$/, (ctx) => ctx.fail("not_implemented"), "post /v1/invoices/create_preview"],
  ["GET", ID, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.invoice) }), "get /v1/invoices/{invoice}"],
  ["POST", ID, w4("id"), "post /v1/invoices/{invoice}"],
  ["DELETE", ID, w4(), "delete /v1/invoices/{invoice}"],
  ...["finalize", "pay", "void"].map((a): Route => ["POST", new RegExp(`^/v1/invoices/(?<invoice>[^/]+)/${a}$`), w4(), `post /v1/invoices/{invoice}/${a}`]),
];
