import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, logPath, provenance, verifyLog, type LogEntry } from "../src/align/log.ts";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-log-"));
  writeFileSync(join(dir, "oracle.jsonl"), '{"seq":"a#1"}\n{"seq":"a#2"}\n');
  return { dir, file: logPath(dir), oracle: provenance(join(dir, "oracle.jsonl")) };
};
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

test("log: entries chain by sha256(prev + JSON(data) + ts + kind), carry oracle provenance, and verify", () => {
  const { dir, file, oracle } = setup();
  assert.deepEqual(oracle, { oracleSeqs: 2, oracleSha: createHash("sha256").update('{"seq":"a#1"}\n{"seq":"a#2"}\n').digest("hex") });
  assert.deepEqual(verifyLog(file), { ok: true, entries: 0 }, "no log yet is an empty, valid chain");
  const [a] = appendLog(file, "run1", [{ kind: "score", data: { l3: 0.031, oracle } }], "2026-09-26T00:00:00.000Z");
  const [b, c] = appendLog(file, "run2", [
    { kind: "patch", data: { class: "automatic", edit: { file: "src/twin/shapes/customer.json", pointer: "/tax_exempt", op: "set", value: "none" }, oracle } },
    { kind: "gate", data: { accepted: 1, oracle } },
  ]);
  assert.equal(file, join(dir, "align", "log.jsonl"));
  assert.equal(a!.prev, "");
  assert.equal(a!.hash, createHash("sha256").update(`${JSON.stringify({ l3: 0.031, oracle })}2026-09-26T00:00:00.000Zscore`).digest("hex"));
  assert.deepEqual([b!.prev, c!.prev], [a!.hash, b!.hash]);
  assert.deepEqual(lines(file).map((l) => (JSON.parse(l) as LogEntry).runId), ["run1", "run2", "run2"]);
  assert.deepEqual(verifyLog(file), { ok: true, entries: 3 });
  assert.throws(() => appendLog(file, "run3", [{ kind: "note", data: {} as never }]), /without oracle provenance/);
});

test("log: an edited, removed or reordered entry breaks the chain, and appending to a broken chain is refused", () => {
  const { file, oracle } = setup();
  appendLog(file, "r", ["score", "patch", "gate"].map((kind) => ({ kind: kind as "score", data: { n: kind, oracle } })));
  const good = lines(file);
  const check = (ls: string[], why: RegExp) => {
    writeFileSync(file, ls.join("\n") + "\n");
    const v = verifyLog(file);
    assert.equal(v.ok, false);
    assert.match((v as { error: string }).error, why);
  };
  check([good[0]!, good[1]!.replace('"n":"patch"', '"n":"patched"'), good[2]!], /line 2: hash does not match/);
  check([good[0]!, good[2]!], /line 2: prev is not the previous entry's hash/);
  check([good[1]!, good[0]!, good[2]!], /line 1: prev/);
  // Rewriting an entry and its own hash still breaks the next entry's prev.
  const e = JSON.parse(good[1]!) as LogEntry;
  e.data.n = "patched";
  e.hash = createHash("sha256").update(e.prev + JSON.stringify(e.data) + e.ts + e.kind).digest("hex");
  check([good[0]!, JSON.stringify(e), good[2]!], /line 3: prev/);
  assert.throws(() => appendLog(file, "r", [{ kind: "note", data: { oracle } }]), /refusing to append to a broken log/);
  writeFileSync(file, good.join("\n") + "\n");
  assert.equal(verifyLog(file).ok, true);
});
