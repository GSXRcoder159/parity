// Oracle store (decision 0002 §1): raw runs under <dataDir>/runs/<date>/, and <dataDir>/oracle.jsonl =
// the newest clean sandbox recording per sequence. Raw recordings are Stripe data (decision 0001 C3).
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonl } from "../jsonl.ts";
import type { Recording } from "../types.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** PARITY_DATA_DIR, else `../parity-data` next to the repo root when it exists, else the repo's gitignored `recordings/`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, root = REPO_ROOT): string {
  if (env.PARITY_DATA_DIR) return resolve(env.PARITY_DATA_DIR);
  const sibling = resolve(root, "../parity-data");
  return existsSync(sibling) ? sibling : join(root, "recordings");
}

/** Never an oracle: a step unanswered or unsent (status 0), rate-limited (429), or events not collected. */
export const contaminated = (r: Recording): boolean => Boolean(r.eventsError) || r.steps.some((s) => s.status === 0 || s.status === 429);

export interface OracleBuild {
  oracle: Recording[]; // sorted by template, then seed
  files: number;
  sandbox: number; // sandbox recordings scanned
  contaminated: number;
  tooOld: number;
}

/** Newest clean sandbox recording per `seq` (by `startedAt`) across `<dir>/runs/**.jsonl`, optionally only those started at or after `minStartedMs`. */
export function buildOracle(dir: string, minStartedMs = -Infinity): OracleBuild {
  const runs = join(dir, "runs");
  const files = readdirSync(runs, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl"));
  const newest = new Map<string, Recording>();
  const out: OracleBuild = { oracle: [], files: files.length, sandbox: 0, contaminated: 0, tooOld: 0 };
  for (const f of files) {
    for (const r of readJsonl<Recording>(join(runs, f))) {
      if (r.target !== "sandbox") continue;
      out.sandbox++;
      const t = Date.parse(r.startedAt);
      if (contaminated(r)) out.contaminated++;
      else if (!(t >= minStartedMs)) out.tooOld++; // an unparsable startedAt is never selected
      else {
        const prev = newest.get(r.seq);
        if (!prev || t > Date.parse(prev.startedAt)) newest.set(r.seq, r);
      }
    }
  }
  out.oracle = [...newest.values()].sort((a, b) => (a.template < b.template ? -1 : a.template > b.template ? 1 : a.seed - b.seed));
  return out;
}
