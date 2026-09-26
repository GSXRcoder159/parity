// Generic list and search responses over stored objects.
import { fail } from "./errors.ts";

type Obj = Record<string, unknown>;

/** Newest first; same-second ties in reverse insertion order (the input is insertion order). */
const newestFirst = (items: Obj[]) => [...items].reverse().sort((a, b) => (b.created as number) - (a.created as number));

const CMP: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
};

/** `created` filter: exact (`created=t`) or a range (`created[gte]=t`…). */
function inCreated(t: number, c: unknown): boolean {
  if (c === undefined || c === "") return true;
  if (c === null || typeof c !== "object") return t === Number(c);
  return Object.entries(c).every(([op, v]) => v === "" || (CMP[op]?.(t, Number(v)) ?? true));
}

export function list(items: Obj[], params: Obj, url: string) {
  const limit = params.limit === undefined || params.limit === "" ? 10 : Number(params.limit);
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100)) fail("list_limit_invalid");
  const all = newestFirst(items);
  // ponytail: a cursor must be in `items` (after the handler's own filters); the real API also accepts other ids of the type.
  const at = (param: string) => {
    const i = all.findIndex((o) => o.id === params[param]);
    return i < 0 ? fail("resource_missing", { param }) : i;
  };
  const keep = (o: Obj) => inCreated(o.created as number, params.created);
  if (params.ending_before) {
    const before = all.slice(0, at("ending_before")).filter(keep);
    return { object: "list", data: before.slice(-limit), has_more: before.length > limit, url };
  }
  const after = (params.starting_after ? all.slice(at("starting_after") + 1) : all).filter(keep);
  return { object: "list", data: after.slice(0, limit), has_more: after.length > limit, url };
}

// field:'value' or metadata['key']:'value' (single or double quotes).
const CLAUSE = /^(\w+)(?:\[(['"])((?:(?!\2).)*)\2\])?:(['"])((?:(?!\4).)*)\4$/;
// field>n, field>=n, field<n, field<=n on a numeric field (docs: `created>=<epoch>` works in a customer search, #23).
const RANGE = /^(\w+)(>=|<=|>|<)(-?\d+)$/;
const OPS: Record<string, keyof typeof CMP> = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

/** Search query language subset: exact-match and numeric range clauses joined by ` AND `. */
export function search(items: Obj[], query: unknown, url: string, limit = 10) {
  const clauses = String(query ?? "")
    .split(" AND ")
    .map((c): ((o: Obj) => boolean) => {
      const range = RANGE.exec(c.trim());
      if (range) {
        const [, field, op, n] = range;
        return (o) => typeof o[field!] === "number" && CMP[OPS[op!]!]!(o[field!] as number, Number(n));
      }
      const [, field, , key, , value] = CLAUSE.exec(c.trim()) ?? fail("search_query_invalid");
      // A clause needs the field to hold a value: 'null' is the literal string, never a null or absent field.
      return (o) => {
        const v = key === undefined ? o[field!] : (o[field!] as Obj | null)?.[key];
        return v != null && String(v) === value;
      };
    });
  const hits = newestFirst(items).filter((o) => clauses.every((hit) => hit(o)));
  // ponytail: no page tokens; next_page stays null even when has_more is true.
  return { object: "search_result", data: hits.slice(0, limit), has_more: hits.length > limit, next_page: null, url };
}
