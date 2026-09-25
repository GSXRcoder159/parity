// Events: the first resource module. A module exports `routes`; its handlers read through ctx and return a Result.
import { list } from "../list.ts";
import type { Route } from "../server.ts";

/** `type` supports `*` wildcards ("customer.*"). */
const typeMatcher = (pattern: string) =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

export const routes: Route[] = [
  [
    "GET",
    /^\/v1\/events$/,
    (ctx, { params }) => {
      const { type, types } = params;
      const re = typeMatcher(typeof type === "string" && type ? type : "*");
      const match = Array.isArray(types) ? (t: string) => types.includes(t) : (t: string) => re.test(t);
      return { body: list(ctx.all("event").filter((e) => match(e.type as string)), params, "/v1/events") };
    },
    "get /v1/events",
  ],
  [
    "GET",
    /^\/v1\/events\/(?<id>[^/]+)$/,
    (ctx, { pathParams }) => {
      const evt = ctx.get(pathParams.id!);
      if (evt?.object !== "event") ctx.fail("resource_missing", { param: "id" });
      return { body: evt };
    },
    "get /v1/events/{id}",
  ],
];
