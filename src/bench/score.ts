// Four-level parity score with Wilson 95% intervals: L1–L3 per step, L4 per sequence.
import type { Level } from "../types.ts";
import type { SeqResult } from "./compare.ts";

export type Wilson = { p: number; lo: number; hi: number; k: number; n: number };
export type LevelScores = Record<Level, Wilson>;
export type Score = { overall: LevelScores; byStratum: Record<string, LevelScores>; heldOut: LevelScores; train: LevelScores };

export function wilson(k: number, n: number, z = 1.96): Wilson {
  if (n === 0) return { p: 0, lo: 0, hi: 0, k, n };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h), k, n };
}

function levels(rs: SeqResult[]): LevelScores {
  const steps = rs.flatMap((r) => r.steps);
  const at = (l: "L1" | "L2" | "L3") => wilson(steps.filter((s) => s[l]).length, steps.length);
  return { L1: at("L1"), L2: at("L2"), L3: at("L3"), L4: wilson(rs.filter((r) => r.L4).length, rs.length) };
}

export function score(results: SeqResult[]): Score {
  const strata = [...new Set(results.map((r) => r.stratum))];
  return {
    overall: levels(results),
    byStratum: Object.fromEntries(strata.map((s) => [s, levels(results.filter((r) => r.stratum === s))])),
    heldOut: levels(results.filter((r) => r.heldOut)),
    train: levels(results.filter((r) => !r.heldOut)),
  };
}
