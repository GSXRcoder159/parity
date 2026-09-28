// `paritybench agree`: run a customer's own test command once per target (twin, sandbox) and report per-test pass/fail
// agreement. The report holds test names and outcomes only, never anything the command printed (decision 0001 C3).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { appendLedger, readLedger, rollingGets } from "./bench/budget.ts";
import { dataDir } from "./bench/oracle.ts";
import { createLimiter, sandboxTarget, type Target } from "./bench/run.ts";
import { wilson, type Wilson } from "./bench/score.ts";
import { budgetRefusal, newRunId, readsLedger, Refused } from "./cli.ts";

export type Outcome = "pass" | "fail" | "skip";
export interface AgreeTarget {
  name: string;
  baseUrl: string;
  apiKey: string;
}
export interface AgreeReport {
  date: string;
  targets: string[];
  /** Union of the targets' tests, in first-seen order; "missing" = the test did not run on that target. */
  tests: { name: string; outcomes: Record<string, Outcome | "missing"> }[];
  /** Tests with the same outcome on every target; null with a single target. */
  agreement: Wilson | null;
  disagreeing: string[];
}

/** Names are made unique in order ("x", "x (2)") so both runs pair the same way. */
function add(out: Map<string, Outcome>, name: string, o: Outcome): void {
  let key = name;
  for (let i = 2; out.has(key); i++) key = `${name} (${i})`;
  out.set(key, o);
}

/**
 * `node --test --test-reporter=tap` output: one outcome per test, not per block. A nested test (4 spaces per level) is
 * named `parent > child` from the `# Subtest:` lines; a describe block or a test with subtests is not counted itself,
 * its tests are. `# SKIP` and `# TODO` count as skip. YAML diagnostic blocks (`---` .. `...`) are skipped.
 * ponytail: a block that fails with every one of its tests passing (an after-hook error) is not reported; --junit is.
 */
export function parseTap(stdout: string): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  const unescape = (s: string) => s.replace(/\\([#\\])/g, "$1");
  const names: string[] = []; // `# Subtest:` names by depth
  const children: number[] = []; // results at depth d + 1 since the last result at depth d
  let yaml = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    const body = line.trimStart();
    const depth = Math.floor((line.length - body.length) / 4);
    if (yaml || body === "---") {
      yaml = body === "---" || (yaml && body !== "...");
      continue;
    }
    const sub = /^# Subtest: (.*)$/.exec(body);
    if (sub) names.splice(depth, Infinity, unescape(sub[1]!));
    const m = /^(not )?ok \d+ - (.*?)(?:(?<!\\) # (SKIP|TODO)\b.*)?$/.exec(body);
    if (!m) continue;
    const leaf = !children[depth];
    children[depth] = 0;
    if (depth > 0) children[depth - 1] = (children[depth - 1] ?? 0) + 1;
    if (leaf) add(out, [...names.slice(0, depth), unescape(m[2]!)].join(" > "), m[3] ? "skip" : m[1] ? "fail" : "pass");
  }
  return out;
}

const XML_ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string): string =>
  s.replace(XML_ENTITY, (_, hex, dec, name) => (name ? NAMED[name.toLowerCase()]! : String.fromCodePoint(hex ? parseInt(hex, 16) : Number(dec))));

/**
 * JUnit XML: every `<testcase>`, named `classname > name`; a `<skipped>` child is skip (node marks todo that way too),
 * `<failure>` or `<error>` is fail. ponytail: regex, not an XML parser; fine for reporter output, not for CDATA holding `</testcase>`.
 */
export function parseJunit(xml: string): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  const attr = (attrs: string, k: string): string | undefined => {
    const m = new RegExp(`\\s${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
    return m ? unxml(m[1] ?? m[2]!) : undefined;
  };
  for (const m of xml.matchAll(/<testcase\b((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = attr(m[1]!, "name") ?? "";
    const cls = attr(m[1]!, "classname");
    const body = m[2] ?? "";
    add(out, cls ? `${cls} > ${name}` : name, /<skipped\b/.test(body) ? "skip" : /<(failure|error)\b/.test(body) ? "fail" : "pass");
  }
  return out;
}

/** Runs `cmd` in a shell with STRIPE_API_BASE and STRIPE_API_KEY set for `t`; its stdout is parsed, never kept. */
async function runOnce(cmd: string, t: AgreeTarget, junit: string | undefined): Promise<Map<string, Outcome>> {
  if (junit) rmSync(junit, { force: true }); // a stale file from the previous target must not pass for this run's results
  // Async spawn: the twin serves from this process's event loop.
  const child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, STRIPE_API_BASE: t.baseUrl, STRIPE_API_KEY: t.apiKey } });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => chunks.push(d));
  const [code] = (await once(child, "close")) as [number | null];
  if (junit) {
    if (!existsSync(junit)) throw new Error(`agree: ${t.name}: the command wrote no ${junit} (exit code ${code})`);
    return parseJunit(readFileSync(junit, "utf8"));
  }
  const tests = parseTap(Buffer.concat(chunks).toString("utf8"));
  if (!tests.size) throw new Error(`agree: ${t.name}: no TAP test lines on stdout (exit code ${code}); run node --test with --test-reporter=tap, or pass --junit`);
  return tests;
}

/** Runs `cmd` once per target (in order) and pairs the outcomes by test name. A failing suite is data, not an error. */
export async function agree(o: { cmd: string; junit?: string; targets: AgreeTarget[]; log?: (line: string) => void }): Promise<AgreeReport> {
  const runs: [string, Map<string, Outcome>][] = [];
  for (const t of o.targets) {
    o.log?.(`agree: running on ${t.name} (${t.baseUrl})`);
    const r = await runOnce(o.cmd, t, o.junit);
    const n = (x: Outcome): number => [...r.values()].filter((v) => v === x).length;
    o.log?.(`agree: ${t.name}: ${r.size} tests, ${n("pass")} pass, ${n("fail")} fail, ${n("skip")} skip`);
    runs.push([t.name, r]);
  }
  const names = [...new Set(runs.flatMap(([, r]) => [...r.keys()]))];
  const tests = names.map((name) => ({ name, outcomes: Object.fromEntries(runs.map(([t, r]): [string, Outcome | "missing"] => [t, r.get(name) ?? "missing"])) }));
  const disagreeing = tests.filter((t) => new Set(Object.values(t.outcomes)).size > 1).map((t) => t.name);
  return {
    date: new Date().toISOString().slice(0, 10),
    targets: runs.map(([t]) => t),
    tests,
    agreement: runs.length > 1 ? wilson(tests.length - disagreeing.length, tests.length) : null,
    disagreeing,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function agreeText(r: AgreeReport): string {
  const count = (t: string, o: Outcome): number => r.tests.filter((x) => x.outcomes[t] === o).length;
  const a = r.agreement;
  return [
    `# ParityBench agree: ${r.targets.join(" vs ")}`,
    "",
    `${r.date} · ${r.tests.length} tests · ` + r.targets.map((t) => `${t}: ${count(t, "pass")} pass, ${count(t, "fail")} fail, ${count(t, "skip")} skip`).join(" · "),
    "",
    a ? `**Agreement: ${pct(a.p)}** (${a.k}/${a.n} tests; 95% Wilson CI ${pct(a.lo)}–${pct(a.hi)})` : `Agreement: n/a (one target: ${r.targets[0]})`,
    ...(a ? ["", `## Disagreeing tests (${r.disagreeing.length})`, "", ...(r.disagreeing.length ? r.disagreeing.map((n) => `- ${cell(n)}: ` + r.targets.map((t) => `${t} ${r.tests.find((x) => x.name === n)!.outcomes[t]}`).join(", ")) : ["none"])] : []),
    "",
    "## Tests",
    "",
    `| test | ${r.targets.join(" | ")} |`,
    `|---|${r.targets.map(() => "---").join("|")}|`,
    ...r.tests.map((t) => `| ${cell(t.name)} | ${r.targets.map((x) => t.outcomes[x]).join(" | ")} |`),
  ].join("\n");
}

/** Consecutive 429 answers that halt a metered run (the harness's BREAKER in src/bench/run.ts). */
const BREAKER = 10;
// Hop-by-hop headers, and content-encoding: fetch hands back the decoded body, so the upstream's gzip header must not follow it.
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);

export interface Metered {
  baseUrl: string;
  /** Rolling 30-day GETs in the ledger when the proxy started. */
  rolling: number;
  /** Stops the proxy and appends this run's counts to the read ledger; `aborted` says why the run was halted, if it was. */
  close: () => Promise<{ gets: number; posts: number; deletes: number; charges: number; aborted?: string }>;
}

/**
 * A call that creates a charge by itself: POST /v1/charges, a payment intent confirmed (created with confirm=true, or
 * /confirm), an invoice paid (/pay, not paid_out_of_band). The charges Stripe makes on its own cannot be counted here: a
 * subscription's first or renewal invoice, an auto-advancing invoice. The call behind them (POST /v1/subscriptions, a
 * test clock advance) does not say whether one was made (a trial, a $0 invoice, send_invoice make none), and finding out
 * takes event reads that count against the read budget. A 2xx confirm that still requires an action counts.
 */
function chargeCreating(method: string, url: string, body: string): boolean {
  if (method !== "POST") return false;
  const path = url.split("?")[0]!;
  const form = new URLSearchParams(body);
  if (path === "/v1/payment_intents") return form.get("confirm") === "true";
  if (/^\/v1\/invoices\/[^/]+\/pay$/.test(path)) return form.get("paid_out_of_band") !== "true";
  return path === "/v1/charges" || /^\/v1\/payment_intents\/[^/]+\/confirm$/.test(path);
}

/**
 * The sandbox half's STRIPE_API_BASE: a local proxy to `upstream` under the harness's controls (decision 0001 C2/R7). Every
 * request waits on the limiter (upstream.rps; 20 req/s for the sandbox) and is counted by method before it is forwarded.
 * The run halts once the rolling 30-day GETs reach `budget` or after BREAKER consecutive 429s: every later request is
 * answered here with a 503 and never forwarded. close() ledgers the counts, with `charges`: 2xx answers to
 * chargeCreating() calls, idempotent replays excluded. Headers (the child's Authorization included) and bodies pass
 * through untouched and are never kept.
 * ponytail: 429s are passed back, not retried (the suite owns its retry policy; the limiter caps its rate). Counts are
 * ledgered at close, so a killed run loses its entry, as recordCorpus's current chunk does.
 */
export async function meteredProxy(upstream: Target, o: { ledger: string; budget: number; runId: string }): Promise<Metered> {
  const take = createLimiter(upstream.rps ?? 1000);
  const rolling = rollingGets(readLedger(o.ledger), new Date().toISOString());
  const n = { gets: 0, posts: 0, deletes: 0, charges: 0 };
  let streak = 0;
  let aborted: string | undefined;
  const local = (res: ServerResponse, status: number, message: string): void =>
    void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "api_error", message: `parity agree: ${message}` } }));
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const sent = Buffer.concat(chunks);
    if (!aborted) await take();
    if (rolling + n.gets >= o.budget) aborted ??= `run halted: the rolling 30-day sandbox GETs reached the read budget ${o.budget} (decision 0001 C2)`;
    if (aborted) return local(res, 503, `not sent to the sandbox: ${aborted}`);
    const method = req.method ?? "GET";
    n[method === "GET" ? "gets" : method === "DELETE" ? "deletes" : "posts"]++; // per attempt, before fetch, as the harness counts
    const headers = Object.fromEntries(Object.entries(req.headers).filter((e): e is [string, string] => !HOP.has(e[0]) && typeof e[1] === "string"));
    let r: Response;
    try {
      r = await fetch(upstream.baseUrl + req.url, { method, headers, body: chunks.length ? sent : undefined });
    } catch (e) {
      return local(res, 502, `sandbox unreachable: ${(e as Error).message}`);
    }
    const body = Buffer.from(await r.arrayBuffer());
    if (r.ok && r.headers.get("idempotent-replayed") !== "true" && chargeCreating(method, req.url ?? "", sent.toString("utf8"))) n.charges++;
    streak = r.status === 429 ? streak + 1 : 0;
    if (streak >= BREAKER) aborted ??= `circuit breaker: ${BREAKER} consecutive sandbox answers were 429 (decision 0001 R7)`;
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => void (HOP.has(k) || (out[k] = v)));
    res.writeHead(r.status, out).end(body);
  };
  const server = createServer((req, res) => void handle(req, res).catch(() => res.destroy())).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    rolling,
    close: async () => {
      server.closeAllConnections();
      server.close();
      const date = new Date().toISOString();
      appendLedger(o.ledger, { date, account: process.env.STRIPE_SANDBOX_ACCOUNT ?? "unknown", target: upstream.name, runId: o.runId, ...n });
      return { ...n, aborted };
    },
  };
}

/**
 * The CLI's `agree`: the sandbox (budget-gated, through meteredProxy) and an in-process twin on an ephemeral port, in
 * `runs` order; writes `<out>.md` + `<out>.json` when `out` is given and returns the Markdown report. A halted sandbox run
 * is ledgered and throws Refused: no report. `sandbox` replaces the sandbox upstream (tests only; the CLI never sets it).
 */
export async function agreeRuns(o: { cmd: string; junit?: string; runs: ("twin" | "sandbox")[]; out?: string; sandbox?: Target }): Promise<string> {
  // Gate the sandbox before anything runs, so a refusal costs nothing.
  const key = process.env.STRIPE_API_KEY;
  const ledger = o.runs.includes("sandbox") ? readsLedger(dataDir()) : "";
  const budget = Number(process.env.PARITY_READ_BUDGET ?? 10_000);
  if (ledger) {
    if (!key) throw new Error("STRIPE_API_KEY is not set (put it in .env)");
    // Projected 1: the proxy halts the run when the total reaches the budget, so the gate only needs room for one GET.
    const refusal = budgetRefusal(readLedger(ledger), 1, new Date().toISOString(), budget, ledger);
    if (refusal) throw new Refused(refusal);
  }
  let closeTwin = (): void => {};
  let proxy: Metered | undefined;
  let halted: string | undefined;
  let report: AgreeReport;
  const targets: AgreeTarget[] = [];
  try {
    for (const run of o.runs) {
      if (run === "sandbox") {
        const upstream = o.sandbox ?? sandboxTarget(key!);
        proxy = await meteredProxy(upstream, { ledger, budget, runId: newRunId() });
        console.error(`agree: sandbox via a metered proxy ${proxy.baseUrl} -> ${upstream.baseUrl} (${upstream.rps ?? "unlimited"} req/s; ${proxy.rolling}/${budget} GETs used in 30 days)`);
        targets.push({ name: "sandbox", baseUrl: proxy.baseUrl, apiKey: key! });
        continue;
      }
      const { createTwin } = await import("./twin/server.ts"); // loads every resource and the pruned spec: only when needed
      const server = await createTwin().listen(0);
      closeTwin = () => {
        server.closeAllConnections();
        server.close();
      };
      targets.push({ name: "twin", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity" });
    }
    report = await agree({ cmd: o.cmd, junit: o.junit, targets, log: (l) => console.error(l) });
  } finally {
    closeTwin();
    const m = await proxy?.close();
    if (m) console.error(`agree: sandbox: ${m.gets} GET, ${m.posts} POST, ${m.deletes} DELETE, ${m.charges} charges (direct charge-creating calls only) ledgered to ${ledger}${m.aborted ? `; HALTED: ${m.aborted}` : ""}`);
    halted = m?.aborted;
  }
  if (halted) throw new Refused(`agree: the sandbox run was halted, so there is no report: ${halted}`);
  const text = agreeText(report);
  if (o.out) {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(`${o.out}.md`, text + "\n");
    writeFileSync(`${o.out}.json`, JSON.stringify(report, null, 2) + "\n");
    console.error(`agree: wrote ${o.out}.md and ${o.out}.json`);
  }
  return text;
}
