import type { Step, Template } from "../src/types.ts";
import { customer, email, tag } from "./common.ts";

// #14
export const idempotencyReplay: Template = {
  name: "idempotency-replay",
  stratum: "idempotency",
  build(g) {
    const n = tag(g);
    const params = { email: email("idempotency-replay", n), name: `Parity ${n}` };
    const k1 = { "Idempotency-Key": "parity-$run-k1" };
    return [
      { ref: "c1", method: "POST", path: "/v1/customers", params, headers: k1 },
      { method: "POST", path: "/v1/customers", params, headers: k1 },
      { method: "POST", path: "/v1/customers", params: { ...params, name: `Parity ${n} changed` }, headers: k1 },
      { ref: "c2", method: "POST", path: "/v1/customers", params, headers: { "Idempotency-Key": "parity-$run-k2" } },
    ];
  },
};

// #25: a failure inside the endpoint (the card check on attach) is saved and replayed; a validation failure is not,
// so its key still works; a key is bound to the endpoint it was first used on.
export const idempotencyErrors: Template = {
  name: "idempotency-errors",
  stratum: "idempotency",
  build(g) {
    const n = tag(g);
    const params = { email: email("idempotency-errors", n), name: `Parity ${n}` };
    const k1 = { "Idempotency-Key": "parity-$run-k1" };
    const k2 = { "Idempotency-Key": "parity-$run-k2" };
    const decline: Step = { method: "POST", path: "/v1/payment_methods/pm_card_chargeDeclined/attach", params: { customer: "$c1.id" }, headers: k1 };
    return [
      customer("idempotency-errors", n),
      decline,
      decline,
      { method: "POST", path: "/v1/customers", params: { ...params, [g.pick(["nickname", "colour", "loyalty_tier"])]: "x" }, headers: k2 },
      { ref: "c2", method: "POST", path: "/v1/customers", params, headers: k2 },
      { method: "POST", path: "/v1/products", params: { name: `Parity product ${n}` }, headers: k2 },
    ];
  },
};
