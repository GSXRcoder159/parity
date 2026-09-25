// Corpus builder: instantiates templates × seeds into deterministic Sequences.
import { createHash } from "node:crypto";
import { createGen } from "../gen.ts";
import type { Sequence, Template } from "../types.ts";

const hash = (s: string): number => createHash("sha1").update(s).digest().readUInt32BE(0);

/** Template-major order; each sequence's generator is seeded from hash(template name) ^ seed. */
export function buildCorpus(templates: Template[], seeds: number[]): Sequence[] {
  return templates.flatMap((t) =>
    seeds.map((seed) => ({
      id: `${t.name}#${seed}`,
      template: t.name,
      stratum: t.stratum,
      seed,
      heldOut: !!t.heldOut,
      steps: t.build(createGen((hash(t.name) ^ seed) >>> 0)),
    })),
  );
}

/** "1-20", "3,5,9", "1-3,7" -> seeds in order, deduplicated. Throws on anything else. */
export function parseSeeds(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    const a = Number(m?.[1]);
    const b = Number(m?.[2] ?? a);
    if (!m || b < a) throw new Error(`invalid seed spec "${spec}" (expected e.g. 1-20, 3,5,9 or 1-3,7)`);
    for (let s = a; s <= b; s++) out.add(s);
  }
  return [...out];
}
