#!/usr/bin/env node
// paritybench: record a corpus against a target, compare recordings, bench a URL against an oracle, build the oracle,
// serve the twin, score the twin against an oracle.
import { randomInt } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TEMPLATES } from "../templates/index.ts";
import { appendLedger, readLedger, rollingGets, type LedgerEntry } from "./bench/budget.ts";
import { compareRecordings, noiseKeys } from "./bench/compare.ts";
import { buildCorpus, parseSeeds } from "./bench/corpus.ts";
import { NORMALIZATION_VERSION, normalizeRaw, normalizeRecording } from "./bench/normalize.ts";
import { buildOracle, dataDir } from "./bench/oracle.ts";
import { renderMarkdown, toJson, type ReportInput } from "./bench/report.ts";
import { idsIn, runCorpus, sandboxTarget, touching, type Target } from "./bench/run.ts";
import { score } from "./bench/score.ts";
import { readJsonl, writeJsonl } from "./jsonl.ts";
import type { Recording, Sequence, Template } from "./types.ts";

const USAGE = `usage:
  paritybench record --target <sandbox|URL> [--name N] [--templates all|a,b] [--seeds 1-20] [--slice k/n] [--concurrency 8]
                     [--chunk <n> --chunk-wait <minutes>] [--out <file>]
  paritybench compare --oracle A.jsonl --target B.jsonl [--noise C.jsonl] [--raw] --out reports/<name>
  paritybench bench <baseURL> --oracle A.jsonl [--noise C.jsonl] [--out recordings/<date>/bench-<name>-<runId>]
  paritybench oracle build [--max-age-days N]
  paritybench twin [--port 12111] [--host 127.0.0.1]
  paritybench score-twin --oracle A.jsonl [--templates all|a,b] [--noise C.jsonl] [--json out.json] [--recordings twin.jsonl]
  paritybench align [--apply | --assist] [--max-batches N]
  paritybench nightly [--dry-run]
  paritybench help

  Sandbox key: STRIPE_API_KEY (.env). URL targets: PARITY_TARGET_KEY or sk_test_parity.
  Sandbox GET budget: PARITY_READ_BUDGET (default 10000) per rolling 30 days, ledger <dataDir>/budget/reads.jsonl (private:
    it names the account; seeded once from this repo's old budget/reads.jsonl).
  Data dir: PARITY_DATA_DIR, else ../parity-data next to the repo if present, else recordings/.
  record --out default: <dataDir>/runs/<date>/<name>-<runId>.jsonl on the sandbox, recordings/<date>/<name>-<runId>.jsonl elsewhere.
  --slice k/n: only the corpus sequences whose index (templates x seeds order) is k mod n.
  --chunk n --chunk-wait m: run n sequences at a time, m minutes apart (each chunk ledgered and written as it ends).
  bench sends Parity-Now: <oracle recording's startedAt, epoch seconds> on every step of each sequence (not to the sandbox),
    and its event sweep starts at the earliest Parity-Now − 60 s.
  oracle build: newest clean sandbox recording per sequence in <dataDir>/runs/** -> <dataDir>/oracle.jsonl.
  --noise C.jsonl: a second sandbox recording of the oracle's corpus; oracle-vs-C is the noise floor.
  twin: serves the twin until SIGINT/SIGTERM (port also from env PORT).
  score-twin: the oracle's sequences (optionally only --templates) against a fresh in-process twin on an ephemeral port,
    with Parity-Now per sequence as in bench, step waits skipped and events read from the twin's store; the Markdown
    report goes to stdout, --json writes the results and score, --recordings the twin's recordings.
  align: score-twin on <dataDir>/oracle.jsonl, triage every divergence to a locus, propose mechanical data-file edits
    (src/twin/shapes/*.json, src/twin/errors.json) from train sequences only, and gate them in a temp copy of the repo
    (held-out L3 must not drop, train divergences must fall). Prints the plan. --apply writes the accepted edits, commits
    them, then appends them to the sealed log <dataDir>/align/log.jsonl. --max-batches: gate only the first N per-file batches.
    --assist (after the plan, on HEAD; run align --apply first): the LLM proposes one twin code file per non-mechanical
    locus (top 3); a reply that passes the same gate becomes a branch align/assisted-<date>-<n> and a draft PR (gh), never
    merged. Needs ANTHROPIC_API_KEY (else skipped and logged); model PARITY_LLM_MODEL (default claude-sonnet-5); every
    call's tokens and cost_usd go to budget/llm.jsonl; daily cap $15 (UTC), PARITY_LLM_CAP_USD may only lower it.
  nightly: record today's slice (--slice <UTC day of week>/7 of templates x seeds 1-20) on the sandbox at <=10 req/s, and on
    Sundays (UTC) the noise pair (all templates x seeds 1-2, --name noise-a then noise-b); oracle build; score-twin (a
    sealed-log score entry) with the noise ceiling from the latest noise-a/noise-b pair; align --apply; align --assist;
    log merged align/assisted-* PRs (gh); append site/data/curve.json and write site/data/scores/<date>.json; drift
    (drift/<date>.md + site/data/drift.json, or a note); commit and push the data repo, commit the public-safe files here
    (the workflow pushes). A refused or aborted recording (budget gate, circuit breaker) is noted and the night goes on
    with the existing oracle (curve point oracleRefreshed: false). Run from the repo root (.env).
    --dry-run: no sandbox traffic, no --apply, no --assist, no commits or pushes: runs on a temp copy of the data dir
    and writes the public files to a temp dir.
  compare/bench/score-twin outputs contain raw expected/actual values (Stripe data, decision 0001 C3): never commit them.`;

export const LEDGER = "budget/reads.jsonl";
const REPO_ROOT = resolve(import.meta.dirname, "..");
const FLAGS: Record<string, string[]> = {
  record: ["target", "name", "templates", "seeds", "slice", "concurrency", "chunk", "chunk-wait", "out"],
  compare: ["oracle", "target", "noise", "raw", "out"],
  bench: ["oracle", "noise", "out"],
  oracle: ["max-age-days"],
  twin: ["port", "host"],
  "score-twin": ["oracle", "templates", "noise", "json", "recordings"],
  align: ["apply", "assist", "max-batches"],
  nightly: ["dry-run"],
};

class UsageError extends Error {}

/** `--flag value` pairs (`--raw`, `--apply`, `--assist`, `--dry-run` take none) and positionals; unknown flags and missing values are usage errors. */
function parseArgs(cmd: string, argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!FLAGS[cmd]!.includes(name)) throw new UsageError(`unknown flag ${a} for ${cmd}`);
    if (name === "raw" || name === "apply" || name === "assist" || name === "dry-run") {
      flags[name] = "1";
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    flags[name] = v;
  }
  return { flags, positional };
}

function need(flags: Record<string, string>, k: string): string {
  const v = flags[k];
  if (v === undefined) throw new UsageError(`--${k} is required`);
  return v;
}

/** `--k` as a number > 0 (or >= 0 with `zero`), integer if asked; undefined when absent. */
function num(flags: Record<string, string>, k: string, o: { integer?: boolean; zero?: boolean } = {}): number | undefined {
  const v = flags[k];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || !(o.zero ? n >= 0 : n > 0) || (o.integer && !Number.isInteger(n))) {
    throw new UsageError(`--${k} must be a ${o.zero ? "non-negative" : "positive"} ${o.integer ? "integer" : "number"}, got "${v}"`);
  }
  return n;
}

/** `k/n` (0 <= k < n): the items whose index is k mod n. */
export function slice<T>(xs: T[], spec: string): T[] {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  const k = Number(m?.[1]);
  const n = Number(m?.[2]);
  if (!m || n < 1 || k >= n) throw new UsageError(`--slice must be k/n with 0 <= k < n, got "${spec}"`);
  return xs.filter((_, i) => i % n === k);
}

/** UTC `YYYYMMDDTHHMMSS-xxxx` (4 random base36): idempotency nonces derive from it and must never repeat. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomInt(36 ** 4).toString(36).padStart(4, "0")}`;
}

/** Refusal message when the run would push the rolling 30-day sandbox GETs over `budget` (decision 0001 C2), else null. */
export function budgetRefusal(ledger: LedgerEntry[], projected: number, nowIso: string, budget: number, path = LEDGER): string | null {
  const rolling = rollingGets(ledger, nowIso);
  if (rolling + projected <= budget) return null;
  return `refusing to run: ${rolling} sandbox GETs in the last 30 days + ${projected} projected for this run = ${rolling + projected} > read budget ${budget} (${path}; PARITY_READ_BUDGET; decision 0001 C2)`;
}

export function resolveTarget(spec: string, name?: string): Target {
  if (spec !== "sandbox" && !URL.canParse(spec)) throw new UsageError(`target must be "sandbox" or a URL, got "${spec}"`);
  // By host: a URL naming api.stripe.com is the sandbox and gets its 20 req/s bucket and event wait, never a URL target's unthrottled defaults.
  if (spec === "sandbox" || new URL(spec).hostname === "api.stripe.com") {
    const key = process.env.STRIPE_API_KEY;
    if (!key) throw new Error("STRIPE_API_KEY is not set (put it in .env)");
    return sandboxTarget(key);
  }
  // `oracle build` trusts recordings whose target is "sandbox"; another server must not borrow the name.
  if (name === "sandbox") throw new UsageError(`--name sandbox is reserved for the Stripe sandbox (target ${spec})`);
  return { name: name ?? spec, baseUrl: spec.replace(/\/+$/, ""), apiKey: process.env.PARITY_TARGET_KEY ?? "sk_test_parity" };
}

/**
 * The sandbox read ledger <dir>/budget/reads.jsonl. It names the Stripe account, so it lives in the private data repo
 * (decision 0001 C3), never in this one. Seeded from `legacy` (this repo's old ledger) when absent, so the rolling 30-day
 * count keeps its history. ponytail: one-time migration; drop `legacy` once the data repo carries its own ledger.
 */
export function readsLedger(dir: string, legacy = join(REPO_ROOT, LEDGER)): string {
  const path = join(dir, LEDGER);
  if (!existsSync(path) && existsSync(legacy)) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(legacy, path);
  }
  return path;
}

const fileName = (spec: string, name?: string): string => name ?? (spec === "sandbox" ? "sandbox" : new URL(spec).host.replace(/[^A-Za-z0-9.-]/g, "-"));
const today = (): string => new Date().toISOString().slice(0, 10);

const isSandbox = (t: Target): boolean => new URL(t.baseUrl).hostname === "api.stripe.com";

interface RecordOpts {
  concurrency: number;
  /** Read ledger (default readsLedger(dataDir())). */
  ledger?: string;
  runId: string;
  out: string;
  headersFor?: (seq: Sequence) => Record<string, string>;
  /** Sequences per chunk and minutes between chunks (the claimable key's quota: ~460 requests per ~20 min is safe). */
  chunk?: number;
  chunkWaitMin?: number;
}

/**
 * Runs `seqs` against `target` (budget-gated and ledgered on the sandbox), writes the recordings, prints a summary.
 * Chunked runs ledger and rewrite `out` after every chunk. A circuit-breaker abort is ledgered and written, then thrown.
 */
export async function recordCorpus(target: Target, seqs: Sequence[], o: RecordOpts): Promise<Recording[]> {
  if (!seqs.length) throw new Error("no sequences to run");
  const ledger = o.ledger ?? readsLedger(dataDir());
  // By host, not name: `--target https://api.stripe.com` or `--name sandbox` must not dodge (or fake) the budget.
  const sandbox = isSandbox(target);
  const budget = Number(process.env.PARITY_READ_BUDGET ?? 10_000);
  if (sandbox) {
    const sweep = Math.ceil((10.5 * seqs.length) / 100) * 5;
    const projected = seqs.flatMap((s) => s.steps).filter((s) => s.method === "GET").length + sweep;
    const refusal = budgetRefusal(readLedger(ledger), projected, new Date().toISOString(), budget, ledger);
    if (refusal) throw new Error(refusal);
    console.log(`projected sandbox GETs: ${projected} (GET steps + ${sweep} for the event sweep: ceil(10.5 events/sequence / 100 per page) x 5 passes)`);
  }
  const size = o.chunk ?? seqs.length;
  const chunks = Math.ceil(seqs.length / size);
  console.log(
    `run ${o.runId}: ${seqs.length} sequences against ${target.name} at concurrency ${o.concurrency}` +
      (chunks > 1 ? ` in ${chunks} chunks of ${size}, ${o.chunkWaitMin ?? 0} min apart` : ""),
  );
  const recordings: Recording[] = [];
  for (let c = 0; c < chunks; c++) {
    if (c > 0) {
      console.log(`waiting ${o.chunkWaitMin ?? 0} min before chunk ${c + 1}/${chunks}`);
      await sleep((o.chunkWaitMin ?? 0) * 60_000);
    }
    const part = seqs.slice(c * size, (c + 1) * size);
    const t0 = performance.now();
    let done = 0;
    let stepsEnd = t0;
    // ponytail: an interrupted sandbox run (Ctrl-C) loses its current chunk's ledger entry; add a signal handler if runs get long.
    const { recordings: recs, summary } = await runCorpus(part, target, {
      concurrency: o.concurrency,
      runId: o.runId,
      headersFor: o.headersFor,
      onRecord: () => {
        stepsEnd = performance.now();
        if (++done % 10 === 0) console.log(`  ${done}/${part.length} sequences`);
      },
    });
    const wall = (performance.now() - t0) / 1000;
    const stepsWall = (stepsEnd - t0) / 1000;
    recordings.push(...recs);
    writeJsonl(o.out, recordings);

    const perHour = (s: number): string => (s > 0 ? Math.round((part.length * 3600) / s).toString() : "—");
    const charges = new Set(recs.flatMap((r) => r.events).filter((e) => e.type === "charge.succeeded").map((e) => e.id)).size;
    const eventsFailed = recs.filter((r) => r.eventsError).length;
    console.log(
      [
        `${chunks > 1 ? `chunk ${c + 1}/${chunks}: ` : ""}sequences ${part.length} · requests ${summary.requests} (GET ${summary.gets} incl. ${summary.eventSweepGets} event-sweep, POST ${summary.posts}, DELETE ${summary.deletes}) · 429 retries ${summary.retries429}`,
        `wall ${wall.toFixed(1)} s (steps ${stepsWall.toFixed(1)} s + event sweep ${(wall - stepsWall).toFixed(1)} s) · sequences/hour ${perHour(stepsWall)} on steps, ${perHour(wall)} on wall`,
        `charge.succeeded events ${charges} · event overlaps ${summary.eventOverlaps}${eventsFailed ? ` · EVENT COLLECTION FAILED for ${eventsFailed} sequences: ${recs.find((r) => r.eventsError)!.eventsError}` : ""}`,
      ].join("\n"),
    );
    if (sandbox) {
      const date = new Date().toISOString();
      const account = process.env.STRIPE_SANDBOX_ACCOUNT ?? "unknown";
      appendLedger(ledger, { date, account, target: target.name, runId: o.runId, gets: summary.gets, posts: summary.posts, deletes: summary.deletes, charges });
      console.log(`rolling 30-day sandbox GETs: ${rollingGets(readLedger(ledger), date)} / ${budget} (ledger ${ledger})`);
    }
    if (summary.aborted) {
      throw new Error(`${summary.aborted}; ${seqs.length - recordings.length} sequences not run; recordings flagged (status 0, eventsError) in ${o.out}`);
    }
  }
  console.log(`wrote ${o.out}`);
  return recordings;
}

/** `oracle build`: writes <dir>/oracle.jsonl; returns counts per template and the date range. */
export function oracleBuild(maxAgeDays: number | undefined, dir = dataDir()): string {
  const b = buildOracle(dir, maxAgeDays === undefined ? -Infinity : Date.now() - maxAgeDays * 86_400_000);
  const excluded = `${b.contaminated} contaminated (a step with status 0 or 429, or eventsError)${maxAgeDays === undefined ? "" : `, ${b.tooOld} older than ${maxAgeDays} days`}`;
  if (!b.oracle.length) throw new Error(`no eligible sandbox recordings under ${join(dir, "runs")} (${b.sandbox} scanned; excluded ${excluded})`);
  const out = join(dir, "oracle.jsonl");
  writeJsonl(out, b.oracle);
  const perTemplate = new Map<string, number>();
  for (const r of b.oracle) perTemplate.set(r.template, (perTemplate.get(r.template) ?? 0) + 1);
  const started = b.oracle.map((r) => r.startedAt).sort();
  return [
    `oracle: ${b.oracle.length} sequences, newest clean per sequence, from ${b.sandbox} sandbox recordings in ${b.files} files; excluded ${excluded}`,
    ...[...perTemplate].map(([t, n]) => `  ${t} ${n}`),
    `oldest ${started[0]} · newest ${started.at(-1)}`,
    `wrote ${out}`,
  ].join("\n");
}

/** Recordings named for error messages (a file path). */
export type Side = [name: string, recordings: Recording[]];

/** Normalizes (or not), pairs each side with the oracle by `seq` (oracle order), compares and scores; `noise` is the floor and marks NONDETERMINISTIC. */
export function compareSets(oracleRecs: Recording[], target: Side, noise: Side | undefined, raw: boolean): Pick<ReportInput, "score" | "noise" | "normalization" | "results"> {
  const norm = raw ? normalizeRaw : normalizeRecording;
  const oracle = oracleRecs.map(norm);
  const paired = ([name, recs]: Side): Recording[] => {
    const bySeq = new Map(recs.map((r) => [r.seq, r]));
    return oracle.map((o) => {
      const r = bySeq.get(o.seq);
      if (!r) throw new Error(`${name} has no recording for oracle sequence ${o.seq}`);
      return norm(r);
    });
  };
  const floor = noise && paired(noise).map((c, i) => compareRecordings(oracle[i]!, c));
  const keys = floor && noiseKeys(floor);
  const results = paired(target).map((t, i) => compareRecordings(oracle[i]!, t, keys));
  return { score: score(results), noise: floor && score(floor), normalization: raw ? "raw" : NORMALIZATION_VERSION, results };
}

const side = (path: string): Side => [path, readJsonl<Recording>(path)];

/** `compare`: writes `<out>.md` + `<out>.json`. */
function compareFiles(oraclePath: string, targetPath: string, noisePath: string | undefined, raw: boolean, out: string): void {
  const input: ReportInput = {
    title: `ParityBench: ${basename(targetPath)} vs ${basename(oraclePath)}`,
    date: today(),
    target: basename(targetPath),
    oracle: basename(oraclePath),
    ...compareSets(readJsonl<Recording>(oraclePath), side(targetPath), noisePath === undefined ? undefined : side(noisePath), raw),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.md`, renderMarkdown(input));
  writeFileSync(`${out}.json`, JSON.stringify(toJson(input), null, 2) + "\n");
  const o = input.score.overall;
  const pct = (l: keyof typeof o): string => `${l} ${(o[l].p * 100).toFixed(1)}%`;
  console.log(`${input.results.length} sequences · ${pct("L1")} · ${pct("L2")} · ${pct("L3")} · ${pct("L4")} (${input.normalization})`);
  console.log(`wrote ${out}.md and ${out}.json`);
}

/** The oracle's exact (template, seed) sequences, and headers pinning each one's clock to its oracle recording's start. */
function replay(oracle: Recording[]): { seqs: Sequence[]; headersFor: (s: Sequence) => Record<string, string> } {
  const seqs = oracle.map((r) => buildCorpus([TEMPLATES.find((t) => t.name === r.template) ?? badTemplate(r.template)], [r.seed])[0]!);
  // The oracle's clock: a twin answers as of the day the oracle was recorded (decision 0002 §4.4); other targets ignore it.
  const now = new Map(oracle.map((r) => [r.seq, String(Math.floor(Date.parse(r.startedAt) / 1000))]));
  return { seqs, headersFor: (s) => ({ "Parity-Now": now.get(s.id)! }) };
}

/** `score-twin`: the oracle's sequences against a fresh in-process twin; Markdown report to stdout, results + score to `jsonOut`. */
async function scoreTwin(oraclePath: string, templates: Template[], noisePath: string | undefined, jsonOut: string | undefined, recOut: string | undefined): Promise<void> {
  const names = new Set(templates.map((t) => t.name));
  const oracle = readJsonl<Recording>(oraclePath).filter((r) => names.has(r.template));
  if (!oracle.length) throw new Error(`${oraclePath} has no sequence of ${[...names].join(", ")}`);
  const { seqs, headersFor } = replay(oracle);
  // The twin is consistent at once: waits for the sandbox's eventual consistency (customer-search: 60 s) are skipped.
  const unwaited = seqs.map((s) => ({ ...s, steps: s.steps.map(({ waitMs: _, ...step }) => step) }));
  const { createTwin } = await import("./twin/server.ts"); // loads every resource and the pruned spec: only for this command
  const twin = createTwin();
  const server = await twin.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const t0 = performance.now();
  const { recordings, summary } = await runCorpus(unwaited, { name: "twin", baseUrl, apiKey: "sk_test_parity", eventWaitMs: 0 }, { concurrency: 8, runId: newRunId(), headersFor }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  // Events from the twin's store, not a /v1/events sweep: the sweep asks for created >= wall-clock start, and the twin
  // stamps events with Parity-Now (the oracle's day). The store is this run's alone, so it holds exactly the run's events.
  for (const r of recordings) r.events = touching(idsIn(r.steps), twin.store.events);
  const t1 = performance.now();
  const input: ReportInput = {
    title: `ParityBench: twin vs ${basename(oraclePath)}`,
    date: today(),
    target: "twin",
    oracle: basename(oraclePath),
    ...compareSets(oracle, ["twin", recordings], noisePath === undefined ? undefined : side(noisePath), false),
  };
  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, JSON.stringify(toJson(input), null, 2) + "\n");
  }
  if (recOut) writeJsonl(recOut, recordings);
  console.log(renderMarkdown(input));
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  console.error(
    `score-twin: ${oracle.length} sequences, ${summary.requests} requests: twin ${s(t1 - t0)}, compare ${s(performance.now() - t1)}` +
      (jsonOut ? `; wrote ${jsonOut}` : ""),
  );
}

export async function main(argv: string[]): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "help" || cmd === "--help" || cmd === "-h") {
      console.log(USAGE);
      return 0;
    }
    if (cmd === undefined || !FLAGS[cmd]) throw new UsageError(cmd === undefined ? "no command" : `unknown command "${cmd}"`);
    const { flags, positional } = parseArgs(cmd, rest);
    if (cmd === "oracle") {
      if (positional.join(" ") !== "build") throw new UsageError(`expected "oracle build", got "oracle ${positional.join(" ")}"`);
      console.log(oracleBuild(num(flags, "max-age-days")));
      return 0;
    }
    if (positional.length !== (cmd === "bench" ? 1 : 0)) throw new UsageError(`unexpected arguments: ${positional.join(" ") || "(missing <baseURL>)"}`);

    if (cmd === "twin") return (await import("./twin/main.ts")).main(rest);
    if (cmd === "score-twin") {
      await scoreTwin(need(flags, "oracle"), pickTemplates(flags.templates), flags.noise, flags.json, flags.recordings);
      return 0;
    }
    if (cmd === "align") {
      // The assisted pass gates against HEAD and branches from it: after an --apply commit that baseline is stale.
      if (flags.apply && flags.assist) throw new UsageError("--apply and --assist are separate runs: align --apply, then align --assist");
      const { align, planText } = await import("./align/index.ts");
      const r = align({ repo: REPO_ROOT, dataDir: dataDir(), runId: newRunId(), apply: flags.apply === "1", maxBatches: num(flags, "max-batches", { integer: true }) });
      console.log(planText(r));
      if (flags.assist) {
        const { assist, assistText } = await import("./align/assist.ts");
        console.log(assistText(await assist(r, { repo: REPO_ROOT, dataDir: dataDir(), runId: r.runId })));
      }
      return 0;
    }

    if (cmd === "nightly") {
      const { nightly, nightlyText } = await import("./nightly.ts");
      console.log(nightlyText(await nightly({ repo: REPO_ROOT, dataDir: dataDir(), dryRun: flags["dry-run"] === "1" })));
      return 0;
    }

    if (cmd === "compare") {
      compareFiles(need(flags, "oracle"), need(flags, "target"), flags.noise, flags.raw === "1", need(flags, "out"));
      return 0;
    }

    const runId = newRunId();
    if (cmd === "record") {
      const spec = need(flags, "target");
      const target = resolveTarget(spec, flags.name);
      const templates = pickTemplates(flags.templates);
      let seeds: number[];
      try {
        seeds = parseSeeds(flags.seeds ?? "1-20");
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      const concurrency = num(flags, "concurrency", { integer: true }) ?? 8;
      const chunk = num(flags, "chunk", { integer: true });
      const chunkWaitMin = num(flags, "chunk-wait", { zero: true });
      if (chunkWaitMin !== undefined && chunk === undefined) throw new UsageError("--chunk-wait needs --chunk");
      const corpus = buildCorpus(templates, seeds);
      const seqs = flags.slice === undefined ? corpus : slice(corpus, flags.slice);
      const dir = isSandbox(target) ? join(dataDir(), "runs") : "recordings";
      const out = flags.out ?? join(dir, today(), `${fileName(spec, flags.name)}-${runId}.jsonl`);
      await recordCorpus(target, seqs, { concurrency, runId, out, chunk, chunkWaitMin });
      return 0;
    }

    // bench: re-record the oracle's exact (template, seed) pairs against the URL, then compare.
    const url = positional[0]!;
    const oraclePath = need(flags, "oracle");
    const { seqs, headersFor } = replay(readJsonl<Recording>(oraclePath));
    const target = resolveTarget(url);
    const name = fileName(url);
    const recPath = `recordings/${today()}/${name}-${runId}.jsonl`;
    // The sandbox ignores Parity-Now; sending it would also move the event sweep back to the oracle's day (outside the budget's projection).
    await recordCorpus(target, seqs, { concurrency: 8, runId, out: recPath, headersFor: isSandbox(target) ? undefined : headersFor });
    compareFiles(oraclePath, recPath, flags.noise, false, flags.out ?? `recordings/${today()}/bench-${name}-${runId}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`paritybench: ${e.message}\n${USAGE}`);
      return 2;
    }
    console.error(`paritybench: ${(e as Error).message}`);
    return 1;
  }
}

/** `all` (the default) or comma-separated template names. */
function pickTemplates(spec = "all"): Template[] {
  const names = spec.split(",");
  return names[0] === "all" ? TEMPLATES : names.map((n) => TEMPLATES.find((t) => t.name === n) ?? badTemplate(n));
}

function badTemplate(name: string): never {
  throw new UsageError(`unknown template "${name}"; known: ${TEMPLATES.map((t) => t.name).join(", ")}`);
}

// No top-level await: nightly.ts imports this module, and a pending await here would deadlock that import.
if (import.meta.main) void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
