import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpus, parseSeeds } from "../src/bench/corpus.ts";
import { TEMPLATES } from "../templates/index.ts";

const SEEDS = [1, 2, 3, 4, 5];
const corpus = buildCorpus(TEMPLATES, SEEDS);

test("catalog: 31 unique names, #7/#9/#12/#18/#21/#28 held out", () => {
  assert.equal(TEMPLATES.length, 31);
  assert.equal(new Set(TEMPLATES.map((t) => t.name)).size, 31);
  assert.deepEqual(
    TEMPLATES.filter((t) => t.heldOut).map((t) => t.name),
    ["subscription-cancel-at-period-end", "refund-partial-then-rest", "invalid-params", "subscription-update-quantity", "boundaries-list-limits", "clock-trial-end"],
  );
});

test("buildCorpus is deterministic, seed-sensitive, with unique ids", () => {
  assert.deepEqual(buildCorpus(TEMPLATES, SEEDS), corpus);
  assert.equal(corpus.length, TEMPLATES.length * SEEDS.length);
  assert.equal(new Set(corpus.map((s) => s.id)).size, corpus.length);
  assert.equal(corpus[0]!.id, "customer-crud#1");
  assert.equal(corpus[0]!.heldOut, false);
  for (const t of TEMPLATES) {
    const [a, b] = corpus.filter((s) => s.template === t.name);
    assert.notDeepEqual(a!.steps, b!.steps, `${t.name}: seeds 1 and 2 built identical steps`);
  }
});

test("every sequence has >= 2 steps", () => {
  for (const s of corpus) assert.ok(s.steps.length >= 2, s.id);
});

test("refs are bound earlier, $run only in headers, list calls are scoped, email lists guarded by created[gte]", () => {
  const REF = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const refsIn = (v: unknown): string[] =>
    typeof v === "string"
      ? [...v.matchAll(REF)].map((m) => m[1]!)
      : v !== null && typeof v === "object"
        ? Object.values(v).flatMap(refsIn)
        : [];
  const SCOPES = ["customer", "subscription", "product", "payment_intent", "email"];
  for (const s of corpus) {
    const bound = new Set<string>();
    for (const [i, step] of s.steps.entries()) {
      const where = `${s.id} step ${i}`;
      for (const r of refsIn([step.path, step.params])) {
        assert.notEqual(r, "run", `${where}: $run outside headers`);
        assert.ok(bound.has(r), `${where}: $${r} not bound by an earlier step`);
      }
      for (const r of refsIn(step.headers)) assert.ok(r === "run" || bound.has(r), `${where}: $${r} unbound`);
      if (step.method === "GET" && /^\/v1\/[a-z_]+$/.test(step.path)) {
        assert.ok(SCOPES.some((k) => step.params?.[k] !== undefined), `${where}: unscoped list ${step.path}`);
      }
      // Deterministic emails recur across runs of a seed: an email-scoped list or search must also filter on creation time.
      if (step.method === "GET" && step.params?.email !== undefined) assert.deepEqual(step.params.created, { gte: "$c1.created" }, `${where}: email list without created[gte]`);
      const query = step.params?.query;
      if (typeof query === "string" && query.includes("email:")) assert.match(query, / AND created>=\$c1\.created$/, `${where}: email search without created>=`);
      if (step.ref) bound.add(step.ref);
    }
  }
});

test("clock templates: one clock, at most 3 customers on it, at most 2 advances (5 invoices a subscription), each waited out, the clock deleted last", () => {
  for (const s of corpus.filter((q) => q.stratum === "clocks")) {
    const count = (f: (step: (typeof s.steps)[number]) => boolean) => s.steps.filter(f).length;
    assert.equal(count((st) => st.method === "POST" && st.path === "/v1/test_helpers/test_clocks"), 1, s.id);
    assert.ok(count((st) => st.method === "POST" && st.path === "/v1/customers") <= 3, s.id);
    // Each advance spans at most two intervals: the first invoice plus two renewals per advance stays within 5.
    assert.ok(count((st) => st.path.endsWith("/advance")) <= 2, s.id);
    // The next step waits out the advance: sandbox advances reached `ready` within 24 s (reports/2026-09-27-clocks.md),
    // and an advancing clock refuses modifications (429).
    for (const [i, st] of s.steps.entries()) {
      if (!st.path.endsWith("/advance")) continue;
      const next = s.steps[i + 1];
      assert.deepEqual([next?.method, next?.path], ["GET", "/v1/test_helpers/test_clocks/$ck.id"], `${s.id} step ${i + 1}`);
      assert.ok((next?.waitMs ?? 0) >= 40_000, `${s.id} step ${i + 1}: waits ${next?.waitMs} ms`);
    }
    assert.deepEqual([s.steps.at(-1)!.method, s.steps.at(-1)!.path], ["DELETE", "/v1/test_helpers/test_clocks/$ck.id"], s.id);
  }
});

test("clock-declined-renewal: its second advance is waited out for >= 600 s (declined-card advances took 208–393 s)", () => {
  for (const s of corpus.filter((q) => q.template === "clock-declined-renewal")) {
    const advances = s.steps.flatMap((st, i) => (st.path.endsWith("/advance") ? [i] : []));
    assert.equal(advances.length, 2, s.id);
    assert.ok((s.steps[advances[1]! + 1]!.waitMs ?? 0) >= 600_000, `${s.id}: waits ${s.steps[advances[1]! + 1]!.waitMs} ms`);
  }
});

test("subscription-interval-swap: monthly to annual, no billing_cycle_anchor, seeds 1-20 take every proration_behavior", () => {
  const seqs = buildCorpus(TEMPLATES.filter((t) => t.name === "subscription-interval-swap"), parseSeeds("1-20"));
  const behaviors = new Set<unknown>();
  for (const s of seqs) {
    const step = (ref: string) => s.steps.find((st) => st.ref === ref)!;
    assert.deepEqual([step("pr1").params?.recurring, step("pr2").params?.recurring], [{ interval: "month" }, { interval: "year" }], s.id);
    const [update, retrieve, list] = s.steps.slice(-3);
    assert.deepEqual([update!.method, update!.path, update!.params?.items], ["POST", "/v1/subscriptions/$s1.id", [{ id: "$s1.items.data.0.id", price: "$pr2.id" }]], s.id);
    assert.deepEqual(Object.keys(update!.params!).sort(), ["items", "proration_behavior"], s.id);
    behaviors.add(update!.params!.proration_behavior);
    assert.deepEqual([retrieve, list], [{ method: "GET", path: "/v1/subscriptions/$s1.id" }, { method: "GET", path: "/v1/invoices", params: { customer: "$c1.id" } }], s.id);
  }
  assert.deepEqual([...behaviors].sort(), ["always_invoice", "create_prorations", "none"]);
});

test("parseSeeds", () => {
  assert.deepEqual(parseSeeds("1-20"), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(parseSeeds("3,5,9"), [3, 5, 9]);
  assert.deepEqual(parseSeeds("1-3,7"), [1, 2, 3, 7]);
  assert.deepEqual(parseSeeds(" 4 , 2-3 ,3"), [4, 2, 3]);
  for (const bad of ["", "a", "5-3", "1-", "1.5", "1,,2", "-1"]) assert.throws(() => parseSeeds(bad), /invalid seed spec/, bad);
});
