// Objects are built as template ⊕ computed fields (0002 §2): a fresh copy of shapes/<type>.json
// shallow-merged with `fields`.
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("./shapes/", import.meta.url);
const SHAPES = new Map(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), readFileSync(new URL(f, dir), "utf8")]));

export function build(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = SHAPES.get(type);
  if (raw === undefined) throw new Error(`build: no template for type "${type}"`);
  return { ...JSON.parse(raw), ...fields };
}
