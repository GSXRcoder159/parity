// paritybench align surface (decision 0002 §3, §4.5): a twin change after the scaffold freeze that is neither automatic
// nor assisted (new surface such as proration, invoices, test clocks) is scaffold work. It is logged in the sealed log with
// the score before and after, so the curve annotates it ("surface-added: <note>") and its jump is never read as alignment.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LevelScores } from "../bench/score.ts";
import { evalOf, scores, scoreTwinIn, type Scores } from "./gate.ts";
import { git, split } from "./index.ts";
import { appendLog, logPath, provenance, type Provenance } from "./log.ts";

export interface Surface {
  runId: string;
  note: string;
  /** The first commit of the surface: `before` is scored on its parent. */
  commit: string;
  /** HEAD when `after` was scored on the working tree (the twin's inputs clean, so HEAD's twin). */
  head: string;
  before: Scores;
  after: Scores;
  oracle: Provenance;
  log: string;
}

/**
 * score-twin on <dataDir>/oracle.jsonl for a temp checkout of `<commit>^` (before) and for the working tree (after), then
 * one sealed-log `patch` entry {class: "surface-added", status: "applied", note, commit, head, before, after} with provenance.
 */
export function surface(o: { repo: string; dataDir: string; runId: string; note: string; commit?: string }): Surface {
  // "after" is the working tree while the entry names commits: the twin's own inputs must be committed. Other src/ files
  // (the harness) are not checked: other work edits them concurrently and they do not change the twin.
  const dirty = git(o.repo, "status", "--porcelain", "--", "src/twin", "templates", "package.json");
  if (dirty) throw new Error(`refusing align surface: uncommitted changes in src/twin/, templates/ or package.json:\n${dirty}`);
  const commit = git(o.repo, "rev-parse", "--verify", `${o.commit ?? "HEAD"}^{commit}`);
  const head = git(o.repo, "rev-parse", "HEAD");
  const oraclePath = join(o.dataDir, "oracle.jsonl");
  const oracle = provenance(oraclePath);
  const tmp = mkdtempSync(join(tmpdir(), "parity-surface-"));
  let before: Scores;
  try {
    // git archive, not a checkout: the repo's index, HEAD and worktrees are never touched.
    const tar = execFileSync("git", ["-C", o.repo, "archive", `${commit}^`, "src", "templates", "package.json"], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", tmp], { input: tar });
    before = scores(evalOf(scoreTwinIn(tmp, oraclePath, []).json));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const after = scores(evalOf(scoreTwinIn(o.repo, oraclePath, []).json));
  const log = logPath(o.dataDir);
  appendLog(log, o.runId, [{ kind: "patch", data: { class: "surface-added", status: "applied", note: o.note, commit, head, before, after, oracle } }]);
  return { runId: o.runId, note: o.note, commit, head, before, after, oracle, log };
}

const signed = (x: number, digits: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
const deltas = (a: LevelScores, b: LevelScores): string => (["L1", "L2", "L3", "L4"] as const).map((l) => `${l} ${signed((b[l].p - a[l].p) * 100, 1)}`).join(" ");

export function surfaceText(s: Surface): string {
  return [
    `align surface ${s.runId}: "${s.note}" · oracle ${s.oracle.oracleSeqs} sequences (sha256 ${s.oracle.oracleSha.slice(0, 12)}…)`,
    `before (${s.commit.slice(0, 12)}^): ${split(s.before)}`,
    `after (working tree at ${s.head.slice(0, 12)}): ${split(s.after)}`,
    `delta: train ${deltas(s.before.train, s.after.train)} pts (${signed(s.after.trainDivergences - s.before.trainDivergences, 0)} divergences) · held-out ${deltas(s.before.heldOut, s.after.heldOut)} pts`,
    `logged: patch surface-added (applied, commit ${s.commit}) in ${s.log}; the next nightly curve point annotates it`,
  ].join("\n");
}
