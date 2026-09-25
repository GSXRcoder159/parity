import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetRefusal, newRunId } from "../src/cli.ts";
import type { LedgerEntry } from "../src/bench/budget.ts";
import { writeJsonl } from "../src/jsonl.ts";
import type { Recording } from "../src/types.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");
// A fresh cwd per call: no .env is loaded and nothing lands in the repo.
const cli = (args: string[], cwd = mkdtempSync(join(tmpdir(), "pb-cli-"))) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

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
  assert.equal(nj.normalization, "v1.1");
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
    ["bench", "--oracle", "a.jsonl"], // missing <baseURL>
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
  assert.equal(budgetRefusal([], 10_001, now, 10_000) !== null, true);
});

test("runId: UTC YYYYMMDDTHHMMSS plus 4 random base36 chars", () => {
  const id = newRunId(new Date("2026-09-25T07:08:09.123Z"));
  assert.match(id, /^20260925T070809-[0-9a-z]{4}$/);
  assert.notEqual(newRunId(), newRunId()); // 1 in 1.7M chance of a false failure within the same second
});
