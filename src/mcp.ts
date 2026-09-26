// `paritybench mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) over an in-process twin.
// One tool per twin route, named from its spec operation ("post /v1/subscriptions" -> post_v1_subscriptions), with the
// pruned spec's request schema as input schema; plus parity_reset and parity_state. It speaks the initialize-handshake
// revisions (2025-11-25 and earlier): the stateless 2026-07-28 revision has no initialize. A dual-era client's
// server/discover probe gets -32601 and falls back to initialize.
import { readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { encodeForm } from "./bench/run.ts";
import { createTwin, type Route, type TwinRequest } from "./twin/server.ts";

type Obj = Record<string, unknown>;
interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema: Obj;
}
interface Tool {
  def: { name: string; description: string; inputSchema: Obj };
  /** Throws on arguments the call cannot be built from (a missing path parameter). */
  req(args: Obj): TwinRequest;
}

/** Handshake revisions answered as requested; any other requested version gets the first (newest). */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const AUTH = { authorization: "Bearer sk_test_parity" };
const NO_ARGS = { type: "object", additionalProperties: false };

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

/** A tool for one spec operation ("get /v1/customers/{customer}"): path, query and form body params as one object. */
function opTool(spec: { paths: Record<string, Record<string, Obj>> }, op: string): Tool {
  const [method, path] = op.split(" ") as [string, string];
  const o = spec.paths[path]![method]! as { summary: string; parameters?: Param[]; requestBody?: Obj };
  const params = (o.parameters ?? []).filter((p) => p.in === "path" || p.in === "query");
  const body = ((o.requestBody?.content as Obj | undefined)?.["application/x-www-form-urlencoded"] as { schema?: Obj } | undefined)?.schema ?? {};
  const M = method.toUpperCase();
  return {
    def: {
      name: op.replace(/[^A-Za-z0-9]+/g, "_").replace(/_$/, ""),
      description: `${o.summary}: ${M} ${path} on the Parity twin.`,
      inputSchema: {
        type: "object",
        properties: { ...Object.fromEntries(params.map((p) => [p.name, p.schema])), ...(body.properties as Obj | undefined) },
        required: [...params.filter((p) => p.required).map((p) => p.name), ...((body.required as string[] | undefined) ?? [])],
      },
    },
    req(args) {
      const rest = { ...args };
      const url = path.replace(/\{(\w+)\}/g, (_, n: string) => {
        const v = rest[n];
        delete rest[n];
        if (typeof v !== "string" || !v) throw new Error(`missing path parameter "${n}" (a non-empty string)`);
        return encodeURIComponent(v);
      });
      const form = encodeForm(rest);
      return { method: M, path: url, headers: AUTH, ...(M === "POST" ? { body: form } : { query: form }) };
    },
  };
}

/** Serves MCP on stdin/stdout until stdin ends; resolves 0. Nothing but JSON-RPC messages goes to stdout. */
export async function main(): Promise<number> {
  const spec = read("./twin/spec/openapi.pruned.json");
  // The twin's route table, loaded as server.ts loads it (it does not export it).
  // ponytail: duplicates server.ts's loader; export RESOURCE_ROUTES there and use it.
  const dir = new URL("./twin/resources/", import.meta.url);
  const modules = await Promise.all(
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => import(new URL(f, dir).href) as Promise<{ routes?: Route[] }>),
  );
  // One tool per operation: GET /v1/invoices/upcoming borrows the list's operation for validation and gets no tool.
  const ops = new Set(modules.flatMap((m) => (m.routes ?? []).map((r) => r[3])));
  const tools = new Map<string, Tool>(
    [
      ...[...ops].map((op) => opTool(spec, op)),
      { def: { name: "parity_reset", description: "Clears all twin state (POST /_parity/reset).", inputSchema: NO_ARGS }, req: () => ({ method: "POST", path: "/_parity/reset" }) },
      { def: { name: "parity_state", description: "The twin's store: live objects, deleted objects, event count (GET /_parity/state).", inputSchema: NO_ARGS }, req: () => ({ method: "GET", path: "/_parity/state" }) },
    ].map((t) => [t.def.name, t]),
  );
  const twin = createTwin();
  const version = read("../package.json").version as string;

  const respond = async (id: unknown, method: string, params: Obj): Promise<Obj> => {
    const result = (result: Obj) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize") {
      const v = params.protocolVersion as string;
      return result({ protocolVersion: VERSIONS.includes(v) ? v : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "parity-twin", version } });
    }
    if (method === "tools/list") return result({ tools: [...tools.values()].map((t) => t.def) });
    if (method !== "tools/call") return error(-32601, `Method not found: ${method}`);
    const tool = tools.get(params.name as string);
    if (!tool) return error(-32602, `Unknown tool: ${params.name}`);
    const args = (params.arguments ?? {}) as Obj;
    // API errors and unbuildable arguments are tool results (isError), so the model can correct them.
    let text: string;
    let isError: boolean;
    try {
      const r = await twin.handle(tool.req(args));
      text = JSON.stringify({ status: r.status, body: r.body }, null, 2);
      isError = r.status >= 400;
    } catch (e) {
      text = (e as Error).message;
      isError = true;
    }
    return result({ content: [{ type: "text", text }], isError });
  };

  const send = (m: Obj) => process.stdout.write(JSON.stringify(m) + "\n");
  // Sequential: each message is answered before the next is read, so responses keep request order.
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg: Obj;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
      send({ jsonrpc: "2.0", id: (msg as Obj | null)?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    if (!("id" in msg)) continue; // a notification (notifications/initialized, cancellations): no reply
    send(await respond(msg.id, msg.method, (msg.params ?? {}) as Obj));
  }
  return 0;
}
