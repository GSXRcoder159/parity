import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, readLedger, rollingGets, type LedgerEntry } from "../src/bench/budget.ts";

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
