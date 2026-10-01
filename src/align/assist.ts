// Assisted patches (decision 0002 §3): for the top K non-mechanical train loci (the plan's not-mechanical loci and its
// blocked-by-code candidates), the LLM sees the behavior module owning the route, a normalized counterexample from the
// smallest train sequence showing the locus, and the divergences; it returns one replaced file under src/twin/. The
// reply is gated in a temp copy inside a container with no network (gate.ts scoreTwinIn with docker): no docker, no
// pass. The mechanical pass runs on top of the code change there (train only, data files only, index.ts mechanical)
// and the combination is gated (gate.ts gatePaired: held-out L3 must not drop, train divergences must fall, one of the
// locus's own must go), so a change that exposes template fields is not judged without the data edits fixing them; the
// plan's own accepted or not-gated edits are never paired (they fix what HEAD already could, not the change's). A
// pass becomes a branch align/assisted-<date>-<n> built in a separate worktree (the code change, then the data edits,
// as two commits), pushed, and a draft PR; the sealed log gets a `patch` entry {class: "assisted", status: "proposed"}
// scored after the code change alone, and one {class: "automatic", status: "proposed"} per data edit. Nothing here
// merges: merging is a review step (docs/plan/STATUS.md). Held-out sequences are never shown to the LLM. A locus whose last
// 2 attempts stopped at max_tokens sits out 7 days (`cooldown`, from the sealed log) and the next locus takes its slot.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeRecording } from "../bench/normalize.ts";
import { readJsonl } from "../jsonl.ts";
import type { Recording } from "../types.ts";
import type { Route } from "../twin/server.ts";
import { applyEdits, dockerCheck, editOf, evalOf, gatePaired, scores, scoreTwinIn, type Run, type Scores } from "./gate.ts";
import { candidateLine, mechanical, split, where, type AlignResult } from "./index.ts";
import { appendLog, logPath, verifyLog, type LogEntry } from "./log.ts";
import { CapRefused, DEFAULT_MODEL, capUsd, complete, type Env } from "./llm.ts";
import { FRAUD_OR_RISK, locusKey, type Candidate } from "./patch.ts";
import { divergenceId, segments, type Locus, type Triaged } from "./triage.ts";

export type { Run } from "./gate.ts";
/** Runs a command in `cwd` and returns its trimmed stdout (injectable: tests fake `gh`, `docker` and failing pushes). */
// maxBuffer: `git show` of the sealed log (reland) outgrows the 1 MB default.
export const sh: Run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();

interface Cluster {
  locus: Locus;
  reason: string;
  /** Its train divergences (noise excluded). */
  divergences: Triaged[];
}

/**
 * Fraud and risk fields (patch.ts FRAUD_OR_RISK; 0001 R8: never published, in any form) are kept out of the prompt and
 * the PR: `risky` paths are dropped, `scrub` removes those keys at any depth of a value.
 */
const risky = (path: string): boolean => segments(path).some((s) => FRAUD_OR_RISK.has(String(s)));
const scrub = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !FRAUD_OR_RISK.has(k)).map(([k, x]) => [k, scrub(x)])) : v;

/** Non-mechanical train loci worth a code change, most train divergences first. Noise and fraud/risk loci are skipped. */
function clusters(r: AlignResult): Cluster[] {
  const train = r.divergences.filter((d) => !d.heldOut && d.cls !== "NONDETERMINISTIC");
  const loci = [
    ...r.notMechanical.filter((n) => !/^(noise|fraud)/.test(n.reason)).map((n) => ({ locus: n.locus, reason: n.reason })),
    ...r.gate.blocked.map((j) => ({ locus: j.candidate.locus, reason: "blocked-by-code: the data edit changed nothing" })),
  ].filter((l) => !(l.locus.kind === "field" && risky(`.${l.locus.fieldPath}`))); // e.g. "no template" is decided before the fraud check
  return loci
    .map((l) => ({ ...l, divergences: train.filter((d) => locusKey(d.locus) === locusKey(l.locus)) }))
    .filter((c) => c.divergences.length)
    .sort((a, b) => b.divergences.length - a.divergences.length || (locusKey(a.locus) < locusKey(b.locus) ? -1 : 1));
}

const RESOURCES = new URL("../twin/resources/", import.meta.url);
/** The resource module whose route serves (method, path), first match in the server's order. */
async function owner(method: string, path: string): Promise<string | undefined> {
  for (const f of readdirSync(RESOURCES).filter((x) => x.endsWith(".ts")).sort()) {
    const { routes = [] } = (await import(new URL(f, RESOURCES).href)) as { routes?: Route[] };
    if (routes.some(([m, re]) => m === method && re.test(path.split("?")[0]!))) return `src/twin/resources/${f}`;
  }
  return undefined;
}

/** Stripe's documented test payment methods (`pm_card_chargeCustomerFail`): our template inputs, never a generated id. */
const TEST_TOKEN = /^pm_card_/;

/**
 * normalizeRecording (bodies and params), plus each step's path segments by the same rules (ids <id:prefix>, run nonce
 * <run>, ...; 0001 C3), except test-token segments, which stay: they say why a step declines. The paths go through as
 * extra steps after the real ones, so the timestamp anchor stays the bodies'.
 */
// ponytail: tokens are kept in paths only; no template puts one in params (templates/common.ts attach), add it there if one does.
export function normalizeWithParams(r: Recording): Recording {
  const n = r.steps.length;
  const x = normalizeRecording({ ...r, steps: [...r.steps, ...r.steps.map((s) => ({ ...s, body: s.path.split("/") }))] });
  return {
    ...x,
    steps: x.steps.slice(0, n).map((s, i) => {
      const raw = r.steps[i]!.path.split("/");
      return { ...s, path: (x.steps[n + i]!.body as string[]).map((p, j) => (TEST_TOKEN.test(raw[j]!) ? raw[j]! : p)).join("/") };
    }),
  };
}

interface Counterexample {
  seq: string;
  /** Steps 0..last are shown. */
  last: number;
  /** The step whose route owns the locus, and its path normalized as shown (ids <id:prefix>, test tokens kept). */
  step: number;
  path: string;
  text: string;
}

/**
 * The smallest train sequence showing the cluster, truncated after the cluster's earliest divergent step there (an
 * event-set locus keeps the whole sequence), normalized, with its divergences (`*` marks the cluster's).
 */
// ponytail: truncation only; step-dropping minimization needs new oracle runs and is deferred until the read budget allows.
function counterexample(c: Cluster, all: Triaged[], oracle: Map<string, Recording>, twin: Map<string, Recording>): Counterexample {
  const seq = [...new Set(c.divergences.map((d) => d.seq))].sort((a, b) => oracle.get(a)!.steps.length - oracle.get(b)!.steps.length || (a < b ? -1 : 1))[0]!;
  const o = normalizeWithParams(oracle.get(seq)!);
  const t = normalizeRecording(twin.get(seq)!);
  const mine = c.divergences.filter((d) => d.seq === seq);
  const steps = mine.filter((d) => d.step >= 0).map((d) => d.step);
  const last = steps.length ? Math.min(...steps) : o.steps.length - 1;
  const ev = mine.find((d) => d.locus.kind === "events")?.locus;
  const step = steps.length ? last : ev?.kind === "events" ? (ev.steps.find((s) => s.step >= 0)?.step ?? last) : last;
  const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
  const out = [`## Counterexample (normalized): ${seq}, steps 0..${last} of ${o.steps.length}`, "oracle = the reference sandbox; twin = the code above. Normalized: ids <id:prefix>, timestamps <t:...> (relative), dates in text <date>, run nonces <run>, generated opaque strings <opaque>, secrets <secret>, invoice numbers <number:...>, URLs <url:host>; any generated value of that kind matches. Fraud and risk fields are removed from both sides: leave the code that sets them as it is."];
  for (const s of o.steps.slice(0, last + 1)) {
    const ts = t.steps[s.i];
    const [ob, tb] = [scrub(s.body), scrub(ts?.body)];
    out.push(`### Step ${s.i}: ${s.method} ${s.path}`, `params: ${JSON.stringify(scrub(s.params ?? {}))}`, `oracle: status ${s.status}`, json(ob));
    out.push(ts && ts.status === s.status && isDeepStrictEqual(tb, ob) ? "twin: identical" : `twin: status ${ts?.status}\n${json(tb)}`);
  }
  if (ev) out.push(`### Events of the whole sequence\noracle: ${JSON.stringify(o.events.map((e) => e.type))}\ntwin: ${JSON.stringify(t.events.map((e) => e.type))}`);
  const ids = new Set(mine.map((d) => divergenceId(d.seq, d.step, d.path)));
  const shown = all.filter((d) => d.seq === seq && d.cls !== "NONDETERMINISTIC" && d.step <= last && !risky(d.path));
  out.push(
    `## Divergences in these steps (* = the locus to fix: ${where(c.locus)}; ${c.reason}; ${c.divergences.length} train divergences there in ${new Set(c.divergences.map((d) => d.seq)).size} sequences)`,
    ...shown.map((d) => `${ids.has(divergenceId(d.seq, d.step, d.path)) ? "*" : "-"} step ${d.step} ${d.path} ${d.cls} expected ${JSON.stringify(scrub(d.expected))} actual ${JSON.stringify(scrub(d.actual))}`),
  );
  return { seq, last, step, path: o.steps[step]!.path, text: out.join("\n") };
}

const SYSTEM = `You fix one behavior bug in Parity's twin: an open-source emulator of a payments API's Billing surface, in TypeScript for Node 22 (type stripping, explicit .ts imports, \`import type\` for types).
Handlers are pure: (ctx, req) -> { status, body, events }. Objects are built as \`ctx.build(type, computed)\` (a data template plus computed fields) and errors are raised by catalog key with \`ctx.fail(key, vars)\`. Templates (shapes/*.json) and the error catalog (errors.json) are data you cannot edit here: fix only what handler code decides (computed fields, statuses, which events fire, state transitions).
Rules:
1. Reply with a full replacement of exactly one of the files shown, in this format and nothing else:
FILE: <path as shown>
\`\`\`ts
<the entire file>
\`\`\`
2. Change behavior only as far as the counterexample shows; keep every other route, export and import working.
3. Clean room: write original code from the evidence shown. Do not use, recall or reproduce code from any third-party emulator or mock of this API (such as stripe-mock or localstripe) or from any other twin.
4. Build every API object you add or return, nested ones too, with \`ctx.build(type, computed)\` and set only what the handler computes; never write an object's fields as a literal. After your change, a mechanical pass fixes the templates' field values against the oracle, so a template field that differs from the counterexample is fixed there, not in code.`;

/** The user message: the files, the counterexample, the instruction. */
const userPrompt = (files: { path: string; source: string }[], ce: Counterexample): string =>
  [
    "## Behavior module source",
    ...files.map((f) => `### ${f.path}\n\`\`\`ts\n${f.source}\`\`\``),
    ce.text,
    `## Task\nReturn the full replacement of exactly one of: ${files.map((f) => f.path).join(", ")}, so the twin answers as the oracle does at the * divergences.`,
  ].join("\n\n");

/** `FILE: <path>` plus one fenced block; the path must be one of `allowed` (the files shown). */
export function parseReply(text: string, allowed: string[]): { file: string; content: string } | { error: string } {
  const files = [...text.matchAll(/^FILE:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]!);
  const blocks = [...text.matchAll(/^```[\w-]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]!);
  if (files.length !== 1 || blocks.length !== 1) return { error: `expected one FILE line and one fenced block, got ${files.length} and ${blocks.length}` };
  if (!allowed.includes(files[0]!)) return { error: `${files[0]} is not one of the files shown (${allowed.join(", ")})` };
  if (!blocks[0]!.trim()) return { error: "empty file" };
  return { file: files[0]!, content: blocks[0]! };
}

/**
 * The code change paired with the mechanical pass on top of it, in a temp copy of the repo with `file` replaced, every
 * score-twin in the container (`run` runs docker): `code` is the change's own score, `data` the gate of the data edits
 * from there, `pass` the combination's verdict against `r.baseline` (gate.ts gatePaired).
 */
function scorePaired(r: AlignResult, repo: string, oraclePath: string, file: string, content: string, ids: string[], run: Run) {
  const tmp = mkdtempSync(join(tmpdir(), "parity-assist-"));
  try {
    for (const p of ["src", "templates", "package.json"]) cpSync(join(repo, p), join(tmp, p), { recursive: true });
    writeFileSync(join(tmp, file), content);
    // ponytail: the plan's accepted and not-gated edits are dropped whole (gatePaired `stale`), so when the change also
    // exposes one's field, those divergences wait for a run after the edit lands. Blocked and rejected ones are re-gated
    // (docker runs per locus grow with them); skip the rejected if the assisted pass gets slow.
    const m = mechanical(tmp, oraclePath, r.noiseKeys, run);
    const stale = [...r.gate.accepted.map((j) => j.candidate), ...r.gate.notGated];
    return { code: m.baseline, ...gatePaired(r.baseline, m.baseline, m.candidates, (edits) => evalOf(scoreTwinIn(tmp, oraclePath, edits, false, run).json), ids, stale) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * On a new branch align/assisted-<date>-<n> from HEAD in a separate worktree: commits `file` (the code change), then
 * `edits` applied to the data files as a second commit when there are any; pushes it, opens a draft PR.
 */
function openDraftPr(repo: string, run: Run, date: string, file: string, content: string, msg: string, edits: { candidates: Candidate[]; msg: string }, title: string, body: string) {
  const prefix = `align/assisted-${date}-`;
  const git = (...args: string[]) => run("git", args, repo);
  const names = [
    ...git("branch", "--list", `${prefix}*`, "--format=%(refname:short)").split("\n"),
    ...git("ls-remote", "--heads", "origin", `refs/heads/${prefix}*`).split("\n").map((l) => l.split("refs/heads/")[1] ?? ""),
  ];
  const n = Math.max(0, ...names.filter((x) => x.startsWith(prefix)).map((x) => Number(x.slice(prefix.length))).filter(Number.isInteger)) + 1;
  const branch = `${prefix}${n}`;
  const tmp = mkdtempSync(join(tmpdir(), "parity-assist-wt-"));
  const wt = join(tmp, "wt");
  git("worktree", "add", "-q", "-b", branch, wt, "HEAD"); // the main working tree is never checked out elsewhere
  let pushed = false;
  let done = false;
  try {
    writeFileSync(join(wt, file), content);
    run("git", ["commit", "-q", "-m", msg, "--", file], wt);
    const commit = run("git", ["rev-parse", "HEAD"], wt);
    let dataCommit: string | undefined;
    if (edits.candidates.length) {
      run("git", ["commit", "-q", "-m", edits.msg, "--", ...applyEdits(wt, edits.candidates)], wt);
      dataCommit = run("git", ["rev-parse", "HEAD"], wt);
    }
    run("git", ["push", "-q", "-u", "origin", branch], wt);
    pushed = true;
    const pr = run("gh", ["pr", "create", "--draft", "--head", branch, "--title", title, "--body", body], repo);
    done = true;
    return { branch, commit, pr, dataCommit };
  } finally {
    git("worktree", "remove", "--force", wt);
    rmSync(tmp, { recursive: true, force: true });
    // A proposal without its PR leaves no branch behind, here or on origin (e.g. the repo does not allow GitHub Actions
    // to create pull requests: STATUS B2).
    if (!done) {
      for (const args of [...(pushed ? [["push", "-q", "origin", "--delete", branch]] : []), ["branch", "-q", "-D", branch]]) {
        try {
          git(...args);
        } catch {}
      }
    }
  }
}

export interface Outcome {
  locus: string;
  reason: string;
  divergences: number;
  result: "proposed" | "gate-failed" | "bad-reply" | "llm-error" | "no-owner" | "cap" | "pr-failed" | "cooldown";
  detail?: string;
  seq?: string;
  file?: string;
  cost_usd: number;
  /** The code change's own scores: after = the change alone, before the paired data edits. */
  gate?: { before: Scores; after: Scores };
  /** The data edits the mechanical pass accepted on top of the change, and the combination's scores. */
  paired?: { edits: number; after: Scores };
  branch?: string;
  pr?: string;
}
export interface AssistResult {
  skipped?: string;
  model?: string;
  cap?: number;
  clusters: number;
  cost_usd: number;
  outcomes: Outcome[];
}

/**
 * max_tokens of an assist call: Sonnet 5's adaptive thinking plus the whole replaced file (subscriptions.ts, the largest,
 * is ~23K chars). 8,192 cut off events clock-period-rollover on 2026-09-28 (42,780 tokens in, $0.17). The cap estimate
 * (llm.ts) charges all 16,000 at $10/MTok ($0.16) plus chars/2 input: 3 loci with prompts twice that size still fit the
 * CI's $3 cap (test/align-assist.test.ts). 16,000 is the Claude API skill's non-streaming default; more would need streaming.
 */
export const ASSIST_MAX_TOKENS = 16_000;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const PR_BODY_MAX = 60_000;

const COOLDOWN_MS = 7 * 86_400_000;
/** The outcomes that paid for a reply (cap, no-owner, llm-error and cooldown got none): what a cooldown counts. */
const ATTEMPTS = new Set<Outcome["result"]>(["proposed", "gate-failed", "bad-reply", "pr-failed"]);

/**
 * Loci on cooldown at `now`, each with the time it ends: the locus's last 2 attempts in the sealed log's assist notes
 * both stopped at max_tokens, the newer under 7 days ago. events clock-period-rollover did on 2026-09-28, 09-30 and
 * 10-01, ~$0.24 a night for nothing.
 */
export function cooldowns(log: string, now: Date): Map<string, string> {
  const tries = new Map<string, { ts: string; maxed: boolean }[]>();
  for (const e of existsSync(log) ? readJsonl<LogEntry>(log) : []) {
    const outcomes = e.kind === "note" ? ((e.data.assist as AssistResult | undefined)?.outcomes ?? []) : [];
    for (const x of outcomes.filter((x) => ATTEMPTS.has(x.result)))
      tries.set(x.locus, [...(tries.get(x.locus) ?? []), { ts: e.ts, maxed: x.result === "bad-reply" && x.detail === "stop_reason max_tokens" }]);
  }
  const out = new Map<string, string>();
  for (const [locus, t] of tries) {
    const until = Date.parse(t.at(-1)!.ts) + COOLDOWN_MS;
    if (t.length >= 2 && t.slice(-2).every((x) => x.maxed) && now.getTime() < until) out.set(locus, new Date(until).toISOString());
  }
  return out;
}

/**
 * The assisted pass on the plan `r` (whose baseline is the repo's HEAD). Without ANTHROPIC_API_KEY it only logs that it
 * was skipped; without docker running the pinned image it refuses, logged the same way, before any LLM call (LLM-written
 * code never runs outside the container). Stops at the LLM cost cap. Appends a `patch` entry per draft PR and one `note`
 * entry for the run.
 */
export async function assist(
  r: AlignResult,
  o: { repo: string; dataDir: string; runId: string; k?: number; env?: Env; run?: Run; now?: () => Date },
): Promise<AssistResult> {
  const env = o.env ?? process.env;
  const run = o.run ?? sh;
  const now = o.now ?? (() => new Date());
  const log = logPath(o.dataDir);
  const note = (res: AssistResult) => void appendLog(log, o.runId, [{ kind: "note", data: { assist: res, oracle: r.oracle } }]);
  const all = clusters(r);
  if (!env.ANTHROPIC_API_KEY) {
    const res: AssistResult = { skipped: "ANTHROPIC_API_KEY is not set: no LLM call, assisted pass skipped", clusters: all.length, cost_usd: 0, outcomes: [] };
    note(res);
    return res;
  }
  // The gate scores the working tree and the branch starts at HEAD: they must agree. Checked before any spend.
  const dirty = run("git", ["status", "--porcelain", "--", "src", "templates", "package.json"], o.repo);
  if (dirty) throw new Error(`refusing --assist: uncommitted changes the gate would score but the branch would not carry:\n${dirty}`);
  const v = verifyLog(log);
  if (!v.ok) throw new Error(`refusing --assist: the sealed log is broken: ${v.error}`);
  try {
    dockerCheck(run, o.repo);
  } catch (e) {
    const detail = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n")[0];
    const res: AssistResult = { skipped: `refused: docker cannot run the pinned node image (${detail}); LLM-written code never runs outside its container`, clusters: all.length, cost_usd: 0, outcomes: [] };
    note(res);
    return res;
  }

  const oraclePath = join(o.dataDir, "oracle.jsonl");
  const oracle = new Map(readJsonl<Recording>(oraclePath).filter((x) => !x.heldOut).map((x) => [x.seq, x]));
  const twin = new Map(r.twin.filter((x) => !x.heldOut).map((x) => [x.seq, x]));
  const model = env.PARITY_LLM_MODEL || DEFAULT_MODEL;
  const res: AssistResult = { model, cap: capUsd(env), clusters: all.length, cost_usd: 0, outcomes: [] };
  // In the data repo, like the read ledger: the nightly pushes it, so the daily cap survives a failed night and a rerun.
  const ledger = join(o.dataDir, "budget/llm.jsonl");
  const cool = cooldowns(log, now());
  let tried = 0;
  for (const c of all) {
    if (tried === (o.k ?? 3)) break;
    const until = cool.get(where(c.locus));
    if (until) {
      res.outcomes.push({ locus: where(c.locus), reason: c.reason, divergences: c.divergences.length, result: "cooldown", detail: `its last 2 attempts stopped at max_tokens; next try after ${until}`, cost_usd: 0 });
      continue; // the next locus takes the slot
    }
    tried++;
    const out: Outcome = { locus: where(c.locus), reason: c.reason, divergences: c.divergences.length, result: "no-owner", cost_usd: 0 };
    res.outcomes.push(out);
    const ce = counterexample(c, r.divergences, oracle, twin);
    out.seq = ce.seq;
    const s = oracle.get(ce.seq)!.steps[ce.step]!;
    const own = await owner(s.method, s.path);
    if (!own) {
      out.detail = `no behavior module serves ${s.method} ${ce.path.split("?")[0]}`;
      continue;
    }
    const source = (p: string) => readFileSync(join(o.repo, p), "utf8");
    const files = [own, ...(source(own).includes('"../billing.ts"') ? ["src/twin/billing.ts"] : [])].map((path) => ({ path, source: source(path) }));
    let reply;
    try {
      reply = await complete({ system: SYSTEM, user: userPrompt(files, ce), runId: o.runId, purpose: `assist ${out.locus}`, maxTokens: ASSIST_MAX_TOKENS }, { ledger, env, now });
    } catch (e) {
      Object.assign(out, { result: e instanceof CapRefused ? "cap" : "llm-error", detail: (e as Error).message });
      if (e instanceof CapRefused) break; // the loop stops at the cap
      continue;
    }
    out.cost_usd = reply.cost_usd;
    res.cost_usd += reply.cost_usd;
    // A max_tokens stop is a bad-reply like any other: its cost is logged and the locus waits for the next run.
    const parsed = reply.stop_reason === "end_turn" ? parseReply(reply.text, files.map((f) => f.path)) : { error: `stop_reason ${reply.stop_reason}` };
    if ("error" in parsed || parsed.content === source(parsed.file)) {
      Object.assign(out, { result: "bad-reply", detail: "error" in parsed ? parsed.error : "the file is unchanged" });
      continue;
    }
    out.file = parsed.file;
    const ids = c.divergences.map((d) => divergenceId(d.seq, d.step, d.path));
    let paired: ReturnType<typeof scorePaired>;
    try {
      paired = scorePaired(r, o.repo, oraclePath, parsed.file, parsed.content, ids, run);
    } catch (e) {
      Object.assign(out, { result: "gate-failed", detail: (e as Error).message.slice(0, 400) });
      continue;
    }
    const edits = paired.data.accepted;
    const g = (out.gate = { before: scores(r.baseline), after: scores(paired.code) });
    const fin = paired.data.after; // g.after when no data edit was accepted
    if (edits.length) out.paired = { edits: edits.length, after: fin };
    const trainTrail = `train divergences ${g.before.trainDivergences} -> ${g.after.trainDivergences}${edits.length ? ` (the code change) -> ${fin.trainDivergences} (with ${edits.length} paired data edits)` : ""}`;
    if (!paired.pass) {
      Object.assign(out, { result: "gate-failed", detail: `${trainTrail}; held-out L3 ${pct(g.before.heldOut.L3.p)} -> ${pct(fin.heldOut.L3.p)}` });
      continue;
    }
    const summary = `${trainTrail}; train L3 ${pct(g.before.train.L3.p)} -> ${pct(fin.train.L3.p)}; held-out L3 ${pct(g.before.heldOut.L3.p)} -> ${pct(fin.heldOut.L3.p)}`;
    // The commits go public with the repo's history: names and scores only, no response values (0001 C3).
    const msg =
      `align: assisted patch to ${parsed.file} (${out.locus})\n\n` +
      `Proposed by ${reply.model} from train sequence ${ce.seq} (steps 0..${ce.last}), sealed log run ${o.runId}; cost_usd ${reply.cost_usd.toFixed(4)}.\n` +
      `Gate: ${summary}.\nClass assisted (decision 0002 §3): merge only after review (docs/plan/STATUS.md).` +
      (edits.length ? ` The next commit holds the ${edits.length} data edits the mechanical pass accepted on top of this change (class automatic).` : "") +
      `\n\nCo-Authored-By: ${reply.model} <noreply@anthropic.com>`;
    const dataMsg =
      `align: ${edits.length} automatic patches paired with the assisted patch to ${parsed.file} (${out.locus})\n\n` +
      `The mechanical pass on top of the previous commit's code change (train sequences only, the same determinism rules, data files only), ` +
      `gated from the code change's score: train divergences ${g.after.trainDivergences} -> ${fin.trainDivergences}; held-out L3 ${pct(g.after.heldOut.L3.p)} -> ${pct(fin.heldOut.L3.p)}.\n` +
      `Class automatic (decision 0002 §3), logged with status proposed alongside this draft PR; sealed log run ${o.runId}; oracle ${r.oracle.oracleSeqs} sequences, sha256 ${r.oracle.oracleSha}.`;
    const body = [
      "Assisted patch: class `assisted`, status `proposed` (decision 0002 §3). **Draft: merge only after review** (docs/plan/STATUS.md). Nothing merges it automatically.",
      `- Locus: ${out.locus} (${c.reason}); ${c.divergences.length} train divergences in ${new Set(c.divergences.map((d) => d.seq)).size} sequences`,
      `- File: \`${parsed.file}\` · model ${reply.model} · cost_usd ${reply.cost_usd.toFixed(4)} · sealed log run ${o.runId}`,
      `- Before: ${split(g.before)}`,
      `- After${edits.length ? " the code change (commit 1, class `assisted`)" : ""}: ${split(g.after)}`,
      ...(edits.length
        ? [
            `- After its ${edits.length} paired data edits (commit 2, class \`automatic\`: the mechanical pass on top of the code change, train sequences only, data files only): ${split(fin)}\n` +
              edits.map((j) => `  - ${candidateLine(j.candidate).trim()}`).join("\n"),
          ]
        : []),
      "> This description holds normalized sandbox response values (decision 0001 C3): delete or scrub it before the repository becomes public.",
      "> CI does not run on this PR when the nightly opened it with the workflow's GITHUB_TOKEN (GitHub starts no workflows for it), and the gate ran score-twin only: run `npx tsc -p tsconfig.json` and `node --test test/*.test.ts` before merging.",
      ce.text,
    ].join("\n\n");
    try {
      const { dataCommit, ...pr } = openDraftPr(
        o.repo,
        run,
        now().toISOString().slice(0, 10),
        parsed.file,
        parsed.content,
        msg,
        { candidates: edits.map((j) => j.candidate), msg: dataMsg },
        `align: assisted patch to ${parsed.file} (${out.locus})`,
        body.length > PR_BODY_MAX ? body.slice(0, PR_BODY_MAX) + "\n\n…(truncated)" : body,
      );
      Object.assign(out, { result: "proposed", ...pr });
      appendLog(log, o.runId, [
        {
          kind: "patch",
          data: {
            class: "assisted",
            status: "proposed",
            ...pr,
            file: parsed.file,
            sha256: createHash("sha256").update(parsed.content).digest("hex"),
            locus: c.locus,
            evidence: { seq: ce.seq, steps: ce.last + 1, divergences: c.divergences.length, seqs: new Set(c.divergences.map((d) => d.seq)).size },
            gate: g, // after = the code change alone: its divergences removed exclude the data edits'
            model: reply.model,
            cost_usd: reply.cost_usd,
            oracle: r.oracle,
          },
        },
        // Proposed, not applied: they land only if the PR merges, and the ratio counts merges, never proposals.
        ...edits.map((j) => ({
          kind: "patch" as const,
          data: { class: "automatic", status: "proposed", branch: pr.branch, pr: pr.pr, commit: dataCommit, edit: editOf(j.candidate), locus: j.candidate.locus, evidence: j.candidate.evidence, gate: { before: j.before, after: j.after }, oracle: r.oracle },
        })),
      ]);
    } catch (e) {
      Object.assign(out, { result: "pr-failed", detail: (e as Error).message.slice(0, 400) });
    }
  }
  note(res);
  return res;
}

export function assistText(a: AssistResult): string {
  if (a.skipped) return `assist: ${a.skipped} (${a.clusters} non-mechanical loci waiting)`;
  return [
    `assist: ${a.outcomes.filter((x) => x.result !== "cooldown").length} of ${a.clusters} non-mechanical loci tried with ${a.model} · cost_usd ${a.cost_usd.toFixed(4)} this run (daily cap $${a.cap})`,
    ...a.outcomes.map((x) => `  ${x.result} · ${x.divergences} · ${x.locus}${x.file ? ` · ${x.file}` : ""}${x.paired ? ` + ${x.paired.edits} paired data edits` : ""} · $${x.cost_usd.toFixed(4)}${x.pr ? ` · ${x.pr}` : ""}${x.detail ? ` · ${x.detail}` : ""}`),
  ].join("\n");
}
