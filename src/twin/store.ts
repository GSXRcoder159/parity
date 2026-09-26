// In-memory event-sourced store: an append-only event log plus the projection it implies
// (live objects by id, tombstones of deleted ones) and the idempotency cache.
import { randomInt } from "node:crypto";
import type { StripeEvent } from "../types.ts";
import { build } from "./build.ts";

export const API_VERSION = "2026-08-26.dahlia";

type Obj = Record<string, unknown>;
export interface Emit {
  type: string;
  object: Obj;
  previous_attributes?: Obj;
}
/** What a handler changes: `emits` (event + projection), `puts` (projection only), `deletes` (tombstone bodies, keyed by their id). */
export interface Changes {
  emits?: Emit[];
  puts?: Obj[];
  deletes?: Obj[];
}
export interface Meta {
  now: number;
  requestId: string | null;
  idempotencyKey: string | null;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `prefix_` + 24 random base62 chars (14 for `cus`). */
export function newId(prefix: string): string {
  let s = "";
  for (let i = prefix === "cus" ? 14 : 24; i > 0; i--) s += B62[randomInt(62)];
  return `${prefix}_${s}`;
}

export class Store {
  events: StripeEvent[] = [];
  objects = new Map<string, Obj>();
  deleted = new Map<string, Obj>();
  idem = new Map<string, { hash: string; status: number; body: unknown; at: number }>();

  apply({ emits = [], puts = [], deletes = [] }: Changes, meta: Meta): StripeEvent[] {
    for (const o of puts) this.objects.set(o.id as string, o);
    const out = emits.map(({ type, object, previous_attributes }) => {
      const evt = build("event", {
        id: newId("evt"),
        api_version: API_VERSION,
        created: meta.now,
        data: previous_attributes ? { object: structuredClone(object), previous_attributes } : { object: structuredClone(object) },
        pending_webhooks: this.endpointsFor(type).length,
        request: { id: meta.requestId, idempotency_key: meta.idempotencyKey },
        type,
      }) as StripeEvent;
      this.objects.set(object.id as string, object);
      this.events.push(evt);
      return evt;
    });
    for (const t of deletes) {
      this.objects.delete(t.id as string);
      this.deleted.set(t.id as string, t);
    }
    return out;
  }

  /** Enabled webhook endpoints subscribed to `type`: the one matcher behind `pending_webhooks` and delivery. */
  endpointsFor(type: string): Obj[] {
    return [...this.objects.values()].filter(
      (o) => o.object === "webhook_endpoint" && o.status === "enabled" && (o.enabled_events as string[] | undefined)?.some((t) => t === "*" || t === type),
    );
  }

  reset(): void {
    this.events.length = 0;
    this.objects.clear();
    this.deleted.clear();
    this.idem.clear();
  }

  snapshot() {
    return { objects: [...this.objects.values()], deleted: [...this.deleted.values()], events: this.events.length };
  }
}
