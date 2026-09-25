import type { Template } from "../src/types.ts";
import { email, tag } from "./common.ts";

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
