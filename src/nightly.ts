// paritybench nightly (plan §3.3–§3.5; decision 0002 §1 rolling oracle, §3 what counts, §5 data locations): record
// tonight's sandbox slice (and weekly the noise pair), rebuild the oracle, score the twin on the whole oracle with the
// noise ceiling, align (mechanical, then assisted), log merged assisted PRs, publish the public-safe curve point and
// scores file, run drift, commit. A refused or aborted recording (budget gate, circuit breaker; decision 0001 C2) is a
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
import { compareSets, LEDGER, newRunId, oracleBuild, readsLedger, recordCorpus, Refused, resolveTarget, slice } from "./cli.ts";
import { drift, type DriftResult } from "./drift.ts";
import { readJsonl } from "./jsonl.ts";
import type { Recording, Sequence } from "./types.ts";

/** The noise pair's weekday (UTC; 0 = Sunday). */
const NOISE_DAY = 0;
/** The fixed noise subset: every template x these seeds (26 x 2 = 52 sequences), recorded twice back-to-back. */
const NOISE_SEEDS = [1, 2];
/** Decision 0001 C2: the nightly path runs at <=10 req/s (the sandbox target's default bucket is 20). */
const NIGHTLY_RPS = 10;
/** The corpus the slices rotate through: templates x seeds 1-20 (520 sequences, ~75 a night). */
const CORPUS_SEEDS = "1-20";

export type Noise = { overall: LevelScores; byStratum: Record<string, LevelScores> };
export type Patches = { automatic: number; assisted: number };

/** Records `seqs` on the sandbox at NIGHTLY_RPS into <dataDir>/runs/<date>/<name>-<runId>.jsonl: budget-gated, ledgered in <dataDir>/budget (seeded from the repo's old ledger). */
async function recordSandbox(repo: string, dataDir: string, date: string, name: string, seqs: Sequence[]): Promise<Recording[]> {
  const runId = newRunId(); // a fresh run id per recording: idempotency nonces derive from it and must never repeat
  const target = { ...resolveTarget("sandbox"), rps: NIGHTLY_RPS };
  return recordCorpus(target, seqs, { concurrency: 8, runId, out: join(dataDir, "runs", date, `${name}-${runId}.jsonl`), ledger: readsLedger(dataDir, join(repo, LEDGER)) });
}

/**
 * Tonight's normalization of the latest noise pair: the newest `noise-b-<runId>.jsonl` under <dataDir>/runs and the
 * newest `noise-a` recorded before it, on the sequences clean in both (compare --oracle a --target b, score only).
 * A pair with no clean sequence in common is skipped for the one before it. Undefined when there is none.
 */
function noiseFloor(dataDir: string): (Noise & { pair: [string, string]; seqs: number }) | undefined {
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
    return { overall, byStratum, pair: [a, b], seqs: as.length };
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
 * The night's public-safe files (the page's contract, site/app.js): a curve point and site/data/scores/<date>.json.
 * Scores only, no values or ids (decision 0001 C3). Without a noise pair `noise` is absent (the page marks the night
 * invalid); a stratum the pair does not cover has no noise.
 */
function publicFiles(o: { date: string; score: Score; results: SeqResult[]; noise?: Noise; events: string[]; patches: Patches; oracleRefreshed: boolean; oracleSeqs: number }) {
  const { date } = o;
  const s = o.score;
  const normalization = NORMALIZATION_VERSION;
  const noise = o.noise && { overall: o.noise.overall, byStratum: o.noise.byStratum };
  const point = { date, normalization, overall: s.overall, byStratum: s.byStratum, heldOut: s.heldOut, train: s.train, events: o.events, ...(noise && { noise }), patches: o.patches, oracleRefreshed: o.oracleRefreshed, oracleSeqs: o.oracleSeqs };
  const byStratum = Object.keys(s.byStratum)
    .sort()
    .map((k) => {
      const t = score(o.results.filter((r) => r.stratum === k));
      return [k, { train: t.train, heldOut: t.heldOut, noise: noise?.byStratum[k] }];
    });
  const scores = { date, normalization, overall: { train: s.train, heldOut: s.heldOut, noise: noise?.overall }, byStratum: Object.fromEntries(byStratum) };
  return { point, scores };
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
  noise?: Noise & { pair: [string, string]; seqs: number };
  plan: string;
  assist: string;
  merged: number;
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
  // Tonight's run files and read-ledger entries are pushed as soon as each recording ends (and when one fails), so a later
  // failure or a killed run cannot lose them: the next night's budget gate counts those reads (decision 0001 C2).
  const persist = (): void => {
    const paths = ["runs", "budget"].filter((p) => existsSync(join(data, p)));
    if (o.dryRun || !paths.length || !run("git", ["status", "--porcelain", "--", ...paths], data)) return;
    run("git", ["add", "-A", "--", ...paths], data);
    run("git", ["commit", "-q", "-m", `nightly ${date} run ${runId}: recordings and read ledger`, "--", ...paths], data);
    run("git", ["push", "-q"], data);
  };
  try {
    if (!o.dryRun) {
      try {
        today = await recordSandbox(o.repo, data, date, "slice", seqs);
        sliceRes.recorded = today.filter((r) => !contaminated(r)).length;
      } catch (e) {
        sliceRes.refused = refuse(`record slice ${spec}`, e);
      }
      persist(); // before a Sunday's noise pair: the slice's reads must not wait ~104 more sequences
    }
    if (dow === NOISE_DAY) {
      const noiseSeqs = buildCorpus(TEMPLATES, NOISE_SEEDS);
      noisePair = { seqs: noiseSeqs.length, recorded: false };
      // After a refused slice the sandbox is refusing: the pair waits for next week.
      if (!o.dryRun && !sliceRes.refused) {
        try {
          for (const name of ["noise-a", "noise-b"]) await recordSandbox(o.repo, data, date, name, noiseSeqs);
          noisePair.recorded = true;
        } catch (e) {
          noisePair.refused = refuse("record noise pair", e);
        }
      }
    }
  } finally {
    persist();
  }
  const oracleRefreshed = !o.dryRun && !sliceRes.refused;

  // 2. oracle build: newest clean recording per sequence (an aborted run is contaminated and never selected).
  const built = oracleBuild(undefined, data).split("\n")[0]!;
  const oracle = provenance(oraclePath);
  if (refused.length) appendLog(log, runId, refused.map((n) => ({ kind: "note", data: { nightly: { date, ...n, oracleRefreshed }, oracle } })));

  // 3. score-twin on the whole oracle, the noise ceiling from the latest pair, one sealed-log `score` entry.
  const { json } = scoreTwinIn(o.repo, oraclePath, []);
  const noise = noiseFloor(data);
  const commit = run("git", ["rev-parse", "HEAD"], o.repo);
  appendLog(log, runId, [{ kind: "score", data: { label: "nightly", date, commit, normalization: NORMALIZATION_VERSION, score: json.score, ...(noise && { noise }), oracleRefreshed, oracle } }]);

  // 4. align --apply (mechanical); plan only on a dry run.
  const plan = align({ repo: o.repo, dataDir: data, runId, apply: !o.dryRun });

  // 5. align --assist on HEAD (a fresh plan when --apply just committed: the old baseline is stale), then merged PRs.
  let assisted = "assist: not run (dry run)";
  if (!o.dryRun) {
    const base = plan.applied?.commit ? align({ repo: o.repo, dataDir: data, runId }) : plan;
    assisted = assistText(await assist(base, { repo: o.repo, dataDir: data, runId, env: o.env, run }));
  }
  const merged = logMerged({ repo: o.repo, log, runId, oracle, run });
  const patches = { automatic: plan.applied ? plan.gate.accepted.length : 0, assisted: merged };

  // 6. The public-safe curve point and scores file, then a `publish` entry: the next night's surface-added window starts here.
  const curveFile = join(root, "site/data/curve.json");
  const curve = existsSync(curveFile) ? (JSON.parse(readFileSync(curveFile, "utf8")) as { oracleSeqs?: number }[]) : [];
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

  // 8. Commit and push the data repo, then commit the public-safe files here (the workflow pushes this repo).
  let commits: NightlyResult["commits"];
  if (!o.dryRun) {
    const pct = (w: { p: number }) => `${(w.p * 100).toFixed(1)}%`;
    // The read ledger names the account: it is committed here, in the private data repo, never in the parity repo.
    run("git", ["add", "-A", "--", ...["runs", "oracle.jsonl", "align", "budget"].filter((p) => existsSync(join(data, p)))], data);
    run("git", ["commit", "-q", "-m", `nightly ${date} run ${runId}: slice ${spec} ${oracleRefreshed ? `recorded (${sliceRes.recorded} clean)` : "not recorded"}; oracle ${oracle.oracleSeqs} sequences, sha256 ${oracle.oracleSha}`], data);
    const dataCommit = run("git", ["rev-parse", "HEAD"], data);
    run("git", ["push", "-q"], data);
    // The LLM ledger (tokens and cost, no ids) rides along: the next run's daily cost cap reads it from this repo.
    const files = [...published, ...["budget/llm.jsonl"].filter((f) => existsSync(join(o.repo, f)))];
    run("git", ["add", "--", ...files], o.repo);
    const msg =
      `nightly ${date}: curve point and scores (train L3 ${pct(json.score.train.L3)}, held-out L3 ${pct(json.score.heldOut.L3)}; ` +
      `${noise ? `noise ceiling L3 ${pct(noise.overall.L3)}` : "no noise pair"}; oracle ${oracleRefreshed ? "refreshed" : "not refreshed"})` +
      `${d.file ? `; drift: ${d.items.length} paths` : ""}\n\nSealed log run ${runId} (data repo ${dataCommit}); oracle ${oracle.oracleSeqs} sequences, sha256 ${oracle.oracleSha}.`;
    run("git", ["commit", "-q", "-m", msg, "--", ...files], o.repo);
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
      ? `noise ceiling: ${levels(r.noise.overall)} from ${r.noise.pair.join(" vs ")} (${r.noise.seqs} sequences)`
      : "noise ceiling: none (no noise-a/noise-b pair with clean sequences): the page marks the night invalid",
    r.plan,
    r.assist,
    `merged align/assisted-* PRs newly logged: ${r.merged} · patches this night: automatic ${r.patches.automatic}, assisted ${r.patches.assisted}`,
    `curve annotations: ${r.events.join("; ") || "none"}`,
    d.file
      ? `drift: ${d.items.length} paths in ${d.compared} sequences compared -> ${d.file}${d.withheld ? ` (${d.withheld} fraud or risk divergences withheld)` : ""}`
      : `drift: nothing to report (${d.compared} sequences compared${d.withheld ? `, ${d.withheld} fraud or risk divergences withheld` : ""}); sealed-log note`,
    `${r.tmp ? `written under ${r.tmp}/parity (dry run)` : "published"}: ${r.published.join(", ")}`,
    r.commits ? `commits: data repo ${r.commits.data} pushed · parity ${r.commits.parity} (the workflow pushes it)` : "commits: none (dry run)",
  ].join("\n");
}
