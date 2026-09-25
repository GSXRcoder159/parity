// Form decoding in the API's bracket style, the inverse of the harness's encodeForm: a[b][0][c]=x -> {a:{b:[{c:"x"}]}}.
// Values stay strings; "" (unset) is preserved. Used for POST bodies and GET/DELETE query strings.

type Obj = Record<string, unknown>;

export function parseForm(body: string): Obj {
  const root: Obj = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const head = key.match(/^[^[]*/)![0];
    const segs = [head, ...Array.from(key.slice(head.length).matchAll(/\[([^\]]*)\]/g), (m) => m[1]!)];
    if (segs.includes("__proto__")) continue;
    let cur = root;
    // `[]` appends: it takes the next index of its container.
    const at = (s: string) => (s === "" ? String(Object.keys(cur).length) : s);
    for (const s of segs.slice(0, -1)) {
      const k = at(s);
      const next = cur[k];
      cur = next !== null && typeof next === "object" ? (next as Obj) : ((cur[k] = {}) as Obj);
    }
    cur[at(segs.at(-1)!)] = value;
  }
  for (const k of Object.keys(root)) root[k] = arrays(root[k]); // the top level stays an object
  return root;
}

// ponytail: an object keyed exactly "0".."n-1" becomes an array, so metadata[0]=x parses as ["x"];
// validate.ts turns it back into an object where the schema wants one.
function arrays(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Obj;
  for (const k of Object.keys(o)) o[k] = arrays(o[k]);
  const keys = Object.keys(o); // integer keys come first, ascending
  return keys.length > 0 && keys.every((k, i) => k === String(i)) ? Object.values(o) : o;
}
