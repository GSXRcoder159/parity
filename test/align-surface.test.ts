import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { logPath, provenance, verifyLog, type LogEntry } from "../src/align/log.ts";
import { surface, surfaceText } from "../src/align/surface.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, touching } from "../src/bench/run.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { createTwin } from "../src/twin/server.ts";

const REPO = resolve(import.meta.dirname, "..");

test("align surface: usage errors exit 2 before any scoring", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "src/cli.ts"), "align", ...args], { encoding: "utf8" });
  for (const bad of [["surface"], ["surface", "--note", " "], ["surface", "--note", "x", "--apply"], ["surface", "extra", "--note", "x"], ["--note", "x"], ["--commit", "HEAD"]]) {
    const r = cli(...bad);
    assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
  }
});

test("align surface: scores <commit>^ and the working tree on the oracle, logs one surface-added patch entry, prints the deltas", { timeout: 60_000 }, async () => {
  // Oracle: the twin's own recording of customer-crud (train) and subscription-cancel-at-period-end (held out), with every
  // customer's tax_exempt changed to "reverse". The "surface" commit makes the twin answer "reverse".
  const CLOCK = "2026-03-01T00:00:00.000Z";
  const seqs = buildCorpus(TEMPLATES.filter((t) => ["customer-crud", "subscription-cancel-at-period-end"].includes(t.name)), [1]);
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
  const data = mkdtempSync(join(tmpdir(), "pb-surface-data-"));
  writeJsonl(join(data, "oracle.jsonl"), recordings.map((r) => ({ ...r, startedAt: CLOCK, events: touching(idsIn(r.steps), twin.store.events), steps: r.steps.map((s) => ({ ...s, body: reverse(s.body) })) })));

  // History: init -> the surface commit -> an unrelated later commit (HEAD). --commit names the surface commit.
  const repo = mkdtempSync(join(tmpdir(), "pb-surface-repo-"));
  for (const p of ["src", "templates", "package.json"]) cpSync(join(REPO, p), join(repo, p), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const shape = join(repo, "src/twin/shapes/customer.json");
  writeFileSync(shape, JSON.stringify({ ...JSON.parse(readFileSync(shape, "utf8")), tax_exempt: "reverse" }, null, 2) + "\n");
  git("commit", "-q", "-am", "surface: customer tax_exempt");
  const commit = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "NOTES.md"), "later\n");
  git("add", "NOTES.md");
  git("commit", "-q", "-m", "later");
  const head = git("rev-parse", "HEAD");

  // The twin's inputs must be committed; the refusal comes before any scoring or logging.
  writeFileSync(join(repo, "src/twin/billing.ts"), readFileSync(join(repo, "src/twin/billing.ts"), "utf8") + "\n");
  assert.throws(() => surface({ repo, dataDir: data, runId: "dirty", note: "x", commit }), /^Error: refusing align surface: uncommitted changes in src\/twin\/, templates\/ or package\.json:\nM src\/twin\/billing\.ts$/);
  git("checkout", "--", "src/twin/billing.ts");

  const s = surface({ repo, dataDir: data, runId: "run-surface", note: "customer tax_exempt", commit });
  assert.deepEqual([s.commit, s.head], [commit, head]);
  assert.ok(s.before.trainDivergences > 0 && s.after.trainDivergences < s.before.trainDivergences, `train divergences ${s.before.trainDivergences} -> ${s.after.trainDivergences}`);
  assert.ok(s.after.heldOut.L3.k > s.before.heldOut.L3.k, "the held-out customer matches too");
  assert.equal(git("status", "--porcelain"), "", "the repo is untouched");

  // The entry: the one shape nightly reads (class surface-added, note), with scores before and after and provenance.
  assert.deepEqual(verifyLog(logPath(data)), { ok: true, entries: 1 });
  const [e] = readJsonl<LogEntry>(logPath(data));
  assert.deepEqual([e!.kind, e!.runId], ["patch", "run-surface"]);
  assert.deepEqual(e!.data, { class: "surface-added", status: "applied", note: "customer tax_exempt", commit, head, before: s.before, after: s.after, oracle: provenance(join(data, "oracle.jsonl")) });
  assert.deepEqual(Object.keys(s.before), ["train", "heldOut", "trainDivergences"]);

  const text = surfaceText(s);
  assert.match(text, new RegExp(`^before \\(${commit.slice(0, 12)}\\^\\): train L1 `, "m"));
  assert.match(text, new RegExp(`^after \\(working tree at ${head.slice(0, 12)}\\): train L1 `, "m"));
  assert.match(text, new RegExp(`^delta: train L1 [+-][\\d.]+ L2 [+-][\\d.]+ L3 \\+[\\d.]+ L4 [+-][\\d.]+ pts \\(-${s.before.trainDivergences - s.after.trainDivergences} divergences\\) · held-out L1 `, "m"));
});
