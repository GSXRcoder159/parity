// Sequence runner: executes a Sequence's steps against a Stripe-compatible target and records
// every request/response plus the events the run produced.
import { setTimeout as sleep } from "node:timers/promises";
import type { Method, Recording, Sequence, StepRecord, StripeEvent } from "../types.ts";

export interface Target {
  name: string;
  baseUrl: string;
  apiKey: string;
  rps?: number;
  eventWaitMs?: number;
}

const STRIPE_VERSION = "2026-08-26.dahlia";
const REF = /\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)/g;
const EXACT_REF = new RegExp(`^${REF.source}$`);
// Stripe object id: lowercase prefix + mixed-case tail (the uppercase/digit lookahead excludes enums).
const ID = /^[a-z]+(?:_[a-z]+)*_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{10,}$/;
const RES_HEADERS = ["request-id", "idempotent-replayed", "stripe-version"];

export function sandboxTarget(apiKey: string): Target {
  return { name: "sandbox", baseUrl: "https://api.stripe.com", apiKey, rps: 20, eventWaitMs: 3000 };
}

/** Stripe nested form encoding: a[b]=v, items[0][price]=v, null -> "" (unset), undefined omitted. */
export function encodeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (key: string, v: unknown): void => {
    if (v === undefined) return;
    if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(`${key}[${encodeURIComponent(k)}]`, x);
    } else out.push(`${key}=${v === null ? "" : encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(encodeURIComponent(k), v);
  return out.join("&");
}

/** Deep-resolves "$ref.path" strings (see Step in types.ts). Throws on an unresolvable ref. */
export function resolveRefs(value: unknown, bound: Record<string, unknown>, runNonce: string): unknown {
  const lookup = (ref: string, name: string, path: string): unknown => {
    if (name === "run" && !path) return runNonce;
    let cur: unknown = bound;
    for (const seg of [name, ...path.split(".").slice(1)]) {
      if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) throw new Error(`unresolved ref ${ref}`);
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  };
  if (typeof value === "string") {
    const m = EXACT_REF.exec(value);
    if (m) return lookup(m[0], m[1]!, m[2] ?? "");
    return value.replace(REF, (ref: string, name: string, path: string) => String(lookup(ref, name, path)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, bound, runNonce));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, bound, runNonce)]));
  }
  return value;
}

/** Token bucket (capacity = rps); one instance is shared by all concurrent sequences of a target. */
export function createLimiter(rps: number): () => Promise<void> {
  let tokens = rps;
  let last = performance.now();
  return async () => {
    for (;;) {
      const now = performance.now();
      tokens = Math.min(rps, tokens + ((now - last) * rps) / 1000);
      last = now;
      if (tokens >= 1) {
        tokens--;
        return;
      }
      await sleep(((1 - tokens) * 1000) / rps);
    }
  };
}

export function runNonce(runId: string, seqId: string): string {
  return `${runId}-${seqId}`.replace(/[^A-Za-z0-9]/g, "-");
}

/** Every HTTP request actually sent (each 429 retry and event page counts); `eventOverlaps` = events assigned to >1 recording. */
export interface RunSummary {
  requests: number;
  gets: number;
  posts: number;
  deletes: number;
  eventSweepGets: number;
  retries429: number;
  eventOverlaps: number;
}

const newSummary = (): RunSummary => ({ requests: 0, gets: 0, posts: 0, deletes: 0, eventSweepGets: 0, retries429: 0, eventOverlaps: 0 });
const COUNTER = { GET: "gets", POST: "posts", DELETE: "deletes" } as const;

interface Io {
  take: () => Promise<void>;
  stats: RunSummary;
}

/** One HTTP call through the limiter; 429s retried up to 3 times (1 s, 2 s, 4 s). `ms` = final attempt. */
async function send(io: Io, target: Target, method: Method, path: string, form: string, stepHeaders: Record<string, string> = {}) {
  const headers = new Headers({ Authorization: `Bearer ${target.apiKey}`, "Stripe-Version": STRIPE_VERSION });
  if (method === "POST") headers.set("Content-Type", "application/x-www-form-urlencoded");
  for (const [k, v] of Object.entries(stepHeaders)) headers.set(k, String(v));
  const url = target.baseUrl + path + (method !== "POST" && form ? `?${form}` : "");
  for (let retries = 0; ; retries++) {
    await io.take();
    // Counted per attempt, before fetch: a transport failure still counts (conservative for the read budget).
    io.stats.requests++;
    io.stats[COUNTER[method]]++;
    const t0 = performance.now();
    const res = await fetch(url, { method, headers, body: method === "POST" ? form : undefined });
    const text = await res.text();
    if (res.status !== 429 || retries === 3) {
      return { status: res.status, text, headers: res.headers, ms: Math.round(performance.now() - t0), retries };
    }
    io.stats.retries429++;
    await sleep(1000 * 2 ** retries);
  }
}

const errMsg = (e: unknown): string => {
  const err = e as Error & { cause?: { message?: string } };
  return err.cause?.message ? `${err.message}: ${err.cause.message}` : String(err.message ?? e);
};

/**
 * `collectEvents` (default true) polls /v1/events for this sequence alone (single-sequence re-runs);
 * runCorpus passes false and sweeps once for the whole corpus. `stats` accumulates request counts.
 */
export async function runSequence(
  seq: Sequence,
  target: Target,
  opts: { take: () => Promise<void>; runId: string; collectEvents?: boolean; stats?: RunSummary },
): Promise<Recording> {
  const io: Io = { take: opts.take, stats: opts.stats ?? newSummary() };
  const started = Date.now();
  const nonce = runNonce(opts.runId, seq.id);
  const bound: Record<string, unknown> = {};
  const steps: StepRecord[] = [];
  for (const [i, step] of seq.steps.entries()) {
    if (step.waitMs) await sleep(step.waitMs);
    let path: string;
    let params: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;
    try {
      path = String(resolveRefs(step.path, bound, nonce));
      params = step.params && (resolveRefs(step.params, bound, nonce) as Record<string, unknown>);
      headers = step.headers && (resolveRefs(step.headers, bound, nonce) as Record<string, string>);
    } catch (e) {
      // Not sent; `path` stays the unresolved template string.
      steps.push({ i, method: step.method, path: step.path, status: 0, body: null, resHeaders: {}, ms: 0, error: errMsg(e) });
      continue;
    }
    const rec: StepRecord = { i, method: step.method, path, status: 0, body: null, resHeaders: {}, ms: 0 };
    if (params) rec.params = params;
    if (headers) rec.headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "authorization"));
    try {
      const r = await send(io, target, step.method, path, params ? encodeForm(params) : "", headers);
      rec.status = r.status;
      try {
        rec.body = JSON.parse(r.text);
      } catch {
        rec.body = { _raw: r.text };
      }
      for (const h of RES_HEADERS) {
        const v = r.headers.get(h);
        if (v !== null) rec.resHeaders[h] = v;
      }
      rec.ms = r.ms;
      if (r.retries) rec.retries = r.retries;
      if (step.ref) bound[step.ref] = rec.body;
    } catch (e) {
      rec.error = errMsg(e);
    }
    steps.push(rec);
  }
  const out: Recording = {
    seq: seq.id,
    template: seq.template,
    stratum: seq.stratum,
    seed: seq.seed,
    heldOut: seq.heldOut,
    target: target.name,
    runId: opts.runId,
    startedAt: new Date(started).toISOString(),
    ms: 0,
    steps,
    events: [],
  };
  const ids = idsIn(steps);
  if (opts.collectEvents !== false && target.eventWaitMs !== 0 && ids.size > 0) {
    try {
      const since = Math.floor(started / 1000) - 60;
      out.events = touching(ids, await pollEvents(io, target, since, (all) => touching(ids, all).length, 2000, 15_000));
    } catch (e) {
      out.eventsError = errMsg(e);
    }
  }
  out.ms = Date.now() - started;
  return out;
}

/** Every object id (whole-string match) in the step response bodies. */
function idsIn(steps: StepRecord[]): Set<string> {
  const ids = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (ID.test(v)) ids.add(v);
    } else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  steps.forEach((s) => walk(s.body));
  return ids;
}

/** Events whose data.object.id or .customer is in `ids`, by created then type (code-point order). */
function touching(ids: Set<string>, all: StripeEvent[]): StripeEvent[] {
  return all
    .filter((e) => ids.has(e.data.object.id as string) || ids.has(e.data.object.customer as string))
    .sort((a, b) => a.created - b.created || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** Every page of GET /v1/events since `sinceSec`; throws on a non-200 (after 429 retries) or unparsable page. */
async function listEvents(io: Io, target: Target, sinceSec: number): Promise<StripeEvent[]> {
  const all: StripeEvent[] = [];
  for (let after: string | undefined; ; ) {
    const r = await send(io, target, "GET", "/v1/events", encodeForm({ created: { gte: sinceSec }, limit: 100, starting_after: after }));
    if (r.status !== 200) throw new Error(`GET /v1/events -> ${r.status}`);
    const list = JSON.parse(r.text) as { data: StripeEvent[]; has_more: boolean };
    all.push(...list.data);
    after = list.data.at(-1)?.id;
    if (!list.has_more || !after) return all;
  }
}

/** Waits eventWaitMs, then lists all events every `everyMs` until `count` repeats on consecutive lists or `capMs` passes. */
async function pollEvents(
  io: Io,
  target: Target,
  sinceSec: number,
  count: (all: StripeEvent[]) => number,
  everyMs: number,
  capMs: number,
): Promise<StripeEvent[]> {
  await sleep(target.eventWaitMs ?? 200);
  const first = performance.now();
  for (let prev = -1; ; ) {
    const all = await listEvents(io, target, sinceSec);
    const n = count(all);
    if (n === prev || performance.now() - first >= capMs) return all;
    prev = n;
    await sleep(everyMs);
  }
}

/**
 * Runs the corpus, then ONE event sweep for all of it (events are attached after every sequence has
 * finished). `onRecord` fires as each sequence's steps finish, BEFORE its events are attached: use it
 * for progress, and write the returned `recordings` (the same objects, completed by the sweep).
 */
export async function runCorpus(
  seqs: Sequence[],
  target: Target,
  opts: { concurrency: number; runId: string; onRecord?: (r: Recording) => void },
): Promise<{ recordings: Recording[]; summary: RunSummary }> {
  const io: Io = { take: createLimiter(target.rps ?? 1000), stats: newSummary() };
  const startSec = Math.floor(Date.now() / 1000);
  const out: Recording[] = new Array(seqs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < seqs.length) {
      const i = next++;
      const r = await runSequence(seqs[i]!, target, { ...io, runId: opts.runId, collectEvents: false });
      out[i] = r;
      opts.onRecord?.(r);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  const idSets = out.map((r) => idsIn(r.steps));
  if (target.eventWaitMs !== 0 && idSets.some((s) => s.size > 0)) {
    const gets0 = io.stats.gets;
    try {
      // ponytail: pages every account event since corpus start − 60 s; filter by type if other traffic on the account grows.
      const all = await pollEvents(io, target, startSec - 60, (all) => all.length, 3000, 30_000);
      const owners = new Map<string, number>();
      out.forEach((r, i) => {
        r.events = touching(idSets[i]!, all);
        for (const e of r.events) owners.set(e.id, (owners.get(e.id) ?? 0) + 1);
      });
      io.stats.eventOverlaps = [...owners.values()].filter((n) => n > 1).length;
    } catch (e) {
      for (const r of out) r.eventsError = errMsg(e);
    }
    io.stats.eventSweepGets = io.stats.gets - gets0;
  }
  return { recordings: out, summary: io.stats };
}
