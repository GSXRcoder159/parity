# W0 verifications (2026-09-25)

Answers to every plan §12 unknown and every UNVERIFIED item in `docs/research/2026-09-25-evidence.md`, plus the benchmark-target runs, the claimable-sandbox observations, and the H4 (Stripe-gym / agent-toolkit) findings.

**Method.** Stripe docs were read from their Markdown mirrors (`<page>.md`), which serve the page text unrendered. Each Stripe quote below was re-checked by `grep -F` against that raw text on 2026-09-25; the pages use curly apostrophes (’), which the quotes keep. GitHub files were read as raw bytes (`gh api`, `raw.githubusercontent.com`), and npm/PyPI tarballs were downloaded and read directly. The SSA and LocalStack MSA were downloaded as HTML and converted to text locally. No summarizer output is quoted as a source. The benchmark targets were run on this machine (macOS arm64, Docker Desktop 20.10.23).

**Confidence legend.** `verified-primary`: quote read in the primary page or file. `verified-live`: seen in our own run. `inference`: our reading of primary text, not a statement the source makes. `unverified`: no primary answer yet, and the section says what would settle it.

## Summary

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | Sandbox cap per account | 5 | verified-primary |
| 1 | Do anonymous CLI sandboxes count against it? | Not documented. Moot for clocks: their `rkcs_test_` keys cannot create test clocks | unverified / verified-live |
| 1 | Concurrent test-clock cap | None documented (3 pages checked) | verified-primary (absence) |
| 2 | Invoice preview endpoint on `2026-08-26.dahlia` | `POST /v1/invoices/create_preview` only; `upcoming` was removed at basil (2025-03-31) | verified-live + verified-primary |
| 3 | `stripe/openapi` license | MIT; fine to vendor into Apache-2.0 with the notice kept | verified-primary |
| 4 | Stripe SSA wording | §2.4 bars reverse engineering and "derivative works of … the Stripe Technology or any services provided by Stripe"; the definition of Stripe Technology includes the Stripe API. **Counsel question.** | verified-primary |
| 4 | LocalStack terms | MSA forbids benchmarking "for any competitive purposes" without written consent | verified-primary |
| 4 | Arga terms | No public ToS found on any Arga page | verified-primary (absence) |
| 5 | Seconds per clock advance; sequences/hour | Not measured. Clock timing is blocked on B1 (needs an `sk_test_` key). Docs say only "a few seconds" | unverified |
| 5+ | Read-API allocation | 10,000 GETs/month minimum; does not say whether sandboxes are exempt | verified-primary / scope unverified |
| 6 | Do clock-driven events appear in `GET /v1/events`? | Not documented. Docs warn that other list endpoints hide clock objects | unverified |
| E | Changelog RSS/JSON feed | None (5 URLs tried, all 404). Usable substitutes: `changelog.md` and `stripe/openapi` commits | verified-primary |
| E | Next major release | `2026-09-30.endive` is already in `stripe/openapi` (legacy folder) and stripe-mock master | verified-primary (spec) / inference (breaking) |
| E | project-vera/vera license | None: all rights reserved, cite only | verified-primary |
| E | WonderTwin price | "~$199 per twin per month", "Land ~$1K/mo 5 twins" | verified-primary (vendor page) |
| E | Jev price and latency | "$0.042 / MTok", "70ms-500ms" | verified-primary (vendor claim, not tested) |
| E | Prime Intellect Hub: any Stripe twin? | 1 Stripe environment exists, a coding eval against a mock API. No stateful twin | verified-primary |
| E | Claimable Sandboxes v2 | Read the guide page; the API reference page could not be fetched | partial |

---

## 1. Sandboxes: account cap, anonymous sandboxes, concurrent clocks

**Account cap: 5.** `verified-primary`
> "Your account can have up to five sandboxes."

https://docs.stripe.com/sandboxes/dashboard/manage

**Two different "claimable" mechanisms. The plan and evidence doc cite the wrong one.** `verified-primary`
- **CLI `stripe sandbox create` / `stripe sandbox claim`.** This is the one we used. It expires after 7 days and issues a `rkcs_test_` key.
  > "Sandbox environments expire after 7 days. Claim your sandbox before it expires by running `stripe sandbox claim` to keep your account and data."

  The docs' own example response shows `"secret_key": "rkcs_test_abc123"` (https://docs.stripe.com/cli/sandbox). Our sandbox `acct_1UJKSxBXgzwfQJL7` has an `rkcs_test_` key and expires 2026-10-02, 7 days after it was created. It matches this mechanism.
- **Claimable Sandboxes v2 API (`/v2/core/claimable_sandboxes`)**, built for platforms and Stripe Apps.
  > "A claimable sandbox expires after 60 days."

  (https://docs.stripe.com/sandboxes/claimable-sandboxes). It returns `sk_test_`/`pk_test_` keys plus an `ek_test_` MCP key. The raw reference page https://docs.stripe.com/api/v2/claimable-sandboxes returned 404 both as `.md` and as HTML, so it was **not read**. The guide page above was read instead.

**Do anonymous CLI sandboxes count against the 5-sandbox cap?** `unverified`. Neither /sandboxes, /sandboxes/dashboard/manage nor /cli/sandbox says. Only an empirical test settles it: with 5 Dashboard sandboxes in place, run `stripe sandbox create` and see what happens, then check again after claiming.

The question matters less than §12 assumed. The `rkcs_test_` key is refused on `/v1/test_helpers/test_clocks` (live, 2026-09-25; see §9). So anonymous sandboxes can never add clock throughput. Clock parallelism can only come from clocks inside a claimed account's sandboxes, which means at most 5 sandboxes.

What the key can and cannot do is not documented anywhere. No page lists the permissions of an `rkcs_test_` key; our probe results are the only evidence.

**Concurrent test-clock cap.** `verified-primary` (absence). The documented limits are per clock:
> "You can simulate up to: … Three customers … Three subscriptions, including scheduled subscriptions, per customer … Ten quotes that aren’t attached to customers"

(https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage). No per-account limit on concurrent or active clocks appears on that page, on /billing/testing/test-clocks, or on /rate-limits. "Not documented" is not the same as "no limit", so measure it in W0 once B1 is done.

Terms note (`inference`): SSA §1.2(a)(ii) forbids circumventing "any technical limitations of the Services" (quoted in §4). Creating many sandboxes to multiply the rate limit could be read that way. Stay within one account's documented limits.

## 2. Invoice preview endpoint for the pinned version

**Answer: `POST /v1/invoices/create_preview` only.** It needs `subscription`, `schedule` or `subscription_details.items`; `customer` alone is not enough. `verified-live` + `verified-primary`

- **Live, 2026-09-25, API version `2026-08-26.dahlia`** (sandbox `acct_1UJKSxBXgzwfQJL7`; recorded in `docs/plan/STATUS.md`). `GET /v1/invoices/upcoming` returns an error saying the method is deprecated and pointing to Create Preview Invoice. `POST /v1/invoices/create_preview` requires one of `subscription`, `schedule` or `subscription_details.items`. The exact error bodies were not saved, so they are described here, not quoted.
- **Removed at basil (2025-03-31), not at dahlia.** Major releases carry their changes forward, so it stays removed on dahlia.
  > "We’re removing the `GET /v1/invoices/upcoming` API in favor of the Create Preview Invoice API. Additionally, you can no longer preview the next invoice for a customer across all their subscriptions on the Create Preview Invoice API."

  > "You must pass specific subscription details (`subscription`, `subscription_details.items`, `schedule`, `schedule_details.phases`, or `invoice_items`) along with the `customer` parameter to the Create Preview Invoice API."

  https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations
- **The current reference page contradicts the changelog and the live behavior.**
  > "If neither `subscription` nor `subscription_details.items` is provided, you will retrieve the next upcoming invoice from among the customer’s subscriptions."

  https://docs.stripe.com/api/invoices/create_preview. The live sandbox follows the changelog. The twin must copy the live behavior, not this sentence. The same sentence explains why a mock built from the spec gets this wrong (next point).
- **How the two baselines handle it** (`verified-live`, this session):
  - stripe-mock accepts `create_preview` with `customer` only (200), where real Stripe rejects it.
  - localstripe still serves the removed `GET /v1/invoices/upcoming` route ("No upcoming invoices for customer" on a real customer). `POST /v1/invoices/create_preview` gets a generic 400 "Bad request".

  Both are H1 divergences on the ICP's "preview a plan change" step.

## 3. `stripe/openapi`: license, versions, pinned URL

**License: MIT.** `verified-primary`
> "The MIT License … Copyright (c) 2011- Stripe, Inc. (https://stripe.com)"

https://github.com/stripe/openapi/blob/master/LICENSE. The README adds no usage terms. It says the files are made by "a custom closed-source generator", but the generated files themselves are MIT.

Vendoring `spec3.json` into Apache-2.0 Parity is fine as long as the MIT notice goes with it, for example in `THIRD_PARTY_NOTICES` (`inference` from the MIT grant; not legal advice). This MIT grant, not the SSA, covers our use of the spec file. SSA §2.3 says open-source licenses take precedence for open-source code.

**The two spec folders are on different API versions at the same commit.** `verified-primary`. Commit `2bab97685e29abae0c241680c2257153e259e50f` (master HEAD, 2026-09-25T01:05:15Z):

| File | Bytes | `info.version` |
|---|---|---|
| `latest/openapi.spec3.json` | 4,518,735 | `2026-08-26.dahlia` |
| `openapi/spec3.json` (legacy, v1 only) | 8,316,935 | `2026-09-30.endive` |

**Pinned URL for the dahlia spec:** https://raw.githubusercontent.com/stripe/openapi/2bab97685e29abae0c241680c2257153e259e50f/latest/openapi.spec3.json

Repo tags are build numbers (newest seen: `v2524`) and none is named after an API version. A commit SHA is the only stable pin. The `master/latest/...` URL will move, probably to endive (§E2).

## 4. Terms: Stripe SSA (legal gate), LocalStack, WonderTwin, Arga

### 4.1 Stripe Services Agreement, read directly. `verified-primary`

Source: https://stripe.com/legal/ssa, "Last modified: November 18, 2025".

> **1.2 (a)** "User must not, and must not enable or allow any third party to: … (ii) circumvent any technical limitations of the Services or enable functionality that is disabled or prohibited, or access or attempt to access non-public Stripe systems or data; … (iv) perform or attempt to perform any action that interferes with the operation of the Services or affects other Stripe users’ use of Stripe services; … (vi) copy, reproduce, republish, upload, post, transmit, resell, or distribute in any way, any part of the Services, Documentation, or the Stripe Website except as Law permits;"

> **2.4 Modifications and Reverse Engineering.** "Except to the extent that the following restriction is not permitted under Law, User must not (and User must not enable others to) decompile, reverse engineer, disassemble, attempt to derive the source code of, decrypt, tamper, translate, modify, or create derivative works of all or any part of the Stripe Technology or any services provided by Stripe. User agrees not to remove, obscure, or alter any proprietary notices (including trademark and copyright notices) that may be affixed to or contained within the Stripe Technology."

> "“Stripe Technology” means all software (including software in the Stripe SDKs), application programming interfaces (including the Stripe API), user interfaces (including the Stripe Dashboard), and other technology that Stripe and its Affiliates use to provide and make the Services available."

> "“Stripe API” means all instances of the Stripe application programming interfaces, including all endpoints that enable Stripe users to use Stripe services."

> "“Documentation” means the sample code, instructions, requirements, and other documentation (a) available on the Stripe Website, the first page of which is located at www.docs.stripe.com; and (b) included in the Stripe SDKs."

Reading (`inference`, not legal advice):
- **§2.4 is the real question.** The research pass reported it; the actual wording is broader. It covers "any services provided by Stripe", and the definition of Stripe Technology explicitly includes the Stripe API. It also names "reverse engineer". The plan's clean-room method builds a behavioral twin from our own sandbox probes. Whether that is "reverse engineering" or a "derivative work" of the Stripe API or its services, we cannot decide from the text. Counsel must answer that before the public launch. Plan §10's trigger for "Legal objection" ("Any clause found in W0") has therefore fired.
- **Things that help, but are not a defense:**
  - Stripe publishes an MIT spec and its own mock (stripe-mock).
  - Other public twins exist: localstripe, stripe-stateful-mock, WonderTwin, Arga.
  - Stripe's own rate-limits page recommends "mocking out requests to the Stripe API".
- **§1.2(a)(vi) matters for two artifacts.**
  - Publishing raw sandbox recordings (full Stripe response bodies) publicly could be read as "republish … any part of the Services".
  - Verbatim Documentation quotes, such as the README's "we recommend mocking" quote.

  Low risk either way, but ask counsel about both.
- **§1.2(a)(iv) and (ii):** keep the harness well below the rate limits and do not use extra sandboxes to get around them. The plan already does the first.
- **Not read:** Stripe's per-product Service Terms. The SSA text itself contains no sandbox- or test-mode-specific clause (searched for "sandbox", "test mode", "testing", "mock", "simulat", "compet").

### 4.2 LocalStack (owner of WonderTwin since 2026-09-14). `verified-primary`

Source: LocalStack Master Services Agreement, https://www.localstack.cloud/legal/msa (`/legal/tos` redirects here), "Last updated: May 8th, 2025".

> "Customer will not (and will not authorize or permit any third party to): … (iv) access the LocalStack Assets in order to benchmark, or monitor the availability, security, performance, or functionality of the LocalStack Assets, for any competitive purposes without LocalStack’s express written consent;"

> "“LocalStack Assets” means the Software, Service and Documentation."

Reading (`inference`): scoring any LocalStack product in ParityBench needs written consent. WonderTwin's open-source repo is MIT, a separate grant that allows use:

> "MIT License … Copyright (c) 2026 WonderTwin AI"

https://github.com/WonderTwin-AI/wondertwin/blob/main/LICENSE. Scoring it is moot anyway. Its `twin-stripe` covers Connect (accounts, transfers, payouts), not Billing, so it claims none of our v0 surface.

### 4.3 Arga Labs. `verified-primary` (absence)

No public terms of service were found:
- `argalabs.com/{terms, terms-of-service, legal/terms, tos, privacy}`: all 404.
- The homepage, pricing and docs pages (docs.argalabs.com and its `llms.txt`) have no legal links.
- The login page at login.argalabs.com and its JS bundles contain no terms link.

A search-engine snippet says the login portal refers to a ToS. That was not confirmed in the page source. **Do not score Arga until we get written terms or permission.**

## 5. Throughput, clock-advance latency, read allocation

**Seconds per test-clock advance and sequences/hour at 20 req/s: not measured.** `unverified`
- Clock timing is blocked on B1: test clocks need an `sk_test_` key from the claimed account.
- The docs give no number: "After a successful API request or Dashboard operation, it takes a few seconds to advance to the specified time." (https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage)
- Advance limits (`verified-primary`, same page): "if you have a monthly subscription, you can only advance up to two months at a time. If you haven’t set any subscriptions or subscription schedules, you can advance up to two years from the initial frozen time."
- The non-clock sequences/hour figure can be measured now with the `rkcs_test_` key.

**Rate limits** (`verified-primary`, https://docs.stripe.com/rate-limits): sandbox global limit 25 req/s. Per endpoint, "unless otherwise noted", also 25 req/s. There is no test-helpers-specific limit.

**Read-API allocation: a new constraint not in the plan.** `verified-primary` (text) / `unverified` (applies to sandboxes?)

Source: https://docs.stripe.com/rate-limits
> "Your account’s read API requests must not exceed an average of 500 per transaction." … "Ratios are calculated over a rolling 30-day period (the most recent 30 days)." … "Every account, regardless of transaction count, has a minimum allocation of 10,000 read requests per month." … "Write API requests have no allocation limit."

The page does not say whether this applies to sandboxes, and a sandbox has no real transactions.

Our runner (`src/bench/run.ts` `collectEvents`) makes at least 2 `GET /v1/events` polls per sequence, and each poll can be up to 10 pages. A 500-sequence corpus therefore costs at least ~1,000 reads per run, plus the extra runs for the noise floor. If the allocation does apply, the 10,000/month floor is used up in a few nightly runs.

Increases go through Stripe Support: "If you request a large increase, contact Stripe Support at least 6 weeks in advance."

## 6. Test-clock-driven events in `GET /v1/events`

**Not documented either way.** `unverified`
- `test_helpers.test_clock.{created,advancing,ready,internal_failure,deleted}` are real event types.
- Events can be retrieved for 30 days.
- But the test-clock page warns about other list endpoints:
  > "API list methods (such as List Invoices) don’t return objects generated by test clocks unless you specify a query clause. The required query parameters vary by resource, so check the specific list method entry in the API reference."

  (https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage)

The same filtering may apply to `/v1/events`. Our current `collectEvents` filters by `created >= start-60s`. For a clock-driven event, `created` may follow the clock's frozen time instead of wall-clock time, which would put it outside that window. This is `inference` and needs a W0 test after B1: advance a clock past a period boundary, then compare `GET /v1/events` (unfiltered, `created`-filtered and `type`-filtered) against the events delivered to a webhook endpoint.

## 7. Other items the evidence doc marked UNVERIFIED

**E1. Changelog feed.** `verified-primary` (absence). No feed exists: `docs.stripe.com/changelog{.rss,/rss,.atom,/feed,.json}` all return 404. Two substitutes can be read by a machine:
1. https://docs.stripe.com/changelog.md, one Markdown page with `## <version>` headings and tables marked "Breaking/Non-breaking".
2. The commit history of `stripe/openapi`, whose `info.version` shows a new version before the changelog does (see E2).

**E2. The next major release, `2026-09-30.endive`, is already in the specs.** `verified-primary` (spec contents), `inference` (breaking)
- `2026-09-30.endive` is in `stripe/openapi` `openapi/spec3.json` and in stripe-mock master (commit `5c774f16`, 2026-09-25). It is not yet in the changelog: `changelog/endive.md` returns 404.
- Versioning page:
  > "Twice a year, we issue a new major release (for example, Basil) that starts with an API version containing breaking changes."

  (https://docs.stripe.com/api/versioning)
- First versions of each major in the changelog: acacia 2024-09-30, basil 2025-03-31, clover 2025-09-30, dahlia 2026-03-25. That pattern makes endive the next breaking major, arriving during W1.
- The harness already sends `Stripe-Version: 2026-08-26.dahlia` on every request (`src/bench/run.ts:14`), so the corpus is protected.

**E3. project-vera/vera license: none.** `verified-primary`. GitHub's license API returns `{"message":"Not Found",…,"status":"404"}` (https://api.github.com/repos/project-vera/vera/license). There is no LICENSE, LICENSE.md, LICENSE.txt or COPYING file, no `license` field in either emulator's `pyproject.toml` or in `CITATION.cff`, and no license section in the README. Default copyright applies: cite the method, copy no code.

**E4. Other licenses.** `verified-primary`
| Project | License | Source |
|---|---|---|
| exo | MIT | "Copyright (c) 2026 Ankur Goyal", https://github.com/exoharness/exo/blob/main/LICENSE |
| stripe-mock | MIT | Its `update-openapi-spec` Makefile target downloads `openapi/spec3.json` and `fixtures3.json` from the legacy folder |
| localstripe | GPL-3.0 | See §8.2 |
| `stripe/agent-toolkit` | MIT; **renamed to `stripe/ai`** | "Copyright (c) 2024–2025 Stripe", https://github.com/stripe/ai/blob/main/LICENSE; the old URL redirects |

**E5. WonderTwin price.** `verified-primary` (vendor page). https://wondertwin.ai/: "~$199 per twin per month · every version of a twin included", "Land ~$1K/mo 5 twins · entry", "Expand $80–100K/yr 40–55 twins". LocalStack's list prices (https://www.localstack.cloud/pricing): Base "$39 per license/ per month billed annually", Ultimate "$89 per license/ per month billed annually".

**E6. Jev.** `verified-primary` that the vendor says this; performance not tested by us. https://typesafe.ai/blog/introducing-system-one-models-and-jev: "Input tokens: $0.042 / MTok ($42 per billion tokens). Output tokens: FREE (too cheap to meter)." and "End-to-end response time is 70ms-500ms for TypeSafe."

**E7. Prime Intellect Hub.** `verified-primary`. Checked with the public search API, https://api.primeintellect.ai/api/v1/environmentshub/?search=stripe, which returned `total_count: 1`: `ankush82/api-coding-eval`, "Evaluate LLM coding ability: implement Stripe payment functions, scored by a functional test suite against a mock API". There is no stateful Stripe twin environment. For a later Slack twin: `hubert-marek/agent-diff-bench` ("Benchmark for evaluating agents on Slack, Linear, Box, Calendar via Bash & Python") already exists.

## 8. Benchmark targets: exact commands and what each supports

### 8.1 stripe-mock

**Command (pinned):**
```sh
docker run --rm -d --name parity-stripe-mock -p 12111-12112:12111-12112 \
  stripe/stripe-mock@sha256:ff32647993847be491e68533e2881c90434fa8d5df40246ee5f7d41253422081
# add `-strict-version-check` after the image to make it report its embedded API version
docker rm -f parity-stripe-mock
```
- Ports: HTTP on 12111, HTTPS/HTTP2 on 12112. The README's own command is `docker run --rm -it -p 12111-12112:12111-12112 stripe/stripe-mock:latest`.
- Any `Authorization: Bearer sk_test_…` is accepted.

**Version.** `verified-live` + `verified-primary`. The image digest above is `latest` = release v0.205.0 (response header `Stripe-Mock-Version: 0.205.0`). The v0.205.0 tag points to commit `eb806aca`, whose embedded spec is `2026-08-26.dahlia`. With `-strict-version-check` (stripe-mock's error message spells the flag `-stripe-version-check`), the container said so itself during the earlier baselines run on this machine:
> "Version sent in `Stripe-Version` header '2000-01-01' doesn't match version in OpenAPI specification '2026-08-26.dahlia'"

stripe-mock master (`5c774f16`, not yet released) already embeds `2026-09-30.endive`. The next stripe-mock release, and therefore `:latest`, will move to endive. The research passes seemed to disagree about this version (one said "endive" from master, the other "dahlia" from the image); these two commits explain the difference.

**Behavior** (`verified-live`; the create_preview, test-clock, unknown-param and never-created-GET rows were reproduced this session, and the rest come from the earlier baselines run on this machine):

| Request | Result |
|---|---|
| `POST /v1/customers` | 200; sent fields echoed, the rest is a fixed fixture |
| `GET /v1/customers/cus_never` (never created) | 200, full fixture: no state |
| `POST /v1/subscriptions` | 200, fixed fixture unrelated to the price sent |
| `POST /v1/customers -d bogus=1` | 400 "additional properties are not allowed" (spec validation) |
| `POST /v1/test_helpers/test_clocks`, `…/clock_x/advance` | 200 (fixtures; nothing advances) |
| `POST /v1/invoices/create_preview -d customer=cus_x` | 200 (real Stripe rejects this) |
| `POST /v1/invoices/create_preview` with no params | 400 |
| `GET /v1/invoices/upcoming?customer=cus_x` | 400 "additional properties are not allowed" |

This matches its README:
> "stripe-mock is stateless. Data you send on a `POST` request will be validated, but it will be completely ignored beyond that."

(https://github.com/stripe/stripe-mock). What it claims: every endpoint in the spec, request validation only.

### 8.2 localstripe

**Command (verified this session):**
```sh
uvx --from localstripe==1.15.10 localstripe      # listens on :8420; any key starting sk_ is accepted
```
- Also works: `pip install localstripe` into a venv, then `localstripe`.
- The documented Docker path is `docker run -p 8420:8420 adrienverge/localstripe:latest`. That image is amd64 only and 429 MB. Two pull attempts on this arm64 Mac did not finish within several minutes. On Apple Silicon, expect `--platform linux/amd64` and emulation. In CI on amd64 Linux it should be fine; that has not been tested.

**Support** (`verified-live`, v1.15.10; customers, prices, test clocks, `create_preview` and `upcoming` were reproduced this session, and products, plans, subscriptions and refunds come from the earlier baselines run on this machine):

| Resource | Result |
|---|---|
| Customers | 200 |
| Products | 200 |
| Plans (legacy) | 200 |
| **Prices** | **404** (plain text, not Stripe's JSON error envelope) |
| Subscriptions | 200, but only after a card token is attached as a source |
| Refunds | 200; partial refunds correct |
| **Test clocks** | **404** |
| `create_preview` | 400 "Bad request" |
| `GET /v1/invoices/upcoming` | Served (a route real Stripe removed at basil) |

More detail:
- Subscriptions: `tok_visa` is not recognized. A token must be minted via `POST /v1/tokens` with card fields and attached via `/v1/customers/{id}/sources`. A customer with no payment method is rejected ("This customer has no payment method"), whereas Stripe returns status `incomplete`.
- Customer objects carry pre-2019 fields (`account_balance`, `business_vat_id`), so L2 shape scores will partly measure API-version drift.
- The server's route table has no Price and no TestClock class, and grepping the source for `test_clock` finds nothing. The source does contain proration parameters (`subscription_proration_date`, `proration=True` line items). These are untested, so do not write "localstripe has no proration" as a flat claim.

**What it claims:**
- README: "only the **latest version of Stripe API** is supported (on best effort)". It has no list of endpoints.
- The only list it gives is webhook events: `product.created`, `plan.created`, `customer.created/updated/deleted`, `customer.source.created`, `customer.subscription.created/deleted`, `invoice.created`, `invoice.payment_succeeded`, `invoice.payment_failed`.
- https://github.com/adrienverge/localstripe (README.rst)

**License: GPL-3.0.** `verified-primary`. "This program is licensed under the GNU General Public License version 3." Running it unmodified as an external target is allowed:
> "This License explicitly affirms your unlimited permission to run the unmodified Program."

(https://github.com/adrienverge/localstripe/blob/master/LICENSE, §2). Copyleft attaches to conveying the code, not to running it and reading its HTTP responses (`inference`). Never copy or vendor its code.

## 9. Claimable-sandbox observations (live, 2026-09-25)

Account `acct_1UJKSxBXgzwfQJL7`, created with `stripe sandbox create --from-git`. Key prefix `rkcs_test_`. Reported API version `2026-08-26.dahlia`. `verified-live`

| Works | Refused |
|---|---|
| Customers (create/retrieve/list), customer search | `/v1/test_helpers/test_clocks` |
| PaymentMethods attach with `pm_card_visa` | `/v1/account` |
| Products, Prices | |
| Subscriptions | |
| Refunds | |
| Idempotency: same key + different params → error | |
| Webhook endpoints | |
| Events | |

- **Expiry:** 2026-10-02 unless claimed (7-day CLI mechanism, §1). After claiming, the docs say to run `stripe login` to get permanent keys.
- **Consequence:** everything except the clock stratum and `/v1/account` can be recorded now. Clock work, including the §5 timing and §6 events checks, waits for B1.

## 10. H4 fallback: Stripe-gym and agent-toolkit

**Stripe's eval environments.** `verified-primary`. Source: https://stripe.com/blog/can-ai-agents-build-real-stripe-integrations
- The post describes "11 diverse environments": backend-only tasks, full-stack tasks, and "gym" problem sets.
- The public set is at https://github.com/stripe/ai/tree/main/benchmarks, under MIT.
- Grading is deterministic tests, and "a mostly correct integration is a failure; payments require 100% accuracy."
- The repo README reports each task's score as the best of 3 runs.

**What `benchmarks/subscription-gym` contains.** It closely matches our v0 surface:
- `cancel_subcription_without_proration_task.rb` ("Cancel Date: … 9am UTC on the 20th of the current month. Proration: No proration will apply to the cancellation.")
- `upgrade_subscription_with_proration_task.rb` ("Implement proration for the upgrade and bill the customer immediately … keep the current billing date unchanged.")
- `downgrade_subscription_at_end_of_cycle_task.rb`
- `preview_invoice_task.rb`
- Trial, discount and usage tasks, with test-clock preconditions.
- (https://github.com/stripe/ai/blob/main/benchmarks/subscription-gym/environment/server/tasks/cancel_subcription_without_proration_task.rb)

There are **no refund tasks** anywhere in `benchmarks/` (recursive grep). Refund tasks must be written by us.

**Can agent-toolkit point at a custom base URL?**
- **Current releases: no.** `verified-primary`
  - npm `@stripe/agent-toolkit@0.9.0` and PyPI `stripe-agent-toolkit==0.7.0` are thin clients to Stripe's hosted MCP server.
  - Their configuration has only `secretKey` and `configuration.context.{account,customer,mode}`. There is no base-URL option.
  - The server URL is hard-coded: `export const MCP_SERVER_URL = 'https://mcp.stripe.com';` (https://github.com/stripe/ai/blob/main/tools/typescript/src/shared/constants.ts; the Python version has the same constant).
  - The client's own error text: "No fallback to direct SDK is available."
- **Python, older release: yes, with no patch.** `verified-primary`
  - Pin `stripe-agent-toolkit==0.6.1` (sdist https://files.pythonhosted.org/packages/d9/a3/41db99ad3c617d3c36f2d4a59d7007f9db54192429185d923ebdc81154cc/stripe_agent_toolkit-0.6.1.tar.gz). It sets `stripe.api_key = secret_key` and never touches `stripe.api_base`.
  - stripe-python exposes `api_base: str = DEFAULT_API_BASE` as a module-level variable (https://raw.githubusercontent.com/stripe/stripe-python/master/stripe/__init__.py) and reads it on each request.
  - So run `import stripe; stripe.api_base = "http://localhost:<port>"` before building the toolkit.
- **TypeScript, older release: yes, with a one-line patch.** `verified-primary`
  - Pin `@stripe/agent-toolkit@0.7.12` (https://registry.npmjs.org/@stripe/agent-toolkit/-/agent-toolkit-0.7.12.tgz).
  - It builds `new Stripe(secretKey, { appInfo: {...} })` and does not pass network options through.
  - Patch that call to add stripe-node's own options: `host` (default `'api.stripe.com'`), `port` (default `443`), `protocol` (`'https'` or `'http'`, default `'https'`). Source: https://github.com/stripe/stripe-node/blob/master/README.md. The README "strongly discourage[s] `http`, even in local testing"; this only matters for real Stripe keys.
- **0.7.12 tools** relevant to Billing: `createCustomer`, `listCustomers`, `createProduct`, `createPrice`, `listPrices`, `createInvoice`, `createInvoiceItem`, `finalizeInvoice`, `listInvoices`, `listSubscriptions`, `updateSubscription`, `cancelSubscription`, `createRefund`, `listPaymentIntents`. There is **no `createSubscription`**, so tasks must start from a seeded subscription.
- **Unresolved:** what tools the live `mcp.stripe.com` actually lists.
  - https://docs.stripe.com/mcp lists generic tools (`stripe_api_read`, `stripe_api_write`, `stripe_api_search`, `stripe_api_details`, …) that reach "Cancel a subscription", "Create refund", "Create a preview invoice" and "Create a test clock".
  - The toolkit's MIGRATION.md and unit tests show one tool per resource (`create_customer`, …).
  - Only a live `listTools()` settles it. This does not affect the fallback, which uses the pinned older releases.

---

## Plan changes implied

- **Legal gate fired: counsel review becomes a hard gate before the Oct 15 public launch.** Plan §10 said "any clause found in W0".
  - The clause: SSA §2.4 forbids reverse engineering and "derivative works of … the Stripe API or any services provided by Stripe".
  - Record this in `docs/decisions/0001-clean-room.md` with the exact questions for counsel: is a behavioral twin built from our own probes allowed; may we publish raw sandbox recordings (§1.2(a)(vi)); may the README quote the docs verbatim.
  - Until counsel answers, keep recordings private (for example, publish only normalized diffs and scores) and keep the repo private.
- **Correct §2.1 and §12: the invoice preview is `POST /v1/invoices/create_preview` only.**
  - `customer` alone is rejected; it needs `subscription`, `schedule` or `subscription_details.items`. The twin follows this live behavior, not the reference page.
  - Add probes for "customer only" and for "`GET upcoming`". Both are H1 divergences on the ICP's preview step (stripe-mock returns 200; localstripe serves `upcoming`).
- **Pin the spec by SHA:** `stripe/openapi@2bab9768…/latest/openapi.spec3.json` (dahlia), never the legacy `openapi/spec3.json` (already endive). Keep the MIT notice with the vendored copy.
- **Plan for the endive major release around 2026-09-30, during W1.**
  - Keep the pinned `Stripe-Version` header. It is already in place.
  - Pin the stripe-mock baseline by image digest (`sha256:ff3264…`, dahlia), because `:latest` will move to endive.
  - The baseline report states each target's API version.
  - H5 may see a real drift or new-version event in W1 rather than as "a bonus".
- **The clock stratum depends entirely on B1 (claim the sandbox, get an `sk_test_` key).**
  - `rkcs_test_` keys cannot create test clocks, so anonymous sandboxes never add clock throughput.
  - Clock parallelism is capped at clocks within ≤5 sandboxes of one claimed account.
  - No concurrent-clock cap is documented; measure one.
  - Using extra sandboxes to get around rate limits risks SSA §1.2(a)(ii).
  - Fix the plan/evidence doc links: `docs.stripe.com/cli/sandbox`, not `/api/v2/claimable-sandboxes`.
- **Add the read-API allocation to §4 and §10.**
  - 10,000 GETs/month minimum over a rolling 30 days. It is not stated whether sandboxes are exempt.
  - W0: count GETs per corpus run and watch for the error when it is exceeded.
  - Harness: replace per-sequence `/v1/events` polling (at least 2 polls, up to 10 pages each) with one sweep per batch, filtered locally.
  - If sandboxes are in scope, ask Stripe Support now; they ask for 6 weeks' notice.
- **Add clock events to the W0 checks after B1.** Stripe hides clock-generated objects from list endpoints unless filtered by customer. Test whether `/v1/events` does the same, and whether `created` follows the frozen clock time, before relying on the `created >= start-60s` event window for the clock stratum.
- **Baselines (W1):**
  - Run stripe-mock with the pinned digest above.
  - Run localstripe with `uvx --from localstripe==1.15.10 localstripe` (not Docker on arm64).
  - Score localstripe only on what it implements: customers, products, plans, subscriptions with sources, refunds. It has no Prices, test clocks or `create_preview`.
  - Note in the report that its object shapes date from before 2019.
  - Do not state "no proration" as fact until it is tested.
- **Competitor scoring:**
  - No LocalStack products without written consent (MSA §(iv)).
  - WonderTwin OSS (MIT) claims only Connect, so there is nothing to score.
  - Arga has no public ToS, so do not score it without written permission.
  - This settles plan §8's condition: in practice the W1 baseline is stripe-mock plus localstripe only.
- **H4 fallback (§6.4) needs a realistic estimate of about 2 days, not ≤1, and a de-risk step in W1.**
  - Use the pinned Python `stripe-agent-toolkit==0.6.1` + `stripe.api_base` (no patch), or TypeScript `0.7.12` with a one-line `new Stripe(key, {host, port, protocol})` patch.
  - Current releases are MCP-only and hard-coded to `mcp.stripe.com`.
  - Adapt the cancel, proration, downgrade and preview tasks from `stripe/ai` `subscription-gym`, credited under MIT. Refund tasks must be written by us.
  - Seed subscriptions, because the 0.7.12 toolkit has no `createSubscription`.
  - Update the reference from `stripe/agent-toolkit` to `stripe/ai`.
- **Drift instrument (§3.4):** Stripe has no changelog feed. Watch `docs.stripe.com/changelog.md` and `stripe/openapi` commits (`info.version`) alongside the nightly sandbox diff.
- **STATUS.md items these answers satisfy:** `stripe/openapi` license, the terms line (Arga, LocalStack, WonderTwin read), and the sandbox cap line. Anonymous-sandbox counting and the concurrent-clock cap stay open, blocked on B1.
