// Objects are built as template ⊕ computed fields (0002 §2): a fresh copy of shapes/<type>.json
// deep-merged with `fields`: plain objects merge key by key, anything else (arrays, null, scalars) replaces.
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("./shapes/", import.meta.url);
const SHAPES = new Map(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), readFileSync(new URL(f, dir), "utf8")]));

type Obj = Record<string, unknown>;
const isPlain = (v: unknown): v is Obj => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

/** `fields` over `base` (mutated): a computed nested object keeps the template's other nested defaults. */
function merge(base: Obj, fields: Obj): Obj {
  for (const [k, v] of Object.entries(fields)) base[k] = isPlain(base[k]) && isPlain(v) ? merge(base[k], v) : v;
  return base;
}

export function build(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = SHAPES.get(type);
  if (raw === undefined) throw new Error(`build: no template for type "${type}"`);
  return merge(JSON.parse(raw), fields);
}
