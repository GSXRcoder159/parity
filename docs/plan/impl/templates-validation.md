# Templates #1–#26: live validation

#1–#15 were validated on 2026-09-25 (this part); #16–#26 on 2026-09-26 (see [Templates #16–#26](#templates-1626-2026-09-26) below).

Date 2026-09-25. Target: the Stripe sandbox (unclaimed, as the error-message prefix below confirms; the key type is `rkcs_test_` according to the Task 4 brief and was not inspected here), API version `2026-08-26.dahlia`. Each template was run for seeds 1 and 2 with `runSequence` via `runCorpus` (concurrency 5, the shared 20 req/s limiter). This ran from a throwaway script, `buildCorpus(TEMPLATES, [1, 2])` followed by `runCorpus(seqs, sandboxTarget(key), …)`, and took 58 s for all 30 sequences.

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

## Templates #16–#26 (2026-09-26)

Target: the same unclaimed sandbox (claimable key), API version `2026-08-26.dahlia`. Recorded with the CLI, so every run was budget-gated and ledgered in `budget/reads.jsonl`:

- `paritybench record --target sandbox --templates invoice-preview-proration,subscription-update-price,subscription-update-quantity,invoice-send-invoice,boundaries-amounts,boundaries-list-limits,expand-paths,customer-search,webhook-endpoint-crud,idempotency-errors,customer-delete-cascade --seeds 1-2`: run `20260926T012758-uxv2`, 22 sequences at concurrency 8, 148 requests (35 GETs), 0 429s, 75 s wall.
- `paritybench record --target sandbox --templates subscription-update-price,invoice-send-invoice,expand-paths --seeds 3-4`: run `20260926T012914-57wc`, 6 sequences, 49 requests (16 GETs), 0 429s. This covers the generator branches that seeds 1–2 do not take.

Both recordings are in the private data repo under `runs/2026-09-26/`. Before them, two iteration passes and two exploratory probe runs (a throwaway template, since removed) found the behavior below. Those runs wrote to a scratch directory outside both repos and are counted in the ledger. The final runs came about 20 minutes after the last iteration run so they would not hit the claimable key's quota.

**Every step returned the status its template intends.** Both #23 searches found their customer after the 60 s wait. The cell format matches the #1–#15 tables above. Error steps show `status error.code`, or `error.type` when there is no `code`. "(replayed)" marks a response that carried `idempotent-replayed: true`.

### Intended steps per template (#16–#26)

#16–#18, #22 and #26 start with `subscribed()` (the prefix described above).

| # | template | steps after the prefix (expected status) |
|---|---|---|
| 16 | invoice-preview-proration | Price B (pr1's product, currency and interval; 200). Then `POST /v1/invoices/create_preview` with `subscription`, `subscription_details[items]` (the item swapped to B) and `subscription_details[proration_behavior]=create_prorations` (200). Then `create_preview` with `customer` only (**400**, no code). Then `GET /v1/invoices/upcoming?customer=` (**404**, no code) |
| 17 | subscription-update-price | Price B (200). Update the item to B with `proration_behavior` ∈ {`create_prorations`, `none`, `always_invoice`} (200). `GET /v1/invoices?customer=` (200) |
| 18 H | subscription-update-quantity | Set the item's quantity to 2–9 with `create_prorations` (200). `create_preview` with `subscription` (200) |
| 19 | invoice-send-invoice | Customer, price, and a subscription with `collection_method=send_invoice` and `days_until_due` (all 200). Finalize the first invoice (200 `open`). Pay it `paid_out_of_band=true` or void it, as the generator picks (200). Retrieve it (200). Then try the other action (**400**, no code) |
| 20 | boundaries-amounts | One-time prices with `unit_amount` 0 (200), 99,999,999,999,999 (200) and 100,000,000,000,000 (**400** `parameter_invalid_integer`). `unit_amount_decimal` sent as a string with two decimals (200) and with 13 decimal places (**400**, no code). Both `unit_amount` and `unit_amount_decimal` (**400**, no code). PaymentIntents for 1–49 (**400** `amount_too_small`) and for 50 (200) |
| 21 H | boundaries-list-limits | Two customers sharing one email (200). `GET /v1/customers?email=&created[gte]=` with `limit=0`, `limit=101` and `limit=100` (all 200), then with `starting_after=<missing id>` (**400** `resource_missing`) |
| 22 | expand-paths | Subscription with `expand[]` = `customer`, `latest_invoice`, `items.data.price.product` (200). `GET /v1/payment_intents?customer=` with `expand[]` = `data.latest_charge`, `data.payment_method` (200). A 5-level expand (**400** `property_expansion_max_depth`). One of `status`, `plan_details`, `latest_invoice.plan_details` (**400**, no code) |
| 23 | customer-search | Customer (200). After `waitMs` 60 s, `GET /v1/customers/search?query=email:'…' AND created>=<c1.created>` (200, 1 result expected, but eventually consistent) |
| 24 | webhook-endpoint-crud | Create (200 `enabled`), retrieve (200), update `enabled_events` with `disabled=true` (200 `disabled`), delete (200), retrieve the deleted endpoint (**404** `resource_missing`) |
| 25 | idempotency-errors | Customer (200). Attach `pm_card_chargeDeclined` under key K1 (**402** `card_declined`), then again under K1 (**402**, replayed). A customer with an unknown parameter under key K2 (**400** `parameter_unknown`). The valid customer under K2 (200, not replayed). A product under K2 (**400** `idempotency_error`) |
| 26 | customer-delete-cascade | Delete the customer (200). Retrieve the subscription (200 `status=canceled`) |

### Results (seeds 1 and 2)

| sequence | step statuses | event types observed |
|---|---|---|
| invoice-preview-proration#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error · 404 invalid_request_error | charge.succeeded, customer.created, customer.subscription.created, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created ×2, price.created ×2, product.created |
| invoice-preview-proration#2 | 200 · 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error · 404 invalid_request_error | charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created ×2, price.created ×2, product.created |
| subscription-update-price#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, invoiceitem.created ×2, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created ×2, price.created ×2, product.created |
| subscription-update-price#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, invoiceitem.created ×2, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created ×2, price.created ×2, product.created |
| subscription-update-quantity#1 | 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, invoiceitem.created ×2, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| subscription-update-quantity#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, invoiceitem.created ×2, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| invoice-send-invoice#1 | 200 · 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error | customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.updated ×2, invoice.voided, payment_intent.canceled, payment_intent.created, plan.created, price.created, product.created |
| invoice-send-invoice#2 | 200 · 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error | customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.updated ×2, invoice.voided, payment_intent.canceled, payment_intent.created, plan.created, price.created, product.created |
| boundaries-amounts#1 | 200 · 200 · 400 parameter_invalid_integer · 200 · 400 invalid_request_error · 400 invalid_request_error · 400 amount_too_small · 200 | payment_intent.created, price.created ×3, product.created ×3 |
| boundaries-amounts#2 | 200 · 200 · 400 parameter_invalid_integer · 200 · 400 invalid_request_error · 400 invalid_request_error · 400 amount_too_small · 200 | payment_intent.created, price.created ×3, product.created ×3 |
| boundaries-list-limits#1 | 200 · 200 · 200 · 200 · 200 · 400 resource_missing | customer.created ×2 |
| boundaries-list-limits#2 | 200 · 200 · 200 · 200 · 200 · 400 resource_missing | customer.created ×2 |
| expand-paths#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 400 property_expansion_max_depth · 400 invalid_request_error | charge.succeeded, customer.created, customer.subscription.created, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| expand-paths#2 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 400 property_expansion_max_depth · 400 invalid_request_error | charge.succeeded, customer.created, customer.subscription.created, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| customer-search#1 | 200 · 200 | customer.created |
| customer-search#2 | 200 · 200 | customer.created |
| webhook-endpoint-crud#1 | 200 · 200 · 200 · 200 · 404 resource_missing | none |
| webhook-endpoint-crud#2 | 200 · 200 · 200 · 200 · 404 resource_missing | none |
| idempotency-errors#1 | 200 · 402 card_declined · 402 card_declined (replayed) · 400 parameter_unknown · 200 · 400 idempotency_error | customer.created ×2 |
| idempotency-errors#2 | 200 · 402 card_declined · 402 card_declined (replayed) · 400 parameter_unknown · 200 · 400 idempotency_error | customer.created ×2 |
| customer-delete-cascade#1 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.deleted, customer.subscription.created, customer.subscription.deleted, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| customer-delete-cascade#2 | 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.deleted, customer.subscription.created, customer.subscription.deleted, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |

These are the extra seeds for branches that seeds 1–2 miss:
- #17: seeds 1–2 use `create_prorations`, seed 3 `always_invoice`, seed 4 `none`.
- #19: seeds 1, 2 and 4 void first, and seed 3 pays first.
- #22: seeds 1 and 3 use `latest_invoice.plan_details`, seed 2 `status`, seed 4 `plan_details`.

| sequence | step statuses | event types observed |
|---|---|---|
| subscription-update-price#3 | 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated, customer.updated ×2, invoice.created ×2, invoice.finalized ×2, invoice.paid ×2, invoice.payment_succeeded ×2, invoiceitem.created ×2, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created ×2, price.created ×2, product.created |
| subscription-update-price#4 | 200 · 200 · 200 · 200 · 200 · 200 · 200 · 200 | charge.succeeded, customer.created, customer.subscription.created, customer.subscription.updated, customer.updated ×2, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created ×2, price.created ×2, product.created |
| invoice-send-invoice#3 | 200 · 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error | customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, invoice.updated ×2, payment_intent.canceled, payment_intent.created, plan.created, price.created, product.created |
| invoice-send-invoice#4 | 200 · 200 · 200 · 200 · 200 · 200 · 400 invalid_request_error | customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.updated ×2, invoice.voided, payment_intent.canceled, payment_intent.created, plan.created, price.created, product.created |
| expand-paths#3 | 200 · 200 · 200 · 200 · 200 · 200 · 400 property_expansion_max_depth · 400 invalid_request_error | charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |
| expand-paths#4 | 200 · 200 · 200 · 200 · 200 · 200 · 400 property_expansion_max_depth · 400 invalid_request_error | charge.succeeded, customer.created, customer.subscription.created, customer.updated, invoice.created, invoice.finalized, invoice.paid, invoice.payment_succeeded, payment_intent.created, payment_intent.succeeded, payment_method.attached, plan.created, price.created, product.created |

### Stripe behavior later tasks must know (#16–#26)

**Proration and previews**
- `create_preview` with `subscription` and `subscription_details` returns an `invoice` object with `status: draft` and an id prefixed `upcoming_in_` (the `ids` rule normalizes it).
  - The swap preview has 3 lines: a proration credit for the unused time on price A, a proration charge for the rest of the period on B, and the next full period on B.
  - The quantity preview in #18 has the same 3-line shape.
- `create_preview` with only `customer` gives 400 with no `code` and no `param`: "You must provide at least one of: `subscription`, `schedule`, `subscription_details.items`, `schedule_details.phases`, `invoice_items`."
- `GET /v1/invoices/upcoming` gives **404**, not 400. It has `type=invalid_request_error` and no `code`, and the message says the method is deprecated and links to Create Preview Invoice.
- `proration_behavior` on an item swap or quantity change:
  - `create_prorations` emits 2 `invoiceitem.created` events for pending items. It creates no invoice, so the invoice list still has only the first one.
  - `always_invoice` creates and pays a second invoice immediately (`billing_reason=subscription_update`), with a second set of `invoice.*` events. On a downgrade (#17 seed 3), that invoice's total is negative and it is still `paid`.
  - `none` creates no invoice items.

**send_invoice**
- The first invoice of a `send_invoice` subscription stays a **draft** (`auto_advance: true`, `due_date` set). The subscription is `active` immediately.
- On that draft invoice:
  - Void gives 400: "You can only pass in open invoices. This invoice isn't open."
  - `pay` with `paid_out_of_band=true` gives 200 `paid`. It finalizes the invoice implicitly, and `invoice.finalized` is emitted.
  - #19 therefore finalizes explicitly first.
- An explicit finalize creates a PaymentIntent (`payment_intent.created`). Voiding or paying out of band then cancels it (`payment_intent.canceled`), and each emits `invoice.updated`. Paying the draft out of band without an explicit finalize (pass 1) emitted no `payment_intent.*` events.
- The state errors have no `code`:
  - Paying a voided invoice: "Voided invoices cannot be paid."
  - Voiding a paid invoice: "Invoices with `paid` payments cannot be voided."

**Amount boundaries**
- **The maximum price `unit_amount` is 99,999,999,999,999.** No Stripe page we found documents it; it was found live. One more gives 400 `parameter_invalid_integer`, `param: unit_amount`, "This value must be less than or equal to 99,999,999,999,999 (it currently is '100000000000000')". Values past int64 give "Invalid integer: <n>" with the same code (probe).
- How prices return their amounts:
  - A price created with an integer `unit_amount` returns `unit_amount_decimal` holding the same digits as a string.
  - A price created with `unit_amount_decimal` returns `unit_amount: null` and the decimal string as sent.
- Decimal-parameter errors (both 400, no code):
  - 13 decimal places: `param: unit_amount_decimal`. The message shows the value in exponent form ("Invalid decimal: 0.1e-12; must contain at most 12 decimal places."). Decimals are therefore always sent as strings, because a JS number would itself serialize as `1e-13`.
  - Both `unit_amount` and `unit_amount_decimal`: `param: unit_amount`, "You may only specify one of these parameters: unit_amount, unit_amount_decimal."
- One-time prices (no `recurring`) emit `price.created` and `product.created`, but no `plan.created`.
- PaymentIntent amounts:
  - Below the minimum: 400 `amount_too_small` with no `param`, "Amount must be at least $0.50 USD" (seeds 1–2 are usd).
  - Exactly 50: 200 `requires_payment_method`.
  - Creation does not enforce the 8-digit charge maximum: 100,000,000 and 99,999,999,999 were both accepted (probe).

**Lists and expansion**
- **`limit` is clamped, not validated.**
  - `limit=0` returns 200 with 1 item and `has_more: true`. So did `limit=-1` (probe).
  - `limit=101` returns 200. Seeing where the upper clamp sits would need more than 100 matching objects.
  - `GET /v1/invoices?customer=` also answered 200 to `limit=0` and `limit=101` (probe).
  - The harness catalog expected errors for these.
- `starting_after` with an unknown id gives **400** (not 404) `resource_missing`, with `param: starting_after`.
- Expansion errors:
  - More than 4 levels gives 400 `property_expansion_max_depth`, and the message names the property.
  - A property that cannot be expanded, or does not exist, gives 400 with no code: "This property cannot be expanded (<path>)." The message carries the full path, also for nested paths such as `latest_invoice.plan_details`.
  - List expansions take the `data.` prefix.
- **Expanding a field that was removed at basil is silently ignored.** `expand[]=latest_invoice.payment_intent` returns 200: `latest_invoice` is expanded and has no `payment_intent` key (pass 1, seed 2). A twin must not return 400 for it. #22's error pick leaves it out.

**Search**
- `created>=<epoch>` works inside a customer search query. The result is `object: search_result` with `data`, `has_more`, `next_page` and `url`; there is no `total_count`.
- **Observed lag:**
  - In a probe of 2 sequences with 3 same-email customers each, searches from 0.3 s to 14.8 s after creation returned nothing.
  - The customers appeared between 24.8 s and 25.2 s after creation, all at once.
  - With a 30 s wait (pass 2), 1 of 2 sequences still found nothing.
  - Stripe documents "less than a minute", so #23 waits 60 s, and both final searches found their customer.
  - Expect noise on this template regardless.

**Webhook endpoints**
- The claimable key can manage webhook endpoints (unlike test clocks).
- Create returns `secret` (`whsec_…`, which the `ids` rule normalizes); retrieve does not. `api_version` is null when none is given. `disabled=true` gives `status: disabled`.
- Delete returns `{id, object, deleted: true}`. Retrieving the endpoint afterwards gives **404** `resource_missing` with `param: webhook_endpoint`. Customers behave differently and return a tombstone.
- Webhook endpoint CRUD emits no events.
- #24 subscribes only to event types that no template produces (disputes, early-fraud warnings). This means nothing is delivered to example.com, and concurrent sequences' events keep `pending_webhooks: 0`.
- An aborted run can leave an endpoint behind. Stripe's docs cap an account at 16 endpoints; this was not checked live.

**Idempotency on failures**
- A 402 raised inside an endpoint (attaching `pm_card_chargeDeclined`) is saved. A retry under the same key returns the same 402 with `idempotent-replayed: true`, and the first response has no such header.
- A parameter-validation failure (400 `parameter_unknown`) is **not** saved. The same key then succeeds (200, not replayed) with different, valid params.
- A key reused on another endpoint gives 400 `type=idempotency_error` with no code: "Keys for idempotent requests can only be used for the same endpoint they were first used for ('/v1/products' vs '/v1/customers')…". The message includes the key, and normalize rule 3 covers the run nonce in it.

**Deletion cascade**
- Deleting a customer with an active subscription cancels the subscription immediately. The subscription then reads 200 `status: canceled` with `cancellation_details.reason: cancellation_requested`, and both `canceled_at` and `ended_at` are set. The events include `customer.subscription.deleted` and `customer.deleted`.

**Sandbox banner**
- The unclaimed-sandbox prefix showed up on more error kinds, each time in only some sequences:
  - #20: the 400 for sending both amount parameters and the `unit_amount` maximum-plus-one 400.
  - #22: an invalid-expand 400.
  - #24: the deleted-endpoint 404.
  - #25: the `idempotency_error`.
- It never appeared for the same step in both seeds of one run, so it is still noise per response, not per endpoint. The `sandbox-banner` rule strips it.

### Deviations from the catalog (#16–#26)

- #16 also probes `create_preview` with `customer` only and `GET upcoming`, as W0 research asked.
- #19 uses the first invoice of a `send_invoice` subscription and finalizes it explicitly, because it would otherwise stay a draft. It also adds the opposite action as a state error.
- #20:
  - "max+1" is the price maximum found live (99,999,999,999,999) plus one. It is not the 8-digit charge maximum, which PaymentIntent creation does not enforce.
  - The sub-minimum amount is a PaymentIntent below 50.
- #21: the catalog expected `limit=0` and `limit=101` to fail, but Stripe clamps them (200). The template creates two customers so that the clamp shows.
- #22: the invalid-expand pick leaves out `latest_invoice.payment_intent`, which is silently ignored (see above).
- #23 waits 60 s and is still expected to be noisy.
- #24 never lists endpoints, because the list is account-global.
- #25: the error that replays comes from inside the endpoint (the 402). The validation-failure step shows that validation errors are not saved.
