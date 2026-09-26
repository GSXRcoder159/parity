// paritybench align (decision 0002 §3): score the twin on the latest oracle, triage every divergence to a locus,
// propose mechanical data-file edits from train sequences only, and gate them on held-out. --apply writes the accepted
// edits, appends them (and every blocked-by-code candidate) to the sealed log, and commits the data files.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareRecordings, noiseKeys, type SeqResult } from "../bench/compare.ts";
import { normalizeRecording } from "../bench/normalize.ts";
import { contaminated } from "../bench/oracle.ts";
import type { LevelScores } from "../bench/score.ts";
import { readJsonl } from "../jsonl.ts";
import type { Recording } from "../types.ts";
import { applyEdits, evalOf, gate, scoreTwinIn, type GateResult, type Judged, type Scores } from "./gate.ts";
import { appendLog, logPath, provenance, type Kind, type LogData, type Provenance } from "./log.ts";
import { CATALOG_FILE, SHAPES_DIR, propose, type Candidate, type NotMechanical } from "./patch.ts";
import { triage, type Locus, type Triaged } from "./triage.ts";

/**
 * Noise keys from every pair of clean sandbox recordings of one sequence started under an hour apart (back-to-back
 * runs such as W0 A/D or the weekly noise pair; a week-apart re-record is drift, not noise).
 */
export function noiseFromRuns(dataDir: string): { keys: Set<string>; pairs: number } {
  const dir = join(dataDir, "runs");
  const bySeq = new Map<string, Recording[]>();
  // ponytail: reads every run on each align; index the pairs if runs/ grows past a few hundred MB.
  for (const f of existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((x) => x.endsWith(".jsonl")) : []) {
    for (const r of readJsonl<Recording>(join(dir, f))) if (r.target === "sandbox" && !contaminated(r)) bySeq.set(r.seq, [...(bySeq.get(r.seq) ?? []), r]);
  }
  const pairs: SeqResult[] = [];
  for (const rs of bySeq.values()) {
    rs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (let i = 1; i < rs.length; i++) {
      if (Date.parse(rs[i]!.startedAt) - Date.parse(rs[i - 1]!.startedAt) < 3_600_000) pairs.push(compareRecordings(normalizeRecording(rs[i - 1]!), normalizeRecording(rs[i]!)));
    }
  }
  return { keys: noiseKeys(pairs), pairs: pairs.length };
}

export interface AlignResult {
  runId: string;
  oracle: Provenance;
  noise: { keys: number; pairs: number };
  divergences: Triaged[];
  earliest: Record<string, number | null>;
  candidates: Candidate[];
  notMechanical: NotMechanical[];
  gate: GateResult;
  applied?: { files: string[]; log: string; entries: number; commit?: string };
}

const DATA_PATHS = [SHAPES_DIR, CATALOG_FILE];
const git = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

export function align(o: { repo: string; dataDir: string; runId: string; apply?: boolean; maxBatches?: number }): AlignResult {
  const oraclePath = join(o.dataDir, "oracle.jsonl");
  // --apply commits the data files as automatic patches: a pending hand edit there must never ride along.
  const dirty = o.apply ? git(o.repo, "status", "--porcelain", "--", ...DATA_PATHS) : "";
  if (dirty) throw new Error(`refusing --apply: uncommitted changes in the twin's data files:\n${dirty}`);
  const oracle = provenance(oraclePath);
  const recs = readJsonl<Recording>(oraclePath);
  const noise = noiseFromRuns(o.dataDir);
  const base = scoreTwinIn(o.repo, oraclePath, [], true);
  const { divergences, earliest } = triage(base.json.results, noise.keys, recs, base.twin!);
  const catalog = JSON.parse(readFileSync(join(o.repo, CATALOG_FILE), "utf8"));
  const shape = (t: string) => /^[a-z][a-z0-9_.]*$/.test(t) && existsSync(join(o.repo, SHAPES_DIR, `${t}.json`));
  const { candidates, notMechanical } = propose(divergences, recs.map(normalizeRecording), base.twin!, noise.keys, { shape, catalog });
  const g = gate(candidates, (edits) => evalOf(scoreTwinIn(o.repo, oraclePath, edits).json), { maxBatches: o.maxBatches, before: evalOf(base.json) });
  const r: AlignResult = { runId: o.runId, oracle, noise: { keys: noise.keys.size, pairs: noise.pairs }, divergences, earliest, candidates, notMechanical, gate: g };
  if (o.apply) r.applied = applyAndLog(o.repo, o.dataDir, r);
  return r;
}

const editOf = (c: Candidate) => ({ file: c.file, pointer: c.pointer, op: c.op, ...(c.op === "set" ? { value: c.value } : {}) });
const pts = (a: LevelScores, b: LevelScores): string => `${b.L3.p >= a.L3.p ? "+" : ""}${((b.L3.p - a.L3.p) * 100).toFixed(1)} pts`;

/** Writes the accepted edits, logs one `patch` entry per edit and one `gate` entry for the run, commits the data files. */
function applyAndLog(repo: string, dataDir: string, r: AlignResult): NonNullable<AlignResult["applied"]> {
  const g = r.gate;
  const files = applyEdits(repo, g.accepted.map((j) => j.candidate));
  const oracle = r.oracle;
  const brief = (j: Judged) => ({ edit: editOf(j.candidate), locus: j.candidate.locus, evidence: { occurrences: j.candidate.evidence.occurrences, seqs: j.candidate.evidence.seqs.length }, divergences: j.candidate.ids.length });
  const reasons: Record<string, number> = {};
  for (const n of r.notMechanical) reasons[n.reason] = (reasons[n.reason] ?? 0) + 1;
  const entries: { kind: Kind; data: LogData }[] = [
    ...g.accepted.map((j) => ({
      kind: "patch" as const,
      data: { class: "automatic", status: "applied", edit: editOf(j.candidate), locus: j.candidate.locus, evidence: j.candidate.evidence, gate: { before: j.before, after: j.after }, oracle },
    })),
    {
      kind: "gate",
      data: {
        before: g.before,
        after: g.after,
        evaluations: g.evaluations,
        candidates: r.candidates.length,
        accepted: g.accepted.length,
        blockedByCode: g.blocked.map(brief),
        rejected: g.rejected.map((j) => ({ ...brief(j), after: j.after })),
        notGated: g.notGated.map((c) => ({ edit: editOf(c), locus: c.locus })),
        notMechanical: reasons,
        noise: r.noise,
        oracle,
      },
    },
  ];
  const log = logPath(dataDir);
  appendLog(log, r.runId, entries);
  if (!files.length) return { files, log, entries: entries.length };
  const msg =
    `align: ${g.accepted.length} automatic patches (train Δ ${g.after.trainDivergences - g.before.trainDivergences} divergences, L3 ${pts(g.before.train, g.after.train)}; ` +
    `held-out Δ L3 ${pts(g.before.heldOut, g.after.heldOut)})\n\nSealed log run ${r.runId} (${g.accepted.length} patch entries + 1 gate entry); oracle ${oracle.oracleSeqs} sequences, sha256 ${oracle.oracleSha}.`;
  git(repo, "commit", "-q", "-m", msg, "--", ...files);
  return { files, log, entries: entries.length, commit: git(repo, "rev-parse", "HEAD") };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const levels = (s: LevelScores): string => (["L1", "L2", "L3", "L4"] as const).map((l) => `${l} ${pct(s[l].p)}`).join(" ");
const split = (s: Scores): string => `train ${levels(s.train)} (${s.trainDivergences} divergences) · held-out ${levels(s.heldOut)}`;
const where = (l: Locus): string =>
  l.kind === "field" ? `${l.objectType} ${l.fieldPath}` : l.kind === "error" ? `error ${l.errorKey} ${l.field}` : l.kind === "route" ? l.route : `events ${l.template}`;
const line = (c: Candidate): string =>
  `  ${c.file} ${c.pointer} ${c.op}${c.op === "set" ? ` ${JSON.stringify(c.value)}` : ""} · ${c.ids.length} divergences, value seen at ${c.evidence.occurrences} occurrences in ${c.evidence.seqs.length} sequences`;

/** The human-readable plan (and what --apply did). */
export function planText(r: AlignResult): string {
  const g = r.gate;
  const train = r.divergences.filter((d) => !d.heldOut);
  const kinds: Record<string, number> = {};
  for (const d of train) kinds[d.locus.kind] = (kinds[d.locus.kind] ?? 0) + 1;
  const reasons: Record<string, number> = {};
  for (const n of r.notMechanical) reasons[n.reason] = (reasons[n.reason] ?? 0) + 1;
  const first = Object.values(r.earliest);
  const out = [
    `align ${r.runId}: oracle ${r.oracle.oracleSeqs} sequences (sha256 ${r.oracle.oracleSha.slice(0, 12)}…) · noise: ${r.noise.keys} keys from ${r.noise.pairs} back-to-back sandbox pairs`,
    `before: ${split(g.before)}`,
    `triage: ${train.length} train divergences (${train.filter((d) => d.cls === "NONDETERMINISTIC").length} noise) by locus: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")}` +
      ` · earliest divergent step: 0 in ${first.filter((s) => s === 0).length} sequences, later in ${first.filter((s) => s !== null && s > 0).length}, none in ${first.filter((s) => s === null).length}`,
    `candidates: ${r.candidates.length} mechanical (${r.candidates.filter((c) => c.op === "set").length} set, ${r.candidates.filter((c) => c.op === "delete").length} delete)` +
      ` · not mechanical: ${r.notMechanical.length} train loci (${Object.entries(reasons).map(([k, n]) => `${n} ${k}`).join("; ")})`,
    `gate: ${g.evaluations} score-twin runs after the baseline · accepted ${g.accepted.length} · blocked-by-code ${g.blocked.length} · rejected ${g.rejected.length}` + (g.notGated.length ? ` · not gated ${g.notGated.length} (--max-batches)` : ""),
    `after: ${split(g.after)}`,
  ];
  const list = (title: string, js: Candidate[]) => js.length && out.push(`${title}:`, ...js.map(line));
  list("accepted", g.accepted.map((j) => j.candidate));
  list("blocked-by-code (no effect: handler code decides the value)", g.blocked.map((j) => j.candidate));
  list("rejected (made train or held-out worse)", g.rejected.map((j) => j.candidate));
  list("not gated", g.notGated);
  if (r.notMechanical.length) {
    out.push("not mechanical (assisted pass), by train divergences:");
    for (const n of [...r.notMechanical].sort((a, b) => b.divergences - a.divergences)) out.push(`  ${n.divergences} · ${where(n.locus)} · ${n.reason}`);
  }
  out.push(
    r.applied
      ? `applied: ${r.applied.files.length} files; ${r.applied.entries} entries appended to ${r.applied.log}; ${r.applied.commit ? `committed ${r.applied.commit}` : "nothing to commit"}`
      : g.accepted.length
        ? `plan only: --apply writes the ${g.accepted.length} accepted edits, logs them and commits`
        : "plan only: nothing to apply",
  );
  return out.join("\n");
}

