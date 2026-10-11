import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { ASSIST_EFFORT, ASSIST_LOCI, ASSIST_MAX_TOKENS, CONTRACT, assist, assistText, clusters, cooldowns, normalizeWithParams, parseReply, sh, type AssistResult, type Run } from "../src/align/assist.ts";
import { nodeImage, type Judged, type Scores } from "../src/align/gate.ts";
import { align, type AlignResult } from "../src/align/index.ts";
import { CapRefused, capUsd, complete, costUsd, readLlmLedger, type LlmEntry } from "../src/align/llm.ts";
import { appendLog, logPath, verifyLog, type LogEntry } from "../src/align/log.ts";
import type { Locus, Triaged } from "../src/align/triage.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, runNonce, touching } from "../src/bench/run.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { createTwin } from "../src/twin/server.ts";
import type { Recording, StepRecord } from "../src/types.ts";
import { fakeDocker } from "./fake-docker.ts";

const REPO = resolve(import.meta.dirname, "..");
const NOW = () => new Date("2026-09-26T12:00:00.000Z");

/** A local fake Messages API: `reply(n)` answers the n-th request (0-based); every request is kept. */
async function fakeApi(reply: (n: number) => { status?: number; json: unknown }) {
  const requests: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const r = reply(requests.length);
    requests.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.json));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => server.close() };
}
const message = (text: string, usage: Record<string, number> = { input_tokens: 1000, output_tokens: 500 }) => ({
  json: { content: [{ type: "thinking", thinking: "" }, { type: "text", text }], stop_reason: "end_turn", usage },
});
/** A reply in the assist contract: one FILE line, then SEARCH/REPLACE blocks ([search, replace], each ending in a newline). */
const edits = (file: string, ...blocks: [string, string][]) => `FILE: ${file}\n` + blocks.map(([search, replace]) => `<<<<<<< SEARCH\n${search}=======\n${replace}>>>>>>> REPLACE\n`).join("");

/**
 * An oracle: the twin's own recording of customer-crud (train) and subscription-cancel-at-period-end (held out), seeds
 * 1-2, with every object of each step body (innermost first) passed through `edit`.
 */
async function twinOracle(edit: (o: Record<string, unknown>, heldOut: boolean) => Record<string, unknown>): Promise<Recording[]> {
  const CLOCK = "2026-03-01T00:00:00.000Z";
  const seqs = buildCorpus(TEMPLATES.filter((t) => ["customer-crud", "subscription-cancel-at-period-end"].includes(t.name)), [1, 2]);
  const twin = createTwin();
  const server = await twin.listen(0);
  const target = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  const { recordings } = await runCorpus(seqs, target, { concurrency: 2, runId: "oracle", headersFor: () => ({ "Parity-Now": String(Date.parse(CLOCK) / 1000) }) }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  const walk = (v: unknown, heldOut: boolean): unknown =>
    Array.isArray(v) ? v.map((x) => walk(x, heldOut)) : v && typeof v === "object" ? edit(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, heldOut)])), heldOut) : v;
  return recordings.map((r) => ({ ...r, startedAt: CLOCK, events: touching(idsIn(r.steps), twin.store.events), steps: r.steps.map((s) => ({ ...s, body: walk(s.body, r.heldOut) })) }));
}

/** A git repo copy of the twin with a bare origin to push to. */
function gitRepo() {
  const tmp = mkdtempSync(join(tmpdir(), "pb-assist-"));
  const repo = join(tmp, "repo");
  for (const p of ["src", "templates", "package.json"]) cpSync(join(REPO, p), join(repo, p), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", join(tmp, "origin.git")]);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("remote", "add", "origin", join(tmp, "origin.git"));
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repo, git, head: git("rev-parse", "HEAD") };
}

test("llm: cost from usage, one ledger line per call, text blocks only, temperature 0 and effort only where the model accepts them", async () => {
  const api = await fakeApi(() => message("hello", { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000 }));
  try {
    const ledger = join(mkdtempSync(join(tmpdir(), "pb-llm-")), "budget/llm.jsonl");
    const env = { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: api.url };
    const r = await complete({ system: "sys", user: "usr", runId: "run-1", purpose: "test" }, { ledger, env, now: NOW });
    // claude-sonnet-5 at $2/$10 per MTok: 1000 in + 500 out + 2000 cache writes (1.25x in) + 10000 cache reads (0.1x in).
    const want = (1000 * 2 + 500 * 10 + 2000 * 2 * 1.25 + 10000 * 2 * 0.1) / 1e6;
    assert.equal(r.text, "hello");
    assert.ok(Math.abs(r.cost_usd - want) < 1e-12);
    assert.deepEqual(readLlmLedger(ledger), [
      {
        date: "2026-09-26T12:00:00.000Z",
        runId: "run-1",
        purpose: "test",
        model: "claude-sonnet-5",
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 10000,
        cost_usd: r.cost_usd,
        stop_reason: "end_turn",
      },
    ]);
    const [first] = api.requests;
    assert.equal(first!.headers["x-api-key"], "sk-ant-test");
    assert.equal(first!.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(first!.body, { model: "claude-sonnet-5", max_tokens: 8192, system: "sys", messages: [{ role: "user", content: "usr" }] });
    await complete({ system: "s", user: "u", runId: "run-1", purpose: "test", effort: "medium" }, { ledger, env: { ...env, PARITY_LLM_MODEL: "claude-haiku-4-5" }, now: NOW });
    assert.equal(api.requests[1]!.body.temperature, 0);
    assert.equal(api.requests[1]!.body.output_config, undefined, "Haiku 4.5 rejects effort: not sent");
    await complete({ system: "s", user: "u", runId: "run-1", purpose: "test", effort: "medium" }, { ledger, env, now: NOW });
    assert.deepEqual(api.requests[2]!.body.output_config, { effort: "medium" });
    assert.equal(api.requests[2]!.body.thinking, undefined, "Sonnet 5 thinks adaptively by default; a thinking budget would be a 400");
    assert.equal(readLlmLedger(ledger).length, 3);
    await assert.rejects(complete({ system: "s", user: "u", runId: "r", purpose: "p" }, { ledger, env: { ...env, PARITY_LLM_MODEL: "claude-unknown" } }), /no price for model "claude-unknown"/);
    assert.throws(() => costUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 }), /no price/);
    assert.equal(api.requests.length, 3, "an unpriced model is refused before sending");
  } finally {
    api.close();
  }
});

test("llm: the daily cap ($15, lowered only) refuses before sending; yesterday does not count; a 529 is retried twice, then errors redacted and not ledgered", async () => {
  assert.deepEqual([capUsd({}), capUsd({ PARITY_LLM_CAP_USD: "3" }), capUsd({ PARITY_LLM_CAP_USD: "40" })], [15, 3, 15]);
  assert.throws(() => capUsd({ PARITY_LLM_CAP_USD: "lots" }), /non-negative number/);
  const api = await fakeApi((n) => (n >= 1 && n <= 3 ? { status: 529, json: { error: { message: "overloaded for key sk-ant-secret" } } } : message("ok")));
  try {
    const ledger = join(mkdtempSync(join(tmpdir(), "pb-llm-cap-")), "llm.jsonl");
    const entry = (date: string, cost_usd: number): LlmEntry => ({
      date,
      runId: "x",
      purpose: "p",
      model: "claude-sonnet-5",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd,
      stop_reason: "end_turn",
    });
    writeJsonl(ledger, [entry("2026-09-25T23:59:59.000Z", 100), entry("2026-09-26T00:00:01.000Z", 14.95)]);
    const env = { ANTHROPIC_API_KEY: "sk-ant-secret", ANTHROPIC_BASE_URL: api.url };
    const call = (e: Record<string, string>) => complete({ system: "s", user: "u".repeat(1000), runId: "r", purpose: "p" }, { ledger, env: { ...env, ...e }, now: NOW });
    // Today: $14.95 + estimate (501 input tokens, 8192 output: $0.08292) > $15.
    await assert.rejects(call({}), (e: unknown) => e instanceof CapRefused && /\$14\.9500 spent today \(UTC\) \+ \$0\.0829 estimated for this call > cap \$15/.test((e as Error).message));
    assert.equal(api.requests.length, 0);
    writeJsonl(ledger, [entry("2026-09-25T23:59:59.000Z", 100)]);
    await call({ PARITY_LLM_CAP_USD: "3" }); // yesterday's $100 does not count against today
    await assert.rejects(call({ PARITY_LLM_CAP_USD: "0.05" }), CapRefused);
    await assert.rejects(call({}), (e: unknown) => /LLM HTTP 529: .*overloaded for key \[REDACTED\]/.test((e as Error).message) && !(e as Error).message.includes("sk-ant-secret"));
    assert.equal(api.requests.length, 4); // the 529 was sent three times
    assert.deepEqual(readLlmLedger(ledger).map((e) => e.date.slice(0, 10)), ["2026-09-25", "2026-09-26"], "only the call that returned usage is ledgered");
  } finally {
    api.close();
  }
});

test("llm: a call's maxTokens and effort are sent, maxTokens charged in full (thinking included) in the cap estimate; a night's ASSIST_LOCI assist calls on prompts twice 2026-09-28's largest fit the CI's $3 cap, the ninth is refused unsent", async () => {
  // Every reply is cut off at max_tokens, the worst case: billed in full, ledgered, returned as is.
  const usage = { input_tokens: 85_560, output_tokens: ASSIST_MAX_TOKENS };
  const api = await fakeApi(() => ({ json: { content: [{ type: "text", text: "FILE: src/twin/billing.ts\n<<<<<<< SEARCH\nexport" }], stop_reason: "max_tokens", usage } }));
  try {
    const ledger = join(mkdtempSync(join(tmpdir(), "pb-llm-max-")), "llm.jsonl");
    const env = { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: api.url, PARITY_LLM_CAP_USD: "3" };
    // events clock-period-rollover's prompt was 42,780 tokens (~128K chars at 3 a token); twice that is 256K chars.
    const call = (e: Record<string, string> = {}) =>
      complete({ system: "s", user: "u".repeat(255_999), runId: "r", purpose: "assist", maxTokens: ASSIST_MAX_TOKENS, effort: ASSIST_EFFORT }, { ledger, env: { ...env, ...e }, now: NOW });
    // Estimate: 128,000 input tokens at $2/MTok ($0.256) + all 16,000 output tokens at $10/MTok ($0.16): a lower effort
    // thins the thinking but bounds nothing, so the cap still charges max_tokens.
    await assert.rejects(call({ PARITY_LLM_CAP_USD: "0.4" }), (e: unknown) => e instanceof CapRefused && /\$0\.0000 spent today \(UTC\) \+ \$0\.4160 estimated for this call > cap \$0\.4 /.test((e as Error).message));
    assert.equal(api.requests.length, 0);
    // Even billed at the estimate, 6 calls are $2.4960 < $3; the sixth: 5 x $0.33112 = $1.6556 spent + $0.4160 < $3.
    assert.equal(ASSIST_LOCI, 6);
    for (let i = 0; i < ASSIST_LOCI; i++) assert.equal((await call()).stop_reason, "max_tokens");
    assert.deepEqual(api.requests.map((r) => [r.body.max_tokens, r.body.output_config]), Array(ASSIST_LOCI).fill([16_000, { effort: "medium" }]));
    // 6 x (85,560 x $2 + 16,000 x $10) / 1e6.
    assert.equal(readLlmLedger(ledger).reduce((s, e) => s + e.cost_usd, 0).toFixed(4), "1.9867");
    // The headroom: 2 more fit, the ninth would pass the cap (8 x $0.33112 + $0.4160 = $3.0650) and is refused unsent.
    for (let i = 0; i < 2; i++) await call();
    await assert.rejects(call(), (e: unknown) => e instanceof CapRefused && /\$2\.6490 spent today \(UTC\) \+ \$0\.4160 estimated for this call > cap \$3 /.test((e as Error).message));
    assert.equal(api.requests.length, 8);
  } finally {
    api.close();
  }
});

test("parseReply: one FILE line naming a file shown plus SEARCH/REPLACE blocks applied in order, each SEARCH matching exactly once there; else an error", () => {
  const C = "src/twin/resources/customers.ts";
  const shown = [
    { path: C, source: "const a = 1;\nconst b = 2;\nconst a2 = 1;\n" },
    { path: "src/twin/billing.ts", source: "x\nx\nx\n" },
  ];
  // Two blocks, the second matching what the first left; prose and a fence around them are ignored.
  const ok = edits(C, ["const b = 2;\n", "const b = 3;\nconst c = 4;\n"], ["const c = 4;\n", ""]);
  assert.deepEqual(parseReply(`Here:\n\`\`\`\n${ok}\`\`\`\n`, shown), { file: C, content: "const a = 1;\nconst b = 3;\nconst a2 = 1;\n" });
  const err = (text: string) => (parseReply(text, shown) as { error: string }).error;
  assert.equal(err(edits(C, ["const z = 9;\n", "y\n"])), 'block 1: SEARCH matches nothing in src/twin/resources/customers.ts: "const z = 9;\\n"');
  assert.equal(err(edits(C, [" = 1;\n", " = 5;\n"])), 'block 1: SEARCH matches more than one place in src/twin/resources/customers.ts: " = 1;\\n"');
  assert.match(err(edits("src/twin/billing.ts", ["x\nx\n", "y\n"])), /^block 1: SEARCH matches more than one place/, "overlapping matches count");
  assert.match(err(edits(C, ["const b = 2;\n", "const b = 3;\n"], ["const b = 2;\n", "y\n"])), /^block 2: SEARCH matches nothing/, "the first block edited it away");
  assert.equal(err(edits(C, ["", "y\n"])), "block 1: empty SEARCH");
  assert.equal(err(edits(C, [" \n", "y\n"])), "block 1: empty SEARCH");
  assert.equal(err(edits("src/twin/server.ts", ["x\n", "y\n"])), "src/twin/server.ts is not one of the files shown (src/twin/resources/customers.ts, src/twin/billing.ts)");
  assert.equal(err(edits("../../etc/passwd", ["x\n", "y\n"])), "../../etc/passwd is not one of the files shown (src/twin/resources/customers.ts, src/twin/billing.ts)");
  assert.match(err(edits(C, ["const a = 1;\n", "y\n"]) + edits("src/twin/billing.ts", ["x\n", "y\n"])), /got 2 and 2/, "one file per reply");
  assert.match(err(`FILE: ${C}\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`), /got 1 and 0/, "a whole file (the old contract) is no edit");
  assert.match(err(`FILE:\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n`), /got 0 and 1/, "a bare FILE: line names nothing");
  // Stray markers: a block missing its REPLACE line would be swallowed into the next one's replacement (markers written
  // into the file), and an unterminated last block would be dropped (part of the change gated alone).
  const swallowed = `FILE: ${C}\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 9;\n` + edits(C, ["const b = 2;\n", "const b = 3;\n"]).split("\n").slice(1).join("\n");
  assert.equal(err(swallowed), "malformed SEARCH/REPLACE markers: 5 marker lines for 1 complete blocks");
  assert.equal(err(edits(C, ["const b = 2;\n", "const b = 3;\n"]) + "<<<<<<< SEARCH\nconst a = 1;\n=======\n"), "malformed SEARCH/REPLACE markers: 5 marker lines for 1 complete blocks");
  assert.equal(err(edits(C, ["const b = 2;\n", "const b = 3;\n"]) + "<<<<<<< SEARCH\nconst a = 1;\n"), "malformed SEARCH/REPLACE markers: 4 marker lines for 1 complete blocks");
});

test("normalizeWithParams: request paths and params normalized like bodies (0001 C3; params by normalizeRecording itself), test tokens kept, bodies' anchor", () => {
  const T0 = 1_767_225_600;
  const req = (i: number, method: StepRecord["method"], path: string, params?: Record<string, unknown>, body: unknown = {}): StepRecord => ({ i, method, path, params, status: 200, body, resHeaders: {}, ms: 0 });
  const r: Recording = {
    seq: "card-declined#3", template: "card-declined", stratum: "errors", seed: 3, heldOut: false, target: "sandbox", runId: "oracle", startedAt: "2026-01-01T00:00:00.000Z", ms: 0, events: [],
    steps: [
      req(0, "POST", "/v1/customers", { email: `jenny+${runNonce("oracle", "card-declined#3")}@example.com` }, { id: "cus_TESTa1b2c3d4e5", object: "customer", created: T0 }),
      req(1, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: "cus_TESTa1b2c3d4e5" }, { id: "pm_1TESTa1b2c3d4e5" }),
      req(2, "GET", "/v1/customers/cus_TESTa1b2c3d4e5"),
      req(3, "POST", "/v1/subscriptions/sub_1TESTa1b2c3d4e5", { trial_end: T0 + 7200 }),
      req(4, "GET", "/v1/prices/price_1TESTa1b2c3d4e5"),
    ],
  };
  const raw = structuredClone(r);
  const n = normalizeWithParams(r);
  assert.deepEqual(
    n.steps.map((s) => [s.path, s.params]),
    [
      ["/v1/customers", { email: "jenny+<run>@example.com" }],
      ["/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: "<id:cus>" }],
      ["/v1/customers/<id:cus>", undefined],
      ["/v1/subscriptions/<id:sub>", { trial_end: "<t:+2h>" }],
      ["/v1/prices/<id:price>", undefined],
    ],
  );
  assert.deepEqual(n.steps.map((s) => s.body), [{ id: "<id:cus>", object: "customer", created: "<t:~0>" }, { id: "<id:pm>" }, {}, {}, {}]);
  // The brief's C3 grep: no raw object id in any request; the kept test token does not match it either.
  assert.doesNotMatch(JSON.stringify(n.steps.map((s) => [s.path, s.params])), /(cus|sub|pi|ch|price|pm|prod|in|re)_[A-Za-z0-9]{10,}/);
  assert.deepEqual(r, raw, "the input is not mutated");
});

test("assist: a locus whose route no behavior module serves is reported with the counterexample's normalized path, never a raw id (0001 C3), before any LLM call", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pb-assist-no-owner-"));
  const locus: Locus = { kind: "route", route: "GET /v1/unserved/{id}" };
  const rec = (target: string, status: string): Recording => ({
    seq: "unserved#1", template: "unserved", stratum: "lifecycle", seed: 1, heldOut: false, target, runId: "oracle", startedAt: "2026-01-01T00:00:00.000Z", ms: 0, events: [],
    steps: [{ i: 0, method: "GET", path: "/v1/unserved/cus_TESTa1b2c3d4e5?expand[]=customer", status: 200, body: { object: "unserved", status }, resHeaders: {}, ms: 0 }],
  });
  writeJsonl(join(dataDir, "oracle.jsonl"), [rec("sandbox", "a")]);
  const d: Triaged = { seq: "unserved#1", step: 0, path: "$.status", cls: "VALUE_MISMATCH", expected: "a", actual: "b", template: "unserved", heldOut: false, locus };
  // Only what the pass reads before the owner check: the loci, their divergences, the twin's recordings, the oracle's provenance.
  const r = { divergences: [d], notMechanical: [{ locus, reason: "status: decided by handler code", divergences: 1 }], gate: { blocked: [] }, twin: [rec("twin", "b")], oracle: { oracleSeqs: 1, oracleSha: "0".repeat(64) } } as unknown as AlignResult;
  const calls: string[] = [];
  const run: Run = (cmd, args) => (calls.push(`${cmd} ${args[0]}`), ""); // a clean tree, docker available
  const res = await assist(r, { repo: REPO, dataDir, runId: "run-no-owner", env: { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, run, now: NOW });
  assert.deepEqual(res.outcomes.map((o) => [o.result, o.detail, o.cost_usd]), [["no-owner", "no behavior module serves GET /v1/unserved/<id:cus>", 0]]);
  assert.deepEqual(calls, ["git status", "docker run"], "no LLM call, no gate, no PR");
  assert.doesNotMatch(assistText(res), /cus_TEST/);
});

test("assist: a locus whose last 2 attempts under the current reply contract stopped at max_tokens sits out 7 days (sealed log), logged as cooldown with the reason; the next locus takes its slot; an older contract's attempts do not count", async () => {
  const a: Locus = { kind: "route", route: "GET /v1/unserved/{id}" };
  const b: Locus = { kind: "route", route: "GET /v1/unknown/{id}" };
  const step = (i: number, path: string, status: string): StepRecord => ({ i, method: "GET", path, status: 200, body: { object: "unserved", status }, resHeaders: {}, ms: 0 });
  const rec = (target: string, status: string): Recording => ({
    seq: "unserved#1", template: "unserved", stratum: "lifecycle", seed: 1, heldOut: false, target, runId: "oracle", startedAt: "2026-01-01T00:00:00.000Z", ms: 0, events: [],
    steps: [step(0, "/v1/unserved/cus_TESTa1b2c3d4e5", status), step(1, "/v1/unknown/cus_TESTa1b2c3d4e5", status)],
  });
  const d = (step: number, path: string, locus: Locus): Triaged => ({ seq: "unserved#1", step, path, cls: "VALUE_MISMATCH", expected: "a", actual: "b", template: "unserved", heldOut: false, locus });
  const oracle = { oracleSeqs: 1, oracleSha: "0".repeat(64) };
  // a has the most divergences, so it holds the one slot (k = 1) unless it is cooling down.
  const r = {
    divergences: [d(0, "$.status", a), d(0, "$.object", a), d(1, "$.status", b)],
    notMechanical: [
      { locus: a, reason: "status: decided by handler code", divergences: 2 },
      { locus: b, reason: "status: decided by handler code", divergences: 1 },
    ],
    gate: { blocked: [] },
    twin: [rec("twin", "b")],
    oracle,
  } as unknown as AlignResult;
  // a: max_tokens, a cap (no reply: not an attempt), max_tokens. b: max_tokens, then a proposed reply (the streak resets).
  const tried = (locus: string, result: string, detail?: string) => ({ locus, reason: "r", divergences: 1, result, detail, cost_usd: result === "cap" ? 0 : 0.24 });
  // The same history in a data dir per contract: `contract` absent is the full-file contract (1), before 2026-10-04.
  const history = (contract: number | undefined) => {
    const dir = mkdtempSync(join(tmpdir(), "pb-assist-cooldown-"));
    writeJsonl(join(dir, "oracle.jsonl"), [rec("sandbox", "a")]);
    const note = (ts: string, ...outcomes: unknown[]) => appendLog(logPath(dir), "night", [{ kind: "note", data: { assist: { contract, clusters: 2, cost_usd: 0.24, outcomes }, oracle } }], ts);
    note("2026-09-19T13:00:00.000Z", tried("GET /v1/unserved/{id}", "bad-reply", "stop_reason max_tokens"), tried("GET /v1/unknown/{id}", "bad-reply", "stop_reason max_tokens"));
    note("2026-09-20T13:00:00.000Z", tried("GET /v1/unserved/{id}", "cap", "LLM cap: ..."));
    note("2026-09-21T13:00:00.000Z", tried("GET /v1/unserved/{id}", "bad-reply", "stop_reason max_tokens"), tried("GET /v1/unknown/{id}", "proposed"));
    return dir;
  };
  const dataDir = history(CONTRACT);
  const calls: string[] = [];
  const run: Run = (cmd, args) => (calls.push(`${cmd} ${args[0]}`), ""); // a clean tree, docker available
  const env = { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };

  const res = await assist(r, { repo: REPO, dataDir, runId: "run-cool", k: 1, env, run, now: NOW });
  assert.deepEqual(
    res.outcomes.map((o) => [o.locus, o.result, o.cost_usd]),
    [
      ["GET /v1/unserved/{id}", "cooldown", 0],
      ["GET /v1/unknown/{id}", "no-owner", 0],
    ],
  );
  assert.equal(res.outcomes[0]!.detail, "its last 2 attempts were not productive (max_tokens, max_tokens); next try after 2026-09-28T13:00:00.000Z");
  assert.deepEqual(calls, ["git status", "docker run"], "no LLM call");
  assert.match(assistText(res), /^assist: 1 of 2 non-mechanical loci tried/);
  assert.match(assistText(res), /^ {2}cooldown · 2 · GET \/v1\/unserved\/\{id\} · \$0\.0000 · its last 2 attempts were not productive \(max_tokens, max_tokens\)/m);
  const logged = readJsonl<LogEntry>(logPath(dataDir)).at(-1)!.data.assist as AssistResult;
  assert.deepEqual([logged.contract, logged.outcomes.map((o) => o.result)], [CONTRACT, ["cooldown", "no-owner"]]);

  // Seven days after the second: tried again.
  const later = await assist(r, { repo: REPO, dataDir, runId: "run-later", k: 1, env, run, now: () => new Date("2026-09-28T13:00:00.000Z") });
  assert.deepEqual(later.outcomes.map((o) => [o.locus, o.result]), [["GET /v1/unserved/{id}", "no-owner"]]);

  // The same max_tokens history under the full-file contract: the edit contract tries the locus at once.
  const old = await assist(r, { repo: REPO, dataDir: history(undefined), runId: "run-old", k: 1, env, run, now: NOW });
  assert.deepEqual(old.outcomes.map((o) => [o.locus, o.result]), [["GET /v1/unserved/{id}", "no-owner"]]);
});

test("assist: a locus whose sealed-log proposal is still an open align/assisted-* PR (gh pr list, matched by branch and number) is skipped as open-pr; the next locus takes its slot; once the PR is no longer open the locus is tried", async () => {
  const a: Locus = { kind: "route", route: "GET /v1/unserved/{id}" };
  const b: Locus = { kind: "route", route: "GET /v1/unknown/{id}" };
  const step = (i: number, path: string, status: string): StepRecord => ({ i, method: "GET", path, status: 200, body: { object: "unserved", status }, resHeaders: {}, ms: 0 });
  const rec = (target: string, status: string): Recording => ({
    seq: "unserved#1", template: "unserved", stratum: "lifecycle", seed: 1, heldOut: false, target, runId: "oracle", startedAt: "2026-01-01T00:00:00.000Z", ms: 0, events: [],
    steps: [step(0, "/v1/unserved/cus_TESTa1b2c3d4e5", status), step(1, "/v1/unknown/cus_TESTa1b2c3d4e5", status)],
  });
  const d = (step: number, path: string, locus: Locus): Triaged => ({ seq: "unserved#1", step, path, cls: "VALUE_MISMATCH", expected: "a", actual: "b", template: "unserved", heldOut: false, locus });
  const oracle = { oracleSeqs: 1, oracleSha: "0".repeat(64) };
  // a has the most divergences, so it holds the one slot (k = 1) unless its PR is open.
  const r = {
    divergences: [d(0, "$.status", a), d(0, "$.object", a), d(1, "$.status", b)],
    notMechanical: [
      { locus: a, reason: "status: decided by handler code", divergences: 2 },
      { locus: b, reason: "status: decided by handler code", divergences: 1 },
    ],
    gate: { blocked: [] },
    twin: [rec("twin", "b")],
    oracle,
  } as unknown as AlignResult;
  const dataDir = mkdtempSync(join(tmpdir(), "pb-assist-open-pr-"));
  writeJsonl(join(dataDir, "oracle.jsonl"), [rec("sandbox", "a")]);
  const env = { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
  const ghArgs: string[][] = [];
  const withOpen = (open: object[]): Run => (cmd, args) => (cmd === "gh" ? (ghArgs.push(args), JSON.stringify(open)) : ""); // a clean tree, docker available

  // No proposal in the sealed log: gh is not asked.
  await assist(r, { repo: REPO, dataDir, runId: "run-0", k: 1, env, run: withOpen([]), now: NOW });
  assert.equal(ghArgs.length, 0);

  // a was proposed as PR #7; b as PR #5, since closed, whose branch name came back on the open PR #9.
  const proposal = (locus: Locus, branch: string, n: number) => ({ kind: "patch" as const, data: { class: "assisted", status: "proposed", branch, pr: `https://github.com/example/parity/pull/${n}`, locus, oracle } });
  appendLog(logPath(dataDir), "night", [proposal(a, "align/assisted-2026-09-25-1", 7), proposal(b, "align/assisted-2026-09-24-1", 5)]);
  const open = [
    { number: 7, headRefName: "align/assisted-2026-09-25-1" },
    { number: 9, headRefName: "align/assisted-2026-09-24-1" },
    { number: 8, headRefName: "feature/unserved" },
  ];
  const res = await assist(r, { repo: REPO, dataDir, runId: "run-open", k: 1, env, run: withOpen(open), now: NOW });
  assert.deepEqual(ghArgs, [["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "200"]]);
  assert.deepEqual(
    res.outcomes.map((o) => [o.locus, o.result, o.detail, o.cost_usd]),
    [
      ["GET /v1/unserved/{id}", "open-pr", "its proposal https://github.com/example/parity/pull/7 is still open: review it first", 0],
      ["GET /v1/unknown/{id}", "no-owner", "no behavior module serves GET /v1/unknown/<id:cus>", 0],
    ],
  );
  assert.match(assistText(res), /^assist: 1 of 2 non-mechanical loci tried/);
  assert.match(assistText(res), /^ {2}open-pr · 2 · GET \/v1\/unserved\/\{id\} · \$0\.0000 · its proposal https:\/\/github\.com\/example\/parity\/pull\/7 is still open: review it first$/m);
  const logged = readJsonl<LogEntry>(logPath(dataDir)).at(-1)!.data.assist as AssistResult;
  assert.deepEqual(logged.outcomes.map((o) => o.result), ["open-pr", "no-owner"]);

  // PR #7 merged or closed: no longer open, so a is tried again.
  const later = await assist(r, { repo: REPO, dataDir, runId: "run-closed", k: 1, env, run: withOpen(open.slice(1)), now: NOW });
  assert.deepEqual(later.outcomes.map((o) => [o.locus, o.result]), [["GET /v1/unserved/{id}", "no-owner"]]);
});

test("clusters: one per object type and per error key, the most train steps unlocked first (not the most divergences); a fraud/risk field holds its step back", () => {
  const d = (seq: string, step: number, path: string, locus: Locus, heldOut = false): Triaged => ({ seq, step, path, cls: "VALUE_MISMATCH", template: "t", heldOut, locus });
  const card = (f: string): Locus => ({ kind: "field", objectType: "payment_method", fieldPath: `card.${f}` });
  const err = (f: string): Locus => ({ kind: "error", errorKey: "k", field: f });
  const events: Locus = { kind: "events", template: "t", steps: [] };
  const divergences = [
    // Two card fields diverging together at one step: one cluster, which alone unlocks the step, except where a fraud
    // field (never the LLM's to fix) diverges there too.
    ...["a#1", "a#2", "a#3"].flatMap((s) => [d(s, 0, "$.card.x", card("x")), d(s, 0, "$.card.y", card("y"))]),
    d("a#1", 0, "$.card.checks", card("checks")),
    ...["b#1", "b#2"].flatMap((s) => [d(s, 1, "$.error.message", err("message")), d(s, 1, "$.error.advice_code", err("advice_code"))]),
    ...["c#1", "c#2", "c#3", "c#4", "c#5", "c#6", "c#7"].map((s) => d(s, -1, "$", events)), // event loci own no step
    d("h#1", 0, "$.error.message", err("message"), true), // held out: never counted
  ];
  const notMechanical = [card("x"), card("y"), card("checks"), err("message"), err("advice_code"), events].map((locus) => ({ locus, reason: "r", divergences: 0 }));
  const order = clusters({ divergences, notMechanical, gate: { blocked: [] } as unknown as AlignResult["gate"] });
  assert.deepEqual(order.map((c) => [c.locus, c.steps, c.divergences.length]), [
    [card("x, card.y"), 2, 6],
    [err("advice_code, message"), 2, 4],
    [events, 0, 7],
  ]);
});

test("cooldowns: any 2 consecutive non-productive attempts (bad-reply of any kind, gate-failed) under the current contract cool a locus 7 days, with the reason; a proposed one resets the streak; older contracts' entries are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-assist-cooldowns-"));
  const oracle = { oracleSeqs: 1, oracleSha: "0".repeat(64) };
  const note = (contract: number | undefined, ts: string, ...outcomes: [string, string, string?][]) =>
    appendLog(logPath(dir), "night", [{ kind: "note", data: { assist: { contract, clusters: 9, cost_usd: 0, outcomes: outcomes.map(([locus, result, detail]) => ({ locus, reason: "r", divergences: 1, result, detail, cost_usd: 0.2 })) }, oracle } }], ts);
  const GATE = "train divergences 3 -> 3; held-out L3 10.0% -> 10.0%";
  // `contract` absent is the full-file contract (1).
  note(undefined, "2026-09-19T13:00:00.000Z", ["old", "gate-failed", GATE], ["mixed-contract", "gate-failed", GATE]);
  note(1, "2026-09-20T13:00:00.000Z", ["old", "gate-failed", GATE]);
  note(CONTRACT, "2026-09-21T13:00:00.000Z", ["gates", "gate-failed", GATE], ["reset", "gate-failed", GATE], ["mixed", "bad-reply", "stop_reason max_tokens"], ["replies", "bad-reply", "block 1: empty SEARCH"],
    ["capped", "gate-failed", GATE], ["mixed-contract", "gate-failed", GATE], ["once", "proposed"], ["pr", "gate-failed", GATE]);
  // A cap got no reply (not an attempt); a pr-failed reply passed the gate (productive).
  note(CONTRACT, "2026-09-22T13:00:00.000Z", ["capped", "cap", "LLM cap: ..."], ["pr", "pr-failed", "gh: ..."]);
  note(CONTRACT, "2026-09-23T13:00:00.000Z", ["gates", "gate-failed", GATE], ["reset", "proposed"], ["mixed", "gate-failed", GATE], ["replies", "bad-reply", "stop_reason max_tokens"],
    ["capped", "gate-failed", GATE], ["once", "gate-failed", GATE]);
  const why = (reasons: string) => `its last 2 attempts were not productive (${reasons}); next try after 2026-09-30T13:00:00.000Z`;
  assert.deepEqual(Object.fromEntries(cooldowns(logPath(dir), NOW())), {
    gates: why("gate-failed, gate-failed"),
    mixed: why("max_tokens, gate-failed"),
    replies: why("bad-reply, max_tokens"),
    capped: why("gate-failed, gate-failed"),
  });
  // 7 days after the newer attempt, every locus is tried again.
  assert.equal(cooldowns(logPath(dir), new Date("2026-09-30T13:00:00.000Z")).size, 0);
});

test("assist end to end: a code-only divergence goes to the LLM (train only), a reply passing the gate becomes a pushed branch and a draft PR; a failing one opens nothing", { timeout: 120_000 }, async () => {
  // Oracle: every customer's description set to its name: a per-sequence value no data file can seed, so only code can
  // fix it.
  const oracle = await twinOracle((o) => (o.object === "customer" && !o.deleted ? { ...o, description: o.name ?? null } : o));
  // Fraud and risk fields (0001 R8) in a train response, as a field and nested in another field's value: they must reach
  // neither the prompt nor the PR. Train only: in the held-out customers they would block the L3 match below.
  const RISK = "RISKMARK";
  Object.assign(oracle.find((r) => r.seq === "customer-crud#1")!.steps[0]!.body as object, {
    outcome: { type: "authorized", risk_level: RISK, seller_message: RISK },
    payment: { card: { brand: "visa", checks: { cvc_check: RISK } } },
  });
  // Request params holding real-looking ids and a run-nonce email (PR #3's did): the prompt and the PR show them
  // normalized like bodies (0001 C3). Params are not scored.
  const NONCE = runNonce("oracle", "customer-crud#1");
  Object.assign(oracle.find((r) => r.seq === "customer-crud#1")!.steps[0]!.params!, {
    email: `jenny+${NONCE}@example.com`,
    metadata: { parity: "customer-crud", referred_by: "cus_TESTa1b2c3d4e5", plan: "price_1TESTa1b2c3d4e5" },
    payment_method: "pm_1TESTa1b2c3d4e5",
    invoice_settings: { default_payment_method: "pm_1TESTa1b2c3d4e5" },
  });
  const data = mkdtempSync(join(tmpdir(), "pb-assist-data-"));
  writeJsonl(join(data, "oracle.jsonl"), oracle);

  const { repo, git, head } = gitRepo();

  const plan = align({ repo, dataDir: data, runId: "plan" });
  const nm = plan.notMechanical.find((n) => n.locus.kind === "field" && n.locus.objectType === "customer" && n.locus.fieldPath === "description");
  assert.ok(nm, "the description locus is not mechanical");
  assert.equal(plan.gate.accepted.length, 0);

  const FILE = "src/twin/resources/customers.ts";
  const original = readFileSync(join(repo, FILE), "utf8");
  const fixed = original
    .replace("      return { body: c, emits: [{ type: \"customer.created\", object: c }] };", "      c.description = c.name;\n      return { body: c, emits: [{ type: \"customer.created\", object: c }] };")
    .replace("const after = assign(structuredClone(before), params, FIELDS);", "const after = assign(structuredClone(before), params, FIELDS);\n      after.description = after.name;");
  assert.notEqual(fixed, original);
  // The same change as edit blocks (each line occurs once in the file), a comment-only change, and the fix again.
  const RET = '      return { body: c, emits: [{ type: "customer.created", object: c }] };\n';
  const AFTER = "const after = assign(structuredClone(before), params, FIELDS);\n";
  const fix = edits(FILE, [RET, "      c.description = c.name;\n" + RET], [AFTER, AFTER + "      after.description = after.name;\n"]);
  const replies = [fix, edits(FILE, [RET, "      // a comment changes nothing\n" + RET]), fix];
  // The fourth request is cut off at the assist max_tokens (2026-09-28's clock-period-rollover prompt size); the fifth's
  // SEARCH is not in the file.
  const truncated = { json: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: `FILE: ${FILE}\n<<<<<<< SEARCH\nimport` }], stop_reason: "max_tokens", usage: { input_tokens: 42_780, output_tokens: 16_000 } } };
  replies[4] = edits(FILE, ["      c.description = null;\n", "      c.description = c.name;\n"]);
  const api = await fakeApi((n) => (n === 3 ? truncated : message(replies[n]!)));
  const gh: string[][] = [];
  // docker: the fake runs the container's command on the host and records its argv (a real run: test/align-gate.test.ts).
  const dockerCalls: string[][] = [];
  const docker = fakeDocker(dockerCalls);
  // gh: no open PR (the open-pr skip has its own test); `gh` records the PRs created.
  const run: Run = (cmd, args, cwd) => (cmd === "gh" ? (args[1] === "list" ? "[]" : (gh.push(args), "https://github.com/example/parity/pull/7")) : cmd === "docker" ? docker(args) : sh(cmd, args, cwd));
  const env = { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: api.url };
  try {
    const ok = await assist(plan, { repo, dataDir: data, runId: "assist-1", env, run, now: NOW });
    assert.equal(api.requests.length, 1, "one non-mechanical locus, one call");
    const [o] = ok.outcomes;
    assert.deepEqual([o!.result, o!.file, o!.seq, o!.pr, o!.branch], ["proposed", FILE, "customer-crud#1", "https://github.com/example/parity/pull/7", "align/assisted-2026-09-26-1"]);
    assert.ok(o!.gate!.after.trainDivergences < o!.gate!.before.trainDivergences);
    assert.ok(o!.gate!.after.heldOut.L3.k > o!.gate!.before.heldOut.L3.k, "the held-out customers match too");
    assert.match(assistText(ok), /^ {2}proposed · \d+ · customer description · src\/twin\/resources\/customers\.ts · \$0\.0070 · https:\/\/github\.com\/example\/parity\/pull\/7$/m);
    // The LLM's file was scored only in the container: first a start check of the pinned image, then score-twin there,
    // with the twin's recordings for the mechanical pass on top of it (which proposes nothing here: no gate run).
    assert.deepEqual(dockerCalls[0], ["run", "--rm", "--network", "none", nodeImage(), "node", "--version"]);
    assert.equal(dockerCalls.length, 2);
    assert.deepEqual(dockerCalls[1]!.slice(0, 4), ["run", "--rm", "--network", "none"]);
    assert.deepEqual(dockerCalls[1]!.slice(dockerCalls[1]!.indexOf(nodeImage())), [nodeImage(), "node", "src/cli.ts", "score-twin", "--oracle", "/oracle.jsonl", "--json", "/out/score.json", "--recordings", "/out/twin.jsonl"]);
    assert.equal(o!.paired, undefined, "no data edit to pair");

    // The prompt: the owning module, a train counterexample truncated after its first divergent step, the clean-room
    // rule; nothing from held-out sequences.
    const sent = api.requests[0]!.body as { system: string; messages: { content: string }[]; max_tokens: number; output_config: unknown };
    const user = sent.messages[0]!.content;
    assert.equal(sent.max_tokens, 16_000);
    assert.deepEqual(sent.output_config, { effort: "medium" }, "the thinking is held to effort medium");
    assert.match(sent.system, /Clean room: write original code/);
    assert.match(sent.system, /^<<<<<<< SEARCH\n<lines copied exactly from the current file, whitespace included>\n=======\n<the lines that replace them>\n>>>>>>> REPLACE\nEach SEARCH must match exactly one place in the file/m);
    assert.match(user, /^## Task\nReply with SEARCH\/REPLACE edits to exactly one of: src\/twin\/resources\/customers\.ts, /m);
    assert.ok(user.includes(`### ${FILE}\n\`\`\`ts\n${original}\`\`\``));
    assert.match(user, /^## Counterexample \(normalized\): customer-crud#1, steps 0\.\.0 of 6$/m);
    assert.match(user, /^\* step 0 \$\.description VALUE_MISMATCH expected "Parity \d+" actual null$/m);
    // The legend: <opaque> on card fields is a value of the right kind (PR #9-#12 reviews), not any value.
    assert.ok(
      user.includes(
        "On card fields <opaque> means a value of the right kind, not any value: fingerprint must be stable per card number (the same card number gives the same fingerprint within an account), and exp_month/exp_year must be a plausible card expiry derived from the twin's clock, never random numbers or ids.",
      ),
    );
    assert.ok(!user.includes("subscription-cancel-at-period-end") && !user.includes("templates-validation"));

    // One draft PR carrying the counterexample, scores and cost; the branch holds only the replaced file and is pushed.
    assert.equal(gh.length, 1);
    const [args] = gh;
    assert.deepEqual(args!.slice(0, 5), ["pr", "create", "--draft", "--head", "align/assisted-2026-09-26-1"]);
    const body = args![args!.indexOf("--body") + 1]!;
    for (const s of ["**Draft: merge only after review**", "- Before: train L1", "- After: train L1", "cost_usd 0.0070", "## Counterexample (normalized): customer-crud#1", "decision 0001 C3"]) assert.ok(body.includes(s), s);
    const ce = user.slice(user.indexOf("## Counterexample"));
    for (const text of [ce, body]) {
      assert.ok(!text.includes(RISK) && !/outcome|checks|risk_level|seller_message|cvc_check/.test(text), "no fraud or risk field, key or value");
      assert.match(text, /^- step 0 \$\.payment MISSING_FIELD expected \{"card":\{"brand":"visa"\}\} actual undefined$/m);
      assert.match(
        text,
        /^params: \{"email":"jenny\+<run>@example\.com","name":"Parity \d+","metadata":\{"parity":"customer-crud","referred_by":"<id:cus>","plan":"<id:price>"\},"payment_method":"<id:pm>","invoice_settings":\{"default_payment_method":"<id:pm>"\}\}$/m,
      );
      assert.doesNotMatch(text, /(cus|sub|pi|ch|price|pm|prod|in|re)_[A-Za-z0-9]{10,}/, "no raw object id");
      assert.ok(!text.includes(NONCE), "no run nonce");
    }
    assert.ok(!gh.flat().includes("merge"), "never merges");
    assert.equal(git("rev-parse", "HEAD"), head, "the main working tree stays on HEAD");
    assert.equal(git("status", "--porcelain"), "", "the repo is untouched: the LLM ledger is in the data dir");
    assert.equal(readLlmLedger(join(data, "budget/llm.jsonl")).length, 1);
    assert.equal(git("worktree", "list").split("\n").length, 1, "the worktree is removed");
    assert.equal(git("diff", "--name-only", head, "align/assisted-2026-09-26-1"), FILE);
    assert.equal(git("show", `align/assisted-2026-09-26-1:${FILE}`) + "\n", fixed);
    assert.match(git("log", "-1", "--format=%B", "align/assisted-2026-09-26-1"), /^align: assisted patch to src\/twin\/resources\/customers\.ts \(customer description\)\n\nProposed by claude-sonnet-5 from train sequence customer-crud#1/);
    assert.ok(!git("log", "-1", "--format=%B", "align/assisted-2026-09-26-1").includes("Parity "), "no response values in the commit");
    assert.match(git("ls-remote", "--heads", "origin"), /refs\/heads\/align\/assisted-2026-09-26-1$/m);

    // A reply that changes nothing: the gate runs and fails, no branch, no PR; the call is still ledgered.
    const bad = await assist(plan, { repo, dataDir: data, runId: "assist-2", env, run, now: NOW });
    assert.deepEqual([bad.outcomes[0]!.result, bad.outcomes[0]!.gate?.after.trainDivergences], ["gate-failed", plan.baseline.trainDivergences]);
    assert.equal(gh.length, 1, "no PR when the gate fails");
    assert.equal(git("branch", "--list", "align/*"), "align/assisted-2026-09-26-1");
    assert.equal(readLlmLedger(join(data, "budget/llm.jsonl")).length, 2);

    // No key: skipped and logged, nothing sent.
    const none = await assist(plan, { repo, dataDir: data, runId: "assist-3", env: {}, run, now: NOW });
    assert.equal(none.skipped, "ANTHROPIC_API_KEY is not set: no LLM call, assisted pass skipped");
    assert.equal(api.requests.length, 2);

    // At the cap: the loop stops before anything is sent, and the run's note records it.
    const capped = await assist(plan, { repo, dataDir: data, runId: "assist-4", env: { ...env, PARITY_LLM_CAP_USD: "0" }, run, now: NOW });
    assert.deepEqual([capped.outcomes.length, capped.outcomes[0]!.result, capped.cost_usd], [1, "cap", 0]);
    assert.match(capped.outcomes[0]!.detail!, /> cap \$0 /);
    // The estimate charges the whole assist max_tokens (16,000) as output, on the same prompt as assist-1.
    const estimate = costUsd("claude-sonnet-5", { input_tokens: Math.ceil((sent.system.length + user.length) / 2), output_tokens: 16_000 });
    assert.ok(capped.outcomes[0]!.detail!.includes(`+ $${estimate.toFixed(4)} estimated for this call`), capped.outcomes[0]!.detail);
    assert.equal(api.requests.length, 2);

    // No docker (or the pinned image does not start): refused before any LLM call, logged, no PR. LLM-written code
    // never runs outside the container.
    const noDocker: Run = (cmd, args, cwd) => {
      if (cmd === "docker") throw Object.assign(new Error("Command failed: docker run"), { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n" });
      return run(cmd, args, cwd);
    };
    const refused = await assist(plan, { repo, dataDir: data, runId: "assist-6", env, run: noDocker, now: NOW });
    assert.deepEqual([refused.skipped, refused.outcomes, refused.cost_usd], ["refused: docker cannot run the pinned node image (Cannot connect to the Docker daemon at unix:///var/run/docker.sock.); LLM-written code never runs outside its container", [], 0]);
    assert.equal(api.requests.length, 2, "no LLM call");
    assert.equal(gh.length, 1, "no PR");
    assert.match(assistText(refused), /^assist: refused: docker cannot run the pinned node image/);

    // gh refuses the PR (the repo does not let GitHub Actions create pull requests): pr-failed, and the branch it
    // pushed is deleted again, on origin and here.
    const refuse: Run = (cmd, args, cwd) => {
      if (cmd === "gh" && args[1] === "create") throw new Error("gh: GitHub Actions is not permitted to create or approve pull requests");
      if (cmd === "gh") return "[]";
      return cmd === "docker" ? docker(args) : sh(cmd, args, cwd);
    };
    const denied = await assist(plan, { repo, dataDir: data, runId: "assist-5", env, run: refuse, now: NOW });
    assert.deepEqual([denied.outcomes[0]!.result, denied.outcomes[0]!.branch], ["pr-failed", undefined]);
    assert.match(denied.outcomes[0]!.detail!, /not permitted to create/);
    assert.doesNotMatch(git("ls-remote", "--heads", "origin"), /assisted-2026-09-26-2/);
    assert.equal(git("branch", "--list", "align/*"), "align/assisted-2026-09-26-1");

    // A reply cut off at max_tokens: a bad-reply carrying its cost and ledgered, never sent again in the run and never
    // scored.
    const scored = dockerCalls.filter((a) => a.includes("score-twin")).length;
    const cut = await assist(plan, { repo, dataDir: data, runId: "assist-7", env, run, now: NOW });
    assert.deepEqual(cut.outcomes.map((x) => [x.result, x.detail, x.cost_usd]), [["bad-reply", "stop_reason max_tokens", 0.24556]]); // (42,780 x $2 + 16,000 x $10) / 1e6
    assert.equal(cut.cost_usd, 0.24556);
    assert.equal(api.requests.length, 4, "sent once");
    assert.equal(dockerCalls.filter((a) => a.includes("score-twin")).length, scored);
    const last = readLlmLedger(join(data, "budget/llm.jsonl")).at(-1)!;
    assert.deepEqual([last.purpose, last.stop_reason, last.cost_usd], ["assist customer description", "max_tokens", 0.24556]);
    assert.match(assistText(cut), /^ {2}bad-reply · \d+ · customer description · \$0\.2456 · stop_reason max_tokens$/m);
    assert.equal(gh.length, 1, "no PR");

    // A SEARCH that is not in the file: a bad-reply naming it, ledgered, never scored, no PR.
    const missed = await assist(plan, { repo, dataDir: data, runId: "assist-8", env, run, now: NOW });
    assert.deepEqual(missed.outcomes.map((x) => [x.result, x.detail, x.cost_usd]), [["bad-reply", 'block 1: SEARCH matches nothing in src/twin/resources/customers.ts: "      c.description = null;\\n"', 0.007]]);
    assert.equal(api.requests.length, 5);
    assert.equal(dockerCalls.filter((a) => a.includes("score-twin")).length, scored);
    assert.equal(gh.length, 1, "no PR");

    const log = readJsonl<LogEntry>(logPath(data));
    assert.deepEqual(verifyLog(logPath(data)), { ok: true, entries: 9 });
    assert.deepEqual(log.map((e) => [e.kind, e.runId, e.data.class, e.data.status]), [
      ["patch", "assist-1", "assisted", "proposed"],
      ["note", "assist-1", undefined, undefined],
      ["note", "assist-2", undefined, undefined],
      ["note", "assist-3", undefined, undefined],
      ["note", "assist-4", undefined, undefined],
      ["note", "assist-6", undefined, undefined],
      ["note", "assist-5", undefined, undefined],
      ["note", "assist-7", undefined, undefined],
      ["note", "assist-8", undefined, undefined],
    ]);
    assert.deepEqual((log[7]!.data.assist as AssistResult).outcomes.map((x) => [x.result, x.cost_usd]), [["bad-reply", 0.24556]]);
    assert.equal((log[5]!.data.assist as { skipped: string }).skipped, refused.skipped);
    assert.deepEqual([log[0]!.data.pr, log[0]!.data.branch, log[0]!.data.file], ["https://github.com/example/parity/pull/7", "align/assisted-2026-09-26-1", FILE]);
    assert.deepEqual((log[3]!.data.assist as { skipped?: string }).skipped, none.skipped);
  } finally {
    api.close();
  }

  // The CLI: --assist without a key prints the skip and logs it; --apply with --assist is a usage error.
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(REPO, "src/cli.ts"), "align", ...args], { cwd: data, env: { ...process.env, PARITY_DATA_DIR: data, ANTHROPIC_API_KEY: "" }, encoding: "utf8" });
  assert.equal(cli("--apply", "--assist").status, 2);
  const viaCli = cli("--assist");
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.match(viaCli.stdout, /^assist: ANTHROPIC_API_KEY is not set: no LLM call, assisted pass skipped \(1 non-mechanical loci waiting\)$/m);
  assert.equal(readJsonl<LogEntry>(logPath(data)).at(-1)!.kind, "note");
});

test("assist pairing: a code change the gate rejects alone passes with the data edits the mechanical pass makes on top of it: one PR, two commits, each logged in its class; held-out never feeds a candidate", { timeout: 120_000 }, async () => {
  // Oracle: every customer carries a cash_balance, which the twin never emits (it holds the customer's id: only code can
  // build it). Its settings.reconciliation_mode is "manual" in train and "merchant_default" in held-out; the template
  // says "automatic". Built from the template (PR #4's shape), the object removes one divergence per customer and
  // exposes one: train does not fall, so the gate alone rejects the honest change.
  const tpl = JSON.parse(readFileSync(join(REPO, "src/twin/shapes/cash_balance.json"), "utf8"));
  assert.equal(tpl.settings.reconciliation_mode, "automatic");
  const oracle = await twinOracle((o, heldOut) =>
    o.object === "customer" && !o.deleted ? { ...o, cash_balance: { ...tpl, customer: o.id, settings: { ...tpl.settings, reconciliation_mode: heldOut ? "merchant_default" : "manual" } } } : o,
  );
  const data = mkdtempSync(join(tmpdir(), "pb-assist-pair-data-"));
  writeJsonl(join(data, "oracle.jsonl"), oracle);
  const heldOut = new Set(oracle.filter((r) => r.heldOut).map((r) => r.seq));
  assert.ok(heldOut.size && heldOut.size < oracle.length);
  const { repo, git, head } = gitRepo();

  const plan = align({ repo, dataDir: data, runId: "plan" });
  assert.deepEqual(
    plan.notMechanical.map((n) => [n.locus, n.reason]),
    [[{ kind: "field", objectType: "customer", fieldPath: "cash_balance" }, "computed: the value holds a normalization placeholder"]],
  );
  assert.deepEqual([plan.candidates, plan.baseline.trainDivergences > 0], [[], true]);

  const FILE = "src/twin/resources/customers.ts";
  const original = readFileSync(join(repo, FILE), "utf8");
  const RET = '      return { body: c, emits: [{ type: "customer.created", object: c }] };';
  const fixed = original.replace(RET, '      c.cash_balance = ctx.build("cash_balance", { customer: c.id });\n' + RET);
  assert.notEqual(fixed, original);
  const api = await fakeApi(() => message(edits(FILE, [RET + "\n", '      c.cash_balance = ctx.build("cash_balance", { customer: c.id });\n' + RET + "\n"])));
  const gh: string[][] = [];
  const dockerCalls: string[][] = [];
  const docker = fakeDocker(dockerCalls);
  const run: Run = (cmd, args, cwd) => (cmd === "gh" ? (args[1] === "list" ? "[]" : (gh.push(args), "https://github.com/example/parity/pull/8")) : cmd === "docker" ? docker(args) : sh(cmd, args, cwd));
  try {
    const res = await assist(plan, { repo, dataDir: data, runId: "assist-pair", env: { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: api.url }, run, now: NOW });
    const [o] = res.outcomes;
    const n = plan.baseline.trainDivergences;
    // Alone: n -> n (one divergence per customer removed, one exposed). With the paired data edit: n -> 0.
    assert.deepEqual([o!.result, o!.gate!.before.trainDivergences, o!.gate!.after.trainDivergences, o!.paired?.edits, o!.paired?.after.trainDivergences], ["proposed", n, n, 1, 0]);
    assert.ok(o!.paired!.after.heldOut.L3.k >= o!.gate!.before.heldOut.L3.k);
    assert.match(assistText(res), /^ {2}proposed · \d+ · customer cash_balance · src\/twin\/resources\/customers\.ts \+ 1 paired data edits · \$0\.0070 · https:\/\/github\.com\/example\/parity\/pull\/8$/m);
    // The prompt steers the model to template builders.
    assert.match((api.requests[0]!.body as { system: string }).system, /^4\. Build every API object you add or return, nested ones too, with `ctx\.build\(type, computed\)`.*a mechanical pass fixes the templates' field values/m);
    // Every score of the LLM's code ran in the container: the start check, the code change with recordings, one data batch.
    assert.deepEqual(dockerCalls.map((a) => [a.slice(0, 4).join(" "), a.includes("score-twin"), a.includes("--recordings")]), [["run --rm --network none", false, false], ["run --rm --network none", true, true], ["run --rm --network none", true, false]]);

    // One draft PR; its branch holds two commits: the code change, then the data edit.
    const branch = "align/assisted-2026-09-26-1";
    assert.equal(gh.length, 1);
    assert.ok(!gh.flat().includes("merge"), "never merges");
    assert.equal(git("rev-list", "--count", `${head}..${branch}`), "2");
    assert.equal(git("diff", "--name-only", head, `${branch}~1`), FILE);
    assert.equal(git("show", `${branch}~1:${FILE}`) + "\n", fixed);
    assert.equal(git("diff", "--name-only", `${branch}~1`, branch), "src/twin/shapes/cash_balance.json");
    assert.deepEqual(JSON.parse(git("show", `${branch}:src/twin/shapes/cash_balance.json`)), { ...tpl, settings: { ...tpl.settings, reconciliation_mode: "manual" } });
    const [codeMsg, dataMsg] = [git("log", "-1", "--format=%B", `${branch}~1`), git("log", "-1", "--format=%B", branch)];
    assert.match(codeMsg, new RegExp(`^align: assisted patch to src/twin/resources/customers\\.ts \\(customer cash_balance\\)\\n\\n[^]*Gate: train divergences ${n} -> ${n} \\(the code change\\) -> 0 \\(with 1 paired data edits\\);`));
    assert.match(dataMsg, new RegExp(`^align: 1 automatic patches paired with the assisted patch to src/twin/resources/customers\\.ts \\(customer cash_balance\\)\\n\\n[^]*train divergences ${n} -> 0;`));
    for (const m of [codeMsg, dataMsg]) assert.ok(!m.includes("manual"), "no response values in the commits");
    assert.match(git("ls-remote", "--heads", "origin"), /refs\/heads\/align\/assisted-2026-09-26-1$/m);
    assert.deepEqual([git("rev-parse", "HEAD"), git("status", "--porcelain"), git("worktree", "list").split("\n").length], [head, "", 1]);
    const body = gh[0]![gh[0]!.indexOf("--body") + 1]!;
    assert.match(body, /^- After the code change \(commit 1, class `assisted`\): train L1 /m);
    assert.match(body, /^- After its 1 paired data edits \(commit 2, class `automatic`: [^)]*\): train L1 [^\n]*\n {2}- src\/twin\/shapes\/cash_balance\.json \/settings\/reconciliation_mode set "manual" · \d+ divergences/m);

    // The sealed log: the code change as assisted, scored after it alone (the divergences it removed: n - n = 0), and
    // the data edit as automatic, gated from that intermediate score (n - 0); both proposed until the PR merges.
    const log = readJsonl<LogEntry>(logPath(data));
    assert.deepEqual(verifyLog(logPath(data)), { ok: true, entries: 3 });
    assert.deepEqual(log.map((e) => [e.kind, e.data.class, e.data.status, e.data.branch, e.data.commit]), [
      ["patch", "assisted", "proposed", branch, git("rev-parse", `${branch}~1`)],
      ["patch", "automatic", "proposed", branch, git("rev-parse", branch)],
      ["note", undefined, undefined, undefined, undefined],
    ]);
    const [assisted, automatic] = log as [LogEntry & { data: { gate: { before: Scores; after: Scores } } }, LogEntry & { data: { gate: { before: Scores; after: Scores }; evidence: { seqs: string[] } } }];
    assert.deepEqual([assisted.data.gate.before.trainDivergences, assisted.data.gate.after.trainDivergences], [n, n]);
    assert.deepEqual([automatic.data.gate.before.trainDivergences, automatic.data.gate.after.trainDivergences], [n, 0]);
    assert.deepEqual([assisted.data.pr, automatic.data.pr, assisted.data.file], ["https://github.com/example/parity/pull/8", "https://github.com/example/parity/pull/8", FILE]);
    assert.deepEqual(automatic.data.edit, { file: "src/twin/shapes/cash_balance.json", pointer: "/settings/reconciliation_mode", op: "set", value: "manual" });
    assert.deepEqual(automatic.data.locus, { kind: "field", objectType: "cash_balance", fieldPath: "settings.reconciliation_mode" });
    // Held-out never feeds a candidate: the value is train's although held-out shows another (read, it would vary and
    // nothing would pass), and the evidence names train sequences only.
    assert.ok(automatic.data.evidence.seqs.length && automatic.data.evidence.seqs.every((s) => !heldOut.has(s)), automatic.data.evidence.seqs.join());

    // The plan's own edits are never paired (gatePaired `stale`, fake scores in align-gate.test.ts). The wiring: a plan
    // (synthesized here) that already accepted this very data edit on HEAD without applying it leaves the change alone,
    // n -> n, and it fails with no data batch scored and no second PR.
    const edit = automatic.data.edit as { file: string; pointer: string; op: "set"; value: unknown };
    const stale: Judged = { candidate: { ...edit, locus: automatic.data.locus as Locus, evidence: { occurrences: 1, seqs: [] }, ids: [] }, before: plan.gate.before, after: plan.gate.after };
    const calls = dockerCalls.length;
    const again = await assist({ ...plan, gate: { ...plan.gate, accepted: [stale] } }, { repo, dataDir: data, runId: "assist-stale", env: { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: api.url }, run, now: NOW });
    assert.deepEqual([again.outcomes[0]!.result, again.outcomes[0]!.paired, gh.length, dockerCalls.length - calls], ["gate-failed", undefined, 1, 2]);
    assert.match(again.outcomes[0]!.detail!, new RegExp(`^train divergences ${n} -> ${n}; held-out L3 `));
  } finally {
    api.close();
  }
});
