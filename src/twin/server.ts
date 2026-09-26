// The twin's HTTP layer: auth -> parse -> route -> validate -> idempotency -> handler -> store.apply -> expand.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import http from "node:http";
import { build } from "./build.ts";
import { TwinError, fail, renderError } from "./errors.ts";
import { expand } from "./expand.ts";
import { parseForm } from "./form.ts";
import { API_VERSION, type Changes, Store, newId } from "./store.ts";
import { validate } from "./validate.ts";

type Obj = Record<string, unknown>;

/** What a handler sees. Handlers are pure w.r.t. ctx: they read through it and return changes, never touch the store. */
export interface Ctx {
  now(): number;
  id(prefix: string): string;
  /** A copy of the live object, else its tombstone (`deleted: true`), else the event with that id. */
  get(id: string): Obj | undefined;
  /** Copies of the live objects of one type in insertion order; "event" gives the event log. */
  all(type: string): Obj[];
  requestId: string;
  fail: typeof fail;
  build: typeof build;
}
export interface HandlerReq {
  method: string;
  path: string;
  /** Named groups of the route's RegExp. */
  pathParams: Record<string, string>;
  /** Query and form body params, validated and coerced. */
  params: Obj;
  /** Lowercased names. */
  headers: Record<string, string>;
}
export interface Result extends Changes {
  status?: number;
  body: unknown;
}
export type Handler = (ctx: Ctx, req: HandlerReq) => Result;
/** [method, path pattern, handler, spec operation ("get /v1/events/{id}")]. */
export type Route = [method: string, pattern: RegExp, handler: Handler, operation: string];

export interface TwinRequest {
  method: string;
  path: string;
  query?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
}
export interface TwinResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// Every module in resources/ exporting `routes` is registered. Modules import this file with `import type` only:
// a runtime import would deadlock on this top-level await.
const resourcesDir = new URL("./resources/", import.meta.url);
const RESOURCE_ROUTES: Route[] = (
  await Promise.all(
    readdirSync(resourcesDir)
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => import(new URL(f, resourcesDir).href) as Promise<{ routes?: Route[] }>),
  )
).flatMap((m) => m.routes ?? []);

const IDEMPOTENCY_TTL = 24 * 3600;
/** JSON.stringify replacer: param order does not change the idempotency hash. */
const sortKeys = (_: string, v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v;

/** API key from `Bearer <key>` or Basic `<key>:`. */
function apiKey(authorization: string | undefined): string {
  const [scheme = "", cred = ""] = (authorization ?? "").trim().split(/\s+/, 2);
  if (/^bearer$/i.test(scheme)) return cred;
  if (/^basic$/i.test(scheme)) return Buffer.from(cred, "base64").toString().split(":")[0] ?? "";
  return "";
}

/** `opts.routes` are extra routes, matched before the resource modules' (tests use them for fake handlers). */
export function createTwin(opts: { routes?: Route[] } = {}) {
  const store = new Store();
  const routes = [...(opts.routes ?? []), ...RESOURCE_ROUTES];

  // ponytail: event lookup by id is a linear scan (only reached on a miss); index it if event logs get large.
  const get = (id: string): Obj | undefined => {
    const o = store.objects.get(id) ?? store.deleted.get(id) ?? store.events.find((e) => e.id === id);
    return o && structuredClone(o);
  };
  const all = (type: string): Obj[] =>
    structuredClone(type === "event" ? store.events : [...store.objects.values()].filter((o) => o.object === type));

  async function handle(req: TwinRequest): Promise<TwinResponse> {
    const method = req.method.toUpperCase();
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const requestId = newId("req");
    const pnow = headers["parity-now"];
    const now = pnow !== undefined && /^\d+$/.test(pnow) ? Number(pnow) : Math.floor(Date.now() / 1000);
    const respond = (status: number, body: unknown, extra: Record<string, string> = {}): TwinResponse => ({
      status,
      headers: { "Request-Id": requestId, "Stripe-Version": headers["stripe-version"] ?? API_VERSION, "Content-Type": "application/json", ...extra },
      body,
    });
    const error = (e: unknown): TwinResponse => {
      if (!(e instanceof TwinError)) console.error(e);
      const { status, body } = renderError(e instanceof TwinError ? e : new TwinError("api_error"), requestId);
      return respond(status, body);
    };

    try {
      if (req.path.startsWith("/_parity/")) return respond(200, parity(method, req.path, req.body ?? "", now));

      const key = apiKey(headers.authorization);
      if (!key) fail("api_key_missing");
      if (!/^(sk|rk)_test_/.test(key)) fail("api_key_invalid");

      let match: { handler: Handler; operation: string; pathParams: Record<string, string> } | undefined;
      for (const [m, pattern, handler, operation] of routes) {
        const r = m === method ? pattern.exec(req.path) : null;
        if (r) {
          match = { handler, operation, pathParams: { ...r.groups } };
          break;
        }
      }
      if (!match) return fail("unrecognized_url");

      const raw = { ...parseForm(req.query ?? ""), ...(method === "POST" ? parseForm(req.body ?? "") : {}) };
      const params = validate(match.operation, raw);

      // Validation errors above are never stored, like the real API: only requests that reach a handler are.
      const idemKey = method === "POST" ? headers["idempotency-key"] : undefined;
      const hash = createHash("sha256").update(JSON.stringify([method, req.path, params], sortKeys)).digest("hex");
      if (idemKey) {
        const hit = store.idem.get(idemKey);
        if (hit && now - hit.at < IDEMPOTENCY_TTL) {
          if (hit.hash !== hash) fail("idempotency_mismatch");
          return respond(hit.status, hit.body, { "Idempotent-Replayed": "true" });
        }
      }

      let res: TwinResponse;
      try {
        const ctx: Ctx = { now: () => now, id: newId, get, all, requestId, fail, build };
        const r = match.handler(ctx, { method, path: req.path, pathParams: match.pathParams, params, headers });
        // Expand before applying so an invalid path leaves no state behind; ids created by this request resolve too.
        // A returned error (a 402 that still persists its payment events) is never expanded.
        const pending = new Map([...(r.puts ?? []), ...(r.emits ?? []).map((e) => e.object)].map((o) => [o.id as string, o]));
        const body = (r.status ?? 200) >= 400 ? r.body : expand(r.body, params.expand, (id) => pending.get(id) ?? get(id));
        store.apply(r, { now, requestId, idempotencyKey: idemKey ?? null });
        res = respond(r.status ?? 200, body);
      } catch (e) {
        res = error(e);
      }
      if (idemKey) store.idem.set(idemKey, { hash, status: res.status, body: res.body, at: now });
      return res;
    } catch (e) {
      return error(e);
    }
  }

  /** Test/bench control endpoints; no auth. */
  function parity(method: string, path: string, body: string, now: number): unknown {
    if (method === "POST" && path === "/_parity/reset") {
      store.reset();
      return { reset: true };
    }
    if (method === "POST" && path === "/_parity/seed") {
      const objects = (JSON.parse(body || "{}") as { objects?: unknown }).objects;
      if (!Array.isArray(objects) || !objects.every((o) => typeof o?.id === "string")) fail("parameter_invalid", { param: "objects" });
      store.apply({ puts: objects }, { now, requestId: null, idempotencyKey: null });
      return { seeded: objects.length };
    }
    if (method === "GET" && path === "/_parity/state") return store.snapshot();
    return fail("unrecognized_url");
  }

  function listen(port = 0, host = "127.0.0.1"): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const url = req.url ?? "/";
      const q = url.indexOf("?");
      const r = await handle({
        method: req.method ?? "GET",
        path: q < 0 ? url : url.slice(0, q),
        query: q < 0 ? "" : url.slice(q + 1),
        headers: req.headers,
        body,
      });
      res.writeHead(r.status, r.headers).end(JSON.stringify(r.body, null, 2));
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { handle, listen, store };
}
