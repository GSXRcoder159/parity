import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLimiter,
  encodeForm,
  resolveRefs,
  runCorpus,
  runNonce,
  runSequence,
  sandboxTarget,
  type Target,
} from "../src/bench/run.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import type { Sequence, Step } from "../src/types.ts";

const CUS = "cus_TestAbc12345";
const SUB = "sub_TestXyz67890";
const seq = (steps: Step[], id = "tmpl#1"): Sequence => ({
  id,
  template: "tmpl",
  stratum: "lifecycle",
  seed: 1,
  heldOut: false,
  steps,
});
const noop = async (): Promise<void> => {};

// ---- local fake Stripe ----
const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let flakyHits = 0;
const ev = (id: string, created: number, type: string, object: Record<string, unknown>) => ({
  id,
  object: "event",
  created,
  type,
  data: { object },
});
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
  const url = new URL(req.url!, "http://local");
  const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "request-id": "req_local", ...headers });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "POST" && url.pathname === "/v1/customers") {
    return json(
      200,
      { id: CUS, object: "customer", count: 7, proration_behavior: "create_prorations", subscriptions: { data: [{ id: SUB }] } },
      { "idempotent-replayed": "false" },
    );
  }
  if (req.method === "GET" && url.pathname === `/v1/customers/${CUS}`) return json(200, { id: CUS, object: "customer" });
  if (url.pathname === "/v1/flaky") return ++flakyHits === 1 ? json(429, { error: { type: "rate_limit" } }) : json(200, { ok: true });
  if (url.pathname === "/v1/text") return void res.end("not json");
  if (url.pathname === "/v1/events") {
    if (!url.searchParams.has("starting_after")) {
      return json(200, {
        object: "list",
        has_more: true,
        data: [
          ev("evt_A", 100, "customer.updated", { id: CUS }),
          ev("evt_B", 99, "customer.created", { id: "cus_OtherAbc12345" }),
          ev("evt_C", 100, "checkout.session.completed", { id: "cs_TestSess12345", customer: CUS }),
          ev("evt_E", 97, "noise", { id: "create_prorations" }),
        ],
      });
    }
    if (url.searchParams.get("starting_after") === "evt_E") {
      return json(200, { object: "list", has_more: false, data: [ev("evt_D", 98, "customer.subscription.created", { id: SUB })] });
    }
  }
  json(404, { error: { type: "invalid_request_error" } });
});
let local: Target;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  local = { name: "local", baseUrl: `http://127.0.0.1:${port}`, apiKey: "sk_test_local", eventWaitMs: 10 };
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// ---- pure functions ----
test("encodeForm: Stripe nested form encoding", () => {
  assert.equal(encodeForm({ metadata: { a: "1", "b c": "x&y" } }), "metadata[a]=1&metadata[b%20c]=x%26y");
  assert.equal(
    encodeForm({ items: [{ price: "price_1", quantity: 2 }, { price: "price_2" }] }),
    "items[0][price]=price_1&items[0][quantity]=2&items[1][price]=price_2",
  );
  assert.equal(encodeForm({ a: true, b: false }), "a=true&b=false");
  assert.equal(encodeForm({ coupon: null, skip: undefined, x: "1" }), "coupon=&x=1");
  assert.equal(encodeForm({ amount: 1000, rate: 1.5 }), "amount=1000&rate=1.5");
});

test("resolveRefs: exact refs keep type, interpolation, numeric index, $run, unresolved throws", () => {
  const bound = { c1: { id: CUS, n: 7, obj: { k: 1 } }, s1: { items: { data: [{ id: "si_1" }, { id: "si_2" }] } } };
  assert.equal(resolveRefs("$c1.n", bound, "nonce"), 7);
  assert.deepEqual(resolveRefs("$c1.obj", bound, "nonce"), { k: 1 });
  assert.equal(resolveRefs("/v1/customers/$c1.id/x-$c1.n", bound, "nonce"), `/v1/customers/${CUS}/x-7`);
  assert.equal(resolveRefs("$s1.items.data.1.id", bound, "nonce"), "si_2");
  assert.equal(resolveRefs("$run", bound, "nonce"), "nonce");
  assert.deepEqual(resolveRefs({ k: ["key-$run", 3, null] }, bound, "nonce"), { k: ["key-nonce", 3, null] });
  assert.throws(() => resolveRefs("$c1.nope", bound, "n"), { message: "unresolved ref $c1.nope" });
  assert.throws(() => resolveRefs({ a: "x $c9.id" }, bound, "n"), { message: "unresolved ref $c9.id" });
  assert.throws(() => resolveRefs("$s1.items.data.5.id", bound, "n"), { message: "unresolved ref $s1.items.data.5.id" });
});

test("runNonce replaces non-alphanumerics", () => {
  assert.equal(runNonce("2026-09-25T10:00", "tmpl#3"), "2026-09-25T10-00-tmpl-3");
});

test("createLimiter: 10 takes at rps 5 take >= 1 s", async () => {
  const t0 = performance.now();
  const take = createLimiter(5);
  await Promise.all(Array.from({ length: 10 }, take));
  const ms = performance.now() - t0;
  assert.ok(ms >= 995 && ms < 1500, `took ${ms} ms`);
});

test("jsonl round-trip creates parent dirs", () => {
  const p = join(mkdtempSync(join(tmpdir(), "parity-")), "a", "b.jsonl");
  writeJsonl(p, [{ x: 1 }, { y: "z" }]);
  assert.deepEqual(readJsonl(p), [{ x: 1 }, { y: "z" }]);
});

// ---- runner against the local server ----
test("runSequence end-to-end against a local server", async () => {
  seen.length = 0;
  const nonce = runNonce("run1", "tmpl#1");
  const rec = await runSequence(
    seq([
      {
        ref: "c1",
        method: "POST",
        path: "/v1/customers",
        params: { name: "A B", metadata: { run: "$run" }, preferred_locales: ["en", "fr"] },
        headers: { "Idempotency-Key": "$run" },
      },
      {
        method: "GET",
        path: "/v1/customers/$c1.id",
        params: { tag: "t-$c1.id", n: "$c1.count", sub: "$c1.subscriptions.data.0.id" },
        headers: { Authorization: "Bearer sk_test_override", "X-Probe": "$c1.id" },
      },
      { method: "GET", path: "/v1/customers/$nope.id" },
      { method: "POST", path: "/v1/flaky" },
      { method: "GET", path: "/v1/text" },
    ]),
    local,
    { take: noop, runId: "run1" },
  );
  const [s0, s1, s2, s3, s4] = rec.steps;
  assert.deepEqual(rec.steps.map((s) => s.status), [200, 200, 0, 200, 200]);
  assert.equal(rec.target, "local");
  assert.equal(rec.runId, "run1");
  assert.equal(new Date(rec.startedAt).toISOString(), rec.startedAt);

  // step 0: POST form body, default + step headers sent, only step headers recorded
  const r0 = seen[0]!;
  assert.equal(r0.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(r0.body, `name=A%20B&metadata[run]=${nonce}&preferred_locales[0]=en&preferred_locales[1]=fr`);
  assert.equal(r0.headers.authorization, "Bearer sk_test_local");
  assert.equal(r0.headers["stripe-version"], "2026-08-26.dahlia");
  assert.equal(r0.headers["idempotency-key"], nonce);
  assert.deepEqual(s0!.headers, { "Idempotency-Key": nonce });
  assert.deepEqual(s0!.params, { name: "A B", metadata: { run: nonce }, preferred_locales: ["en", "fr"] });
  assert.deepEqual(s0!.resHeaders, { "request-id": "req_local", "idempotent-replayed": "false" });

  // step 1: refs from step 0 in path, query params and headers; Authorization override sent but never recorded
  const r1 = seen[1]!;
  assert.equal(r1.method, "GET");
  assert.equal(r1.url, `/v1/customers/${CUS}?tag=t-${CUS}&n=7&sub=${SUB}`);
  assert.equal(r1.body, "");
  assert.equal(r1.headers.authorization, "Bearer sk_test_override");
  assert.equal(s1!.path, `/v1/customers/${CUS}`);
  assert.deepEqual(s1!.params, { tag: `t-${CUS}`, n: 7, sub: SUB });
  assert.deepEqual(s1!.headers, { "X-Probe": CUS });
  assert.deepEqual(s1!.body, { id: CUS, object: "customer" });

  // step 2: unresolved ref -> not sent, later steps still run
  assert.deepEqual(s2, { i: 2, method: "GET", path: "/v1/customers/$nope.id", status: 0, body: null, resHeaders: {}, ms: 0, error: "unresolved ref $nope.id" });
  assert.ok(!seen.some((r) => r.url.includes("nope")));

  // step 3: 429 retried once then 200
  assert.equal(s3!.retries, 1);
  assert.deepEqual(s3!.body, { ok: true });
  assert.equal(seen.filter((r) => r.url === "/v1/flaky").length, 2);
  assert.equal(s0!.retries, undefined);

  // step 4: non-JSON body
  assert.deepEqual(s4!.body, { _raw: "not json" });

  // events: filtered by ids seen in bodies (incl. nested + .customer), paginated, sorted by created then type
  assert.deepEqual(rec.events.map((e) => e.id), ["evt_D", "evt_C", "evt_A"]);
  const polls = seen.filter((r) => r.url.startsWith("/v1/events"));
  const firstPages = polls.filter((r) => !r.url.includes("starting_after"));
  assert.equal(firstPages.length, 2, "stops after two polls with the same kept count");
  assert.equal(polls.length, 4);
  const q = new URL(firstPages[0]!.url, "http://x").searchParams;
  assert.equal(q.get("limit"), "100");
  assert.equal(Number(q.get("created[gte]")), Math.floor(Date.parse(rec.startedAt) / 1000) - 60);
  assert.equal(polls[0]!.headers.authorization, "Bearer sk_test_local");
});

test("runSequence: transport error -> status 0; eventWaitMs 0 skips events", async () => {
  const dead: Target = { name: "dead", baseUrl: "http://127.0.0.1:1", apiKey: "k", eventWaitMs: 0 };
  const rec = await runSequence(seq([{ method: "GET", path: "/v1/customers" }]), dead, { take: noop, runId: "r" });
  assert.equal(rec.steps[0]!.status, 0);
  assert.match(rec.steps[0]!.error!, /fetch failed/);
  assert.deepEqual(rec.events, []);
});

test("runCorpus: worker pool returns results in input order", async () => {
  const target = { ...local, eventWaitMs: 0 };
  const seqs = ["a#1", "b#2", "c#3"].map((id) => seq([{ method: "GET", path: `/v1/customers/${CUS}` }], id));
  const got: string[] = [];
  const recs = await runCorpus(seqs, target, { concurrency: 2, runId: "r", onRecord: (r) => got.push(r.seq) });
  assert.deepEqual(recs.map((r) => r.seq), ["a#1", "b#2", "c#3"]);
  assert.deepEqual(got.sort(), ["a#1", "b#2", "c#3"]);
  assert.ok(recs.every((r) => r.steps[0]!.status === 200));
});

// ---- live sandbox smoke (PARITY_LIVE=1) ----
test("live: create, retrieve, delete a customer on the sandbox", { skip: process.env.PARITY_LIVE !== "1", timeout: 60_000 }, async () => {
  if (!process.env.STRIPE_API_KEY) process.loadEnvFile(new URL("../.env", import.meta.url));
  const key = process.env.STRIPE_API_KEY;
  assert.ok(key, "STRIPE_API_KEY is not set");
  const rec = await runSequence(
    seq(
      [
        { ref: "c1", method: "POST", path: "/v1/customers", params: { description: "parity smoke $run" }, headers: { "Idempotency-Key": "$run" } },
        { method: "GET", path: "/v1/customers/$c1.id" },
        { method: "DELETE", path: "/v1/customers/$c1.id" },
      ],
      "live-smoke#1",
    ),
    sandboxTarget(key),
    { take: createLimiter(20), runId: `live-${Date.now()}` },
  );
  assert.deepEqual(rec.steps.map((s) => s.status), [200, 200, 200], JSON.stringify(rec.steps.map((s) => s.body)));
  assert.ok(rec.steps[0]!.resHeaders["request-id"]);
  assert.ok(rec.events.some((e) => e.type === "customer.created"), `events: ${rec.events.map((e) => e.type).join(",")}`);
});
