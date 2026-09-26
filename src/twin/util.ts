// Helpers the resource modules share: live lookup, param assignment, previous_attributes diff, attached-pm check.
import type { Ctx } from "./server.ts";

type Obj = Record<string, unknown>;

export const isHash = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The live (not deleted) object `id` of `type`, else undefined. */
export function live(ctx: Ctx, id: unknown, type: string): Obj | undefined {
  const o = typeof id === "string" && id ? ctx.get(id) : undefined;
  return o?.object === type && !o.deleted ? o : undefined;
}

/**
 * Writes form params onto `o` (only `keys` at the top level, when given): "" unsets (null), hashes merge
 * into hashes, `metadata` merges and drops keys set to "" (metadata="" clears it).
 */
export function assign(o: Obj, params: Obj, keys?: string[]): Obj {
  for (const [k, v] of Object.entries(params)) {
    if (keys && !keys.includes(k)) continue;
    if (k === "metadata") {
      o.metadata = v === "" ? {} : Object.fromEntries(Object.entries({ ...(o.metadata as Obj), ...(v as Obj) }).filter(([, x]) => x !== ""));
    } else if (isHash(v)) o[k] = assign(isHash(o[k]) ? o[k] : {}, v);
    else o[k] = v === "" ? null : v;
  }
  return o;
}

/** `previous_attributes`: the old value of each changed key (null if it did not exist); hashes recurse. */
export function diff(before: Obj, after: Obj): Obj {
  const prev: Obj = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [b, a] = [before[k], after[k]];
    if (JSON.stringify(b) !== JSON.stringify(a)) prev[k] = isHash(b) && isHash(a) ? diff(b, a) : (b ?? null);
  }
  return prev;
}

/**
 * The payment method `id` if it is still attached to `customer`, else undefined: a detached one can never be charged
 * again (docs: "once detached, a PaymentMethod can no longer be used for payments").
 */
export function attachedPm(ctx: Ctx, id: unknown, customer: unknown): Obj | undefined {
  const pm = live(ctx, id, "payment_method");
  return pm && pm.customer === customer ? pm : undefined;
}

/** A payment method id param must name a payment method attached to `customer` (undefined: not created yet). */
export function checkAttached(ctx: Ctx, pm: unknown, customer: unknown, param = "default_payment_method"): void {
  if (typeof pm !== "string" || pm === "") return;
  const o = live(ctx, pm, "payment_method") ?? ctx.fail("resource_missing_400", { param });
  if (o.customer !== customer) ctx.fail("default_payment_method_not_attached", { param });
}
