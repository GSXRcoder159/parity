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
import { h4Text, loadTasks, MAX_TURNS, report, runH4, verdict, type Run, type TaskResult } from "../evals/h4/run.ts";

// These run the real bridge (evals/h4/toolkit.py under `uv run --script`, the pinned toolkit) against in-process twins.
const RUN = join(import.meta.dirname, "../evals/h4/run.ts");
const TASKS = loadTasks();
const task = (id: string) => TASKS.find((t) => t.id === id)!;
const tmp = (): string => mkdtempSync(join(tmpdir(), "pb-h4-"));
const quiet = () => {};
/** Twin surface gaps this harness found: the scripted agent's correct calls fail on the twin. */
// switch-to-annual: a price on another interval without billing_cycle_anchor=now answers not_implemented. Owner: the first
// post-B1 recording task (record the swap on the claimed sandbox, implement it, then drop it from here; evals/h4/README.md).
const TWIN_GAPS = ["switch-to-annual"];

/** Sets env vars for one test (undefined deletes) and returns the restore. */
function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>) => Object.entries(v).forEach(([k, x]) => (x === undefined ? delete process.env[k] : (process.env[k] = x)));
  set(vars);
  return () => set(saved);
}

test("tasks.json: 80 refund/cancel/proration tasks, each with setup, an instruction naming the customer by email, scripted calls and checks", () => {
  assert.equal(TASKS.length, 80);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, 80);
  const n = (s: string) => TASKS.filter((t) => t.stratum === s).length;
  assert.deepEqual([n("refunds"), n("cancellation"), n("proration")], [28, 26, 26]);
  // Invoice lookups and customer lookups by email are grouped by id prefix (their stratum is the write they check).
  const prefix = (p: string) => TASKS.filter((t) => t.id.startsWith(p)).length;
  assert.deepEqual([prefix("invoice-"), prefix("lookup-")], [8, 10]);
  for (const t of TASKS) {
    assert.ok(t.setup.length >= 4 && t.setup.every((s) => typeof s === "object" && s.method && s.path), t.id);
    assert.match(t.instruction, /\$c\w*\.email/, t.id);
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
  assert.match(h4Text(r), /twin: 79 pass, 1 fail, 0 error/);
  // The tool log: each call's name and input keys, in order; no value reaches the report.
  const tools = (id: string) => r.tasks.find((t) => t.id === id)!.tools!.twin;
  assert.deepEqual(tools("cancel-at-period-end"), [{ name: "update_subscription", keys: ["subscription", "cancel_at_period_end"] }]);
  assert.deepEqual(tools("cancel-at-period-end-and-credit"), [
    { name: "update_subscription", keys: ["subscription", "cancel_at_period_end"] },
    { name: "create_refund", keys: ["payment_intent", "amount"] },
  ]);
  assert.doesNotMatch(JSON.stringify(r), /sub_|pi_|@example\.com|true/);
});

test("an agent that does nothing fails every task: no predicate holds on the setup state alone", async () => {
  const r = await runH4({ tasks: TASKS.map((t) => ({ ...t, scripted: [] })), runs: ["twin"], agent: "scripted", log: quiet });
  assert.deepEqual(r.tasks.filter((t) => t.outcomes.twin !== "fail").map((t) => t.id), []);
});

/** A fake Messages API: `reply(body, n)` answers the n-th call (1-based; a `status` other than 200 is an API error); every request is kept. */
async function fakeAnthropic(reply: (body: any, n: number) => { content: unknown[]; stop_reason: string } | { status: number }) {
  const calls: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ headers: req.headers, body });
    const r = reply(body, calls.length);
    if ("status" in r) return void res.writeHead(r.status, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
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
    // The tool log holds names and input keys only: the email, the ids and amount's null are not in the report.
    const log = [
      { name: "list_customers", keys: ["email"] },
      { name: "list_payment_intents", keys: ["customer"] },
      { name: "create_refund", keys: ["payment_intent", "amount"] },
    ];
    assert.deepEqual(r.tasks[0], { id: "refund-full", stratum: "refunds", outcomes: { twin: "pass" }, turns: { twin: 4 }, tools: { twin: log } });
    assert.doesNotMatch(JSON.stringify(r.tasks), /cus_|pi_|@example\.com|null/);
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
    // H4 v2: update_subscription offers cancel_at_period_end and billing_cycle_anchor, in its schema and its description.
    const update = first.body.tools.find((t: { name: string }) => t.name === "update_subscription");
    assert.equal(update.input_schema.properties.cancel_at_period_end.type, "boolean");
    assert.deepEqual(update.input_schema.properties.billing_cycle_anchor.enum, ["now", "unchanged"]);
    assert.match(update.description, /- cancel_at_period_end \(bool, optional\):[\s\S]*- billing_cycle_anchor \(str, optional\): 'now'/);
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

test("tool log masks input keys that aren't normal parameter names (an id or email the model used as a key), keeping normal ones", async () => {
  const fake = await fakeAnthropic((body, n) => {
    if (n === 1) return toolUse(n, "cancel_subscription", { subscription: "sub_missing", cus_ABC123: true, "a@b.com": true });
    return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" };
  });
  const restore = withEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: fake.url, PARITY_LLM_MODEL: undefined, PARITY_LLM_CAP_USD: undefined });
  try {
    const r = await runH4({ tasks: [task("cancel-now")], runs: ["twin"], agent: "llm", ledger: join(tmp(), "llm.jsonl"), log: quiet });
    assert.deepEqual(r.tasks[0]!.tools!.twin, [{ name: "cancel_subscription", keys: ["subscription", "<other>", "<other>"] }]);
    assert.doesNotMatch(JSON.stringify(r.tasks), /cus_ABC123|a@b\.com/);
  } finally {
    restore();
    fake.close();
  }
});

test("llm agent: refused before any call without a key; a cap refusal stops the run and still reports (sandbox half not run)", async () => {
  const fake = await fakeAnthropic(() => ({ content: [], stop_reason: "end_turn" }));
  const one = [task("refund-full")];
  const upstream = await createTwin().listen(0);
  const dir = tmp();
  mkdirSync(join(dir, "budget"));
  writeFileSync(join(dir, "budget/reads.jsonl"), "");
  const sandbox = { name: "sandbox", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "unused", rps: 1000 };
  let restore = withEnv({ ANTHROPIC_API_KEY: undefined });
  try {
    await assert.rejects(runH4({ tasks: one, runs: ["twin"], agent: "llm", log: quiet }), /ANTHROPIC_API_KEY is not set: no live LLM runs/);
  } finally {
    restore();
  }
  restore = withEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: fake.url, PARITY_LLM_MODEL: undefined, PARITY_LLM_CAP_USD: undefined, PARITY_DATA_DIR: dir, STRIPE_API_KEY: "sk_test_env", PARITY_READ_BUDGET: "1000" });
  try {
    // A call's worst case is > $0.08 (8192 output tokens at $10/M), so a $0.05 run cap refuses the first call.
    const two = [task("refund-full"), task("cancel-now")];
    const r = await runH4({ tasks: two, runs: ["twin", "sandbox"], agent: "llm", capUsd: 0.05, ledger: join(tmp(), "llm.jsonl"), sandbox, log: quiet });
    assert.match(r.stopped!, /this run's cap \(--cap-usd\)/);
    assert.deepEqual(r.tasks.map((t) => t.outcomes), two.map(() => ({ twin: "error", sandbox: "error" })));
    assert.deepEqual([r.agreement, r.verdict], [null, "none: 2 task(s) errored on some target, so they were not measured; fix and re-run for the H4 number"]);
    assert.match(h4Text(r), /\*\*Stopped early:\*\* LLM this run's cap/);
    // The sandbox half never started: its only ledger row is the preflight's one GET.
    assert.deepEqual(readLedger(join(dir, "budget/reads.jsonl")).map((e) => [e.gets, e.posts, e.deletes]), [[1, 0, 0]]);
    const ledger = join(tmp(), "llm.jsonl");
    const old: LlmEntry = { date: "2026-09-01T00:00:00.000Z", runId: "r0", purpose: "h4", model: "claude-sonnet-5", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 49.99, stop_reason: "end_turn" };
    writeFileSync(ledger, JSON.stringify(old) + "\n");
    const capped = await runH4({ tasks: one, runs: ["twin"], agent: "llm", ledger, log: quiet });
    assert.match(capped.stopped!, /H4 total cap: \$49\.9900 spent/);
    assert.equal(fake.calls.length, 0);
  } finally {
    restore();
    fake.close();
    upstream.close();
  }
});

test("llm agent: a 529 is retried twice; a third errors that task only; the run goes on and reports it as not measured", async () => {
  // Calls 1-3: refund-full's first model call and its two retries. Call 4: cancel-now's, whose retry (5) answers.
  const fake = await fakeAnthropic((_, n) => (n <= 4 ? { status: 529 } : { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" }));
  const restore = withEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: fake.url, PARITY_LLM_MODEL: undefined, PARITY_LLM_CAP_USD: undefined });
  const lines: string[] = [];
  try {
    const r = await runH4({ tasks: [task("refund-full"), task("cancel-now")], runs: ["twin"], agent: "llm", ledger: join(tmp(), "llm.jsonl"), log: (l) => lines.push(l) });
    assert.deepEqual(r.tasks.map((t) => t.outcomes.twin), ["error", "fail"]); // the do-nothing reply fails cancel-now
    assert.equal(r.stopped, undefined);
    assert.equal(fake.calls.length, 5);
    assert.ok(lines.includes("h4: twin: refund-full: error: LLM HTTP 529: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"));
    assert.match(h4Text(r), /## Not measured: an error on some target \(1\)\n\n- refund-full: twin error/);
  } finally {
    restore();
    fake.close();
  }
});

test("sandbox half: setup, tools and checks all go through the metered proxy (fake upstream); twin, control and sandbox agree", async () => {
  const upstream = await createTwin().listen(0);
  const dir = tmp();
  mkdirSync(join(dir, "budget"));
  writeFileSync(join(dir, "budget/reads.jsonl"), ""); // not seeded from this repo's legacy ledger
  const restore = withEnv({ PARITY_DATA_DIR: dir, STRIPE_API_KEY: "sk_test_env", PARITY_READ_BUDGET: "1000" });
  try {
    const sandbox = { name: "sandbox", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "unused", rps: 1000 };
    const three = ["refund-full", "cancel-now", "upgrade-bill-now"].map(task);
    const r = await runH4({ tasks: three, runs: ["twin", "control", "sandbox"], agent: "scripted", sandbox, log: quiet });
    assert.deepEqual(r.tasks.map((t) => t.outcomes), three.map(() => ({ twin: "pass", control: "pass", sandbox: "pass" })));
    assert.deepEqual([r.agreement!.k, r.agreement!.n, r.control!.k, r.control!.n, r.verdict], [3, 3, 3, 3, "confirm (>=95%)"]);
    assert.match(h4Text(r), /Control \(twin vs a second twin run.*\): 100\.0% \(3\/3;.*noise floor 0\.0%/);
    const [preflight, row] = readLedger(join(dir, "budget/reads.jsonl"));
    assert.deepEqual([preflight!.gets, preflight!.posts, preflight!.deletes], [1, 0, 0]);
    // GETs: each task's setup lists its payment intents, then 2 check reads. POSTs: setups 4 + 4 + 5, the refund and
    // the update. DELETE: the cancel. Nothing reached the upstream except through the proxy's counter; the control run
    // is a twin run and adds nothing here.
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
    assert.deepEqual(readLedger(join(dir, "budget/reads.jsonl")).map((e) => e.gets), [1, 1]); // preflight, then the run up to the budget
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

test("sandbox half: a key the sandbox refuses (401, the state until B1) stops the run at the preflight GET, before the twin half", async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"type":"invalid_request_error","message":"Invalid API Key provided"}}');
  }).listen(0, "127.0.0.1");
  await new Promise((r) => upstream.once("listening", r));
  const dir = tmp();
  mkdirSync(join(dir, "budget"));
  writeFileSync(join(dir, "budget/reads.jsonl"), "");
  const restore = withEnv({ PARITY_DATA_DIR: dir, STRIPE_API_KEY: "sk_test_env", PARITY_READ_BUDGET: "1000" });
  const lines: string[] = [];
  try {
    const sandbox = { name: "sandbox", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "unused", rps: 1000 };
    await assert.rejects(
      runH4({ tasks: [task("refund-full"), task("cancel-now")], runs: ["twin", "sandbox"], agent: "scripted", sandbox, log: (l) => lines.push(l) }),
      /sandbox preflight GET \/v1\/customers -> 401: nothing ran/,
    );
    assert.deepEqual(seen, ["GET /v1/customers?limit=1"]);
    assert.deepEqual(lines, []); // no twin task ran
    assert.deepEqual(readLedger(join(dir, "budget/reads.jsonl")).map((e) => e.gets), [1]);
  } finally {
    restore();
    upstream.close();
  }
});

test("agreement: same outcome on twin and sandbox, beside the twin-vs-control floor; >=95% confirms, <90% stops; the report holds ids and outcomes only", () => {
  const floor = wilson(20, 20);
  assert.equal(verdict(null, null), "n/a: H4 needs both the twin and the sandbox runs");
  assert.equal(verdict(wilson(19, 20), floor), "confirm (>=95%)");
  assert.equal(verdict(wilson(18, 20), floor), "inconclusive (90-95%)");
  assert.equal(verdict(wilson(17, 20), floor), "stop (<90%): fix before any pricing conversation");
  assert.match(verdict(wilson(19, 19), floor, 1), /^none: 1 task\(s\) errored/); // H4 is over the whole suite
  assert.match(verdict(wilson(20, 20), null), /^none: no control run \(a second twin run\), so the agreement has no noise floor/);

  const res = (outcome: TaskResult["outcome"]): TaskResult => ({ outcome, why: "check 0: expected 2000, got 1500" });
  const tasks = TASKS.slice(0, 3);
  const [t0, t1, t2] = tasks.map((t) => t.id) as [string, string, string];
  const results = new Map([
    ["twin", new Map([[t0, res("pass")], [t1, res("fail")], [t2, res("fail")]])],
    ["control", new Map([[t0, res("pass")], [t1, res("pass")], [t2, res("fail")]])],
    ["sandbox", new Map([[t0, res("pass")], [t1, res("fail")], [t2, res("error")]])],
  ]);
  const runs: Run[] = ["twin", "control", "sandbox"];
  const r = report({ tasks, runs, results, agent: "scripted", costUsd: 0 });
  // An error is not an outcome: the errored task leaves the twin-vs-sandbox k/n (not the control's, where it was
  // measured), and there is no verdict until it is measured.
  assert.deepEqual([r.agreement!.k, r.agreement!.n, r.control!.k, r.control!.n], [2, 2, 2, 3]);
  assert.match(r.verdict, /^none: 1 task\(s\) errored/);
  const text = h4Text(r);
  assert.match(text, /\*\*Agreement: 100\.0%\*\* \(2\/2 measured tasks.*→ none: 1 task/);
  assert.match(text, /Control .*: 66\.7% \(2\/3;.*noise floor 33\.3%/);
  assert.match(text, /## Disagreeing tasks: twin vs sandbox \(0\)\n\nnone/);
  assert.match(text, new RegExp(`## Agent variance: twin vs control \\(1\\)\\n\\n- ${t1}: twin fail, control pass, sandbox fail\\n`));
  assert.match(text, new RegExp(`## Not measured: an error on some target \\(1\\)\\n\\n- ${t2}: twin fail, control fail, sandbox error`));
  // Measured everywhere: the verdict reads the twin-vs-sandbox agreement, and only with the control run beside it.
  results.get("sandbox")!.set(t2, res("fail"));
  assert.equal(report({ tasks, runs, results, agent: "scripted", costUsd: 0 }).verdict, "confirm (>=95%)");
  assert.match(report({ tasks, runs: ["twin", "sandbox"], results, agent: "scripted", costUsd: 0 }).verdict, /^none: no control run/);
  // Errors on every task: nothing measured, no agreement.
  const allErr = new Map([...results].map(([run, m]) => [run, new Map([...m].map(([id]) => [id, res("error")]))]));
  const none = report({ tasks, runs, results: allErr, agent: "scripted", costUsd: 0 });
  assert.deepEqual([none.agreement, none.control], [null, null]);
  assert.doesNotMatch(JSON.stringify(r) + text, /expected 2000/);
});

test("CLI: bad flags exit 2; --agent llm without a key exits 1 and says there are no live runs", () => {
  const cwd = tmp(); // no .env here
  const { NODE_TEST_CONTEXT: _, ANTHROPIC_API_KEY: __, ...env } = process.env;
  const run = (args: string[]) => spawnSync(process.execPath, [RUN, ...args], { cwd, encoding: "utf8", env });
  const bad = run(["--runs", "twin,mock"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--runs must be some of twin, control, sandbox/);
  const noKey = run(["--runs", "twin"]);
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /h4: ANTHROPIC_API_KEY is not set: no live LLM runs/);
});
