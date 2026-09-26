import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { assist, assistText, parseReply, sh, type Run } from "../src/align/assist.ts";
import { align } from "../src/align/index.ts";
import { CapRefused, capUsd, complete, costUsd, readLlmLedger, type LlmEntry } from "../src/align/llm.ts";
import { logPath, verifyLog, type LogEntry } from "../src/align/log.ts";
import { buildCorpus } from "../src/bench/corpus.ts";
import { idsIn, runCorpus, touching } from "../src/bench/run.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { createTwin } from "../src/twin/server.ts";

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

test("llm: cost from usage, one ledger line per call, text blocks only, temperature 0 only where the model accepts it", async () => {
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
    await complete({ system: "s", user: "u", runId: "run-1", purpose: "test" }, { ledger, env: { ...env, PARITY_LLM_MODEL: "claude-haiku-4-5" }, now: NOW });
    assert.equal(api.requests[1]!.body.temperature, 0);
    assert.equal(readLlmLedger(ledger).length, 2);
    await assert.rejects(complete({ system: "s", user: "u", runId: "r", purpose: "p" }, { ledger, env: { ...env, PARITY_LLM_MODEL: "claude-unknown" } }), /no price for model "claude-unknown"/);
    assert.throws(() => costUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 }), /no price/);
    assert.equal(api.requests.length, 2, "an unpriced model is refused before sending");
  } finally {
    api.close();
  }
});

test("llm: the daily cap ($15, lowered only) refuses before sending; yesterday does not count; HTTP errors are redacted and not ledgered", async () => {
  assert.deepEqual([capUsd({}), capUsd({ PARITY_LLM_CAP_USD: "3" }), capUsd({ PARITY_LLM_CAP_USD: "40" })], [15, 3, 15]);
  assert.throws(() => capUsd({ PARITY_LLM_CAP_USD: "lots" }), /non-negative number/);
  const api = await fakeApi((n) => (n === 1 ? { status: 529, json: { error: { message: "overloaded for key sk-ant-secret" } } } : message("ok")));
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
    assert.equal(api.requests.length, 2);
    assert.deepEqual(readLlmLedger(ledger).map((e) => e.date.slice(0, 10)), ["2026-09-25", "2026-09-26"], "only the call that returned usage is ledgered");
  } finally {
    api.close();
  }
});

test("parseReply: one FILE line naming a file shown plus one fenced block, else an error", () => {
  const allowed = ["src/twin/resources/customers.ts", "src/twin/billing.ts"];
  assert.deepEqual(parseReply("Here:\nFILE: src/twin/billing.ts\n```ts\nexport const x = 1;\n```\n", allowed), { file: "src/twin/billing.ts", content: "export const x = 1;\n" });
  assert.deepEqual(parseReply("FILE: src/twin/server.ts\n```ts\nx\n```", allowed), { error: "src/twin/server.ts is not one of the files shown (src/twin/resources/customers.ts, src/twin/billing.ts)" });
  assert.deepEqual(parseReply("FILE: ../../etc/passwd\n```\nx\n```", allowed), { error: "../../etc/passwd is not one of the files shown (src/twin/resources/customers.ts, src/twin/billing.ts)" });
  assert.match((parseReply("FILE: src/twin/billing.ts\nFILE: src/twin/resources/customers.ts\n```ts\nx\n```\n```ts\ny\n```", allowed) as { error: string }).error, /got 2 and 2/);
  assert.match((parseReply("FILE: src/twin/billing.ts\nno fence", allowed) as { error: string }).error, /got 1 and 0/);
  assert.deepEqual(parseReply("FILE: src/twin/billing.ts\n```ts\n  \n```", allowed), { error: "empty file" });
});

test("assist end to end: a code-only divergence goes to the LLM (train only), a reply passing the gate becomes a pushed branch and a draft PR; a failing one opens nothing", { timeout: 120_000 }, async () => {
  // Oracle: the twin's own recording of customer-crud (train) and subscription-cancel-at-period-end (held out), with
  // every customer's description set to its name: a per-sequence value no data file can seed, so only code can fix it.
  const CLOCK = "2026-03-01T00:00:00.000Z";
  const seqs = buildCorpus(TEMPLATES.filter((t) => ["customer-crud", "subscription-cancel-at-period-end"].includes(t.name)), [1, 2]);
  const twin = createTwin();
  const server = await twin.listen(0);
  const target = { name: "sandbox", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
  const { recordings } = await runCorpus(seqs, target, { concurrency: 2, runId: "oracle", headersFor: () => ({ "Parity-Now": String(Date.parse(CLOCK) / 1000) }) }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  const described = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(described);
    if (!v || typeof v !== "object") return v;
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, described(x)]));
    return o.object === "customer" && !o.deleted ? { ...o, description: o.name ?? null } : o;
  };
  const oracle = recordings.map((r) => ({ ...r, startedAt: CLOCK, events: touching(idsIn(r.steps), twin.store.events), steps: r.steps.map((s) => ({ ...s, body: described(s.body) })) }));
  const data = mkdtempSync(join(tmpdir(), "pb-assist-data-"));
  writeJsonl(join(data, "oracle.jsonl"), oracle);

  // A git repo copy of the twin with a bare origin to push to.
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
  const head = git("rev-parse", "HEAD");

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
  const replies = [`FILE: ${FILE}\n\`\`\`ts\n${fixed}\`\`\`\n`, `FILE: ${FILE}\n\`\`\`ts\n${original}// a comment changes nothing\n\`\`\`\n`];
  const api = await fakeApi((n) => message(replies[n]!));
  const gh: string[][] = [];
  const run: Run = (cmd, args, cwd) => (cmd === "gh" ? (gh.push(args), "https://github.com/example/parity/pull/7") : sh(cmd, args, cwd));
  const env = { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: api.url };
  try {
    const ok = await assist(plan, { repo, dataDir: data, runId: "assist-1", env, run, now: NOW });
    assert.equal(api.requests.length, 1, "one non-mechanical locus, one call");
    const [o] = ok.outcomes;
    assert.deepEqual([o!.result, o!.file, o!.seq, o!.pr, o!.branch], ["proposed", FILE, "customer-crud#1", "https://github.com/example/parity/pull/7", "align/assisted-2026-09-26-1"]);
    assert.ok(o!.gate!.after.trainDivergences < o!.gate!.before.trainDivergences);
    assert.ok(o!.gate!.after.heldOut.L3.k > o!.gate!.before.heldOut.L3.k, "the held-out customers match too");
    assert.match(assistText(ok), /^ {2}proposed · \d+ · customer description · src\/twin\/resources\/customers\.ts · \$0\.0070 · https:\/\/github\.com\/example\/parity\/pull\/7$/m);

    // The prompt: the owning module, a train counterexample truncated after its first divergent step, the clean-room
    // rule; nothing from held-out sequences.
    const sent = api.requests[0]!.body as { system: string; messages: { content: string }[] };
    const user = sent.messages[0]!.content;
    assert.match(sent.system, /Clean room: write original code/);
    assert.ok(user.includes(`### ${FILE}\n\`\`\`ts\n${original}\`\`\``));
    assert.match(user, /^## Counterexample \(normalized\): customer-crud#1, steps 0\.\.0 of 6$/m);
    assert.match(user, /^\* step 0 \$\.description VALUE_MISMATCH expected "Parity \d+" actual null$/m);
    assert.ok(!user.includes("subscription-cancel-at-period-end") && !user.includes("templates-validation"));

    // One draft PR carrying the counterexample, scores and cost; the branch holds only the replaced file and is pushed.
    assert.equal(gh.length, 1);
    const [args] = gh;
    assert.deepEqual(args!.slice(0, 5), ["pr", "create", "--draft", "--head", "align/assisted-2026-09-26-1"]);
    const body = args![args!.indexOf("--body") + 1]!;
    for (const s of ["**Draft: merge only after review**", "- Before: train L1", "- After: train L1", "cost_usd 0.0070", "## Counterexample (normalized): customer-crud#1", "decision 0001 C3"]) assert.ok(body.includes(s), s);
    assert.ok(!gh.flat().includes("merge"), "never merges");
    assert.equal(git("rev-parse", "HEAD"), head, "the main working tree stays on HEAD");
    assert.equal(git("status", "--porcelain"), "?? budget/", "only the LLM ledger is new");
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
    assert.equal(readLlmLedger(join(repo, "budget/llm.jsonl")).length, 2);

    // No key: skipped and logged, nothing sent.
    const none = await assist(plan, { repo, dataDir: data, runId: "assist-3", env: {}, run, now: NOW });
    assert.equal(none.skipped, "ANTHROPIC_API_KEY is not set: no LLM call, assisted pass skipped");
    assert.equal(api.requests.length, 2);

    const log = readJsonl<LogEntry>(logPath(data));
    assert.deepEqual(verifyLog(logPath(data)), { ok: true, entries: 4 });
    assert.deepEqual(log.map((e) => [e.kind, e.runId, e.data.class, e.data.status]), [
      ["patch", "assist-1", "assisted", "proposed"],
      ["note", "assist-1", undefined, undefined],
      ["note", "assist-2", undefined, undefined],
      ["note", "assist-3", undefined, undefined],
    ]);
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
