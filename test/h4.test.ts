import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger } from "../src/bench/budget.ts";
import { wilson } from "../src/bench/score.ts";
import { createTwin } from "../src/twin/server.ts";
import type { LlmEntry } from "../src/align/llm.ts";
import { h4Text, loadTasks, MAX_TURNS, report, runH4, verdict, type TaskResult } from "../evals/h4/run.ts";

// These run the real bridge (evals/h4/toolkit.py under `uv run --script`, the pinned toolkit) against in-process twins.
const RUN = join(import.meta.dirname, "../evals/h4/run.ts");
const TASKS = loadTasks();
const task = (id: string) => TASKS.find((t) => t.id === id)!;
const tmp = (): string => mkdtempSync(join(tmpdir(), "pb-h4-"));
const quiet = () => {};
/** Twin surface gaps this harness found: the scripted agent's correct calls fail on the twin. */
const TWIN_GAPS = ["switch-to-annual"]; // a price with another interval: the twin answers not_implemented

/** Sets env vars for one test (undefined deletes) and returns the restore. */
function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>) => Object.entries(v).forEach(([k, x]) => (x === undefined ? delete process.env[k] : (process.env[k] = x)));
  set(vars);
  return () => set(saved);
}

test("tasks.json: 20 refund/cancel/proration tasks, each with setup, an instruction naming the customer, scripted calls and checks", () => {
  assert.equal(TASKS.length, 20);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, 20);
  const n = (s: string) => TASKS.filter((t) => t.stratum === s).length;
  assert.deepEqual([n("refunds"), n("cancellation"), n("proration")], [6, 6, 8]);
  for (const t of TASKS) {
    assert.ok(t.setup.length >= 4 && t.setup.every((s) => typeof s === "object" && s.method && s.path), t.id);
    assert.match(t.instruction, /\$c1\.email/, t.id);
    assert.ok(t.scripted.length >= 1 && t.checks.length >= 1 && t.checks.every((c) => Object.keys(c.expect).length > 0), t.id);
  }
});

test("scripted agent on the twin: every task passes but the twin's known gaps (harness validation, no LLM)", async () => {
  const r = await runH4({ tasks: TASKS, runs: ["twin"], agent: "scripted", log: quiet });
  const failing = r.tasks.filter((t) => t.outcomes.twin !== "pass").map((t) => `${t.id}:${t.outcomes.twin}`);
  assert.deepEqual(failing, TWIN_GAPS.map((id) => `${id}:fail`));
  assert.equal(r.agreement, null);
  assert.equal(r.model, null);
  assert.equal(r.costUsd, 0);
  assert.match(h4Text(r), /twin: 19 pass, 1 fail, 0 setup error/);
});

test("an agent that does nothing fails every task: no predicate holds on the setup state alone", async () => {
  const r = await runH4({ tasks: TASKS.map((t) => ({ ...t, scripted: [] })), runs: ["twin"], agent: "scripted", log: quiet });
  assert.deepEqual(r.tasks.filter((t) => t.outcomes.twin !== "fail").map((t) => t.id), []);
});

/** A fake Messages API: `reply(body, n)` answers the n-th call (1-based); every request is kept. */
async function fakeAnthropic(reply: (body: any, n: number) => { content: unknown[]; stop_reason: string }) {
  const calls: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ headers: req.headers, body });
    const r = reply(body, calls.length);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...r, usage: { input_tokens: 1000, output_tokens: 100 } }));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}
const toolUse = (n: number, name: string, input: unknown) => ({ content: [{ type: "tool_use", id: `toolu_${n}`, name, input }], stop_reason: "tool_use" });
const lastResult = (body: any) => body.messages.at(-1).content[0];

test("llm agent: the tool-use loop runs the model's calls through the toolkit, feeds results back, and ledgers every call", async () => {
  // Plays refund-full: find the customer by email, list its payment intents, refund the first, then stop.
  const fake = await fakeAnthropic((body, n) => {
    if (n === 1) return toolUse(n, "list_customers", { email: /(\S+@example\.com)/.exec(body.messages[0].content)![1] });
    if (n === 2) return toolUse(n, "list_payment_intents", { customer: JSON.parse(lastResult(body).content)[0].id });
    if (n === 3) return toolUse(n, "create_refund", { payment_intent: JSON.parse(lastResult(body).content)[0].id, amount: null });
    return { content: [{ type: "text", text: "Refunded in full." }], stop_reason: "end_turn" };
  });
  const ledger = join(tmp(), "llm.jsonl");
  const restore = withEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: fake.url, PARITY_LLM_MODEL: undefined, PARITY_LLM_CAP_USD: undefined });
  try {
    const r = await runH4({ tasks: [task("refund-full")], runs: ["twin"], agent: "llm", ledger, log: quiet });
    assert.deepEqual(r.tasks[0], { id: "refund-full", stratum: "refunds", outcomes: { twin: "pass" }, turns: { twin: 4 } });
    assert.equal(r.model, "claude-sonnet-5");
    assert.equal(fake.calls.length, 4);
    const first = fake.calls[0]!;
    assert.equal(first.headers["x-api-key"], "sk-ant-test");
    assert.equal(first.body.model, "claude-sonnet-5");
    assert.equal(first.body.max_tokens, 8192);
    assert.equal("temperature" in first.body, false); // claude-sonnet-5 rejects it (src/align/llm.ts PRICES)
    assert.deepEqual(first.body.tools.map((t: { name: string }) => t.name).sort(), [
      "cancel_subscription", "create_refund", "list_customers", "list_invoices", "list_payment_intents", "list_prices", "list_products", "list_subscriptions", "update_subscription",
    ]);
    // The toolkit's own create_refund result serializes (it json.dumps the API object): no is_error.
    assert.equal(lastResult(fake.calls[3]!.body).is_error, undefined);
    assert.equal(JSON.parse(lastResult(fake.calls[3]!.body).content).amount, 2000);
    const entries = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as LlmEntry);
    assert.equal(entries.length, 4);
    assert.ok(entries.every((e) => e.purpose === "h4" && e.model === "claude-sonnet-5" && e.cost_usd === 0.003 && e.runId === entries[0]!.runId));
    assert.equal(r.costUsd.toFixed(3), "0.012");
  } finally {
    restore();
    fake.close();
  }
});

test("llm agent: stops after 12 model calls; tool errors reach the model as is_error results", async () => {
  const fake = await fakeAnthropic((_, n) => toolUse(n, "cancel_subscription", { subscription: "sub_missing" }));
  const restore = withEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: fake.url, PARITY_LLM_MODEL: undefined, PARITY_LLM_CAP_USD: undefined });
  try {
    const r = await runH4({ tasks: [task("cancel-now")], runs: ["twin"], agent: "llm", ledger: join(tmp(), "llm.jsonl"), log: quiet });
    assert.deepEqual(r.tasks[0]!.outcomes, { twin: "fail" });
    assert.equal(r.tasks[0]!.turns!.twin, MAX_TURNS);
    assert.equal(fake.calls.length, MAX_TURNS);
    assert.equal(lastResult(fake.calls[1]!.body).is_error, true);
  } finally {
    restore();
    fake.close();
  }
});

test("llm agent: refused before any call without a key, over this run's cap, or over the H4 total cap", async () => {
  const fake = await fakeAnthropic(() => ({ content: [], stop_reason: "end_turn" }));
  const one = [task("refund-full")];
  let restore = withEnv({ ANTHROPIC_API_KEY: undefined });
  try {
    await assert.rejects(runH4({ tasks: one, runs: ["twin"], agent: "llm", log: quiet }), /ANTHROPIC_API_KEY is not set: no live LLM runs/);
  } finally {
    restore();
  }
  restore = withEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: fake.url, PARITY_LLM_MODEL: undefined, PARITY_LLM_CAP_USD: undefined });
  try {
    // A call's worst case is > $0.08 (8192 output tokens at $10/M), so a $0.05 run cap refuses the first call.
    await assert.rejects(runH4({ tasks: one, runs: ["twin"], agent: "llm", capUsd: 0.05, ledger: join(tmp(), "llm.jsonl"), log: quiet }), /this run's cap \(--cap-usd\)/);
    const ledger = join(tmp(), "llm.jsonl");
    const old: LlmEntry = { date: "2026-09-01T00:00:00.000Z", runId: "r0", purpose: "h4", model: "claude-sonnet-5", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 49.99, stop_reason: "end_turn" };
    writeFileSync(ledger, JSON.stringify(old) + "\n");
    await assert.rejects(runH4({ tasks: one, runs: ["twin"], agent: "llm", ledger, log: quiet }), /H4 total cap: \$49\.9900 spent/);
    assert.equal(fake.calls.length, 0);
  } finally {
    restore();
    fake.close();
  }
});

test("sandbox half: setup, tools and checks all go through the metered proxy (fake upstream); both halves agree", async () => {
  const upstream = await createTwin().listen(0);
  const dir = tmp();
  mkdirSync(join(dir, "budget"));
  writeFileSync(join(dir, "budget/reads.jsonl"), ""); // not seeded from this repo's legacy ledger
  const restore = withEnv({ PARITY_DATA_DIR: dir, STRIPE_API_KEY: "sk_test_env", PARITY_READ_BUDGET: "1000" });
  try {
    const sandbox = { name: "sandbox", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "unused", rps: 1000 };
    const three = ["refund-full", "cancel-now", "upgrade-bill-now"].map(task);
    const r = await runH4({ tasks: three, runs: ["twin", "sandbox"], agent: "scripted", sandbox, log: quiet });
    assert.deepEqual(r.tasks.map((t) => t.outcomes), three.map(() => ({ twin: "pass", sandbox: "pass" })));
    assert.deepEqual([r.agreement!.k, r.agreement!.n, r.verdict], [3, 3, "confirm (>=95%)"]);
    const [row] = readLedger(join(dir, "budget/reads.jsonl"));
    // GETs: each task's setup lists its payment intents, then 2 check reads. POSTs: setups 4 + 4 + 5, the refund and
    // the update. DELETE: the cancel. Nothing reached the upstream except through the proxy's counter.
    assert.deepEqual([row!.gets, row!.posts, row!.deletes], [3 * 3, 13 + 2, 1]);
  } finally {
    restore();
    upstream.close();
  }
});

test("sandbox half: a run the proxy halts (read budget reached mid-run) is ledgered and gives no report", async () => {
  const upstream = await createTwin().listen(0);
  const dir = tmp();
  mkdirSync(join(dir, "budget"));
  writeFileSync(join(dir, "budget/reads.jsonl"), "");
  const restore = withEnv({ PARITY_DATA_DIR: dir, STRIPE_API_KEY: "sk_test_env", PARITY_READ_BUDGET: "2" });
  try {
    const sandbox = { name: "sandbox", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "unused", rps: 1000 };
    await assert.rejects(
      runH4({ tasks: [task("refund-full")], runs: ["sandbox"], agent: "scripted", sandbox, log: quiet }),
      /the sandbox run was halted, so there is no report: run halted: the rolling 30-day sandbox GETs reached the read budget 2/,
    );
    assert.equal(readLedger(join(dir, "budget/reads.jsonl"))[0]!.gets, 2);
  } finally {
    restore();
    upstream.close();
  }
});

test("sandbox half: refused before anything runs without a key or at the read budget", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "budget"));
  writeFileSync(join(dir, "budget/reads.jsonl"), JSON.stringify({ date: new Date().toISOString(), account: "acct_test", target: "sandbox", runId: "r0", gets: 50, posts: 0, deletes: 0, charges: 0 }) + "\n");
  const one = [task("refund-full")];
  let restore = withEnv({ PARITY_DATA_DIR: dir, STRIPE_API_KEY: undefined });
  try {
    await assert.rejects(runH4({ tasks: one, runs: ["twin", "sandbox"], agent: "scripted", log: quiet }), /STRIPE_API_KEY is not set/);
  } finally {
    restore();
  }
  restore = withEnv({ PARITY_DATA_DIR: dir, STRIPE_API_KEY: "sk_test_env", PARITY_READ_BUDGET: "50" });
  try {
    await assert.rejects(runH4({ tasks: one, runs: ["twin", "sandbox"], agent: "scripted", log: quiet }), /refusing to run: 50 sandbox GETs in the last 30 days/);
  } finally {
    restore();
  }
});

test("agreement: same outcome on both targets; >=95% confirms, <90% stops; the report holds ids and outcomes only", () => {
  assert.equal(verdict(null), "n/a: H4 needs both the twin and the sandbox runs");
  assert.equal(verdict(wilson(19, 20)), "confirm (>=95%)");
  assert.equal(verdict(wilson(18, 20)), "inconclusive (90-95%)");
  assert.equal(verdict(wilson(17, 20)), "stop (<90%): fix before any pricing conversation");

  const res = (outcome: TaskResult["outcome"]): TaskResult => ({ outcome, why: "check 0: expected 2000, got 1500" });
  const tasks = TASKS.slice(0, 3);
  const results = new Map([
    ["twin", new Map([[tasks[0]!.id, res("pass")], [tasks[1]!.id, res("fail")], [tasks[2]!.id, res("fail")]])],
    ["sandbox", new Map([[tasks[0]!.id, res("pass")], [tasks[1]!.id, res("fail")], [tasks[2]!.id, res("error")]])],
  ]);
  const r = report({ tasks, runs: ["twin", "sandbox"], results, agent: "scripted", costUsd: 0 });
  assert.deepEqual([r.agreement!.k, r.agreement!.n], [2, 3]);
  const text = h4Text(r);
  assert.match(text, /\*\*Agreement: 66\.7%\*\* \(2\/3 tasks/);
  assert.match(text, new RegExp(`## Disagreeing tasks \\(1\\)\\n\\n- ${tasks[2]!.id}: twin fail, sandbox error`));
  assert.doesNotMatch(JSON.stringify(r) + text, /expected 2000/);
});

test("CLI: bad flags exit 2; --agent llm without a key exits 1 and says there are no live runs", () => {
  const cwd = tmp(); // no .env here
  const { NODE_TEST_CONTEXT: _, ANTHROPIC_API_KEY: __, ...env } = process.env;
  const run = (args: string[]) => spawnSync(process.execPath, [RUN, ...args], { cwd, encoding: "utf8", env });
  const bad = run(["--runs", "twin,mock"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--runs must be twin, sandbox or both/);
  const noKey = run(["--runs", "twin"]);
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /h4: ANTHROPIC_API_KEY is not set: no live LLM runs/);
});
