// Sealed align log (decision 0002 §5): append-only JSONL at <dataDir>/align/log.jsonl, hash-chained.
// hash = sha256(prev + JSON(data) + ts + kind); the first entry's prev is "". Every entry's data carries the oracle's
// provenance {oracleSeqs, oracleSha}, inside `data` so the chain covers it.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonl } from "../jsonl.ts";

export type Kind = "score" | "patch" | "gate" | "publish" | "note";
export interface Provenance {
  oracleSeqs: number;
  oracleSha: string;
}
export type LogData = Record<string, unknown> & { oracle: Provenance };
export interface LogEntry {
  ts: string;
  runId: string;
  kind: Kind;
  data: LogData;
  prev: string;
  hash: string;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const hashOf = (e: Omit<LogEntry, "hash" | "runId">): string => sha256(e.prev + JSON.stringify(e.data) + e.ts + e.kind);

export const logPath = (dataDir: string): string => join(dataDir, "align", "log.jsonl");

/** The oracle file's sequence count and sha256. */
export function provenance(oraclePath: string): Provenance {
  const buf = readFileSync(oraclePath);
  return { oracleSeqs: buf.toString("utf8").split("\n").filter((l) => l.trim()).length, oracleSha: sha256(buf) };
}

/** Recomputes the chain: each entry's prev is the previous hash, its hash recomputes, and it carries provenance. */
export function verifyLog(file: string): { ok: true; entries: number } | { ok: false; entries: number; error: string } {
  const entries = existsSync(file) ? readJsonl<LogEntry>(file) : [];
  let prev = "";
  for (const [i, e] of entries.entries()) {
    const bad = (why: string) => ({ ok: false as const, entries: entries.length, error: `${file} line ${i + 1}: ${why}` });
    if (e.prev !== prev) return bad("prev is not the previous entry's hash (an entry was removed, reordered or rewritten)");
    if (e.hash !== hashOf(e)) return bad("hash does not match its contents (the entry was edited)");
    if (typeof e.data?.oracle?.oracleSha !== "string" || typeof e.data.oracle.oracleSeqs !== "number") return bad("no oracle provenance");
    prev = e.hash;
  }
  return { ok: true, entries: entries.length };
}

/** Appends `items` under `runId` after verifying the existing chain; throws on a broken chain or missing provenance. */
export function appendLog(file: string, runId: string, items: { kind: Kind; data: LogData }[], ts = new Date().toISOString()): LogEntry[] {
  const v = verifyLog(file);
  if (!v.ok) throw new Error(`refusing to append to a broken log: ${v.error}`);
  let prev = existsSync(file) ? (readJsonl<LogEntry>(file).at(-1)?.hash ?? "") : "";
  const out = items.map(({ kind, data }) => {
    if (!data.oracle) throw new Error(`log entry (${kind}) without oracle provenance`);
    const e = { ts, runId, kind, data, prev };
    prev = hashOf(e);
    return { ...e, hash: prev };
  });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, out.map((e) => JSON.stringify(e) + "\n").join(""));
  return out;
}
