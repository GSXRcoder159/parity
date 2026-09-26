#!/usr/bin/env node
// paritybench: record a corpus against a target, compare recordings, bench a URL against an oracle.
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { appendLedger, readLedger, rollingGets, type LedgerEntry } from "./bench/budget.ts";
import { compareRecordings, noiseKeys } from "./bench/compare.ts";
import { buildCorpus, parseSeeds } from "./bench/corpus.ts";
import { NORMALIZATION_VERSION, normalizeRaw, normalizeRecording } from "./bench/normalize.ts";
import { renderMarkdown, toJson, type ReportInput } from "./bench/report.ts";
import { runCorpus, sandboxTarget, type Target } from "./bench/run.ts";
import { score } from "./bench/score.ts";
import { readJsonl, writeJsonl } from "./jsonl.ts";
import type { Recording, Sequence } from "./types.ts";

const USAGE = `usage:
  paritybench record --target <sandbox|URL> [--name N] [--templates all|a,b] [--seeds 1-20] [--concurrency 8] [--out recordings/<date>/<name>-<runId>.jsonl]
  paritybench compare --oracle A.jsonl --target B.jsonl [--noise C.jsonl] [--raw] --out reports/<name>
  paritybench bench <baseURL> --oracle A.jsonl [--noise C.jsonl] [--out recordings/<date>/bench-<name>-<runId>]
  paritybench help

  Sandbox key: STRIPE_API_KEY (.env). URL targets: PARITY_TARGET_KEY or sk_test_parity.
  Sandbox GET budget: PARITY_READ_BUDGET (default 10000) per rolling 30 days, ledger budget/reads.jsonl.
  --noise C.jsonl: a second sandbox recording of the oracle's corpus; oracle-vs-C is the noise floor.
  compare/bench outputs contain raw expected/actual values (Stripe data, decision 0001 C3): never commit them.`;

const LEDGER = "budget/reads.jsonl";
const FLAGS: Record<string, string[]> = {
  record: ["target", "name", "templates", "seeds", "concurrency", "out"],
  compare: ["oracle", "target", "noise", "raw", "out"],
  bench: ["oracle", "noise", "out"],
};

class UsageError extends Error {}

/** `--flag value` pairs (`--raw` takes none) and positionals; unknown flags and missing values are usage errors. */
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
    if (name === "raw") {
      flags.raw = "1";
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

/** UTC `YYYYMMDDTHHMMSS-xxxx` (4 random base36): idempotency nonces derive from it and must never repeat. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomInt(36 ** 4).toString(36).padStart(4, "0")}`;
}

/** Refusal message when the run would push the rolling 30-day sandbox GETs over `budget` (decision 0001 C2), else null. */
export function budgetRefusal(ledger: LedgerEntry[], projected: number, nowIso: string, budget: number): string | null {
  const rolling = rollingGets(ledger, nowIso);
  if (rolling + projected <= budget) return null;
  return `refusing to run: ${rolling} sandbox GETs in the last 30 days + ${projected} projected for this run = ${rolling + projected} > read budget ${budget} (${LEDGER}; PARITY_READ_BUDGET; decision 0001 C2)`;
}

export function resolveTarget(spec: string, name?: string): Target {
  if (spec !== "sandbox" && !URL.canParse(spec)) throw new UsageError(`target must be "sandbox" or a URL, got "${spec}"`);
  // By host: a URL naming api.stripe.com is the sandbox and gets its 20 req/s bucket and event wait, never a URL target's unthrottled defaults.
  if (spec === "sandbox" || new URL(spec).hostname === "api.stripe.com") {
    const key = process.env.STRIPE_API_KEY;
    if (!key) throw new Error("STRIPE_API_KEY is not set (put it in .env)");
    return sandboxTarget(key);
  }
  return { name: name ?? spec, baseUrl: spec.replace(/\/+$/, ""), apiKey: process.env.PARITY_TARGET_KEY ?? "sk_test_parity" };
}

const fileName = (spec: string, name?: string): string => name ?? (spec === "sandbox" ? "sandbox" : new URL(spec).host.replace(/[^A-Za-z0-9.-]/g, "-"));
const today = (): string => new Date().toISOString().slice(0, 10);

/** Runs `seqs` against `target` (budget-gated and ledgered on the sandbox), writes the recordings, prints a summary. */
async function recordCorpus(target: Target, seqs: Sequence[], concurrency: number, runId: string, out: string): Promise<Recording[]> {
  // By host, not name: `--target https://api.stripe.com` or `--name sandbox` must not dodge (or fake) the budget.
  const sandbox = new URL(target.baseUrl).hostname === "api.stripe.com";
  const budget = Number(process.env.PARITY_READ_BUDGET ?? 10_000);
  if (sandbox) {
    const projected = seqs.flatMap((s) => s.steps).filter((s) => s.method === "GET").length + 20;
    const refusal = budgetRefusal(readLedger(LEDGER), projected, new Date().toISOString(), budget);
    if (refusal) throw new Error(refusal);
    console.log(`projected sandbox GETs: ${projected} (GET steps + 20 for the event sweep)`);
  }
  console.log(`run ${runId}: ${seqs.length} sequences against ${target.name} at concurrency ${concurrency}`);
  const t0 = performance.now();
  let done = 0;
  let stepsEnd = t0;
  // ponytail: an interrupted sandbox run (Ctrl-C) is not ledgered; add a signal handler if runs get long.
  const { recordings, summary } = await runCorpus(seqs, target, {
    concurrency,
    runId,
    onRecord: () => {
      stepsEnd = performance.now();
      if (++done % 10 === 0) console.log(`  ${done}/${seqs.length} sequences`);
    },
  });
  const wall = (performance.now() - t0) / 1000;
  const stepsWall = (stepsEnd - t0) / 1000;
  writeJsonl(out, recordings);

  const perHour = (s: number): string => (s > 0 ? Math.round((seqs.length * 3600) / s).toString() : "—");
  const charges = new Set(recordings.flatMap((r) => r.events).filter((e) => e.type === "charge.succeeded").map((e) => e.id)).size;
  const eventsFailed = recordings.filter((r) => r.eventsError).length;
  console.log(
    [
      `sequences ${seqs.length} · requests ${summary.requests} (GET ${summary.gets} incl. ${summary.eventSweepGets} event-sweep, POST ${summary.posts}, DELETE ${summary.deletes}) · 429 retries ${summary.retries429}`,
      `wall ${wall.toFixed(1)} s (steps ${stepsWall.toFixed(1)} s + event sweep ${(wall - stepsWall).toFixed(1)} s) · sequences/hour ${perHour(stepsWall)} on steps, ${perHour(wall)} on wall`,
      `charge.succeeded events ${charges} · event overlaps ${summary.eventOverlaps}${eventsFailed ? ` · EVENT COLLECTION FAILED for ${eventsFailed} sequences: ${recordings.find((r) => r.eventsError)!.eventsError}` : ""}`,
    ].join("\n"),
  );
  if (sandbox) {
    const date = new Date().toISOString();
    const account = process.env.STRIPE_SANDBOX_ACCOUNT ?? "unknown";
    appendLedger(LEDGER, { date, account, target: target.name, runId, gets: summary.gets, posts: summary.posts, deletes: summary.deletes, charges });
    console.log(`rolling 30-day sandbox GETs: ${rollingGets(readLedger(LEDGER), date)} / ${budget} (ledger ${LEDGER})`);
  }
  console.log(`wrote ${out}`);
  return recordings;
}

/** Pairs by `seq` (oracle order), normalizes (or not), scores, and writes `<out>.md` + `<out>.json`. */
function compareFiles(oraclePath: string, targetPath: string, noisePath: string | undefined, raw: boolean, out: string): void {
  const norm = raw ? normalizeRaw : normalizeRecording;
  const oracle = readJsonl<Recording>(oraclePath).map(norm);
  const paired = (path: string): Recording[] => {
    const bySeq = new Map(readJsonl<Recording>(path).map((r) => [r.seq, r]));
    return oracle.map((o) => {
      const r = bySeq.get(o.seq);
      if (!r) throw new Error(`${path} has no recording for oracle sequence ${o.seq}`);
      return norm(r);
    });
  };
  const noise = noisePath === undefined ? undefined : paired(noisePath).map((c, i) => compareRecordings(oracle[i]!, c));
  const keys = noise && noiseKeys(noise);
  const results = paired(targetPath).map((t, i) => compareRecordings(oracle[i]!, t, keys));
  const input: ReportInput = {
    title: `ParityBench: ${basename(targetPath)} vs ${basename(oraclePath)}`,
    date: today(),
    target: basename(targetPath),
    oracle: basename(oraclePath),
    score: score(results),
    noise: noise && score(noise),
    normalization: raw ? "raw" : NORMALIZATION_VERSION,
    results,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.md`, renderMarkdown(input));
  writeFileSync(`${out}.json`, JSON.stringify(toJson(input), null, 2) + "\n");
  const o = input.score.overall;
  const pct = (l: keyof typeof o): string => `${l} ${(o[l].p * 100).toFixed(1)}%`;
  console.log(`${results.length} sequences · ${pct("L1")} · ${pct("L2")} · ${pct("L3")} · ${pct("L4")} (${input.normalization})`);
  console.log(`wrote ${out}.md and ${out}.json`);
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
    if (positional.length !== (cmd === "bench" ? 1 : 0)) throw new UsageError(`unexpected arguments: ${positional.join(" ") || "(missing <baseURL>)"}`);

    if (cmd === "compare") {
      compareFiles(need(flags, "oracle"), need(flags, "target"), flags.noise, flags.raw === "1", need(flags, "out"));
      return 0;
    }

    const runId = newRunId();
    if (cmd === "record") {
      const spec = need(flags, "target");
      const target = resolveTarget(spec, flags.name);
      const names = (flags.templates ?? "all").split(",");
      const templates = names[0] === "all" ? TEMPLATES : names.map((n) => TEMPLATES.find((t) => t.name === n) ?? badTemplate(n));
      let seeds: number[];
      try {
        seeds = parseSeeds(flags.seeds ?? "1-20");
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      const concurrency = Number(flags.concurrency ?? 8);
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError(`--concurrency must be a positive integer, got "${flags.concurrency}"`);
      const out = flags.out ?? `recordings/${today()}/${fileName(spec, flags.name)}-${runId}.jsonl`;
      await recordCorpus(target, buildCorpus(templates, seeds), concurrency, runId, out);
      return 0;
    }

    // bench: re-record the oracle's exact (template, seed) pairs against the URL, then compare.
    const url = positional[0]!;
    const oraclePath = need(flags, "oracle");
    const seqs = readJsonl<Recording>(oraclePath).map((r) => buildCorpus([TEMPLATES.find((t) => t.name === r.template) ?? badTemplate(r.template)], [r.seed])[0]!);
    const target = resolveTarget(url);
    const name = fileName(url);
    const recPath = `recordings/${today()}/${name}-${runId}.jsonl`;
    await recordCorpus(target, seqs, 8, runId, recPath);
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

function badTemplate(name: string): never {
  throw new UsageError(`unknown template "${name}"; known: ${TEMPLATES.map((t) => t.name).join(", ")}`);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
