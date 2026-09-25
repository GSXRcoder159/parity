// Step-by-step comparison of two (already normalized) recordings of the same sequence.
import { isDeepStrictEqual } from "node:util";
import type { Divergence, Recording, Stratum } from "../types.ts";

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
  /** Event check not run: either side's event collection failed (`eventsError`); eventsMatch is then true. */
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

  const eventsSkipped = Boolean(oracle.eventsError || target.eventsError);
  const expected = types(oracle);
  const actual = types(target);
  const eventsMatch = eventsSkipped || isDeepStrictEqual(expected, actual);
  if (!eventsMatch) divergences.push({ seq: oracle.seq, step: -1, path: "$", cls: "EVENT_SET_MISMATCH", expected, actual });

  for (const d of divergences) if (noise?.has(`${oracle.template}|${d.step}|${d.path}`)) d.cls = "NONDETERMINISTIC";

  return {
    seq: oracle.seq,
    template: oracle.template,
    stratum: oracle.stratum,
    heldOut: oracle.heldOut,
    steps,
    L4: eventsMatch && steps.every((s) => s.L3),
    eventsMatch,
    eventsSkipped,
    divergences,
  };
}

/** Keys (`template|step|path`) of every divergence in sandbox-vs-sandbox results. */
export function noiseKeys(results: SeqResult[]): Set<string> {
  return new Set(results.flatMap((r) => r.divergences.map((d) => `${r.template}|${d.step}|${d.path}`)));
}
