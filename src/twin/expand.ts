// `expand[]` paths: replace id strings in a response body with the stored objects.
import { fail } from "./errors.ts";

type Obj = Record<string, unknown>;

// ponytail: "expandable" = holds a string that resolves to a stored object (never `id`); the spec's
// x-expansionResources would also reject stored-id fields that are not expandable (e.g. subscription_item.subscription).
const MAX_DEPTH = 4; // counts every segment, `data` included (data.invoice.subscription.default_source is the deepest)

/** Returns an expanded copy of `body` (always a copy). `get` resolves an id to its stored object. */
export function expand(body: unknown, paths: unknown, get: (id: string) => Obj | undefined): unknown {
  const out = structuredClone(body);
  // Shorter paths first (and each once), so `a` is already an object when `a.b` walks through it.
  const unique = [...new Set((Array.isArray(paths) ? paths : []).map(String))].sort((a, b) => a.split(".").length - b.split(".").length);
  for (const p of unique) {
    const segs = p.split(".");
    if (segs.length > MAX_DEPTH) fail("expand_too_deep");
    walk(out, segs, get);
  }
  return out;
}

function walk(node: unknown, [seg, ...rest]: string[], get: (id: string) => Obj | undefined): void {
  if (Array.isArray(node)) return node.forEach((x) => walk(x, [seg!, ...rest], get));
  const o = node as Obj;
  if (seg === "id" || !Object.hasOwn(o, seg!)) fail("expand_invalid");
  let v = o[seg!];
  if (typeof v === "string") {
    const found = get(v);
    if (!found) fail("expand_invalid");
    v = o[seg!] = structuredClone(found);
  } else if (v !== null && (typeof v !== "object" || rest.length === 0)) fail("expand_invalid"); // a scalar, or a hash/list as the expanded field
  if (rest.length > 0 && v !== null) walk(v, rest, get);
}
