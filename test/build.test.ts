import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ROOT = join(import.meta.dirname, "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string; bin: { paritybench: string } };

test("build: the compiled package (as npm installs it) serves the twin over HTTP and MCP", { timeout: 60_000 }, async (t) => {
  // <tmp>/package.json + <tmp>/dist: the tarball's layout, outside the repo, so nothing resolves back into src/.
  const pkg = mkdtempSync(join(tmpdir(), "pb-build-"));
  const b = spawnSync(process.execPath, [join(ROOT, "scripts/build.ts"), join(pkg, "dist")], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  copyFileSync(join(ROOT, "package.json"), join(pkg, "package.json"));
  const bin = join(pkg, PKG.bin.paritybench);
  assert.match(readFileSync(bin, "utf8"), /^#!\/usr\/bin\/env node\n/);
  const files = readdirSync(join(pkg, "dist"), { recursive: true, encoding: "utf8" });
  assert.deepEqual(files.filter((f) => f.endsWith(".ts")), [], "no TypeScript under dist: Node will not strip it in node_modules");
  assert.ok(files.includes(join("src", "twin", "spec", "openapi.pruned.json")) && files.includes(join("src", "twin", "shapes", "customer.json")));

  const twin = spawn(process.execPath, [bin, "twin", "--port", "0"], { cwd: pkg, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => twin.kill("SIGKILL"));
  const [line] = (await once(createInterface({ input: twin.stdout }), "line")) as [string];
  const url = /^parity twin listening on (http:\/\/127\.0\.0\.1:\d+) /.exec(line)?.[1];
  assert.ok(url, `unexpected first line: ${line}`);
  const res = await fetch(`${url}/v1/customers`, { headers: { Authorization: "Bearer sk_test_parity" } });
  assert.equal(res.status, 200, "resource routes load from .js modules");
  assert.equal(((await res.json()) as { object: string }).object, "list");
  twin.kill("SIGTERM");
  assert.deepEqual(await once(twin, "exit"), [0, null]);

  const msgs = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { id: 2, method: "tools/list" },
  ];
  const mcp = spawnSync(process.execPath, [bin, "mcp"], { cwd: pkg, encoding: "utf8", input: msgs.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n").join("") });
  assert.equal(mcp.status, 0, mcp.stderr);
  const [init, list] = mcp.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.version, PKG.version);
  const names = (list.result.tools as { name: string }[]).map((x) => x.name);
  assert.ok(names.includes("post_v1_customers") && names.includes("get_v1_customers"), names.join(","));

  // No checkout to default into: the data dir (read ledger) must be explicit, and align/nightly refuse outright.
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: pkg, encoding: "utf8", env: { ...process.env, PARITY_DATA_DIR: "" } });
  const oracle = run("oracle", "build");
  assert.equal(oracle.status, 1);
  assert.match(oracle.stderr, /^paritybench: set PARITY_DATA_DIR: /);
  const align = run("align");
  assert.equal(align.status, 1);
  assert.match(align.stderr, /^paritybench: align runs from a checkout /);
});
