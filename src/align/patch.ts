// Mechanical candidates (decision 0002 §3), from train sequences only: data-file edits whose value the oracle shows
// deterministically — the same normalized value at every train occurrence, none of them in the noise set — and that
// holds beyond this oracle: no account- or date-derived field, no free text, no message quoting the request or seen for
// one use of a generic error key (one parameter or one decline code) only, no literal over a catalog `{var}`; and never a
// fraud or risk field, which the public templates must not carry. Every other train locus is returned as not
// mechanical, with the reason (input to the assisted pass).
import { isDeepStrictEqual } from "node:util";
import { FRAUD_OR_RISK } from "../bench/normalize.ts";
import { ID } from "../bench/run.ts";
import { requestVars } from "../twin/errors.ts";
import type { Recording, StepRecord } from "../types.ts";
import { divergenceId, joinPath, segments, typeOf, type Locus, type Triaged } from "./triage.ts";

export const SHAPES_DIR = "src/twin/shapes";
export const CATALOG_FILE = "src/twin/errors.json";

/** A JSON-pointer edit of one data file (path relative to the repo root). */
export interface Edit {
  file: string;
  pointer: string;
  op: "set" | "delete";
  value?: unknown;
  /** `template`/`nearest`: set when the edit targets an enclosing template, `nearest` being the one it had no effect on. */
  evidence: { occurrences: number; seqs: string[]; template?: string; nearest?: string };
}
/** `ids`: the train divergences (seq|step|path) the edit should remove; the gate judges its effect by them. */
export interface Candidate extends Edit {
  locus: Locus;
  ids: string[];
}
export interface NotMechanical {
  locus: Locus;
  reason: string;
  divergences: number;
}
export type Catalog = Record<string, Record<string, unknown>>;

type Obj = Record<string, unknown>;
type Segs = (string | number)[];
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
/** Normalization placeholders (normalize.ts): computed per run, never seeded as a value. */
const PLACEHOLDER = /<(?:id:[^>]*|t:[^>]*|number:[^>]*|url:[^>]*|run|opaque|secret|date)>/;
const computed = (v: unknown): boolean => PLACEHOLDER.test(JSON.stringify(v) ?? "");
const pointer = (keys: Segs): string => keys.map((k) => `/${String(k).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const ERROR_FIELDS = new Set(["status", "type", "code", "param", "message"]);
/** What renderError always writes; any other key in the twin's `error` is an extra passed by the raising call site. */
const RENDERED = new Set([...ERROR_FIELDS, "doc_url", "request_log_url"]);
/**
 * Fields set by the sandbox account (country, name, statement descriptor) or by the recording date (a test card's
 * expiry), not by API semantics: constant within one oracle, wrong for another account or month. Never automatic.
 */
// ponytail: fixed name list; drop a name once the rolling oracle spans accounts/months and the determinism check rejects it on its own.
const ACCOUNT_OR_TIME = new Set(["account_country", "account_name", "calculated_statement_descriptor", "exp_month", "exp_year"]);
// Fraud and risk fields (0001 R8): one list, the normalization's (v1.9 drops them from the comparison too).
export { FRAUD_OR_RISK };
/**
 * An API type default is an enum token (lowercase, digits, `_.-`). Any other text (prose, labels, country or descriptor
 * codes) is set by the request, the account or the context, e.g. a charge description that follows its invoice's reason.
 */
// ponytail: token regex; a context-set value that happens to be one lowercase word still passes until the oracle varies it.
const TOKEN = /^[a-z0-9_.-]*$/;
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) || isObj(v) ? Object.values(v).flatMap(strings) : []);
/** A catalog `{var}`: an entry with one in `param` serves every parameter (and call site) that raises its key. */
const VAR = /\{\w+\}/;
const keysIn = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysIn) : isObj(v) ? Object.entries(v).flatMap(([k, x]) => [k, ...keysIn(x)]) : []);
/** Request param leaves as text (numbers too); booleans and values under 3 characters are too common to mean an echo. */
const requestValues = (v: unknown): string[] =>
  typeof v === "string" || typeof v === "number" ? (String(v).length >= 3 ? [String(v).toLowerCase()] : []) : Array.isArray(v) || isObj(v) ? Object.values(v).flatMap(requestValues) : [];
/** The message quotes a value the request sent (e.g. the expand path): it depends on the request, so it is never a constant. */
const echoes = (message: string, params: unknown): boolean => requestValues(params).some((s) => message.toLowerCase().includes(s));

/** Value at `segs` under `v` (absent when any step is missing). */
function at(v: unknown, segs: Segs): { present: boolean; value?: unknown } {
  for (const s of segs) {
    if (!(isObj(v) || Array.isArray(v)) || !Object.hasOwn(v, s)) return { present: false };
    v = (v as Obj)[s];
  }
  return { present: true, value: v };
}

/** noise(template, step, path): the key, a noisy parent of it, or a noisy path inside it is in the noise set. */
function noiseIndex(noise: Set<string>): (template: string, step: number, path: string) => boolean {
  const by = new Map<string, string[]>();
  for (const k of noise) {
    const [t, s, ...p] = k.split("|");
    by.set(`${t}|${s}`, [...(by.get(`${t}|${s}`) ?? []), p.join("|")]);
  }
  const inside = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}[`);
  return (t, s, path) => (by.get(`${t}|${s}`) ?? []).some((n) => inside(path, n) || inside(n, path));
}

type Ancestor = { type: string; path: string };
/** Every typed object (`object` field) in the step bodies, by template type, with its JSON path and the typed objects enclosing it (nearest first). */
function typedObjects(recs: Recording[]) {
  const out = new Map<string, { seq: string; template: string; step: number; path: string; obj: Obj; up: Ancestor[] }[]>();
  for (const r of recs) {
    for (const s of r.steps) {
      const walk = (v: unknown, path: string, up: Ancestor[]): void => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, up));
        else if (isObj(v)) {
          const t = typeOf(v);
          if (t) out.set(t, [...(out.get(t) ?? []), { seq: r.seq, template: r.template, step: s.i, path, obj: v, up }]);
          for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, t ? [{ type: t, path }, ...up] : up);
        }
      };
      walk(s.body, "$", []);
    }
  }
  return out;
}

/** The catalog's `{name}` vars recoverable from the twin's response: its rendered `error.param` against the entry's template. */
function twinVars(entry: Obj, step: StepRecord | undefined): Record<string, string> {
  const rendered = isObj(step?.body) && isObj(step.body.error) ? step.body.error.param : undefined;
  if (typeof entry.param !== "string" || typeof rendered !== "string") return {};
  const names: string[] = [];
  const re = entry.param.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? (names.push(part), "(.*)") : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const m = new RegExp(`^${re.join("")}$`).exec(rendered);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]!])) : {};
}

/** A call site's sub-codes in the twin's rendered error (e.g. a decline code): string extras that are not ids or placeholders. */
function subCodes(step: StepRecord | undefined): Record<string, string> {
  const error = isObj(step?.body) && isObj(step.body.error) ? step.body.error : {};
  const out = Object.entries(error).filter(([k, v]) => !RENDERED.has(k) && typeof v === "string" && !ID.test(v) && !computed(v));
  return Object.fromEntries(out) as Record<string, string>;
}

/**
 * The message template for one occurrence: the oracle's normalized message, where each `<id:P>` token becomes the `{var}`
 * whose twin value is an id with prefix P, and each value of a `subst` var, as a whole token, becomes that `{var}`
 * (longest value first); undefined (assisted) when another placeholder is left or an `<id:P>` has no single var.
 */
function messageTemplate(message: string, vars: Record<string, string>, subst: Set<string>): string | undefined {
  if (PLACEHOLDER.test(message.replace(/<id:[^>]*>/g, ""))) return undefined;
  let ok = true;
  let out = message.replace(/<id:([^>]*)>/g, (_, prefix: string) => {
    const names = Object.keys(vars).filter((n) => ID.test(vars[n]!) && vars[n]!.startsWith(`${prefix}_`));
    if (names.length !== 1) ok = false;
    return `{${names[0]}}`;
  });
  for (const n of [...subst].filter((n) => (vars[n] ?? "").length >= 3).sort((a, b) => vars[b]!.length - vars[a]!.length)) {
    const lit = vars[n]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\w{])${lit}(?![\\w}])`, "g"), `{${n}}`);
  }
  return ok ? out : undefined;
}

/** One group per locus; event loci group by template (their per-step detail differs by sequence). */
export const locusKey = (l: Locus): string => JSON.stringify(l.kind === "events" ? { kind: "events", template: l.template } : l);

/**
 * Candidates from the train divergences of `divergences`, checked against the train sequences of `oracle` (normalized
 * bodies, raw params: the echo check reads the request as sent) and `twin` (raw, for its error keys and rendered vars). Held-out sequences are dropped here, before anything is read.
 * `data.shape(type)`: the parsed shapes/<type>.json, undefined when there is none.
 */
export function propose(
  divergences: Triaged[],
  oracle: Recording[],
  twin: Recording[],
  noise: Set<string>,
  data: { shape: (type: string) => unknown; catalog: Catalog },
): { candidates: Candidate[]; notMechanical: NotMechanical[] } {
  const train = divergences.filter((d) => !d.heldOut);
  const trainOracle = oracle.filter((r) => !r.heldOut);
  const twinBySeq = new Map(twin.filter((r) => !r.heldOut).map((r) => [r.seq, r]));
  const noisy = noiseIndex(noise);
  const objects = typedObjects(trainOracle);

  const groups = new Map<string, Triaged[]>();
  for (const d of train) groups.set(locusKey(d.locus), [...(groups.get(locusKey(d.locus)) ?? []), d]);
  const candidates: Candidate[] = [];
  const notMechanical: NotMechanical[] = [];
  for (const g of groups.values()) {
    const locus = g[0]!.locus;
    const ids = g.map((d) => divergenceId(d.seq, d.step, d.path));
    const no = (reason: string) => void notMechanical.push({ locus, reason, divergences: g.length });
    const seqsOf = (xs: { seq: string }[]) => [...new Set(xs.map((x) => x.seq))];
    if (g.some((d) => d.cls === "NONDETERMINISTIC")) no("noise: a divergence at this locus is in the noise set");
    else if (locus.kind === "events") no("event set: emitted by handler code");
    else if (locus.kind === "route") no("status: decided by handler code");
    else if (locus.kind === "field") {
      /** The edit at `segs` in `type`'s template, judged on every train occurrence of `type`: a candidate, or why not. */
      const judge = (type: string, segs: Segs): Candidate | string => {
        const occ = (objects.get(type) ?? []).map((o) => ({ ...o, at: at(o.obj, segs) }));
        const present = occ.filter((o) => o.at.present);
        const value = present[0]?.at.value;
        const edit = { file: `${SHAPES_DIR}/${type}.json`, pointer: pointer(segs), evidence: { occurrences: occ.length, seqs: seqsOf(occ) }, locus, ids };
        if (segs.some((s) => typeof s === "number")) return "inside an array element";
        if (!data.shape(type)) return `no template ${edit.file}`;
        if (occ.some((o) => noisy(o.template, o.step, `${o.path}.${joinPath(segs)}`))) return "noise: an occurrence is in the noise set";
        if (!present.length && g.every((d) => d.cls === "EXTRA_FIELD")) return { ...edit, op: "delete" };
        if ([...segs.map(String), ...present.flatMap((o) => keysIn(o.at.value))].some((k) => FRAUD_OR_RISK.has(k))) return "fraud or risk data: never seeded into a public template";
        if (present.length < occ.length) return "absent from some occurrences";
        if (!present.every((o) => isDeepStrictEqual(o.at.value, value))) return "varies across sequences";
        if (computed(value)) return "computed: the value holds a normalization placeholder";
        if ([...segs.map(String), ...keysIn(value)].some((k) => ACCOUNT_OR_TIME.has(k))) return "account- or time-derived: constant only within one account or month";
        if (strings(value).some((x) => !TOKEN.test(x))) return "context text: only enum-like tokens are type defaults";
        return { ...edit, op: "set", value };
      };
      /** The edit leaves `type`'s template as it is: a delete of a pointer it lacks, a set of the value it holds. */
      const noop = (type: string, segs: Segs, c: Candidate): boolean => {
        const cur = at(data.shape(type), segs);
        return c.op === "delete" ? !cur.present : cur.present && isDeepStrictEqual(cur.value, c.value);
      };
      const segs = segments(`.${locus.fieldPath}`);
      const near = judge(locus.objectType, segs);
      let v = near;
      if (typeof near !== "string" && noop(locus.objectType, segs, near)) {
        // A nested default: build() deep-merges an enclosing template's copy (subscription_item.json#/price) over the
        // stored object. Try the pointer in each typed object enclosing every divergent occurrence, nearest first; the
        // first template that has it and that the edit changes takes it. None: the nearest edit stays (blocked-by-code).
        const divergent = new Set(ids);
        const hits = (objects.get(locus.objectType) ?? []).filter((o) => divergent.has(divergenceId(o.seq, o.step, `${o.path}.${locus.fieldPath}`)));
        const up = (o: (typeof hits)[number]) => o.up.map((a) => ({ type: a.type, segs: [...segments(o.path.slice(a.path.length)), ...segs] }));
        const key = (e: { type: string; segs: Segs }) => `${e.type}${pointer(e.segs)}`;
        const shared = hits.map((o) => new Set(up(o).map(key)));
        for (const e of hits.length === ids.length ? up(hits[0]!) : []) {
          if (!shared.every((s) => s.has(key(e))) || !at(data.shape(e.type), e.segs).present) continue;
          const w = judge(e.type, e.segs);
          if (typeof w === "string" || noop(e.type, e.segs, w)) continue;
          v = { ...w, evidence: { ...w.evidence, template: `${w.file}#${w.pointer}`, nearest: `${near.file}#${near.pointer}` } };
          break;
        }
      }
      if (typeof v === "string") no(v);
      else candidates.push(v);
    } else {
      const entry = data.catalog[locus.errorKey];
      // Every train step where the twin raised this key, with the oracle's step at the same position.
      const occ = trainOracle.flatMap((o) =>
        (twinBySeq.get(o.seq)?.steps ?? [])
          .filter((t) => t.resHeaders["parity-error-key"] === locus.errorKey)
          .map((t) => ({ seq: o.seq, template: o.template, t, o: o.steps[t.i]! })),
      );
      const values = occ.map(({ o }) => (locus.field === "status" ? o.status : isObj(o.body) && isObj(o.body.error) ? o.body.error[locus.field] : undefined));
      const edit = { file: CATALOG_FILE, pointer: pointer([locus.errorKey, locus.field]), evidence: { occurrences: occ.length, seqs: seqsOf(occ) } };
      const path = locus.field === "status" ? "$" : `$.error.${locus.field}`;
      if (!entry) no(`no catalog entry "${locus.errorKey}"`);
      else if (!ERROR_FIELDS.has(locus.field)) no("not a catalog field (status, type, code, param, message)");
      else if (occ.some((x) => noisy(x.template, x.o.i, path))) no("noise: an occurrence is in the noise set");
      else if (locus.field !== "message") {
        // A {var} renders per call site: a wrong rendered value is a call-site bug, and a literal would break the other sites.
        if (VAR.test(String(entry[locus.field]))) no("call-site var: the entry's {var} renders per call site (assisted)");
        else if (!values.every((v) => isDeepStrictEqual(v, values[0]))) no("varies across sequences");
        else if (computed(values[0])) no("computed: the value holds a normalization placeholder");
        else candidates.push(values[0] === undefined ? { ...edit, op: "delete", locus, ids } : { ...edit, op: "set", value: values[0], locus, ids });
      } else if (values.some((m) => typeof m !== "string")) no("absent from some occurrences");
      else {
        // The call site's vars, over the request's (requestVars, read from the twin's own request as renderError reads it).
        const call = occ.map((x) => twinVars(entry, x.t));
        const vars = occ.map((x, i): Record<string, string> => {
          const param = isObj(x.t.body) && isObj(x.t.body.error) && typeof x.t.body.error.param === "string" ? x.t.body.error.param : undefined;
          return { ...requestVars(param, { params: isObj(x.t.params) ? x.t.params : {}, path: x.t.path }), ...call[i] };
        });
        // A var is shown to be one where its value changes across occurrences; `{value}` is the request's own value at
        // the error's param, so its literal in the message is an echo by definition.
        const subst = new Set(Object.keys(vars[0] ?? {}).filter((n) => n === "value" || new Set(vars.map((v) => v[n])).size > 1));
        const tpl = values.map((m, i) => messageTemplate(m as string, vars[i]!, subst));
        const bindings = occ.map((x, i) => ({ ...call[i], ...subCodes(x.t) }));
        if (tpl.some((m) => m === undefined)) no("computed: the message holds placeholders no twin var renders");
        else if (tpl.some((m, i) => echoes(m!, occ[i]!.o.params))) no("request-derived: the message quotes a request parameter value");
        else if (!tpl.every((m) => m === tpl[0])) no("varies across sequences");
        // A generic entry (a {var} in param, or a sub-code such as a decline code) is shown to hold for its other uses
        // only when the corpus renders 2+ bindings of its vars and sub-codes.
        else if (
          (VAR.test(String(entry.param)) || bindings.some((b) => Object.keys(b).length)) &&
          new Set(bindings.map((b) => JSON.stringify(Object.entries(b).sort()))).size < 2
        )
          no("one binding: every occurrence renders the same {param} or sub-code, so the message is shown for one use of the key only");
        else candidates.push({ ...edit, op: "set", value: tpl[0], locus, ids });
      }
    }
  }
  return { candidates, notMechanical };
}
