import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
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
import { compareRecordings } from "../src/bench/compare.ts";
import { readJsonl, writeJsonl } from "../src/jsonl.ts";
import { createTwin } from "../src/twin/server.ts";
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
const EVENTS = [
  ev("evt_A", 100, "customer.updated", { id: CUS }),
  ev("evt_B", 99, "customer.created", { id: "cus_OtherAbc12345" }),
  ev("evt_C", 100, "checkout.session.completed", { id: "cs_TestSess12345", customer: CUS }),
  ev("evt_E", 97, "noise", { id: "create_prorations" }),
  ev("evt_D", 98, "customer.subscription.created", { id: SUB }),
];
let events = EVENTS; // served 4 per page, like a newest-first Stripe list
let eventFaults: number[] = []; // statuses /v1/events answers (in order) before serving pages
let onEventsGet: (() => void) | undefined; // runs before each /v1/events answer (events arriving mid-sweep)
let limited = false; // every non-events request answers 429, like a rate-limited key
let clocks: string[] = []; // the account's test clocks, newest first, listed 1 per page
let clockN = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
  const url = new URL(req.url!, "http://local");
  const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "request-id": "req_local", ...headers });
    res.end(JSON.stringify(obj));
  };
  if (limited && url.pathname !== "/v1/events") {
    return json(429, { error: { type: "rate_limit_error" } }, { "retry-after": "1", "stripe-rate-limited-reason": "global-rate" });
  }
  if (req.method === "POST" && url.pathname === "/v1/customers") {
    return json(
      200,
      { id: CUS, object: "customer", count: 7, proration_behavior: "create_prorations", subscriptions: { data: [{ id: SUB }] } },
      { "idempotent-replayed": "false" },
    );
  }
  if (url.pathname === "/v1/test_helpers/test_clocks") {
    if (req.method === "POST") {
      clocks.unshift(`clock_Test${String(++clockN).padStart(10, "0")}`);
      return json(200, { id: clocks[0], object: "test_helpers.test_clock" });
    }
    const after = url.searchParams.get("starting_after");
    const from = after ? clocks.indexOf(after) + 1 : 0;
    return json(200, { object: "list", has_more: from + 1 < clocks.length, data: clocks.slice(from, from + 1).map((id) => ({ id, object: "test_helpers.test_clock" })) });
  }
  const clock = /^\/v1\/test_helpers\/test_clocks\/(\w+)$/.exec(url.pathname);
  if (clock && req.method === "DELETE") {
    if (!clocks.includes(clock[1]!)) return json(404, { error: { type: "invalid_request_error" } });
    clocks = clocks.filter((c) => c !== clock[1]);
    return json(200, { id: clock[1], object: "test_helpers.test_clock", deleted: true });
  }
  const obj = /^\/v1\/(\w+)s\/(\w+)$/.exec(url.pathname); // GET/DELETE /v1/<type>s/<id> echoes the id
  if (obj && req.method !== "POST") return json(200, { id: obj[2], object: obj[1] });
  if (url.pathname === "/v1/flaky") return ++flakyHits === 1 ? json(429, { error: { type: "rate_limit" } }) : json(200, { ok: true });
  if (url.pathname === "/v1/text") return void res.end("not json");
  if (url.pathname === "/v1/events") {
    onEventsGet?.();
    const fault = eventFaults.shift();
    if (fault) return json(fault, { error: { type: "api_error" } });
    const before = url.searchParams.get("ending_before"); // the 4 events just newer than the cursor; has_more = even newer ones exist
    if (before) {
      const end = events.findIndex((e) => e.id === before);
      return json(200, { object: "list", has_more: end > 4, data: events.slice(Math.max(0, end - 4), end) });
    }
    const after = url.searchParams.get("starting_after");
    const from = after ? events.findIndex((e) => e.id === after) + 1 : 0;
    return json(200, { object: "list", has_more: from + 4 < events.length, data: events.slice(from, from + 4) });
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

/** The pagination cursor of a /v1/events request ("" for the first page of a full list). */
const cursor = (url: string): string => {
  const q = new URL(url, "http://x").searchParams;
  for (const k of ["starting_after", "ending_before"]) if (q.has(k)) return `${k}=${q.get(k)}`;
  return "";
};

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
  assert.ok(ms >= 995, `took ${ms} ms`);
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
  assert.deepEqual(polls.map((r) => cursor(r.url)), ["", "starting_after=evt_E", "ending_before=evt_A", "ending_before=evt_A"], "full list, then two empty incremental passes");
  const q = new URL(polls[0]!.url, "http://x").searchParams;
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

test("runCorpus: worker pool returns results in input order; eventWaitMs 0 skips the sweep", async () => {
  seen.length = 0;
  const target = { ...local, eventWaitMs: 0 };
  const seqs = ["a#1", "b#2", "c#3"].map((id) => seq([{ method: "GET", path: `/v1/customers/${CUS}` }], id));
  const got: string[] = [];
  const { recordings: recs, summary } = await runCorpus(seqs, target, { concurrency: 2, runId: "r", onRecord: (r) => got.push(r.seq) });
  assert.deepEqual(recs.map((r) => r.seq), ["a#1", "b#2", "c#3"]);
  assert.deepEqual(got.sort(), ["a#1", "b#2", "c#3"]);
  assert.ok(recs.every((r) => r.steps[0]!.status === 200));
  assert.equal(summary.eventSweepGets, 0);
  assert.equal(seen.length, 3);
});

test("runCorpus: ONE sweep assigns interleaved events to two sequences; summary counts every request sent", async () => {
  seen.length = 0;
  flakyHits = 0;
  const CUS2 = "cus_TestTwo2345678";
  const PROD = "prod_SharedAb1234"; // seen by both sequences -> its event is an overlap
  events = [
    ev("evt_7", 104, "product.updated", { id: PROD }),
    ev("evt_6", 103, "customer.deleted", { id: CUS2 }),
    ev("evt_5", 103, "customer.created", { id: "cus_Unrelated12345" }),
    ev("evt_4", 102, "invoice_payment.paid", { id: "inpay_Abc12345678", customer: CUS }),
    ev("evt_3", 102, "invoice.finalized", { id: "in_Abc1234567890", customer: CUS }),
    ev("evt_2", 101, "customer.created", { id: CUS2 }),
    ev("evt_1", 101, "customer.created", { id: CUS }),
  ];
  eventFaults = [429]; // first event page is rate-limited once
  const seqs = [
    seq([{ method: "POST", path: "/v1/customers" }, { method: "GET", path: `/v1/products/${PROD}` }], "a#1"),
    seq(
      [
        { method: "GET", path: `/v1/customers/${CUS2}` },
        { method: "POST", path: "/v1/flaky" },
        { method: "GET", path: `/v1/products/${PROD}` },
        { method: "DELETE", path: `/v1/customers/${CUS2}` },
      ],
      "b#2",
    ),
  ];
  const { recordings: [a, b], summary } = await runCorpus(seqs, local, { concurrency: 2, runId: "r" });
  events = EVENTS;

  // same created: code-point order puts "invoice.finalized" before "invoice_payment.paid" (localeCompare reverses them)
  assert.deepEqual(a!.events.map((e) => e.id), ["evt_1", "evt_3", "evt_4", "evt_7"]);
  assert.deepEqual(b!.events.map((e) => e.id), ["evt_2", "evt_6", "evt_7"]);
  assert.equal(a!.eventsError, undefined);

  // one corpus sweep (2 pages, then two empty incremental passes), not per-sequence polls
  const polls = seen.filter((r) => r.url.startsWith("/v1/events"));
  assert.deepEqual(polls.map((r) => cursor(r.url)), ["", "", "starting_after=evt_4", "ending_before=evt_7", "ending_before=evt_7"], "429 + retry + page 2, then 2 incremental passes");
  const gte = Number(new URL(polls[0]!.url, "http://x").searchParams.get("created[gte]"));
  assert.ok(Math.abs(gte - (Math.floor(Date.parse(a!.startedAt) / 1000) - 60)) <= 1, `created[gte]=${gte}`);

  const count = (m: string) => seen.filter((r) => r.method === m).length;
  assert.deepEqual(summary, {
    requests: seen.length,
    gets: count("GET"),
    posts: count("POST"),
    deletes: count("DELETE"),
    eventSweepGets: polls.length,
    retries429: 2, // /v1/flaky once, first event page once
    eventOverlaps: 1, // evt_7
  });
  assert.deepEqual([summary.requests, summary.gets, summary.posts, summary.deletes], [12, 8, 3, 1]);
});

test("a 500 from /v1/events sets eventsError (corpus sweep and per-sequence) and the event check is skipped", async () => {
  eventFaults = [500, 500];
  const one = seq([{ method: "POST", path: "/v1/customers" }]);
  const { recordings: [c] } = await runCorpus([one], local, { concurrency: 1, runId: "r" });
  const s = await runSequence(one, local, { take: noop, runId: "r" });
  assert.deepEqual([c!.eventsError, c!.events], ["GET /v1/events -> 500", []]);
  assert.deepEqual([s.eventsError, s.events], ["GET /v1/events -> 500", []]);

  const withEvents = { ...structuredClone(c!), eventsError: undefined, events: [ev("evt_1", 1, "customer.created", { id: CUS })] };
  const r = compareRecordings(c!, withEvents);
  assert.deepEqual([r.eventsSkipped, r.eventsMatch, r.L4, r.divergences], [true, true, true, []]);
});

test("runCorpus: incremental sweep pages the events once, then fetches only newer ones (ending_before chain)", async () => {
  seen.length = 0;
  const e = (n: number) => ev(`evt_${n}`, 100 + n, "customer.updated", { id: CUS });
  const upTo = (hi: number, lo = 1) => Array.from({ length: hi - lo + 1 }, (_, i) => e(hi - i)); // newest first
  events = upTo(9);
  let gets = 0;
  onEventsGet = () => {
    if (++gets === 4) events = [...upTo(15, 10), ...events]; // 6 new events land after the first full list
  };
  const one = [seq([{ method: "POST", path: "/v1/customers" }])];
  const { recordings: [a], summary } = await runCorpus(one, local, { concurrency: 1, runId: "r" });
  const polls = seen.filter((r) => r.url.startsWith("/v1/events")).map((r) => cursor(r.url));
  assert.deepEqual(polls, [
    "", // full list: 3 pages of 4
    "starting_after=evt_6",
    "starting_after=evt_2",
    "ending_before=evt_9", // pass 1: the 6 newer events, oldest page first
    "ending_before=evt_13",
    "ending_before=evt_15", // passes 2-3: nothing new twice -> stop
    "ending_before=evt_15",
  ]);
  assert.equal(summary.eventSweepGets, 7, "pages of events + one GET per empty pass, not pages x passes");
  assert.deepEqual(a!.events.map((x) => x.id), upTo(15).reverse().map((x) => x.id));

  // An empty first list has no cursor: repeat passes re-list in full until an event appears.
  seen.length = 0;
  events = [];
  gets = 0;
  onEventsGet = () => {
    if (++gets === 2) events = [e(1)];
  };
  const { recordings: [b], summary: s2 } = await runCorpus(one, local, { concurrency: 1, runId: "r" });
  onEventsGet = undefined;
  events = EVENTS;
  assert.deepEqual(seen.filter((r) => r.url.startsWith("/v1/events")).map((r) => cursor(r.url)), ["", "", "ending_before=evt_1", "ending_before=evt_1"]);
  assert.equal(s2.eventSweepGets, 4);
  assert.deepEqual(b!.events.map((x) => x.id), ["evt_1"]);
});

test("runCorpus: headersFor(seq) goes on every step of that sequence, is recorded, and step headers win", async () => {
  seen.length = 0;
  const steps: Step[] = [
    { method: "POST", path: "/v1/customers", headers: { "Idempotency-Key": "$run" } },
    { method: "GET", path: `/v1/customers/${CUS}` },
    { method: "GET", path: `/v1/customers/${CUS}`, headers: { "Parity-Now": "5" } },
  ];
  const now: Record<string, string> = { "a#1": "1790000000", "b#2": "1790086400" };
  const { recordings } = await runCorpus([seq(steps, "a#1"), seq(steps, "b#2")], { ...local, eventWaitMs: 0 }, {
    concurrency: 2,
    runId: "r",
    headersFor: (s) => ({ "Parity-Now": now[s.id]! }),
  });
  for (const r of recordings) {
    const t = now[r.seq]!;
    assert.deepEqual(r.steps.map((s) => s.headers), [{ "Parity-Now": t, "Idempotency-Key": runNonce("r", r.seq) }, { "Parity-Now": t }, { "Parity-Now": "5" }]);
  }
  const sent = (id: string) => seen.filter((x) => x.headers["idempotency-key"] === runNonce("r", id) || x.headers["parity-now"] === now[id]);
  assert.deepEqual(sent("a#1").map((x) => x.headers["parity-now"]), ["1790000000", "1790000000"]);
  assert.deepEqual(sent("b#2").map((x) => x.headers["parity-now"]), ["1790086400", "1790086400"]);
  assert.equal(seen.filter((x) => x.headers["parity-now"] === "5").length, 2);
});

test("runCorpus: maxGets halts the run when the read budget is spent; the halted GET is never sent, the rest is recorded as not sent", async () => {
  seen.length = 0;
  const steps: Step[] = [
    { method: "GET", path: `/v1/customers/${CUS}` },
    { method: "POST", path: "/v1/customers" },
    { method: "GET", path: `/v1/subscriptions/${SUB}` },
  ];
  const { recordings, summary } = await runCorpus([seq(steps, "a#1"), seq(steps, "a#2")], local, { concurrency: 1, runId: "r", maxGets: 3 });
  const reason = "run halted: the read budget allowed 3 more sandbox GETs and they are spent (decision 0001 C2/R7)";
  assert.equal(summary.aborted, reason);
  assert.equal(summary.gets, 3);
  assert.equal(seen.filter((r) => r.method === "GET").length, 3, "no fourth GET reached the server");
  assert.deepEqual(recordings.map((r) => r.steps.map((s) => s.status)), [[200, 200, 200], [200, 200, 0]]);
  assert.ok(recordings.every((r) => r.eventsError === `not collected: ${reason}`), "no event sweep past the budget");
});

test("runCorpus deleteLeftoverClocks: deletes this run's clocks the account still lists, never another's, after the sweep; within the read budget", async () => {
  seen.length = 0;
  clocks = ["clock_Foreign12345678"]; // not this run's: never deleted
  const create: Step = { ref: "ck", method: "POST", path: "/v1/test_helpers/test_clocks" };
  const seqs = [seq([create, { method: "DELETE", path: "/v1/test_helpers/test_clocks/$ck.id" }], "a#1"), seq([create], "b#2")]; // b#2 leaks its clock
  const { summary } = await runCorpus(seqs, local, { concurrency: 1, runId: "r", deleteLeftoverClocks: true });
  const leaked = "clock_Test" + String(clockN).padStart(10, "0");
  assert.deepEqual(summary.clocks, { created: 2, leftOver: 1, deleted: 1 });
  assert.deepEqual(clocks, ["clock_Foreign12345678"]);
  // After the event sweep (its delete events stay out of the recordings), only the check: the list pages (1 clock each:
  // the leak, then the foreign one), then the leak's delete.
  const sweepEnd = seen.findLastIndex((r) => r.url.startsWith("/v1/events"));
  assert.ok(sweepEnd > 0, "a sweep ran");
  const check = seen.slice(sweepEnd + 1).map((r) => `${r.method} ${r.url}`);
  assert.deepEqual(check, ["GET /v1/test_helpers/test_clocks?limit=100", `GET /v1/test_helpers/test_clocks?limit=100&starting_after=${leaked}`, `DELETE /v1/test_helpers/test_clocks/${leaked}`]);
  assert.equal(summary.gets, seen.filter((r) => r.method === "GET").length, "the check's GETs are counted (ledgered)");
  assert.equal(summary.deletes, 2);

  // Budget spent: the check's list GET is never sent, and the summary says so.
  seen.length = 0;
  const halted = await runCorpus([seq([create], "c#3")], { ...local, eventWaitMs: 0 }, { concurrency: 1, runId: "r", maxGets: 0, deleteLeftoverClocks: true });
  assert.match(halted.summary.clocks?.error ?? "", /^not sent: run halted: the read budget allowed 0 more sandbox GETs/);
  assert.equal(halted.summary.aborted, undefined, "a complete run is not reported as halted");
  assert.deepEqual(seen.map((r) => r.method), ["POST"]);
  // Without the flag (URL targets), or when the run created no clock, no check.
  seen.length = 0;
  const off = await runCorpus([seq([create], "d#4")], { ...local, eventWaitMs: 0 }, { concurrency: 1, runId: "r" });
  const none = await runCorpus([seq([{ method: "POST", path: "/v1/customers" }], "e#5")], { ...local, eventWaitMs: 0 }, { concurrency: 1, runId: "r", deleteLeftoverClocks: true });
  assert.deepEqual([off.summary.clocks, none.summary.clocks], [undefined, { created: 0, leftOver: 0, deleted: 0 }]);
  assert.deepEqual(seen.map((r) => r.method), ["POST", "POST"]);
  clocks = [];
});

test("runCorpus: circuit breaker aborts after 10 consecutive steps ending 429; rest recorded as not sent, no sweep", { timeout: 30_000 }, async () => {
  seen.length = 0;
  limited = true;
  const steps: Step[] = [
    { method: "GET", path: `/v1/customers/${CUS}` },
    { method: "POST", path: "/v1/customers", waitMs: 300 }, // lets the 10 in-flight 429s land before the check
  ];
  const seqs = Array.from({ length: 11 }, (_, i) => seq(steps, `s#${i}`));
  const { recordings, summary } = await runCorpus(seqs, local, { concurrency: 10, runId: "r" });
  limited = false;
  const reason = "corpus aborted by the circuit breaker: 10 consecutive steps ended 429 after all retries";
  assert.equal(summary.aborted, reason);
  assert.equal(recordings.length, 11);
  for (const r of recordings.slice(0, 10)) {
    assert.deepEqual([r.steps[0]!.status, r.steps[0]!.retries], [429, 3]);
    assert.deepEqual(r.steps[0]!.resHeaders, { "request-id": "req_local", "retry-after": "1", "stripe-rate-limited-reason": "global-rate" });
    assert.deepEqual([r.steps[1]!.status, r.steps[1]!.error], [0, `not sent: ${reason}`]);
  }
  assert.deepEqual(recordings[10]!.steps.map((s) => s.status), [0, 0], "a sequence started after the trip sends nothing");
  assert.ok(recordings.every((r) => r.eventsError === `not collected: ${reason}`));
  assert.equal(seen.filter((r) => r.url.startsWith("/v1/events")).length, 0, "no event sweep into a limited key");
  assert.deepEqual([summary.requests, summary.gets, summary.posts, summary.retries429], [40, 40, 0, 30]);
});

test("the twin's Parity-Error-Key is recorded as resHeaders parity-error-key and is never a divergence", async () => {
  const server = await createTwin().listen(0);
  try {
    const twin: Target = { name: "twin", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 0 };
    const steps: Step[] = [
      { method: "POST", path: "/v1/customers" },
      { method: "GET", path: "/v1/customers/cus_Missing1234567" },
    ];
    const { recordings } = await runCorpus([seq(steps)], twin, { concurrency: 1, runId: "run1" });
    const [ok, missing] = recordings[0]!.steps;
    assert.deepEqual([ok!.status, ok!.resHeaders["parity-error-key"]], [200, undefined]);
    assert.deepEqual([missing!.status, missing!.resHeaders["parity-error-key"]], [404, "resource_missing"]);
    // An oracle (the real API) never sends the header: headers are not compared.
    const oracle = { ...recordings[0]!, steps: recordings[0]!.steps.map((s) => ({ ...s, resHeaders: {} })) };
    assert.deepEqual(compareRecordings(oracle, recordings[0]!).divergences, []);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("runCorpus: with Parity-Now from headersFor, the sweep starts at min(Parity-Now) − 60, so the twin's back-dated events are collected", async () => {
  const now: Record<string, string> = { "a#1": "1790000000", "b#2": "1789990000" }; // days before the wall clock
  const steps: Step[] = [{ method: "POST", path: "/v1/customers" }];
  seen.length = 0;
  await runCorpus([seq(steps, "a#1"), seq(steps, "b#2")], local, { concurrency: 2, runId: "r", headersFor: (s) => ({ "Parity-Now": now[s.id]! }) });
  const gte = seen.filter((r) => r.url.startsWith("/v1/events")).map((r) => new URL(r.url, "http://x").searchParams.get("created[gte]"));
  assert.ok(gte.length > 0 && gte.every((g) => g === String(1789990000 - 60)), `created[gte] ${gte.join(",")}`);

  const server = await createTwin().listen(0);
  try {
    const twin: Target = { name: "twin", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "sk_test_parity", eventWaitMs: 10 };
    const { recordings } = await runCorpus([seq(steps, "a#1"), seq(steps, "b#2")], twin, { concurrency: 2, runId: "r", headersFor: (s) => ({ "Parity-Now": now[s.id]! }) });
    for (const r of recordings) assert.deepEqual(r.events.map((e) => [e.type, e.created]), [["customer.created", Number(now[r.seq])]], r.seq);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- live sandbox smoke (PARITY_LIVE=1) ----
test("live: two create/retrieve/delete sequences, one corpus event sweep", { skip: process.env.PARITY_LIVE !== "1", timeout: 90_000 }, async () => {
  const env = new URL("../.env", import.meta.url);
  if (!process.env.STRIPE_API_KEY && existsSync(env)) process.loadEnvFile(env);
  const key = process.env.STRIPE_API_KEY;
  assert.ok(key, "STRIPE_API_KEY is not set");
  const smoke = (id: string) =>
    seq(
      [
        { ref: "c1", method: "POST", path: "/v1/customers", params: { description: "parity smoke $run" }, headers: { "Idempotency-Key": "$run" } },
        { method: "GET", path: "/v1/customers/$c1.id" },
        { method: "DELETE", path: "/v1/customers/$c1.id" },
      ],
      id,
    );
  const { recordings, summary } = await runCorpus([smoke("live-smoke#1"), smoke("live-smoke#2")], sandboxTarget(key), {
    concurrency: 2,
    runId: `live-${Date.now()}`,
  });
  for (const rec of recordings) {
    assert.deepEqual(rec.steps.map((s) => s.status), [200, 200, 200], JSON.stringify(rec.steps.map((s) => s.body)));
    assert.ok(rec.steps[0]!.resHeaders["request-id"]);
    assert.equal(rec.eventsError, undefined);
    assert.ok(rec.events.some((e) => e.type === "customer.created"), `events: ${rec.events.map((e) => e.type).join(",")}`);
  }
  assert.equal(summary.eventOverlaps, 0);
  assert.ok(summary.eventSweepGets >= 2, `sweep GETs ${summary.eventSweepGets}`);
  assert.deepEqual([summary.gets - summary.eventSweepGets, summary.posts, summary.deletes], [2, 2, 2]);
  assert.equal(summary.requests, summary.gets + summary.posts + summary.deletes);
  console.log(`live summary: ${JSON.stringify(summary)}; events: ${recordings.map((r) => r.events.map((e) => e.type).join(",")).join(" | ")}`);
});
