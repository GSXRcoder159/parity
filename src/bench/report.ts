// Markdown and JSON renderings of a score, its noise floor/ceiling, and the top divergences.
import type { Level } from "../types.ts";
import type { SeqResult } from "./compare.ts";
import { NORMALIZATION_VERSION, RULES } from "./normalize.ts";
import { wilson, type LevelScores, type Score, type Wilson } from "./score.ts";

export interface ReportInput {
  title: string;
  date: string;
  target: string;
  oracle: string;
  score: Score;
  noise?: Score;
  /** How much of the oracle the noise floor covers: the ceiling holds for those sequences only. */
  noiseCoverage?: { seqs: number; oracleSeqs: number; templates: number; oracleTemplates: number };
  normalization: string;
  /** compare.ts METHOD.version: what L4 checks of the events. */
  method: string;
  results: SeqResult[];
}

const LEVELS: Level[] = ["L1", "L2", "L3", "L4"];
const pct = (x: number): string => (x * 100).toFixed(1);
const cell = (w: Wilson): string => (w.n === 0 ? "— (0)" : `${pct(w.p)}% [${pct(w.lo)}–${pct(w.hi)}] (${w.n})`);
const row = (name: string, s: LevelScores): string => `| ${name} | ${LEVELS.map((l) => cell(s[l])).join(" | ")} |`;
const HEAD = `| L1 | L2 | L3 | L4 |\n|---|---|---|---|---|`;
const esc = (s: string): string => s.replaceAll("|", "\\|");
const val = (v: unknown): string => {
  const s = JSON.stringify(v) ?? "—";
  return esc(s.length > 60 ? `${s.slice(0, 57)}...` : s);
};

export function renderMarkdown(input: ReportInput): string {
  const { score, noise, results } = input;
  const md: string[] = [
    `# ${input.title}`,
    "",
    `Date: ${input.date} · Target: \`${input.target}\` · Oracle: \`${input.oracle}\` · Normalization: ${input.normalization} · Method: ${input.method}`,
    "",
    `**Summary:** ${LEVELS.map((l) => `${l} ${cell(score.overall[l])}`).join(" · ")} — L1 status, L2 shape, L3 value (per step), L4 sequence pass (every step at L3, the same event types, no causal-order violation); 95% Wilson intervals.`,
    "",
    `Event checks skipped for ${results.filter((r) => r.eventsSkipped).length} of ${results.length} sequences (the oracle's event collection failed; their L4 rests on the steps alone. A target whose collection failed fails the event check instead). Event order violated in ${results.filter((r) => r.divergences.some((d) => d.cls === "EVENT_ORDER_MISMATCH")).length} sequences (method ${input.method}: every oracle event of type A created strictly before every one of type B, and the target creates a B strictly before an A; ties never count).`,
    "",
    "## Noise floor and ceiling",
    "",
  ];
  if (noise) {
    const c = input.noiseCoverage;
    md.push("Oracle vs a second sandbox recording of the same sequences. Floor = 1 − noise agreement; ceiling = noise agreement.", "");
    if (c && c.seqs < c.oracleSeqs) {
      md.push(`**Coverage: the noise recording covers ${c.seqs} of ${c.oracleSeqs} oracle sequences (${c.templates} of ${c.oracleTemplates} templates).** The floor and ceiling hold for those only; the other sequences have no measured floor.`, "");
    }
    md.push("| Level | Noise agreement | Floor | Ceiling |", "|---|---|---|---|");
    for (const l of LEVELS) {
      const w = noise.overall[l];
      md.push(`| ${l} | ${cell(w)} | ${cell({ ...w, p: 1 - w.p, lo: 1 - w.hi, hi: 1 - w.lo })} | ${cell(w)} |`);
    }
  } else {
    md.push("**Any score without the noise floor and ceiling is invalid.** No noise recording was supplied for this report.");
  }

  md.push("", "## Per stratum", "", `| Stratum ${HEAD}`);
  for (const s of Object.keys(score.byStratum).sort()) md.push(row(s, score.byStratum[s]!));

  md.push("", "## Held-out vs train", "", `| Split ${HEAD}`, row("held-out", score.heldOut), row("train", score.train));

  const groups = new Map<string, { n: number; d: SeqResult["divergences"][number] }>();
  for (const d of results.flatMap((r) => r.divergences)) {
    const k = `${d.cls}|${d.path}`;
    const g = groups.get(k);
    if (g) g.n++;
    else groups.set(k, { n: 1, d });
  }
  md.push("", "## Top divergence paths", "", "| Path | Class | Count | Example |", "|---|---|---|---|");
  const nondet = (g: { d: { cls: string } }): number => Number(g.d.cls === "NONDETERMINISTIC");
  for (const { n, d } of [...groups.values()].sort((a, b) => nondet(a) - nondet(b) || b.n - a.n).slice(0, 20)) {
    md.push(`| \`${esc(d.path)}\` | ${d.cls} | ${n} | ${esc(d.seq)} step ${d.step}: expected \`${val(d.expected)}\` → actual \`${val(d.actual)}\` |`);
  }
  if (groups.size === 0) md.push("| — | — | 0 | no divergences |");

  md.push("", "## Per-template L4", "", "| Template | Stratum | Held-out | L4 |", "|---|---|---|---|");
  for (const t of new Set(results.map((r) => r.template))) {
    const rs = results.filter((r) => r.template === t);
    md.push(`| ${t} | ${rs[0]!.stratum} | ${rs[0]!.heldOut ? "yes" : "no"} | ${cell(wilson(rs.filter((r) => r.L4).length, rs.length))} |`);
  }

  md.push("", "## Normalization", "");
  md.push(
    input.normalization === NORMALIZATION_VERSION
      ? `Version ${NORMALIZATION_VERSION}. Rules: ${RULES.map((r) => r.name).join(", ")}. Everything else, including \`livemode\`, is compared as-is.`
      : `\`${input.normalization}\`: no normalization rules applied.`,
  );
  return md.join("\n") + "\n";
}

/** The same inputs as a plain object for `report.json`, with the rule rationales when normalized. */
export function toJson(input: ReportInput): Record<string, unknown> {
  return { ...input, rules: input.normalization === NORMALIZATION_VERSION ? RULES : [] };
}
