// Webhook endpoints: create/retrieve/update/list/delete. They emit no events (the API has no webhook_endpoint.*
// types). `secret` stays on the stored object, which delivery (webhooks.ts) signs with, but only create returns it.
import { list } from "../list.ts";
import type { Ctx, Route } from "../server.ts";
import { assign, live } from "../util.ts";

type Obj = Record<string, unknown>;

const FIELDS = ["api_version", "description", "enabled_events", "metadata", "url"];
const ID = /^\/v1\/webhook_endpoints\/(?<webhook_endpoint>[^/]+)$/;

const find = (ctx: Ctx, id: string | undefined) =>
  live(ctx, id, "webhook_endpoint") ?? ctx.fail("resource_missing", { param: "webhook_endpoint" });
const hide = ({ secret: _, ...o }: Obj): Obj => o;

/** Delivery POSTs to it, so it must be an http(s) URL. */
function checkUrl(ctx: Ctx, url: unknown): void {
  if (url !== undefined && !/^https?:$/.test((typeof url === "string" && URL.parse(url)?.protocol) || "")) ctx.fail("url_invalid");
}

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/webhook_endpoints$/,
    (ctx, { params }) => {
      for (const p of ["enabled_events", "url"]) if (params[p] === undefined || params[p] === "") ctx.fail("parameter_missing", { param: p });
      if (params.connect) ctx.fail("not_implemented"); // connected-account events: the twin has no connected accounts
      checkUrl(ctx, params.url);
      const fields = { id: ctx.id("we"), created: ctx.now(), secret: ctx.id("whsec"), status: "enabled" };
      const w = assign(ctx.build("webhook_endpoint", fields), params, FIELDS);
      return { body: w, puts: [w] };
    },
    "post /v1/webhook_endpoints",
  ],
  [
    "GET",
    /^\/v1\/webhook_endpoints$/,
    (ctx, { params }) => ({ body: list(ctx.all("webhook_endpoint").map(hide), params, "/v1/webhook_endpoints") }),
    "get /v1/webhook_endpoints",
  ],
  ["GET", ID, (ctx, { pathParams }) => ({ body: hide(find(ctx, pathParams.webhook_endpoint)) }), "get /v1/webhook_endpoints/{webhook_endpoint}"],
  [
    "POST",
    ID,
    (ctx, { pathParams, params }) => {
      const w = find(ctx, pathParams.webhook_endpoint);
      checkUrl(ctx, params.url);
      assign(w, params, FIELDS);
      if (typeof params.disabled === "boolean") w.status = params.disabled ? "disabled" : "enabled";
      return { body: hide(w), puts: [w] };
    },
    "post /v1/webhook_endpoints/{webhook_endpoint}",
  ],
  [
    "DELETE",
    ID,
    (ctx, { pathParams }) => {
      const tombstone = ctx.build("deleted_webhook_endpoint", { id: find(ctx, pathParams.webhook_endpoint).id });
      return { body: tombstone, deletes: [tombstone] };
    },
    "delete /v1/webhook_endpoints/{webhook_endpoint}",
  ],
];
