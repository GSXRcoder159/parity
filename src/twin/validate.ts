// Validates parsed form params against the pruned spec's request schema for one operation
// ("post /v1/customers"): unknown params, form-string coercion, enums. Required-ness stays in handlers.
import { readFileSync } from "node:fs";
import { TwinError, fail } from "./errors.ts";

// Request schemas in the pruned spec use only type/properties/additionalProperties/items/enum/anyOf.
interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
}
type Obj = Record<string, unknown>;

const spec = JSON.parse(readFileSync(new URL("./spec/openapi.pruned.json", import.meta.url), "utf8"));
const EXPAND: Schema = { type: "array", items: { type: "string" } };
const schemas = new Map<string, Schema>();

/** Query parameters and form body fields of one operation, as one object schema. */
function requestSchema(op: string): Schema {
  const [method, path] = op.split(" ");
  const o = spec.paths[path!]?.[method!];
  if (!o) throw new Error(`validate: no operation "${op}" in the pruned spec`);
  const query = (o.parameters ?? []).filter((p: { in: string }) => p.in === "query").map((p: { name: string; schema: Schema }) => [p.name, p.schema]);
  const body = o.requestBody?.content?.["application/x-www-form-urlencoded"]?.schema?.properties ?? {};
  return { type: "object", properties: { expand: EXPAND, ...Object.fromEntries(query), ...body } };
}

/** Returns the coerced params; throws TwinError on the first invalid one. */
export function validate(op: string, params: Obj): Obj {
  let s = schemas.get(op);
  if (!s) schemas.set(op, (s = requestSchema(op)));
  return check(s, params, "") as Obj;
}

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object";

function check(s: Schema, v: unknown, name: string): unknown {
  if (v === "") return v; // "" means unset; handlers decide what that does
  if (s.anyOf) {
    const errs: TwinError[] = [];
    for (const b of s.anyOf) {
      try {
        return check(b, v, name);
      } catch (e) {
        if (!(e instanceof TwinError)) throw e;
        errs.push(e);
      }
    }
    // Report the branch shaped like the value (hash vs scalar): created=abc -> integer error, created[x]=1 -> unknown created[x].
    const i = s.anyOf.findIndex((b) => (b.type === "object" || b.type === "array") === isObj(v));
    throw errs[Math.max(i, 0)];
  }
  const param = { param: name };
  switch (s.type) {
    case "object": {
      if (Array.isArray(v)) v = Object.fromEntries(v.entries()); // metadata[0]=x parsed as an array
      if (!isObj(v)) fail("parameter_invalid", param);
      const { properties, additionalProperties } = s;
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          const key = name ? `${name}[${k}]` : k;
          const sub = properties ? (Object.hasOwn(properties, k) ? properties[k] : undefined) : isObj(additionalProperties) ? additionalProperties : {};
          if (!sub) fail("parameter_unknown", { param: key });
          return [k, check(sub, x, key)];
        }),
      );
    }
    case "array": {
      if (!isObj(v)) fail("parameter_invalid", param);
      return Object.values(v).map((x, i) => check(s.items ?? {}, x, `${name}[${i}]`));
    }
    case "integer":
      if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
      return fail("parameter_invalid_integer", param);
    case "number":
      if (typeof v === "string" && /^-?(\d+\.?\d*|\.\d+)$/.test(v)) return Number(v);
      return fail("parameter_invalid", param);
    case "boolean":
      if (v === "true" || v === "false") return v === "true";
      return fail("parameter_invalid", param);
    case "string":
      if (typeof v !== "string") fail("parameter_invalid", param);
      if (s.enum && !s.enum.includes(v)) fail("parameter_invalid_enum", param);
      return v;
    default:
      return v;
  }
}
