import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agree, agreeText, parseJunit, parseTap } from "../src/agree.ts";
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

test("parseTap: top-level results only, SKIP and TODO as skip, escapes undone, duplicate names numbered", () => {
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
      ["grp", "fail"],
      ["d todo", "skip"],
      ["b fails (2)", "pass"],
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

test("agree sandbox: refused without a key or over the read budget, before any command runs", () => {
  const dir = tmp();
  const marker = join(dir, "ran");
  const cmd = `${node} -e "require('fs').writeFileSync('ran', '')"`;
  const noKey = cli(["agree", "--cmd", cmd], dir, { STRIPE_API_KEY: "" });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /STRIPE_API_KEY is not set/);

  mkdirSync(join(dir, "data/budget"), { recursive: true });
  const entry = { date: new Date().toISOString(), account: "acct_test", target: "sandbox", runId: "r1", gets: 60, posts: 0, deletes: 0, charges: 0 };
  writeFileSync(join(dir, "data/budget/reads.jsonl"), JSON.stringify(entry) + "\n");
  const over = cli(["agree", "--cmd", cmd, "--runs", "twin,sandbox"], dir, { STRIPE_API_KEY: "sk_test_fake", PARITY_READ_BUDGET: "50" });
  assert.equal(over.status, 1);
  assert.match(over.stderr, /refusing to run: 60 sandbox GETs in the last 30 days/);
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
