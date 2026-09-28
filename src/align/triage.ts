// Triage (deterministic): each twin-vs-oracle divergence gets its class (NONDETERMINISTIC when its key is in the
// noise set) and a locus, the place in the twin that owns it:
//   field  — the nearest enclosing oracle object with an `object` field: {objectType, fieldPath} (shapes/<type>.json)
//   error  — the twin's Parity-Error-Key and the error field (message, code, param, type, status…; errors.json)
//   events — the template, and per step the missing/extra event types
//   route  — the handler route (method + path pattern), for status mismatches that are not error-vs-error
import type { SeqResult } from "../bench/compare.ts";
import type { Divergence, Recording } from "../types.ts";

export type Locus =
  | { kind: "field"; objectType: string; fieldPath: string }
  | { kind: "error"; errorKey: string; field: string }
  | { kind: "events"; template: string; steps: { step: number; missing: string[]; extra: string[] }[] }
  | { kind: "route"; route: string };

export interface Triaged extends Divergence {
  template: string;
  heldOut: boolean;
  locus: Locus;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export const noiseKey = (template: string, step: number, path: string): string => `${template}|${step}|${path}`;
export const divergenceId = (seq: string, step: number, path: string): string => `${seq}|${step}|${path}`;

/** "$.items.data[0].price" → ["items", "data", 0, "price"]. */
export const segments = (path: string): (string | number)[] => [...path.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)].map((m) => m[1] ?? Number(m[2]));
/** ["recurring", "interval"] → "recurring.interval"; indexes as "[i]". */
export const joinPath = (segs: (string | number)[]): string => segs.map((s, i) => (typeof s === "number" ? `[${s}]` : i ? `.${s}` : s)).join("");

/** The template a typed object is built from: a deleted object (`deleted: true`) comes from deleted_<type>. */
export const typeOf = (o: Obj): string | undefined => (typeof o.object !== "string" ? undefined : o.deleted === true ? `deleted_${o.object}` : o.object);

const NAMED = new Set(["search", "create_preview", "upcoming"]); // literal segments where an id could sit

/** `POST /v1/payment_methods/{id}/attach`: ids, refs and route params become `{id}`. */
export function endpoint(method: string, path: string): string {
  const [, v, ...segs] = path.split("?")[0]!.split("/");
  // `test_helpers` namespaces a resource: `/v1/test_helpers/test_clocks/{id}/advance`.
  const ns = segs[0] === "test_helpers" ? [segs.shift()!] : [];
  const [res, id, action, sub] = segs;
  const parts = [v, ...ns, res];
  if (id !== undefined) parts.push(NAMED.has(id) ? id : "{id}");
  if (action !== undefined) parts.push(action);
  if (sub !== undefined) parts.push("{id}");
  return `${method} /${parts.join("/")}`;
}

/** Nearest typed object above the divergent path in the oracle body → {objectType, fieldPath}. */
function fieldLocus(body: unknown, path: string): Locus | undefined {
  const segs = segments(path);
  let cur = body;
  let found: Locus | undefined;
  for (let i = 0; i < segs.length && (isObj(cur) || Array.isArray(cur)); i++) {
    const t = isObj(cur) ? typeOf(cur) : undefined;
    if (t) found = { kind: "field", objectType: t, fieldPath: joinPath(segs.slice(i)) };
    cur = (cur as Obj)[segs[i]!];
  }
  return found;
}

/** Oracle and twin event types of one kind that the other side lacks (multiset difference), attributed to steps. */
function eventLocus(oracle: Recording, twin: Recording): Locus {
  const byStep = new Map<number, { step: number; missing: string[]; extra: string[] }>();
  const add = (from: Recording, other: Recording, key: "missing" | "extra") => {
    const left = other.events.map((e) => e.type);
    for (const e of from.events) {
      const j = left.indexOf(e.type);
      if (j >= 0) {
        left.splice(j, 1);
        continue;
      }
      // The step whose response first mentions the event's object (-1: none does).
      const id = e.data.object.id;
      const step = from.steps.find((s) => JSON.stringify(s.body)?.includes(`"${id}"`))?.i ?? -1;
      const g = byStep.get(step) ?? { step, missing: [], extra: [] };
      g[key].push(e.type);
      byStep.set(step, g);
    }
  };
  add(oracle, twin, "missing");
  add(twin, oracle, "extra");
  return { kind: "events", template: oracle.template, steps: [...byStep.values()].sort((a, b) => a.step - b.step) };
}

/**
 * Loci for every divergence of `results`, and each sequence's earliest divergent step (null: none, noise excluded).
 * `oracle` and `twin` are the raw recordings the results came from, matched by `seq`.
 */
export function triage(results: SeqResult[], noise: Set<string>, oracle: Recording[], twin: Recording[]) {
  const oracleBySeq = new Map(oracle.map((r) => [r.seq, r]));
  const twinBySeq = new Map(twin.map((r) => [r.seq, r]));
  const divergences: Triaged[] = [];
  const earliest: Record<string, number | null> = {};
  for (const r of results) {
    const o = oracleBySeq.get(r.seq);
    const t = twinBySeq.get(r.seq);
    if (!o || !t) throw new Error(`triage: no oracle or twin recording for ${r.seq}`);
    earliest[r.seq] = null;
    for (const d of r.divergences) {
      const cls = noise.has(noiseKey(r.template, d.step, d.path)) ? "NONDETERMINISTIC" : d.cls;
      const os = o.steps[d.step];
      const errorKey = t.steps[d.step]?.resHeaders["parity-error-key"];
      let locus: Locus | undefined;
      if (d.step < 0) locus = eventLocus(o, t);
      else if (d.cls === "STATUS_MISMATCH") {
        locus = errorKey && os!.status >= 400 ? { kind: "error", errorKey, field: "status" } : undefined;
      } else {
        locus = fieldLocus(os!.body, d.path);
        if (!locus && errorKey && d.path.startsWith("$.error.")) locus = { kind: "error", errorKey, field: joinPath(segments(d.path).slice(1)) };
      }
      divergences.push({ ...d, cls, template: r.template, heldOut: r.heldOut, locus: locus ?? { kind: "route", route: endpoint(os!.method, os!.path) } });
      if (d.step >= 0 && cls !== "NONDETERMINISTIC") earliest[r.seq] = Math.min(earliest[r.seq] ?? d.step, d.step);
    }
  }
  return { divergences, earliest };
}
