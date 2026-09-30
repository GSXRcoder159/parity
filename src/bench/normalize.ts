// Normalization v1.5: rewrites run-specific values (ids, timestamps, readable dates in text, a declined invoice's retry
// day, nonces, secrets, hosted URLs, per-account and simulated card-network opaques, dashboard links, the unclaimed-sandbox banner) so two
// faithful runs compare equal. List order is compared as returned. Published with every score.
import type { Recording } from "../types.ts";
import { runNonce } from "./run.ts";

export const NORMALIZATION_VERSION = "v1.5";

export const RULES: { name: string; rationale: string }[] = [
  {
    name: "ids",
    rationale:
      "Object ids are random per run; `cus_Ab12…` → `<id:cus>` keeps the prefix, both as a whole string and embedded word-bounded in a longer one (`No such customer: 'cus_Ab12…'` → `No such customer: '<id:cus>'`). Hides: an id pointing at the wrong object of the right type (e.g. `customer` set to another customer, or an error message citing another customer), and malformed id tails.",
  },
  {
    name: "timestamps",
    rationale:
      "Absolute times differ per run; times under timestamp keys (`created`, `updated`, `date`, `deletes_after`, `*_at`, `*_start`, `*_end`, `*_date`, `*_time`, …; v1.3 added `deletes_after` and the `*_time` suffix, for a test clock's `status_details.advancing.target_frozen_time`) become hour offsets from the recording's first `created` (`<t:+720h>`, `<t:~0>` within an hour). Hides: errors under one hour (off-by-minutes, second-level anchor drift) and wrong but in-range epochs of the same hour offset. Not applied to an event's own top-level `created`: events are compared by type set and causal order (compare method m2), never by value, and the order check needs the raw times.",
  },
  {
    name: "readable-dates",
    rationale:
      "Proration line descriptions embed the calendar day the sandbox ran (`Unused time on … after 29 Sep 2026`), so recordings of one sequence made on different days differ (drift/2026-09-29.md). v1.5: a date in Stripe's `D Mon YYYY` form inside any string becomes `<date>` (`Unused time on … after <date>`); the `Month D, YYYY` form does not occur in the corpus. Hides: a wrong date in the text (e.g. a twin writing the period end instead of the proration day) and a wrong text date format of that form. The dates themselves are still compared, hour-granular, in the timestamp fields (the line's `period.start`/`period.end`).",
  },
  {
    name: "retry-day",
    rationale:
      "After a declined payment attempt the sandbox schedules the retry a random 42–46 h later (#30: the 2026-09-28 noise pair, and the same spread over its 20 oracle seeds). v1.4: `next_payment_attempt` on an invoice with `attempt_count` > 0 becomes a whole-day offset from the timestamps rule's anchor, rounded (`<t:+35d>`); before any attempt it stays hour-granular. Hides: a retry time that rounds to the same day as the oracle's (up to ±12 h off, e.g. a fixed 48 h, or 38 h instead of 46 h).",
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
      "`fingerprint`, `invoice_prefix` and (v1.5) `account_name` are per-account → `<opaque>`; `account_name` also when null, because it is an account setting: the unclaimed sandbox returned null and the claimed one its display name (2026-09-26 vs 2026-09-28 recordings; drift/2026-09-28.md, drift/2026-09-29.md). Invoice `number` keeps only its numeric suffix (`<number:-0002>`). Hides: fingerprints that fail to match across equal cards, wrong invoice prefixes, a wrong account name, and a null-vs-name difference in `account_name` (a twin that never fills it in).",
  },
  {
    name: "card-network-opaques",
    rationale:
      "Simulated card-network values are random per charge: `authorization_code`, `network_transaction_id` and `transaction_link_id` (charge `payment_method_details.card`) and `risk_score` (`outcome`; a fraud/risk field, never published per decision 0001 R8) → `<opaque>` wherever they are non-null. Hides: a wrong value, format or type in those fields (a null-vs-value difference is still compared).",
  },
  {
    name: "card-eci",
    rationale:
      "A Visa charge's `payment_method_details.card.electronic_commerce_indicator` takes one of two values that nothing in the sequence selects (same test card, no 3DS; #8 in the 2026-09-28 noise pair). v1.4: it becomes `<opaque>` wherever it is non-null (Mastercard charges carry null). Hides: a wrong ECI value, format or type (a null-vs-value difference is still compared). 3DS's own `three_d_secure.electronic_commerce_indicator` is not rewritten.",
  },
  {
    name: "request-log-url",
    rationale:
      "`error.request_log_url` is a dashboard link, and the unclaimed sandbox omits it exactly on the responses that carry the sandbox banner; the key is dropped. Hides: a target that omits it, adds it, or points it anywhere.",
  },
  {
    name: "refund-network-reference",
    rationale:
      "A refund's `destination_details.card.{reference, reference_status, reference_type}` is a random card-network reference assigned asynchronously (sometimes still absent when read back); those keys are dropped from refunds. Hides: a target that omits them, adds them, or never moves `reference_status` from `pending` to `available`.",
  },
  {
    name: "list-order",
    rationale:
      "Not normalized: `data` of lists and search results is compared in the order returned. Stripe lists are deterministic (`created` descending, same-second ties in reverse insertion order; templates-validation.md), and v1.1's sort created the W0 pagination noise by reordering same-second elements. Hides: nothing (a wrong order is a divergence).",
  },
  {
    name: "sandbox-banner",
    rationale:
      "Unclaimed sandboxes prefix error messages with `This is an unclaimed Stripe sandbox. Dashboard links in this error message will not work until the sandbox is claimed. `; that exact prefix is stripped (account state, not API behavior; it disappears once the sandbox is claimed). Hides: a target that emits the banner itself, and a claimed-vs-unclaimed oracle difference in that prefix.",
  },
];

// Same grammar as run.ts ID, word-bounded so ids inside messages match too (`_` is a word char: `pi_…_secret_…` does not).
const ID = /\b([a-z]+(?:_[a-z]+)*)_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{10,}\b/g;
// Stripe's human-readable date in text (proration line descriptions): `29 Sep 2026`.
const DATE = /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/g;
const BANNER = "This is an unclaimed Stripe sandbox. Dashboard links in this error message will not work until the sandbox is claimed. ";
const TS_KEYS = new Set([
  "created",
  "updated",
  "date",
  "start",
  "end",
  "start_date",
  "due_date",
  "billing_cycle_anchor",
  "frozen_time",
  "next_payment_attempt",
  "effective_at",
  "deletes_after",
]);
const TS_SUFFIX = /(_at|_start|_end|_date|_time)$/;
const STRIPE_HOST = /(^|\.)stripe\.(com|network)$/;
const INVOICE_NUMBER = /^[A-Z0-9]+-(\d+)$/;
const CARD_NETWORK = new Set(["authorization_code", "network_transaction_id", "transaction_link_id", "risk_score"]);
const REFUND_REFERENCE = ["reference", "reference_status", "reference_type"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

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

  const str = (raw: string): string => {
    const s = raw.startsWith(BANNER) ? raw.slice(BANNER.length) : raw;
    if (s.startsWith("https://")) {
      try {
        const host = new URL(s).hostname;
        if (STRIPE_HOST.test(host)) return `<url:${host}>`;
      } catch {}
    }
    return s.replaceAll(nonce, "<run>").replace(ID, (_, prefix: string) => `<id:${prefix}>`).replace(DATE, "<date>");
  };

  const field = (parent: Obj, k: string, v: unknown): unknown => {
    if (k === "account_name") return "<opaque>"; // null too: an unclaimed sandbox has no account name
    if (typeof v === "string") {
      if (k === "client_secret") return "<secret>";
      if (k === "fingerprint" || k === "invoice_prefix") return "<opaque>";
      const num = k === "number" && parent.object === "invoice" ? INVOICE_NUMBER.exec(v) : null;
      if (num) return `<number:-${num[1]}>`;
    }
    if (CARD_NETWORK.has(k) && v !== null) return "<opaque>";
    // ponytail: no anchor (no `created` in any step body) leaves timestamps raw; they then surface as noise.
    if (t0 !== undefined && Number.isInteger(v) && (TS_KEYS.has(k) || TS_SUFFIX.test(k))) {
      const t = v as number;
      if (t >= 946684800 && t <= 4102444800) {
        if (k === "next_payment_attempt" && parent.object === "invoice" && (parent.attempt_count as number) > 0) {
          const d = Math.round((t - t0) / 86400);
          return `<t:${d >= 0 ? "+" : ""}${d}d>`;
        }
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
    // Dropped keys (v is part of the structuredClone below, so deleting is safe).
    if (isObj(v.error)) delete v.error.request_log_url;
    const card = v.object === "refund" && isObj(v.destination_details) ? v.destination_details.card : undefined;
    if (isObj(card)) for (const k of REFUND_REFERENCE) delete card[k];
    const pmCard = isObj(v.payment_method_details) ? v.payment_method_details.card : undefined;
    if (isObj(pmCard) && pmCard.electronic_commerce_indicator != null) pmCard.electronic_commerce_indicator = "<opaque>";
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = field(v, k, x);
    return out;
  };

  const out = structuredClone(r);
  // Step params by the same rules and the bodies' anchor (they hold resolved ids and run nonces; 0001 C3). Never compared.
  for (const s of out.steps) {
    s.body = walk(s.body);
    if (s.params) s.params = walk(s.params) as Obj;
  }
  // An event's own `created` stays raw: compare orders events by it (method m2), and events are never compared by value.
  out.events = out.events.map((e) => ({ ...(walk(e) as Recording["events"][number]), created: e.created }));
  return out;
}

/** Identity copy: the raw, un-normalized comparison (for the raw noise floor). */
export function normalizeRaw(r: Recording): Recording {
  return structuredClone(r);
}
