# Templates #1–#31: live validation

#1–#15 were validated on 2026-09-25 (this part); #16–#26 on 2026-09-26 (see [Templates #16–#26](#templates-1626-2026-09-26) below). #27–#30 (test clocks) on 2026-09-27 (see [Templates #27–#30](#templates-2730-test-clocks-2026-09-27) below). #31 (interval swap without an anchor) on 2026-09-29 (see [Template #31](#template-31-interval-swap-without-an-anchor-2026-09-29) at the end).

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

Target: the same sandbox, still unclaimed (the error-message banner shows it; the key itself was not inspected), API version `2026-08-26.dahlia`. Recorded with the CLI, so every run was budget-gated and ledgered in `budget/reads.jsonl`:

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
  - https://docs.stripe.com/search (fetched 2026-09-26, "Data freshness") says: "Under normal operating conditions, data is searchable in under 1 minute." #23 therefore waits 60 s, and both final searches found their customer.
  - Expect noise on this template regardless.

**Webhook endpoints**
- The claimable key can manage webhook endpoints (unlike test clocks).
- Create returns `secret` (`whsec_…`, which the `ids` rule normalizes); retrieve does not. `api_version` is null when none is given. `disabled=true` gives `status: disabled`.
- Delete returns `{id, object, deleted: true}`. Retrieving the endpoint afterwards gives **404** `resource_missing` with `param: webhook_endpoint`. Customers behave differently and return a tombstone.
- Webhook endpoint CRUD emits no events.
- #24 subscribes only to event types that no template produces (disputes, early-fraud warnings), so nothing is delivered to example.com. It does not change `pending_webhooks`.
- **Observed `pending_webhooks`:** every recorded event carries `pending_webhooks: 1`, both before #24 existed and after. The W0 D run (`w0-d-c8-20260926T000140-m0x6`) has 627 events, all with 1. The final runs `20260926T012758-uxv2` and `20260926T012914-57wc` have 219 + 97 = 316 events, all with 1. No event showed 0. The account already has something that counts as a pending webhook; what that is was not identified. A twin should emit 1 here, not 0. Scores do not depend on it, because `compare.ts` compares only event types.
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

## Templates #27–#30 (test clocks, 2026-09-27)

Written 2026-09-26 (W4 Task 4, surface-added) from the public docs ([test clocks: API and advanced usage](https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage), [advance a test clock](https://docs.stripe.com/api/test_clocks/advance), [Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries)) and dry-run against the twin. **Validated on the sandbox on 2026-09-27** (the claimed sandbox, an `sk_test_` key after B1; API version `2026-08-26.dahlia`): seeds 1 and 2 of all four through `paritybench record --target sandbox --templates clock-period-rollover,clock-trial-end,clock-cancel-at-period-end,clock-declined-renewal --seeds 1-2 --concurrency 8`, run `20260927T234224-sgjk` (data repo `runs/2026-09-27/`): 8 sequences, 103 requests (37 GETs, 5 of them event-sweep), 0 429s, 658 s wall (these counts include held-out #28's 2 sequences; see the exposure section at the end), most of it #30's 600 s wait. The clock facts behind the waits, and how they were measured: `reports/2026-09-27-clocks.md`.

The prefix `onClock()` has five steps. It creates a recurring price `pr1` (month or year). Then it creates a test clock `ck` with `frozen_time=$pr1.created` (the clock starts now). Then a customer `c1` with `test_clock=$ck.id`, an attached card `pm1` (visa or mastercard), and a subscription `s1` whose `default_payment_method` is `pm1`. `advance(x)` is `POST /v1/test_helpers/test_clocks/$ck.id/advance` with `frozen_time=x`. The runner has neither arithmetic nor loops, so `x` is always a ref, and the advance is followed by **one clock retrieve after 40 s** (600 s after #30's second advance). Sandbox advances reached `ready` within 24 s, 10 clocks at once included, but an advance that charges a declining card took 208–393 s. The wait has to cover the whole advance: an advancing clock refuses its modifications, its delete included. Each clock has one customer (the docs' cap is 3) and each subscription gets at most 2 invoices (the plan's cap is 5). Every template deletes its clock last.

How the waits were set. The templates as written (three retrieves after 2, 3 and 5 s) were never run on the sandbox: the W0 measurement came first and showed advances of 13–22 s, so they would have raced the clock. A first run with a single 30 s wait (`20260927T232646-y3tt`; its recording was kept out of the data repo's `runs/`, its reads are in the ledger) passed #27–#29. In #30 the retrieve after the second advance still saw `advancing`, and the clock's delete ended 429 after 3 retries (`invalid_request_error`, "Test clock advancement underway - cannot perform modifications", `Stripe-Rate-Limited-Reason: resource-specific`). Those two clocks reached `ready` minutes later and were deleted then. The waits became 40 s, and 600 s for #30's second advance.

| # | template | steps after the prefix (intended status) | validation (sandbox, seeds 1 and 2) |
|---|---|---|---|
| 27 | clock-period-rollover | `advance($s1.items.data.0.current_period_end)`, `GET /v1/invoices?customer=` (`l1`: the renewal draft is newest), `advance($l1.data.0.automatically_finalizes_at)`, list the invoices again, retrieve `s1`, delete the clock (all 200) | every step 200, both clock retrieves `ready`. End: subscription `active`; invoices `subscription_cycle` `paid` and `subscription_create` `paid` |
| 28 H | clock-trial-end | prefix with `trial_period_days` 4–14; `advance($s1.trial_end)`, retrieve `s1`, list the invoices, delete the clock (all 200) | every step 200, seeds 1 and 2 (held out: statuses only) |
| 29 | clock-cancel-at-period-end | `cancel_at_period_end=true` (`s2`), `advance($s2.cancel_at)`, retrieve `s1`, list the invoices, delete the clock (all 200) | every step 200, the clock retrieve `ready`; `$s2.cancel_at` resolved. End: subscription `canceled`; one invoice (`subscription_create`, `paid`) |
| 30 | clock-declined-renewal | attach `pm_card_chargeCustomerFail` (`pm2`), set it as `s1`'s `default_payment_method`, `advance($s1.items.data.0.current_period_end)`, list the invoices (`l1`), `advance($l1.data.0.automatically_finalizes_at)` (600 s wait), retrieve `s1`, list the invoices, delete the clock (all 200) | every step 200, both clock retrieves `ready`. End: subscription `past_due`; the renewal invoice `open`, `attempt_count=1`, `next_payment_attempt` set |

### Sandbox results (2026-09-27)

`(ready)` marks a clock retrieve that saw `status=ready`. Seeds 1 and 2 had the same statuses and the same event types.

| sequence | step statuses (sandbox) | events collected (types, with counts) |
|---|---|---|
| clock-period-rollover#1, #2 | 200 ×6 · 200(ready) · 200 ×2 · 200(ready) · 200 ×3 | 32: `charge.succeeded` ×2, `customer.created`, `customer.deleted`, `customer.subscription.created`, `customer.subscription.deleted`, `customer.subscription.updated`, `customer.updated`, `invoice.created` ×2, `invoice.finalized` ×2, `invoice.paid` ×2, `invoice.payment_succeeded` ×2, `invoice.upcoming`, `invoice.updated`, `payment_intent.created` ×2, `payment_intent.succeeded` ×2, `payment_method.attached`, `plan.created`, `price.created`, `product.created`, `test_helpers.test_clock.advancing` ×2, `test_helpers.test_clock.created`, `test_helpers.test_clock.deleted`, `test_helpers.test_clock.ready` ×2 |
| clock-trial-end#1, #2 (held out: statuses only) | 200 ×10 | not read |
| clock-cancel-at-period-end#1, #2 | 200 ×7 · 200(ready) · 200 ×3 | 21: `charge.succeeded`, `customer.created`, `customer.deleted`, `customer.subscription.created`, `customer.subscription.deleted`, `customer.subscription.updated`, `customer.updated`, `invoice.created`, `invoice.finalized`, `invoice.paid`, `invoice.payment_succeeded`, `payment_intent.created`, `payment_intent.succeeded`, `payment_method.attached`, `plan.created`, `price.created`, `product.created`, `test_helpers.test_clock.advancing`, `test_helpers.test_clock.created`, `test_helpers.test_clock.deleted`, `test_helpers.test_clock.ready` |
| clock-declined-renewal#1, #2 | 200 ×8 · 200(ready) · 200 ×2 · 200(ready) · 200 ×3 | 40: `charge.failed`, `charge.succeeded`, `customer.created`, `customer.deleted`, `customer.subscription.created`, `customer.subscription.deleted`, `customer.subscription.updated` ×3, `customer.updated` ×2, `invoice.created` ×2, `invoice.finalized` ×2, `invoice.marked_uncollectible`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_succeeded`, `invoice.upcoming`, `invoice.updated` ×3, `payment_intent.created` ×2, `payment_intent.payment_failed`, `payment_intent.succeeded`, `payment_method.attached` ×2, `plan.created`, `price.created`, `product.created`, `setup_intent.created`, `setup_intent.succeeded`, `test_helpers.test_clock.advancing` ×2, `test_helpers.test_clock.created`, `test_helpers.test_clock.deleted`, `test_helpers.test_clock.ready` ×2 |

### Twin dry-run (2026-09-26; the twin, not the sandbox)

Seeds 1 and 2 ran through `runCorpus` against a listening twin, with the templates' real waits, at concurrency 8: 8 sequences, 127 requests (61 GETs), 20.9 s. `(ready)` marks a clock retrieve that saw `status=ready`. The twin's fixed advancing delay is 1 s, so the 2 s wait always sees `ready`. Every step returned 200. These rows are the twin's own behavior and are not evidence about the sandbox. They show the 2026-09-26 templates, with three retrieves per advance (one since 2026-09-27).

| sequence | step statuses (twin) |
|---|---|
| clock-period-rollover#1, #2 | 200 ×6 · 200(ready) ×3 · 200 · 200 · 200(ready) ×3 · 200 ×3 |
| clock-trial-end#1, #2 | 200 ×6 · 200(ready) ×3 · 200 ×3 |
| clock-cancel-at-period-end#1, #2 | 200 ×7 · 200(ready) ×3 · 200 ×3 |
| clock-declined-renewal#1, #2 | 200 ×8 · 200(ready) ×3 · 200 · 200 · 200(ready) ×3 · 200 ×3 |

### Facts observed on the sandbox (2026-09-27)

These are the questions the B1 run had to answer, with what the sandbox did. The method and every number are in `reports/2026-09-27-clocks.md`. "Twin:" marks a difference from the twin. Those differences are for the align loop or the assisted pass and are not fixed here.

1. **Advance seconds.** The advance answers 200 with `status=advancing`, the old `frozen_time`, and `status_details.advancing.target_frozen_time` = the target. Once ready: `status_details` = `{}` and `frozen_time` = the target. From the advance to a retrieve that saw `ready`: median 14.7 s (1 month) and 14.6 s (1 year), max 20.3 s, at a poll resolution of 1.1–1.4 s. With 10 clocks at once: median 17.3 s, max 22.1 s. By the clock's own `advancing`/`ready` event timestamps, the ordinary advances of #27, #29 and #30 took 7–24 s in run `sgjk` (6–23 s in the unpublished first run `y3tt`; #28 not read), and those that charge a declining card 208–393 s (6 clocks). Twin: `ready` at once.
2. **Events in the sweep window: yes.** The events of an advance are stamped with the wall clock (fact 3), so `created[gte]=<corpus start − 60 s>` covers them wherever the clock is frozen. They were listed 0–6 s after their `created`. The renewal's events were listed 8–11 s after the advance request, before `ready` (14–19 s). The delete's events were listed within 5 s of the delete. Every validation recording (#28's not read) holds the events of its clock's transitions and of its delete, and the corpus sweep ended in 10.3 s of its 30 s cap. **The sweep needed no change.**
3. **`created`.**
   - Events: the wall clock, not the frozen time. The renewal's `invoice.created` is stamped seconds after the advance request, while the clock jumps a month or a year.
   - Objects an advance creates: the frozen time of their transition. The renewal draft's `created` equals the old period end exactly.
   - The clock's own `created`: the request's time.
   - Objects created before the first advance: the frozen time and the wall clock coincide here (the clock starts now), so this run cannot tell them apart.
   - Twin: stamps each advance event with its transition's frozen time.
4. `deletes_after` = `created` + 30 days (2,592,000 s), as in the twin.
5. **Renewal draft.** `automatically_finalizes_at` = `created` + 3 days (259,200 s), and `next_payment_attempt` = `created` + 1 h. Advancing to `automatically_finalizes_at` finalizes and charges it. Advancing to exactly `next_payment_attempt` left it a draft with `attempt_count=0` (2 clocks). Twin: `automatically_finalizes_at` = `created` + 1 h.
6. **Event sets.**
   - Renewal: `invoice.upcoming`, `invoice.created`, `customer.subscription.updated`.
   - #27's second advance adds `invoice.finalized`, `payment_intent.created`, `charge.succeeded`, `payment_intent.succeeded`, `invoice.paid` and `invoice.payment_succeeded`, and one `invoice.updated` for the renewal invoice, stamped in the same second as its `invoice.paid` (`sgjk`, both seeds). Its `previous_attributes` name `status`, `status_transitions`, `amount_paid`, `amount_remaining`, `attempt_count`, `attempted`, `auto_advance`, `automatically_finalizes_at`, `next_payment_attempt`, `number`, `hosted_invoice_url`, `invoice_pdf`, `effective_at` and `ending_balance`. #27's clock delete adds no invoice event: both invoices are `paid` by then.
   - Period-end cancel (#29): `customer.subscription.deleted`, and no renewal invoice.
   - Clock delete: `customer.subscription.deleted` (when the subscription is live), `customer.deleted` and `test_helpers.test_clock.deleted`. Each draft or open invoice also gets `invoice.marked_uncollectible` and `invoice.updated`.
   - The full set for each template is in the table above.
   - Twin: sends no `invoice.upcoming`, and no `invoice.marked_uncollectible` at clock delete.
7. **Declined renewal: as expected.** The subscription goes `past_due`, and the invoice stays `open` with `attempt_count=1`. `next_payment_attempt` is 1.77–1.90 days after the advance's target: 153,284 s and 164,199 s on the 2 clocks of the measurement run `20260927T233548-gbsj-w0clocks-declined` (a phase of the throwaway measurement script: its reads are in the ledger, its output is not published), and 152,842 s and 157,794 s (1.77 and 1.83 days) on #30's 2 clocks in `sgjk`. The retry rule is not established. Over the 20 oracle seeds of #30 the retry lands 42.2–45.8 h after the declined attempt (`reports/2026-09-27-baseline-v1.md`), and normalization v1.4's `retry-day` rule compares it to the day. The advance took 208–393 s. Twin: a fixed 2-day retry, and `ready` at once.
8. Trials: not checked (#28 is held out; only its statuses were read).
9. Error shapes: not checked, except one. A delete of an advancing clock answers **429** `invalid_request_error` with `Stripe-Rate-Limited-Reason: resource-specific` ("Test clock advancement underway - cannot perform modifications"). The runner retries it 3 times (after 1, 2 and 4 s). A second advance during an advance was not tried. Twin: refuses nothing while a clock advances.
10. Customer and subscription lists: not checked.

### Deviations and gaps (#27–#30)

- **Advance limit.** The docs (and the spec's parameter text) say two intervals of the **shortest** subscription interval, or two years without subscriptions. The twin follows the docs; the task brief said "longest".
- `score-twin` strips `waitMs`, and the twin answers `ready` at once (since the final review). On the sandbox, every clock retrieve of #27, #29 and #30 after the 2026-09-27 waits saw `ready` (#28: statuses only), so these retrieves compare. #30's 600 s wait makes it the slowest sequence in the corpus.
- Not built (each is a `ponytail:` or refusal in the twin): `incomplete` → `incomplete_expired` after 23 h; `trial_will_end` for trials of 3 days or less; `trial_end` at create; attaching an existing customer to a new clock (the `customer` param answers `not_implemented`); the 3-subscriptions-per-customer cap; item changes during a trial; `invoice.upcoming` (the sandbox sends it at renewal, fact 6).

### Held-out exposure during W4 Task 4 (ruled 2026-09-26)

While writing this section, the Task 4 implementer ran a `grep` over this file's table lines. It printed the rows of held-out templates #7, #9 and #12 (intended steps and results, cut at 160 characters) into the implementer's context. This breaks the W4 plan's held-out rule ("never read their rows in `templates-validation.md` while implementing"). The rows of #18 and #21 and all held-out recordings were not opened.

- What suggests the rows were not used (circumstantial only): Task 4 changes no code path of those templates. The held-out score is the same before and after Task 4 (L1 94.7 / L2 30.1 / L3 8.8 / L4 0.0; sealed-log entry `20260926T133009-sx3t`, data repo 580be4b), and the same again after fix round 1.
- **Orchestrator ruling (2026-09-26, decision 0002 §4.5):** #7, #9 and #12 stay held out, and the exposure is disclosed.
  - Reason: rotating the held-out set now would reset the held-out baseline. The exposure reached an implementer, not patch synthesis (the align loop never saw these rows). The held-out score did not move across the task.
  - Cost: held-out generalization on #7 (cancel at period end) may read slightly optimistic once clock-driven period ends are scored.
  - Records: the sealed log has a `note` entry for this, and the day-0 report's limitations list carries it.

### Held-out exposure during B1-unblock Task 1 (2026-09-27; ruled 2026-09-28)

The rule: #28's recordings and rows are not opened, except its step statuses in Task 1's own validation.

- **Task 1 (implementer):** a line-count `grep` over this file printed about the first 160 characters of #28's row in the per-template table. That text was its intended steps (the same as #28 in `templates/clocks.ts`, which Task 1 edits) and its result cell of the time, "unvalidated until B1".
- **Not read:** no #28 response body, event type or event timestamp from either validation run (`y3tt`, `sgjk`). The timing and event scripts skipped held-out sequences; the validation printer showed #28's step statuses only.
- **Numbers that looked like #28 data, and where they came from:**
  - The advance range "6–24 s" pooled the ordinary non-held-out advances of both runs; the 6 s came from `y3tt`, which is not published. Now stated per run (7–24 s in `sgjk`).
  - "12 advances" was the count of advances in the 8 sequences (#27 2, #28 1, #29 1, #30 2, per seed), taken from the templates, not from data.
  - "every clock retrieve `ready`" in all 8 sequences was an over-claim, not a read: #28's retrieve bodies were never checked. Now restricted to #27, #29 and #30.
- **Fix round 1 (2026-09-27):**
  - A listing of both recordings' sequences printed #28's step count (10) and event count (25 per seed, both runs).
  - A `grep` for line numbers printed the first ~20 characters of #28's three rows in this file (row number and template name).
  - Nothing else of #28 was printed.
- **Post-v1 hardening Task 3 (2026-09-28, this docs refresh):** to locate the clock rows, a prefix listing printed the first 14 characters of #28's three rows in this file (row number and the start of the template name). Every later read of this file skipped those lines, diffs were printed with `-U0`, and the scripts over `sgjk` filtered `heldOut`. Nothing else of #28 was printed.
- **Orchestrator ruling (2026-09-28, the same as the 2026-09-26 precedent above, decision 0002 §4.5):** #28 stays held out, and the exposure is disclosed.
  - Reason: the rows printed were step intent and counts only (its intended steps, which `templates/clocks.ts` holds anyway, its step count and its event count); no results or bodies were printed. The exposure reached an implementer, not patch synthesis: the align loop never shows held-out templates to patch synthesis.
  - What suggests nothing was tuned from it (circumstantial only): B1-unblock Task 1 changed no twin code. The twin's clock code predates the exposure (d32db08, 2026-09-26), and the only twin change since is align's `errors.json` batch `ae1343c` (6 message and code edits, none from a clock locus; `reports/2026-09-27-twin-v1.md`). Unlike the precedent, there is no before/after held-out score: #28 had no sandbox recording in the oracle before oracle v1, so its first score (held-out clocks L3 50.0%, L4 0.0% on oracle v1) comes after the exposure.
  - Cost: an implementer saw #28's step count (10) and event count (25 per seed). Held-out generalization on #28 may read slightly optimistic if an implementer's later twin change drew on them.
  - Records: this section and the day-0 report's limitations list. The sealed-log `note` is appended by the orchestrator, not by this task.

## Template #31: interval swap without an anchor (2026-09-29)

Written 2026-09-29 (H4 v2 plan Task 2) for H4's `switch-to-annual`: a price swap across billing intervals without `billing_cycle_anchor`, which the twin refuses (`not_implemented`, W4 plan Task 3(b)). A train template in the proration stratum, last in the catalog so the nightly's slices keep every existing sequence's corpus index. The option it adds to `subscribed()` (`interval`) skips the prefix's interval pick, so the other 30 templates build the same corpus as before (seeds 1–20, checked by hash).

| # | template | steps after the prefix (intended status) |
|---|---|---|
| 31 | subscription-interval-swap | The prefix with a **monthly** price A. Price B on A's product and currency, **yearly**, 500–50,000 (200). Update the item to B with `proration_behavior` ∈ {`create_prorations`, `always_invoice`, `none`} and no `billing_cycle_anchor` (200). Retrieve `s1` (200). `GET /v1/invoices?customer=` (200) |

Target: the claimed sandbox (`sk_test_` key after B1), API version `2026-08-26.dahlia` on every response. Both runs went through the CLI (budget-gated, ledgered in `budget/reads.jsonl`) and are in the data repo under `runs/2026-09-29/`:

- Validation, `paritybench record --target sandbox --templates subscription-interval-swap --seeds 1-3,8`: run `20260929T015151-kab1`, 4 sequences, 38 requests (12 GETs, 4 of them event-sweep; 26 POSTs), 0 429s, 19.7 s wall. Seeds 1–3 take `create_prorations`, `none` and `create_prorations`; seed 8 is the first `always_invoice`, so it was added.
- Oracle, the same with `--seeds 1-20`: run `20260929T015254-trjf`, 20 sequences, 177 requests (49 GETs, 9 of them event-sweep; 128 POSTs), 0 429s, 36.2 s wall. `create_prorations` on seeds 1, 3, 6, 7, 10, 12, 14 and 15; `none` on 2, 4, 5, 11, 13 and 17; `always_invoice` on 8, 9, 16, 18, 19 and 20. Seeds 1, 3, 5, 6, 14, 15, 19 and 20 set the default payment method on the customer (9 steps), the others on the subscription (8 steps).
- `oracle build` then: 620 sequences, the 600 of oracle v1 unchanged plus #31 × 20 from `trjf`. Rolling 30-day sandbox GETs after both runs: 4,769 of 10,000.

**Every step returned 200** in all 24 sequences. The facts below hold for every sequence of both runs (the 4 `kab1` sequences match their `trjf` seeds). A and B are the two prices' `unit_amount`.

1. **Accepted, in flexible mode.** The swap to a yearly price with no `billing_cycle_anchor` answers 200 whatever `proration_behavior`. The subscription stays `active`, with `billing_mode.type: flexible` (the default on dahlia; the template does not set it) and `pending_update: null`.
2. **Item periods.** `current_period_start` stays the subscription's start (its `created`), and `current_period_end` becomes that start plus one year (it was the start plus one month). The period is lengthened in place, not restarted at the change. The update response and the retrieve agree.
3. **`billing_cycle_anchor` does not move**: it stays the subscription's start in the update response and in the retrieve, in all three branches. `start_date` does not move either.
4. **Invoices and `billing_reason`.**
   - `create_prorations`: no new invoice. The list holds only the first invoice (`subscription_create`, `paid`). The prorations are 2 pending invoice items (`invoice: null`), visible only in the `invoiceitem.created` events.
   - `always_invoice`: a second invoice at once, `billing_reason: subscription_update`, `status: paid`, `charge_automatically`, holding the 2 proration lines. It becomes `latest_invoice`, and its period runs from the subscription's start to the change. Its total is B − A.
     - Upgrades (seeds 8, 16, 19, 20): charged at once, with a second PaymentIntent and charge.
     - Downgrades (seeds 9, 18): a negative total, `amount_due` 0 and `amount_paid` 0, `ending_balance` equal to the total, and still `paid`. The customer's `balance` is credited by the total (a second `customer.updated`, with `balance` in `previous_attributes`). No payment.
   - `none`: no invoice items and no invoice.
5. **Proration lines** (`create_prorations` and `always_invoice`, 14 sequences): 2 invoice items, both `proration: true`.
   - A credit of −A on price A, for the period from the change to the old period end (start + 1 month).
   - A debit of +B on price B, for the period from the change to the new period end (start + 1 year).
   - The change came 2–4 s after the subscription started, so both amounts round to the full A and B: the unused and remaining fractions differ from 1 by less than 10⁻⁵. **These recordings cannot show how a swap later in the period is prorated**, for example whether the debit is B times the remaining share of the year. A swap after a test-clock advance would.
   - Line descriptions: the credit's names the unused time on the product after the change date, and the debit's the remaining time (paraphrased, decision 0001 C3).
6. **Events.** One `customer.subscription.updated`, with `previous_attributes` keys `items` and `plan` (and `latest_invoice` with `always_invoice`). No `invoice.upcoming` and no `invoice.updated`. The prefix and price B emit 16 events (17 with the prefix's customer update). The swap adds:
   - `create_prorations`: `customer.subscription.updated` and `invoiceitem.created` ×2 (19 or 20 events in all).
   - `none`: `customer.subscription.updated` only (17 or 18).
   - `always_invoice`: `customer.subscription.updated`, `invoiceitem.created` ×2, `invoice.created`, `invoice.finalized`, `invoice.paid` and `invoice.payment_succeeded`. Upgrades add `payment_intent.created`, `payment_intent.succeeded` and `charge.succeeded` (26 or 27). The two downgrades add a `customer.updated` for the balance instead (24; both are 8-step seeds).
7. **Twin: refused, and left refused** (not changed by hand; brief). The twin answers the update 400 `invalid_request_error` with `parity: not_implemented` in all 20 oracle sequences, and the later steps see the monthly subscription. `score-twin` on #31 alone, on the 2026-09-29 oracle (normalization v1.4, method m2): L1 88.1% (148 of 168 steps; the 20 misses are the update step), L2 and L3 40.5%, L4 0 of 20. This is now a scored train divergence for the assisted pass. The twin's `change()` doc comment says a price on another billing period is accepted only with `billing_cycle_anchor=now`; the sandbox accepts it without one (facts 1–3).

### Held-out exposure during H4 v2 Task 2 (2026-09-29)

The rule: this plan's Global Constraint says "never open their recordings" for #7, #9, #12, #18, #21 and #28. The precedents above say more: the W4 rule is "never read their rows in `templates-validation.md` while implementing", and the #28 rule is that its recordings and rows are not opened. Which rule binds here is for the orchestrator's ruling.

- **Task 2 (implementer):** while orienting, the implementer read this file's lines 1–40 and 129–395. That printed these held-out rows:
  - #7, #9 and #12: their intended steps (the #1–#15 table).
  - #18 and #21: their intended steps, and their result rows for seeds 1–2 (step statuses and event-type lists).
  - #28: its intended steps with "every step 200", its results row ("200 ×10 | not read") and its twin dry-run row.
  - The two exposure sections above, which cite #28's step count (10) and event count (25 per seed).
- **Not read:** no held-out recording was opened. Every script over `oracle.jsonl` or the runs filtered on a train template name (`subscription-update-price`, `subscription-interval-swap`). `score-twin` ran with `--templates subscription-interval-swap` only.
- **Fix round 1 (2026-09-29):** a `grep -n '^#'` for this file's section headers also matched line 142, a prose line saying #16–#18, #22 and #26 start with `subscribed()`. So it showed that #18 starts with the prefix, which the rows above had already printed. The only range read was lines 366 to the end: the two exposure sections above and the #31 section. No other held-out text was printed.
- What suggests nothing was tuned from it (circumstantial only): `src/` has no diff between the task's BASE `23d32b9` and `afd834c` (`git diff --stat 23d32b9..afd834c -- src/` is empty), so no twin code changed. The 30 existing templates build the same corpus, seeds 1–20 (sha256 checked, `416ec3d48c1f251f…`), so the held-out sequences are unchanged.
- Records: this section and the Task 2 report. The ruling and the sealed-log `note` are the orchestrator's (decision 0002 §4.5 precedent), not this task's.
