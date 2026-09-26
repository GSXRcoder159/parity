import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { sh, type Run } from "../src/align/assist.ts";
import { appendLog, logPath, verifyLog, type LogEntry } from "../src/align/log.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, touching } from "../src/bench/run.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { logMerged, nightly, nightlyText } from "../src/nightly.ts";
import { createTwin } from "../src/twin/server.ts";

// site/app.js is browser JS with no build step; a computed specifier keeps tsc from asking for its types.
const app = await import(new URL("../site/app.js", import.meta.url).href);

const REPO = resolve(import.meta.dirname, "..");
const ORACLE = { oracleSeqs: 1, oracleSha: "0".repeat(64) };
const GH_ARGS = ["pr", "list", "--state", "merged", "--json", "number,headRefName,mergedAt", "--limit", "200"];
const pr = (number: number, headRefName: string, mergedAt: string | null = "2026-10-03T12:00:00Z") => ({ number, headRefName, mergedAt });

/** `gh` answers with `prs` (and records its calls); every other command runs for real. */
const withGh = (prs: object[], calls: string[][] = []): Run => (cmd, args, cwd) => {
  if (cmd !== "gh") return sh(cmd, args, cwd);
  calls.push(args);
  return JSON.stringify(prs);
};

test("logMerged: each merged align/assisted-* PR is logged once across runs; open PRs and other branches are not", () => {
  const log = join(mkdtempSync(join(tmpdir(), "pb-merged-")), "align/log.jsonl");
  const calls: string[][] = [];
  const first = [pr(12, "align/assisted-2026-10-02-1"), pr(13, "align/assisted-2026-10-02-2", null), pr(14, "fix/readme"), pr(11, "align/assisted-2026-10-01-1"), pr(10, "x-align/assisted-2026-10-01-1")];
  assert.equal(logMerged({ repo: REPO, log, runId: "night-1", oracle: ORACLE, run: withGh(first, calls) }), 2);
  // The next night #13 has merged; #11 and #12 are listed again.
  const second = [...first.filter((p) => p.number !== 13), pr(13, "align/assisted-2026-10-02-2")];
  assert.equal(logMerged({ repo: REPO, log, runId: "night-2", oracle: ORACLE, run: withGh(second, calls) }), 1);
  assert.equal(logMerged({ repo: REPO, log, runId: "night-3", oracle: ORACLE, run: withGh(second, calls) }), 0);

  assert.deepEqual(calls, [GH_ARGS, GH_ARGS, GH_ARGS]);
  assert.deepEqual(verifyLog(log), { ok: true, entries: 3 });
  assert.deepEqual(
    readJsonl<LogEntry>(log).map((e) => [e.runId, e.kind, e.data.class, e.data.status, e.data.pr, e.data.branch]),
    [
      ["night-1", "patch", "assisted", "merged", 11, "align/assisted-2026-10-01-1"],
      ["night-1", "patch", "assisted", "merged", 12, "align/assisted-2026-10-02-1"],
      ["night-2", "patch", "assisted", "merged", 13, "align/assisted-2026-10-02-2"],
    ],
  );
});

test("nightly on a refusing sandbox: a missing key fails loudly; --dry-run writes nothing; recordings and ledger are pushed before a later failure; the real run scores the existing oracle, aligns, notes drift, publishes a point the page reads, commits and pushes both repos (parity first); the next night annotates only what is new and replaces a same-date point", { timeout: 180_000 }, async () => {
  // Oracle and noise pair: two back-to-back recordings of the twin itself (as "sandbox") over three strata, one held out;
  // `extra` (seed 3) is a later run that grows the oracle before the second night.
  const three = TEMPLATES.filter((t) => ["customer-crud", "refund-full", "invalid-params"].includes(t.name));
  const seqs = buildCorpus(three, [1, 2]);
  const twin = createTwin();
  const server = await twin.listen(0);
  const target = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  const pair: Record<string, unknown[]> = {};
  try {
    for (const [side, runId, s] of [["a", "20260927T070000-aaaa", seqs], ["b", "20260927T071000-bbbb", seqs], ["extra", "20261004T120000-cccc", buildCorpus(three, [3])]] as const) {
      const { recordings } = await runCorpus(s, target, { concurrency: 4, runId });
      pair[side] = recordings.map((r) => ({ ...r, events: touching(idsIn(r.steps), twin.store.events) }));
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }

  const tmp = mkdtempSync(join(tmpdir(), "pb-nightly-"));
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const init = (dir: string) => {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
  };
  // The data repo, with a bare origin to push to, and a surface-added entry logged since the last score entry.
  const data = join(tmp, "parity-data");
  writeJsonl(join(data, "runs/2026-09-27/noise-a-20260927T070000-aaaa.jsonl"), pair.a!);
  writeJsonl(join(data, "runs/2026-09-27/noise-b-20260927T071000-bbbb.jsonl"), pair.b!);
  appendLog(logPath(data), "manual", [
    { kind: "score", data: { label: "day-0", oracle: ORACLE } },
    { kind: "patch", data: { class: "automatic", status: "applied", commit: "0".repeat(40), oracle: ORACLE } }, // a manual align --apply
    { kind: "patch", data: { class: "surface-added", status: "applied", note: "test clocks", oracle: ORACLE } },
  ]);
  // The data repo's read ledger (it names the account): the gate counts it (dated yesterday by the wall clock: the gate's
  // 30-day window ends at the real now, not at the pipeline's `now`).
  writeJsonl(join(data, "budget/reads.jsonl"), [{ date: new Date(Date.now() - 86_400_000).toISOString(), account: "acct_legacy00000000", target: "sandbox", runId: "old", gets: 5, posts: 0, deletes: 0, charges: 0 }]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(tmp, "origin.git")]);
  init(data);
  git(data, "remote", "add", "origin", join(tmp, "origin.git"));
  git(data, "add", ".");
  git(data, "commit", "-q", "-m", "init");
  git(data, "push", "-q", "-u", "origin", "main");
  // The parity repo: the twin's code, with its own bare origin (the nightly pushes it, before the data repo).
  const repo = join(tmp, "parity");
  for (const p of ["src", "templates", "package.json"]) cpSync(join(REPO, p), join(repo, p), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(tmp, "parity-origin.git")]);
  init(repo);
  git(repo, "remote", "add", "origin", join(tmp, "parity-origin.git"));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");

  const logBefore = readFileSync(logPath(data), "utf8");
  const heads = () => [git(repo, "rev-parse", "HEAD"), git(data, "rev-parse", "HEAD")];
  const clean = () => [git(repo, "status", "--porcelain"), git(data, "status", "--porcelain")];
  const PRS = [pr(7, "align/assisted-2026-10-02-1"), pr(8, "align/assisted-2026-10-03-1", null), pr(9, "docs/typo")];
  const now = () => new Date("2026-10-04T07:00:00Z"); // a Sunday: slice 0/7 and the noise pair's day

  // The sandbox refuses: a read budget of 0 stops the recording at the budget gate, before any request.
  const saved = { key: process.env.STRIPE_API_KEY, budget: process.env.PARITY_READ_BUDGET };
  process.env.STRIPE_API_KEY = "sk_test_never_sent";
  process.env.PARITY_READ_BUDGET = "0";
  try {
    const [head0, dataHead0] = heads();
    // (b) Only a sandbox refusal is a degraded night: a missing key fails the run, before anything is written.
    delete process.env.STRIPE_API_KEY;
    await assert.rejects(nightly({ repo, dataDir: data, env: {}, run: withGh(PRS), now }), /^Error: STRIPE_API_KEY is not set/);
    assert.deepEqual([heads(), clean(), readFileSync(logPath(data), "utf8")], [[head0, dataHead0], ["", ""], logBefore]);
    process.env.STRIPE_API_KEY = "sk_test_never_sent";

    const dry = await nightly({ repo, dataDir: data, dryRun: true, env: {}, run: withGh(PRS), now });
    assert.deepEqual(heads(), [head0, dataHead0], "a dry run commits nothing");
    assert.deepEqual(clean(), ["", ""], "a dry run writes nothing in either repo");
    assert.equal(readFileSync(logPath(data), "utf8"), logBefore);
    assert.ok(dry.tmp && existsSync(join(dry.tmp, "parity/site/data/curve.json")) && existsSync(join(dry.tmp, "parity-data/align/log.jsonl")));
    assert.equal(dry.slice.refused, undefined, "a dry run never reaches the sandbox");
    assert.match(nightlyText(dry), /DRY RUN: nothing recorded, applied, assisted, committed or pushed/);

    // (c) A night that fails after recording (here gh, at step 5) has already pushed tonight's run files and read-ledger
    // entries: the refused slice wrote no run file, so here an uncommitted run file stands in for one.
    const late = "runs/2026-10-03/late-20261003T070000-dddd.jsonl";
    writeJsonl(join(data, late), pair.b!);
    const ghDown: Run = (cmd, args, cwd) => {
      if (cmd === "gh") throw new Error("gh: injected outage");
      return sh(cmd, args, cwd);
    };
    await assert.rejects(nightly({ repo, dataDir: data, env: {}, run: ghDown, now }), /gh: injected outage/);
    const origin = (...args: string[]) => git(tmp, "--git-dir", join(tmp, "origin.git"), ...args);
    assert.match(origin("log", "-1", "--format=%s", "main"), /^nightly 2026-10-04 run \S+: recordings and read ledger$/);
    assert.deepEqual(origin("show", "--name-only", "--format=", "main").split("\n"), [late]);
    assert.equal(git(repo, "rev-parse", "HEAD"), head0, "it failed before publishing anything");

    const gh: string[][] = [];
    const r = await nightly({ repo, dataDir: data, env: {}, run: withGh(PRS, gh), now });
    const text = nightlyText(r);

    // Step 1 refused at the budget gate: noted, the noise pair not attempted, the oracle not refreshed.
    assert.match(r.slice.refused ?? "", /^refusing to run: 5 sandbox GETs in the last 30 days \+ \d+ projected for this run = \d+ > read budget 0 \(/);
    assert.ok(r.slice.refused!.includes(`(${join(data, "budget/reads.jsonl")}; `), "the gate reads the data repo's ledger");
    const corpus = TEMPLATES.length * 20; // slice 0/7: indices 0, 7, 14, …
    assert.deepEqual([r.slice.spec, r.slice.seqs, r.slice.recorded], ["0/7", Math.ceil(corpus / 7), 0]);
    assert.deepEqual(r.noisePair, { seqs: TEMPLATES.length * 2, recorded: false });
    assert.equal(r.oracleRefreshed, false);
    assert.equal(r.oracle.oracleSeqs, 6);
    assert.match(text, /^slice 0\/7: \d+ sequences · NOT RECORDED: refusing to run/m);
    assert.match(text, /NOT refreshed tonight \(curve point oracleRefreshed: false\)/);

    // The sealed log: the refusal, the score (with the noise floor), align's gate, assist skipped, one merged PR, drift.
    assert.deepEqual(gh, [GH_ARGS]);
    assert.ok(verifyLog(logPath(data)).ok);
    const mine = readJsonl<LogEntry>(logPath(data)).filter((e) => e.runId === r.runId);
    const at = (kind: string, key: string) => mine.filter((e) => e.kind === kind && key in e.data).map((e) => e.data[key]);
    assert.deepEqual(
      at("note", "nightly").map((n) => ({ ...(n as object), error: "…" })),
      [{ date: "2026-10-04", step: "record slice 0/7", error: "…", oracleRefreshed: false }],
    );
    const scored = mine.filter((e) => e.kind === "score");
    assert.equal(scored.length, 1);
    assert.deepEqual((scored[0]!.data.noise as { pair: string[] }).pair, ["2026-09-27/noise-a-20260927T070000-aaaa.jsonl", "2026-09-27/noise-b-20260927T071000-bbbb.jsonl"]);
    assert.equal(scored[0]!.data.oracleRefreshed, false);
    assert.equal(mine.filter((e) => e.kind === "gate").length, 1);
    assert.match(String((at("note", "assist")[0] as { skipped: string }).skipped), /ANTHROPIC_API_KEY is not set/);
    assert.deepEqual(at("patch", "pr"), [7]);
    assert.deepEqual(at("note", "drift"), [{ date: "2026-10-04", compared: 0, withheld: 0, reason: "no clean slice recording tonight with a previous recording to compare" }]);

    // The public files: a point with oracleRefreshed false, the surface-added annotation (not counted), the merged PR.
    const site = (f: string) => JSON.parse(readFileSync(join(repo, "site/data", f), "utf8"));
    const curve = site("curve.json");
    assert.equal(curve.length, 1);
    const pt = curve[0];
    // The failed night left a nightly score entry but never published: its surface-added entry is annotated here.
    // patches: sealed-log totals since the freeze, the manual --apply included.
    assert.deepEqual([pt.date, pt.normalization, pt.oracleRefreshed, pt.oracleSeqs, pt.events, pt.patches, pt.sample], ["2026-10-04", "v1.3", false, 6, ["surface-added: test clocks"], { automatic: 1, assisted: 1 }, undefined]);
    assert.deepEqual(pt.noise.coverage, { seqs: 6, oracleSeqs: 6, templates: 3, oracleTemplates: 3, strata: ["errors", "lifecycle", "refunds"], inSample: false });
    assert.deepEqual(r.events, pt.events);
    assert.match(text, /^curve annotations: surface-added: test clocks$/m);
    assert.deepEqual(Object.keys(pt.noise.byStratum).sort(), ["errors", "lifecycle", "refunds"]);
    const scores = site("scores/2026-10-04.json");
    assert.deepEqual(Object.keys(scores.byStratum), ["errors", "lifecycle", "refunds"]);
    assert.deepEqual([scores.byStratum.errors.train.L1.n, scores.byStratum.lifecycle.heldOut.L1.n], [0, 0], "invalid-params is held out, customer-crud is train");
    assert.ok(scores.byStratum.errors.heldOut.L1.n > 0 && scores.byStratum.lifecycle.train.L1.n > 0);
    assert.ok(scores.overall.noise && scores.byStratum.refunds.noise);
    assert.equal(existsSync(join(repo, "drift")), false, "nothing to report: no drift file");

    // The page reads them: a ceiling on every stratum and an automation series.
    const d = await app.load(async (url: string) => (existsSync(join(repo, "site", url)) ? JSON.parse(readFileSync(join(repo, "site", url), "utf8")) : null));
    assert.equal(d.sample, false);
    assert.equal(d.scores.date, "2026-10-04");
    for (const k of ["all", "errors", "lifecycle", "refunds"]) {
      const [row] = app.series(d.curve, k);
      assert.ok(row.ceiling.L3 !== null && row.ceiling.L4 !== null, `${k} has a ceiling`);
      assert.ok(row.L3.n > 0);
    }
    assert.deepEqual(app.automation(d.curve), [{ date: "2026-10-04", events: [], automatic: 1, assisted: 1, share: 0.5 }]);

    // Public-safe: no ids, no values' telltales, no fraud or risk fields.
    for (const f of ["curve.json", "scores/2026-10-04.json"]) {
      const s = readFileSync(join(repo, "site/data", f), "utf8");
      assert.doesNotMatch(s, /\b[a-z]+_[A-Za-z0-9]{10,}\b|@example|outcome|risk_|sk_test/, f);
    }

    // Step 8: both repos committed and pushed; here, exactly the public files committed, the tree left clean.
    const [head1, dataHead1] = heads();
    assert.notEqual(dataHead1, dataHead0);
    assert.equal(git(tmp, "--git-dir", join(tmp, "origin.git"), "rev-parse", "main"), dataHead1, "the data repo was pushed");
    assert.equal(git(tmp, "--git-dir", join(tmp, "parity-origin.git"), "rev-parse", "main"), head1, "this repo was pushed");
    assert.deepEqual(r.commits, { data: dataHead1, parity: head1 });
    assert.deepEqual(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n"), ["site/data/curve.json", "site/data/scores/2026-10-04.json"], "no ledger here: it names the account");
    assert.ok(git(data, "log", "--name-only", "--format=").split("\n").includes("budget/reads.jsonl"), "the read ledger is committed in the data repo");
    assert.match(git(repo, "log", "-1", "--format=%s"), /^nightly 2026-10-04: curve point and scores \(train L3 [\d.]+%, held-out L3 [\d.]+%; noise ceiling L3 [\d.]+%; oracle not refreshed\)$/);
    assert.deepEqual(clean(), ["", ""]);
    assert.deepEqual(readdirSync(join(data, "runs")).sort(), ["2026-09-27", "2026-10-03"], "a refused recording writes no run file");

    // (d) and "annotated once": the next night, after a surface-added entry and a run that grows the oracle 6 -> 9.
    appendLog(logPath(data), "manual", [{ kind: "patch", data: { class: "surface-added", status: "applied", note: "proration", oracle: ORACLE } }]);
    writeJsonl(join(data, "runs/2026-10-04/extra-20261004T120000-cccc.jsonl"), pair.extra!);
    const r2 = await nightly({ repo, dataDir: data, env: {}, run: withGh(PRS), now: () => new Date("2026-10-05T07:00:00Z") });
    assert.equal(r2.oracle.oracleSeqs, 9);
    assert.deepEqual(r2.patches, { automatic: 1, assisted: 1 }, "totals: nothing counted twice");
    const curve2 = site("curve.json");
    assert.deepEqual(curve2.map((p: { date: string; oracleSeqs: number; events: string[] }) => [p.date, p.oracleSeqs, p.events]), [
      ["2026-10-04", 6, ["surface-added: test clocks"]],
      ["2026-10-05", 9, ["surface-added: proration", "oracle expanded: 6→9"]],
    ]);
    const d2 = await app.load(async (url: string) => (existsSync(join(repo, "site", url)) ? JSON.parse(readFileSync(join(repo, "site", url), "utf8")) : null));
    assert.deepEqual(app.series(d2.curve, "all").map((row: { events: string[] }) => row.events), [["surface-added: test clocks"], ["surface-added: proration", "oracle expanded: 6→9"]]);
    assert.deepEqual(readJsonl<LogEntry>(logPath(data)).filter((e) => e.kind === "publish").map((e) => [e.data.date, e.data.events]), [["2026-10-04", curve2[0].events], ["2026-10-05", curve2[1].events]]);
    assert.deepEqual(curve2[1].noise.coverage, { seqs: 6, oracleSeqs: 9, templates: 3, oracleTemplates: 3, strata: ["errors", "lifecycle", "refunds"], inSample: false });
    assert.deepEqual(clean(), ["", ""]);

    // A second run on the same date replaces that date's point.
    await nightly({ repo, dataDir: data, env: {}, run: withGh(PRS), now: () => new Date("2026-10-05T09:00:00Z") });
    assert.deepEqual(site("curve.json").map((p: { date: string }) => p.date), ["2026-10-04", "2026-10-05"]);
    assert.deepEqual(clean(), ["", ""]);
  } finally {
    for (const [k, v] of [["STRIPE_API_KEY", saved.key], ["PARITY_READ_BUDGET", saved.budget]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
