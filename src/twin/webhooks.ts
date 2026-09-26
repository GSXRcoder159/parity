// Webhook delivery: after each store.apply, every enabled endpoint subscribed to an event gets a signed POST of it,
// retried on a non-2xx (a 3xx included: redirects are not followed), a network error or no answer within 10 s.
// Fire-and-forget: the API response never waits for it.
import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { StripeEvent } from "../types.ts";
import type { Store } from "./store.ts";

/** Delays before the 3 retries. */
export const BACKOFF_MS = [1000, 5000, 25000];
/** An attempt with no complete response by then is aborted and counts as failed. */
export const TIMEOUT_MS = 10_000;

/** `Stripe-Signature`: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<payload>" keyed by the endpoint secret>`. */
export const sign = (payload: string, secret: string, t: number) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

/** Same endpoint set as the store's `pending_webhooks` count, taken synchronously right after apply. */
export function deliver(store: Store, events: StripeEvent[], backoffMs = BACKOFF_MS, timeoutMs = TIMEOUT_MS): void {
  for (const evt of events) for (const ep of store.endpointsFor(evt.type)) void send(store, evt, ep.id as string, backoffMs, timeoutMs);
}

async function send(store: Store, evt: StripeEvent, id: string, backoffMs: number[], timeoutMs: number): Promise<void> {
  const payload = JSON.stringify(evt, null, 2); // the same bytes on every attempt
  for (let attempt = 0; ; attempt++) {
    // An endpoint disabled or deleted since (or a store reset) stops the retries, like the real API.
    const ep = store.objects.get(id);
    if (ep?.status !== "enabled") return;
    try {
      // Wall clock, not Parity-Now: receivers check the timestamp against their own clock.
      const t = Math.floor(Date.now() / 1000);
      const res = await fetch(String(ep.url), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", "Stripe-Signature": sign(payload, String(ep.secret), t) },
        body: payload,
        redirect: "manual", // the real API does not follow redirects and counts them as failures
        signal: AbortSignal.timeout(timeoutMs), // covers the body read too; its timer never keeps the process alive
      });
      await res.arrayBuffer();
      if (res.ok) {
        evt.pending_webhooks = (evt.pending_webhooks as number) - 1;
        return;
      }
    } catch {
      // A network error or a timeout is retried like a non-2xx.
    }
    if (attempt >= backoffMs.length) return;
    await sleep(backoffMs[attempt], undefined, { ref: false }); // unref: pending retries never keep the process alive
  }
}
