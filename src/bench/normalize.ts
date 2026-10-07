// Normalization v1.8: rewrites run-specific values (ids, timestamps, calendar months plus hours or after a trial, dates in text, a declined
// invoice's retry day, nonces, secrets, hosted URLs, per-account and simulated card-network opaques, test-card expiry, dashboard
// links, the unclaimed-sandbox banner) so two faithful runs compare equal. List order is compared as returned. Published with every score.
import type { Recording } from "../types.ts";
import { runNonce } from "./run.ts";

export const NORMALIZATION_VERSION = "v1.8";

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
    name: "calendar-months",
    rationale:
      "A one-month period is 30 days from a September start and 31 from an October one, so v1.5 rendered one sequence's period end `<t:+720h>` when recorded on 2026-09-28 and `<t:+744h>` when re-recorded on 2026-10-01: period ends, `cancel_at`, a renewal invoice's `created`, a test clock's `frozen_time` (drift/2026-10-01.md). v1.6: a timestamp within an hour of t0 + k calendar months (k ≠ 0; UTC, the day clamped to the target month's length as Stripe bills a month-end anchor: Jan 31 + 1 month = Feb 28; a year is 12 months) becomes `<t:+kmo>`. A month plus a fixed time moved the same way under v1.6: a renewal invoice finalized 72 h after the period end (its `automatically_finalizes_at`, `effective_at`, `finalized_at`, `paid_at`, and a clock advanced to it) and its `next_payment_attempt` 1 h after it read `+792h` and `+721h` from a September t0 and `+816h` and `+745h` from an October one (drift/2026-10-02.md, drift/2026-10-03.md). v1.7, in this order after `<t:+kmo>`: (a) a subscription with a trial bills in calendar months from its `trial_end`, which is days from t0 (`trial_period_days`), so the end of its first paid period is days, then a month, out (held-out clock-trial-end's monthly seeds: t0 + 7 days + 1 month). A timestamp within an hour of A + k calendar months (k ≥ 1), A any `trial_end` in the recording's step bodies at least an hour after t0, becomes `<t:+Nh+kmo>`, N the hours from t0 to A (A's own label is `<t:+Nh>`): `<t:+168h+1mo>` from 28 September and from 1 October. Counted from t0 it moves by the months' lengths: v1.6's hour bucket by the trial end's month (`+912h` from 1 October, `+888h` from 1 November), the month-plus-hours form of (b) by the difference between that month and t0's (`<t:+1mo+192h>` from 28 September, `<t:+1mo+168h>` from 1 October). Found in review, on synthetic data (held-out recordings are not opened): without (a), (b) split every pair of such a period end recorded on 28 September and re-recorded on 1–7 October (77 of 77; v1.6 none), and a week apart, over a year of t0s and trials of 4–14 days, it split 36% of pairs (v1.6 20%). (b) Any other timestamp at least one calendar month after t0 becomes `<t:+kmo+Nh>`, k the most whole calendar months (same arithmetic) with t0 + k months not after it and N the hours left, rounded as the hour buckets round (`<t:+1mo+72h>`, `<t:+1mo+1h>`); the exact-month window stays ±1 h, so N is never 0. Offsets under one month, and offsets before t0 other than a whole number of months, keep their hour bucket. Each recording renders against its own t0 and its own trial ends. Not applied to `deletes_after`, `due_date` and `trial_end`, which Stripe counts in days (a test clock is deleted 30 days after creation; `days_until_due`, `trial_period_days`): 30 days from a September t0 is also exactly one calendar month, so the rule would render them `<t:+1mo>` in September and `<t:+720h>` in October (it did, for `deletes_after`, when v1.6 was first replayed on drift/2026-10-01.md; `due_date` would on invoice-send-invoice seed 10, 30 days until due). Another key counted in days needs the same exclusion once a template makes it span a month. Hides: between two recordings whose t0 (or trial ends) fall in months of different lengths (drift's re-recordings), the month's length, which is the point, on whole months (v1.6), on months plus hours and on months after a trial (v1.7); a twin replayed at another month's clock than the oracle's (score-twin's Parity-Now pin lost), which before v1.6 showed on period ends and before v1.7 still showed on a renewal's finalization times and a period end after a trial (test/cli.test.ts checks the pin on the twin's raw recordings instead); and an error under an hour either side of t0 + k months or of a trial end + k months (the hour buckets also hid under an hour, by rounding). Against one t0, (b) hides nothing v1.6 showed: t0 + k months is a whole number of hours after t0 (the UTC time of day is kept), so `<t:+kmo+Nh>` is the v1.6 hour bucket relabeled one to one (`<t:+816h>` from 1 October is `<t:+1mo+72h>`); (a), like `<t:+kmo>`, names one instant to within an hour, so it hides only an error under an hour that the hour buckets may have shown. A twin scored against the oracle runs at the oracle's Parity-Now, so its t0 is the oracle's to within the pin: `<t:+kmo>` on both sides is the same instant within an hour, and `<t:+kmo+Nh>` the same hour; `<t:+Nh+kmo>` is the same instant within an hour when the twin's `trial_end` is the oracle's, and a twin whose `trial_end` differs (itself a divergence) can label the same instant differently: an extra divergence, never a hidden one. Not hidden: a twin that adds 30 days where Stripe adds a calendar month, or the reverse, with or without a fixed delay after it, renders `<t:+720h>` against `<t:+1mo>` and `<t:+1mo+48h>` against `<t:+1mo+72h>` (from 1 October) whenever t0 + 1 month is not t0 + 30 days, and after a trial, `<t:+1mo+144h>` against `<t:+168h+1mo>` (a 7-day trial from 1 October) whenever the trial end + 1 month is not + 30 days. When it is (t0, or the trial end, in April, June, September or November, or a month end such as March 31 → April 30) both sides render the same, as both did in hours under v1.5: that gap is unchanged by v1.6 and v1.7, and only sequences recorded (or trials ending) in other months expose it. New in v1.7, false drift rather than a hidden bug: a timestamp Stripe counts as a fixed number of days from t0, more than a month out and on a key outside that exclusion, now differs between months of different lengths (35 days is `<t:+1mo+120h>` from September, `<t:+1mo+96h>` from October), where its v1.6 hour bucket did not; and so does days, then a month, from a day that is not a `trial_end` (e.g. a `billing_cycle_anchor` set days out), as (a) describes, more often than under v1.6. Unchanged by v1.7: a time a fixed span before a month boundary (t0 + k months − 3 days) is counted in hours, from t0 or from the month before, and differs between such months under v1.6 and v1.7 alike. None of these is in the templates (`deletes_after` is 30 days, `due_date` at most 30, no template sets `billing_cycle_anchor`, every clock advance targets a period end, `cancel_at`, `trial_end` or `automatically_finalizes_at`; checked from the templates' source, held-out ones included, not from held-out recordings). Only clock-trial-end has a trial, and every train recording's `trial_end` is null, so (a) changes no train label.",
  },
  {
    name: "readable-dates",
    rationale:
      "Proration line descriptions embed the calendar day the sandbox ran (`Unused time on … after 29 Sep 2026`), so recordings of one sequence made on different days differ (drift/2026-09-29.md). v1.5: a date in Stripe's `D Mon YYYY` form inside any string becomes `<date>` (`Unused time on … after <date>`); the `Month D, YYYY` form does not occur in the corpus. Hides: a wrong date in the text (e.g. a twin writing the period end instead of the proration day) and a wrong text date format of that form. The dates themselves are still compared, hour-granular, in the timestamp fields (the line's `period.start`/`period.end`).",
  },
  {
    name: "retry-day",
    rationale:
      "After a declined payment attempt the sandbox schedules the retry a random 42–46 h later (#30: the 2026-09-28 noise pair, and the same spread over its 20 oracle seeds). v1.4: `next_payment_attempt` on an invoice with `attempt_count` > 0 becomes a whole-day offset from the timestamps rule's anchor, rounded (`<t:+35d>`); before any attempt it stays hour-granular. v1.7: the retry after a monthly renewal is a month plus about 5 days, so it read `<t:+35d>` from a September t0 and `<t:+36d>` from an October one (drift/2026-10-02.md); a retry whose rounded day is at least a calendar month out now counts its days from the last whole month before that day (rule calendar-months' arithmetic; `<t:+1mo+5d>`), so the day count is 0 to the month's length − 1. Hides: a retry time that rounds to the same day as the oracle's (up to ±12 h off, e.g. a fixed 48 h, or 38 h instead of 46 h); and, as rule calendar-months, the month's length between recordings whose t0 fall in months of different lengths.",
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
    name: "card-expiry",
    rationale:
      "Stripe's test cards (`pm_card_visa`, `pm_card_mastercard`, …) expire in the month of the request one year on (every train oracle recording, September's and October's), so `exp_month` differed on every payment method of drift/2026-10-01.md, the first night in a new month, against its September recording (39 of its 106 rows), and `exp_year` will on 1 January. v1.6: `card.exp_month` and `card.exp_year` of a payment method (also nested, e.g. in an error) and of a charge's `payment_method_details` become `<opaque>` when they hold a valid month (an integer 1–12) or year (an integer from 2000); any other value is compared, so null, a string, or the 0 of a twin that never computes an expiry (its templates hold 0) is still a divergence. v1.8 (review of assisted PRs #9–#12): a year was any integer from 2000, so a unix-seconds `exp_year` passed, and each field was judged alone, so a valid month next to a bad year was hidden. Now the pair becomes `<opaque>` only when `exp_month` is an integer 1–12 and `exp_year` an integer from Y − 1 to Y + 20, Y the UTC year of the timestamps rule's anchor (t0); otherwise both are compared raw, as they are in a recording with no anchor. Every train oracle expiry is Y + 1 (1,235 card objects in step bodies and events, months 9 and 10; held-out recordings not opened), so v1.8 changes no train oracle label. Hides: a wrong but plausible expiry: any month 1–12 (a random month, or a twin that always answers 12) and any year in that 22-year window (a twin that always answers 12/2030).",
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
// Timestamps Stripe counts in days, never in calendar months (rule calendar-months).
const DAY_COUNT = new Set(["deletes_after", "due_date", "trial_end"]);
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

/**
 * `t` plus k calendar months in UTC, the day clamped to the target month's length (Stripe's billing anchor rule). Kept
 * here, not imported from the twin's billing.ts: the instrument does not share arithmetic with what it measures.
 */
function addMonths(t: number, k: number): number {
  const d = new Date(t * 1000);
  const m = d.getUTCMonth() + k;
  const last = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate(); // Date.UTC carries month overflow into the year
  return Date.UTC(d.getUTCFullYear(), m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

/** k ≠ 0 when `t` is within an hour of t0 + k calendar months. */
function wholeMonths(t0: number, t: number): number | undefined {
  const est = Math.round((t - t0) / 2_629_746); // the mean Gregorian month in seconds
  for (const k of [est - 1, est, est + 1]) if (k !== 0 && Math.abs(addMonths(t0, k) - t) < 3600) return k;
  return undefined;
}

/** Every integer `trial_end` in `v`: the trial anchors of rule calendar-months. */
function trialEnds(v: unknown, out: Set<number>): Set<number> {
  if (Array.isArray(v)) for (const x of v) trialEnds(x, out);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) k === "trial_end" && Number.isInteger(x) ? out.add(x as number) : trialEnds(x, out);
  return out;
}

/** The most calendar months k with t0 + k months ≤ t (0 under a month, negative before t0). */
function monthsBefore(t0: number, t: number): number {
  const [a, b] = [new Date(t0 * 1000), new Date(t * 1000)];
  const k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth(); // lands in t's month
  return addMonths(t0, k) > t ? k - 1 : k;
}

export function normalizeRecording(r: Recording): Recording {
  const nonce = runNonce(r.runId, r.seq);
  let t0: number | undefined;
  for (const s of r.steps) if ((t0 = firstCreated(s.body)) !== undefined) break;
  const trials = new Set<number>();
  for (const s of r.steps) trialEnds(s.body, trials);
  const anchors = t0 === undefined ? [] : [...trials].filter((a) => a - t0! >= 3600).sort((a, b) => a - b);
  const year = t0 === undefined ? undefined : new Date(t0 * 1000).getUTCFullYear(); // rule card-expiry's window

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
        const days = DAY_COUNT.has(k);
        if (k === "next_payment_attempt" && parent.object === "invoice" && (parent.attempt_count as number) > 0) {
          // Counted from the last whole month before the rounded day (+12 h), so the day count stays in 0 … month − 1.
          const m = monthsBefore(t0, t + 43200);
          const d = Math.round((t - (m > 0 ? addMonths(t0, m) : t0)) / 86400);
          return m > 0 ? `<t:+${m}mo+${d}d>` : `<t:${d >= 0 ? "+" : ""}${d}d>`;
        }
        if (Math.abs(t - t0) < 3600) return "<t:~0>";
        const mo = days ? undefined : wholeMonths(t0, t);
        if (mo !== undefined) return `<t:${mo > 0 ? "+" : ""}${mo}mo>`;
        for (const a of days ? [] : anchors) {
          const j = wholeMonths(a, t);
          if (j !== undefined && j > 0) return `<t:+${Math.round((a - t0) / 3600)}h+${j}mo>`;
        }
        const m = days ? 0 : monthsBefore(t0, t);
        if (m > 0) return `<t:+${m}mo+${Math.round((t - addMonths(t0, m)) / 3600)}h>`;
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
    for (const c of [pmCard, v.object === "payment_method" ? v.card : undefined]) {
      if (isObj(c) && year !== undefined && Number.isInteger(c.exp_month) && Number.isInteger(c.exp_year)) {
        const [m, y] = [c.exp_month as number, c.exp_year as number];
        if (m >= 1 && m <= 12 && y >= year - 1 && y <= year + 20) c.exp_month = c.exp_year = "<opaque>";
      }
    }
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = field(v, k, x);
    return out;
  };

  const out = structuredClone(r);
  // Step params by the same rules and the bodies' anchor (they hold resolved ids and run nonces; 0001 C3). compare.ts never
  // reads them; align's echo check (propose) needs them raw, so align's mechanical() puts the raw ones back.
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
