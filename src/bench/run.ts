// Sequence runner: executes a Sequence's steps against a Stripe-compatible target and records
// every request/response plus the events the run produced.
import { setTimeout as sleep } from "node:timers/promises";
import type { Method, Recording, Sequence, StepRecord, StripeEvent } from "../types.ts";

export interface Target {
  name: string;
  baseUrl: string;
  apiKey: string;
  rps?: number;
  /** Wait before the first event pass and between passes (default 200 ms); 0 skips event collection. */
  eventWaitMs?: number;
}

const STRIPE_VERSION = "2026-08-26.dahlia";
const REF = /\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)/g;
const EXACT_REF = new RegExp(`^${REF.source}$`);
// Stripe object id: lowercase prefix + mixed-case tail (the uppercase/digit lookahead excludes enums).
export const ID = /^[a-z]+(?:_[a-z]+)*_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{10,}$/;
// parity-error-key: the twin's error catalog key (the real API never sends it; headers are never compared).
const RES_HEADERS = ["request-id", "idempotent-replayed", "stripe-version", "stripe-rate-limited-reason", "retry-after", "parity-error-key"];
/** Consecutive steps ending 429 after all retries that abort a corpus (W0: B and C sent 966 retries into a limited key). */
const BREAKER = 10;

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

/**
 * Evenly spaced requests at `rps` (a token bucket of capacity 1); one instance is shared by all concurrent sequences of a
 * target. No burst: a bucket of capacity rps allowed nearly 2 x rps in the first second after an idle spell, and
 * decision 0001 C2's 20 req/s is a hard cap.
 */
export function createLimiter(rps: number): () => Promise<void> {
  let tokens = 1;
  let last = performance.now();
  return async () => {
    for (;;) {
      const now = performance.now();
      tokens = Math.min(1, tokens + ((now - last) * rps) / 1000);
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

/**
 * Every HTTP request actually sent (each 429 retry and event page counts); `eventOverlaps` = events assigned to >1 recording.
 * `aborted` is set when the circuit breaker tripped: later steps were not sent and events were not collected.
 */
export interface RunSummary {
  requests: number;
  gets: number;
  posts: number;
  deletes: number;
  eventSweepGets: number;
  retries429: number;
  eventOverlaps: number;
  aborted?: string;
  /** The leak check (runCorpus `deleteLeftoverClocks`): this run's test clocks, those still listed, those deleted now. */
  clocks?: { created: number; leftOver: number; deleted: number; error?: string };
}

const newSummary = (): RunSummary => ({ requests: 0, gets: 0, posts: 0, deletes: 0, eventSweepGets: 0, retries429: 0, eventOverlaps: 0 });
const COUNTER = { GET: "gets", POST: "posts", DELETE: "deletes" } as const;

/**
 * Shared by reference across a corpus's workers. `streak429` = consecutive answered steps that ended 429. `maxGets`: the
 * GETs this run may still send (the rolling read budget left); reaching it halts the run like the circuit breaker.
 */
interface Io {
  take: () => Promise<void>;
  stats: RunSummary;
  streak429: number;
  maxGets?: number;
}

/** One HTTP call through the limiter; 429s retried up to 3 times (1 s, 2 s, 4 s). `ms` = final attempt. */
async function send(io: Io, target: Target, method: Method, path: string, form: string, stepHeaders: Record<string, string> = {}) {
  const headers = new Headers({ Authorization: `Bearer ${target.apiKey}`, "Stripe-Version": STRIPE_VERSION });
  if (method === "POST") headers.set("Content-Type", "application/x-www-form-urlencoded");
  for (const [k, v] of Object.entries(stepHeaders)) headers.set(k, String(v));
  const url = target.baseUrl + path + (method !== "POST" && form ? `?${form}` : "");
  for (let retries = 0; ; retries++) {
    // Decision 0001 R7: the run halts when the read budget is reached, whatever the projection said (429 retries and
    // event pages can exceed it). The halted request is never sent.
    if (method === "GET" && io.maxGets !== undefined && io.stats.gets >= io.maxGets) {
      io.stats.aborted ??= `run halted: the read budget allowed ${io.maxGets} more sandbox GETs and they are spent (decision 0001 C2/R7)`;
      throw new Error(`not sent: ${io.stats.aborted}`);
    }
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

/** Runs one sequence alone: its steps, then an event sweep since its start − 60 s (single-sequence re-runs). */
export async function runSequence(seq: Sequence, target: Target, opts: { take: () => Promise<void>; runId: string }): Promise<Recording> {
  const io: Io = { take: opts.take, stats: newSummary(), streak429: 0 };
  const out = await runSteps(io, seq, target, opts.runId, {});
  const ids = idsIn(out.steps);
  if (target.eventWaitMs !== 0 && ids.size > 0) {
    try {
      out.events = touching(ids, await sweepEvents(io, target, Math.floor(Date.parse(out.startedAt) / 1000) - 60, 15_000));
    } catch (e) {
      out.eventsError = errMsg(e);
    }
  }
  out.ms = Date.now() - Date.parse(out.startedAt);
  return out;
}

/** Sends a sequence's steps (`seqHeaders` on every step, step headers win) and records them; events are left to the caller. */
async function runSteps(io: Io, seq: Sequence, target: Target, runId: string, seqHeaders: Record<string, string>): Promise<Recording> {
  const started = Date.now();
  const nonce = runNonce(runId, seq.id);
  const bound: Record<string, unknown> = {};
  const steps: StepRecord[] = [];
  for (const [i, step] of seq.steps.entries()) {
    const unsent = (error: string): void => void steps.push({ i, method: step.method, path: step.path, status: 0, body: null, resHeaders: {}, ms: 0, error });
    if (step.waitMs && !io.stats.aborted) await sleep(step.waitMs);
    if (io.stats.aborted) {
      unsent(`not sent: ${io.stats.aborted}`);
      continue;
    }
    let path: string;
    let params: Record<string, unknown> | undefined;
    let headers: Record<string, string>;
    try {
      path = String(resolveRefs(step.path, bound, nonce));
      params = step.params && (resolveRefs(step.params, bound, nonce) as Record<string, unknown>);
      headers = { ...seqHeaders, ...(step.headers && (resolveRefs(step.headers, bound, nonce) as Record<string, string>)) };
    } catch (e) {
      // Not sent; `path` stays the unresolved template string.
      unsent(errMsg(e));
      continue;
    }
    const rec: StepRecord = { i, method: step.method, path, status: 0, body: null, resHeaders: {}, ms: 0 };
    if (params) rec.params = params;
    const kept = Object.entries(headers).filter(([k]) => k.toLowerCase() !== "authorization");
    if (kept.length) rec.headers = Object.fromEntries(kept);
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
      io.streak429 = r.status === 429 ? io.streak429 + 1 : 0;
      if (io.streak429 >= BREAKER && !io.stats.aborted) {
        io.stats.aborted = `corpus aborted by the circuit breaker: ${BREAKER} consecutive steps ended 429 after all retries`;
      }
    } catch (e) {
      rec.error = errMsg(e);
    }
    steps.push(rec);
  }
  return {
    seq: seq.id,
    template: seq.template,
    stratum: seq.stratum,
    seed: seq.seed,
    heldOut: seq.heldOut,
    target: target.name,
    runId,
    startedAt: new Date(started).toISOString(),
    ms: Date.now() - started,
    steps,
    events: [],
  };
}

/** Every object id (whole-string match) in the step response bodies. */
export function idsIn(steps: StepRecord[]): Set<string> {
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
export function touching(ids: Set<string>, all: StripeEvent[]): StripeEvent[] {
  return all
    .filter((e) => ids.has(e.data.object.id as string) || ids.has(e.data.object.customer as string))
    .sort((a, b) => a.created - b.created || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/**
 * GET /v1/events since `sinceSec`, newest first: every page (`starting_after`), or with `newerThan` only the events
 * newer than that id (`ending_before`, whose pages arrive oldest to newest). Throws on a non-200 (after 429 retries).
 */
async function listEvents(io: Io, target: Target, sinceSec: number, newerThan?: string): Promise<StripeEvent[]> {
  const all: StripeEvent[] = [];
  for (let cursor = newerThan; ; ) {
    const page = newerThan ? { ending_before: cursor } : { starting_after: cursor };
    const r = await send(io, target, "GET", "/v1/events", encodeForm({ created: { gte: sinceSec }, limit: 100, ...page }));
    if (r.status !== 200) throw new Error(`GET /v1/events -> ${r.status}`);
    const list = JSON.parse(r.text) as { data: StripeEvent[]; has_more: boolean };
    if (newerThan) all.unshift(...list.data);
    else all.push(...list.data);
    cursor = newerThan ? list.data[0]?.id : list.data.at(-1)?.id;
    if (!list.has_more || !cursor) return all;
  }
}

/**
 * Incremental sweep: waits eventWaitMs, lists every event since `sinceSec`, then every eventWaitMs fetches only the
 * events newer than the newest seen, until two passes in a row find nothing new or `capMs` passes since the first list.
 */
async function sweepEvents(io: Io, target: Target, sinceSec: number, capMs: number): Promise<StripeEvent[]> {
  const every = target.eventWaitMs ?? 200;
  await sleep(every);
  const first = performance.now();
  // ponytail: an event that becomes visible after a newer one was listed is missed; widen to a created[gte] re-list if W1 shows gaps.
  const all = await listEvents(io, target, sinceSec);
  for (let empty = 0; empty < 2 && performance.now() - first < capMs; ) {
    await sleep(every);
    const fresh = await listEvents(io, target, sinceSec, all[0]?.id);
    all.unshift(...fresh);
    empty = fresh.length ? 0 : empty + 1;
  }
  return all;
}

const CLOCKS = "/v1/test_helpers/test_clocks";

/**
 * The leak check: the test clocks this run created (its 200s to POST /v1/test_helpers/test_clocks) that GET
 * /v1/test_helpers/test_clocks still lists are deleted. A sequence that stopped before its last step (the clock's DELETE)
 * leaves its clock, customer and subscription behind. Other clocks on the account are never touched. Never throws.
 */
async function deleteLeftoverClocks(io: Io, target: Target, recs: Recording[]): Promise<NonNullable<RunSummary["clocks"]>> {
  const ours = new Set(recs.flatMap((r) => r.steps).flatMap((s) => (s.method === "POST" && s.path === CLOCKS && s.status === 200 ? [(s.body as { id: string }).id] : [])));
  const out: NonNullable<RunSummary["clocks"]> = { created: ours.size, leftOver: 0, deleted: 0 };
  if (!ours.size) return out;
  if (io.stats.aborted) return { ...out, error: `not checked: ${io.stats.aborted}` };
  try {
    const left: string[] = [];
    for (let cursor: string | undefined; ; ) {
      const r = await send(io, target, "GET", CLOCKS, encodeForm({ limit: 100, starting_after: cursor }));
      if (r.status !== 200) throw new Error(`GET ${CLOCKS} -> ${r.status}`);
      const page = JSON.parse(r.text) as { data: { id: string }[]; has_more: boolean };
      left.push(...page.data.map((c) => c.id).filter((id) => ours.has(id)));
      cursor = page.data.at(-1)?.id;
      if (!page.has_more || !cursor) break;
    }
    out.leftOver = left.length;
    for (const id of left) {
      // An advancing clock refuses its delete (429, after send's retries); it expires at its deletes_after (30 days).
      const r = await send(io, target, "DELETE", `${CLOCKS}/${id}`, "");
      if (r.status === 200) out.deleted++;
      else out.error ??= `DELETE ${CLOCKS}/{id} -> ${r.status}`;
    }
  } catch (e) {
    out.error = errMsg(e);
    // send() marks a budget halt on the run, but this run's steps and sweep are complete: the halt is the check's alone.
    delete io.stats.aborted;
  }
  return out;
}

/**
 * Runs the corpus, then ONE event sweep for all of it (events are attached after every sequence has
 * finished). `onRecord` fires as each sequence's steps finish, BEFORE its events are attached: use it
 * for progress, and write the returned `recordings` (the same objects, completed by the sweep).
 * `headersFor(seq)` headers go on every step of that sequence; when they set `Parity-Now`, the sweep covers events
 * created since min(Parity-Now) − 60 s instead of the wall-clock start − 60 s. If the circuit breaker trips, the rest of the
 * corpus is recorded as not sent (status 0), the sweep is skipped, and every recording gets `eventsError`.
 * `deleteLeftoverClocks` (sandbox record) ends the run with the leak check, after the sweep, into `summary.clocks`.
 */
export async function runCorpus(
  seqs: Sequence[],
  target: Target,
  opts: {
    concurrency: number;
    runId: string;
    onRecord?: (r: Recording) => void;
    headersFor?: (seq: Sequence) => Record<string, string>;
    maxGets?: number;
    deleteLeftoverClocks?: boolean;
  },
): Promise<{ recordings: Recording[]; summary: RunSummary }> {
  const io: Io = { take: createLimiter(target.rps ?? 1000), stats: newSummary(), streak429: 0, maxGets: opts.maxGets };
  // A target answering as of Parity-Now (the twin) stamps events with it: the sweep starts at the earliest one, not wall clock.
  const nows = seqs.map((s) => Number(opts.headersFor?.(s)["Parity-Now"])).filter(Number.isFinite);
  const startSec = nows.length ? Math.min(...nows) : Math.floor(Date.now() / 1000);
  const out: Recording[] = new Array(seqs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < seqs.length) {
      const i = next++;
      const r = await runSteps(io, seqs[i]!, target, opts.runId, opts.headersFor?.(seqs[i]!) ?? {});
      out[i] = r;
      opts.onRecord?.(r);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  const idSets = out.map((r) => idsIn(r.steps));
  if (io.stats.aborted) {
    for (const r of out) r.eventsError = `not collected: ${io.stats.aborted}`;
  } else if (target.eventWaitMs !== 0 && idSets.some((s) => s.size > 0)) {
    const gets0 = io.stats.gets;
    try {
      // ponytail: pages every account event since corpus start − 60 s; filter by type if other traffic on the account grows.
      const all = await sweepEvents(io, target, startSec - 60, 30_000);
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
  // After the sweep: the clocks' delete events must not land in the recordings.
  if (opts.deleteLeftoverClocks) io.stats.clocks = await deleteLeftoverClocks(io, target, out);
  return { recordings: out, summary: io.stats };
}
