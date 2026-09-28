import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { agree, agreeRuns, agreeText, meteredProxy, parseJunit, parseTap } from "../src/agree.ts";
import { readLedger } from "../src/bench/budget.ts";
import type { Target } from "../src/bench/run.ts";
import { createTwin } from "../src/twin/server.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");
const SUITE = join(import.meta.dirname, "../examples/agree-suite/billing.test.mjs");
const node = `"${process.execPath}"`;
// A fresh cwd and data dir per call: no .env is loaded and nothing lands in the repo or ../parity-data. Without
// NODE_TEST_CONTEXT, which this runner sets and which would stop the suite's own `node --test` from running its files.
const { NODE_TEST_CONTEXT: _, ...parentEnv } = process.env;
const cli = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...parentEnv, PARITY_DATA_DIR: join(cwd, "data"), ...env } });
const tmp = (): string => mkdtempSync(join(tmpdir(), "pb-agree-"));

test("parseTap: one outcome per test (a block's tests, not the block), SKIP and TODO as skip, escapes undone, duplicate names numbered", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: a \\# hash",
    "ok 1 - a \\# hash",
    "  ---",
    "  duration_ms: 0.4",
    "  ...",
    "not ok 2 - b fails",
    "ok 3 - c skip # SKIP nope",
    "# Subtest: grp",
    "    # Subtest: inner",
    "    not ok 1 - inner",
    "    1..1",
    "not ok 4 - grp",
    "not ok 5 - d todo # TODO",
    "ok 6 - b fails",
    "1..6",
    "# tests 6",
  ].join("\n");
  assert.deepEqual(
    [...parseTap(tap)],
    [
      ["a # hash", "pass"],
      ["b fails", "fail"],
      ["c skip", "skip"],
      ["grp > inner", "fail"],
      ["d todo", "skip"],
      ["b fails (2)", "pass"],
    ],
  );
});

test("parseTap on real node --test output: nested describe blocks and subtests count per test", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-tap-"));
  writeFileSync(
    join(dir, "nested.test.mjs"),
    [
      'import { describe, it, test } from "node:test";',
      'describe("billing", () => { it("previews", () => {}); describe("refunds", () => { it("full", () => {}); it("partial # x", () => { throw new Error("no"); }); }); });',
      'test("top", () => {});',
      'test("with subtests", async (t) => { await t.test("a", () => {}); await t.test("b", { skip: true }, () => {}); });',
    ].join("\n"),
  );
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, "nested.test.mjs")], { encoding: "utf8", env: parentEnv });
  assert.deepEqual(
    [...parseTap(r.stdout)],
    [
      ["billing > previews", "pass"],
      ["billing > refunds > full", "pass"],
      ["billing > refunds > partial # x", "fail"],
      ["top", "pass"],
      ["with subtests > a", "pass"],
      ["with subtests > b", "skip"],
    ],
  );
});

test("parseJunit: classname > name, entities decoded, failure/error fail, skipped skip (also over a failure)", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="a &amp; b" time="0.1" classname="test"/>
  <testcase name="fails" classname="test" failure="1 > 2"><failure type="x" message="1 > 2">at &lt;anonymous> (file.js)</failure></testcase>
  <testsuite name="grp"><testcase name='errors' classname="pkg.Mod"><error message="boom"/></testcase></testsuite>
  <testcase name="todo" classname="test"><skipped type="todo"/><failure message="x"/></testcase>
  <testcase name="no class"></testcase>
</testsuites>`;
  assert.deepEqual(
    [...parseJunit(xml)],
    [
      ["test > a & b", "pass"],
      ["test > fails", "fail"],
      ["pkg.Mod > errors", "fail"],
      ["test > todo", "skip"],
      ["no class", "pass"],
    ],
  );
});

test("agree: runs the command per target with its base and key, pairs by name, reports names and outcomes only", async () => {
  const dir = tmp();
  const probe = join(dir, "probe.mjs");
  // Prints a response body to stdout: the report must never carry it.
  writeFileSync(
    probe,
    `const res = await fetch(process.env.STRIPE_API_BASE + "/v1/customers", { method: "POST", headers: { Authorization: "Bearer " + process.env.STRIPE_API_KEY } });
console.log("BODY " + (await res.text()));
console.log((res.status === 200 ? "ok" : "not ok") + " 1 - creates a customer");
console.log("ok 2 - always passes");
if (process.env.STRIPE_API_KEY === "sk_test_parity") console.log("ok 3 - only with the parity key");
`,
  );
  const servers = await Promise.all([createTwin().listen(0), createTwin().listen(0)]);
  const [a, b] = servers.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
  try {
    const r = await agree({
      cmd: `${node} "${probe}"`,
      targets: [
        { name: "twin", baseUrl: a!, apiKey: "sk_test_parity" },
        { name: "other", baseUrl: b!, apiKey: "bad_key" },
      ],
    });
    assert.deepEqual(r.targets, ["twin", "other"]);
    assert.deepEqual(r.tests, [
      { name: "creates a customer", outcomes: { twin: "pass", other: "fail" } },
      { name: "always passes", outcomes: { twin: "pass", other: "pass" } },
      { name: "only with the parity key", outcomes: { twin: "pass", other: "missing" } },
    ]);
    assert.deepEqual(r.disagreeing, ["creates a customer", "only with the parity key"]);
    assert.equal(r.agreement!.k, 1);
    assert.equal(r.agreement!.n, 3);
    assert.ok(r.agreement!.lo < 1 / 3 && r.agreement!.hi > 1 / 3);
    const text = agreeText(r);
    assert.match(text, /\*\*Agreement: 33\.3%\*\* \(1\/3 tests; 95% Wilson CI \d+\.\d%–\d+\.\d%\)/);
    assert.match(text, /- creates a customer: twin pass, other fail/);
    for (const s of [text, JSON.stringify(r)]) assert.doesNotMatch(s, /BODY|cus_|"object"/);
  } finally {
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  }
});

test("agree --runs twin: the example suite on an in-process twin; the twin run gets sk_test_parity, never .env's key", () => {
  const dir = tmp();
  writeFileSync(
    join(dir, "env.mjs"),
    `const { STRIPE_API_KEY: k, STRIPE_API_BASE: b } = process.env;
console.log((k === "sk_test_parity" ? "ok" : "not ok") + " 1 - twin key");
console.log((/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(b) ? "ok" : "not ok") + " 2 - twin base");
`,
  );
  writeFileSync(join(dir, ".env"), "STRIPE_API_KEY=sk_test_from_dotenv\n");
  const env = cli(["agree", "--cmd", `${node} env.mjs`, "--runs", "twin"], dir);
  assert.equal(env.status, 0, env.stderr);
  assert.match(env.stdout, /\| twin key \| pass \|\n\| twin base \| pass \|/);

  const r = cli(["agree", "--cmd", `${node} --test --test-reporter=tap "${SUITE}"`, "--runs", "twin", "--out", "reports/suite"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /agree: twin: 8 tests/);
  const json = JSON.parse(readFileSync(join(dir, "reports/suite.json"), "utf8"));
  assert.equal(json.agreement, null);
  const outcome = Object.fromEntries(json.tests.map((t: { name: string; outcomes: { twin: string } }) => [t.name, t.outcomes.twin]));
  assert.equal(Object.keys(outcome).length, 8);
  // The preview and the price change are the W4 proration surface (Task 2): not asserted here.
  for (const name of ["creates a customer", "attaches a card as the default payment method", "creates a monthly price", "subscribes the customer and charges the first invoice", "cancels the subscription", "refunds the first payment"]) {
    assert.equal(outcome[name], "pass", name);
  }
  assert.equal(readFileSync(join(dir, "reports/suite.md"), "utf8"), r.stdout);
});

test("agree --junit: reads the file the command writes, and a stale file never stands in for a run", () => {
  const dir = tmp();
  writeFileSync(join(dir, "probe.test.mjs"), `import { test } from "node:test";\ntest("passes", () => {});\ntest("fails", () => { throw new Error("x"); });\n`);
  const r = cli(["agree", "--cmd", `${node} --test --test-reporter=junit --test-reporter-destination=out.xml probe.test.mjs`, "--junit", "out.xml", "--runs", "twin"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| test > passes \| pass \|\n\| test > fails \| fail \|/);

  writeFileSync(join(dir, "out.xml"), `<testcase name="stale" classname="test"/>`);
  const stale = cli(["agree", "--cmd", `${node} -e 0`, "--junit", "out.xml", "--runs", "twin"], dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /agree: twin: the command wrote no out\.xml \(exit code 0\)/);
});

test("agree: a command that prints no TAP is an error", () => {
  const dir = tmp();
  const r = cli(["agree", "--cmd", `${node} -e "process.exit(3)"`, "--runs", "twin"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no TAP test lines on stdout \(exit code 3\)/);
});

test("agree sandbox: refused without a key or at the read budget, before any command runs", () => {
  const dir = tmp();
  const marker = join(dir, "ran");
  const cmd = `${node} -e "require('fs').writeFileSync('ran', '')"`;
  const noKey = cli(["agree", "--cmd", cmd], dir, { STRIPE_API_KEY: "" });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /STRIPE_API_KEY is not set/);

  mkdirSync(join(dir, "data/budget"), { recursive: true });
  // Exactly at the budget is refused too: R7 halts a run when the total reaches it.
  const entry = { date: new Date().toISOString(), account: "acct_test", target: "sandbox", runId: "r1", gets: 50, posts: 0, deletes: 0, charges: 0 };
  writeFileSync(join(dir, "data/budget/reads.jsonl"), JSON.stringify(entry) + "\n");
  const at = cli(["agree", "--cmd", cmd, "--runs", "twin,sandbox"], dir, { STRIPE_API_KEY: "sk_test_fake", PARITY_READ_BUDGET: "50" });
  assert.equal(at.status, 1);
  assert.match(at.stderr, /refusing to run: 50 sandbox GETs in the last 30 days \+ 1 projected/);
  assert.equal(existsSync(marker), false);
});

test("agree: --cmd is required and --runs takes only twin and sandbox", () => {
  const dir = tmp();
  assert.equal(cli(["agree", "--runs", "twin"], dir).status, 2);
  const bad = cli(["agree", "--cmd", "true", "--runs", "twin,mock"], dir);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--runs must be twin, sandbox or both/);
  assert.equal(cli(["agree", "--cmd", "true", "--runs", "twin,twin"], dir).status, 2);
});

/** A stand-in for api.stripe.com: records what reaches it and answers `status` with a gzipped JSON body. */
async function fakeUpstream(): Promise<{ target: Target; hits: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[]; status: { v: number }; server: Server }> {
  const hits: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const status = { v: 200 };
  const keys = new Set<unknown>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    hits.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    // As Stripe answers a request whose Idempotency-Key it has seen: the first answer again, marked as a replay.
    const replayed = keys.has(req.headers["idempotency-key"]);
    if (req.headers["idempotency-key"]) keys.add(req.headers["idempotency-key"]);
    res.writeHead(status.v, { "content-type": "application/json", "content-encoding": "gzip", "request-id": `req_${hits.length}`, ...(replayed && { "idempotent-replayed": "true" }) });
    res.end(gzipSync(JSON.stringify({ n: hits.length })));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { target: { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "unused", rps: 1000 }, hits, status, server };
}
const ledgerWith = (dir: string, gets: number): string => {
  const path = join(dir, "reads.jsonl");
  if (gets) writeFileSync(path, JSON.stringify({ date: new Date().toISOString(), account: "acct_test", target: "sandbox", runId: "r0", gets, posts: 0, deletes: 0, charges: 0 }) + "\n");
  return path;
};

test("meteredProxy: forwards requests with their headers and body, decodes gzip, counts by method, ledgers on close", async () => {
  const up = await fakeUpstream();
  const ledger = ledgerWith(tmp(), 0);
  const p = await meteredProxy(up.target, { ledger, budget: 100, runId: "r1" });
  try {
    const auth = { Authorization: "Bearer sk_test_child" };
    const g = await fetch(`${p.baseUrl}/v1/customers?limit=1`, { headers: auth });
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), { n: 1 });
    assert.equal(g.headers.get("request-id"), "req_1");
    const post = await fetch(`${p.baseUrl}/v1/customers`, { method: "POST", headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" }, body: "email=a%40b.c" });
    assert.deepEqual(await post.json(), { n: 2 });
    await (await fetch(`${p.baseUrl}/v1/customers/cus_1`, { method: "DELETE", headers: auth })).text();
    assert.deepEqual(up.hits.map((h) => [h.method, h.url, h.headers.authorization, h.body]), [
      ["GET", "/v1/customers?limit=1", "Bearer sk_test_child", ""],
      ["POST", "/v1/customers", "Bearer sk_test_child", "email=a%40b.c"],
      ["DELETE", "/v1/customers/cus_1", "Bearer sk_test_child", ""],
    ]);
  } finally {
    const m = await p.close();
    up.server.close();
    assert.deepEqual(m, { gets: 1, posts: 1, deletes: 1, charges: 0, aborted: undefined });
  }
  const [row] = readLedger(ledger);
  assert.deepEqual({ ...row, date: undefined }, { date: undefined, account: process.env.STRIPE_SANDBOX_ACCOUNT ?? "unknown", target: "sandbox", runId: "r1", gets: 1, posts: 1, deletes: 1, charges: 0 });
});

test("meteredProxy: ledgers charges as 2xx answers to direct charge-creating calls; declines, replays and the charges Stripe makes on its own are not counted", async () => {
  const up = await fakeUpstream();
  const ledger = ledgerWith(tmp(), 0);
  const p = await meteredProxy(up.target, { ledger, budget: 100, runId: "r5" });
  const post = async (path: string, body = "", key?: string) =>
    (await fetch(`${p.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(key && { "Idempotency-Key": key }) }, body })).status;
  const counted = [
    await post("/v1/charges", "amount=2000&currency=usd&source=tok_visa", "key-1"),
    await post("/v1/payment_intents", "amount=2000&currency=usd&payment_method=pm_card_visa&confirm=true"),
    await post("/v1/payment_intents/pi_1/confirm?expand[]=latest_charge", "payment_method=pm_card_visa"),
    await post("/v1/invoices/in_1/pay"),
  ];
  const notCounted = [
    await post("/v1/charges", "amount=2000&currency=usd&source=tok_visa", "key-1"), // the first call's replay
    await post("/v1/payment_intents", "amount=2000&currency=usd"), // created, not confirmed
    await post("/v1/invoices/in_2/pay", "paid_out_of_band=true"),
    await post("/v1/subscriptions", "customer=cus_1&items[0][price]=price_1"), // may charge its first invoice: not countable here
    (await fetch(`${p.baseUrl}/v1/charges?limit=3`)).status,
  ];
  up.status.v = 402;
  notCounted.push(await post("/v1/charges", "amount=2000&currency=usd&source=tok_chargeDeclined")); // declined
  const m = await p.close();
  up.server.close();
  assert.deepEqual([...counted, ...notCounted], [200, 200, 200, 200, 200, 200, 200, 200, 200, 402]);
  assert.equal(up.hits.length, 10, "every call was forwarded");
  assert.deepEqual([m.charges, readLedger(ledger)[0]!.charges], [4, 4]);
});

test("meteredProxy: halts the run when the rolling GETs reach the budget; nothing after it is forwarded", async () => {
  const up = await fakeUpstream();
  const ledger = ledgerWith(tmp(), 49);
  const p = await meteredProxy(up.target, { ledger, budget: 50, runId: "r2" });
  assert.equal(p.rolling, 49);
  const statuses = [];
  for (const method of ["GET", "POST", "GET"]) statuses.push((await fetch(`${p.baseUrl}/v1/customers`, { method })).status);
  const m = await p.close();
  up.server.close();
  assert.deepEqual(statuses, [200, 503, 503]);
  assert.equal(up.hits.length, 1);
  assert.match(m.aborted!, /reached the read budget 50/);
  assert.deepEqual(readLedger(ledger).map((e) => e.gets), [49, 1]);
});

test("meteredProxy: the circuit breaker halts the run after 10 consecutive 429s", async () => {
  const up = await fakeUpstream();
  up.status.v = 429;
  const p = await meteredProxy(up.target, { ledger: ledgerWith(tmp(), 0), budget: 100, runId: "r3" });
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await fetch(`${p.baseUrl}/v1/customers`)).status);
  const m = await p.close();
  up.server.close();
  assert.deepEqual(statuses, [...Array(10).fill(429), 503, 503]);
  assert.equal(up.hits.length, 10);
  assert.match(m.aborted!, /circuit breaker: 10 consecutive/);
});

test("agreeRuns sandbox: the command gets the proxy as its base and the .env key; its requests are ledgered; a halted run throws", async (t) => {
  t.mock.method(console, "error", () => {});
  const dir = tmp();
  // An existing (empty) ledger, so readsLedger never seeds it from this repo's budget/reads.jsonl.
  mkdirSync(join(dir, "data/budget"), { recursive: true });
  const ledger = join(dir, "data/budget/reads.jsonl");
  writeFileSync(ledger, "");
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `const { STRIPE_API_BASE: b, STRIPE_API_KEY: k } = process.env;
console.log((/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(b) ? "ok" : "not ok") + " 1 - proxy base");
let s;
for (let i = 0; i < Number(process.argv[2]); i++) s = (await fetch(b + "/v1/customers", { headers: { Authorization: "Bearer " + k } })).status;
console.log((s === 200 ? "ok" : "not ok") + " 2 - reads through the proxy");
`,
  );
  const up = await fakeUpstream();
  const saved = { PARITY_DATA_DIR: process.env.PARITY_DATA_DIR, STRIPE_API_KEY: process.env.STRIPE_API_KEY, PARITY_READ_BUDGET: process.env.PARITY_READ_BUDGET };
  Object.assign(process.env, { PARITY_DATA_DIR: join(dir, "data"), STRIPE_API_KEY: "sk_test_env", PARITY_READ_BUDGET: "100" });
  try {
    const text = await agreeRuns({ cmd: `${node} "${probe}" 2`, runs: ["sandbox"], sandbox: up.target });
    assert.match(text, /\| proxy base \| pass \|\n\| reads through the proxy \| pass \|/);
    assert.deepEqual(up.hits.map((h) => h.headers.authorization), ["Bearer sk_test_env", "Bearer sk_test_env"]);
    assert.deepEqual(readLedger(ledger).map((e) => e.gets), [2]);

    up.status.v = 429;
    await assert.rejects(agreeRuns({ cmd: `${node} "${probe}" 12`, runs: ["sandbox"], sandbox: up.target }), /sandbox run was halted.*circuit breaker/);
    assert.equal(up.hits.length, 12);
    assert.deepEqual(readLedger(ledger).map((e) => e.gets), [2, 10]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    up.server.close();
  }
});

test("meteredProxy: requests wait on the upstream's limiter (rps)", async () => {
  const up = await fakeUpstream();
  const p = await meteredProxy({ ...up.target, rps: 5 }, { ledger: ledgerWith(tmp(), 0), budget: 100, runId: "r4" });
  const t0 = performance.now();
  for (let i = 0; i < 8; i++) await (await fetch(`${p.baseUrl}/v1/customers`)).text();
  const ms = performance.now() - t0;
  await p.close();
  up.server.close();
  // A bucket of 5 at 5/s: the first 5 go at once, the next 3 wait ~200 ms each.
  assert.ok(ms >= 500, `8 requests at 5 req/s took ${ms.toFixed(0)} ms`);
});
