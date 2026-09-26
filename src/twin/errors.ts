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

/** `{ error: { type, code?, param?, message, doc_url?, request_log_url } }` with the catalog entry's status. */
export function renderError(e: TwinError, requestId: string): { status: number; body: { error: Record<string, unknown> } } {
  const entry = CATALOG[e.key];
  if (!entry) throw new Error(`errors.json has no key "${e.key}"`);
  const { status, type, code, param, message } = entry;
  const error: Record<string, unknown> = { type };
  if (code) error.code = code;
  if (param) error.param = fill(e.key, param, e.vars);
  error.message = fill(e.key, message, e.vars);
  if (code) error.doc_url = `https://stripe.com/docs/error-codes/${code.replaceAll("_", "-")}`; // card_declined -> card-declined (observed)
  error.request_log_url = `https://dashboard.stripe.com/test/logs/${requestId}`;
  return { status, body: { error: { ...error, ...e.extra } } };
}
