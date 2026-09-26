> **DRAFT — not for publication before the launch gate (docs/plan/STATUS.md)**

# Letter of intent (template)

**SKU:** plan §6.3, private alignment plus `paritybench agree` in the customer's CI · **Price:** $99–$299/month · **Delivery:** from W6, which starts 2026-11-03 (plan §5: W5 ends Nov 2) · **Tracker:** `funnel.md`, LOI column

**Have counsel review this template before it is used.** It is an engineer's draft, not legal advice.

Sender notes:
- Fill every `{{…}}`. Scope names the customer's own APIs and call shapes. Nothing on the plan §2.3 cut list is sold.
- An LOI counts toward the H3 target only at ≥$200/month (`funnel.md`).
- Keep signed copies out of this repository: it goes public at the launch gate. Log only the date, company and price in `funnel.md`.
- Send only the letter below the rule.

---

**Letter of intent: private alignment and `paritybench agree` in CI**

Date: {{date}}

From: {{company legal name}} ("Customer"), {{company address}}
To: {{TBD: provider legal entity, when incorporated}} ("Parity"), attn. Adam Kuca

1. **Purpose.** Customer intends to buy the service in section 2 once it is available, on the terms below. This letter records that intent. It is not a contract.

2. **Service.**
   - *Private alignment.* Parity aligns its twin to Customer's own call shapes (section 3). Every sandbox run for this uses a Stripe sandbox in Customer's account and Customer's key, never Parity's account. Changes derived from Customer's calls stay private to Customer and are not added to the public twin.
   - *`paritybench agree` in Customer's CI.* Customer's suite runs on the aligned twin and on Customer's sandbox. The report gives per-test pass/fail on each and their agreement.

3. **Scope.**
   - APIs: {{the Stripe APIs Customer calls, e.g. Customers, Subscriptions, Invoices, Refunds}}
   - Call shapes: {{the endpoints and parameters Customer's code or agent sends, e.g. POST /v1/subscriptions with proration_behavior}}
   - Suite: {{test suite or eval scenarios, runner, approximate number of tests}}
   - Out of scope unless listed above: {{surfaces Customer uses outside the twin's current surface, e.g. Connect, Tax, Checkout}}

4. **Price.** {{price, between $99 and $299}} per month, billed {{monthly or annually}}, from the start of delivery.

5. **Delivery.** No earlier than 2026-11-03. Target start: {{date}}.

6. **Confidentiality.** Parity will not publish Customer's name, tests, call shapes, recordings or results without Customer's written consent.

7. **Non-binding.** This letter creates no obligation to sign an agreement, pay, or deliver. Either party may withdraw at any time by written notice, without liability. Only a signed services agreement would create obligations.

8. **Non-affiliation.** Parity is not affiliated with, endorsed by, or sponsored by Stripe, Inc.

| | Customer | Parity |
|---|---|---|
| Name | {{signer name}} | Adam Kuca |
| Title | {{signer title}} | {{title}} |
| Company | {{company legal name}} | {{TBD: provider legal entity, when incorporated}} |
| Signature | | |
| Date | | |
