// Error catalog (data: errors.json) and the error type handlers raise with `fail(key)`.
// status/type/code/param are semantics; `message` stays "parity: <key>" until the align loop seeds it (0002 §4.3).
import { readFileSync } from "node:fs";

interface Entry {
  status: number;
  type: string;
  code?: string;
  param?: string;
  message: string;
}

export const CATALOG: Record<string, Entry> = JSON.parse(readFileSync(new URL("./errors.json", import.meta.url), "utf8"));

export class TwinError extends Error {
  key: string;
  vars: Record<string, string>;
  /** Extra fields merged into the rendered `error` object (e.g. a card error's `charge`, `payment_method`). */
  extra: Record<string, unknown>;
  constructor(key: string, vars: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    super(key);
    this.key = key;
    this.vars = vars;
    this.extra = extra;
  }
}

export function fail(key: string, vars?: Record<string, string>, extra?: Record<string, unknown>): never {
  throw new TwinError(key, vars, extra);
}

/** Fills `{name}` from `vars`; a placeholder without a var is a bug at the call site, not text to render. */
const fill = (key: string, s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new Error(`errors.json "${key}": no value for {${k}}`);
    return vars[k]!;
  });

/**
 * Object names by id prefix, as the oracle's messages name them ("No such webhook endpoint: 'we_…'"): only names seen
 * there. Any other prefix renders `{object}` as "" (the API's own naming is not uniform, so none is guessed).
 */
// ponytail: observed names only; add one when the oracle shows a message naming it.
const OBJECTS: Record<string, string> = { cus: "customer", in: "invoice", price: "price", sub: "subscription", we: "webhook endpoint" };
/** An object id (`cus_ParityMissing1`, `we_1Abc…`): prefix, underscore, then a token with a digit or capital, not a word such as `create_preview`. */
const OBJECT_ID = /^[a-z]+(?:_[a-z]+)*_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6,}$/;
const objectOf = (id: string): string => (OBJECT_ID.test(id) ? (OBJECTS[id.slice(0, id.lastIndexOf("_"))] ?? "") : "");

/** The request an error answers: its decoded params (query and body) and its path. */
export interface ErrorRequest {
  params: Record<string, unknown>;
  path: string;
}

/**
 * Message vars every error gets from its request, so a catalog message can quote it without call-site code (decision
 * 0002 §4.3; the align loop derives the template, patch.ts): `{value}` is the request's value at the error's param
 * (`recurring[interval]` reads nested), else the id in the path; `{object}` names the object of that value when it is
 * an id of a known prefix (OBJECTS). "" when there is none.
 */
export function requestVars(param: string | undefined, req: ErrorRequest | undefined): { value: string; object: string } {
  let v: unknown = req?.params;
  for (const s of param?.split(/\]?\[|\]/).filter(Boolean) ?? [undefined]) v = s !== undefined && v && typeof v === "object" ? (v as Record<string, unknown>)[s] : undefined;
  const pathId = req?.path.split("?")[0]!.split("/").findLast((s) => OBJECT_ID.test(s));
  const value = typeof v === "string" || typeof v === "number" ? String(v) : (pathId ?? "");
  return { value, object: objectOf(value) };
}

/** `{ error: { type, code?, param?, message, doc_url?, request_log_url } }` with the catalog entry's status, and its key (the `Parity-Error-Key` header). */
export function renderError(e: TwinError, requestId: string, req?: ErrorRequest): { status: number; body: { error: Record<string, unknown> }; errorKey: string } {
  const entry = CATALOG[e.key];
  if (!entry) throw new Error(`errors.json has no key "${e.key}"`);
  const { status, type, code, param, message } = entry;
  const error: Record<string, unknown> = { type };
  if (code) error.code = code;
  if (param) error.param = fill(e.key, param, e.vars);
  // Call-site vars win over the request's: the call site knows which value it is about.
  error.message = fill(e.key, message, { ...requestVars(error.param as string | undefined, req), ...e.vars });
  if (code) error.doc_url = `https://stripe.com/docs/error-codes/${code.replaceAll("_", "-")}`; // card_declined -> card-declined (observed)
  error.request_log_url = `https://dashboard.stripe.com/test/logs/${requestId}`;
  return { status, body: { error: { ...error, ...e.extra } }, errorKey: e.key };
}
