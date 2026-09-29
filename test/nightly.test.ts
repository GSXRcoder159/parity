import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { sh, type Run } from "../src/align/assist.ts";
import { appendLog, logPath, verifyLog, type LogEntry } from "../src/align/log.ts";
import { nightShare, projectedGets } from "../src/bench/budget.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, touching } from "../src/bench/run.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { ceilingText, changelog, logMerged, nightly, nightlyCommand, nightlyText, removedTotals } from "../src/nightly.ts";
import { NORMALIZATION_VERSION } from "../src/bench/normalize.ts";
import { createTwin } from "../src/twin/server.ts";
import type { Recording } from "../src/types.ts";

// site/app.js is browser JS with no build step; a computed specifier keeps tsc from asking for its types.
const app = await import(new URL("../site/app.js", import.meta.url).href);

const REPO = resolve(import.meta.dirname, "..");
/** The nightly's corpus seeds (src/nightly.ts CORPUS_SEEDS). */
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
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

test("ceilingText: the public commit message names a pair's coverage, and a pair missing a template is no ceiling", () => {
  const L3 = { p: 0.95, lo: 0.9, hi: 0.98, k: 57, n: 60 };
  const noise = { seqs: 60, overall: { L1: L3, L2: L3, L3, L4: L3 } };
  assert.equal(ceilingText(undefined, 88, false), "no noise pair");
  assert.equal(ceilingText({ ...noise, seqs: 88 }, 88, true), "noise ceiling L3 95.0%");
  assert.equal(ceilingText(noise, 88, true), "noise ceiling L3 95.0% (the pair covers 60 of 88 sequences)");
  assert.equal(ceilingText(noise, 88, false), "no whole-corpus noise ceiling (the pair covers 60 of 88 sequences: L3 95.0% on those)");
});

test("changelog: automatic patches per gate batch, merged PRs joined with their proposal, surface-added with its delta; fraud or risk pointers counted, never named", () => {
  const log = join(mkdtempSync(join(tmpdir(), "pb-changelog-")), "align/log.jsonl");
  const n = (d: number) => ({ trainDivergences: d });
  const auto = (file: string, pointer: string, before: number, after: number) => ({ kind: "patch" as const, data: { class: "automatic", status: "applied", commit: "c1", edit: { file, pointer, op: "set", value: "SECRET_VALUE" }, gate: { before: n(before), after: n(after) }, oracle: ORACLE } });
  appendLog(log, "run-1", [auto("a.json", "/x", 100, 90), auto("a.json", "/radar_options", 100, 90), auto("a.json", "/y", 100, 90), auto("a.json", "/z", 90, 88), auto("b.json", "/w", 88, 80), { kind: "gate", data: { oracle: ORACLE } }], "2026-10-01T07:00:00.000Z");
  appendLog(log, "run-2", [{ kind: "patch", data: { class: "assisted", status: "proposed", branch: "align/assisted-2026-10-02-1", pr: "https://github.com/x/y/pull/7", file: "src/twin/resources/customers.ts", gate: { before: n(80), after: n(71) }, oracle: ORACLE } }], "2026-10-02T07:00:00.000Z");
  appendLog(log, "run-3", [
    { kind: "patch", data: { class: "assisted", status: "merged", pr: 7, branch: "align/assisted-2026-10-02-1", mergedAt: "2026-10-03T12:00:00Z", oracle: ORACLE } },
    { kind: "patch", data: { class: "surface-added", status: "applied", note: "invoices", commit: "c2", before: n(71), after: n(75), oracle: ORACLE } },
  ], "2026-10-04T07:00:00.000Z");
  const rows = changelog(log);
  assert.deepEqual(rows, [
    { date: "2026-10-01", class: "automatic", file: "a.json", pointers: ["/x", "/y"], withheld: 1, commit: "c1", divergencesRemoved: 10 },
    { date: "2026-10-01", class: "automatic", file: "a.json", pointers: ["/z"], commit: "c1", divergencesRemoved: 2 },
    { date: "2026-10-01", class: "automatic", file: "b.json", pointers: ["/w"], commit: "c1", divergencesRemoved: 8 },
    { date: "2026-10-03", class: "assisted", pr: 7, file: "src/twin/resources/customers.ts", divergencesRemoved: 9 },
    { date: "2026-10-04", class: "surface-added", note: "invoices", commit: "c2", divergencesRemoved: -4 },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_VALUE|radar/);
  assert.deepEqual(removedTotals(rows), { automatic: 20, assisted: 9 }, "surface-added counts as neither");
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
    assert.match(origin("log", "-1", "--format=%s", "main"), /^nightly 2026-10-04 run \S+: recordings, read ledger and rotation cursor$/);
    assert.deepEqual(origin("show", "--name-only", "--format=", "main").split("\n"), [late]);
    assert.equal(git(repo, "rev-parse", "HEAD"), head0, "it failed before publishing anything");

    const gh: string[][] = [];
    const r = await nightly({ repo, dataDir: data, env: {}, run: withGh(PRS, gh), now });
    const text = nightlyText(r);
    // The pair's age on a night: days since its older side (noise-a) was recorded, rounded up.
    const pairAge = (night: string) => Math.max(0, Math.ceil((Date.parse(night) - Math.min(...(pair.a as Recording[]).map((x) => Date.parse(x.startedAt)))) / 86_400_000));

    // Step 1 refused at the budget gate: noted, the noise pair not attempted, the oracle not refreshed.
    assert.match(r.slice.refused ?? "", /^refusing to run: 5 sandbox GETs in the last 30 days \+ \d+ projected for this run = \d+ > read budget 0 \(/);
    assert.ok(r.slice.refused!.includes(`(${join(data, "budget/reads.jsonl")}; `), "the gate reads the data repo's ledger");
    // No rotation cursor yet: a Sunday's window starts at slice 0/7 (indices 0, 7, 14, …), a full seventh within the allowance.
    const corpus = TEMPLATES.length * 20;
    assert.deepEqual([r.slice.spec, r.slice.seqs, r.slice.recorded], [`0+${Math.ceil(corpus / 7)}/${corpus}`, Math.ceil(corpus / 7), 0]);
    const seventh = projectedGets(buildCorpus(TEMPLATES, SEEDS).filter((_, i) => i % 7 === 0));
    assert.ok(seventh < 1_213);
    assert.equal(r.slice.allowance, seventh, "min(one seventh, floor((10000 − 1500 − 5 GETs) / 7) = 1213)");
    assert.deepEqual(r.noisePair, { seqs: TEMPLATES.length * 2, recorded: false });
    assert.equal(r.oracleRefreshed, false);
    assert.equal(r.oracle.oracleSeqs, 6);
    assert.ok(text.includes(`\nslice 0+${Math.ceil(corpus / 7)}/${corpus}: ${Math.ceil(corpus / 7)} sequences · NOT RECORDED: refusing to run`), text);
    assert.equal(existsSync(join(data, "budget/rotation.json")), false, "a refused slice leaves the cursor where it was");
    assert.match(text, /NOT refreshed tonight \(curve point oracleRefreshed: false\)/);

    // The sealed log: the refusal, the score (with the noise floor), align's gate, assist skipped, one merged PR, drift.
    assert.deepEqual(gh, [GH_ARGS]);
    assert.ok(verifyLog(logPath(data)).ok);
    const mine = readJsonl<LogEntry>(logPath(data)).filter((e) => e.runId === r.runId);
    const at = (kind: string, key: string) => mine.filter((e) => e.kind === kind && key in e.data).map((e) => e.data[key]);
    assert.deepEqual(
      at("note", "nightly").map((n) => ({ ...(n as object), error: "…" })),
      [{ date: "2026-10-04", step: `record slice 0+${Math.ceil(corpus / 7)}/${corpus}`, error: "…", oracleRefreshed: false }],
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
    assert.deepEqual([pt.date, pt.normalization, pt.method, pt.oracleRefreshed, pt.oracleSeqs, pt.events, pt.patches, pt.sample], ["2026-10-04", NORMALIZATION_VERSION, "m2", false, 6, ["surface-added: test clocks"], { automatic: 1, assisted: 1 }, undefined]);
    assert.ok(Number.isInteger(pt.oracleMaxAgeDays) && pt.oracleMaxAgeDays === r.oracleMaxAgeDays);
    assert.equal(site("scores/2026-10-04.json").method, "m2");
    // Train divergences removed per class: the fixture's manual apply and merged PR carry no gate counts.
    assert.deepEqual([pt.divergencesRemoved, r.divergencesRemoved], [{ automatic: 0, assisted: 0 }, { automatic: 0, assisted: 0 }]);
    assert.match(text, /^merged align\/assisted-\* PRs newly logged: 1 · since the scaffold freeze \(sealed log\): patches automatic 1 \(JSON-pointer edits\), assisted 1 \(merged PRs\); train divergences removed automatic 0, assisted 0$/m);
    assert.equal(mine.find((e) => e.kind === "score")!.data.method, "m2");
    assert.deepEqual(pt.noise.coverage, { seqs: 6, oracleSeqs: 6, templates: 3, oracleTemplates: 3, strata: ["errors", "lifecycle", "refunds"], inSample: false, maxAgeDays: pairAge("2026-10-04T07:00:00Z") });
    assert.equal(r.noise?.maxAgeDays, pairAge("2026-10-04T07:00:00Z"));
    assert.match(text, new RegExp(`^noise ceiling: .* \\(6 of 6 oracle sequences; at most ${r.noise!.maxAgeDays} days old\\)$`, "m"));
    assert.deepEqual(r.events, pt.events);
    assert.match(text, /^curve annotations: surface-added: test clocks$/m);
    assert.deepEqual(Object.keys(pt.noise.byStratum).sort(), ["errors", "lifecycle", "refunds"]);
    const scores = site("scores/2026-10-04.json");
    assert.deepEqual(scores.noiseCoverage, pt.noise.coverage);
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
    assert.deepEqual(app.automation(d.curve), [{ date: "2026-10-04", events: [], automatic: 1, assisted: 1, share: 0.5, removed: { automatic: 0, assisted: 0, share: null } }]);

    // The changelog: the sealed log's patch entries in log order, merged PRs by number, no values.
    assert.deepEqual(site("changelog.json"), [
      { date: new Date().toISOString().slice(0, 10), class: "automatic", pointers: [], commit: "0".repeat(40) },
      { date: new Date().toISOString().slice(0, 10), class: "surface-added", note: "test clocks" },
      { date: "2026-10-03", class: "assisted", pr: 7 },
    ]);

    // Public-safe: no ids, no values' telltales, no fraud or risk fields.
    for (const f of ["curve.json", "scores/2026-10-04.json", "changelog.json"]) {
      const s = readFileSync(join(repo, "site/data", f), "utf8");
      assert.doesNotMatch(s, /\b[a-z]+_[A-Za-z0-9]{10,}\b|@example|outcome|risk_|sk_test/, f);
    }

    // Step 8: both repos committed and pushed; here, exactly the public files committed, the tree left clean.
    const [head1, dataHead1] = heads();
    assert.notEqual(dataHead1, dataHead0);
    assert.equal(git(tmp, "--git-dir", join(tmp, "origin.git"), "rev-parse", "main"), dataHead1, "the data repo was pushed");
    assert.equal(git(tmp, "--git-dir", join(tmp, "parity-origin.git"), "rev-parse", "main"), head1, "this repo was pushed");
    assert.deepEqual(r.commits, { data: dataHead1, parity: head1 });
    assert.deepEqual(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n"), ["site/data/changelog.json", "site/data/curve.json", "site/data/scores/2026-10-04.json"], "no ledger here: it names the account");
    assert.ok(git(data, "log", "--name-only", "--format=").split("\n").includes("budget/reads.jsonl"), "the read ledger is committed in the data repo");
    assert.match(git(repo, "log", "-1", "--format=%s"), /^nightly 2026-10-04: curve point and scores \(train L3 [\d.]+%, held-out L3 [\d.]+%; noise ceiling L3 [\d.]+%; oracle not refreshed\)$/);
    assert.deepEqual(clean(), ["", ""]);
    assert.deepEqual(readdirSync(join(data, "runs")).sort(), ["2026-09-27", "2026-10-03"], "a refused recording writes no run file");

    // (d) and "annotated once": the next night, after a surface-added entry and a run that grows the oracle 6 -> 9.
    appendLog(logPath(data), "manual", [{ kind: "patch", data: { class: "surface-added", status: "applied", note: "proration", oracle: ORACLE } }]);
    writeJsonl(join(data, "runs/2026-10-04/extra-20261004T120000-cccc.jsonl"), pair.extra!);
    // The first point as a pre-m2 night under normalization v1.4 wrote it (no `method`): the next point annotates both
    // method changes, and the page shows the normalization one once (not again as its own "normalization vX" label).
    const curveFile = join(repo, "site/data/curve.json");
    writeFileSync(curveFile, JSON.stringify(JSON.parse(readFileSync(curveFile, "utf8")).map(({ method: _, ...p }: { method: string }) => ({ ...p, normalization: "v1.4" })), null, 2) + "\n");
    const r2 = await nightly({ repo, dataDir: data, env: {}, run: withGh(PRS), now: () => new Date("2026-10-05T07:00:00Z") });
    assert.equal(r2.oracle.oracleSeqs, 9);
    assert.deepEqual(r2.patches, { automatic: 1, assisted: 1 }, "totals: nothing counted twice");
    const curve2 = site("curve.json");
    assert.deepEqual(curve2.map((p: { date: string; oracleSeqs: number; events: string[] }) => [p.date, p.oracleSeqs, p.events]), [
      ["2026-10-04", 6, ["surface-added: test clocks"]],
      ["2026-10-05", 9, ["surface-added: proration", "oracle expanded: 6→9", "method change: causal event order", `method change: normalization ${NORMALIZATION_VERSION}`]],
    ]);
    const d2 = await app.load(async (url: string) => (existsSync(join(repo, "site", url)) ? JSON.parse(readFileSync(join(repo, "site", url), "utf8")) : null));
    assert.deepEqual(app.series(d2.curve, "all").map((row: { events: string[] }) => row.events), [["surface-added: test clocks"], ["surface-added: proration", "oracle expanded: 6→9", "method change: causal event order", `method change: normalization ${NORMALIZATION_VERSION}`]]);
    assert.deepEqual(readJsonl<LogEntry>(logPath(data)).filter((e) => e.kind === "publish").map((e) => [e.data.date, e.data.events]), [["2026-10-04", curve2[0].events], ["2026-10-05", curve2[1].events]]);
    assert.deepEqual(curve2[1].noise.coverage, { seqs: 6, oracleSeqs: 9, templates: 3, oracleTemplates: 3, strata: ["errors", "lifecycle", "refunds"], inSample: false, maxAgeDays: pairAge("2026-10-05T07:00:00Z") });
    // The public commit message never prints the pair's number without its coverage.
    assert.match(git(repo, "log", "-1", "--format=%s"), /; noise ceiling L3 [\d.]+% \(the pair covers 6 of 9 sequences\); oracle not refreshed\)$/);
    assert.deepEqual(clean(), ["", ""]);

    // A second run on the same date replaces that date's point and keeps its annotations (deduplicated), adding the new ones.
    appendLog(logPath(data), "manual", [{ kind: "patch", data: { class: "surface-added", status: "applied", note: "invoices", oracle: ORACLE } }]);
    // The replaced point as an m1 run of that date would have left it: the rerun under m2 annotates the switch.
    writeFileSync(
      curveFile,
      JSON.stringify(JSON.parse(readFileSync(curveFile, "utf8")).map(({ method, ...p }: { date: string; method: string; events: string[] }) => (p.date === "2026-10-05" ? { ...p, events: p.events.filter((e) => !e.startsWith("method")) } : { method, ...p })), null, 2) + "\n",
    );
    const r3 = await nightly({ repo, dataDir: data, env: {}, run: withGh(PRS), now: () => new Date("2026-10-05T09:00:00Z") });
    assert.deepEqual(
      site("curve.json").map((p: { date: string; events: string[] }) => [p.date, p.events]),
      [
        ["2026-10-04", ["surface-added: test clocks"]],
        ["2026-10-05", ["surface-added: proration", "oracle expanded: 6→9", "surface-added: invoices", "method change: causal event order"]],
      ],
    );
    assert.deepEqual(r3.events, ["surface-added: proration", "oracle expanded: 6→9", "surface-added: invoices", "method change: causal event order"]);
    assert.deepEqual(readJsonl<LogEntry>(logPath(data)).filter((e) => e.kind === "publish").at(-1)!.data.events, r3.events);
    assert.deepEqual(clean(), ["", ""]);
  } finally {
    for (const [k, v] of [["STRIPE_API_KEY", saved.key], ["PARITY_READ_BUDGET", saved.budget]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("nightly lands an align commit with its sealed-log entries: a failed parity push drops both here and leaves the pending branch, which the next night deletes unread, or relands when the push landed after all; a failed data push leaves them on a pending branch that the next night relands",{ timeout: 240_000 }, async (t) => {
  const errors = t.mock.method(console, "error", () => {}); // reland()'s shallow-clone line, checked below
  const oracle = await reverseOracle();
  const { tmp, git, bare, data, dataOrigin, repo, parityOrigin } = fixture("pb-land-", { "runs/2026-09-27/sandbox-20260927T070000-aaaa.jsonl": oracle });
  const head0 = git(repo, "rev-parse", "HEAD");

  const originLog = (ref = "main") => {
    try {
      return bare(dataOrigin, "show", `${ref}:align/log.jsonl`).split("\n").map((l) => JSON.parse(l) as LogEntry);
    } catch {
      return []; // no log on that ref yet
    }
  };
  const pendingRefs = () => bare(dataOrigin, "for-each-ref", "--format=%(refname:short)", "refs/heads/nightly/");
  // The invariant, checked on the two origins: every align commit on parity's main has its patch entries in the log on
  // the data repo's main, and every commit the log's nightly entries cite is on parity's main.
  const invariant = () => {
    const log = originLog();
    for (const c of bare(parityOrigin, "log", "--format=%H", "--grep=^align: ", "main").split("\n").filter(Boolean)) {
      assert.ok(log.some((e) => e.kind === "patch" && e.data.class === "automatic" && e.data.commit === c), `align commit ${c} has its patch entries on the data repo's main`);
    }
    for (const e of log.filter((x) => typeof x.data.commit === "string")) execFileSync("git", ["--git-dir", parityOrigin, "merge-base", "--is-ancestor", String(e.data.commit), "main"]);
    assert.ok(verifyLog(logPath(data)).ok);
  };
  /** Real git and an empty `gh`, except that `fail` picks commands to fail. */
  const failing = (fail: (args: string[], cwd: string) => boolean): Run => (cmd, args, cwd) => {
    if (cmd === "gh") return "[]";
    if (cmd === "git" && fail(args, cwd)) throw new Error(`injected failure: git ${args.join(" ")}`);
    return sh(cmd, args, cwd);
  };
  const parityPush = (args: string[], cwd: string) => cwd === repo && args[0] === "push" && args.includes("HEAD:main");

  const saved = { key: process.env.STRIPE_API_KEY, budget: process.env.PARITY_READ_BUDGET };
  process.env.STRIPE_API_KEY = "sk_test_never_sent";
  process.env.PARITY_READ_BUDGET = "0"; // the sandbox refuses at the budget gate: the night scores the existing oracle
  try {
    // (1) The align commit's push fails: neither the commit nor its entries land anywhere, and none is left here.
    await assert.rejects(nightly({ repo, dataDir: data, env: {}, run: failing(parityPush), now: () => new Date("2026-10-05T07:00:00Z") }), /the align commit was not pushed \(injected failure: git push -q origin HEAD:main\); the align commit [0-9a-f]{40} and its sealed-log entries were dropped/);
    assert.deepEqual([git(repo, "rev-parse", "HEAD"), bare(parityOrigin, "rev-parse", "main"), git(repo, "status", "--porcelain")], [head0, head0, ""]);
    // A failed push may have landed (a lost reply): the pending branch is left for the next night's reland() to decide.
    const left = pendingRefs();
    assert.match(left, /^nightly\/pending-\S+$/);
    assert.ok(!readJsonl<LogEntry>(logPath(data)).some((e) => e.kind === "patch" || e.kind === "gate"), "no patch or gate entry here either");
    invariant();

    // A leftover pending branch whose align commit never reached origin (its deletion failed too): deleted, never relanded.
    const ghost = join(tmp, "ghost");
    execFileSync("git", ["clone", "-q", dataOrigin, ghost]);
    appendLog(logPath(ghost), "ghost", [{ kind: "gate", data: { commit: "f".repeat(40), oracle: ORACLE } }]);
    git(ghost, "add", "align");
    git(ghost, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "ghost");
    git(ghost, "push", "-q", "origin", "HEAD:refs/heads/nightly/pending-ghost");

    // (2) The align commit lands, the data repo's main push fails: the entries wait on the pending branch.
    let parityPushed = false;
    const dataPushFails: Run = failing((args, cwd) => {
      if (parityPush(args, cwd)) parityPushed = true;
      return parityPushed && cwd === data && args.join(" ") === "push -q";
    });
    await assert.rejects(nightly({ repo, dataDir: data, env: {}, run: dataPushFails, now: () => new Date("2026-10-06T07:00:00Z") }), /is on origin, but its sealed-log entries did not reach the data repo's main \(injected failure: git push -q\); they wait on nightly\/pending-\S+, and the next nightly lands them first/);
    const aligned = bare(parityOrigin, "rev-parse", "main");
    assert.match(bare(parityOrigin, "log", "-1", "--format=%s", "main"), /^align: 1 automatic patches/);
    const [pending, ...more] = pendingRefs().split("\n");
    assert.match(pending!, /^nightly\/pending-\d{8}T\d{6}-\w+$/);
    assert.notEqual(pending, left);
    assert.deepEqual(more, [], "(1)'s branch and the ghost branch were deleted unread: their align commits are not on origin");
    assert.ok(!originLog().some((e) => e.runId === "ghost"));
    assert.ok(!originLog().some((e) => e.data.commit === aligned), "not on the log's main yet");
    const waiting = originLog(pending).filter((e) => e.data.commit === aligned).map((e) => [e.kind, e.data.class]);
    assert.deepEqual(waiting, [["patch", "automatic"], ["gate", undefined]], "the pending branch holds them");
    const held = originLog(pending).filter((e) => `nightly/pending-${e.runId}` === pending).map((e) => e.hash);

    // (3) The next night runs on a fresh checkout (the runner that failed is gone). First a shallow parity clone, after
    // someone pushed on top of the align commit: it cannot tell whether the commit is on origin, so the branch (the only
    // copy of the entries) is left in place.
    git(data, "fetch", "-q", "origin");
    git(data, "reset", "-q", "--hard", "origin/main");
    git(data, "clean", "-qfd");
    const other = join(tmp, "other");
    execFileSync("git", ["clone", "-q", parityOrigin, other]);
    writeFileSync(join(other, "NOTES.md"), "later\n");
    git(other, "add", "NOTES.md");
    git(other, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "later");
    git(other, "push", "-q", "origin", "HEAD:main");
    const shallow = join(tmp, "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${parityOrigin}`, shallow]);
    git(shallow, "config", "user.email", "test@example.com");
    git(shallow, "config", "user.name", "test");
    await nightly({ repo: shallow, dataDir: data, env: {}, run: failing(() => false), now: () => new Date("2026-10-07T07:00:00Z") });
    assert.equal(pendingRefs(), pending, "left for a full checkout");
    assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /which this shallow clone of the parity repo does not have: left for a full checkout$/);
    assert.ok(!originLog().some((e) => e.data.relanded), "nothing relanded");
    // Then a full clone: it relands them first.
    const r = await nightly({ repo, dataDir: data, env: {}, run: failing(() => false), now: () => new Date("2026-10-08T07:00:00Z") });
    assert.equal(pendingRefs(), "", "the pending branch is deleted once landed");
    // Every recording in the oracle is from CLOCK, 2026-09-27T07:00: 11 days before this night.
    assert.deepEqual([r.oracleMaxAgeDays, site(repo, "curve.json").at(-1).oracleMaxAgeDays], [11, 11]);
    // Run (2)'s entries, all of them (its refusal note and score entry too), relanded with the branch and original hash.
    const relanded = originLog().filter((e) => e.data.relanded);
    assert.deepEqual(relanded.map((e) => [e.kind, e.data.commit === aligned, (e.data.relanded as { branch: string }).branch]), [["note", false, pending], ["score", false, pending], ["patch", true, pending], ["gate", true, pending]]);
    assert.deepEqual(relanded.map((e) => (e.data.relanded as { hash: string }).hash), held);
    assert.equal(r.patches.automatic, 1, "counted once");
    assert.deepEqual(site(repo, "changelog.json").map((c: { class: string; pointers: string[]; commit: string }) => [c.class, c.pointers, c.commit]), [["automatic", ["/tax_exempt"], aligned]]);
    assert.equal(bare(parityOrigin, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"));
    invariant();

    // (6) The align commit's push lands but its reply is lost, so land() drops the commit and entries here. A later
    // recording (tax_exempt "exempt") gives align a second patch. The pending branch is the entries' only copy.
    const exempt = JSON.parse(JSON.stringify(oracle).replaceAll('"tax_exempt":"reverse"', '"tax_exempt":"exempt"')) as typeof oracle;
    writeJsonl(join(data, "runs/2026-10-09/sandbox-20261009T060000-bbbb.jsonl"), exempt.map((x) => ({ ...x, runId: "20261009T060000-bbbb", startedAt: "2026-10-09T06:00:00.000Z" })));
    const lostReply: Run = (cmd, args, cwd) => {
      const out = failing(() => false)(cmd, args, cwd);
      if (parityPush(args, cwd)) throw new Error("injected failure: the push landed, its reply was lost");
      return out;
    };
    await assert.rejects(nightly({ repo, dataDir: data, env: {}, run: lostReply, now: () => new Date("2026-10-09T07:00:00Z") }), /the push landed, its reply was lost/);
    const aligned2 = bare(parityOrigin, "rev-parse", "main");
    assert.notEqual(aligned2, aligned);
    assert.match(bare(parityOrigin, "log", "-1", "--format=%s", "main"), /^align: 1 automatic patches/);
    const [pending2, ...more2] = pendingRefs().split("\n");
    assert.deepEqual([pending2!.startsWith("nightly/pending-"), more2], [true, []]);
    assert.ok(!originLog().some((e) => e.data.commit === aligned2), "not on the log's main");
    assert.deepEqual(originLog(pending2).filter((e) => e.data.commit === aligned2).map((e) => [e.kind, e.data.class]), [["patch", "automatic"], ["gate", undefined]], "the pending branch holds them");
    // The next night, on this same checkout, relands them.
    const r2 = await nightly({ repo, dataDir: data, env: {}, run: failing(() => false), now: () => new Date("2026-10-10T07:00:00Z") });
    assert.equal(pendingRefs(), "");
    assert.deepEqual(originLog().filter((e) => e.data.relanded && e.data.commit === aligned2).map((e) => e.kind), ["patch", "gate"]);
    assert.equal(r2.patches.automatic, 2, "counted once");
    invariant();
  } finally {
    for (const [k, v] of [["STRIPE_API_KEY", saved.key], ["PARITY_READ_BUDGET", saved.budget]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("nightly sizes tonight's slice to the read budget and keeps the rotation cursor across nights: the longest prefix that fits is recorded and the next night goes on from there; an allowance of 0 records nothing; the noise pair waits for a night it fits", { timeout: 240_000 }, async (t) => {
  t.mock.method(console, "log", () => {}); // recordCorpus's progress lines
  // The sandbox is an in-process twin (the `sandbox` seam): the nights record for real, and fast.
  const twin = createTwin();
  const server = await twin.listen(0);
  const sandbox = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  try {
    // Last Sunday's (2026-10-04) noise pair, which is also the oracle: customer-crud #1 and #2 recorded twice.
    const pairSeqs = buildCorpus(TEMPLATES.filter((x) => x.name === "customer-crud"), [1, 2]);
    const record = async (runId: string) => (await runCorpus(pairSeqs, sandbox, { concurrency: 2, runId })).recordings.map((r) => ({ ...r, events: touching(idsIn(r.steps), twin.store.events) }));
    const { git, bare, data, dataOrigin, repo } = fixture("pb-cursor-", {
      "runs/2026-10-04/noise-a-20261004T070000-aaaa.jsonl": await record("20261004T070000-aaaa"),
      "runs/2026-10-04/noise-b-20261004T071000-bbbb.jsonl": await record("20261004T071000-bbbb"),
    });
    // The rotation, rebuilt here: slices 0/7 to 6/7 of the corpus end to end.
    const corpus = buildCorpus(TEMPLATES, SEEDS);
    const rotation = [0, 1, 2, 3, 4, 5, 6].flatMap((k) => corpus.filter((_, i) => i % 7 === k));
    // The ledger's 30-day GETs that leave exactly `seqs`'s projection as the night's share: floor((8500 − x) / 7).
    const spend = (gets: number, day: string) => writeJsonl(join(data, "budget/reads.jsonl"), [{ date: `${day}T00:00:00.000Z`, account: "acct_test", target: "sandbox", runId: "earlier", gets, posts: 0, deletes: 0, charges: 0 }]);
    const leaving = (seqs: typeof rotation) => 8_500 - 7 * projectedGets(seqs);
    const cursor = () => JSON.parse(bare(dataOrigin, "show", "main:budget/rotation.json"));
    const recorded = (day: string) =>
      readdirSync(join(data, "runs", day))
        .filter((f) => f.startsWith("slice-"))
        .flatMap((f) => readJsonl<Recording>(join(data, "runs", day, f)).map((r) => r.seq));
    const notes = (r: { runId: string }) => readJsonl<LogEntry>(logPath(data)).filter((e) => e.runId === r.runId && e.kind === "note" && "nightly" in e.data).map((e) => e.data.nightly as { step: string; error: string });
    const night = (day: string) => nightly({ repo, dataDir: data, env: {}, run: withGh([]), now: () => new Date(`${day}T07:00:00Z`), sandbox });

    // Saturday: no cursor yet, so the window starts at slice 6/7 (rotation position `at`). The share is exactly the first
    // two sequences' projection, which the third one's GETs would exceed: two are recorded, and the cursor moves to at + 2.
    const size = rotation.length;
    const at = rotation.indexOf(corpus[6]!);
    assert.equal(at, size - corpus.filter((_, i) => i % 7 === 6).length);
    assert.ok(projectedGets(rotation.slice(at, at + 3)) > projectedGets(rotation.slice(at, at + 2)), "the third sequence has a GET");
    spend(leaving(rotation.slice(at, at + 2)), "2026-10-09");
    const sat = await night("2026-10-10");
    assert.deepEqual(sat.slice, { spec: `${at}+2/${size}`, seqs: 2, recorded: 2, allowance: projectedGets(rotation.slice(at, at + 2)), budget: sat.slice.budget });
    assert.match(sat.slice.budget, new RegExp(`^allowance ${sat.slice.allowance} GETs = min\\(\\d+ projected for one seventh of the corpus, floor\\(\\(10000 − 1500 reserve − ${leaving(rotation.slice(at, at + 2))} GETs in 30 days\\) / 7\\) = ${sat.slice.allowance}\\); `));
    assert.deepEqual(recorded("2026-10-10"), rotation.slice(at, at + 2).map((x) => x.id));
    assert.deepEqual(cursor(), { cursor: at + 2 }, "the cursor is pushed to the data repo");
    assert.equal(sat.noisePair, undefined, "last Sunday's pair is recorded: none due");
    assert.equal(sat.oracleRefreshed, true);
    assert.deepEqual(notes(sat), []);

    // Sunday: the next night goes on at position at + 2, not at slice 0/7. The pair is due, but the 30-day budget has less left after
    // the slice than the pair projects: it is deferred, and noted.
    spend(leaving(rotation.slice(at + 2, at + 3)), "2026-10-10");
    const sun = await night("2026-10-11");
    assert.deepEqual([sun.slice.spec, sun.slice.recorded], [`${at + 2}+1/${size}`, 1]);
    assert.deepEqual(recorded("2026-10-11"), [rotation[at + 2]!.id]);
    assert.deepEqual(cursor(), { cursor: at + 3 });
    const pairGets = 2 * projectedGets(buildCorpus(TEMPLATES, [1, 2]));
    const one = projectedGets(rotation.slice(at + 2, at + 3));
    assert.ok(8_500 - leaving(rotation.slice(at + 2, at + 3)) - one < pairGets);
    assert.deepEqual(sun.noisePair, { seqs: TEMPLATES.length * 2, recorded: false, refused: `deferred to the next night: ${pairGets} GETs projected for the pair > ${6 * one} left of the 30-day budget after the slice = 10000 − 1500 reserve − ${leaving(rotation.slice(at + 2, at + 3))} GETs in 30 days − ${one} projected for the slice (decision 0001 C2)` });
    assert.deepEqual(notes(sun), [{ date: "2026-10-11", step: "record noise pair", error: sun.noisePair!.refused!, oracleRefreshed: true }]);
    assert.ok(nightlyText(sun).includes(`\nnoise pair: ${TEMPLATES.length * 2} sequences x 2 · NOT RECORDED: deferred to the next night: `));

    // Monday: the 30-day GETs reach the reserve: an allowance of 0, the degraded path. Nothing is recorded, the cursor
    // stays, the oracle is not refreshed, and both the slice and the still-due pair are noted.
    spend(8_500, "2026-10-11");
    const mon = await night("2026-10-12");
    assert.deepEqual([mon.slice.spec, mon.slice.seqs, mon.slice.recorded, mon.slice.allowance, mon.oracleRefreshed], [`${at + 3}+0/${size}`, 0, 0, 0, false]);
    assert.equal(mon.slice.refused, `nothing recorded: ${mon.slice.budget}`);
    assert.ok(mon.slice.budget.endsWith(`; ${join(data, "budget/reads.jsonl")}; decision 0001 C2`), "the allowance reads the data repo's ledger");
    assert.equal(existsSync(join(data, "runs/2026-10-12")), false);
    assert.deepEqual(cursor(), { cursor: at + 3 });
    assert.deepEqual(notes(mon).map((n) => n.step), [`record slice ${at + 3}+0/${size}`, "record noise pair"]);
    assert.match(nightlyText(mon), new RegExp(`^slice ${at + 3}\\+0/${size}: 0 sequences · NOT RECORDED: nothing recorded: allowance 0 GETs = min\\(\\d+ projected for one seventh of the corpus, floor\\(\\(10000 − 1500 reserve − 8500 GETs in 30 days\\) / 7\\) = 0\\)`, "m"));
    assert.match(git(repo, "log", "-1", "--format=%s"), /; oracle not refreshed\)$/);

    // Tuesday: room again; the rotation continues where Sunday stopped.
    spend(leaving(rotation.slice(at + 3, at + 4)), "2026-10-12");
    const tue = await night("2026-10-13");
    assert.deepEqual([tue.slice.spec, recorded("2026-10-13"), cursor()], [`${at + 3}+1/${size}`, [rotation[at + 3]!.id], { cursor: at + 4 }]);
    assert.equal(tue.noisePair?.recorded, false, "the pair is still due and still does not fit");
    assert.deepEqual([git(repo, "status", "--porcelain"), git(data, "status", "--porcelain")], ["", ""]);

    // A Sunday at the steady state's 30-day GETs (a dry run: it plans, never records): one seventh binds the slice, and the
    // pair fits in what the 30-day budget has left after it, though neither the night's share nor the allowance has room
    // for it after the slice (the pair is weekly, decision 0002 §1).
    spend(6_000, "2026-10-17");
    const window = Array.from({ length: Math.ceil(size / 7) }, (_, i) => rotation[(at + 4 + i) % size]!);
    assert.ok(projectedGets(window) < nightShare(6_000) && nightShare(6_000) - projectedGets(window) < pairGets, "the share binds neither the slice nor fits the pair");
    assert.ok(projectedGets(window) + pairGets <= 8_500 - 6_000);
    const dry = await nightly({ repo, dataDir: data, dryRun: true, env: {}, run: withGh([]), now: () => new Date("2026-10-18T07:00:00Z") });
    assert.deepEqual([dry.slice.spec, dry.slice.allowance, dry.noisePair], [`${at + 4}+${Math.ceil(size / 7)}/${size}`, projectedGets(window), { seqs: TEMPLATES.length * 2, recorded: false }]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the test guard: a red suite or tsc on the align commit drops the commit and its sealed-log entries before anything is pushed, notes the failures, and the night goes on; a green one lands it", { timeout: 240_000 }, async () => {
  // A test pinning a value align owns, as the tests that turned CI red on 2026-09-28 pinned the placeholder messages,
  // a type error, and a test that fails if the guard's suite could see the nightly's keys.
  const PIN = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'test("the customer template keeps tax_exempt none", () => {',
    '  assert.equal(JSON.parse(readFileSync(new URL("../src/twin/shapes/customer.json", import.meta.url), "utf8")).tax_exempt, "none");',
    "});",
    'test("no key reaches the guard", () => assert.deepEqual([process.env.STRIPE_API_KEY, process.env.PARITY_READ_BUDGET], [undefined, undefined]));',
    'test("the guard gets its own fresh PARITY_DATA_DIR, not the real one", () => assert.match(process.env.PARITY_DATA_DIR ?? "", /parity-guard-/));',
    'export const typo: number = "not a number";',
    "",
  ].join("\n");
  const { git, bare, data, dataOrigin, repo, parityOrigin } = fixture("pb-guard-", { "runs/2026-09-27/sandbox-20260927T070000-aaaa.jsonl": await reverseOracle() }, { "test/pin.test.ts": PIN });
  const head0 = git(repo, "rev-parse", "HEAD");
  const customerBefore = readFileSync(join(repo, "src/twin/shapes/customer.json"), "utf8"); // whatever align currently owns this to be, not a pinned literal
  const originLog = () => bare(dataOrigin, "show", "main:align/log.jsonl").split("\n").map((l) => JSON.parse(l) as LogEntry);
  const saved = { key: process.env.STRIPE_API_KEY, budget: process.env.PARITY_READ_BUDGET };
  process.env.STRIPE_API_KEY = "sk_test_never_sent";
  process.env.PARITY_READ_BUDGET = "0"; // the sandbox refuses at the budget gate: the night scores the existing oracle
  try {
    const r = await nightly({ repo, dataDir: data, env: {}, run: withGh([]), now: () => new Date("2026-10-05T07:00:00Z") });
    assert.equal(r.guard?.length, 2);
    assert.equal(r.guard![0], "test: the customer template keeps tax_exempt none");
    assert.match(r.guard![1]!, /^tsc: test\/pin\.test\.ts\(9,14\): error TS2322: /);
    assert.match(nightlyText(r), /^test guard: the align commit was DROPPED, 2 failures on it: test: the customer template keeps tax_exempt none; tsc: /m);
    // Nothing of the align commit is anywhere: not here, not on either origin, and no pending branch was pushed.
    assert.deepEqual(bare(parityOrigin, "log", "--format=%s", "main").split("\n").map((x) => x.replace(/ \(.*/s, "")), ["nightly 2026-10-05: curve point and scores", "init"]);
    assert.equal(git(repo, "rev-parse", "HEAD~1"), head0);
    // The working tree was reverted too, not just the commit pointer: no leftover edit from the dropped align commit.
    assert.equal(readFileSync(join(repo, "src/twin/shapes/customer.json"), "utf8"), customerBefore);
    assert.equal(bare(dataOrigin, "for-each-ref", "refs/heads/nightly/"), "");
    const log = originLog();
    assert.ok(!log.some((e) => e.kind === "patch" || e.kind === "gate"), "the patch and gate entries were dropped with the commit");
    const note = log.find((e) => e.runId === r.runId && (e.data.nightly as { step?: string } | undefined)?.step === "test guard");
    assert.deepEqual(note?.data.nightly, { date: "2026-10-05", step: "test guard", error: "the align commit and its sealed-log entries were dropped here: the suite or tsc failed on it (2 failures)", failing: r.guard, oracleRefreshed: false });
    // The night went on: scored, published, both repos pushed.
    assert.equal(r.patches.automatic, 0);
    assert.ok(r.commits && existsSync(join(repo, "site/data/curve.json")));
    assert.ok(verifyLog(logPath(data)).ok);
    assert.deepEqual([git(repo, "status", "--porcelain"), git(data, "status", "--porcelain")], ["", ""]);

    // The pin replaced by a passing test, the next night's align commit passes the guard and lands.
    writeFileSync(join(repo, "test/ok.test.ts"), OK);
    git(repo, "rm", "-q", "test/pin.test.ts");
    git(repo, "add", "test/ok.test.ts");
    git(repo, "commit", "-q", "-m", "unpin");
    git(repo, "push", "-q");
    const r2 = await nightly({ repo, dataDir: data, env: {}, run: withGh([]), now: () => new Date("2026-10-06T07:00:00Z") });
    assert.deepEqual(r2.guard, []);
    assert.match(nightlyText(r2), /^test guard: the suite and tsc pass on the align commit$/m);
    assert.equal(r2.patches.automatic, 1);
    assert.match(bare(parityOrigin, "log", "--format=%s", "main"), /^align: 1 automatic patches/m);
  } finally {
    for (const [k, v] of [["STRIPE_API_KEY", saved.key], ["PARITY_READ_BUDGET", saved.budget]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("the test guard: a suite that could not run (a tool it spawns is missing, as uv on a runner without setup-uv) fails the night after dropping the align commit, instead of dropping every commit on a green night", { timeout: 240_000 }, async () => {
  const TOOL = [
    'import { test } from "node:test";',
    'import { execFileSync } from "node:child_process";',
    'test("the bridge runs", () => { execFileSync("parity-missing-tool", ["--version"]); });',
    "",
  ].join("\n");
  const { git, bare, data, dataOrigin, repo, parityOrigin } = fixture("pb-guard-tool-", { "runs/2026-09-27/sandbox-20260927T070000-aaaa.jsonl": await reverseOracle() }, { "test/tool.test.ts": TOOL });
  const head0 = git(repo, "rev-parse", "HEAD");
  const saved = { key: process.env.STRIPE_API_KEY, budget: process.env.PARITY_READ_BUDGET };
  process.env.STRIPE_API_KEY = "sk_test_never_sent";
  process.env.PARITY_READ_BUDGET = "0";
  try {
    await assert.rejects(
      nightly({ repo, dataDir: data, env: {}, run: withGh([]), now: () => new Date("2026-10-05T07:00:00Z") }),
      /^Error: nightly: the test guard could not run the suite: parity-missing-tool not on PATH \(spawn ENOENT\); install it on the runner \(\.github\/workflows\/nightly\.yml\); the align commit [0-9a-f]{40} and its sealed-log entries were dropped here: nothing is published tonight$/,
    );
    assert.deepEqual([git(repo, "rev-parse", "HEAD"), git(repo, "status", "--porcelain")], [head0, ""]);
    assert.deepEqual([bare(parityOrigin, "log", "--format=%s", "main"), bare(dataOrigin, "for-each-ref", "refs/heads/nightly/")], ["init", ""]);
    assert.ok(!readJsonl<LogEntry>(logPath(data)).some((e) => e.kind === "patch" || e.kind === "gate"), "the patch and gate entries were dropped with the commit");
  } finally {
    for (const [k, v] of [["STRIPE_API_KEY", saved.key], ["PARITY_READ_BUDGET", saved.budget]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("the test guard: a suite that ran 0 tests (moved or renamed) or hung past the guard's timeout drops the align commit, notes it, and the night goes on", { timeout: 240_000 }, async () => {
  // The suite moved to tests/: test/*.test.ts matches nothing, and node --test passes with 0 tests.
  const { git, bare, data, dataOrigin, repo, parityOrigin } = fixture("pb-guard-empty-", { "runs/2026-09-27/sandbox-20260927T070000-aaaa.jsonl": await reverseOracle() }, { "tests/ok.test.ts": OK });
  const saved = { key: process.env.STRIPE_API_KEY, budget: process.env.PARITY_READ_BUDGET };
  process.env.STRIPE_API_KEY = "sk_test_never_sent";
  process.env.PARITY_READ_BUDGET = "0"; // the sandbox refuses at the budget gate: the night scores the existing oracle
  /** The night's align commit was dropped with its entries, its failures noted, and the night went on. */
  const dropped = (r: Awaited<ReturnType<typeof nightly>>, failing: string[]) => {
    assert.deepEqual(r.guard, failing);
    assert.doesNotMatch(bare(parityOrigin, "log", "--format=%s", "main"), /^align: /m);
    assert.equal(bare(dataOrigin, "for-each-ref", "refs/heads/nightly/"), "");
    const log = bare(dataOrigin, "show", "main:align/log.jsonl").split("\n").map((l) => JSON.parse(l) as LogEntry);
    assert.ok(!log.some((e) => e.kind === "patch" || e.kind === "gate"), "the patch and gate entries were dropped with the commit");
    const note = log.find((e) => e.runId === r.runId && (e.data.nightly as { step?: string } | undefined)?.step === "test guard");
    assert.deepEqual((note?.data.nightly as { failing?: string[] } | undefined)?.failing, failing);
    assert.ok(r.commits, "the night went on: published and pushed");
    assert.deepEqual([git(repo, "status", "--porcelain"), git(data, "status", "--porcelain")], ["", ""]);
  };
  try {
    const empty = await nightly({ repo, dataDir: data, env: {}, run: withGh([]), now: () => new Date("2026-10-05T07:00:00Z") });
    dropped(empty, ["test: node --test test/*.test.ts ran 0 tests"]);

    // The suite back in test/, plus a test that never ends: the guard kills the suite at its timeout (here 30 s, 600 s in
    // the nightly) instead of waiting for the job's. 30 s leaves tsc, which shares the timeout, room on a busy runner.
    mkdirSync(join(repo, "test"));
    git(repo, "mv", "tests/ok.test.ts", "test/ok.test.ts");
    writeFileSync(join(repo, "test/hang.test.ts"), ['import { test } from "node:test";', 'test("never ends", () => new Promise(() => setInterval(() => {}, 1_000)));', ""].join("\n"));
    git(repo, "add", "test/hang.test.ts");
    git(repo, "commit", "-q", "-m", "hang");
    git(repo, "push", "-q");
    const hung = await nightly({ repo, dataDir: data, env: {}, run: withGh([]), now: () => new Date("2026-10-06T07:00:00Z"), guardTimeoutMs: 30_000 });
    dropped(hung, ["test: node --test test/*.test.ts timed out after 30 s (killed)"]);
    assert.match(nightlyText(hung), /^test guard: the align commit was DROPPED, 1 failures on it: test: node --test test\/\*\.test\.ts timed out after 30 s \(killed\)$/m);
  } finally {
    for (const [k, v] of [["STRIPE_API_KEY", saved.key], ["PARITY_READ_BUDGET", saved.budget]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("nightly --once-per-day: not published today (UTC), the night runs; a later attempt that day pulls the data repo current, finds the publish entry and stops with one line, recording and committing nothing; without the flag a same-day rerun runs", { timeout: 240_000 }, async () => {
  const { tmp, git, bare, data, dataOrigin, repo, parityOrigin } = fixture("pb-once-", { "runs/2026-09-27/sandbox-20260927T070000-aaaa.jsonl": await reverseOracle() });
  // The backup attempt's checkout, cloned before the first attempt pushes: its log has no publish entry until it pulls.
  const stale = join(tmp, "stale");
  execFileSync("git", ["clone", "-q", dataOrigin, stale]);
  const publishes = (dir: string) => (existsSync(logPath(dir)) ? readJsonl<LogEntry>(logPath(dir)) : []).filter((e) => e.kind === "publish" && e.data.label === "nightly" && e.data.date === "2026-10-05").length;
  const saved = { key: process.env.STRIPE_API_KEY, budget: process.env.PARITY_READ_BUDGET };
  process.env.STRIPE_API_KEY = "sk_test_never_sent";
  process.env.PARITY_READ_BUDGET = "0"; // the sandbox refuses at the budget gate: the night scores the existing oracle
  try {
    const first = await nightlyCommand({ repo, dataDir: data, oncePerDay: true, env: {}, run: withGh([]), now: () => new Date("2026-10-05T07:23:00Z") });
    assert.match(first, /^nightly 2026-10-05 run \S+\n/);
    assert.equal(publishes(data), 1);
    assert.equal(publishes(stale), 0);

    const heads = () => [git(repo, "rev-parse", "HEAD"), bare(parityOrigin, "rev-parse", "main"), bare(dataOrigin, "rev-parse", "main")];
    const before = heads();
    const gh: string[][] = [];
    const second = await nightlyCommand({ repo, dataDir: stale, oncePerDay: true, env: {}, run: withGh([], gh), now: () => new Date("2026-10-05T10:47:00Z") });
    assert.equal(second, "nightly: already published for 2026-10-05, nothing to do");
    assert.deepEqual(heads(), before, "no commit here or on either origin");
    assert.equal(git(stale, "rev-parse", "HEAD"), before[2], "the checkout was pulled current and nothing was added to it");
    assert.equal(publishes(stale), 1);
    assert.deepEqual([git(repo, "status", "--porcelain"), git(stale, "status", "--porcelain"), gh], ["", "", []], "nothing recorded, logged or asked of gh");

    const rerun = await nightlyCommand({ repo, dataDir: data, env: {}, run: withGh([]), now: () => new Date("2026-10-05T12:00:00Z") });
    assert.match(rerun, /^nightly 2026-10-05 run \S+\n/);
    assert.equal(publishes(data), 2);
    assert.notEqual(bare(dataOrigin, "rev-parse", "main"), before[2]);
  } finally {
    for (const [k, v] of [["STRIPE_API_KEY", saved.key], ["PARITY_READ_BUDGET", saved.budget]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("nightly: the 2026-09-28 pair's published ceiling says inSample (normalization v1.4 was written from it) until a newer pair replaces it; an oracle with no recordings has no age, never 0 days", { timeout: 120_000 }, async () => {
  const recs = await reverseOracle();
  const { data, repo } = fixture("pb-insample-", {
    "runs/2026-09-28/noise-a-20260928T011354-l3w0.jsonl": recs,
    "runs/2026-09-28/noise-b-20260928T012601-q5kb.jsonl": recs,
  });
  // Dry runs: the public files go to r.tmp.
  const night = (day: string) => nightly({ repo, dataDir: data, dryRun: true, env: {}, run: withGh([]), now: () => new Date(`${day}T07:00:00Z`) });
  const published = (r: { tmp?: string; date: string }) => [site(join(r.tmp!, "parity"), "curve.json").at(-1).noise.coverage.inSample, site(join(r.tmp!, "parity"), `scores/${r.date}.json`).noiseCoverage.inSample];
  const r = await night("2026-09-29");
  assert.deepEqual(r.noise?.pair, ["2026-09-28/noise-a-20260928T011354-l3w0.jsonl", "2026-09-28/noise-b-20260928T012601-q5kb.jsonl"]);
  assert.deepEqual([r.noise?.inSample, ...published(r)], [true, true, true]);
  assert.match(nightlyText(r), /^noise ceiling: .*; in-sample: the normalization was written from this pair\)$/m);

  // The next weekly pair is the ceiling from then on, out of sample.
  writeJsonl(join(data, "runs/2026-10-04/noise-a-20261004T070000-aaaa.jsonl"), recs);
  writeJsonl(join(data, "runs/2026-10-04/noise-b-20261004T071000-bbbb.jsonl"), recs);
  const r2 = await night("2026-10-05");
  assert.deepEqual(r2.noise?.pair, ["2026-10-04/noise-a-20261004T070000-aaaa.jsonl", "2026-10-04/noise-b-20261004T071000-bbbb.jsonl"]);
  assert.deepEqual([r2.noise?.inSample, ...published(r2)], [false, false, false]);
  assert.doesNotMatch(nightlyText(r2), /in-sample/);

  // The oracle's age: every recording is from CLOCK, 2026-09-27T07:00, 2 days before the first night. With no oracle
  // there is no age: the summary says so, never "at most 0 days old".
  const oracleLine = (x: Parameters<typeof nightlyText>[0]) => nightlyText(x).split("\n").find((l) => l.startsWith(r.built))!;
  assert.equal(r.oracleMaxAgeDays, 2);
  assert.match(oracleLine(r), / · at most 2 days old$/);
  assert.match(oracleLine({ ...r, oracleMaxAgeDays: null }), / · no oracle$/);
});

const site = (repo: string, f: string) => JSON.parse(readFileSync(join(repo, "site/data", f), "utf8"));

/** The land tests' recording time. */
const CLOCK = "2026-09-27T07:00:00.000Z";

/**
 * customer-crud and subscription-cancel-at-period-end x seeds 1-2 recorded on the twin at CLOCK, as a sandbox recording
 * where every customer's tax_exempt is "reverse": align --apply seeds it (one automatic patch).
 */
async function reverseOracle(): Promise<Recording[]> {
  const seqs = buildCorpus(TEMPLATES.filter((t) => ["customer-crud", "subscription-cancel-at-period-end"].includes(t.name)), [1, 2]);
  const twin = createTwin();
  const server = await twin.listen(0);
  const target = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  const { recordings } = await runCorpus(seqs, target, { concurrency: 2, runId: "20260927T070000-aaaa", headersFor: () => ({ "Parity-Now": String(Date.parse(CLOCK) / 1000) }) }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  const reverse = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (v as { object?: string }).object === "customer" && k === "tax_exempt" ? "reverse" : reverse(x)])) : v;
  return recordings.map((r) => ({ ...r, startedAt: CLOCK, events: touching(idsIn(r.steps), twin.store.events), steps: r.steps.map((s) => ({ ...s, body: reverse(s.body) })) }));
}

/** A passing test: the guard fails a suite that runs 0 tests. */
const OK = ['import { test } from "node:test";', 'test("ok", () => {});', ""].join("\n");

/**
 * The data repo (`dataFiles`: JSONL rows per path) and the parity repo (src, templates, package.json and tsconfig.json
 * copied, node_modules linked, so the test guard's suite and tsc run for real, plus `repoFiles`, by default one passing
 * test), each with a bare origin.
 */
function fixture(prefix: string, dataFiles: Record<string, unknown[]>, repoFiles: Record<string, string> = { "test/ok.test.ts": OK }) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const bare = (dir: string, ...args: string[]) => git(tmp, "--git-dir", dir, ...args);
  const repoWithOrigin = (dir: string, origin: string) => {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
    git(dir, "remote", "add", "origin", origin);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "push", "-q", "-u", "origin", "main");
  };
  const data = join(tmp, "parity-data");
  const dataOrigin = join(tmp, "data-origin.git");
  for (const [f, rows] of Object.entries(dataFiles)) writeJsonl(join(data, f), rows);
  repoWithOrigin(data, dataOrigin);
  const repo = join(tmp, "parity");
  const parityOrigin = join(tmp, "parity-origin.git");
  for (const p of ["src", "templates", "package.json", "tsconfig.json"]) cpSync(join(REPO, p), join(repo, p), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(repo, "node_modules"));
  for (const [f, text] of Object.entries(repoFiles)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  repoWithOrigin(repo, parityOrigin);
  return { tmp, git, bare, data, dataOrigin, repo, parityOrigin };
}
