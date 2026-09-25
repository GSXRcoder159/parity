// Normalization v1: rewrites run-specific values (ids, timestamps, nonces, secrets, hosted URLs,
// per-account opaques, list order) so two faithful runs compare equal. Published with every score.
import type { Recording } from "../types.ts";
import { runNonce } from "./run.ts";

export const NORMALIZATION_VERSION = "v1";

export const RULES: { name: string; rationale: string }[] = [
  {
    name: "ids",
    rationale:
      "Object ids are random per run; `cus_Ab12…` → `<id:cus>` keeps the prefix. Hides: an id pointing at the wrong object of the right type (e.g. `customer` set to another customer), and malformed id tails.",
  },
  {
    name: "timestamps",
    rationale:
      "Absolute times differ per run; times under timestamp keys become hour offsets from the recording's first `created` (`<t:+720h>`, `<t:~0>` within an hour). Hides: errors under one hour (off-by-minutes, second-level anchor drift) and wrong but in-range epochs of the same hour offset.",
  },
  {
    name: "run-nonce",
    rationale:
      "The per-run nonce (idempotency keys) is echoed in bodies and error messages; replaced by `<run>`. Hides: echoing the wrong run's key, as long as it has the same position in the string.",
  },
  {
    name: "secrets",
    rationale:
      "`client_secret` is random per object → `<secret>`. Hides: a secret that does not belong to its object or has the wrong format.",
  },
  {
    name: "stripe-hosted-urls",
    rationale:
      "Hosted invoice/receipt/PDF URLs embed per-account tokens; `https://…stripe.com|stripe.network/…` → `<url:HOST>`. Hides: wrong URL paths or query on a correct host.",
  },
  {
    name: "per-account-opaques",
    rationale:
      "`fingerprint` and `invoice_prefix` are per-account → `<opaque>`; invoice `number` keeps only its numeric suffix (`<number:-0002>`). Hides: fingerprints that fail to match across equal cards, wrong invoice prefixes.",
  },
  {
    name: "list-order",
    rationale:
      "Objects created within the same second list in arbitrary order; `data` of `list`/`search_result` is sorted by raw `created` descending, ties by normalized JSON. Hides: any wrong list order (e.g. ascending instead of newest-first, or misordered elements without `created`), not just same-second ties; page membership and `has_more` are still compared.",
  },
];

const ID = /^([a-z]+(?:_[a-z]+)*)_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{10,}$/;
const TS_KEYS = new Set([
  "created",
  "date",
  "start",
  "end",
  "start_date",
  "due_date",
  "billing_cycle_anchor",
  "frozen_time",
  "next_payment_attempt",
  "effective_at",
]);
const TS_SUFFIX = /(_at|_start|_end|_date)$/;
const STRIPE_HOST = /(^|\.)stripe\.(com|network)$/;
const INVOICE_NUMBER = /^[A-Z0-9]+-(\d+)$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
/** JSON.stringify replacer: canonical key order, so tie-breaks ignore a target's key order. */
const sortKeys = (_: string, x: unknown): unknown => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);

/** First integer `created`, depth-first, own key before children. */
function firstCreated(v: unknown): number | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const c = firstCreated(x);
      if (c !== undefined) return c;
    }
  } else if (isObj(v)) {
    if (Number.isInteger(v.created)) return v.created as number;
    for (const x of Object.values(v)) {
      const c = firstCreated(x);
      if (c !== undefined) return c;
    }
  }
  return undefined;
}

export function normalizeRecording(r: Recording): Recording {
  const nonce = runNonce(r.runId, r.seq);
  let t0: number | undefined;
  for (const s of r.steps) if ((t0 = firstCreated(s.body)) !== undefined) break;

  const str = (s: string): string => {
    const id = ID.exec(s);
    if (id) return `<id:${id[1]}>`;
    if (s.startsWith("https://")) {
      try {
        const host = new URL(s).hostname;
        if (STRIPE_HOST.test(host)) return `<url:${host}>`;
      } catch {}
    }
    return s.replaceAll(nonce, "<run>");
  };

  const field = (parent: Obj, k: string, v: unknown): unknown => {
    if (typeof v === "string") {
      if (k === "client_secret") return "<secret>";
      if (k === "fingerprint" || k === "invoice_prefix") return "<opaque>";
      const num = k === "number" && parent.object === "invoice" ? INVOICE_NUMBER.exec(v) : null;
      if (num) return `<number:-${num[1]}>`;
    }
    // ponytail: no anchor (no `created` in any step body) leaves timestamps raw; they then surface as noise.
    if (t0 !== undefined && Number.isInteger(v) && (TS_KEYS.has(k) || TS_SUFFIX.test(k))) {
      const t = v as number;
      if (t >= 946684800 && t <= 4102444800) {
        if (Math.abs(t - t0) < 3600) return "<t:~0>";
        const n = Math.round((t - t0) / 3600);
        return `<t:${n >= 0 ? "+" : ""}${n}h>`;
      }
    }
    return walk(v);
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = field(v, k, x);
    if ((v.object === "list" || v.object === "search_result") && Array.isArray(v.data)) {
      const norm = out.data as unknown[];
      out.data = v.data
        .map((raw, i) => ({ c: isObj(raw) && typeof raw.created === "number" ? raw.created : 0, n: norm[i], j: JSON.stringify(norm[i], sortKeys) }))
        .sort((a, b) => b.c - a.c || (a.j < b.j ? -1 : a.j > b.j ? 1 : 0))
        .map((e) => e.n);
    }
    return out;
  };

  const out = structuredClone(r);
  for (const s of out.steps) s.body = walk(s.body);
  out.events = walk(out.events) as Recording["events"];
  return out;
}

/** Identity copy: the raw, un-normalized comparison (for the raw noise floor). */
export function normalizeRaw(r: Recording): Recording {
  return structuredClone(r);
}
