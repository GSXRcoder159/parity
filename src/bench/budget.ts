// Read-budget ledger (decision 0001 C2): one JSONL line of request counts per sandbox run, never response data.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonl } from "../jsonl.ts";
import type { Sequence } from "../types.ts";

export interface LedgerEntry {
  date: string; // ISO
  account: string;
  target: string;
  runId: string;
  gets: number;
  posts: number;
  deletes: number;
  /**
   * Charges (reads per transaction). recordCorpus: distinct `charge.succeeded` events observed. agree's metered proxy:
   * 2xx answers to direct charge-creating calls, which misses the charges Stripe makes on its own (meteredProxy).
   */
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

/**
 * Projected sandbox GETs of recording `seqs` in one chunk: their GET steps, the event sweep (ceil(10.5 events/sequence /
 * 100 per page) x 5 passes) and, when they create a test clock, the leak check's one list. ponytail: recordCorpus's gate
 * (src/cli.ts) computes the same inline, per chunk; it should call this one.
 */
export function projectedGets(seqs: Sequence[]): number {
  const steps = seqs.flatMap((s) => s.steps);
  const leak = steps.some((s) => s.method === "POST" && s.path === "/v1/test_helpers/test_clocks") ? 1 : 0;
  return steps.filter((s) => s.method === "GET").length + Math.ceil((10.5 * seqs.length) / 100) * 5 + leak;
}

/** GETs of the 30-day budget no nightly slice may use (decision 0001 C2): room for agree, reruns and recordings by hand. */
export const RESERVE = 1_500;

/** A night's share of the read budget (decision 0001 C2): floor((10,000 − RESERVE − rolling30) / 7), never negative. */
export const nightShare = (rolling30: number): number => Math.max(0, Math.floor((10_000 - RESERVE - rolling30) / 7));

/** Tonight's allowance (decision 0001 C2): min(projected GETs of one seventh of the corpus, the night's share). */
export const allowance = (seventhGets: number, rolling30: number): number => Math.min(seventhGets, nightShare(rolling30));

/** The longest prefix of `seqs` whose projection fits in `gets` (the sweep term is not linear in its length). */
export function fittingPrefix(seqs: Sequence[], gets: number): Sequence[] {
  let n = seqs.length;
  while (n > 0 && projectedGets(seqs.slice(0, n)) > gets) n--;
  return seqs.slice(0, n);
}
