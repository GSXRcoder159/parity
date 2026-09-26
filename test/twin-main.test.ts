import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { build } from "../src/twin/build.ts";

const MAIN = new URL("../src/twin/main.ts", import.meta.url).pathname;
const AUTH = { Authorization: "Bearer sk_test_parity" };

/** Spawns the entrypoint and waits for its listening line; the child is killed when the test ends. */
async function boot(t: { after(fn: () => void): void }, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  const [line] = (await once(createInterface({ input: child.stdout }), "line")) as [string];
  const m = /^parity twin listening on (http:\/\/127\.0\.0\.1:\d+) \(API 2026-08-26\.dahlia\)$/.exec(line);
  assert.ok(m, `unexpected first line: ${line}`);
  return { child, url: m[1]! };
}

test("boots to a first successful request in under 1 s and exits 0 on SIGTERM", { timeout: 10_000 }, async (t) => {
  const t0 = performance.now();
  const { child, url } = await boot(t, ["--port", "0"]);
  const res = await fetch(`${url}/v1/customers`, { headers: AUTH });
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { object: string }).object, "list");
  assert.ok(ms < 1000, `boot to first request took ${Math.round(ms)} ms`);

  child.kill("SIGTERM");
  assert.deepEqual(await once(child, "exit"), [0, null]);
});

test("POST /_parity/reset over HTTP clears 1,000 objects in under 50 ms", { timeout: 10_000 }, async (t) => {
  const { url } = await boot(t, ["--port", "0"]);
  const objects = Array.from({ length: 1000 }, (_, i) => build("customer", { id: `cus_${String(i).padStart(14, "0")}`, created: i }));
  const seeded = await fetch(`${url}/_parity/seed`, { method: "POST", body: JSON.stringify({ objects }) });
  assert.deepEqual(await seeded.json(), { seeded: 1000 });

  const t0 = performance.now();
  const res = await fetch(`${url}/_parity/reset`, { method: "POST" });
  await res.json();
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(ms < 50, `reset took ${ms.toFixed(1)} ms`);
  assert.deepEqual(await (await fetch(`${url}/_parity/state`)).json(), { objects: [], deleted: [], events: 0 });
});

test("takes the port from PORT and exits 0 on SIGINT", { timeout: 10_000 }, async (t) => {
  const { child, url } = await boot(t, [], { PORT: "0" });
  assert.doesNotMatch(url, /:12111$/); // an ephemeral port, not the default
  child.kill("SIGINT");
  assert.deepEqual(await once(child, "exit"), [0, null]);
});
