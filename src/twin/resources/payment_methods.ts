// Payment methods: attach a test token (cards.json, from the public testing docs) to a customer, detach,
// retrieve, list by customer.
import { readFileSync } from "node:fs";
import { list } from "../list.ts";
import type { Ctx, Route } from "../server.ts";
import type { Emit } from "../store.ts";
import { assign, diff, live } from "../util.ts";

type Obj = Record<string, unknown>;
interface Card {
  brand: string;
  last4: string;
  funding: string;
  country: string;
  /** ok | attach_declined (attaching verifies the card and fails) | charge_fails (attaches, charges fail) */
  behavior: string;
  decline_code?: string;
}

const CARDS: Record<string, Card> = JSON.parse(readFileSync(new URL("../cards.json", import.meta.url), "utf8"));

const find = (ctx: Ctx, id: string | undefined) => live(ctx, id, "payment_method") ?? ctx.fail("resource_missing", { param: "payment_method" });
const ofCustomer = (ctx: Ctx, customer: unknown, params: Obj, url: string) =>
  list(ctx.all("payment_method").filter((p) => p.customer === customer && (!params.type || p.type === params.type)), params, url);

export const routes: Route[] = [
  [
    "POST",
    /^\/v1\/payment_methods\/(?<payment_method>[^/]+)\/attach$/,
    (ctx, { pathParams, params }) => {
      if (!params.customer) ctx.fail("parameter_missing", { param: "customer" });
      const customer = live(ctx, params.customer, "customer") ?? ctx.fail("resource_missing_400", { param: "customer" });
      const token = pathParams.payment_method!;
      const card = Object.hasOwn(CARDS, token) ? CARDS[token] : undefined;
      // ponytail: only test tokens attach; a stored pm_ (attached or detached) is refused as one case.
      if (!card) return ctx.fail(live(ctx, token, "payment_method") ? "payment_method_unattachable" : "resource_missing", { param: "payment_method" });
      const { behavior, decline_code, ...details } = card;
      if (behavior === "attach_declined") ctx.fail("card_declined", {}, { decline_code });
      const pm = ctx.build("payment_method", { id: ctx.id("pm"), created: ctx.now(), customer: customer.id, type: "card" });
      pm.card = { ...(pm.card as Obj), ...details, display_brand: details.brand };
      return { body: pm, emits: [{ type: "payment_method.attached", object: pm }] };
    },
    "post /v1/payment_methods/{payment_method}/attach",
  ],
  [
    "POST",
    /^\/v1\/payment_methods\/(?<payment_method>[^/]+)\/detach$/,
    (ctx, { pathParams }) => {
      const pm = find(ctx, pathParams.payment_method);
      if (!pm.customer) ctx.fail("payment_method_not_attached");
      const after = { ...pm, customer: null };
      const emits: Emit[] = [{ type: "payment_method.detached", object: after, previous_attributes: { customer: pm.customer } }];
      // Detaching the customer's default payment method clears it.
      const c = live(ctx, pm.customer, "customer");
      if (c && (c.invoice_settings as Obj | null)?.default_payment_method === pm.id) {
        const updated = assign(structuredClone(c), { invoice_settings: { default_payment_method: "" } });
        emits.push({ type: "customer.updated", object: updated, previous_attributes: diff(c, updated) });
      }
      return { body: after, emits };
    },
    "post /v1/payment_methods/{payment_method}/detach",
  ],
  ["GET", /^\/v1\/payment_methods\/(?<payment_method>[^/]+)$/, (ctx, { pathParams }) => ({ body: find(ctx, pathParams.payment_method) }), "get /v1/payment_methods/{payment_method}"],
  [
    "GET",
    /^\/v1\/payment_methods$/,
    // Without `customer` this lists payment methods attached to no customer.
    (ctx, { params }) => ({ body: ofCustomer(ctx, params.customer || null, params, "/v1/payment_methods") }),
    "get /v1/payment_methods",
  ],
  [
    "GET",
    /^\/v1\/customers\/(?<customer>[^/]+)\/payment_methods$/,
    (ctx, { pathParams, params }) => {
      const c = live(ctx, pathParams.customer, "customer") ?? ctx.fail("resource_missing", { param: "customer" });
      return { body: ofCustomer(ctx, c.id, params, `/v1/customers/${c.id}/payment_methods`) };
    },
    "get /v1/customers/{customer}/payment_methods",
  ],
];
