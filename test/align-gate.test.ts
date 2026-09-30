import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { sh } from "../src/align/assist.ts";
import { applyEdits, gate, gatePaired, nodeImage, scoreTwinIn, type Eval, type Run } from "../src/align/gate.ts";
import { align, planText } from "../src/align/index.ts";
import { logPath, verifyLog, type LogEntry } from "../src/align/log.ts";
import type { Candidate, Edit } from "../src/align/patch.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, touching } from "../src/bench/run.ts";
import { wilson, type LevelScores } from "../src/bench/score.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { createTwin } from "../src/twin/server.ts";
import { fakeDocker } from "./fake-docker.ts";

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

test("gatePaired (the assisted gate): a code change is judged with the data edits gated on top of it, from its own score", () => {
  const own = ["s#1|0|$.cb", "s#2|0|$.cb"]; // the locus's divergences
  const exposed = ["s#1|0|$.cb.mode", "s#2|0|$.cb.mode"]; // a template field the code change's object brings along
  const other = "o#1|0|$.x";
  const ev = (ids: string[]): Eval => ({ train: levels(100 - ids.length), heldOut: levels(10), trainDivergences: ids.length, ids: new Set(ids) });
  const before = ev([...own, other]);
  const code = ev([...exposed, other]); // 3 -> 3: the single-edit rule rejects the change alone
  const mode = cand("src/twin/shapes/cb.json", "/mode", exposed);
  const p = gatePaired(before, code, [mode], fake([...exposed, other], { "/mode": { fixes: exposed } }).evaluate, own, []);
  assert.equal(p.pass, true);
  assert.deepEqual(p.data.accepted.map((j) => [j.candidate.pointer, j.before.trainDivergences, j.after.trainDivergences]), [["/mode", 3, 1]], "the data edit is gated from the code change's score");
  assert.deepEqual([p.data.before.trainDivergences, p.data.after.trainDivergences, [...p.data.final.ids]], [3, 1, [other]]);
  // No data edit: the change alone fails. A data edit that drops held-out L3 is rejected as in the mechanical gate, so
  // the combination fails too.
  assert.equal(gatePaired(before, code, [], fake([...exposed, other], {}).evaluate, own, []).pass, false);
  const dropping = gatePaired(before, code, [mode], fake([...exposed, other], { "/mode": { fixes: exposed, heldOut: -1 } }).evaluate, own, []);
  assert.deepEqual([dropping.pass, dropping.data.rejected.length], [false, 1]);
  // The combination must remove one of the locus's own divergences, not only fall.
  const elsewhere = cand("src/twin/shapes/o.json", "/x", [other]);
  assert.equal(gatePaired(before, before, [elsewhere], fake([...own, other], { "/x": { fixes: [other] } }).evaluate, own, []).pass, false);
});

test("gatePaired: the plan's own edits (accepted but unapplied, or not gated) are never paired, so they cannot carry a change that makes train worse", () => {
  // PR #4 fix round 1: baseline 7 (2 of the locus's own + 5 pre-existing, each fixable by an edit the plan accepted on
  // HEAD but did not apply); the code change removes one of its own and adds 3 non-mechanical ones: 7 -> 9.
  const own = ["s#1|0|$.cb", "s#2|0|$.cb"];
  const pre = [1, 2, 3, 4, 5].map((i) => `p#${i}|0|$.p${i}`);
  const added = [1, 2, 3].map((i) => `n#${i}|0|$.n`);
  const ev = (ids: string[]): Eval => ({ train: levels(100 - ids.length), heldOut: levels(10), trainDivergences: ids.length, ids: new Set(ids) });
  const before = ev([...own, ...pre]);
  const code = ev([own[1]!, ...pre, ...added]);
  const plan = pre.map((id, i) => cand("src/twin/shapes/p.json", `/p${i + 1}`, [id]));
  const effects = Object.fromEntries(plan.map((c) => [c.pointer, { fixes: c.ids }]));
  // Unfiltered, the 5 unrelated edits bring the bundle to 4 < 7 and it would pass.
  assert.deepEqual([gatePaired(before, code, plan, fake([own[1]!, ...pre, ...added], effects).evaluate, own, []).pass], [true]);
  const { evaluate, calls } = fake([own[1]!, ...pre, ...added], effects);
  const p = gatePaired(before, code, plan, evaluate, own, plan);
  assert.deepEqual([p.pass, p.data.accepted.length, p.data.final.trainDivergences, calls], [false, 0, 9, []], "the plan's edits are never evaluated, and 9 > 7 fails");
  // Matched by file, pointer, op and value: the same pointer with another value is the change's to gate.
  const other = { ...plan[0]!, value: 2 };
  const q = fake([own[1]!, ...pre, ...added], effects);
  gatePaired(before, code, [other], q.evaluate, own, plan);
  assert.deepEqual(q.calls, [["/p1"]]);
});

test("scoreTwinIn: the score-twin child (gate and assisted pass) gets PATH, HOME and CI only, and reads only its copy and the oracle", () => {
  // A stand-in repo whose src/cli.ts writes its env, and what it could read and write, where score-twin writes its JSON
  // (--json is the last argument).
  const repo = mkdtempSync(join(tmpdir(), "pb-child-env-"));
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "templates"));
  writeFileSync(join(repo, "package.json"), '{ "type": "module" }\n');
  const secret = join(repo, "secret.txt"); // outside the copy: like the data repo, or a checkout's .git/config
  writeFileSync(secret, "token\n");
  writeFileSync(join(repo, "oracle.jsonl"), "{}\n");
  const probe = (expr: string) => `(() => { try { return ${expr}; } catch (e) { return String(e.code); } })()`;
  writeFileSync(
    join(repo, "src/cli.ts"),
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const oracle = process.argv[process.argv.indexOf(\"--oracle\") + 1]!;",
      `const reads = { oracle: ${probe("readFileSync(oracle, 'utf8')")}, secret: ${probe(`readFileSync(${JSON.stringify(secret)}, 'utf8')`)}, write: ${probe(`writeFileSync(${JSON.stringify(join(repo, "planted.txt"))}, 'x')`)} };`,
      "writeFileSync(process.argv.at(-1)!, JSON.stringify({ score: { env: process.env, reads }, results: [] }));",
    ].join("\n"),
  );
  const set = { ANTHROPIC_API_KEY: "sk-ant-leak", GH_TOKEN: "ghp_leak", STRIPE_API_KEY: "sk_test_leak", PARITY_DATA_TOKEN: "github_pat_leak", PARITY_LLM_MODEL: "x", PARITY_DATA_DIR: "/data", CI: "1", NODE_OPTIONS: "--no-warnings" };
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    const { env, reads } = scoreTwinIn(repo, join(repo, "oracle.jsonl"), []).json.score as unknown as { env: Record<string, string>; reads: Record<string, string | undefined> };
    const kept = Object.keys(process.env).filter((k) => ["PATH", "HOME", "CI"].includes(k));
    // macOS itself adds __CF_USER_TEXT_ENCODING (a locale code) to every process it starts.
    assert.deepEqual(Object.keys(env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort(), kept.sort());
    assert.deepEqual([env.CI, env.PATH], ["1", process.env.PATH]);
    for (const k of ["ANTHROPIC_API_KEY", "GH_TOKEN", "STRIPE_API_KEY", "PARITY_DATA_TOKEN", "PARITY_DATA_DIR", "NODE_OPTIONS"]) assert.equal(env[k], undefined, k);
    assert.deepEqual(reads, { oracle: "{}\n", secret: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED" });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("scoreTwinIn with docker (the assisted pass): exactly this container: no network, read-only root and inputs, one writable output dir, no host env; a docker failure throws, never a fallback", () => {
  const repo = mkdtempSync(join(tmpdir(), "pb-child-docker-"));
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "templates"));
  writeFileSync(join(repo, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(repo, "oracle.jsonl"), "{}\n");
  writeFileSync(join(repo, "src/cli.ts"), 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[process.argv.indexOf("--json") + 1]!, JSON.stringify({ score: { argv: process.argv.slice(2) }, results: [] }));\n');
  const calls: string[][] = [];
  const cmds: string[] = [];
  const run: Run = (cmd, args) => (cmds.push(cmd), fakeDocker(calls)(args));
  const { json } = scoreTwinIn(repo, join(repo, "oracle.jsonl"), [], false, run);
  assert.deepEqual(cmds, ["docker"]);
  const [args] = calls;
  const root = args![args!.indexOf("-v") + 1]!.split(":")[0]!;
  const image = /^FROM\s+(\S+)/m.exec(readFileSync(join(REPO, "Dockerfile"), "utf8"))![1]!;
  assert.match(image, /^node:22-alpine@sha256:[0-9a-f]{64}$/);
  assert.equal(nodeImage(), image, "the Dockerfile's pinned image");
  assert.deepEqual(args, [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", `${process.getuid!()}:${process.getgid!()}`,
    "-v", `${root}:/parity:ro`, "-v", `${realpathSync(join(repo, "oracle.jsonl"))}:/oracle.jsonl:ro`, "-v", `${root}/out:/out`, "-w", "/parity",
    image, "node", "src/cli.ts", "score-twin", "--oracle", "/oracle.jsonl", "--json", "/out/score.json",
  ]);
  assert.ok(root.startsWith(realpathSync(tmpdir())) && root !== repo, "a temp copy is mounted, never the repo");
  assert.ok(!args!.some((a) => /^(-e|--env|--env-file|--privileged|--network=host)$/.test(a)), "no host env, no privileges");
  assert.deepEqual((json.score as unknown as { argv: string[] }).argv.slice(0, 1), ["score-twin"]);

  // docker cannot start (or the container fails): the error surfaces, and nothing runs on the host instead.
  const down: Run = () => {
    throw Object.assign(new Error("Command failed: docker run"), { stderr: "Cannot connect to the Docker daemon" });
  };
  assert.throws(() => scoreTwinIn(repo, join(repo, "oracle.jsonl"), [], false, down), /^Error: gate: score-twin failed in its container: Cannot connect to the Docker daemon$/);
});

const dockerOk = (() => {
  try {
    return spawnSync("docker", ["image", "inspect", nodeImage()], { stdio: "ignore", timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
})();

test("scoreTwinIn in the real container (docker and the pinned image present): the same score as the host child, and no network inside", { skip: !dockerOk && "docker or the pinned node image is not available", timeout: 180_000 }, async () => {
  const CLOCK = "2026-03-01T00:00:00.000Z";
  const seqs = buildCorpus(TEMPLATES.filter((t) => ["customer-crud", "refund-full", "subscription-cancel-at-period-end"].includes(t.name)), [1]);
  const twin = createTwin();
  const server = await twin.listen(0);
  const target = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  const { recordings } = await runCorpus(seqs, target, { concurrency: 2, runId: "oracle", headersFor: () => ({ "Parity-Now": String(Date.parse(CLOCK) / 1000) }) }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  const oracle = join(mkdtempSync(join(tmpdir(), "pb-docker-")), "oracle.jsonl");
  writeJsonl(oracle, recordings.map((r) => ({ ...r, startedAt: CLOCK, events: touching(idsIn(r.steps), twin.store.events) })));
  const host = scoreTwinIn(REPO, oracle, [], true);
  const boxed = scoreTwinIn(REPO, oracle, [], true, sh);
  assert.deepEqual(boxed.json.score, host.json.score);
  assert.equal(boxed.twin!.length, seqs.length);
  assert.ok(boxed.json.score.overall.L1.n > 0);
  // --network none: even a DNS lookup fails inside.
  const probe = "require('node:dns').lookup('example.com', (e) => process.stdout.write(e ? e.code : 'resolved'))";
  assert.match(sh("docker", ["run", "--rm", "--network", "none", nodeImage(), "node", "-e", probe], REPO), /^E[A-Z_]+$/);
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
  assert.match(viaCli.stdout, /^gate: 1 score-twin runs after the baseline · accepted 1 · blocked-by-code 0 · rejected 0$/m);
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

  // --apply refuses a dirty data file, and any uncommitted change the gate would score but the commit would not carry.
  for (const f of ["src/twin/shapes/customer.json", "src/twin/resources/customers.ts", "templates/index.ts"]) {
    writeFileSync(join(repo, f), readFileSync(join(repo, f), "utf8") + " ");
    assert.throws(() => align({ repo, dataDir: data, runId: "dirty", apply: true }), new RegExp(`^Error: refusing --apply: uncommitted changes in src/, templates/ or package\\.json:\\nM ${f}$`));
    git("checkout", "--", f);
  }

  // Nothing is written when the sealed log is broken, and nothing is logged when the commit fails (files restored).
  const customerJson = readFileSync(join(repo, "src/twin/shapes/customer.json"), "utf8");
  mkdirSync(join(data, "align"));
  writeFileSync(logPath(data), JSON.stringify({ ts: "t", runId: "r", kind: "note", data: { oracle: { oracleSeqs: 1, oracleSha: "x" } }, prev: "", hash: "edited" }) + "\n");
  assert.throws(() => align({ repo, dataDir: data, runId: "broken", apply: true }), /refusing --apply: the sealed log is broken: .*line 1: hash does not match/);
  rmSync(logPath(data));
  const hooks = mkdtempSync(join(tmpdir(), "pb-align-hooks-"));
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git("config", "core.hooksPath", hooks);
  assert.throws(() => align({ repo, dataDir: data, runId: "no-commit", apply: true }), /Command failed: git .* commit/);
  git("config", "--unset", "core.hooksPath");
  assert.equal(existsSync(logPath(data)), false, "a failed commit logs nothing");
  assert.equal(readFileSync(join(repo, "src/twin/shapes/customer.json"), "utf8"), customerJson);
  assert.equal(git("status", "--porcelain"), "");
  // A failed append after the commit names the commit and how to undo it; the command it gives restores the tree.
  chmodSync(join(data, "align"), 0o555);
  assert.throws(() => align({ repo, dataDir: data, runId: "no-log", apply: true }), /commit [0-9a-f]{40} landed but the sealed log append failed; undo the commit \(git reset --soft HEAD~1 && git checkout HEAD -- src\/twin\/shapes\/customer\.json\)/);
  chmodSync(join(data, "align"), 0o755);
  git("reset", "--soft", "HEAD~1");
  git("checkout", "HEAD", "--", "src/twin/shapes/customer.json");
  assert.deepEqual([git("log", "--format=%s"), git("status", "--porcelain"), existsSync(logPath(data))], ["init", "", false]);

  const done = align({ repo, dataDir: data, runId: "run-apply", apply: true });
  assert.equal(JSON.parse(readFileSync(join(repo, "src/twin/shapes/customer.json"), "utf8")).tax_exempt, "reverse");
  assert.match(git("log", "-1", "--format=%B"), /^align: 1 automatic patches \(train Δ -\d+ divergences, L3 \+[\d.]+ pts; held-out Δ L3 \+[\d.]+ pts\)\n\nSealed log run run-apply /);
  assert.equal(done.applied?.commit, git("rev-parse", "HEAD"));
  assert.equal(git("status", "--porcelain"), "");
  const log = readJsonl<LogEntry>(logPath(data));
  assert.deepEqual(verifyLog(logPath(data)), { ok: true, entries: 2 });
  assert.deepEqual(log.map((e) => [e.kind, e.runId, e.data.class, e.data.status]), [["patch", "run-apply", "automatic", "applied"], ["gate", "run-apply", undefined, undefined]]);
  assert.deepEqual(log[0]!.data.edit, { file: "src/twin/shapes/customer.json", pointer: "/tax_exempt", op: "set", value: "reverse" });
  assert.deepEqual(log.map((e) => e.data.commit), [done.applied?.commit, done.applied?.commit], "every entry names the commit that landed its patch");
  assert.equal(log[0]!.data.oracle.oracleSeqs, oracle.length);
});
