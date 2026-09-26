import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOracle, contaminated, dataDir } from "../src/bench/oracle.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import type { Recording } from "../src/types.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");
const DAY = 86_400_000;
const OLD = new Date(Date.now() - 10 * DAY).toISOString();
const NEW = new Date(Date.now() - 1 * DAY).toISOString();

const rec = (seq: string, startedAt: string, o: { status?: number; eventsError?: string; target?: string } = {}): Recording => ({
  seq,
  template: seq.split("#")[0]!,
  stratum: "lifecycle",
  seed: Number(seq.split("#")[1]),
  heldOut: false,
  target: o.target ?? "sandbox",
  runId: startedAt,
  startedAt,
  ms: 1,
  steps: [
    { i: 0, method: "POST", path: "/v1/customers", status: 200, body: {}, resHeaders: {}, ms: 1 },
    { i: 1, method: "GET", path: "/v1/customers/x", status: o.status ?? 200, body: {}, resHeaders: {}, ms: 1 },
  ],
  events: [],
  ...(o.eventsError ? { eventsError: o.eventsError } : {}),
});

/** A data dir with an old clean run, a newer run whose x#2/y#1/x#3 are contaminated, a twin run and a non-recording file. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pb-data-"));
  writeJsonl(join(dir, "runs", OLD.slice(0, 10), "w-old.jsonl"), [rec("x#1", OLD), rec("x#2", OLD), rec("y#1", OLD)]);
  writeJsonl(join(dir, "runs", NEW.slice(0, 10), "w-new.jsonl"), [
    rec("x#1", NEW),
    rec("x#2", NEW, { status: 429 }),
    rec("y#1", NEW, { eventsError: "GET /v1/events -> 500" }),
    rec("x#3", NEW, { status: 0 }),
  ]);
  writeJsonl(join(dir, "runs", NEW.slice(0, 10), "twin.jsonl"), [rec("x#1", new Date().toISOString(), { target: "twin" })]);
  writeFileSync(join(dir, "runs", NEW.slice(0, 10), "bench-twin.json"), "{}");
  return dir;
}

test("dataDir: PARITY_DATA_DIR, else ../parity-data beside the repo root if it exists, else <root>/recordings", () => {
  const base = mkdtempSync(join(tmpdir(), "pb-root-"));
  const root = join(base, "parity");
  mkdirSync(root);
  assert.equal(dataDir({ PARITY_DATA_DIR: "/tmp/x/../pd" }, root), "/tmp/pd");
  assert.equal(dataDir({ PARITY_DATA_DIR: "rel" }, root), resolve("rel"));
  assert.equal(dataDir({}, root), join(root, "recordings"));
  mkdirSync(join(base, "parity-data"));
  assert.equal(dataDir({}, root), join(base, "parity-data"));
  assert.equal(dataDir({ PARITY_DATA_DIR: "" }, root), join(base, "parity-data"));
});

test("contaminated: any step with status 0 or 429, or eventsError", () => {
  assert.equal(contaminated(rec("x#1", NEW)), false);
  assert.equal(contaminated(rec("x#1", NEW, { status: 404 })), false);
  assert.equal(contaminated(rec("x#1", NEW, { status: 429 })), true);
  assert.equal(contaminated(rec("x#1", NEW, { status: 0 })), true);
  assert.equal(contaminated(rec("x#1", NEW, { eventsError: "not collected" })), true);
});

test("buildOracle: newest clean sandbox recording per seq; contaminated never selected; --max-age-days filter", () => {
  const dir = fixture();
  const b = buildOracle(dir);
  assert.deepEqual(
    b.oracle.map((r) => [r.seq, r.startedAt]),
    [
      ["x#1", NEW],
      ["x#2", OLD], // the newer x#2 hit a 429
      ["y#1", OLD], // the newer y#1 has eventsError; x#3 has no clean recording at all
    ],
  );
  assert.deepEqual([b.files, b.sandbox, b.contaminated, b.tooOld], [3, 7, 3, 0]);

  const recent = buildOracle(dir, Date.now() - 5 * DAY);
  assert.deepEqual(recent.oracle.map((r) => [r.seq, r.startedAt]), [["x#1", NEW]]);
  assert.deepEqual([recent.contaminated, recent.tooOld], [3, 3]);
});

test("paritybench oracle build writes <dataDir>/oracle.jsonl and prints per-template counts and the date range", () => {
  const dir = fixture();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, "oracle", "build", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PARITY_DATA_DIR: dir } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJsonl<Recording>(join(dir, "oracle.jsonl")).map((x) => x.seq), ["x#1", "x#2", "y#1"]);
  assert.match(r.stdout, /^oracle: 3 sequences, .* from 7 sandbox recordings in 3 files; excluded 3 contaminated/m);
  assert.match(r.stdout, /^ {2}x 2$/m);
  assert.match(r.stdout, /^ {2}y 1$/m);
  assert.ok(r.stdout.includes(`oldest ${OLD} · newest ${NEW}`), r.stdout);

  const recent = run("--max-age-days", "5");
  assert.equal(recent.status, 0, recent.stderr);
  assert.match(recent.stdout, /^oracle: 1 sequences, .*, 3 older than 5 days$/m);
  assert.deepEqual(readJsonl<Recording>(join(dir, "oracle.jsonl")).map((x) => x.seq), ["x#1"]);

  const none = run("--max-age-days", "0.5");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no eligible sandbox recordings under .*runs \(7 scanned; excluded 3 contaminated .*, 4 older than 0\.5 days\)/);
});
