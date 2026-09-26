// Baseline report helper (W1 Task 3). Three steps around `paritybench compare` / `bench`:
//   surface <routes.txt> <oracle.jsonl> <out.jsonl>          oracle restricted to templates whose every endpoint is in routes.txt
//   pair <oracle.jsonl> <outOracle.jsonl> <outNoise.jsonl> <run.jsonl>...   noise partner file + matching oracle subset
//   summarize --oracle <oracle.jsonl> --noise <compare.json> --out <report.json> <name>=<bench.json>...
// summarize writes a JSON with no response values (decision 0001 C3: paths, classes, statuses and counts only) and
// prints Markdown tables. Inputs are private (they hold raw recordings); only its output is committed.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { endpoint } from "../src/align/triage.ts";
import type { SeqResult } from "../src/bench/compare.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { NORMALIZATION_VERSION, RULES } from "../src/bench/normalize.ts";
import { contaminated } from "../src/bench/oracle.ts";
import { score, wilson, type LevelScores, type Wilson } from "../src/bench/score.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import type { Recording, Step } from "../src/types.ts";

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

const stepsOf = (template: string, seed: number): Step[] =>
  buildCorpus([TEMPLATES.find((t) => t.name === template)!], [seed])[0]!.steps;

function surface(routesPath: string, oraclePath: string, out: string): void {
  const served = new Set(readFileSync(routesPath, "utf8").split("\n").filter(Boolean).map((l) => endpoint(...(l.split(" ") as [string, string]))));
  const included: string[] = [];
  for (const t of TEMPLATES) {
    const eps = new Set(SEEDS.flatMap((s) => stepsOf(t.name, s).map((st) => endpoint(st.method, st.path))));
    const missing = [...eps].filter((e) => !served.has(e));
    if (missing.length) console.log(`excluded ${t.name}: ${missing.join(", ")}`);
    else included.push(t.name);
  }
  const oracle = readJsonl<Recording>(oraclePath).filter((r) => included.includes(r.template));
  writeJsonl(out, oracle);
  console.log(`included ${included.join(", ")}\nwrote ${out}: ${oracle.length} sequences`);
}

function pair(oraclePath: string, outOracle: string, outNoise: string, runs: string[]): void {
  const oracle = new Map(readJsonl<Recording>(oraclePath).map((r) => [r.seq, r]));
  const noise = new Map<string, Recording>();
  for (const r of runs.flatMap((p) => readJsonl<Recording>(p))) {
    const o = oracle.get(r.seq);
    // A partner is a clean, different recording of an oracle sequence.
    if (!o || contaminated(r) || o.runId === r.runId) continue;
    if (noise.has(r.seq)) throw new Error(`two noise recordings for ${r.seq}`);
    noise.set(r.seq, r);
  }
  writeJsonl(outNoise, [...noise.values()]);
  writeJsonl(outOracle, [...oracle.values()].filter((r) => noise.has(r.seq)));
  console.log(`wrote ${outOracle} and ${outNoise}: ${noise.size} pairs`);
}

interface Group {
  cls: string;
  endpoint: string;
  path: string;
  status?: string;
  count: number;
}

/** Divergences grouped by class, endpoint and path (array indices as [*]); STATUS_MISMATCH keeps its status pair. */
function groups(results: SeqResult[], noise?: Set<string>): Group[] {
  const g = new Map<string, Group>();
  for (const r of results) {
    const steps = stepsOf(r.template, Number(r.seq.split("#")[1]));
    for (const d of r.divergences) {
      const cls = noise?.has(`${r.template}|${d.step}|${d.path}`) ? "NONDETERMINISTIC" : d.cls;
      const ep = d.step < 0 ? "events" : endpoint(steps[d.step]!.method, steps[d.step]!.path);
      const path = d.path.replace(/\[\d+\]/g, "[*]");
      const status = cls === "STATUS_MISMATCH" ? `${d.expected}→${d.actual ?? "none"}` : undefined;
      const k = [cls, ep, path, status].join("|");
      const e = g.get(k) ?? g.set(k, { cls, endpoint: ep, path, ...(status && { status }), count: 0 }).get(k)!;
      e.count++;
    }
  }
  return [...g.values()].sort((a, b) => b.count - a.count);
}

const pct = (x: number): string => (x * 100).toFixed(1);
const cell = (w: Wilson): string => (w.n === 0 ? "—" : `${pct(w.p)}% [${pct(w.lo)}–${pct(w.hi)}] (${w.n})`);
const LV = ["L1", "L2", "L3", "L4"] as const;
const table = (title: string, rows: [string, LevelScores][]): string =>
  [`| ${title} | L1 status | L2 shape | L3 value | L4 sequence |`, "|---|---|---|---|---|", ...rows.map(([n, s]) => `| ${n} | ${LV.map((l) => cell(s[l])).join(" | ")} |`)].join("\n");
const byStratum = (s: ReturnType<typeof score>): [string, LevelScores][] => [
  ...Object.keys(s.byStratum).sort().map((k): [string, LevelScores] => [k, s.byStratum[k]!]),
  ["**all**", s.overall],
];
const perTemplate = (rs: SeqResult[]) =>
  [...new Set(rs.map((r) => r.template))].map((t) => {
    const x = rs.filter((r) => r.template === t);
    return { template: t, stratum: x[0]!.stratum, heldOut: x[0]!.heldOut, ...score(x).overall };
  });

function summarize(args: string[]): void {
  const flag = (k: string): string => {
    const i = args.indexOf(`--${k}`);
    if (i < 0 || !args[i + 1]) throw new Error(`--${k} is required`);
    return args.splice(i, 2)[1]!;
  };
  const oraclePath = flag("oracle");
  const noisePath = flag("noise");
  const out = flag("out");
  const oracle = readJsonl<Recording>(oraclePath);
  const started = oracle.map((r) => r.startedAt).sort();
  const noise = JSON.parse(readFileSync(noisePath, "utf8")) as { score: ReturnType<typeof score>; results: SeqResult[] };
  const keys = new Set(noise.results.flatMap((r) => r.divergences.map((d) => `${r.template}|${d.step}|${d.path}`)));
  const noiseFloor = (w: Wilson): Wilson => ({ ...w, p: 1 - w.p, lo: 1 - w.hi, hi: 1 - w.lo, k: w.n - w.k });

  const md: string[] = [];
  md.push("### Noise: agreement (= ceiling) per stratum", "", table("Stratum", byStratum(noise.score)), "");
  md.push("### Noise floor (1 − agreement)", "", table("Stratum", byStratum(noise.score).map(([n, s]) => [n, { L1: noiseFloor(s.L1), L2: noiseFloor(s.L2), L3: noiseFloor(s.L3), L4: noiseFloor(s.L4) }])), "");
  const noiseGroups = groups(noise.results);
  md.push("### Noise divergences", "", ...noiseGroups.map((g) => `- ${g.cls} \`${g.endpoint}\` \`${g.path}\`${g.status ? ` ${g.status}` : ""}: ${g.count}`), "");

  const targets = args.map((a) => {
    const [name, path] = a.split("=") as [string, string];
    const j = JSON.parse(readFileSync(path, "utf8")) as { score: ReturnType<typeof score>; results: SeqResult[]; target: string; date: string };
    const gs = groups(j.results, keys);
    const classTotals: Record<string, number> = {};
    for (const g of gs) classTotals[g.cls] = (classTotals[g.cls] ?? 0) + g.count;
    const templates = perTemplate(j.results);
    md.push(`### ${name}`, "", table("Stratum", byStratum(j.score)), "", table("Split", [["held-out", j.score.heldOut], ["train", j.score.train]]), "");
    md.push(table("Template", templates.map((t) => [`${t.template} (${t.stratum}${t.heldOut ? ", held-out" : ""})`, t])), "");
    md.push(`Divergences by class: ${Object.entries(classTotals).map(([c, n]) => `${c} ${n}`).join(", ")}`, "");
    const rows = (xs: Group[]): string[] => ["| Class | Endpoint | Path | Status | Count |", "|---|---|---|---|---|", ...xs.map((g) => `| ${g.cls} | \`${g.endpoint}\` | \`${g.path}\` | ${g.status ?? ""} | ${g.count} |`), ""];
    const statusMismatches = gs.filter((g) => g.cls === "STATUS_MISMATCH");
    md.push("Top 20 divergence paths:", "", ...rows(gs.slice(0, 20)), "Every status mismatch (oracle→target):", "", ...rows(statusMismatches));
    return { name, bench: basename(path), date: j.date, sequences: j.results.length, score: j.score, perTemplate: templates, classTotals, topDivergences: gs.slice(0, 50), statusMismatches };
  });

  const report = {
    normalization: { version: NORMALIZATION_VERSION, rules: RULES.map((r) => r.name) },
    oracle: {
      file: basename(oraclePath),
      sha256: createHash("sha256").update(readFileSync(oraclePath)).digest("hex"),
      sequences: oracle.length,
      templates: new Set(oracle.map((r) => r.template)).size,
      oldest: started[0],
      newest: started.at(-1),
    },
    noise: { compare: basename(noisePath), pairs: noise.results.length, score: noise.score, divergences: noiseGroups },
    targets,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  // C3 guard: no response values may reach the committed file.
  if (/"(expected|actual)"/.test(text)) throw new Error("refusing to write: expected/actual values present");
  writeFileSync(out, text);
  console.log(md.join("\n"));
  console.error(`wrote ${out}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "surface") surface(rest[0]!, rest[1]!, rest[2]!);
else if (cmd === "pair") pair(rest[0]!, rest[1]!, rest[2]!, rest.slice(3));
else if (cmd === "summarize") summarize(rest);
else {
  console.error("usage: node reports/baseline.ts surface|pair|summarize … (see the header comment)");
  process.exitCode = 2;
}
