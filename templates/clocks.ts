// Test clock templates #27–#30 (surface-added, W4 Task 4). Written from the public test-clock docs, validated on the
// sandbox on 2026-09-27 (docs/plan/impl/templates-validation.md). One customer per clock (docs cap: 3) and at most
// 2 invoices per subscription (cap: 5); every template deletes its clock at the end.
import type { Gen, Step, Template } from "../src/types.ts";
import { amount, attach, currency, customer, tag } from "./common.ts";

/**
 * A price, a test clock frozen at the price's `created` (now), a customer on the clock with an attached card, and a
 * subscription paid by that card: refs pr1, ck, c1, pm1, s1. The sandbox stamps a clock's events with the wall clock
 * (so the run's event sweep collects them) and the objects an advance creates with the clock's frozen time.
 */
function onClock(g: Gen, template: string, sub: Record<string, unknown> = {}): Step[] {
  const n = tag(g);
  const c1 = customer(template, n);
  return [
    {
      ref: "pr1",
      method: "POST",
      path: "/v1/prices",
      params: { currency: currency(g), unit_amount: amount(g), recurring: { interval: g.pick(["month", "year"]) }, product_data: { name: `Parity plan ${n}` } },
    },
    { ref: "ck", method: "POST", path: "/v1/test_helpers/test_clocks", params: { frozen_time: "$pr1.created", name: `Parity ${template} ${n}` } },
    { ...c1, params: { ...c1.params, test_clock: "$ck.id" } },
    attach(g.pick(["pm_card_visa", "pm_card_mastercard"])),
    { ref: "s1", method: "POST", path: "/v1/subscriptions", params: { customer: "$c1.id", items: [{ price: "$pr1.id" }], default_payment_method: "$pm1.id", ...sub } },
  ];
}

/**
 * Advances the clock to `frozenTime` (a ref: the runner has no arithmetic), then retrieves it once after `waitMs` (the
 * runner has no loops either). The sandbox refuses a clock's modifications, its delete included, while it advances
 * (429). Sandbox advances reached `ready` within 24 s, 10 clocks at once included; one that charges a declining card
 * took 208–393 s (reports/2026-09-27-clocks.md).
 */
const advance = (frozenTime: string, waitMs = 40_000): Step[] => [
  { method: "POST", path: "/v1/test_helpers/test_clocks/$ck.id/advance", params: { frozen_time: frozenTime } },
  { method: "GET", path: "/v1/test_helpers/test_clocks/$ck.id", waitMs },
];

const invoices = (ref?: string): Step => ({ ref, method: "GET", path: "/v1/invoices", params: { customer: "$c1.id" } });
const retrieve: Step = { method: "GET", path: "/v1/subscriptions/$s1.id" };
const deleteClock: Step = { method: "DELETE", path: "/v1/test_helpers/test_clocks/$ck.id" };

// #27
export const clockPeriodRollover: Template = {
  name: "clock-period-rollover",
  stratum: "clocks",
  build(g) {
    return [
      ...onClock(g, "clock-period-rollover"),
      // The period's end renews the subscription on a draft invoice (the newest). Its automatically_finalizes_at is 3 days
      // later on the sandbox (next_payment_attempt 1 h); by then it is finalized and paid.
      ...advance("$s1.items.data.0.current_period_end"),
      invoices("l1"),
      ...advance("$l1.data.0.automatically_finalizes_at"),
      invoices(),
      retrieve,
      deleteClock,
    ];
  },
};

// #28 (held out)
export const clockTrialEnd: Template = {
  name: "clock-trial-end",
  stratum: "clocks",
  heldOut: true,
  build(g) {
    return [...onClock(g, "clock-trial-end", { trial_period_days: g.int(4, 14) }), ...advance("$s1.trial_end"), retrieve, invoices(), deleteClock];
  },
};

// #29
export const clockCancelAtPeriodEnd: Template = {
  name: "clock-cancel-at-period-end",
  stratum: "clocks",
  build(g) {
    return [
      ...onClock(g, "clock-cancel-at-period-end"),
      { ref: "s2", method: "POST", path: "/v1/subscriptions/$s1.id", params: { cancel_at_period_end: true } },
      ...advance("$s2.cancel_at"),
      retrieve,
      invoices(),
      deleteClock,
    ];
  },
};

// #30
export const clockDeclinedRenewal: Template = {
  name: "clock-declined-renewal",
  stratum: "clocks",
  build(g) {
    return [
      // The first invoice is paid by a good card; the renewal is charged to one that attaches but declines charges.
      ...onClock(g, "clock-declined-renewal"),
      attach("pm_card_chargeCustomerFail", "pm2"),
      { method: "POST", path: "/v1/subscriptions/$s1.id", params: { default_payment_method: "$pm2.id" } },
      ...advance("$s1.items.data.0.current_period_end"),
      invoices("l1"),
      // After the declined charge the sandbox clock stays `advancing` for minutes (cause unknown).
      ...advance("$l1.data.0.automatically_finalizes_at", 600_000),
      retrieve,
      invoices(),
      deleteClock,
    ];
  },
};
