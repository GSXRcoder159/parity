// Drift instrument (plan §3.4, decision 0002 §1): tonight's sandbox slice against the previous recording of the same
// sequences (the oracle as it stood before tonight's rebuild: the newest clean recording of each), normalized, with the
// noise set's paths excluded. Public output is endpoints, templates, paths and classes only (decision 0001 C3); fraud
// and risk paths are withheld (0001 R8). Nothing to report: no file, a sealed-log `note` instead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES } from "../templates/index.ts";
import { appendLog, type Provenance } from "./align/log.ts";
import { FRAUD_OR_RISK } from "./align/patch.ts";
import { segments } from "./align/triage.ts";
import { compareRecordings } from "./bench/compare.ts";
import { buildCorpus } from "./bench/corpus.ts";
import { NORMALIZATION_VERSION, normalizeRecording } from "./bench/normalize.ts";
import { contaminated } from "./bench/oracle.ts";
import type { DivergenceClass, Recording } from "./types.ts";

/** One line of site/data/drift.json (the page's contract, site/app.js). */
export interface DriftItem {
  date: string;
  endpoint: string;
  template: string;
  path: string;
  cls: DivergenceClass;
}
export interface DriftResult {
  /** Tonight's clean recordings that had a previous recording. */
  compared: number;
  items: DriftItem[];
  /** Divergences on fraud or risk paths: logged as a count, never published. */
  withheld: number;
  /** drift/<date>.md, relative to the root, when there is something to report. */
  file?: string;
}

/** The template's own step path (`POST /v1/customers/$c1.id`), never the resolved one, which holds response ids. */
function endpoint(r: Recording, step: number): string {
  if (step < 0) return "events";
  const t = TEMPLATES.find((x) => x.name === r.template);
  const s = t && buildCorpus([t], [r.seed])[0]!.steps[step];
  return s ? `${s.method} ${s.path}` : `step ${step}`;
}

/**
 * Compares `today` (tonight's slice) with `previous` by sequence, excluding `noise` keys (`template|step|path`). Writes
 * drift/<date>.md under `root` and replaces the date's lines in <root>/site/data/drift.json; with nothing to report it
 * writes no file and appends a `note` to the sealed log `log`.
 */
export function drift(o: { date: string; today: Recording[]; previous: Recording[]; noise: Set<string>; root: string; log: string; runId: string; oracle: Provenance }): DriftResult {
  const prev = new Map(o.previous.map((r) => [r.seq, r]));
  const pairs = o.today.filter((r) => !contaminated(r) && prev.has(r.seq));
  const found = new Map<string, { item: DriftItem; seqs: Set<string> }>();
  let withheld = 0;
  for (const t of pairs) {
    for (const d of compareRecordings(normalizeRecording(prev.get(t.seq)!), normalizeRecording(t), o.noise).divergences) {
      if (d.cls === "NONDETERMINISTIC") continue;
      if (segments(d.path).some((s) => FRAUD_OR_RISK.has(String(s)))) {
        withheld++;
        continue;
      }
      const item: DriftItem = { date: o.date, endpoint: endpoint(t, d.step), template: t.template, path: d.path, cls: d.cls };
      const k = JSON.stringify(item);
      if (!found.has(k)) found.set(k, { item, seqs: new Set() });
      found.get(k)!.seqs.add(t.seq);
    }
  }
  const rows = [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  const res: DriftResult = { compared: pairs.length, items: rows.map((r) => r.item), withheld };
  if (!rows.length) {
    const reason = !pairs.length
      ? "no clean slice recording tonight with a previous recording to compare"
      : withheld
        ? "only fraud or risk paths diverged (withheld, decision 0001 R8)"
        : "no divergence outside the noise set";
    appendLog(o.log, o.runId, [{ kind: "note", data: { drift: { date: o.date, compared: pairs.length, withheld, reason }, oracle: o.oracle } }]);
    return res;
  }
  res.file = `drift/${o.date}.md`;
  mkdirSync(join(o.root, "drift"), { recursive: true });
  writeFileSync(
    join(o.root, res.file),
    [
      `# Drift ${o.date}`,
      "",
      `Tonight's sandbox slice against the previous sandbox recording of the same sequences: ${pairs.length} sequences compared, normalization ${NORMALIZATION_VERSION}, paths in the noise set (${o.noise.size} keys) excluded. Endpoints, templates, paths and classes only (decision 0001 C3).`,
      "",
      "| Endpoint | Template | Path | Class | Sequences |",
      "| --- | --- | --- | --- | --- |",
      ...rows.map(({ item: i, seqs }) => `| \`${i.endpoint}\` | ${i.template} | \`${i.path}\` | ${i.cls} | ${seqs.size} |`),
      ...(withheld ? ["", `${withheld} divergences on fraud or risk fields are withheld (decision 0001 R8).`] : []),
      "",
    ].join("\n"),
  );
  const feed = join(o.root, "site/data/drift.json");
  const old = existsSync(feed) ? (JSON.parse(readFileSync(feed, "utf8")) as DriftItem[]).filter((x) => x.date !== o.date) : [];
  mkdirSync(join(o.root, "site/data"), { recursive: true });
  writeFileSync(feed, JSON.stringify([...old, ...res.items], null, 2) + "\n");
  return res;
}
