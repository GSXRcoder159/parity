// Step-by-step comparison of two (already normalized) recordings of the same sequence.
import { isDeepStrictEqual } from "node:util";
import type { Divergence, Recording, Stratum } from "../types.ts";

/**
 * The comparison method, published with every score next to the normalization version: a change moves every score, so
 * the curve annotates it. m1: steps (L1-L3) and event-type multisets. m2: m1 plus causal event order (plan §3.1).
 */
export const METHOD = { version: "m2", change: "causal event order" } as const;

export interface StepResult {
  i: number;
  L1: boolean;
  L2: boolean;
  L3: boolean;
}

export interface SeqResult {
  seq: string;
  template: string;
  stratum: Stratum;
  heldOut: boolean;
  steps: StepResult[];
  L4: boolean;
  eventsMatch: boolean;
  /**
   * Event checks (set and order) not run: the oracle's event collection failed (`eventsError`); eventsMatch is then true. A target whose
   * collection failed is compared as having no events (EVENT_SET_MISMATCH, actual "error: <message>"): a broken
   * `/v1/events` must never score better than a working but imperfect one.
   */
  eventsSkipped: boolean;
  divergences: Divergence[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Type skeleton: primitives → typeof, objects → sorted key→shape, arrays → sorted unique element shapes. */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return [...new Set(v.map((x) => JSON.stringify(shape(x))))].sort();
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return typeof v;
}

/** Oracle-vs-target field diff; array length differences stop at the array (no element diff). */
function diff(o: unknown, t: unknown, path: string, out: Omit<Divergence, "seq" | "step">[]): void {
  if (isObj(o) && isObj(t)) {
    for (const k of Object.keys(o)) {
      if (!Object.hasOwn(t, k)) out.push({ path: `${path}.${k}`, cls: "MISSING_FIELD", expected: o[k] });
      else diff(o[k], t[k], `${path}.${k}`, out);
    }
    for (const k of Object.keys(t)) if (!Object.hasOwn(o, k)) out.push({ path: `${path}.${k}`, cls: "EXTRA_FIELD", actual: t[k] });
  } else if (Array.isArray(o) && Array.isArray(t)) {
    if (o.length !== t.length) out.push({ path, cls: "VALUE_MISMATCH", expected: o.length, actual: t.length });
    else o.forEach((x, i) => diff(x, t[i], `${path}[${i}]`, out));
  } else if (!isDeepStrictEqual(o, t)) out.push({ path, cls: "VALUE_MISMATCH", expected: o, actual: t });
}

const types = (r: Recording): string[] => r.events.map((e) => e.type).sort();

/** Each event type's earliest and latest raw `created` (normalization keeps an event's own `created` raw). */
function spans(r: Recording): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const { type, created } of r.events) {
    if (!Number.isFinite(created)) continue;
    const s = out.get(type);
    out.set(type, s ? [Math.min(s[0], created), Math.max(s[1], created)] : [created, created]);
  }
  return out;
}

/**
 * Causal-order violations, as [A, B] pairs (plan §3.1: event sets plus causal-order constraints, never strict
 * sequences). The oracle orders A before B when every A was created strictly before every B; the target violates that
 * when some B was created strictly before some A. Ties never violate: events are stamped by the second, and Stripe does
 * not order events of the same second.
 */
export function orderViolations(oracle: Recording, target: Recording): [string, string][] {
  const o = spans(oracle);
  const t = spans(target);
  const out: [string, string][] = [];
  for (const [a, [, aLast]] of o) {
    for (const [b, [bFirst]] of o) {
      const [ta, tb] = [t.get(a), t.get(b)];
      if (a !== b && aLast < bFirst && ta && tb && tb[0] < ta[1]) out.push([a, b]);
    }
  }
  return out.sort((x, y) => (x.join() < y.join() ? -1 : 1));
}

export function compareRecordings(oracle: Recording, target: Recording, noise?: Set<string>): SeqResult {
  const divergences: Divergence[] = [];
  const steps = oracle.steps.map((o, idx): StepResult => {
    const t = target.steps[idx];
    const L1 = t !== undefined && o.status === t.status;
    // L2/L3 imply L1: a body match under a different status is not agreement.
    const L2 = L1 && isDeepStrictEqual(shape(o.body), shape(t.body));
    const L3 = L1 && isDeepStrictEqual(o.body, t.body);
    const found: Omit<Divergence, "seq" | "step">[] = [];
    if (!L1) found.push({ path: "$", cls: "STATUS_MISMATCH", expected: o.status, actual: t?.status });
    else diff(o.body, t.body, "$", found);
    for (const d of found) divergences.push({ seq: oracle.seq, step: o.i, ...d });
    return { i: o.i, L1, L2, L3 };
  });

  const eventsSkipped = Boolean(oracle.eventsError);
  const expected = types(oracle);
  const actual = target.eventsError ? `error: ${target.eventsError}` : types(target);
  const eventsMatch = eventsSkipped || (!target.eventsError && isDeepStrictEqual(expected, actual));
  if (!eventsMatch) divergences.push({ seq: oracle.seq, step: -1, path: "$", cls: "EVENT_SET_MISMATCH", expected, actual });
  const order = eventsSkipped ? [] : orderViolations(oracle, target);
  for (const [a, b] of order) divergences.push({ seq: oracle.seq, step: -1, path: `$.order(${a}<${b})`, cls: "EVENT_ORDER_MISMATCH", expected: `${a} before ${b}`, actual: `${b} before ${a}` });

  for (const d of divergences) if (noise?.has(`${oracle.template}|${d.step}|${d.path}`)) d.cls = "NONDETERMINISTIC";

  return {
    seq: oracle.seq,
    template: oracle.template,
    stratum: oracle.stratum,
    heldOut: oracle.heldOut,
    steps,
    L4: eventsMatch && !order.length && steps.every((s) => s.L3),
    eventsMatch,
    eventsSkipped,
    divergences,
  };
}

/** Keys (`template|step|path`) of every divergence in sandbox-vs-sandbox results. */
export function noiseKeys(results: SeqResult[]): Set<string> {
  return new Set(results.flatMap((r) => r.divergences.map((d) => `${r.template}|${d.step}|${d.path}`)));
}
