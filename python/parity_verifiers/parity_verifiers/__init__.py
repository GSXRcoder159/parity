"""A `verifiers` ToolEnv of billing-support tasks over the Parity twin (start it with `node src/twin/main.ts`).

Each rollout seeds its own customer through the API before the first turn, so rollouts can share one twin. The
rubric reads that rollout's objects back from `/_parity/state` and checks the final state.
"""

import json
import uuid
from collections.abc import Callable
from functools import partial
from typing import Literal, NamedTuple
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import verifiers as vf
from datasets import Dataset

KEY = "sk_test_parity"  # the twin accepts any sk_test_ key
SYSTEM = (
    "You are a billing support agent. Use the tools to resolve the customer's request (amounts are in cents). "
    "Change nothing the customer did not ask for. When done, reply with a one-line summary."
)

# ponytail: sync urllib on the event loop (tools, setup, rubric); fine against a local twin, asyncio.to_thread if remote.


def call(base_url: str, method: str, path: str, params: dict | None = None) -> tuple[int, dict]:
    """One form-encoded API request. Returns (status, JSON body); an error status is returned, not raised."""
    form = urlencode({k: str(v).lower() if isinstance(v, bool) else v for k, v in (params or {}).items() if v is not None})
    url = base_url + path + (f"?{form}" if form and method != "POST" else "")
    req = Request(url, data=form.encode() if method == "POST" else None, method=method, headers={"Authorization": f"Bearer {KEY}"})
    try:
        with urlopen(req) as r:
            return r.status, json.load(r)
    except HTTPError as e:
        return e.code, json.load(e)


def ok(base_url: str, method: str, path: str, params: dict | None = None) -> dict:
    """`call` for setup. An unreachable twin or any status but 200 raises `vf.InfraError`, which verifiers records in
    that rollout's `state["error"]` (and retries under `max_retries`); any other exception would abort the whole run."""
    try:
        status, body = call(base_url, method, path, params)
    except OSError as e:  # URLError, connection reset: the twin is unreachable
        raise vf.InfraError(f"setup {method} {path}: {e}") from e
    if status != 200:
        raise vf.InfraError(f"setup {method} {path} -> {status}: {body}")
    return body


# --- Tasks: setup(api) -> ids (always "email", which fills the prompt); check(obj, ids) -> solved. ---

Api = Callable[..., dict]


class Task(NamedTuple):
    prompt: str
    setup: Callable[[Api], dict]
    check: Callable[[Callable[[str], dict], dict], bool]


def customer(api: Api) -> dict:
    email = f"cust-{uuid.uuid4().hex[:8]}@example.com"
    cus = api("POST", "/v1/customers", {"email": email, "name": "Ada Lovelace"})
    pm = api("POST", "/v1/payment_methods/pm_card_visa/attach", {"customer": cus["id"]})
    return {"email": email, "customer": cus["id"], "pm": pm["id"]}


def subscribe(api: Api, ids: dict, name: str, amount: int, **extra) -> dict:
    """A paid monthly subscription: returns its id, payment intent and charge."""
    price = api("POST", "/v1/prices", {"currency": "usd", "unit_amount": amount, "recurring[interval]": "month", "product_data[name]": name})
    sub = api("POST", "/v1/subscriptions", {"customer": ids["customer"], "items[0][price]": price["id"], "default_payment_method": ids["pm"], **extra})
    pi = api("GET", "/v1/payment_intents", {"customer": ids["customer"], "limit": 1})["data"][0]  # newest first
    return {"sub": sub["id"], "pi": pi["id"], "charge": pi["latest_charge"]}


def one(**extra) -> Callable[[Api], dict]:
    """Setup: a customer with one $20/month Pro subscription."""
    return lambda api: (ids := customer(api)) | subscribe(api, ids, "Pro plan", 2000, **extra)


def two(api: Api) -> dict:
    """Setup: a customer with a $29 Base plan and a $9 Analytics add-on, as two subscriptions."""
    ids = customer(api)
    base, addon = subscribe(api, ids, "Base plan", 2900), subscribe(api, ids, "Analytics add-on", 900)
    return ids | {f"base_{k}": v for k, v in base.items()} | {f"addon_{k}": v for k, v in addon.items()}


def active(s: dict) -> bool:
    return s["status"] == "active" and not s["cancel_at_period_end"]


def refunded(c: dict) -> int:
    return c["amount_refunded"]


TASKS: dict[str, Task] = {
    "cancel_now": Task(
        "Customer {email} wants their subscription canceled immediately.",
        one(),
        lambda o, i: o(i["sub"])["status"] == "canceled" and refunded(o(i["charge"])) == 0,
    ),
    "cancel_at_period_end": Task(
        "Customer {email} wants to stop their subscription but keep access until the end of the period they paid for.",
        one(),
        lambda o, i: o(i["sub"])["status"] == "active" and o(i["sub"])["cancel_at_period_end"] is True and refunded(o(i["charge"])) == 0,
    ),
    "keep_subscription": Task(
        "Customer {email} scheduled their subscription to cancel, changed their mind, and wants to keep it.",
        one(cancel_at_period_end=True),
        lambda o, i: active(o(i["sub"])) and refunded(o(i["charge"])) == 0,
    ),
    "refund_full": Task(
        "Customer {email} wants their subscription payment refunded in full, and wants to keep the subscription.",
        one(),
        lambda o, i: refunded(o(i["charge"])) == 2000 and active(o(i["sub"])),
    ),
    "refund_partial": Task(
        "Customer {email} was promised a $5.00 credit for an outage: refund $5.00 of their last payment. "
        "Do not change their subscription.",
        one(),
        lambda o, i: refunded(o(i["charge"])) == 500 and active(o(i["sub"])),
    ),
    "cancel_and_refund": Task(
        "Customer {email} signed up by mistake: cancel their subscription now and refund the payment in full.",
        one(),
        lambda o, i: o(i["sub"])["status"] == "canceled" and refunded(o(i["charge"])) == 2000,
    ),
    "cancel_with_feedback": Task(
        "Customer {email} wants to cancel right away because it is too expensive. Record that reason on the cancellation.",
        one(),
        lambda o, i: o(i["sub"])["status"] == "canceled"
        and o(i["sub"])["cancellation_details"]["feedback"] == "too_expensive"
        and refunded(o(i["charge"])) == 0,
    ),
    "addon_refund": Task(
        "Customer {email} added the $9/month Analytics add-on by accident. Cancel only the add-on, now, and refund "
        "what they paid for it. Keep their Base plan.",
        two,
        lambda o, i: o(i["addon_sub"])["status"] == "canceled"
        and refunded(o(i["addon_charge"])) == 900
        and active(o(i["base_sub"]))
        and refunded(o(i["base_charge"])) == 0,
    ),
    "po_number": Task(
        "Customer {email} needs purchase order number PO-2291 recorded on their subscription, under the metadata key po_number.",
        one(),
        lambda o, i: o(i["sub"])["metadata"].get("po_number") == "PO-2291" and active(o(i["sub"])) and refunded(o(i["charge"])) == 0,
    ),
    "no_double_charge": Task(
        "Customer {email} says they were charged twice this month and wants the duplicate refunded. "
        "Check their payments and refund only a real duplicate.",
        one(),
        lambda o, i: refunded(o(i["charge"])) == 0 and active(o(i["sub"])),
    ),
}


def setup(base_url: str, task: str) -> dict:
    """Seeds a fresh customer for `task` on the twin; returns the ids its check needs."""
    return TASKS[task].setup(partial(ok, base_url))


def score(base_url: str, task: str, ids: dict) -> float:
    """1.0 if the twin's final state solves `task` for the objects `setup` created, else 0.0."""
    # ponytail: fetches the whole store per score, and nothing resets it (rollouts share the twin), so it grows with
    # every rollout; restart the twin between runs, or add an ids filter to /_parity/state if long runs get slow.
    with urlopen(f"{base_url}/_parity/state") as r:
        objects = {o["id"]: o for o in json.load(r)["objects"]}
    return float(TASKS[task].check(objects.__getitem__, ids))


class ParityEnv(vf.ToolEnv):
    """A ToolEnv whose rollouts each seed their own customer before the first turn and name it in the prompt."""

    def __init__(self, base_url: str, **kwargs):
        self.base_url = base_url
        super().__init__(**kwargs)

    async def setup_state(self, state: vf.State) -> vf.State:
        state["parity"] = ids = setup(self.base_url, state["answer"])
        msg = state["prompt"][-1]
        msg.content = msg.content.format(**ids)
        return state


def load_environment(base_url: str = "http://127.0.0.1:12111", tasks: list[str] | None = None, **kwargs) -> vf.ToolEnv:
    """The billing-support ToolEnv over the twin at `base_url`; `tasks` picks a subset of `TASKS` by name."""
    unknown = set(tasks or []) - TASKS.keys()
    if unknown:
        raise ValueError(f"unknown tasks: {sorted(unknown)}")
    api = partial(call, base_url)
    out = lambda res: json.dumps(res[1])  # the body only: an error body names its type, code and param
    sid = lambda s: quote(s, safe="")  # a model-written id stays one path segment

    def lookup_customer(email: str) -> str:
        """Find customers by email, each with their subscriptions and payments (payment intents).

        Args:
            email: The customer's email address.
        """
        status, found = api("GET", "/v1/customers", {"email": email})
        if status != 200:
            return json.dumps(found)
        return json.dumps([
            {
                "customer": c,
                "subscriptions": api("GET", "/v1/subscriptions", {"customer": c["id"], "status": "all"})[1]["data"],
                "payments": api("GET", "/v1/payment_intents", {"customer": c["id"]})[1]["data"],
            }
            for c in found["data"]
        ])

    def get_subscription(subscription_id: str) -> str:
        """Retrieve a subscription.

        Args:
            subscription_id: The subscription id (sub_...).
        """
        return out(api("GET", f"/v1/subscriptions/{sid(subscription_id)}"))

    def update_subscription(
        subscription_id: str,
        cancel_at_period_end: bool | None = None,
        metadata_key: str | None = None,
        metadata_value: str | None = None,
    ) -> str:
        """Update a subscription. Omitted fields are left unchanged.

        Args:
            subscription_id: The subscription id (sub_...).
            cancel_at_period_end: True cancels at the end of the current period; false undoes a scheduled cancellation.
            metadata_key: A metadata key to set on the subscription.
            metadata_value: The value for metadata_key; empty removes the key.
        """
        params = {"cancel_at_period_end": cancel_at_period_end}
        if metadata_key:
            params[f"metadata[{metadata_key}]"] = metadata_value or ""
        return out(api("POST", f"/v1/subscriptions/{sid(subscription_id)}", params))

    def cancel_subscription(
        subscription_id: str,
        feedback: Literal[
            "customer_service", "low_quality", "missing_features", "other", "switched_service", "too_complex", "too_expensive", "unused"
        ]
        | None = None,
        comment: str | None = None,
    ) -> str:
        """Cancel a subscription immediately.

        Args:
            subscription_id: The subscription id (sub_...).
            feedback: The customer's reason for canceling.
            comment: Free-text cancellation comment.
        """
        details = {"cancellation_details[feedback]": feedback, "cancellation_details[comment]": comment}
        return out(api("DELETE", f"/v1/subscriptions/{sid(subscription_id)}", details))

    def preview_invoice(subscription_id: str) -> str:
        """Preview the next invoice of a subscription.

        Args:
            subscription_id: The subscription id (sub_...).
        """
        return out(api("POST", "/v1/invoices/create_preview", {"subscription": subscription_id}))

    def create_refund(
        payment_intent: str,
        amount: int | None = None,
        reason: Literal["duplicate", "fraudulent", "requested_by_customer"] | None = None,
    ) -> str:
        """Refund a payment.

        Args:
            payment_intent: The payment intent id (pi_...) to refund.
            amount: Amount to refund in cents; omit to refund everything not yet refunded.
            reason: Why the payment is refunded.
        """
        return out(api("POST", "/v1/refunds", {"payment_intent": payment_intent, "amount": amount, "reason": reason}))

    def solved(answer: str, state: vf.State) -> float:
        # no ids means setup failed; its InfraError is in state["error"]
        return score(base_url, answer, state["parity"]) if "parity" in state else 0.0

    names = [t for t in TASKS if tasks is None or t in tasks]
    kwargs.setdefault("system_prompt", SYSTEM)
    return ParityEnv(
        base_url,
        dataset=Dataset.from_list([{"question": TASKS[t].prompt, "answer": t} for t in names]),
        tools=[lookup_customer, get_subscription, update_subscription, cancel_subscription, preview_invoice, create_refund],
        rubric=vf.Rubric(funcs=[solved]),
        **kwargs,
    )
