// Minimal Anthropic Messages API client over fetch (the idea of Slim's src/generate/llm.ts), with a cost ledger:
// every call's tokens and cost_usd go to budget/llm.jsonl, and a call is refused before it is sent when today's (UTC)
// spend plus its worst-case estimate would pass the daily cap (plan §9: $15/day; PARITY_LLM_CAP_USD may only lower it).
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonl } from "../jsonl.ts";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const MAX_TOKENS = 8192;
export const HARD_CAP_USD = 15;

/**
 * USD per million tokens. Source: the claude-api skill's model table (Anthropic first-party API rates, cached
 * 2026-06-24), checked 2026-09-26; cache writes (5-minute TTL) cost 1.25x input and cache reads 0.1x input.
 * `temperature0`: the model accepts temperature 0. Claude Sonnet 5 and Opus 4.7+ reject non-default sampling
 * parameters with a 400, so temperature is sent only where it is accepted.
 */
export const PRICES: Record<string, { input: number; output: number; temperature0?: boolean }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15, temperature0: true },
  "claude-haiku-4-5": { input: 1, output: 5, temperature0: true },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}
export interface LlmEntry {
  date: string; // ISO
  runId: string;
  purpose: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  stop_reason: string | null;
}
export type Env = Record<string, string | undefined>;

/** Thrown before anything is sent when the call would pass the daily cap. */
export class CapRefused extends Error {}

const price = (model: string) => PRICES[model] ?? fail(`no price for model "${model}" (PARITY_LLM_MODEL): add it to PRICES in src/align/llm.ts`);
function fail(msg: string): never {
  throw new Error(msg);
}

export function costUsd(model: string, u: Usage): number {
  const p = price(model);
  const tokens = u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 + (u.cache_read_input_tokens ?? 0) * p.input * 0.1;
  return tokens / 1e6;
}

/** The daily cap: $15, or PARITY_LLM_CAP_USD when that is lower. */
export function capUsd(env: Env): number {
  const v = env.PARITY_LLM_CAP_USD;
  if (v === undefined || v === "") return HARD_CAP_USD;
  const n = Number(v);
  if (!(n >= 0)) throw new Error(`PARITY_LLM_CAP_USD must be a non-negative number, got "${v}"`);
  return Math.min(n, HARD_CAP_USD);
}

export const readLlmLedger = (path: string): LlmEntry[] => (existsSync(path) ? readJsonl<LlmEntry>(path) : []);
/** cost_usd of the ledger entries dated on `now`'s UTC day. */
export const spentToday = (entries: LlmEntry[], now: Date): number =>
  entries.filter((e) => e.date.slice(0, 10) === now.toISOString().slice(0, 10)).reduce((s, e) => s + e.cost_usd, 0);

export interface Reply {
  text: string;
  model: string;
  stop_reason: string | null;
  usage: Usage;
  cost_usd: number;
}

/**
 * One Messages API call (max_tokens 8192; temperature 0 where the model accepts it). Refused with CapRefused when
 * today's spend + a worst-case estimate (prompt chars / 2 input tokens, max_tokens output) would pass the cap. The
 * reply is ledgered whatever its stop_reason; only the text blocks are returned.
 */
export async function complete(
  req: { system: string; user: string; runId: string; purpose: string },
  o: { ledger: string; env?: Env; now?: () => Date },
): Promise<Reply> {
  const env = o.env ?? process.env;
  const now = o.now ?? (() => new Date());
  const apiKey = env.ANTHROPIC_API_KEY || fail("ANTHROPIC_API_KEY is not set");
  const model = env.PARITY_LLM_MODEL || DEFAULT_MODEL;
  const p = price(model);
  const cap = capUsd(env);
  const spent = spentToday(readLlmLedger(o.ledger), now());
  // ponytail: chars/2 over-estimates input tokens for code and JSON; /v1/messages/count_tokens would make it exact.
  const estimate = costUsd(model, { input_tokens: Math.ceil((req.system.length + req.user.length) / 2), output_tokens: MAX_TOKENS });
  if (spent + estimate > cap) {
    throw new CapRefused(`LLM cap: $${spent.toFixed(4)} spent today (UTC) + $${estimate.toFixed(4)} estimated for this call > cap $${cap} (${o.ledger}; PARITY_LLM_CAP_USD)`);
  }
  const redact = (s: string) => s.split(apiKey).join("[REDACTED]");
  const url = `${(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        ...(p.temperature0 ? { temperature: 0 } : {}),
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new Error(`LLM network error: ${redact(String(e))}`);
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${redact(raw.slice(0, 400))}`);
  const json = JSON.parse(raw) as { content?: { type: string; text?: string }[]; stop_reason?: string | null; usage?: Usage };
  if (!json.usage) throw new Error(`LLM reply without usage: ${redact(raw.slice(0, 400))}`);
  const u = json.usage;
  const cost_usd = costUsd(model, u);
  const entry: LlmEntry = {
    date: now().toISOString(),
    runId: req.runId,
    purpose: req.purpose,
    model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cost_usd,
    stop_reason: json.stop_reason ?? null,
  };
  mkdirSync(dirname(o.ledger), { recursive: true });
  appendFileSync(o.ledger, JSON.stringify(entry) + "\n");
  const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return { text, model, stop_reason: entry.stop_reason, usage: u, cost_usd };
}
