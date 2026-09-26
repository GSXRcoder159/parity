#!/usr/bin/env node
// H4 sim-to-real (plan §6.4, the fallback when no partner suite exists): the 20 refund/cancel/proration tasks in
// tasks.json, each run once on the twin and once on the sandbox by an agent that uses the pinned Python agent toolkit
// (toolkit.py) against that target. Reports per-task pass/fail on each, their agreement (the H4 number), the model and
// the LLM cost. The report holds task ids and outcomes only, never a response body (decision 0001 C3).
// ponytail: an agent run, not a gym framework: tasks run one after another, one attempt each, no retries or best-of-3.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { meteredProxy } from "../../src/agree.ts";
import { CapRefused, capUsd, costUsd, DEFAULT_MODEL, MAX_TOKENS, PRICES, readLlmLedger, spentToday, type LlmEntry, type Usage } from "../../src/align/llm.ts";
import { readLedger } from "../../src/bench/budget.ts";
import { dataDir } from "../../src/bench/oracle.ts";
import { createLimiter, resolveRefs, runNonce, runSequence, sandboxTarget, type Target } from "../../src/bench/run.ts";
import { wilson, type Wilson } from "../../src/bench/score.ts";
import { budgetRefusal, newRunId, readsLedger, Refused } from "../../src/cli.ts";
import type { Sequence, Step, Stratum } from "../../src/types.ts";

const HERE = import.meta.dirname;
const REPO_ROOT = resolve(HERE, "../..");
const TASKS = join(HERE, "tasks.json");
const TOOLKIT = join(HERE, "toolkit.py");
const LLM_LEDGER = join(REPO_ROOT, "budget/llm.jsonl");
export const MAX_TURNS = 12;
/** Plan W4 budget for all of H4's LLM spend, over every ledger entry with purpose "h4". */
const H4_CAP_USD = 50;
const SYSTEM =
  "You are a billing support agent with API tools. Resolve the request (amounts are in cents). " +
  "Change nothing the request does not ask for. When done, reply with a one-line summary.";

/** A read of the final state (Step format; refs resolve from setup and earlier checks) and what its body must show:
 * dotted field path -> expected value (refs resolve), or {">": n} / {"<": n}. */
export interface Check extends Step {
  expect: Record<string, unknown>;
}
export interface Task {
  id: string;
  stratum: Stratum;
  setup: Step[];
  instruction: string;
  /** The scripted agent's fixed tool calls (refs resolve from setup). */
  scripted: { tool: string; input: Record<string, unknown> }[];
  checks: Check[];
}
/** error = not measured: the setup failed, or the harness or an LLM call threw (the agent's verdict is unknown). */
export type Outcome = "pass" | "fail" | "error";
export interface TaskResult {
  outcome: Outcome;
  /** Model calls the LLM agent made (absent for the scripted agent). */
  turns?: number;
  /** Why it failed or errored (stderr only: may quote values from a response). */
  why?: string;
}
export interface H4Report {
  date: string;
  agent: "scripted" | "llm";
  model: string | null;
  runs: string[];
  tasks: { id: string; stratum: Stratum; outcomes: Record<string, Outcome>; turns?: Record<string, number> }[];
  /** Tasks with the same outcome on every target, among the tasks with no error on any target; null with a single
   * target or when no task was measured. */
  agreement: Wilson | null;
  /** None while any task errored on some target: H4 is defined over the whole suite. */
  verdict: string;
  costUsd: number;
  /** Why the run stopped before every task ran (an LLM cap, a dead bridge); the rest are `error` ("not run"). */
  stopped?: string;
}

/** tasks.json with each setup's fixture names ("subscribed") expanded to their steps. */
export function loadTasks(path = TASKS): Task[] {
  const file = JSON.parse(readFileSync(path, "utf8")) as { fixtures: Record<string, Step[]>; tasks: (Omit<Task, "setup"> & { setup: (Step | string)[] })[] };
  const fixture = (name: string): Step[] => file.fixtures[name] ?? fail(`unknown fixture "${name}" in ${path}`);
  return file.tasks.map((t) => ({ ...t, setup: t.setup.flatMap((s) => (typeof s === "string" ? fixture(s) : [s])) }));
}

function fail(msg: string): never {
  throw new Error(msg);
}
/** The toolkit bridge exited: every later tool call would fail, so the run stops. */
class BridgeDied extends Error {}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
interface Bridge {
  tools: ToolDef[];
  call(name: string, input: unknown): Promise<{ ok: boolean; content: string }>;
  close(): Promise<void>;
}

/** toolkit.py under `uv run --locked --script` (toolkit.py.lock) with STRIPE_API_BASE = the target: one JSON line per call. */
async function startBridge(t: Target): Promise<Bridge> {
  const { ANTHROPIC_API_KEY: _, ...env } = process.env; // the tools never need the model's key
  const child = spawn("uv", ["run", "--quiet", "--locked", "--script", TOOLKIT], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...env, STRIPE_API_BASE: t.baseUrl, STRIPE_API_KEY: t.apiKey },
  });
  let spawnError = "";
  child.on("error", (e) => (spawnError = `: ${e.message}`));
  child.stdin.on("error", () => {}); // a dead bridge surfaces on the next read, not as an EPIPE crash
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const read = async (): Promise<unknown> => {
    const r = await lines.next();
    if (r.done) throw new BridgeDied(`the toolkit bridge exited${spawnError} (it runs \`uv run --locked --script ${TOOLKIT}\`; needs uv)`);
    return JSON.parse(r.value);
  };
  const { tools } = (await read()) as { tools: ToolDef[] };
  return {
    tools,
    call: async (name, input) => {
      child.stdin.write(JSON.stringify({ name, input }) + "\n");
      return (await read()) as { ok: boolean; content: string };
    },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.stdin.end();
      await closed;
    },
  };
}

interface LlmOpts {
  ledger: string;
  runId: string;
  capUsd: number;
  spent: { usd: number };
}
type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string };

/**
 * One Messages API call with tools. src/align/llm.ts's complete() takes a single user string and returns text only,
 * so this is its tool-use twin: same model default, price table, max_tokens, temperature rule, ledger entry and
 * daily cap, plus the H4 total cap and this run's cap. Refused (CapRefused) before sending when any cap would pass.
 */
async function messages(req: { tools: ToolDef[]; messages: unknown[] }, o: LlmOpts): Promise<Block[]> {
  const env = process.env;
  const apiKey = env.ANTHROPIC_API_KEY || fail("ANTHROPIC_API_KEY is not set");
  const model = env.PARITY_LLM_MODEL || DEFAULT_MODEL;
  const p = PRICES[model] ?? fail(`no price for model "${model}" (PARITY_LLM_MODEL): add it to PRICES in src/align/llm.ts`);
  const body = JSON.stringify({ model, max_tokens: MAX_TOKENS, ...(p.temperature0 ? { temperature: 0 } : {}), system: SYSTEM, tools: req.tools, messages: req.messages });
  const now = new Date();
  const ledger = readLlmLedger(o.ledger);
  // ponytail: chars/2 over-estimates input tokens, as complete() does; count_tokens would make it exact.
  const estimate = costUsd(model, { input_tokens: Math.ceil(body.length / 2), output_tokens: MAX_TOKENS });
  const h4 = ledger.filter((e) => e.purpose === "h4").reduce((s, e) => s + e.cost_usd, 0);
  const caps: [number, number, string][] = [
    [spentToday(ledger, now), capUsd(env), "daily cap (UTC; PARITY_LLM_CAP_USD)"],
    [h4, H4_CAP_USD, "H4 total cap"],
    [o.spent.usd, o.capUsd, "this run's cap (--cap-usd)"],
  ];
  for (const [spent, cap, name] of caps) {
    if (spent + estimate > cap) throw new CapRefused(`LLM ${name}: $${spent.toFixed(4)} spent + $${estimate.toFixed(4)} estimated for this call > $${cap} (${o.ledger})`);
  }
  const redact = (s: string) => s.split(apiKey).join("[REDACTED]");
  let res: Response;
  try {
    res = await fetch(`${(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new Error(`LLM network error: ${redact(String(e))}`);
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${redact(raw.slice(0, 400))}`);
  const json = JSON.parse(raw) as { content?: Block[]; stop_reason?: string | null; usage?: Usage };
  const u = json.usage ?? fail(`LLM reply without usage: ${redact(raw.slice(0, 400))}`);
  const entry: LlmEntry = {
    date: new Date().toISOString(),
    runId: o.runId,
    purpose: "h4",
    model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cost_usd: costUsd(model, u),
    stop_reason: json.stop_reason ?? null,
  };
  mkdirSync(dirname(o.ledger), { recursive: true });
  appendFileSync(o.ledger, JSON.stringify(entry) + "\n");
  o.spent.usd += entry.cost_usd;
  return json.content ?? [];
}

/** The minimal tool-use loop: at most MAX_TURNS model calls; every tool_use in a reply runs; a reply without one ends it. */
async function llmAgent(instruction: string, bridge: Bridge, o: LlmOpts): Promise<number> {
  const msgs: unknown[] = [{ role: "user", content: instruction }];
  for (let turn = 1; ; turn++) {
    const content = await messages({ tools: bridge.tools, messages: msgs }, o);
    msgs.push({ role: "assistant", content });
    const uses = content.filter((b) => b.type === "tool_use");
    if (!uses.length) return turn;
    const results = [];
    for (const u of uses) {
      const r = await bridge.call(u.name!, u.input);
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
    }
    if (turn === MAX_TURNS) return turn;
    msgs.push({ role: "user", content: results });
  }
}

const holds = (got: unknown, want: unknown): boolean => {
  if (want !== null && typeof want === "object" && !Array.isArray(want)) {
    const w = want as Record<string, number>;
    if (">" in w) return typeof got === "number" && got > w[">"]!;
    if ("<" in w) return typeof got === "number" && got < w["<"]!;
  }
  return isDeepStrictEqual(got, want);
};

/** Setup through the harness's runner, the agent, then the checks: pass only when every check holds. */
async function runTask(task: Task, t: Target, act: (instruction: string, r: (v: unknown) => unknown) => Promise<number | undefined>, runId: string): Promise<TaskResult> {
  const target = { ...t, eventWaitMs: 0 }; // predicates read state; no event sweep
  const take = createLimiter(1000); // the sandbox's limiter is the metered proxy's
  const seq = (id: string, steps: Step[]): Sequence => ({ id, template: `h4:${task.id}`, stratum: task.stratum, seed: 0, heldOut: false, steps });
  const id = `h4:${task.id}`;
  const setup = await runSequence(seq(id, task.setup), target, { take, runId });
  const bad = setup.steps.find((s) => s.status !== 200);
  if (bad) return { outcome: "error", why: `setup step ${bad.i} ${bad.method} ${task.setup[bad.i]!.path} -> ${bad.error ?? bad.status}` };
  const bound: Record<string, unknown> = {};
  task.setup.forEach((s, i) => s.ref && (bound[s.ref] = setup.steps[i]!.body));
  const nonce = runNonce(runId, id);
  const r = (v: unknown) => resolveRefs(v, bound, nonce);

  const turns = await act(String(r(task.instruction)), r);
  for (const [i, { expect, ...step }] of task.checks.entries()) {
    const where = `check ${i} (${step.method} ${step.path})`;
    let read: Step;
    try {
      read = r(step) as Step;
    } catch (e) {
      return { outcome: "fail", turns, why: `${where}: ${(e as Error).message}` };
    }
    const got = (await runSequence(seq(`${id}:check${i}`, [read]), target, { take, runId })).steps[0]!;
    if (got.status !== 200) return { outcome: "fail", turns, why: `${where} -> ${got.error ?? got.status}` };
    if (step.ref) bound[step.ref] = got.body;
    for (const [field, want] of Object.entries(r(expect) as Record<string, unknown>)) {
      const value = field.split(".").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), got.body);
      if (!holds(value, want)) return { outcome: "fail", turns, why: `${where} ${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(value)}` };
    }
  }
  return { outcome: "pass", turns };
}

export function verdict(a: Wilson | null, errored = 0): string {
  if (errored) return `none: ${errored} task(s) errored on some target, so they were not measured; fix and re-run for the H4 number`;
  if (!a) return "n/a: H4 needs both the twin and the sandbox runs";
  if (a.p >= 0.95) return "confirm (>=95%)";
  if (a.p < 0.9) return "stop (<90%): fix before any pricing conversation";
  return "inconclusive (90-95%)";
}

/** Outcomes of every task on every run -> the report (agreement = the same outcome on every target, over the tasks
 * with no error on any target). */
export function report(o: { tasks: Task[]; runs: string[]; results: Map<string, Map<string, TaskResult>>; agent: "scripted" | "llm"; costUsd: number; stopped?: string }): H4Report {
  const tasks = o.tasks.map((t) => {
    const rs = o.runs.map((run): [string, TaskResult] => [run, o.results.get(run)!.get(t.id)!]);
    const turns = rs.filter(([, x]) => x.turns !== undefined).map(([run, x]) => [run, x.turns!]);
    return { id: t.id, stratum: t.stratum, outcomes: Object.fromEntries(rs.map(([run, x]) => [run, x.outcome])), ...(turns.length ? { turns: Object.fromEntries(turns) } : {}) };
  });
  const measured = tasks.filter((t) => !Object.values(t.outcomes).includes("error"));
  const agreeing = measured.filter((t) => new Set(Object.values(t.outcomes)).size === 1).length;
  const agreement = o.runs.length > 1 && measured.length ? wilson(agreeing, measured.length) : null;
  return {
    date: new Date().toISOString().slice(0, 10),
    agent: o.agent,
    model: o.agent === "llm" ? process.env.PARITY_LLM_MODEL || DEFAULT_MODEL : null,
    runs: o.runs,
    tasks,
    agreement,
    verdict: o.runs.length > 1 ? verdict(agreement, tasks.length - measured.length) : verdict(null),
    costUsd: o.costUsd,
    ...(o.stopped ? { stopped: o.stopped } : {}),
  };
}

/**
 * Runs `tasks` on each of `runs` in order: twin = an in-process twin on an ephemeral port; sandbox = STRIPE_API_KEY
 * through agree's metered proxy (refused at the read budget; halted at the budget or after 10 consecutive 429s, and a
 * halted run throws Refused: no report). Setup, tools and checks of the sandbox run all go through the proxy, after one
 * preflight GET (also through a proxy) that refuses the run before anything else when the sandbox does not answer 200.
 * A task that throws is recorded as `error` and the run goes on; an LLM cap refusal or a dead bridge stops the run and
 * the rest are `error` ("not run"): either way the report covers what ran. `sandbox` replaces the sandbox upstream (tests only).
 */
export async function runH4(o: { tasks: Task[]; runs: ("twin" | "sandbox")[]; agent: "scripted" | "llm"; capUsd?: number; ledger?: string; sandbox?: Target; log?: (line: string) => void }): Promise<H4Report> {
  const log = o.log ?? ((l: string) => console.error(l));
  if (o.agent === "llm" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set: no live LLM runs (--agent scripted validates the harness without one)");
  const key = process.env.STRIPE_API_KEY;
  const readsPath = o.runs.includes("sandbox") ? readsLedger(dataDir()) : "";
  const budget = Number(process.env.PARITY_READ_BUDGET ?? 10_000);
  const runId = newRunId();
  const upstream = o.sandbox ?? sandboxTarget(key ?? "");
  if (readsPath) {
    if (!key) throw new Error("STRIPE_API_KEY is not set (put it in .env)");
    const refusal = budgetRefusal(readLedger(readsPath), 1, new Date().toISOString(), budget, readsPath);
    if (refusal) throw new Refused(refusal);
    // One authenticated GET before anything runs: a refused key (the state until B1) or an unreachable sandbox then
    // costs one ledgered read, not the twin half's LLM spend followed by a sandbox half of setup errors.
    const proxy = await meteredProxy(upstream, { ledger: readsPath, budget, runId });
    const seq: Sequence = { id: "h4:preflight", template: "h4:preflight", stratum: "refunds", seed: 0, heldOut: false, steps: [{ method: "GET", path: "/v1/customers", params: { limit: 1 } }] };
    const probe = (await runSequence(seq, { name: "sandbox", baseUrl: proxy.baseUrl, apiKey: key, eventWaitMs: 0 }, { take: createLimiter(1000), runId })).steps[0]!;
    const m = await proxy.close();
    if (probe.status !== 200) throw new Refused(`sandbox preflight GET /v1/customers -> ${probe.error ?? probe.status}${m.aborted ? ` (${m.aborted})` : ""}: nothing ran (a refused key waits for B1)`);
  }
  const llm: LlmOpts = { ledger: o.ledger ?? LLM_LEDGER, runId, capUsd: o.capUsd ?? 10, spent: { usd: 0 } };
  const results = new Map<string, Map<string, TaskResult>>();
  let stopped: string | undefined;
  for (const run of o.runs) {
    if (stopped) break;
    let target: Target;
    let close: () => Promise<string | undefined>;
    if (run === "sandbox") {
      const proxy = await meteredProxy(upstream, { ledger: readsPath, budget, runId });
      log(`h4: sandbox via a metered proxy ${proxy.baseUrl} -> ${upstream.baseUrl} (${proxy.rolling}/${budget} GETs used in 30 days)`);
      target = { name: "sandbox", baseUrl: proxy.baseUrl, apiKey: key! };
      close = async () => {
        const m = await proxy.close();
        log(`h4: sandbox: ${m.gets} GET, ${m.posts} POST, ${m.deletes} DELETE ledgered to ${readsPath}${m.aborted ? `; HALTED: ${m.aborted}` : ""}`);
        return m.aborted;
      };
    } else {
      const { createTwin } = await import("../../src/twin/server.ts");
      const server = await createTwin().listen(0);
      target = { name: "twin", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity" };
      close = async () => {
        server.closeAllConnections();
        server.close();
        return undefined;
      };
    }
    const out = new Map<string, TaskResult>();
    results.set(run, out);
    let bridge: Bridge | undefined;
    let halted: string | undefined;
    try {
      bridge = await startBridge(target);
      const b = bridge;
      for (const task of o.tasks) {
        const act =
          o.agent === "llm"
            ? (instruction: string) => llmAgent(instruction, b, llm)
            : async (_: string, r: (v: unknown) => unknown) => {
                for (const c of task.scripted) {
                  const res = await b.call(c.tool, r(c.input));
                  if (!res.ok) log(`h4: ${run}: ${task.id}: scripted ${c.tool} -> ${res.content}`);
                }
                return undefined;
              };
        let res: TaskResult;
        try {
          res = await runTask(task, target, act, runId);
        } catch (e) {
          res = { outcome: "error", why: (e as Error).message };
          if (e instanceof CapRefused || e instanceof BridgeDied) stopped = res.why;
        }
        out.set(task.id, res);
        log(`h4: ${run}: ${task.id}: ${res.outcome}${res.turns === undefined ? "" : ` (${res.turns} turns)`}${res.why ? `: ${res.why}` : ""}`);
        if (stopped) break;
      }
    } finally {
      await bridge?.close();
      halted = await close();
    }
    if (halted) throw new Refused(`the sandbox run was halted, so there is no report: ${halted}`);
  }
  if (stopped) {
    log(`h4: stopped early: ${stopped}`);
    for (const run of o.runs) {
      const out = results.get(run) ?? results.set(run, new Map()).get(run)!;
      for (const t of o.tasks) if (!out.has(t.id)) out.set(t.id, { outcome: "error", why: "not run: the run stopped early" });
    }
  }
  return report({ tasks: o.tasks, runs: o.runs, results, agent: o.agent, costUsd: llm.spent.usd, stopped });
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function h4Text(r: H4Report): string {
  const a = r.agreement;
  const count = (run: string, x: Outcome) => r.tasks.filter((t) => t.outcomes[run] === x).length;
  const errored = r.tasks.filter((t) => Object.values(t.outcomes).includes("error"));
  const disagreeing = r.tasks.filter((t) => !errored.includes(t) && new Set(Object.values(t.outcomes)).size > 1);
  const row = (t: H4Report["tasks"][number]) => `- ${t.id}: ${r.runs.map((run) => `${run} ${t.outcomes[run]}`).join(", ")}`;
  return [
    `# H4 sim-to-real: ${r.runs.join(" vs ")}`,
    "",
    `${r.date} · ${r.tasks.length} tasks · agent ${r.agent}${r.model ? ` (${r.model}, at most ${MAX_TURNS} turns)` : " (fixed tool calls, no LLM)"} · LLM cost $${r.costUsd.toFixed(4)}`,
    "",
    r.runs.map((run) => `${run}: ${count(run, "pass")} pass, ${count(run, "fail")} fail, ${count(run, "error")} error`).join(" · "),
    ...(r.stopped ? ["", `**Stopped early:** ${r.stopped}`] : []),
    "",
    a ? `**Agreement: ${pct(a.p)}** (${a.k}/${a.n} measured tasks; 95% Wilson CI ${pct(a.lo)}–${pct(a.hi)}) → ${r.verdict}` : `Agreement: ${r.verdict}`,
    ...(a ? ["", `## Disagreeing tasks (${disagreeing.length})`, "", ...(disagreeing.length ? disagreeing.map(row) : ["none"])] : []),
    ...(errored.length ? ["", `## Not measured: an error on some target (${errored.length})`, "", ...errored.map(row)] : []),
    "",
    "## Tasks",
    "",
    `| task | stratum | ${r.runs.join(" | ")} |`,
    `|---|---|${r.runs.map(() => "---").join("|")}|`,
    ...r.tasks.map((t) => `| ${t.id} | ${t.stratum} | ${r.runs.map((run) => t.outcomes[run]).join(" | ")} |`),
  ].join("\n");
}

const USAGE = "usage: node evals/h4/run.ts [--runs twin,sandbox] [--agent llm|scripted] [--cap-usd 10] [--out reports/<name>]";

async function main(argv: string[]): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  let runs: ("twin" | "sandbox")[];
  let agent: "scripted" | "llm";
  let cap: number;
  let out: string | undefined;
  try {
    const { values } = parseArgs({ args: argv, options: { runs: { type: "string" }, agent: { type: "string" }, "cap-usd": { type: "string" }, out: { type: "string" } } });
    const r = (values.runs ?? "twin,sandbox").split(",");
    if (r.some((x) => x !== "twin" && x !== "sandbox") || new Set(r).size !== r.length) throw new Error(`--runs must be twin, sandbox or both, got "${values.runs}"`);
    runs = r as ("twin" | "sandbox")[];
    const ag = values.agent ?? "llm";
    if (ag !== "llm" && ag !== "scripted") throw new Error(`--agent must be llm or scripted, got "${ag}"`);
    agent = ag;
    cap = Number(values["cap-usd"] ?? 10);
    if (!(cap > 0)) throw new Error(`--cap-usd must be a positive number, got "${values["cap-usd"]}"`);
    out = values.out;
  } catch (e) {
    console.error(`h4: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    const r = await runH4({ tasks: loadTasks(), runs, agent, capUsd: cap });
    const text = h4Text(r);
    console.log(text);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(`${out}.md`, text + "\n");
      writeFileSync(`${out}.json`, JSON.stringify(r, null, 2) + "\n");
      console.error(`h4: wrote ${out}.md and ${out}.json`);
    }
    return r.stopped ? 1 : 0;
  } catch (e) {
    console.error(`h4: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
