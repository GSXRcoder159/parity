// Writes one object template per resource in the pruned spec, <x-resourceId>.json, using generic
// defaults only (decision 0002 §4.1). Run: node scripts/gen-shapes.ts [outDir]
// Default outDir is src/twin/shapes; only there are existing *.json files deleted first, so no stale template
// survives. A dir passed on the command line is never cleared.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Schema = {
  $ref?: string;
  nullable?: boolean;
  anyOf?: Schema[];
  enum?: unknown[];
  type?: string;
  properties?: Record<string, Schema>;
  "x-resourceId"?: string;
};

const root = join(import.meta.dirname, "..");
const spec = JSON.parse(readFileSync(join(root, "src/twin/spec/openapi.pruned.json"), "utf8"));
const schemas: Record<string, Schema> = spec.components.schemas;
const cliOut = process.argv[2];
const out = cliOut ?? join(root, "src/twin/shapes");

// Nested objects are expanded 3 levels below the resource; deeper ones are {}. This also stops
// recursion through self-referencing schemas.
// ponytail: fixed depth cap, fields nested deeper than 3 start as {} and the align loop patches them;
// per-schema cycle detection instead of a depth cap if those patches pile up.
const MAX_DEPTH = 3;

function value(s: Schema, depth: number): unknown {
  if (s.$ref) return value(schemas[s.$ref.replace("#/components/schemas/", "")]!, depth);
  if (s.nullable) return null;
  // Expandable fields (string ID | object) take the string form; other unions take the first branch.
  if (s.anyOf) return value(s.anyOf.find((b) => b.type === "string") ?? s.anyOf[0]!, depth);
  if (s.enum) return s.enum[0]; // covers `object` (the resource constant) and `deleted: [true]`
  if (s.type === "boolean") return false;
  if (s.type === "integer" || s.type === "number") return 0;
  if (s.type === "string") return "";
  if (s.type === "array") return [];
  return s.properties && depth < MAX_DEPTH ? template(s, depth + 1) : {}; // maps like metadata → {}
}

function template(s: Schema, depth: number): Record<string, unknown> {
  const props = s.properties ?? {};
  return Object.fromEntries(Object.keys(props).sort().map((k) => [k, value(props[k]!, depth)]));
}

mkdirSync(out, { recursive: true });
if (!cliOut) for (const f of readdirSync(out)) if (f.endsWith(".json")) rmSync(join(out, f));
let n = 0;
for (const s of Object.values(schemas)) {
  const id = s["x-resourceId"];
  if (!id) continue;
  writeFileSync(join(out, `${id}.json`), JSON.stringify(template(s, 0), null, 2) + "\n");
  n++;
}
console.log(`wrote ${n} templates to ${out}`);
