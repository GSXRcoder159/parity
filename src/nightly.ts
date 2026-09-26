// paritybench nightly (plan §3.3–§3.5; decision 0002 §1 rolling oracle, §3 what counts, §5 data locations): record
// tonight's sandbox slice (and weekly the noise pair), rebuild the oracle, score the twin on the whole oracle with the
// noise ceiling, align (mechanical, then assisted), log merged assisted PRs, publish the public-safe curve point and
// scores file, run drift, commit and push both repos (this one first). A refused or aborted recording (budget gate, circuit breaker; decision 0001 C2) is a
// sealed-log note, not a failure: the night goes on with the existing oracle and the curve point says oracleRefreshed: false.
// Any other error (a missing key, a bug) fails the night.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { assist, assistText, sh, type Run } from "./align/assist.ts";
import { scoreTwinIn } from "./align/gate.ts";
import { align, noiseFromRuns, planText } from "./align/index.ts";
import type { Env } from "./align/llm.ts";
import { appendLog, logPath, provenance, type LogEntry, type Provenance } from "./align/log.ts";
import type { SeqResult } from "./bench/compare.ts";
import { buildCorpus, parseSeeds } from "./bench/corpus.ts";
import { NORMALIZATION_VERSION } from "./bench/normalize.ts";
import { contaminated } from "./bench/oracle.ts";
import { score, type LevelScores, type Score } from "./bench/score.ts";
import { compareSets, newRunId, oracleBuild, readsLedger, recordCorpus, Refused, resolveTarget, slice } from "./cli.ts";
import { drift, type DriftResult } from "./drift.ts";
import { readJsonl } from "./jsonl.ts";
import type { Recording, Sequence } from "./types.ts";

/** The noise pair's weekday (UTC; 0 = Sunday). */
const NOISE_DAY = 0;
/** The fixed noise subset: every template x these seeds (30 x 2 = 60 sequences), recorded twice back-to-back. */
const NOISE_SEEDS = [1, 2];
/** Decision 0001 C2: the nightly path runs at <=10 req/s (the sandbox target's default bucket is 20). */
const NIGHTLY_RPS = 10;
/** The corpus the slices rotate through: templates x seeds 1-20 (30 x 20 = 600 sequences, ~86 a night). */
const CORPUS_SEEDS = "1-20";

/**
 * What a noise pair covers of tonight's scored oracle. `inSample`: the normalization rules were written from this pair,
 * so its floor flatters them (the W0 pair A/D, now noise-a/noise-b, wrote v1.2).
 */
export type Coverage = { seqs: number; oracleSeqs: number; templates: number; oracleTemplates: number; strata: string[]; inSample: boolean };
export type Noise = { overall: LevelScores; byStratum: Record<string, LevelScores> };
/** Cumulative since the scaffold freeze, from the sealed log: automatic patches applied, assisted patches merged. */
export type Patches = { automatic: number; assisted: number };

/** Run ids of the noise pairs the current normalization rules were written from (v1.2: the W0 pair A/D). */
const IN_SAMPLE_RUNS = new Set(["20260925T233315-zdmc", "20260926T000140-m0x6"]);
/** Account keys and ids that must never reach a public file (decision 0001 R8): checked before anything is committed. */
const SECRET = /\b(sk|rk|rkcs)_(test|live)_|\bacct_[A-Za-z0-9]/;

/** Records `seqs` on the sandbox at NIGHTLY_RPS into <dataDir>/runs/<date>/<name>-<runId>.jsonl: budget-gated, ledgered in <dataDir>/budget. */
async function recordSandbox(dataDir: string, date: string, name: string, seqs: Sequence[]): Promise<Recording[]> {
  const runId = newRunId(); // a fresh run id per recording: idempotency nonces derive from it and must never repeat
  const target = { ...resolveTarget("sandbox"), rps: NIGHTLY_RPS };
  return recordCorpus(target, seqs, { concurrency: 8, runId, out: join(dataDir, "runs", date, `${name}-${runId}.jsonl`), ledger: readsLedger(dataDir) });
}

/**
 * Tonight's normalization of the latest noise pair: the newest `noise-b-<runId>.jsonl` under <dataDir>/runs and the
 * newest `noise-a` recorded before it, on the sequences clean in both (compare --oracle a --target b, score only).
 * A pair with no clean sequence in common is skipped for the one before it. Undefined when there is none.
 */
function noiseFloor(dataDir: string): (Noise & { pair: [string, string]; seqs: number; templates: Set<string>; inSample: boolean }) | undefined {
  const runs = join(dataDir, "runs");
  const files = existsSync(runs) ? readdirSync(runs, { recursive: true, encoding: "utf8" }) : [];
  const id = (f: string, side: "a" | "b") => new RegExp(`^noise-${side}-(.+)\\.jsonl$`).exec(basename(f))?.[1];
  const sorted = (side: "a" | "b") => files.filter((f) => id(f, side)).sort((x, y) => (id(x, side)! < id(y, side)! ? -1 : 1));
  for (const b of sorted("b").reverse()) {
    const a = sorted("a").filter((f) => id(f, "a")! < id(b, "b")!).at(-1);
    if (!a) continue;
    const bs = readJsonl<Recording>(join(runs, b));
    const clean = new Set(bs.filter((r) => !contaminated(r)).map((r) => r.seq));
    const as = readJsonl<Recording>(join(runs, a)).filter((r) => !contaminated(r) && clean.has(r.seq));
    if (!as.length) continue;
    const { overall, byStratum } = compareSets(as, [b, bs], undefined, false).score;
    const inSample = IN_SAMPLE_RUNS.has(id(a, "a")!) || IN_SAMPLE_RUNS.has(id(b, "b")!);
    return { overall, byStratum, pair: [a, b], seqs: as.length, templates: new Set(as.map((r) => r.template)), inSample };
  }
  return undefined;
}

/**
 * Appends one sealed-log `patch` entry {class: "assisted", status: "merged", pr} per merged `align/assisted-*` PR not
 * logged yet (by PR number) and returns how many. The ratio counts merges, never proposals (decision 0002 §3).
 */
export function logMerged(o: { repo: string; log: string; runId: string; oracle: Provenance; run?: Run }): number {
  const run = o.run ?? sh;
  const prs = JSON.parse(run("gh", ["pr", "list", "--state", "merged", "--json", "number,headRefName,mergedAt", "--limit", "200"], o.repo)) as { number: number; headRefName: string; mergedAt: string | null }[];
  const entries = existsSync(o.log) ? readJsonl<LogEntry>(o.log) : [];
  const logged = new Set(entries.filter((e) => e.kind === "patch" && e.data.class === "assisted" && e.data.status === "merged").map((e) => e.data.pr));
  // `gh pr list --head` matches one branch exactly, so the prefix is filtered here.
  const fresh = prs.filter((p) => p.mergedAt && p.headRefName.startsWith("align/assisted-") && !logged.has(p.number)).sort((a, b) => a.number - b.number);
  if (fresh.length) {
    appendLog(o.log, o.runId, fresh.map((p) => ({ kind: "patch" as const, data: { class: "assisted", status: "merged", pr: p.number, branch: p.headRefName, mergedAt: p.mergedAt, oracle: o.oracle } })));
  }
  return fresh.length;
}

/**
 * `surface-added: <note>` per sealed-log `patch` entry of class surface-added (align surface) since the previous curve
 * point, i.e. the last nightly `publish` entry (annotated, never counted). A night that fails before publishing leaves
 * its entries for the next one.
 */
function surfaceAdded(log: string): string[] {
  const entries = existsSync(log) ? readJsonl<LogEntry>(log) : [];
  return entries
    .slice(entries.findLastIndex((e) => e.kind === "publish" && e.data.label === "nightly") + 1)
    .filter((e) => e.kind === "patch" && e.data.class === "surface-added")
    .map((e) => `surface-added: ${String(e.data.note)}`);
}

/**
 * Cumulative align-loop patches in the sealed log (decision 0002 §3): `automatic` entries applied (by align --apply,
 * in a nightly or by hand) and `assisted` entries merged. Totals, not a per-night window: a patch applied outside the
 * nightly still counts, and a rerun of a night cannot count one twice.
 */
export function patchTotals(log: string): Patches {
  const entries = existsSync(log) ? readJsonl<LogEntry>(log) : [];
  const n = (cls: string, status: string) => entries.filter((e) => e.kind === "patch" && e.data.class === cls && e.data.status === status).length;
  return { automatic: n("automatic", "applied"), assisted: n("assisted", "merged") };
}

/**
 * The night's public-safe files (the page's contract, site/app.js): a curve point and site/data/scores/<date>.json.
 * Scores only, no values or ids (decision 0001 C3). Without a noise pair `noise` is absent (the page marks the night
 * invalid). A ceiling is published only where the pair covers every scored template: overall when it covers the whole
 * oracle, per stratum for the strata it covers whole; `noise.coverage` says what it covers and whether it is in-sample.
 */
function publicFiles(o: {
  date: string;
  score: Score;
  results: SeqResult[];
  noise?: Noise & { seqs: number; templates: Set<string>; inSample: boolean };
  events: string[];
  patches: Patches;
  oracleRefreshed: boolean;
  oracleSeqs: number;
}) {
  const { date } = o;
  const s = o.score;
  const normalization = NORMALIZATION_VERSION;
  const templatesOf = (rs: SeqResult[]) => new Set(rs.map((r) => r.template));
  const whole = (rs: SeqResult[]) => [...templatesOf(rs)].every((t) => o.noise!.templates.has(t));
  const strata = Object.keys(s.byStratum).filter((k) => o.noise && whole(o.results.filter((r) => r.stratum === k)));
  const coverage: Coverage | undefined = o.noise && {
    seqs: o.noise.seqs,
    oracleSeqs: o.results.length,
    templates: [...templatesOf(o.results)].filter((t) => o.noise!.templates.has(t)).length,
    oracleTemplates: templatesOf(o.results).size,
    strata: strata.sort(),
    inSample: o.noise.inSample,
  };
  const noise = o.noise && {
    ...(whole(o.results) && { overall: o.noise.overall }),
    byStratum: Object.fromEntries(strata.map((k) => [k, o.noise!.byStratum[k]!])),
    coverage,
  };
  const point = { date, normalization, overall: s.overall, byStratum: s.byStratum, heldOut: s.heldOut, train: s.train, events: o.events, ...(noise && { noise }), patches: o.patches, oracleRefreshed: o.oracleRefreshed, oracleSeqs: o.oracleSeqs };
  const byStratum = Object.keys(s.byStratum)
    .sort()
    .map((k) => {
      const t = score(o.results.filter((r) => r.stratum === k));
      return [k, { train: t.train, heldOut: t.heldOut, noise: noise?.byStratum[k] }];
    });
  const scores = { date, normalization, overall: { train: s.train, heldOut: s.heldOut, noise: noise?.overall }, byStratum: Object.fromEntries(byStratum), ...(coverage && { noiseCoverage: coverage }) };
  return { point, scores };
}

/**
 * The public commit message's ceiling clause: the pair's number never goes out without its coverage, and without every
 * scored template (`whole`: publicFiles published an overall ceiling) it is not called the ceiling.
 */
export function ceilingText(noise: { seqs: number; overall: LevelScores } | undefined, oracleSeqs: number, whole: boolean): string {
  if (!noise) return "no noise pair";
  const l3 = `${(noise.overall.L3.p * 100).toFixed(1)}%`;
  const covers = `the pair covers ${noise.seqs} of ${oracleSeqs} sequences`;
  if (!whole) return `no whole-corpus noise ceiling (${covers}: L3 ${l3} on those)`;
  return `noise ceiling L3 ${l3}${noise.seqs < oracleSeqs ? ` (${covers})` : ""}`;
}

const writeJson = (file: string, v: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
};

export interface NightlyResult {
  date: string;
  runId: string;
  /** Set on --dry-run: where the data copy and the public files went. */
  tmp?: string;
  slice: { spec: string; seqs: number; recorded: number; refused?: string };
  noisePair?: { seqs: number; recorded: boolean; refused?: string };
  oracleRefreshed: boolean;
  /** oracle build's one-line account (sequences, recordings scanned, exclusions). */
  built: string;
  oracle: Provenance;
  score: Score;
  noise?: Noise & { pair: [string, string]; seqs: number; inSample: boolean };
  plan: string;
  assist: string;
  merged: number;
  /** Cumulative (patchTotals). */
  patches: Patches;
  /** The curve point's annotations. */
  events: string[];
  drift: DriftResult;
  published: string[];
  commits?: { data: string; parity: string };
}

/**
 * The nightly pipeline on `repo` and `dataDir`. `dryRun`: no sandbox traffic, align plan only, no assisted pass, no
 * commits or pushes; the data dir is copied to a temp dir (the oracle rebuild and sealed-log entries land in the copy)
 * and the public files go to a temp root. `env` reaches the assisted pass; `run` runs git and gh.
 */
export async function nightly(o: { repo: string; dataDir: string; dryRun?: boolean; env?: Env; run?: Run; now?: () => Date }): Promise<NightlyResult> {
  const now = (o.now ?? (() => new Date()))();
  const date = now.toISOString().slice(0, 10);
  const run = o.run ?? sh;
  const runId = newRunId(now);
  const tmp = o.dryRun ? mkdtempSync(join(tmpdir(), "parity-nightly-")) : undefined;
  const data = tmp ? join(tmp, "parity-data") : o.dataDir;
  const root = tmp ? join(tmp, "parity") : o.repo;
  if (tmp) {
    cpSync(o.dataDir, data, { recursive: true, filter: (src) => basename(src) !== ".git" });
    for (const p of ["site/data", "drift"]) if (existsSync(join(o.repo, p))) cpSync(join(o.repo, p), join(root, p), { recursive: true });
  }
  const log = logPath(data);
  const oraclePath = join(data, "oracle.jsonl");

  // 1. Tonight's slice, and on NOISE_DAY the noise pair after it. Drift's baseline is the oracle before the rebuild.
  const previous = existsSync(oraclePath) ? readJsonl<Recording>(oraclePath) : [];
  const dow = now.getUTCDay();
  const spec = `${dow}/7`;
  const seqs = slice(buildCorpus(TEMPLATES, parseSeeds(CORPUS_SEEDS)), spec);
  const sliceRes: NightlyResult["slice"] = { spec, seqs: seqs.length, recorded: 0 };
  let noisePair: NightlyResult["noisePair"];
  let today: Recording[] = [];
  const refused: { step: string; error: string }[] = [];
  const refuse = (step: string, e: unknown): string => {
    if (!(e instanceof Refused)) throw e;
    refused.push({ step, error: e.message });
    return e.message;
  };
  // Tonight's run files and read-ledger entries (and, after the assisted pass, the LLM ledger) are pushed as soon as each
  // recording ends (and when one fails), so a later failure or a killed run cannot lose them: the next night's budget
  // gate and daily LLM cap count them (decision 0001 C2). A concurrent push to the data repo is rebased onto, not lost.
  const persist = (what: string): void => {
    if (o.dryRun) return;
    const paths = ["runs", "budget"].filter((p) => existsSync(join(data, p)));
    if (paths.length && run("git", ["status", "--porcelain", "--", ...paths], data)) {
      run("git", ["add", "-A", "--", ...paths], data);
      run("git", ["commit", "-q", "-m", `nightly ${date} run ${runId}: ${what}`, "--", ...paths], data);
    }
    // The sealed log's own entries are committed only at step 8, so this rebase never rewrites a hash they cite.
    run("git", ["pull", "-q", "--rebase", "--autostash"], data);
    run("git", ["push", "-q"], data);
  };
  let failed: { e: unknown } | undefined;
  try {
    if (!o.dryRun) {
      try {
        today = await recordSandbox(data, date, "slice", seqs);
        sliceRes.recorded = today.filter((r) => !contaminated(r)).length;
      } catch (e) {
        sliceRes.refused = refuse(`record slice ${spec}`, e);
      }
      persist("recordings and read ledger"); // before a Sunday's noise pair: the slice's reads must not wait ~120 more sequences
    }
    if (dow === NOISE_DAY) {
      const noiseSeqs = buildCorpus(TEMPLATES, NOISE_SEEDS);
      noisePair = { seqs: noiseSeqs.length, recorded: false };
      // After a refused slice the sandbox is refusing: the pair waits for next week.
      if (!o.dryRun && !sliceRes.refused) {
        try {
          for (const name of ["noise-a", "noise-b"]) await recordSandbox(data, date, name, noiseSeqs);
          noisePair.recorded = true;
        } catch (e) {
          noisePair.refused = refuse("record noise pair", e);
        }
      }
    }
  } catch (e) {
    failed = { e };
  }
  // Persisting must not mask the night's own error: that one is rethrown, a persist failure after it only reported.
  try {
    persist("recordings and read ledger");
  } catch (p) {
    if (!failed) throw p;
    console.error(`nightly: persisting the recordings also failed: ${(p as Error).message}`);
  }
  if (failed) throw failed.e;
  const oracleRefreshed = !o.dryRun && !sliceRes.refused;

  // 2. oracle build: newest clean recording per sequence (an aborted run is contaminated and never selected).
  const built = oracleBuild(undefined, data).split("\n")[0]!;
  const oracle = provenance(oraclePath);
  if (refused.length) appendLog(log, runId, refused.map((n) => ({ kind: "note", data: { nightly: { date, ...n, oracleRefreshed }, oracle } })));

  // 3. score-twin on the whole oracle, the noise ceiling from the latest pair, one sealed-log `score` entry.
  const { json } = scoreTwinIn(o.repo, oraclePath, []);
  const noise = noiseFloor(data);
  const commit = run("git", ["rev-parse", "HEAD"], o.repo);
  const logged = noise && { overall: noise.overall, byStratum: noise.byStratum, pair: noise.pair, seqs: noise.seqs, inSample: noise.inSample };
  appendLog(log, runId, [{ kind: "score", data: { label: "nightly", date, commit, normalization: NORMALIZATION_VERSION, score: json.score, ...(logged && { noise: logged }), oracleRefreshed, oracle } }]);

  // 4. align --apply (mechanical); plan only on a dry run. Its commit is pushed at once and as is (the sealed log cites
  // its hash, so it is never rebased): up to date with origin first, and a rejected push stops the night before the data
  // repo's log (with the entries citing it) is pushed.
  const branch = o.dryRun ? "" : run("git", ["rev-parse", "--abbrev-ref", "HEAD"], o.repo);
  if (!o.dryRun) run("git", ["pull", "-q", "--ff-only", "origin", branch], o.repo);
  const plan = align({ repo: o.repo, dataDir: data, runId, apply: !o.dryRun });
  if (plan.applied?.commit) {
    try {
      run("git", ["push", "-q", "origin", `HEAD:${branch}`], o.repo);
    } catch (e) {
      throw new Error(`nightly: the align commit ${plan.applied.commit} was not pushed (${(e as Error).message}); its sealed-log entries are not pushed either: nothing is published tonight`);
    }
  }

  // 5. align --assist on HEAD (a fresh plan when --apply just committed: the old baseline is stale), then merged PRs.
  let assisted = "assist: not run (dry run)";
  if (!o.dryRun) {
    const base = plan.applied?.commit ? align({ repo: o.repo, dataDir: data, runId }) : plan;
    assisted = assistText(await assist(base, { repo: o.repo, dataDir: data, runId, env: o.env, run }));
    persist("LLM ledger"); // the day's spend must survive a later failure: the daily cap reads it (a same-day rerun too)
  }
  const merged = logMerged({ repo: o.repo, log, runId, oracle, run });
  const patches = patchTotals(log);

  // 6. The public-safe curve point and scores file, then a `publish` entry: the next night's surface-added window starts here.
  const curveFile = join(root, "site/data/curve.json");
  // A second run on the same date replaces that date's point (one point per night on the chart).
  const curve = (existsSync(curveFile) ? (JSON.parse(readFileSync(curveFile, "utf8")) as { date: string; oracleSeqs?: number }[]) : []).filter((p) => p.date !== date);
  const last = curve.at(-1)?.oracleSeqs; // points before W4 do not carry it: no comparison
  const events = [...surfaceAdded(log), ...(last !== undefined && oracle.oracleSeqs > last ? [`oracle expanded: ${last}→${oracle.oracleSeqs}`] : [])];
  const { point, scores } = publicFiles({ date, score: json.score, results: json.results, noise, events, patches, oracleRefreshed, oracleSeqs: oracle.oracleSeqs });
  writeJson(curveFile, [...curve, point]);
  writeJson(join(root, `site/data/scores/${date}.json`), scores);
  appendLog(log, runId, [{ kind: "publish", data: { label: "nightly", date, events, oracle } }]);
  const published = ["site/data/curve.json", `site/data/scores/${date}.json`];

  // 7. Drift: tonight's slice against the previous recording of each sequence.
  const d = drift({ date, today, previous, noise: noiseFromRuns(data).keys, root, log, runId, oracle });
  if (d.file) published.push(d.file, "site/data/drift.json");

  // 8. Commit both repos, then push this one first and the data repo last: the data repo's log never records a night
  // whose public files did not land. The public files are checked for account keys and ids before anything is committed.
  const leaks = published.filter((f) => SECRET.test(readFileSync(join(root, f), "utf8")));
  if (leaks.length) throw new Error(`nightly: refusing to publish: an account key or id pattern (${SECRET.source}) in ${leaks.join(", ")}`);
  let commits: NightlyResult["commits"];
  if (!o.dryRun) {
    const pct = (w: { p: number }) => `${(w.p * 100).toFixed(1)}%`;
    // The read and LLM ledgers name the account: they are committed in the private data repo, never in the parity repo.
    run("git", ["pull", "-q", "--rebase", "--autostash"], data); // before the commit whose hash the parity commit cites
    run("git", ["add", "-A", "--", ...["runs", "oracle.jsonl", "align", "budget"].filter((p) => existsSync(join(data, p)))], data);
    run("git", ["commit", "-q", "-m", `nightly ${date} run ${runId}: slice ${spec} ${oracleRefreshed ? `recorded (${sliceRes.recorded} clean)` : "not recorded"}; oracle ${oracle.oracleSeqs} sequences, sha256 ${oracle.oracleSha}`], data);
    const dataCommit = run("git", ["rev-parse", "HEAD"], data);
    const files = published;
    run("git", ["add", "--", ...files], o.repo);
    const msg =
      `nightly ${date}: curve point and scores (train L3 ${pct(json.score.train.L3)}, held-out L3 ${pct(json.score.heldOut.L3)}; ` +
      `${ceilingText(noise, oracle.oracleSeqs, Boolean(point.noise?.overall))}; oracle ${oracleRefreshed ? "refreshed" : "not refreshed"})` +
      `${d.file ? `; drift: ${d.items.length} paths` : ""}\n\nSealed log run ${runId} (data repo ${dataCommit}); oracle ${oracle.oracleSeqs} sequences, sha256 ${oracle.oracleSha}.`;
    run("git", ["commit", "-q", "-m", msg, "--", ...files], o.repo);
    // This commit is cited by nothing, so it may be rebased onto a main that moved during the night.
    run("git", ["pull", "-q", "--rebase", "origin", branch], o.repo);
    run("git", ["push", "-q", "origin", `HEAD:${branch}`], o.repo);
    run("git", ["push", "-q"], data);
    commits = { data: dataCommit, parity: run("git", ["rev-parse", "HEAD"], o.repo) };
  }
  return {
    date,
    runId,
    ...(tmp && { tmp }),
    slice: sliceRes,
    ...(noisePair && { noisePair }),
    oracleRefreshed,
    built,
    oracle,
    score: json.score,
    ...(noise && { noise }),
    plan: planText(plan),
    assist: assisted,
    merged,
    patches,
    events,
    drift: d,
    published,
    ...(commits && { commits }),
  };
}

const levels = (s: LevelScores): string => (["L1", "L2", "L3", "L4"] as const).map((l) => `${l} ${(s[l].p * 100).toFixed(1)}%`).join(" ");

/** 9. The summary. */
export function nightlyText(r: NightlyResult): string {
  const d = r.drift;
  return [
    `nightly ${r.date} run ${r.runId}${r.tmp ? ` · DRY RUN: nothing recorded, applied, assisted, committed or pushed; data copy and public files in ${r.tmp}` : ""}`,
    `slice ${r.slice.spec}: ${r.slice.seqs} sequences · ${r.tmp ? "not recorded (dry run)" : r.slice.refused ? `NOT RECORDED: ${r.slice.refused}` : `recorded, ${r.slice.recorded} clean`}`,
    ...(r.noisePair ? [`noise pair: ${r.noisePair.seqs} sequences x 2 · ${r.tmp ? "not recorded (dry run)" : r.noisePair.recorded ? "recorded" : `NOT RECORDED: ${r.noisePair.refused ?? "the slice was refused"}`}`] : []),
    `${r.built} · sha256 ${r.oracle.oracleSha.slice(0, 12)}… · ${r.oracleRefreshed ? "refreshed tonight" : "NOT refreshed tonight (curve point oracleRefreshed: false)"}`,
    `score: train ${levels(r.score.train)} · held-out ${levels(r.score.heldOut)}`,
    r.noise
      ? `noise ceiling: ${levels(r.noise.overall)} from ${r.noise.pair.join(" vs ")} (${r.noise.seqs} of ${r.score.overall.L4.n} oracle sequences${r.noise.inSample ? "; in-sample: the normalization was written from this pair" : ""})`
      : "noise ceiling: none (no noise-a/noise-b pair with clean sequences): the page marks the night invalid",
    r.plan,
    r.assist,
    `merged align/assisted-* PRs newly logged: ${r.merged} · patches since the scaffold freeze (sealed log): automatic ${r.patches.automatic}, assisted ${r.patches.assisted}`,
    `curve annotations: ${r.events.join("; ") || "none"}`,
    d.file
      ? `drift: ${d.items.length} paths in ${d.compared} sequences compared -> ${d.file}${d.withheld ? ` (${d.withheld} fraud or risk divergences withheld)` : ""}`
      : `drift: nothing to report (${d.compared} sequences compared${d.withheld ? `, ${d.withheld} fraud or risk divergences withheld` : ""}); sealed-log note`,
    `${r.tmp ? `written under ${r.tmp}/parity (dry run)` : "published"}: ${r.published.join(", ")}`,
    r.commits ? `commits: parity ${r.commits.parity} pushed, then data repo ${r.commits.data} pushed` : "commits: none (dry run)",
  ].join("\n");
}
