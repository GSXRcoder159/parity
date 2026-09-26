import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { budgetRefusal, newRunId, resolveTarget, slice } from "../src/cli.ts";
import type { LedgerEntry } from "../src/bench/budget.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import type { Recording } from "../src/types.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");
// A fresh cwd and data dir per call: no .env is loaded and nothing lands in the repo or ../parity-data.
const env = (cwd: string) => ({ ...process.env, PARITY_DATA_DIR: join(cwd, "data") });
const cli = (args: string[], cwd = mkdtempSync(join(tmpdir(), "pb-cli-"))) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: env(cwd) });
/** Async variant for runs against a server in this process (spawnSync would block its event loop). */
const cliAsync = (args: string[], cwd: string) => promisify(execFile)(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: env(cwd) });

const rec = (seq: string, customerId: string): Recording => ({
  seq,
  template: seq.split("#")[0]!,
  stratum: "lifecycle",
  seed: Number(seq.split("#")[1]),
  heldOut: false,
  target: "sandbox",
  runId: "run1",
  startedAt: "2026-09-25T00:00:00Z",
  ms: 1,
  steps: [{ i: 0, method: "POST", path: "/v1/customers", status: 200, body: { id: customerId, object: "customer", created: 1790000000 }, resHeaders: {}, ms: 1 }],
  events: [],
});

test("compare writes <out>.md and <out>.json; normalized ids match, --raw ids diverge", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-cmp-"));
  // Target lists the sequences in a different order: pairing is by seq, not by line.
  writeJsonl(join(dir, "a.jsonl"), [rec("customer-crud#1", "cus_AAAAAAAAAAAAAA"), rec("customer-crud#2", "cus_BBBBBBBBBBBBBB")]);
  writeJsonl(join(dir, "b.jsonl"), [rec("customer-crud#2", "cus_DDDDDDDDDDDDDD"), rec("customer-crud#1", "cus_CCCCCCCCCCCCCC")]);

  const norm = cli(["compare", "--oracle", "a.jsonl", "--target", "b.jsonl", "--out", "out/norm"], dir);
  assert.equal(norm.status, 0, norm.stderr);
  const nj = JSON.parse(readFileSync(join(dir, "out/norm.json"), "utf8"));
  assert.equal(nj.normalization, "v1.2");
  assert.equal(nj.score.overall.L3.p, 1);
  assert.deepEqual(nj.results.map((r: { seq: string }) => r.seq), ["customer-crud#1", "customer-crud#2"]);
  assert.match(readFileSync(join(dir, "out/norm.md"), "utf8"), /^# ParityBench: b\.jsonl vs a\.jsonl/);

  const raw = cli(["compare", "--oracle", "a.jsonl", "--target", "b.jsonl", "--raw", "--out", "out/raw"], dir);
  assert.equal(raw.status, 0, raw.stderr);
  const rj = JSON.parse(readFileSync(join(dir, "out/raw.json"), "utf8"));
  assert.equal(rj.normalization, "raw");
  assert.equal(rj.score.overall.L3.p, 0);
  assert.deepEqual(
    rj.results.map((r: { divergences: { path: string }[] }) => r.divergences.map((d) => d.path)),
    [["$.id"], ["$.id"]],
  );

  // --noise: oracle-vs-noise divergences are the floor and mark the same target divergences NONDETERMINISTIC.
  const withNoise = cli(["compare", "--oracle", "a.jsonl", "--target", "b.jsonl", "--noise", "b.jsonl", "--raw", "--out", "out/noise"], dir);
  assert.equal(withNoise.status, 0, withNoise.stderr);
  const wj = JSON.parse(readFileSync(join(dir, "out/noise.json"), "utf8"));
  assert.equal(wj.noise.overall.L3.p, 0);
  assert.equal(wj.results[0].divergences[0].cls, "NONDETERMINISTIC");
  assert.match(readFileSync(join(dir, "out/noise.md"), "utf8"), /\| L3 \| 0\.0%/);
});

test("compare fails clearly when the target lacks an oracle sequence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-cmp-"));
  writeJsonl(join(dir, "a.jsonl"), [rec("customer-crud#1", "cus_AAAAAAAAAAAAAA")]);
  writeJsonl(join(dir, "b.jsonl"), [rec("customer-crud#2", "cus_BBBBBBBBBBBBBB")]);
  const r = cli(["compare", "--oracle", "a.jsonl", "--target", "b.jsonl", "--out", "x"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /b\.jsonl has no recording for oracle sequence customer-crud#1/);
});

test("argv errors exit 2 with a usage line", () => {
  for (const args of [
    [],
    ["bogus"],
    ["compare", "--target", "b.jsonl", "--out", "x"], // missing --oracle
    ["compare", "--oracle", "a.jsonl", "--target", "b.jsonl", "--out"], // flag without value
    ["record", "--target", "sandbox", "--bogus", "1"],
    ["record", "--target", "not a url"],
    ["record", "--target", "http://127.0.0.1:9", "--concurrency", "0"],
    ["record", "--target", "http://127.0.0.1:9", "--seeds", "5-1"],
    ["record", "--target", "http://127.0.0.1:9", "--templates", "no-such-template"],
    ["record", "--target", "http://127.0.0.1:9", "--slice", "3/2"],
    ["record", "--target", "http://127.0.0.1:9", "--slice", "1"],
    ["record", "--target", "http://127.0.0.1:9", "--chunk", "0"],
    ["record", "--target", "http://127.0.0.1:9", "--chunk", "2.5"],
    ["record", "--target", "http://127.0.0.1:9", "--chunk-wait", "20"], // without --chunk
    ["record", "--target", "http://127.0.0.1:9", "--chunk", "5", "--chunk-wait", "-1"],
    ["record", "--target", "http://127.0.0.1:9", "--name", "sandbox"], // oracle build trusts target "sandbox"
    ["bench", "--oracle", "a.jsonl"], // missing <baseURL>
    ["oracle"],
    ["oracle", "rebuild"],
    ["oracle", "build", "--max-age-days", "0"],
    ["oracle", "build", "--oracle", "x"],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^usage:$/m, args.join(" "));
  }
  const help = cli(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage:$/m);
});

test("budget: refuses only when rolling 30-day GETs + projected exceed the budget", () => {
  const entry = (date: string, gets: number): LedgerEntry => ({ date, account: "acct_x", target: "sandbox", runId: "r", gets, posts: 0, deletes: 0, charges: 0 });
  const now = "2026-09-25T12:00:00Z";
  const ledger = [entry("2026-09-25T00:00:00Z", 800), entry("2026-09-20T00:00:00Z", 9000), entry("2026-08-20T00:00:00Z", 5000)]; // last one is >30 days old
  assert.equal(budgetRefusal(ledger, 200, now, 10_000), null); // 9800 + 200 = budget exactly
  const msg = budgetRefusal(ledger, 201, now, 10_000);
  assert.match(msg ?? "", /refusing to run: 9800 sandbox GETs in the last 30 days \+ 201 projected .* = 10001 > read budget 10000/);
  assert.notEqual(budgetRefusal([], 10_001, now, 10_000), null);
});

test("targets: a URL on api.stripe.com gets the sandbox's 20 req/s cap and key; other URLs do not", () => {
  const saved = process.env.STRIPE_API_KEY;
  try {
    process.env.STRIPE_API_KEY = "sk_test_x";
    for (const spec of ["sandbox", "https://api.stripe.com", "https://API.stripe.com/v1/", "http://api.stripe.com:443"]) {
      assert.deepEqual(resolveTarget(spec, "n"), { name: "sandbox", baseUrl: "https://api.stripe.com", apiKey: "sk_test_x", rps: 20, eventWaitMs: 3000 }, spec);
    }
    const local = resolveTarget("http://127.0.0.1:9/");
    assert.equal(local.rps, undefined);
    assert.equal(local.baseUrl, "http://127.0.0.1:9");
    delete process.env.STRIPE_API_KEY;
    assert.throws(() => resolveTarget("https://api.stripe.com"), /STRIPE_API_KEY is not set/);
  } finally {
    if (saved === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = saved;
  }
});

test("slice k/n keeps indexes congruent to k mod n", () => {
  const xs = [0, 1, 2, 3, 4, 5, 6];
  assert.deepEqual(slice(xs, "1/3"), [1, 4]);
  assert.deepEqual(slice(xs, "0/3"), [0, 3, 6]);
  assert.deepEqual(slice(xs, "0/1"), xs);
  for (const bad of ["3/3", "1/0", "-1/3", "1/3/5", "a/b", ""]) assert.throws(() => slice(xs, bad), /--slice must be k\/n/, bad);
});

test("record --slice --chunk and bench --oracle against a local server; bench sends each sequence its oracle's Parity-Now", async () => {
  const hits: { url: string; now: string | undefined }[] = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url!, now: req.headers["parity-now"] as string | undefined });
    const events = req.url!.startsWith("/v1/events");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(events ? { object: "list", has_more: false, data: [] } : { id: "cus_Local123456789", object: "customer", created: 1790000000 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "pb-e2e-"));
    const args = ["--templates", "customer-crud", "--seeds", "1-4", "--slice", "1/2", "--chunk", "1", "--chunk-wait", "0"];
    const r = await cliAsync(["record", "--target", url, "--name", "local", ...args], dir);
    assert.match(r.stdout, /2 sequences against local at concurrency 8 in 2 chunks of 1, 0 min apart/);
    // 6 steps + an empty event list (no cursor yet) re-listed until two passes in a row find nothing: 3 sweep GETs.
    assert.match(r.stdout, /^chunk 2\/2: sequences 1 · requests 9 \(GET 5 incl\. 3 event-sweep, POST 3, DELETE 1\)/m);
    const [file] = readdirSync(join(dir, "recordings"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl"));
    assert.match(file!, /^\d{4}-\d{2}-\d{2}\/local-\d{8}T\d{6}-[0-9a-z]{4}\.jsonl$/, "URL targets keep recordings/<date>/");
    const recs = readJsonl<Recording>(join(dir, "recordings", file!));
    assert.deepEqual(recs.map((x) => x.seq), ["customer-crud#2", "customer-crud#4"]);
    assert.ok(recs.every((x) => x.steps.every((s) => s.status === 200)));
    assert.ok(hits.every((h) => h.now === undefined), "record sends no Parity-Now");

    // bench: the oracle's two sequences were recorded on different days
    const oracle = recs.map((x, i) => ({ ...x, target: "sandbox", startedAt: `2026-09-2${i}T12:00:00.000Z` }));
    writeJsonl(join(dir, "oracle.jsonl"), oracle);
    hits.length = 0;
    const b = await cliAsync(["bench", url, "--oracle", "oracle.jsonl", "--out", "bench"], dir);
    assert.match(b.stdout, /2 sequences · L1 100\.0%/);
    const epoch = (iso: string) => String(Date.parse(iso) / 1000);
    const steps = hits.filter((h) => !h.url.startsWith("/v1/events"));
    assert.equal(steps.length, 12);
    assert.deepEqual([...new Set(steps.map((h) => h.now))].sort(), oracle.map((o) => epoch(o.startedAt)));
    const benchFile = readdirSync(join(dir, "recordings"), { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(".jsonl") && f !== file);
    for (const x of readJsonl<Recording>(join(dir, "recordings", benchFile!))) {
      const want = epoch(oracle.find((o) => o.seq === x.seq)!.startedAt);
      assert.ok(x.steps.every((s) => s.headers?.["Parity-Now"] === want), x.seq);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("runId: UTC YYYYMMDDTHHMMSS plus 4 random base36 chars", () => {
  const id = newRunId(new Date("2026-09-25T07:08:09.123Z"));
  assert.match(id, /^20260925T070809-[0-9a-z]{4}$/);
  assert.notEqual(newRunId(), newRunId()); // 1 in 1.7M chance of a false failure within the same second
});
