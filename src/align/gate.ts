// Held-out gate: candidate edits are scored in a temp copy of the repo (`score-twin` in a child process) and accepted
// iff held-out L3 does not drop AND the train divergence count strictly falls. Greedy per-file batches; a batch that
// fails is split (by which edits removed their own divergences, else in halves) down to single edits.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SeqResult } from "../bench/compare.ts";
import type { LevelScores, Score } from "../bench/score.ts";
import { readJsonl } from "../jsonl.ts";
import type { Recording } from "../types.ts";
import type { Candidate, Edit } from "./patch.ts";
import { divergenceId } from "./triage.ts";

type Obj = Record<string, unknown>;
const isPlain = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** errors.json keeps one entry per line. */
const formatCatalog = (c: Record<string, Obj>): string =>
  `{\n${Object.entries(c)
    .map(([k, v]) => `  ${JSON.stringify(k)}: { ${Object.entries(v).map(([a, b]) => `${JSON.stringify(a)}: ${JSON.stringify(b)}`).join(", ")} }`)
    .join(",\n")}\n}\n`;

/** Applies the edits to the data files under `root` (missing parents are created; deleting a missing key is a no-op). */
export function applyEdits(root: string, edits: Edit[]): string[] {
  const files = [...new Set(edits.map((e) => e.file))];
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(root, f), "utf8")) as Obj;
    for (const e of edits.filter((x) => x.file === f)) {
      const keys = e.pointer.split("/").slice(1).map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
      const last = keys.pop()!;
      let cur: Obj | undefined = doc;
      for (const k of keys) {
        if (!isPlain(cur[k])) {
          if (e.op === "delete") {
            cur = undefined;
            break;
          }
          cur[k] = {};
        }
        cur = cur[k] as Obj;
      }
      if (cur && e.op === "set") cur[last] = structuredClone(e.value);
      else if (cur) delete cur[last];
    }
    writeFileSync(join(root, f), f.endsWith("errors.json") ? formatCatalog(doc as Record<string, Obj>) : JSON.stringify(doc, null, 2) + "\n");
  }
  return files;
}

export interface ScoreJson {
  score: Score;
  results: SeqResult[];
}

/**
 * The score-twin child's whole env: no secret (ANTHROPIC_API_KEY, GH_TOKEN, STRIPE_API_KEY, PARITY_DATA_TOKEN) and no
 * PARITY_DATA_DIR. NODE_OPTIONS is dropped too: it could lift the permission flags below.
 */
const childEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "CI"].includes(k)));

/** Runs a command in `cwd`, returns its stdout, throws with its stderr on failure (assist.ts `Run`; tests fake docker). */
export type Run = (cmd: string, args: string[], cwd: string) => string;

/** The repo Dockerfile's digest-pinned node image (its FROM line): the Node the twin image runs. */
export function nodeImage(): string {
  const from = /^FROM\s+(\S+@sha256:[0-9a-f]{64})\s*$/m.exec(readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8"))?.[1];
  if (!from) throw new Error("gate: the Dockerfile has no digest-pinned FROM line");
  return from;
}

/**
 * `docker run` arguments for score-twin on the repo copy `root` and `oracle`, writing only into `out`: no network,
 * read-only root filesystem, no capabilities, no privilege gain, the caller's uid (so `out` is writable and the files
 * come back owned by it), `root` and the oracle mounted read-only, `out` read-write. docker passes the container no
 * host environment variable: it sees only the image's own (PATH, NODE_VERSION, …).
 */
export function dockerArgs(root: string, oracle: string, out: string, recordings: boolean): string[] {
  return [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "-v", `${root}:/parity:ro`, "-v", `${oracle}:/oracle.jsonl:ro`, "-v", `${out}:/out`, "-w", "/parity",
    nodeImage(), "node", "src/cli.ts", "score-twin", "--oracle", "/oracle.jsonl", "--json", "/out/score.json",
    ...(recordings ? ["--recordings", "/out/twin.jsonl"] : []),
  ];
}

/** Starts the pinned image with no network and returns its `node --version`: throws when docker cannot run it. */
export const dockerCheck = (run: Run, cwd: string): string => run("docker", ["run", "--rm", "--network", "none", nodeImage(), "node", "--version"], cwd);

/**
 * `score-twin` on `oraclePath` from a temp copy of `repo` (src/, templates/, package.json) with `edits` applied; with
 * `recordings`, also the twin's raw recordings. What runs it:
 *
 * - `docker` given (the assisted pass: the copy holds a file an LLM wrote): a container (dockerArgs) run through
 *   `docker`. The LLM-written code can read only the repo copy and the oracle, write only an empty output directory, and
 *   reach no network, host environment variable, credential, data repo or other recording. The oracle holds held-out
 *   sequences, so without the network it cannot send them out. If docker fails, this throws: never a fallback.
 * - otherwise (the mechanical gate: data-file edits, the repo's own code; align surface: committed code): a child
 *   process under Node's permission model with childEnv(): it reads only the copy and the oracle, writes only the copy,
 *   and cannot spawn processes. ponytail: the permission model does not restrict the network; this code is not an LLM's.
 */
export function scoreTwinIn(repo: string, oraclePath: string, edits: Edit[], recordings = false, docker?: Run): { json: ScoreJson; twin?: Recording[] } {
  const tmp = mkdtempSync(join(tmpdir(), "parity-gate-"));
  try {
    for (const p of ["src", "templates", "package.json"]) cpSync(join(repo, p), join(tmp, p), { recursive: true });
    applyEdits(tmp, edits);
    const oracle = existsSync(oraclePath) ? realpathSync(oraclePath) : resolve(oraclePath);
    const root = realpathSync(tmp); // the permission model compares resolved paths (macOS: /var -> /private/var)
    const out = join(root, "out");
    mkdirSync(out);
    try {
      if (docker) docker("docker", dockerArgs(root, oracle, out, recordings), root);
      else {
        const sandbox = ["--permission", `--allow-fs-read=${root}`, `--allow-fs-read=${oracle}`, `--allow-fs-write=${out}`];
        const args = [...sandbox, join(root, "src/cli.ts"), "score-twin", "--oracle", oracle, "--json", join(out, "score.json")];
        if (recordings) args.push("--recordings", join(out, "twin.jsonl"));
        execFileSync(process.execPath, args, { cwd: root, env: childEnv(), stdio: ["ignore", "ignore", "pipe"] });
      }
    } catch (e) {
      throw new Error(`gate: score-twin failed${docker ? " in its container" : ""}: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message ?? e).trim()}`);
    }
    return {
      json: JSON.parse(readFileSync(join(out, "score.json"), "utf8")) as ScoreJson,
      twin: recordings ? readJsonl<Recording>(join(out, "twin.jsonl")) : undefined,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Train and held-out L1–L4 and the train divergence count (every class; `ids` = seq|step|path of each). */
export interface Scores {
  train: LevelScores;
  heldOut: LevelScores;
  trainDivergences: number;
}
export type Eval = Scores & { ids: Set<string> };

export function evalOf({ score, results }: ScoreJson): Eval {
  const train = results.filter((r) => !r.heldOut).flatMap((r) => r.divergences.map((d) => divergenceId(r.seq, d.step, d.path)));
  return { train: score.train, heldOut: score.heldOut, trainDivergences: train.length, ids: new Set(train) };
}

export const scores = ({ train, heldOut, trainDivergences }: Eval): Scores => ({ train, heldOut, trainDivergences });

export interface Judged {
  candidate: Candidate;
  before: Scores;
  after: Scores;
}
export interface GateResult {
  before: Scores;
  after: Scores;
  accepted: Judged[];
  /** Passed the determinism check but changed nothing: a handler computes the value (input to the assisted pass). */
  blocked: Judged[];
  /** Made train or held-out worse on its own. */
  rejected: Judged[];
  /** Beyond --max-batches. */
  notGated: Candidate[];
  evaluations: number;
  /** `after` with its divergence ids: the score of the accepted edits. */
  final: Eval;
}

/**
 * Gates `candidates` in per-file batches (most targeted divergences first), each on top of the edits accepted so far.
 * A batch is accepted whole when every edit removed at least one of its own divergences and the gate passes; a batch
 * that removed none of its divergences and changed nothing is blocked-by-code. Otherwise it is split (into the edits
 * that removed their divergences and the rest, else in halves) and each part judged again; a single edit that still
 * fails is rejected.
 */
export function gate(candidates: Candidate[], evaluate: (edits: Edit[]) => Eval, o: { maxBatches?: number; before?: Eval } = {}): GateResult {
  let base = o.before ?? evaluate([]);
  const out: GateResult = { before: scores(base), after: scores(base), accepted: [], blocked: [], rejected: [], notGated: [], evaluations: o.before ? 0 : 1, final: base };
  const applied: Edit[] = [];
  const judge = (batch: Candidate[]): void => {
    const r = evaluate([...applied, ...batch]);
    out.evaluations++;
    const judged = (c: Candidate): Judged => ({ candidate: c, before: scores(base), after: scores(r) });
    const effective = batch.filter((c) => c.ids.some((id) => !r.ids.has(id)));
    const heldOutKept = r.heldOut.L3.k >= base.heldOut.L3.k;
    if (!effective.length && heldOutKept && r.trainDivergences === base.trainDivergences) return void out.blocked.push(...batch.map(judged));
    if (effective.length === batch.length && heldOutKept && r.trainDivergences < base.trainDivergences) {
      out.accepted.push(...batch.map(judged));
      applied.push(...batch);
      base = r;
      return;
    }
    if (batch.length === 1) return void out.rejected.push(judged(batch[0]!));
    const half = Math.ceil(batch.length / 2);
    const parts = effective.length && effective.length < batch.length ? [effective, batch.filter((c) => !effective.includes(c))] : [batch.slice(0, half), batch.slice(half)];
    for (const p of parts) judge(p);
  };
  const byFile = new Map<string, Candidate[]>();
  for (const c of candidates) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const weight = (b: Candidate[]) => b.reduce((n, c) => n + c.ids.length, 0);
  const batches = [...byFile.values()].sort((a, b) => weight(b) - weight(a) || (a[0]!.file < b[0]!.file ? -1 : 1));
  batches.forEach((b, i) => (i < (o.maxBatches ?? Infinity) ? judge(b) : out.notGated.push(...b)));
  out.after = scores(base);
  out.final = base;
  return out;
}

/**
 * The assisted gate (assist.ts) on a code change scored `code` (from `before`): the mechanical candidates proposed on
 * top of it are gated from `code` as above (`data.before` is the code change's own score), then the combination must
 * pass the single-edit rule against `before`: one of the locus's own divergences `ids` goes, held-out L3 does not
 * drop, train divergences fall. So a code change that exposes template fields is judged with the data edits fixing them.
 */
export function gatePaired(before: Eval, code: Eval, candidates: Candidate[], evaluate: (edits: Edit[]) => Eval, ids: string[]): { data: GateResult; pass: boolean } {
  const data = gate(candidates, evaluate, { before: code });
  const c = data.final;
  return { data, pass: ids.some((id) => !c.ids.has(id)) && c.heldOut.L3.k >= before.heldOut.L3.k && c.trainDivergences < before.trainDivergences };
}
