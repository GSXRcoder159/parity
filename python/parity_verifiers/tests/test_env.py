import asyncio
import json
import re
import subprocess
from pathlib import Path

import pytest
import verifiers as vf
from verifiers.legacy.types import Response, ResponseMessage, ToolCall

from parity_verifiers import TASKS, load_environment, score, setup

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def twin():
    """A twin on an ephemeral port (`node src/twin/main.ts --port 0`), killed after the module's tests."""
    with subprocess.Popen(["node", str(ROOT / "src/twin/main.ts"), "--port", "0"], stdout=subprocess.PIPE, text=True) as p:
        try:
            line = p.stdout.readline()
            m = re.match(r"parity twin listening on (http://127\.0\.0\.1:\d+) ", line)
            assert m, f"unexpected first line: {line!r}"
            yield m[1]
        finally:
            p.kill()


class Scripted(vf.Client):
    """A non-LLM model: turn n calls the tool `plan[n]` picks from the conversation so far; then it stops calling tools."""

    def __init__(self, plan):
        super().__init__(None)
        self.plan = plan

    def setup_client(self, config):
        return None

    async def to_native_tool(self, tool):
        return tool

    async def to_native_prompt(self, messages):
        return messages, {}

    async def get_native_response(self, prompt, model, sampling_args, tools=None, **kwargs):
        turn = sum(m.role == "assistant" for m in prompt)
        calls = [ToolCall(id=f"call_{turn}", name=name, arguments=json.dumps(args)) for name, args in [self.plan[turn](prompt)]] if turn < len(self.plan) else None
        message = ResponseMessage(content=None if calls else "Done.", tool_calls=calls, finish_reason="tool_calls" if calls else "stop", is_truncated=False)
        return Response(id=f"r{turn}", created=0, model=model, message=message)

    async def raise_from_native_response(self, response):
        pass

    async def from_native_response(self, response):
        return response

    async def close(self):
        pass


def lookup(prompt):
    return "lookup_customer", {"email": re.search(r"\S+@example\.com", prompt[-1].content)[0]}


def cancel_at_period_end(prompt):
    sub = json.loads(prompt[-1].content)[0]["subscriptions"][0]["id"]
    return "update_subscription", {"subscription_id": sub, "cancel_at_period_end": True, "metadata_key": None, "metadata_value": None}


def test_scripted_rollout_solves_one_task_and_fails_another(twin):
    env = load_environment(base_url=twin)
    assert isinstance(env, vf.ToolEnv)
    assert [t.name for t in env.tool_defs] == ["lookup_customer", "get_subscription", "update_subscription", "cancel_subscription", "preview_invoice", "create_refund"]
    rows = {r["answer"]: r for r in env.get_dataset()}
    assert len(rows) == 10

    async def run(task):
        state = await env.rollout(rows[task], Scripted([lookup, cancel_at_period_end]), "scripted")
        await env.rubric.score_rollout(state)
        return state

    async def both():  # concurrently, on the one twin
        return await asyncio.gather(run("cancel_at_period_end"), run("cancel_now"))

    # The same two tool calls: right when the customer asked to cancel at period end, wrong when they asked for now.
    solved, failed = asyncio.run(both())
    for state in (solved, failed):
        assert state["error"] is None
        assert [m.role for m in state["completion"]] == ["assistant", "tool", "assistant", "tool", "assistant"]
        assert state["parity"]["email"] in state["prompt"][-1].content
    assert solved["reward"] == 1.0
    assert failed["reward"] == 0.0


# One reference fix per task, as tool calls; "{key}" fills from the ids its setup returned.
FIXES = {
    "cancel_now": [("cancel_subscription", {"subscription_id": "{sub}"})],
    "cancel_at_period_end": [("update_subscription", {"subscription_id": "{sub}", "cancel_at_period_end": True})],
    "keep_subscription": [("update_subscription", {"subscription_id": "{sub}", "cancel_at_period_end": False})],
    "refund_full": [("create_refund", {"payment_intent": "{pi}"})],
    "refund_partial": [("create_refund", {"payment_intent": "{pi}", "amount": 500})],
    "cancel_and_refund": [("cancel_subscription", {"subscription_id": "{sub}"}), ("create_refund", {"payment_intent": "{pi}"})],
    "cancel_with_feedback": [("cancel_subscription", {"subscription_id": "{sub}", "feedback": "too_expensive"})],
    "addon_refund": [("cancel_subscription", {"subscription_id": "{addon_sub}"}), ("create_refund", {"payment_intent": "{addon_pi}"})],
    "po_number": [("update_subscription", {"subscription_id": "{sub}", "metadata_key": "po_number", "metadata_value": "PO-2291"})],
    "no_double_charge": [],  # one charge only: the right move is to refund nothing
}


def test_every_task_fails_untouched_and_passes_its_reference_fix(twin):
    env = load_environment(base_url=twin)
    assert FIXES.keys() == TASKS.keys()
    for task, fix in FIXES.items():
        ids = setup(twin, task)
        assert score(twin, task, ids) == (1.0 if not fix else 0.0), task
        for name, args in fix:
            body = json.loads(env.tool_map[name](**{k: v.format(**ids) if isinstance(v, str) else v for k, v in args.items()}))
            assert "error" not in body, (task, body)
        assert score(twin, task, ids) == 1.0, task


def test_unknown_task_is_refused():
    with pytest.raises(ValueError, match="nope"):
        load_environment(tasks=["nope"])
