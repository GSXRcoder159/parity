import type { Step, Template } from "../src/types.ts";
import { amount, currency, customer, email, tag } from "./common.ts";

// #20: decimal amounts go as strings, never JS numbers (String(1e-13) is "1e-13", and floats lose digits).
export const boundariesAmounts: Template = {
  name: "boundaries-amounts",
  stratum: "boundaries",
  build(g) {
    const n = tag(g);
    const cur = currency(g);
    const price = (p: Record<string, unknown>): Step => ({
      method: "POST",
      path: "/v1/prices",
      params: { currency: cur, product_data: { name: `Parity boundaries ${n}` }, ...p },
    });
    const decimal = `${g.int(1, 999)}.${g.int(1, 9)}5`;
    const intent = (cents: number): Step => ({ method: "POST", path: "/v1/payment_intents", params: { amount: cents, currency: cur } });
    return [
      price({ unit_amount: 0 }),
      price({ unit_amount: 99_999_999_999_999 }), // the max (undocumented; found live)
      price({ unit_amount: 100_000_000_000_000 }),
      price({ unit_amount_decimal: decimal }),
      price({ unit_amount_decimal: `0.${"0".repeat(12)}1` }),
      price({ unit_amount: amount(g), unit_amount_decimal: decimal }),
      intent(g.int(1, 49)),
      intent(50),
    ];
  },
};

// #21 (held out)
export const boundariesListLimits: Template = {
  name: "boundaries-list-limits",
  stratum: "boundaries",
  heldOut: true,
  build(g) {
    const n = tag(g);
    const list = (p: Record<string, unknown>): Step => ({
      method: "GET",
      path: "/v1/customers",
      params: { email: email("boundaries-list-limits", n), created: { gte: "$c1.created" }, ...p },
    });
    // Two matches, so a clamped limit shows (limit=0 returns 1 with has_more).
    return [
      customer("boundaries-list-limits", n),
      customer("boundaries-list-limits", n, "c2"),
      list({ limit: 0 }),
      list({ limit: 101 }),
      list({ limit: 100 }),
      list({ starting_after: `cus_ParityMissing${n}` }),
    ];
  },
};
