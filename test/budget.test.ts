import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowance, appendLedger, fittingPrefix, nightShare, projectedGets, readLedger, RESERVE, rollingGets, type LedgerEntry } from "../src/bench/budget.ts";
import type { Sequence } from "../src/types.ts";

const entry = (date: string, gets: number): LedgerEntry => ({
  date,
  account: "acct_test",
  target: "sandbox",
  runId: `run-${date}`,
  gets,
  posts: 1,
  deletes: 0,
  charges: 0,
});

test("rollingGets: sums GETs in [now - 30 d, now] across the 30-day boundary", () => {
  const entries = [
    entry("2026-09-24T23:59:59.999Z", 1000), // 1 ms older than 30 days: out
    entry("2026-09-25T00:00:00Z", 800), // exactly 30 days: in
    entry("2026-10-10T12:00:00Z", 300),
    entry("2026-10-25T00:00:00Z", 20), // now: in
    entry("2026-10-26T00:00:00Z", 5000), // after now: out
  ];
  assert.equal(rollingGets(entries, "2026-10-25T00:00:00Z"), 1120);
  assert.equal(rollingGets(entries, "2026-10-25T00:00:00.001Z"), 320); // the 800 ages out
  assert.equal(rollingGets(entries, "2026-10-25T00:00:00Z", 7), 20);
  assert.equal(rollingGets([], "2026-10-25T00:00:00Z"), 0);
  assert.throws(() => rollingGets([entry("yesterday", 1)], "2026-10-25T00:00:00Z"), /bad date yesterday/);
});

test("appendLedger appends JSONL counts only; readLedger reads them back, [] when absent", () => {
  const path = join(mkdtempSync(join(tmpdir(), "parity-")), "budget", "reads.jsonl");
  assert.deepEqual(readLedger(path), []);
  const a = entry("2026-09-25T00:00:00Z", 800);
  const b = entry("2026-09-26T08:00:00Z", 42);
  appendLedger(path, a);
  appendLedger(path, { ...b, body: { id: "cus_Secret" } } as LedgerEntry); // extra fields never reach the file
  assert.deepEqual(readLedger(path), [a, b]);
  assert.doesNotMatch(readFileSync(path, "utf8"), /cus_Secret/);
  assert.equal(rollingGets(readLedger(path), "2026-10-01T00:00:00Z"), 842);
});

/** `n` sequences of `gets` GET steps and one POST each. */
const seqs = (n: number, gets = 1): Sequence[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t#${i + 1}`, template: "t", stratum: "lifecycle", seed: i + 1, heldOut: false, steps: [{ method: "POST", path: "/v1/customers" }, ...Array.from({ length: gets }, () => ({ method: "GET" as const, path: "/v1/customers/$c.id" }))] }));

test("projectedGets: GET steps plus the event sweep, ceil(10.5 events/sequence / 100) x 5, which grows in steps, plus one list for the test-clock leak check", () => {
  assert.equal(projectedGets([]), 0);
  assert.equal(projectedGets(seqs(1, 2)), 2 + 5);
  assert.equal(projectedGets(seqs(9)), 9 + 5); // 94.5 events: one page
  assert.equal(projectedGets(seqs(10)), 10 + 10); // 105 events: two pages
  const clock = { ...seqs(1)[0]!, steps: [{ method: "POST" as const, path: "/v1/test_helpers/test_clocks" }] };
  assert.equal(projectedGets([clock, clock, ...seqs(2)]), 2 + 5 + 1, "one leak-check list, however many clocks");
});

test("allowance: min(one seventh's projection, floor((10,000 − 1,500 − rolling30) / 7)), never negative, at the budget's edges", () => {
  assert.equal(RESERVE, 1_500);
  assert.equal(nightShare(0), 1_214); // 8,500 / 7
  assert.equal(nightShare(3_726), 682); // the rolling total after the first real nightly
  assert.equal(nightShare(8_486), 2);
  assert.equal(nightShare(8_493), 1); // exactly 7 left
  assert.equal(nightShare(8_494), 0); // 6 left: less than a GET a night
  assert.equal(nightShare(8_500), 0); // the reserve reached
  assert.equal(nightShare(9_999), 0); // inside the reserve: 0, not negative
  assert.equal(nightShare(12_000), 0); // over the budget: 0, not negative
  assert.equal(allowance(203, 3_726), 203, "a full seventh when the budget has room");
  assert.equal(allowance(203, 7_500), 142, "the night's share when it is smaller");
  assert.equal(allowance(203, 8_494), 0);
});

test("fittingPrefix: the longest prefix whose projection fits, the sweep's step included", () => {
  const ten = seqs(10);
  assert.deepEqual([fittingPrefix(ten, 20).length, fittingPrefix(ten, 19).length], [10, 9], "the 10th sequence adds a sweep page: 20 GETs, not 15");
  assert.equal(fittingPrefix(ten, 14).length, 9);
  assert.equal(fittingPrefix(ten, 13).length, 8);
  assert.equal(fittingPrefix(ten, 6).length, 1);
  assert.equal(fittingPrefix(ten, 5).length, 0, "one sequence needs its GET and a sweep page");
  assert.equal(fittingPrefix(ten, 0).length, 0);
  assert.deepEqual(fittingPrefix(ten, 7).map((s) => s.id), ["t#1", "t#2"], "a prefix, in order");
});
