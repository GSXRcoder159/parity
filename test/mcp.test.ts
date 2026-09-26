import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CLI = join(import.meta.dirname, "../src/cli.ts");
const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")).version;

test("mcp: initialize, list, call create/retrieve/reset over stdio JSON-RPC", async (t) => {
  // A fresh cwd: no .env is loaded.
  const child = spawn(process.execPath, [CLI, "mcp"], { cwd: mkdtempSync(join(tmpdir(), "pb-mcp-")), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill()); // a failed assertion must not leave the server (and the test run) hanging
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  let id = 0;
  // Every stdout line must be one JSON-RPC message (JSON.parse throws otherwise), answering the request just sent.
  const rpc = async (method: string, params?: object) => {
    send({ id: ++id, method, params });
    const msg = JSON.parse((await lines.next()).value as string);
    assert.equal(msg.id, id);
    return msg;
  };
  const call = async (name: string, args: object = {}) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const { status, body } = JSON.parse(result.content[0].text);
    assert.equal(result.isError, status >= 400);
    return { status, body, isError: result.isError as boolean };
  };

  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.deepEqual(init.result, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "parity-twin", version: VERSION } });
  assert.equal((await rpc("initialize", { protocolVersion: "2099-01-01" })).result.protocolVersion, "2025-11-25");
  send({ method: "notifications/initialized" }); // no reply: the next line answers the next request

  const { tools } = (await rpc("tools/list")).result as { tools: { name: string; description: string; inputSchema: Record<string, any> }[] };
  const byName = new Map(tools.map((t) => [t.name, t]));
  assert.equal(byName.size, tools.length, "tool names are unique");
  for (const n of ["post_v1_customers", "get_v1_customers", "get_v1_customers_customer", "post_v1_subscriptions", "parity_reset", "parity_state"]) assert.ok(byName.has(n), n);
  const retrieve = byName.get("get_v1_customers_customer")!;
  assert.equal(retrieve.description, "Retrieve a customer: GET /v1/customers/{customer} on the Parity twin.");
  assert.deepEqual(retrieve.inputSchema.required, ["customer"]);
  assert.deepEqual(Object.keys(retrieve.inputSchema.properties), ["customer", "expand"]);
  assert.equal(byName.get("post_v1_customers")!.inputSchema.properties.email.type, "string");
  assert.deepEqual(byName.get("post_v1_prices")!.inputSchema.required, ["currency"]);

  // Create (nested params reach the form body), retrieve by path param, list via the query string.
  const created = await call("post_v1_customers", { email: "jenny@example.com", metadata: { plan: "pro" } });
  assert.equal(created.status, 200);
  assert.match(created.body.id, /^cus_/);
  assert.deepEqual([created.body.email, created.body.metadata], ["jenny@example.com", { plan: "pro" }]);
  const got = await call("get_v1_customers_customer", { customer: created.body.id });
  assert.deepEqual([got.status, got.isError, got.body], [200, false, created.body]);
  await call("post_v1_customers", { email: "second@example.com" });
  const page = await call("get_v1_customers", { limit: 1 });
  assert.deepEqual([page.status, page.body.data.length, page.body.has_more], [200, 1, true]);

  // API and argument errors are tool results, not JSON-RPC errors.
  const bad = await call("post_v1_customers", { bogus: "x" });
  assert.deepEqual([bad.status, bad.isError, bad.body.error.param], [400, true, "bogus"]);
  const noPath = (await rpc("tools/call", { name: "get_v1_customers_customer", arguments: {} })).result;
  assert.deepEqual(noPath, { content: [{ type: "text", text: 'missing path parameter "customer" (a non-empty string)' }], isError: true });

  const state = await call("parity_state");
  assert.deepEqual(state.body.objects.map((o: { email: string }) => o.email), ["jenny@example.com", "second@example.com"]);
  assert.deepEqual(await call("parity_reset"), { status: 200, body: { reset: true }, isError: false });
  const gone = await call("get_v1_customers_customer", { customer: created.body.id });
  assert.deepEqual([gone.status, gone.isError, gone.body.error.type], [404, true, "invalid_request_error"]);
  assert.deepEqual((await call("parity_state")).body.objects, []);

  // Protocol errors: unknown tool, unknown method.
  assert.equal((await rpc("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
  assert.equal((await rpc("server/discover")).error.code, -32601);

  child.stdin.end(); // closing stdin shuts the server down
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal((await lines.next()).done, true, "no stray stdout");
  assert.equal(stderr, "");
});
