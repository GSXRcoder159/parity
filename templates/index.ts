import type { Template } from "../src/types.ts";
import { subscriptionCancelAtPeriodEnd, subscriptionCancelNow } from "./cancellation.ts";
import { cardDeclined, invalidParams, resourceMissing } from "./errors.ts";
import { subscriptionEvents } from "./events.ts";
import { idempotencyReplay } from "./idempotency.ts";
import { customerCrud, customerListPagination, paymentMethodAttach, productPriceCrud, subscriptionCreate } from "./lifecycle.ts";
import { refundFull, refundOverAndNegative, refundPartialThenRest } from "./refunds.ts";

/** Catalog order (#1–#15; #16–#30 come later). */
export const TEMPLATES: Template[] = [
  customerCrud,
  customerListPagination,
  productPriceCrud,
  paymentMethodAttach,
  subscriptionCreate,
  subscriptionCancelNow,
  subscriptionCancelAtPeriodEnd,
  refundFull,
  refundPartialThenRest,
  refundOverAndNegative,
  resourceMissing,
  invalidParams,
  cardDeclined,
  idempotencyReplay,
  subscriptionEvents,
];
