# Templates #1–#15: live validation

Date 2026-09-25. Target: the Stripe sandbox (claimable `rkcs_test_` key), API version `2026-08-26.dahlia`. Each template was run for seeds 1 and 2 with `runSequence` via `runCorpus` (concurrency 5, the shared 20 req/s limiter). This ran from a throwaway script, `buildCorpus(TEMPLATES, [1, 2])` followed by `runCorpus(seqs, sandboxTarget(key), …)`, and took 58 s for all 30 sequences.

**Every step returned the status its template intends.** Happy-path steps returned 2xx, and each error step returned the intended 4xx. Template #13 has two branches: seeds 1 and 2 take the default `payment_behavior` branch, and seed 3 was run as well to cover the `error_if_incomplete` branch.

Status cells list the steps in order. An error step shows `status error.code`, or `error.type` when Stripe sends no `code`. The events column lists every event type the runner collected (sorted, with counts). Step counts differ between seeds of the same template because `subscribed()` sets the default payment method in one of two places: on the customer (an extra `POST /v1/customers/:id` step) or on the subscription.

## Intended steps per template

`subscribed()`, the shared prefix for #5–#10, #13 and #15, runs these steps:
- `POST /v1/customers`
- `POST /v1/payment_methods/<token>/attach`
- optionally `POST /v1/customers/:id` with `invoice_settings[default_payment_method]`
- `POST /v1/prices` with `product_data[name]`
- `POST /v1/subscriptions`, which sets `default_payment_method` when the customer-level step was skipped

Every one of those steps expects 2xx.

| # | template | steps after the prefix (expected status) |
|---|---|---|
| 1 | customer-crud | create, retrieve, update, delete, retrieve tombstone (all 200), then update the deleted customer (**400** `resource_missing`) |
| 2 | customer-list-pagination | 3–5 creates with one shared email; `ceil(k/2)` pages of `GET /v1/customers?email=&limit=2&created[gte]=$c1.created` following `starting_after` (all 200) |
| 3 | product-price-crud | product, recurring price, retrieve, deactivate plus metadata, `GET /v1/prices?product=`, update product (all 200) |
| 4 | payment-method-attach | customer, attach, `GET /v1/payment_methods?customer=`, set default, attach a second card, detach the first, list (all 200) |
| 5 | subscription-create | prefix, retrieve with `expand[0]=latest_invoice`, `GET /v1/invoices?customer=` (all 200) |
| 6 | subscription-cancel-now | prefix, `DELETE` (200), retrieve (200), `DELETE` again (**404** `resource_missing`) |
| 7 H | subscription-cancel-at-period-end | prefix, `cancel_at_period_end=true`, retrieve, `=false` (all 200) |
| 8 | refund-full | prefix, `GET /v1/payment_intents?customer=`, full refund, retrieve charge, `GET /v1/refunds?payment_intent=` (all 200) |
| 9 H | refund-partial-then-rest | prefix, PI list, partial refund, refund the remainder (200), then 1 more cent (**400** `charge_already_refunded`) |
| 10 | refund-over-and-negative | prefix, PI list, refund above the charge (**400**, no code), negative amount (**400** `parameter_invalid_integer`), valid partial (200) |
| 11 | resource-missing | GET/POST/DELETE on a missing customer, subscription and invoice, plus GET/POST on a missing price (**404** `resource_missing` ×11) |
| 12 H | invalid-params | customer (200), then 5 × **400**: `parameter_unknown`, `parameter_missing` (currency), bad interval (no code), subscription without items (`parameter_missing`), negative `unit_amount` (no code) |
| 13 | card-declined | prefix with `pm_card_chargeCustomerFail`. The generator picks the branch: default `payment_behavior` gives 200 `status=incomplete`, and `error_if_incomplete` gives **402** `card_declined` (`type=card_error`). Then `GET /v1/invoices?customer=` (200) |
| 14 | idempotency-replay | create with key K (200), same K and same params (200, replayed), same K with a different `name` (**400** `idempotency_error`), new key (200, new object) |
| 15 | subscription-events | prefix, `DELETE` subscription (all 200); the probe's value is its event set |

## Results (seeds 1 and 2)

| sequence | step statuses | event types observed |
|---|---|---|
| customer-crud#1 | 200 · 200 · 200 · 200 · 200 · 400 resource_missing | customer.created, customer.deleted, customer.updated |
| customer-crud#2 | 200 · 200 · 200 · 200 · 200 · 400 resource_missing | customer.created, customer.deleted, customer.updated |
| customer-list-pagination#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 200 | customer.created ×5 |
| customer-list-pagination#2 | 200 · 200 · 200 · 200 · 200 · 200 | customer.created ×4 |
| product-price-crud#1 | 200 · 200 · 200 · 200 · 200 · 200 | plan.created, plan.updated, price.created, price.updated, product.created, product.updated |
| product-price-crud#2 | 200 · 200 · 200 · 200 · 200 · 200 | plan.created, plan.updated, price.created, price.updated, product.created, product.updated |
| payment-method-attach#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | customer.created, customer.updated ×2, payment_method.attached ×2, payment_method.detached |
| payment-method-attach#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | customer.created, customer.updated ×2, payment_method.attached ×2, payment_method.detached |
| subscription-create#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| subscription-create#2 | 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| subscription-cancel-now#1 | 200 · 200 · 200 · 200 · 200 · 200 · 404 resource_missing | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.deleted, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| subscription-cancel-now#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 404 resource_missing | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.deleted, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| subscription-cancel-at-period-end#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated ×2, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| subscription-cancel-at-period-end#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated ×2, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| refund-full#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.refund.updated, charge.refunded, charge.succeeded, customer.created, customer.subscription.created, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created, refund.created, refund.updated |
| refund-full#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.refund.updated, charge.refunded, charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created, refund.created, refund.updated |
| refund-partial-then-rest#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 400 charge_already_refunded | charge.refund.updated ×2, charge.refunded ×2, charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created, refund.created ×2, refund.updated ×2 |
| refund-partial-then-rest#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 400 charge_already_refunded | charge.refund.updated ×2, charge.refunded ×2, charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created, refund.created ×2, refund.updated ×2 |
| refund-over-and-negative#1 | 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error · 400 parameter_invalid_integer · 200 | charge.refund.updated, charge.refunded, charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created, refund.created, refund.updated |
| refund-over-and-negative#2 | 200 · 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error · 400 parameter_invalid_integer · 200 | charge.refund.updated, charge.refunded, charge.succeeded, customer.created, customer.subscription.created, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created, refund.created, refund.updated |
| resource-missing#1 | 404 resource_missing ×11 | none (no ids in bodies, not polled) |
| resource-missing#2 | 404 resource_missing ×11 | none (no ids in bodies, not polled) |
| invalid-params#1 | 200 · 400 parameter_unknown · 400 parameter_missing · 400 invalid_request_error · 400 parameter_missing · 400 invalid_request_error | customer.created |
| invalid-params#2 | 200 · 400 parameter_unknown · 400 parameter_missing · 400 invalid_request_error · 400 parameter_missing · 400 invalid_request_error | customer.created |
| card-declined#1 | 200 · 200 · 200 · 200 · 200 | charge.failed, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.payment_failed, payment_intent.created, payment_intent.payment_failed, payment_method.attached, plan.created, price.created, product.created |
| card-declined#2 | 200 · 200 · 200 · 200 · 200 · 200 | charge.failed, customer.created, customer.subscription.created, customer.updated ×2, invoice.created, invoice.finalized, invoice.payment_failed, payment_intent.created, payment_intent.payment_failed, payment_method.attached, plan.created, price.created, product.created |
| idempotency-replay#1 | 200 · 200 · 400 idempotency_error · 200 | customer.created ×2 |
| idempotency-replay#2 | 200 · 200 · 400 idempotency_error · 200 | customer.created ×2 |
| subscription-events#1 | 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.deleted, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| subscription-events#2 | 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.deleted, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |

The extra seed ran for #13 to cover the other branch:

| sequence | step statuses | event types observed |
|---|---|---|
| card-declined#3 | 200 · 200 · 200 · 200 · 402 card_declined · 200 | charge.failed, customer.created, customer.updated, payment_intent.canceled, payment_intent.created, payment_intent.payment_failed, payment_method.attached, plan.created, price.created, product.created |

This is the second run of #2 with the same seeds. By this point, 10 sandbox customers share seed 1's deterministic email. The pages were identical in shape (5 → 2/2/1 with `has_more` true/true/false; 4 → 2/2 with true/false):

| sequence | step statuses | event types observed |
|---|---|---|
| customer-list-pagination#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 200 | customer.created ×5 |
| customer-list-pagination#2 | 200 · 200 · 200 · 200 · 200 · 200 | customer.created ×4 |

## Stripe behavior later tasks must know

**Template design**
- **`pm_card_chargeDeclined` cannot be attached.** `POST /v1/payment_methods/pm_card_chargeDeclined/attach` returns 402 `card_declined` (`decline_code=generic_decline`), because attaching verifies the card. #13 uses `pm_card_chargeCustomerFail` instead: it attaches with 200 and then fails on charge.
- **Deterministic emails collide across runs.** A second recording of the same seed (Task 4's noise B) sees the first run's customers under `email=`. #2 therefore also filters on `created[gte]=$c1.created`. Customers created in the same second list in reverse insertion order. Any future template that lists by `email=` needs the same guard.
- **Subscription payment is synchronous.** With the default `payment_behavior` and a good card, the subscription comes back `active`, and `latest_invoice` (a string id) is already `paid`. The PaymentIntent is visible at once at `GET /v1/payment_intents?customer=` (exactly 1, `latest_charge` is a string id), so no `waitMs` is needed.
- **`billing_mode` defaults to flexible.** On dahlia every new subscription carries `billing_mode: {type: "flexible", flexible: {proration_discounts: "included"}, updated_at}`. The twin must emit this too.
- **`cancel_at_period_end=true` also sets `cancel_at`.** The value equals `items.data[0].current_period_end` (period fields live on items). Setting it back to `false` returns `cancel_at: null`.

**Error responses**
- **Deleted customers.** Retrieving one gives 200 and the tombstone `{id, object: "customer", deleted: true}`, the same body `DELETE` returns. Updating one gives **400** (not 404) `resource_missing`, `param: "id"`.
- **Cancelling a canceled subscription** gives **404** `resource_missing` ("No such subscription"), not a 400 state error.
- **Missing resources** give 404 `resource_missing`, but `param` varies by resource: customer and subscription use `id`; price uses `price` (GET and POST); invoice uses `invoice` for GET and DELETE but `id` for POST.
- **Sandbox-only message prefix.** Some 404 messages start with "This is an unclaimed Stripe sandbox. Dashboard links in this error message will not work until the sandbox is claimed. " It appeared on `POST /v1/prices/<missing>` for seed 1 in both runs and on `POST /v1/customers/<missing>` for seed 2, not on the other 404s. It is not deterministic per endpoint, so expect it as `message` noise in Task 4, and the twin should not copy it.
- **Refund errors.**
  - An amount above the charge gives 400 with **no `code`**, `param: "amount"`, and a message that formats the currency ("Refund amount ($304.13) is greater than charge amount ($304.10)", or "€…" for eur).
  - A negative amount gives 400 `parameter_invalid_integer`, "This value must be greater than or equal to 1.".
  - Refunding after a full refund gives 400 `charge_already_refunded` with no `param`.
  - Refunds come back `status: "succeeded"` synchronously.
- **Validation errors without a `code`.** A bad `recurring[interval]` gives 400 "Invalid recurring[interval]: must be one of month, year, week, or day", and a negative `unit_amount` gives 400 "Invalid non-negative integer". Neither has a `code`. Unknown parameters give `parameter_unknown` ("Received unknown parameter: X", `param: X`). Missing currency or items give `parameter_missing`.

**Card declines and idempotency**
- **`error_if_incomplete` with a failing card.** The response is 402 with `type=card_error`, `code=card_declined`, and `charge` plus a full `payment_method` object in `error`, but no `payment_intent` key. No invoice persists (`GET /v1/invoices?customer=` is empty). The events are `charge.failed`, `payment_intent.created`, `payment_intent.payment_failed` and `payment_intent.canceled`, with no `invoice.*` or `customer.subscription.*` events.
- **The default branch with a failing card** returns 200 `status: "incomplete"` and leaves an `open` invoice, with events `invoice.payment_failed`, `payment_intent.payment_failed` and `charge.failed`.
- **Idempotency.**
  - The first response carries **no** `idempotent-replayed` header. The replay carries `idempotent-replayed: true` and the same body (same id).
  - A key reused with different params gives 400 `type=idempotency_error` with no `code`. Its message embeds the full key, which contains the run nonce and is covered by normalize rule 3.

**Events and endpoints**
- **Events.**
  - Creating a price also emits the legacy `plan.created`, and updating one emits `plan.updated`.
  - Creating a subscription emits one `customer.updated` of its own, so there are 2 when the default payment method was set on the customer and 1 otherwise.
  - Sequences with no object ids in any body (#11) are never polled for events.
- **`GET /v1/payment_methods?customer=`** works without `type`.

## Not covered and deviations from the catalog

- #11 does not delete the price: the API has no `DELETE /v1/prices/:id`, and calling it returns an "unrecognized request URL" 404, not `resource_missing`.
- #13 uses `pm_card_chargeCustomerFail`, not `pm_card_chargeDeclined` (see above), and adds a final `GET /v1/invoices?customer=` so the recording shows what each branch leaves behind.
- #2 adds `created[gte]=$c1.created` to the brief's `email=` scoping (see above).
