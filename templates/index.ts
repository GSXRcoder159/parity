import type { Template } from "../src/types.ts";
import { boundariesAmounts, boundariesListLimits } from "./boundaries.ts";
import { customerDeleteCascade, subscriptionCancelAtPeriodEnd, subscriptionCancelNow } from "./cancellation.ts";
import { clockCancelAtPeriodEnd, clockDeclinedRenewal, clockPeriodRollover, clockTrialEnd } from "./clocks.ts";
import { cardDeclined, invalidParams, resourceMissing } from "./errors.ts";
import { subscriptionEvents, webhookEndpointCrud } from "./events.ts";
import { idempotencyErrors, idempotencyReplay } from "./idempotency.ts";
import {
  customerCrud,
  customerListPagination,
  customerSearch,
  expandPaths,
  invoiceSendInvoice,
  paymentMethodAttach,
  productPriceCrud,
  subscriptionCreate,
} from "./lifecycle.ts";
import { invoicePreviewProration, subscriptionIntervalSwap, subscriptionUpdatePrice, subscriptionUpdateQuantity } from "./proration.ts";
import { refundFull, refundOverAndNegative, refundPartialThenRest } from "./refunds.ts";

/** Catalog order (#1–#31). New templates go last: nightly slices index the corpus in this order. */
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
  invoicePreviewProration,
  subscriptionUpdatePrice,
  subscriptionUpdateQuantity,
  invoiceSendInvoice,
  boundariesAmounts,
  boundariesListLimits,
  expandPaths,
  customerSearch,
  webhookEndpointCrud,
  idempotencyErrors,
  customerDeleteCascade,
  clockPeriodRollover,
  clockTrialEnd,
  clockCancelAtPeriodEnd,
  clockDeclinedRenewal,
  subscriptionIntervalSwap,
];
