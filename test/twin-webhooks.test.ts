// Webhook endpoints (CRUD) and delivery (signature, retries, matching) against a real local receiver.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeForm } from "../src/bench/run.ts";
import { build } from "../src/twin/build.ts";
import { createTwin } from "../src/twin/server.ts";

type Obj = Record<string, any>;
type Twin = ReturnType<typeof createTwin>;

const call = (t: Twin, method: string, path: string, params?: Obj, headers: Obj = {}) => {
  const form = params ? encodeForm(params) : "";
  const post = method === "POST";
  const req = { method, path, query: post ? "" : form, body: post ? form : "", headers: { Authorization: "Bearer sk_test_parity", ...headers } };
  return t.handle(req) as Promise<{ status: number; body: Obj; headers: Record<string, string> }>;
};

/**
 * A local receiver. `script[path]` gives each attempt's status in turn (0 = destroy the socket: a network error;
 * a 3xx redirects to `<path>/`), then 200. `gate` holds every response until it resolves.
 */
async function receiver(script: Record<string, number[]> = {}, gate?: Promise<void>) {
  const hits: { path: string; body: string; headers: http.IncomingHttpHeaders; at: number }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    hits.push({ path: req.url!, body, headers: req.headers, at: Date.now() });
    const status = script[req.url!]?.shift() ?? 200;
    if (status === 0) return void req.socket.destroy();
    await gate;
    res.writeHead(status, status >= 300 && status < 400 ? { Location: `${req.url}/` } : {}).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits, at: (path: string) => hits.filter((h) => h.path === path) };
}

async function until(cond: () => boolean): Promise<void> {
  for (const end = Date.now() + 3000; !cond(); await sleep(5)) if (Date.now() > end) assert.fail("timed out waiting for deliveries");
}

const endpoint = (t: Twin, url: string, enabled_events: string[]) => call(t, "POST", "/v1/webhook_endpoints", { url, enabled_events });

test("webhook endpoints: CRUD, secret only on create, tombstone on delete, no events", async () => {
  const t = createTwin();
  const params = { url: "https://example.com/hook", enabled_events: ["customer.created", "invoice.paid"], description: "d1", metadata: { k: "v" } };
  const c = await call(t, "POST", "/v1/webhook_endpoints", params, { "Parity-Now": "1700000000" });
  assert.equal(c.status, 200);
  const { id, secret } = c.body;
  assert.match(id, /^we_[0-9A-Za-z]{24}$/);
  assert.match(secret, /^whsec_[0-9A-Za-z]{24}$/);
  assert.deepEqual(c.body, { ...build("webhook_endpoint"), ...params, id, secret, created: 1700000000, status: "enabled" });

  const { secret: _, ...pub } = c.body;
  const path = `/v1/webhook_endpoints/${id}`;
  assert.deepEqual((await call(t, "GET", path)).body, pub);

  const u = await call(t, "POST", path, { enabled_events: ["*"], disabled: true, description: "", metadata: { k: "" } });
  assert.deepEqual([u.status, u.body], [200, { ...pub, enabled_events: ["*"], status: "disabled", description: null, metadata: {} }]);
  const on = await call(t, "POST", path, { disabled: false, url: "https://example.com/v2" });
  assert.deepEqual(on.body, { ...u.body, status: "enabled", url: "https://example.com/v2" });

  const page = await call(t, "GET", "/v1/webhook_endpoints");
  assert.deepEqual([page.body.url, page.body.data], ["/v1/webhook_endpoints", [on.body]]);

  const d = await call(t, "DELETE", path);
  assert.deepEqual([d.status, d.body], [200, { id, object: "webhook_endpoint", deleted: true }]);
  for (const [method, p] of [["GET", path], ["POST", path], ["DELETE", path], ["GET", "/v1/webhook_endpoints/we_missing"]] as const) {
    const r = await call(t, method, p, method === "POST" ? { description: "x" } : undefined);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.param], [404, "resource_missing", "webhook_endpoint"], `${method} ${p}`);
  }
  assert.deepEqual((await call(t, "GET", "/v1/webhook_endpoints")).body.data, []);
  assert.equal(t.store.events.length, 0);
});

test("webhook endpoints: required params, URL check, connect", async () => {
  const t = createTwin();
  const err = async (params: Obj, p = "/v1/webhook_endpoints") => {
    const r = await call(t, "POST", p, params);
    return [r.status, r.body.error.code ?? r.body.error.type, r.body.error.param];
  };
  assert.deepEqual(await err({ url: "https://example.com/hook" }), [400, "parameter_missing", "enabled_events"]);
  assert.deepEqual(await err({ enabled_events: ["*"] }), [400, "parameter_missing", "url"]);
  assert.deepEqual(await err({ url: "not a url", enabled_events: ["*"] }), [400, "url_invalid", "url"]);
  assert.deepEqual(await err({ url: "ftp://example.com/hook", enabled_events: ["*"] }), [400, "url_invalid", "url"]);
  assert.deepEqual(await err({ url: "https://example.com/hook", enabled_events: ["*"], connect: true }), [400, "invalid_request_error", undefined]);
  const w = await call(t, "POST", "/v1/webhook_endpoints", { url: "https://example.com/hook", enabled_events: ["*"], connect: false });
  assert.equal(w.status, 200);
  assert.deepEqual(await err({ url: "nope" }, `/v1/webhook_endpoints/${w.body.id}`), [400, "url_invalid", "url"]);
  assert.equal(t.store.objects.size, 1);
});

test("delivery: signed POST of the event, sent without delaying the response; pending_webhooks decrements on success", { timeout: 5000 }, async () => {
  let release!: () => void;
  const rx = await receiver({}, new Promise<void>((resolve) => (release = resolve)));
  const t = createTwin();
  const w = (await endpoint(t, `${rx.url}/a`, ["customer.created"])).body;

  // The receiver holds its answer, yet the API call returns.
  assert.equal((await call(t, "POST", "/v1/customers", { email: "a@example.com" })).status, 200);
  await until(() => rx.hits.length === 1);
  const [evt] = (await call(t, "GET", "/v1/events")).body.data;
  assert.equal(evt.pending_webhooks, 1);
  release();
  await until(() => t.store.events[0]!.pending_webhooks === 0);
  assert.equal((await call(t, "GET", `/v1/events/${evt.id}`)).body.pending_webhooks, 0);

  const hit = rx.hits[0]!;
  assert.deepEqual(JSON.parse(hit.body), evt);
  assert.equal(hit.headers["content-type"], "application/json; charset=utf-8");
  const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hit.headers["stripe-signature"])) ?? assert.fail("malformed Stripe-Signature");
  assert.equal(sig[2], createHmac("sha256", w.secret).update(`${sig[1]}.${hit.body}`).digest("hex"));
  assert.ok(Math.abs(Number(sig[1]) - Date.now() / 1000) < 60, "t is the wall clock");
});

test("delivery retries a network error and a non-2xx with backoff, then succeeds; gives up after 3 retries", { timeout: 5000 }, async () => {
  const rx = await receiver({ "/flaky": [0, 500, 200], "/down": [500, 503, 0, 404, 200] });
  const t = createTwin({ webhookBackoffMs: [30, 60, 90] });
  await endpoint(t, `${rx.url}/flaky`, ["customer.created"]);
  await endpoint(t, `${rx.url}/down`, ["*"]);
  await call(t, "POST", "/v1/customers", {});
  const evt = t.store.events[0]!;
  assert.equal(evt.pending_webhooks, 2);

  await until(() => rx.at("/flaky").length === 3 && rx.at("/down").length === 4);
  await sleep(150); // a 5th attempt would come 90 ms after the 4th, and succeed
  assert.equal(rx.at("/down").length, 4);
  assert.equal(evt.pending_webhooks, 1, "only /flaky succeeded");
  assert.equal(new Set(rx.hits.map((h) => h.body)).size, 1, "every attempt sends the same payload");
  const gaps = rx.at("/down").slice(1).map((h, i) => h.at - rx.at("/down")[i]!.at);
  gaps.forEach((g, i) => assert.ok(g >= [30, 60, 90][i]! - 5, `retry ${i + 1} waited ${g} ms`));
});

test("delivery does not follow a redirect: a 3xx is a failed attempt, retried, never re-sent to the Location", { timeout: 5000 }, async () => {
  const rx = await receiver({ "/moved": [301, 302, 307, 308] });
  const t = createTwin({ webhookBackoffMs: [30, 60, 90] });
  await endpoint(t, `${rx.url}/moved`, ["customer.created"]);
  await call(t, "POST", "/v1/customers", {});

  await until(() => rx.at("/moved").length === 4);
  await sleep(50); // let the last 308 be handled
  assert.deepEqual(rx.at("/moved/"), [], "the Location is never requested");
  assert.equal(t.store.events[0]!.pending_webhooks, 1, "no redirect counts as a delivery");
});

test("delivery follows enabled_events (`*` gets everything) and skips disabled endpoints, even mid-retry", { timeout: 5000 }, async () => {
  const rx = await receiver({ "/stop": [500, 500, 500, 500] });
  const t = createTwin({ webhookBackoffMs: [200, 200, 200] });
  await endpoint(t, `${rx.url}/all`, ["*"]);
  await endpoint(t, `${rx.url}/products`, ["product.created"]);
  const off = (await endpoint(t, `${rx.url}/off`, ["*"])).body;
  await call(t, "POST", `/v1/webhook_endpoints/${off.id}`, { disabled: true });
  const stop = (await endpoint(t, `${rx.url}/stop`, ["customer.created"])).body;

  await call(t, "POST", "/v1/customers", {});
  await call(t, "POST", "/v1/products", { name: "P" });
  assert.deepEqual(
    t.store.events.map((e) => [e.type, e.pending_webhooks]),
    [["customer.created", 2], ["product.created", 2]],
  );
  await until(() => rx.at("/stop").length === 1);
  await call(t, "POST", `/v1/webhook_endpoints/${stop.id}`, { disabled: true });
  await until(() => rx.at("/all").length === 2 && rx.at("/products").length === 1);
  await sleep(300); // past /stop's next retry

  const types = (p: string) => rx.at(p).map((h) => JSON.parse(h.body).type).sort();
  assert.deepEqual(types("/all"), ["customer.created", "product.created"]);
  assert.deepEqual(types("/products"), ["product.created"]);
  assert.deepEqual(types("/off"), []);
  assert.equal(rx.at("/stop").length, 1, "disabling the endpoint stopped its retries");
  assert.deepEqual(t.store.events.map((e) => e.pending_webhooks), [1, 0]);
});
