import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { build } from "../src/twin/build.ts";

const MAIN = new URL("../src/twin/main.ts", import.meta.url).pathname;
const AUTH = { Authorization: "Bearer sk_test_parity" };
/** Shared CI runners are slower: wall-clock upper bounds get 3x there (lower bounds stay). */
const SLOW = process.env.CI ? 3 : 1;

/** Spawns the entrypoint and waits for its listening line; the child is killed when the test ends. */
async function boot(t: TestContext, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  const [line] = (await once(createInterface({ input: child.stdout }), "line")) as [string];
  const m = /^parity twin listening on (http:\/\/127\.0\.0\.1:\d+) \(API 2026-08-26\.dahlia\)$/.exec(line);
  assert.ok(m, `unexpected first line: ${line}`);
  return { child, url: m[1]! };
}

test("boots to a first successful request in under 1 s and exits 0 on SIGTERM", { timeout: 10_000 * SLOW }, async (t) => {
  const t0 = performance.now();
  const { child, url } = await boot(t, ["--port", "0"]);
  const res = await fetch(`${url}/v1/customers`, { headers: AUTH });
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { object: string }).object, "list");
  assert.ok(ms < 1000 * SLOW, `boot to first request took ${Math.round(ms)} ms`);

  // fetch keeps its socket alive: an idle connection is closed at once, not at the 5 s deadline.
  const t1 = performance.now();
  child.kill("SIGTERM");
  assert.deepEqual(await once(child, "exit"), [0, null]);
  assert.ok(performance.now() - t1 < 1000 * SLOW, `exit took ${Math.round(performance.now() - t1)} ms after SIGTERM`);
});

test("POST /_parity/reset over HTTP clears 1,000 objects in under 50 ms", { timeout: 10_000 * SLOW }, async (t) => {
  const { url } = await boot(t, ["--port", "0"]);
  const objects = Array.from({ length: 1000 }, (_, i) => build("customer", { id: `cus_${String(i).padStart(14, "0")}`, created: i }));
  const seeded = await fetch(`${url}/_parity/seed`, { method: "POST", body: JSON.stringify({ objects }) });
  assert.deepEqual(await seeded.json(), { seeded: 1000 });

  const t0 = performance.now();
  const res = await fetch(`${url}/_parity/reset`, { method: "POST" });
  await res.json();
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(ms < 50 * SLOW, `reset took ${ms.toFixed(1)} ms`);
  assert.deepEqual(await (await fetch(`${url}/_parity/state`)).json(), { objects: [], deleted: [], events: 0 });
});

test("takes the port from PORT and exits 0 on SIGINT", { timeout: 10_000 * SLOW }, async (t) => {
  const { child, url } = await boot(t, [], { PORT: "0" });
  assert.doesNotMatch(url, /:12111$/); // an ephemeral port, not the default
  child.kill("SIGINT");
  assert.deepEqual(await once(child, "exit"), [0, null]);
});

test("a port already in use prints one line and exits 1", { timeout: 10_000 * SLOW }, async (t) => {
  const { url } = await boot(t, ["--port", "0"]);
  const child = spawn(process.execPath, [MAIN, "--port", new URL(url).port], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let [out, err] = ["", ""];
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  assert.deepEqual(await once(child, "close"), [1, null]);
  assert.equal(out, "");
  assert.match(err, /^parity twin: listen EADDRINUSE: address already in use 127\.0\.0\.1:\d+\n$/);
});

/** A keep-alive POST /v1/customers whose body is half sent, so it is in flight until `finish()`. */
function halfSent(t: TestContext, url: string) {
  const body = "email=drain%40example.com";
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const headers = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length };
  const req = http.request(`${url}/v1/customers`, { method: "POST", agent, headers });
  req.on("error", () => {}); // `response` rejects with it
  const response = once(req, "response") as Promise<[http.IncomingMessage]>;
  req.write(body.slice(0, 5));
  return { response, finish: () => req.end(body.slice(5)) };
}

test("SIGTERM stops accepting, lets a request in flight finish, then exits 0 without waiting for the deadline", { timeout: 10_000 * SLOW }, async (t) => {
  const { child, url } = await boot(t, ["--port", "0"]);
  const inflight = halfSent(t, url);
  await sleep(100); // the server has the request's headers
  const t0 = performance.now();
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await sleep(100);
  await assert.rejects(fetch(`${url}/v1/customers`, { headers: AUTH }), "new connections are refused");

  inflight.finish();
  const [res] = await inflight.response;
  let text = "";
  for await (const chunk of res) text += chunk;
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(text).email, "drain@example.com");
  assert.equal(res.headers.connection, "close");
  assert.deepEqual(await exited, [0, null]);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000 * SLOW, `exit took ${Math.round(ms)} ms after SIGTERM`);
});

test("SIGTERM with a request that never finishes: connections are cut at the 5 s deadline, exit 0", { timeout: 10_000 * SLOW }, async (t) => {
  const { child, url } = await boot(t, ["--port", "0"]);
  const stalled = halfSent(t, url);
  await sleep(100);
  const t0 = performance.now();
  child.kill("SIGTERM");
  const cut = assert.rejects(stalled.response, /socket hang up/);
  assert.deepEqual(await once(child, "exit"), [0, null]);
  const ms = performance.now() - t0;
  assert.ok(ms >= 4900 && ms < 7000 * SLOW, `exit took ${Math.round(ms)} ms after SIGTERM`);
  await cut;
});
