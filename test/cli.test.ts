import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { budgetRefusal, newRunId, resolveTarget, slice, unwaited } from "../src/cli.ts";
import type { LedgerEntry } from "../src/bench/budget.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, touching } from "../src/bench/run.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { createTwin } from "../src/twin/server.ts";
import type { Recording } from "../src/types.ts";
import { TEMPLATES } from "../templates/index.ts";

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
  assert.equal(nj.normalization, "v1.8");
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

test("--noise covering part of the oracle: the floor is measured on the covered sequences and the report says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-cmp-"));
  writeJsonl(join(dir, "a.jsonl"), [rec("customer-crud#1", "cus_AAAAAAAAAAAAAA"), rec("customer-crud#2", "cus_BBBBBBBBBBBBBB")]);
  writeJsonl(join(dir, "b.jsonl"), [rec("customer-crud#2", "cus_DDDDDDDDDDDDDD"), rec("customer-crud#1", "cus_CCCCCCCCCCCCCC")]);
  writeJsonl(join(dir, "n.jsonl"), [rec("customer-crud#2", "cus_EEEEEEEEEEEEEE")]);
  const r = cli(["compare", "--oracle", "a.jsonl", "--target", "b.jsonl", "--noise", "n.jsonl", "--out", "out/part"], dir);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(dir, "out/part.json"), "utf8"));
  assert.deepEqual([j.noise.overall.L3.n, j.noiseCoverage], [1, { seqs: 1, oracleSeqs: 2, templates: 1, oracleTemplates: 1 }]);
  assert.equal(j.results.length, 2, "the target is still scored on the whole oracle");
  assert.match(readFileSync(join(dir, "out/part.md"), "utf8"), /covers 1 of 2 oracle sequences/);
  // A noise file with no oracle sequence is refused; bench refuses it before recording anything.
  writeJsonl(join(dir, "none.jsonl"), [rec("customer-crud#9", "cus_FFFFFFFFFFFFFF")]);
  const bad = cli(["compare", "--oracle", "a.jsonl", "--target", "b.jsonl", "--noise", "none.jsonl", "--out", "out/x"], dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /none\.jsonl has no clean recording of any oracle sequence/);
  const bench = cli(["bench", "http://127.0.0.1:9", "--oracle", "a.jsonl", "--noise", "none.jsonl"], dir);
  assert.equal(bench.status, 1);
  assert.match(bench.stderr, /no clean recording of any oracle sequence/);
  assert.doesNotMatch(bench.stdout, /run \d{8}T/, "nothing was recorded");
  // These one-step recordings of customer-crud do not match its current six steps: bench refuses before recording.
  const stale = cli(["bench", "http://127.0.0.1:9", "--oracle", "a.jsonl"], dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /2 oracle sequences were recorded from a different version of their template \(step count or methods differ\): customer-crud#1, customer-crud#2; re-record them/);
});

test("resolveTarget: the fully qualified api.stripe.com. is the sandbox too", () => {
  const key = process.env.STRIPE_API_KEY;
  process.env.STRIPE_API_KEY = "sk_test_x";
  try {
    assert.equal(resolveTarget("https://api.stripe.com.").name, "sandbox");
  } finally {
    if (key === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = key;
  }
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
    ["twin", "--bogus", "1"],
    ["twin", "extra"],
    ["score-twin"], // missing --oracle
    ["score-twin", "--oracle", "a.jsonl", "--templates", "no-such-template"],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^usage:$/m, args.join(" "));
  }
  const help = cli(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage:$/m);
  assert.match(help.stdout, /^  paritybench twin \[--port 12111\] \[--host 127\.0\.0\.1\]$/m);
  assert.match(help.stdout, /^  paritybench score-twin --oracle A\.jsonl /m);
});

test("twin: serves the twin until SIGTERM, then exits 0; error responses carry Parity-Error-Key", { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pb-twin-"));
  const child = spawn(process.execPath, [CLI, "twin", "--port", "0"], { cwd: dir, env: env(dir), stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  const [line] = (await once(createInterface({ input: child.stdout }), "line")) as [string];
  const url = /^parity twin listening on (http:\/\/127\.0\.0\.1:\d+) /.exec(line)?.[1];
  assert.ok(url, `unexpected first line: ${line}`);
  const res = await fetch(`${url}/v1/customers/cus_Missing1234567`, { headers: { Authorization: "Bearer sk_test_parity" } });
  assert.deepEqual([res.status, res.headers.get("parity-error-key")], [404, "resource_missing"]);
  await res.arrayBuffer();
  child.kill("SIGTERM");
  assert.deepEqual(await once(child, "exit"), [0, null]);
});

test("score-twin: replays the oracle against an in-process twin at each sequence's oracle clock; --templates, --json", { timeout: 30_000 }, async () => {
  // The oracle is the twin's own recording, subscription-create#1 at a Feb 1 clock and the rest at Mar 1; the twin's
  // recordings show which clock each replay ran at (the control below). customer-search waits 60 s before its search on
  // the sandbox: the timeout fails the test unless the wait is skipped.
  const FEB = "2026-02-01T00:00:00.000Z";
  const MAR = "2026-03-01T00:00:00.000Z";
  const clock = (seq: string) => (seq === "subscription-create#1" ? FEB : MAR);
  const seqs = buildCorpus(TEMPLATES.filter((x) => ["customer-crud", "customer-search", "subscription-create"].includes(x.name)), [1, 2]).map((q) => ({
    ...q,
    steps: q.steps.map(({ waitMs: _, ...step }) => step),
  }));
  const twin = createTwin();
  const server = await twin.listen(0);
  const target = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  const headersFor = (s: { id: string }) => ({ "Parity-Now": String(Date.parse(clock(s.id)) / 1000) });
  const { recordings } = await runCorpus(seqs, target, { concurrency: 2, runId: "oracle", headersFor }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  const oracle = recordings.map((r) => ({ ...r, startedAt: clock(r.seq), events: touching(idsIn(r.steps), twin.store.events) }));
  assert.ok(oracle.every((r) => r.events.length > 0));
  const dir = mkdtempSync(join(tmpdir(), "pb-score-"));
  writeJsonl(join(dir, "oracle.jsonl"), oracle);

  const r = await cliAsync(["score-twin", "--oracle", "oracle.jsonl", "--json", "out/score.json", "--recordings", "out/twin.jsonl"], dir);
  assert.match(r.stdout, /^# ParityBench: twin vs oracle\.jsonl$/m);
  assert.match(r.stdout, /^\*\*Summary:\*\* L1 100\.0% .* L4 100\.0% \[[\d.–]+\] \(6\)/m);
  assert.match(r.stderr, /^score-twin: 6 sequences, \d+ requests: twin [\d.]+ s, compare [\d.]+ s; wrote out\/score\.json$/m);
  const j = JSON.parse(readFileSync(join(dir, "out/score.json"), "utf8"));
  assert.deepEqual([j.target, j.normalization, j.score.overall.L4.k], ["twin", "v1.8", 6]);
  assert.ok(j.results.every((x: { eventsMatch: boolean; eventsSkipped: boolean }) => x.eventsMatch && !x.eventsSkipped), "the twin's events are compared");

  const only = await cliAsync(["score-twin", "--oracle", "oracle.jsonl", "--templates", "subscription-create,customer-crud"], dir);
  assert.match(only.stdout, /L4 100\.0% \[[\d.–]+\] \(4\)/);
  assert.doesNotMatch(only.stdout, /customer-search/);
  assert.match(only.stderr, /^score-twin: 4 sequences, \d+ requests: twin [\d.]+ s, compare [\d.]+ s$/m, "no --json, no file");
  assert.deepEqual(readdirSync(dir).sort(), ["oracle.jsonl", "out"]);

  // Control: the same oracle claiming a Mar 1 start for subscription-create#1 replays it at Mar 1. Its period end no
  // longer tells (28 days from Feb 1, 31 from Mar 1: normalization v1.6 and later render both <t:+1mo>), so the twin's own
  // recordings show the clock: the first object's `created` is the oracle's start.
  writeJsonl(join(dir, "moved.jsonl"), oracle.map((o) => ({ ...o, startedAt: MAR })));
  await cliAsync(["score-twin", "--oracle", "moved.jsonl", "--templates", "subscription-create", "--json", "moved.json", "--recordings", "moved-twin.jsonl"], dir);
  const moved = JSON.parse(readFileSync(join(dir, "moved.json"), "utf8"));
  assert.deepEqual(moved.results.map((x: { seq: string; L4: boolean }) => [x.seq, x.L4]), [["subscription-create#1", true], ["subscription-create#2", true]]);
  const startOf = (file: string, seq: string) => {
    const rec = readJsonl<Recording>(join(dir, file)).find((x) => x.seq === seq)!;
    const created = rec.steps.map((s) => (s.body as { created?: unknown }).created).find(Number.isInteger) as number;
    return new Date(Math.floor(created / 60) * 60_000).toISOString();
  };
  assert.deepEqual([startOf("out/twin.jsonl", "subscription-create#1"), startOf("moved-twin.jsonl", "subscription-create#1"), startOf("out/twin.jsonl", "subscription-create#2")], [FEB, MAR, MAR]);
  assert.equal(existsSync(join(dir, "recordings")), false, "score-twin writes no recordings");
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

test("bench against a URL target skips the templates' step waits (customer-search waits 60 s for the sandbox)", { timeout: 30_000 }, async () => {
  const [seq] = buildCorpus(TEMPLATES.filter((t) => t.name === "customer-search"), [1]);
  assert.deepEqual(seq!.steps.map((s) => s.waitMs), [undefined, 60_000]);
  assert.deepEqual(unwaited([seq!])[0]!.steps, seq!.steps.map(({ waitMs: _, ...s }) => s));
  assert.equal(seq!.steps[1]!.waitMs, 60_000, "the input keeps its waits");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url!.startsWith("/v1/events") ? { object: "list", has_more: false, data: [] } : { id: "cus_Local123456789", object: "customer", created: 1790000000 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = mkdtempSync(join(tmpdir(), "pb-wait-"));
    const body = { id: "cus_Oracle12345678", object: "customer", created: 1790000000 };
    writeJsonl(join(dir, "oracle.jsonl"), [{ ...rec("customer-search#1", body.id), steps: seq!.steps.map((s, i) => ({ i, method: s.method, path: s.path, status: 200, body, resHeaders: {}, ms: 1 })) }]);
    // With the wait, this run takes over 60 s and the test times out.
    const b = await cliAsync(["bench", `http://127.0.0.1:${(server.address() as AddressInfo).port}`, "--oracle", "oracle.jsonl", "--out", "bench"], dir);
    assert.match(b.stdout, /^1 sequences · L1 100\.0%/m);
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
