// Webhook delivery: after each store.apply, every enabled endpoint subscribed to an event gets a signed POST of it,
// retried on a non-2xx or network error. Fire-and-forget: the API response never waits for it.
import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { StripeEvent } from "../types.ts";
import type { Store } from "./store.ts";

type Obj = Record<string, unknown>;

/** Delays before the 3 retries. */
export const BACKOFF_MS = [1000, 5000, 25000];

/** `Stripe-Signature`: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<payload>" keyed by the endpoint secret>`. */
export const sign = (payload: string, secret: string, t: number) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

const enabled = (o: Obj | undefined): o is Obj => o?.object === "webhook_endpoint" && o.status === "enabled";

/** Same endpoint set as the store's `pending_webhooks` count, taken synchronously right after apply. */
export function deliver(store: Store, events: StripeEvent[], backoffMs = BACKOFF_MS): void {
  for (const evt of events) {
    for (const ep of store.objects.values()) {
      const on = ep.enabled_events as string[] | undefined;
      if (enabled(ep) && on?.some((t) => t === "*" || t === evt.type)) void send(store, evt, ep.id as string, backoffMs);
    }
  }
}

// ponytail: no request timeout, so a receiver that never answers holds its delivery pending forever; add AbortSignal.timeout if that shows up.
async function send(store: Store, evt: StripeEvent, id: string, backoffMs: number[]): Promise<void> {
  const payload = JSON.stringify(evt, null, 2); // the same bytes on every attempt
  for (let attempt = 0; ; attempt++) {
    // An endpoint disabled or deleted since (or a store reset) stops the retries, like the real API.
    const ep = store.objects.get(id);
    if (!enabled(ep)) return;
    try {
      // Wall clock, not Parity-Now: receivers check the timestamp against their own clock.
      const t = Math.floor(Date.now() / 1000);
      const res = await fetch(String(ep.url), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", "Stripe-Signature": sign(payload, String(ep.secret), t) },
        body: payload,
      });
      await res.arrayBuffer();
      if (res.ok) {
        evt.pending_webhooks = (evt.pending_webhooks as number) - 1;
        return;
      }
    } catch {
      // A network error is retried like a non-2xx.
    }
    if (attempt >= backoffMs.length) return;
    await sleep(backoffMs[attempt], undefined, { ref: false });
  }
}
