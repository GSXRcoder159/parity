// `paritybench agree`: run a customer's own test command once per target (twin, sandbox) and report per-test pass/fail
// agreement. The report holds test names and outcomes only, never anything the command printed (decision 0001 C3).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { readLedger } from "./bench/budget.ts";
import { dataDir } from "./bench/oracle.ts";
import { sandboxTarget } from "./bench/run.ts";
import { wilson, type Wilson } from "./bench/score.ts";
import { budgetRefusal, readsLedger, Refused } from "./cli.ts";

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
 * `node --test --test-reporter=tap` output: the top-level `ok` / `not ok` lines. `# SKIP` and `# TODO` count as skip.
 * ponytail: top-level only (a describe block is one test); pass --junit for per-subtest outcomes.
 */
export function parseTap(stdout: string): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const line of stdout.split("\n")) {
    const m = /^(not )?ok \d+ - (.*?)(?:(?<!\\) # (SKIP|TODO)\b.*)?$/.exec(line.trimEnd());
    if (m) add(out, m[2]!.replace(/\\([#\\])/g, "$1"), m[3] ? "skip" : m[1] ? "fail" : "pass");
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

/**
 * The CLI's `agree`: the sandbox (budget-gated) and an in-process twin on an ephemeral port, in `runs` order;
 * writes `<out>.md` + `<out>.json` when `out` is given and returns the Markdown report.
 */
export async function agreeRuns(o: { cmd: string; junit?: string; runs: ("twin" | "sandbox")[]; out?: string }): Promise<string> {
  // Gate the sandbox before anything runs, so a refusal costs nothing.
  const key = process.env.STRIPE_API_KEY;
  if (o.runs.includes("sandbox")) {
    if (!key) throw new Error("STRIPE_API_KEY is not set (put it in .env)");
    const ledger = readsLedger(dataDir());
    const budget = Number(process.env.PARITY_READ_BUDGET ?? 10_000);
    // ponytail: the command talks to api.stripe.com directly, so its GETs are neither projected nor ledgered and no circuit
    // breaker watches its 429s; this only refuses an account already at its read budget. Route it through a counting proxy
    // if agree runs on the sandbox routinely.
    const refusal = budgetRefusal(readLedger(ledger), 0, new Date().toISOString(), budget, ledger);
    if (refusal) throw new Refused(refusal);
  }
  let close = (): void => {};
  const targets: AgreeTarget[] = [];
  try {
    for (const run of o.runs) {
      if (run === "sandbox") {
        targets.push(sandboxTarget(key!));
        continue;
      }
      const { createTwin } = await import("./twin/server.ts"); // loads every resource and the pruned spec: only when needed
      const server = await createTwin().listen(0);
      close = () => {
        server.closeAllConnections();
        server.close();
      };
      targets.push({ name: "twin", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity" });
    }
    const report = await agree({ cmd: o.cmd, junit: o.junit, targets, log: (l) => console.error(l) });
    const text = agreeText(report);
    if (o.out) {
      mkdirSync(dirname(o.out), { recursive: true });
      writeFileSync(`${o.out}.md`, text + "\n");
      writeFileSync(`${o.out}.json`, JSON.stringify(report, null, 2) + "\n");
      console.error(`agree: wrote ${o.out}.md and ${o.out}.json`);
    }
    return text;
  } finally {
    close();
  }
}
