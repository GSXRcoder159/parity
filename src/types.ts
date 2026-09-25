// Core contract shared by harness (bench), twin, and align loop. Keep it small.

export type Stratum =
  | "lifecycle"
  | "proration"
  | "cancellation"
  | "refunds"
  | "errors"
  | "boundaries"
  | "idempotency"
  | "events"
  | "pagination"
  | "clocks";

export type Method = "GET" | "POST" | "DELETE";

/**
 * One HTTP step. Strings anywhere in `path`, `params`, or `headers` may contain
 * symbolic refs resolved from earlier responses:
 *   "$c1.id"            -> body of the step with ref "c1", field id
 *   "$s1.items.data.0.id" -> nested path, numeric segments index arrays
 *   "$run"              -> a nonce unique per execution (use for idempotency keys)
 * A string that is exactly one ref is replaced by the raw value (any type);
 * otherwise refs are interpolated as strings.
 */
export interface Step {
  ref?: string;
  method: Method;
  path: string; // "/v1/customers/$c1.id"
  params?: Record<string, unknown>; // nested; form-encoded Stripe-style on send
  headers?: Record<string, string>;
  /** Pause before this step (e.g. waiting for async finalization). */
  waitMs?: number;
}

export interface Template {
  name: string; // kebab-case, unique
  stratum: Stratum;
  /** Held out of repair (never shown to the align loop's patch synthesis). */
  heldOut?: boolean;
  /** Instantiate deterministically from the seeded generator. */
  build(g: Gen): Step[];
}

export interface Sequence {
  id: string; // `${template}#${seed}`
  template: string;
  stratum: Stratum;
  seed: number;
  heldOut: boolean;
  steps: Step[];
}

export interface StepRecord {
  i: number;
  method: Method;
  path: string; // resolved
  params?: Record<string, unknown>; // resolved
  headers?: Record<string, string>; // resolved request headers we set (never the API key)
  status: number;
  body: unknown; // parsed JSON (or {"_raw": text} if not JSON)
  resHeaders: Record<string, string>; // subset: request-id, idempotent-replayed, stripe-version
  ms: number;
  /** Set when a ref could not be resolved or the transport failed. */
  error?: string;
  /** 429 retries spent on this step (absent when none). */
  retries?: number;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
  [k: string]: unknown;
}

export interface Recording {
  seq: string; // Sequence.id
  template: string;
  stratum: Stratum;
  seed: number;
  heldOut: boolean;
  target: string; // "sandbox" | "twin" | "stripe-mock" | "localstripe" | base URL
  runId: string;
  startedAt: string; // ISO
  ms: number;
  steps: StepRecord[];
  /** Events observed via GET /v1/events, filtered to objects this run touched. */
  events: StripeEvent[];
  /** Set when event collection failed (`events` is then [] and not evidence of "no events"). */
  eventsError?: string;
}

export type Level = "L1" | "L2" | "L3" | "L4";

export type DivergenceClass =
  | "STATUS_MISMATCH"
  | "MISSING_FIELD"
  | "EXTRA_FIELD"
  | "VALUE_MISMATCH"
  | "EVENT_SET_MISMATCH"
  | "NONDETERMINISTIC";

export interface Divergence {
  seq: string;
  step: number; // -1 for event-set divergences
  path: string; // JSON path, e.g. "$.items.data[0].price.unit_amount"
  cls: DivergenceClass;
  expected?: unknown; // oracle (normalized)
  actual?: unknown; // target (normalized)
}

export interface Gen {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
  bool(): boolean;
}
