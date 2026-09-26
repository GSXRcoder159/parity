import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { applyEdits, gate, type Eval } from "../src/align/gate.ts";
import { align, planText } from "../src/align/index.ts";
import { logPath, verifyLog, type LogEntry } from "../src/align/log.ts";
import type { Candidate, Edit } from "../src/align/patch.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, touching } from "../src/bench/run.ts";
import { wilson, type LevelScores } from "../src/bench/score.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { createTwin } from "../src/twin/server.ts";

const REPO = resolve(import.meta.dirname, "..");
const levels = (l3: number): LevelScores => ({ L1: wilson(100, 100), L2: wilson(50, 100), L3: wilson(l3, 100), L4: wilson(0, 10) });
const cand = (file: string, pointer: string, ids: string[]): Candidate => ({
  file,
  pointer,
  op: "set",
  value: 1,
  evidence: { occurrences: ids.length, seqs: [] },
  locus: { kind: "field", objectType: "x", fieldPath: pointer.slice(1) },
  ids,
});

/** Fake scores over the train divergences `pool`: each edit removes its `fixes`, adds `worse` more, moves held-out L3 by `heldOut`. */
function fake(pool: string[], effects: Record<string, { fixes: string[]; worse?: number; heldOut?: number }>) {
  const calls: string[][] = [];
  const evaluate = (edits: Edit[]): Eval => {
    calls.push(edits.map((e) => e.pointer));
    const fixed = new Set(edits.flatMap((e) => effects[e.pointer]!.fixes));
    const ids = new Set(pool.filter((id) => !fixed.has(id)));
    const worse = edits.reduce((n, e) => n + (effects[e.pointer]!.worse ?? 0), 0);
    const ho = 10 + edits.reduce((n, e) => n + (effects[e.pointer]!.heldOut ?? 0), 0);
    return { train: levels(100 - ids.size), heldOut: levels(ho), trainDivergences: ids.size + worse, ids };
  };
  return { evaluate, calls };
}

test("gate: accepts a batch whose every edit helps; bisects a failing batch to the held-out drop; no-op edits are blocked-by-code", () => {
  const A = "src/twin/shapes/a.json";
  const B = "src/twin/shapes/b.json";
  const C = "src/twin/errors.json";
  const cands = [
    cand(A, "/a1", ["s#1|0|$.a1"]),
    cand(A, "/a2", ["s#1|0|$.a2", "s#2|0|$.a2"]),
    cand(B, "/b1", ["s#1|0|$.b1"]),
    cand(B, "/b2", ["s#1|0|$.b2"]),
    cand(B, "/b3", ["s#1|0|$.b3"]),
    cand(B, "/b4", ["s#1|0|$.b4"]),
    cand(C, "/c1", ["s#1|0|$.c1"]),
    cand(C, "/c2", ["s#1|0|$.c2"]),
  ];
  const pool = [...cands.flatMap((c) => c.ids), "other#1|0|$.x"];
  const { evaluate, calls } = fake(pool, {
    "/a1": { fixes: ["s#1|0|$.a1"] },
    "/a2": { fixes: ["s#1|0|$.a2", "s#2|0|$.a2"] },
    "/b1": { fixes: ["s#1|0|$.b1"], heldOut: -1 }, // helps train, drops held-out L3
    "/b2": { fixes: ["s#1|0|$.b2"] },
    "/b3": { fixes: [] }, // a handler computes the field: no effect
    "/b4": { fixes: ["s#1|0|$.b4"] },
    "/c1": { fixes: ["s#1|0|$.c1"], worse: 2 }, // removes its divergence, adds two elsewhere
    "/c2": { fixes: ["s#1|0|$.c2"], worse: 1 }, // removes one, adds one: the train count does not strictly fall
  });
  const g = gate(cands, evaluate);
  const ptr = (js: { candidate: Candidate }[]) => js.map((j) => j.candidate.pointer);
  assert.deepEqual(ptr(g.accepted), ["/b2", "/b4", "/a1", "/a2"]);
  assert.deepEqual(ptr(g.rejected), ["/b1", "/c1", "/c2"]);
  assert.deepEqual(ptr(g.blocked), ["/b3"]);
  // Batches heaviest first (b: 4 divergences, a: 3, c: 2); b splits into the edits that removed their divergences and b3, then halves.
  assert.deepEqual(calls, [
    [],
    ["/b1", "/b2", "/b3", "/b4"],
    ["/b1", "/b2", "/b4"],
    ["/b1", "/b2"],
    ["/b1"],
    ["/b2"],
    ["/b2", "/b4"],
    ["/b2", "/b4", "/b3"],
    ["/b2", "/b4", "/a1", "/a2"],
    ["/b2", "/b4", "/a1", "/a2", "/c1", "/c2"],
    ["/b2", "/b4", "/a1", "/a2", "/c1"],
    ["/b2", "/b4", "/a1", "/a2", "/c2"],
  ]);
  assert.equal(g.evaluations, calls.length);
  assert.deepEqual([g.before.trainDivergences, g.after.trainDivergences, g.after.heldOut.L3.k], [10, 5, 10]);
  const b4 = g.accepted.find((j) => j.candidate.pointer === "/b4")!;
  assert.deepEqual([b4.before.trainDivergences, b4.after.trainDivergences], [9, 8], "before/after scores of the batch that accepted it");

  const capped = gate(cands, fake(pool, Object.fromEntries(cands.map((c) => [c.pointer, { fixes: c.ids }]))).evaluate, { maxBatches: 1 });
  assert.deepEqual([ptr(capped.accepted), capped.notGated.map((c) => c.pointer)], [["/b1", "/b2", "/b3", "/b4"], ["/a1", "/a2", "/c1", "/c2"]]);
});

test("applyEdits: JSON-pointer set/delete in shapes (2-space JSON) and errors.json (one entry per line, round-trips byte for byte)", () => {
  const root = mkdtempSync(join(tmpdir(), "pb-edits-"));
  cpSync(join(REPO, "src/twin/errors.json"), join(root, "src/twin/errors.json"));
  writeFileSync(join(root, "s.json"), JSON.stringify({ a: { b: 1 }, n: null, "x/y": 2 }, null, 2) + "\n");
  const e = (file: string, pointer: string, op: "set" | "delete", value?: unknown): Edit => ({ file, pointer, op, value, evidence: { occurrences: 1, seqs: [] } });
  applyEdits(root, [e("src/twin/errors.json", "/nope/code", "delete")]);
  assert.equal(readFileSync(join(root, "src/twin/errors.json"), "utf8"), readFileSync(join(REPO, "src/twin/errors.json"), "utf8"));
  applyEdits(root, [
    e("s.json", "/a/c", "set", { d: [1] }),
    e("s.json", "/n/deep", "set", "v"), // a null parent becomes an object
    e("s.json", "/x~1y", "delete"),
    e("s.json", "/missing/k", "delete"),
    e("src/twin/errors.json", "/card_declined/message", "set", "Your card was declined."),
    e("src/twin/errors.json", "/card_declined/code", "delete"),
  ]);
  assert.equal(readFileSync(join(root, "s.json"), "utf8"), JSON.stringify({ a: { b: 1, c: { d: [1] } }, n: { deep: "v" } }, null, 2) + "\n");
  const errors = readFileSync(join(root, "src/twin/errors.json"), "utf8");
  assert.match(errors, /^ {2}"card_declined": \{ "status": 402, "type": "card_error", "message": "Your card was declined\." \},$/m);
  assert.equal(errors.split("\n").length, readFileSync(join(REPO, "src/twin/errors.json"), "utf8").split("\n").length);
});

test("align end to end: a value the oracle shows at every train occurrence is proposed, gated in a temp copy, applied, logged and committed", { timeout: 60_000 }, async () => {
  // Oracle: the twin's own recording of customer-crud (train) and subscription-cancel-at-period-end (held out), with
  // every customer's tax_exempt changed to "reverse", a value no template holds (so this stays true after align runs).
  const CLOCK = "2026-03-01T00:00:00.000Z";
  const seqs = buildCorpus(TEMPLATES.filter((t) => ["customer-crud", "subscription-cancel-at-period-end"].includes(t.name)), [1, 2]);
  const twin = createTwin();
  const server = await twin.listen(0);
  const target = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  const { recordings } = await runCorpus(seqs, target, { concurrency: 2, runId: "oracle", headersFor: () => ({ "Parity-Now": String(Date.parse(CLOCK) / 1000) }) }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  const reverse = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(reverse)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (v as { object?: string }).object === "customer" && k === "tax_exempt" ? "reverse" : reverse(x)]))
        : v;
  const oracle = recordings.map((r) => ({ ...r, startedAt: CLOCK, events: touching(idsIn(r.steps), twin.store.events), steps: r.steps.map((s) => ({ ...s, body: reverse(s.body) })) }));
  assert.notEqual(JSON.parse(readFileSync(join(REPO, "src/twin/shapes/customer.json"), "utf8")).tax_exempt, "reverse");
  assert.ok(oracle.some((r) => r.heldOut) && oracle.some((r) => !r.heldOut));

  const data = mkdtempSync(join(tmpdir(), "pb-align-data-"));
  writeJsonl(join(data, "oracle.jsonl"), oracle);
  // The CLI: flags, and the plan (no --apply) against this repo; nothing is written.
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "src/cli.ts"), "align", ...args], { cwd: data, env: { ...process.env, PARITY_DATA_DIR: data }, encoding: "utf8" });
  for (const bad of [["--bogus"], ["--max-batches", "0"], ["extra"], ["--max-batches"]]) assert.equal(cli(...bad).status, 2, bad.join(" "));
  const viaCli = cli("--max-batches", "5");
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.match(viaCli.stdout, /^gate: 1 score-twin runs · accepted 1 · blocked-by-code 0 · rejected 0$/m);
  assert.match(viaCli.stdout, /^plan only: --apply writes the 1 accepted edits, logs them and commits$/m);

  const repo = mkdtempSync(join(tmpdir(), "pb-align-repo-"));
  for (const p of ["src", "templates", "package.json"]) cpSync(join(REPO, p), join(repo, p), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const plan = align({ repo, dataDir: data, runId: "run-plan" });
  const accepted = plan.gate.accepted.map((j) => [j.candidate.file, j.candidate.pointer, j.candidate.op, j.candidate.value]);
  assert.deepEqual(accepted, [["src/twin/shapes/customer.json", "/tax_exempt", "set", "reverse"]]);
  assert.deepEqual([plan.gate.blocked, plan.gate.rejected], [[], []]);
  assert.equal(plan.gate.after.trainDivergences, 0);
  assert.ok(plan.gate.before.trainDivergences > 0);
  assert.ok(plan.gate.after.heldOut.L3.k > plan.gate.before.heldOut.L3.k, "the held-out customers match too");
  assert.equal(plan.applied, undefined);
  assert.match(planText(plan), /^accepted:\n {2}src\/twin\/shapes\/customer\.json \/tax_exempt set "reverse" · /m);
  assert.equal(git("status", "--porcelain"), "", "the plan writes nothing");

  writeFileSync(join(repo, "src/twin/shapes/customer.json"), readFileSync(join(repo, "src/twin/shapes/customer.json"), "utf8") + " ");
  assert.throws(() => align({ repo, dataDir: data, runId: "dirty", apply: true }), /refusing --apply: uncommitted changes/);
  git("checkout", "--", "src/twin/shapes/customer.json");

  const done = align({ repo, dataDir: data, runId: "run-apply", apply: true });
  assert.equal(JSON.parse(readFileSync(join(repo, "src/twin/shapes/customer.json"), "utf8")).tax_exempt, "reverse");
  assert.match(git("log", "-1", "--format=%B"), /^align: 1 automatic patches \(train Δ -\d+ divergences, L3 \+[\d.]+ pts; held-out Δ L3 \+[\d.]+ pts\)\n\nSealed log run run-apply /);
  assert.equal(done.applied?.commit, git("rev-parse", "HEAD"));
  assert.equal(git("status", "--porcelain"), "");
  const log = readJsonl<LogEntry>(logPath(data));
  assert.deepEqual(verifyLog(logPath(data)), { ok: true, entries: 2 });
  assert.deepEqual(log.map((e) => [e.kind, e.runId, e.data.class, e.data.status]), [["patch", "run-apply", "automatic", "applied"], ["gate", "run-apply", undefined, undefined]]);
  assert.deepEqual(log[0]!.data.edit, { file: "src/twin/shapes/customer.json", pointer: "/tax_exempt", op: "set", value: "reverse" });
  assert.equal(log[0]!.data.oracle.oracleSeqs, oracle.length);
});
