# /// script
# requires-python = ">=3.11"
# dependencies = ["stripe-agent-toolkit==0.6.1", "stripe==11.6.0", "pydantic>=2,<3"]
# ///
"""H4 tool bridge: the pinned Python agent toolkit (0.6.1) as a JSON-lines tool server for evals/h4/run.ts.

Env: STRIPE_API_BASE (the target: the twin, or the metered proxy to the sandbox) and STRIPE_API_KEY.
stdout line 1: {"tools": [{name, description, input_schema}]}; then one reply per stdin request:
{"name": ..., "input": {...}} -> {"ok": bool, "content": str}. A failing call is a result (ok false), never a crash.

0.6.1 has no subscription tools, so list_subscriptions, cancel_subscription and update_subscription are ported here
from @stripe/agent-toolkit 0.7.12 (MIT, Copyright (c) 2024 Stripe): same names, descriptions and parameters.

0.6.1 declares no dependencies. stripe==11.6.0 is the stripe-python release current when 0.6.1 shipped (2025-03-24);
the toolkit json.dumps API objects, which works only while StripeObject is a dict (11.x yes, 15.x no).
"""

import json
import os
import sys

import stripe

# Before the toolkit is built: 0.6.1 sets stripe.api_key and never touches api_base (docs/research W0 §10).
stripe.api_base = os.environ["STRIPE_API_BASE"]
stripe.api_version = "2026-08-26.dahlia"  # the harness's pin (src/bench/run.ts), not stripe-python's default

from stripe_agent_toolkit.api import StripeAPI  # noqa: E402
from stripe_agent_toolkit.configuration import is_tool_allowed  # noqa: E402
from stripe_agent_toolkit.tools import tools as TOOLKIT  # noqa: E402

# The billing tools a support agent needs; payment links, portal sessions, balance and invoice writes stay off.
CONFIG = {
    "actions": {
        "customers": {"read": True},
        "products": {"read": True},
        "prices": {"read": True},
        "invoices": {"read": True},
        "payment_intents": {"read": True},
        "refunds": {"create": True},
    }
}


def schema(model) -> dict:
    """args_schema as a tool input schema, stripped as the toolkit's own openai/tool.py does."""
    s = model.model_json_schema()
    s.pop("title", None)
    s.pop("description", None)
    for p in s.get("properties", {}).values():
        p.pop("title", None)
        p.pop("default", None)
    return {**s, "type": "object"}


ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "The ID of the subscription item to modify."},
        "price": {"type": "string", "description": "The ID of the price to switch to."},
        "quantity": {"type": "integer", "minimum": 1, "description": "The quantity of the plan to subscribe to."},
        "deleted": {"type": "boolean", "description": "Whether to delete this item."},
    },
}
PORTED = [
    {
        "name": "list_subscriptions",
        "description": """
This tool will list all subscriptions in Stripe.

It takes four arguments:
- customer (str, optional): The ID of the customer to list subscriptions for.

- price (str, optional): The ID of the price to list subscriptions for.
- status (str, optional): The status of the subscriptions to list.
- limit (int, optional): The number of subscriptions to return.
""",
        "input_schema": {
            "type": "object",
            "properties": {
                "customer": {"type": "string", "description": "The ID of the customer to list subscriptions for."},
                "price": {"type": "string", "description": "The ID of the price to list subscriptions for."},
                "status": {
                    "type": "string",
                    "enum": ["active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "trialing", "all"],
                    "description": "The status of the subscriptions to retrieve.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "A limit on the number of objects to be returned. Limit can range between 1 and 100.",
                },
            },
        },
    },
    {
        "name": "cancel_subscription",
        "description": """
This tool will cancel a subscription in Stripe.

It takes the following arguments:
- subscription (str, required): The ID of the subscription to cancel.
""",
        "input_schema": {
            "type": "object",
            "properties": {"subscription": {"type": "string", "description": "The ID of the subscription to cancel."}},
            "required": ["subscription"],
        },
    },
    {
        "name": "update_subscription",
        "description": """This tool will update an existing subscription in Stripe. If changing an existing subscription item, the existing subscription item has to be set to deleted and the new one has to be added.

  It takes the following arguments:
  - subscription (str, required): The ID of the subscription to update.
  - proration_behavior (str, optional): Determines how to handle prorations when the subscription items change. Options: 'create_prorations', 'none', 'always_invoice', 'none_implicit'.
  - items (array, optional): A list of subscription items to update, add, or remove. Each item can have the following properties:
    - id (str, optional): The ID of the subscription item to modify.
    - price (str, optional): The ID of the price to switch to.
    - quantity (int, optional): The quantity of the plan to subscribe to.
    - deleted (bool, optional): Whether to delete this item.
  """,
        "input_schema": {
            "type": "object",
            "properties": {
                "subscription": {"type": "string", "description": "The ID of the subscription to update."},
                "proration_behavior": {
                    "type": "string",
                    "enum": ["create_prorations", "none", "always_invoice", "none_implicit"],
                    "description": "Determines how to handle prorations when the subscription items change.",
                },
                "items": {"type": "array", "items": ITEM, "description": "A list of subscription items to update, add, or remove."},
            },
            "required": ["subscription"],
        },
    },
]


def ported(name: str, args: dict):
    if name == "list_subscriptions":
        return stripe.Subscription.list(**args).data
    sub = args.pop("subscription")
    if name == "cancel_subscription":
        return stripe.Subscription.cancel(sub)
    return stripe.Subscription.modify(sub, **args)


def main() -> None:
    api = StripeAPI(secret_key=os.environ["STRIPE_API_KEY"], context=None)
    enabled = [t for t in TOOLKIT if is_tool_allowed(t, CONFIG)]
    defs = [{"name": t["method"], "description": t["description"], "input_schema": schema(t["args_schema"])} for t in enabled] + PORTED
    print(json.dumps({"tools": defs}), flush=True)
    known = {t["method"] for t in enabled}
    for line in sys.stdin:
        req = json.loads(line)
        name, args = req["name"], dict(req.get("input") or {})
        try:
            if name in known:
                content = api.run(name, **args)
            elif name in {t["name"] for t in PORTED}:
                content = json.dumps(ported(name, args))
            else:
                raise ValueError(f"unknown tool {name}")
            reply = {"ok": True, "content": content}
        except Exception as e:  # an API error or a bad argument is the model's to see, like any tool result
            reply = {"ok": False, "content": f"{type(e).__name__}: {e}"}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
