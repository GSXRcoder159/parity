// Read-budget ledger (decision 0001 C2): one JSONL line of request counts per sandbox run, never response data.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonl } from "../jsonl.ts";

export interface LedgerEntry {
  date: string; // ISO
  account: string;
  target: string;
  runId: string;
  gets: number;
  posts: number;
  deletes: number;
  /** `charge.succeeded` events observed (reads per transaction). */
  charges: number;
}

export function readLedger(path: string): LedgerEntry[] {
  return existsSync(path) ? readJsonl<LedgerEntry>(path) : [];
}

/** GETs dated in [now − days, now]; an entry exactly `days` old still counts. Throws on an unparsable date. */
export function rollingGets(entries: LedgerEntry[], nowIso: string, days = 30): number {
  const now = Date.parse(nowIso);
  const from = now - days * 86_400_000;
  let gets = 0;
  for (const e of entries) {
    const t = Date.parse(e.date);
    if (Number.isNaN(t)) throw new Error(`ledger entry ${e.runId}: bad date ${e.date}`);
    if (t >= from && t <= now) gets += e.gets;
  }
  return gets;
}

/** Appends only the ledger fields, so a caller's extra properties never reach the file. */
export function appendLedger(path: string, entry: LedgerEntry): void {
  const { date, account, target, runId, gets, posts, deletes, charges } = entry;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ date, account, target, runId, gets, posts, deletes, charges }) + "\n");
}
