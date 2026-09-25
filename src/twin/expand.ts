// `expand[]` paths: replace id strings in a response body with the stored objects.
import { fail } from "./errors.ts";

type Obj = Record<string, unknown>;

// Same id grammar as the harness (src/bench/run.ts): lowercase prefix + a tail with an uppercase letter or digit.
// ponytail: "expandable" = holds an id-shaped string; the spec's x-expansionResources would also reject
// id-valued fields that are not expandable (e.g. `id`) and expandable-looking nested hashes.
const ID = /^[a-z]+(?:_[a-z]+)*_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{10,}$/;
const MAX_DEPTH = 4; // counts every segment, `data` included (data.invoice.subscription.default_source is the deepest)

/** Returns an expanded copy of `body` (always a copy). `get` resolves an id (unknown ids stay strings). */
export function expand(body: unknown, paths: unknown, get: (id: string) => Obj | undefined): unknown {
  const out = structuredClone(body);
  for (const p of Array.isArray(paths) ? paths : []) {
    const segs = String(p).split(".");
    if (segs.length > MAX_DEPTH) fail("expand_too_deep");
    walk(out, segs, get);
  }
  return out;
}

function walk(node: unknown, [seg, ...rest]: string[], get: (id: string) => Obj | undefined): void {
  if (Array.isArray(node)) return node.forEach((x) => walk(x, [seg!, ...rest], get));
  const o = node as Obj;
  if (!Object.hasOwn(o, seg!)) fail("expand_invalid");
  let v = o[seg!];
  if (typeof v === "string") {
    if (!ID.test(v)) fail("expand_invalid");
    const found = get(v);
    if (found) v = o[seg!] = structuredClone(found);
  } else if (v !== null && typeof v !== "object") fail("expand_invalid");
  if (rest.length > 0 && v !== null && typeof v === "object") walk(v, rest, get);
}
