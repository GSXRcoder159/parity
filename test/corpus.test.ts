import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpus, parseSeeds } from "../src/bench/corpus.ts";
import { TEMPLATES } from "../templates/index.ts";

const SEEDS = [1, 2, 3, 4, 5];
const corpus = buildCorpus(TEMPLATES, SEEDS);

test("catalog: 30 unique names, #7/#9/#12/#18/#21/#28 held out", () => {
  assert.equal(TEMPLATES.length, 30);
  assert.equal(new Set(TEMPLATES.map((t) => t.name)).size, 30);
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

test("clock templates: one clock, at most 3 customers on it, at most 2 advances (5 invoices a subscription), the clock deleted last", () => {
  for (const s of corpus.filter((q) => q.stratum === "clocks")) {
    const count = (f: (step: (typeof s.steps)[number]) => boolean) => s.steps.filter(f).length;
    assert.equal(count((st) => st.method === "POST" && st.path === "/v1/test_helpers/test_clocks"), 1, s.id);
    assert.ok(count((st) => st.method === "POST" && st.path === "/v1/customers") <= 3, s.id);
    // Each advance spans at most two intervals: the first invoice plus two renewals per advance stays within 5.
    assert.ok(count((st) => st.path.endsWith("/advance")) <= 2, s.id);
    assert.deepEqual([s.steps.at(-1)!.method, s.steps.at(-1)!.path], ["DELETE", "/v1/test_helpers/test_clocks/$ck.id"], s.id);
  }
});

test("parseSeeds", () => {
  assert.deepEqual(parseSeeds("1-20"), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(parseSeeds("3,5,9"), [3, 5, 9]);
  assert.deepEqual(parseSeeds("1-3,7"), [1, 2, 3, 7]);
  assert.deepEqual(parseSeeds(" 4 , 2-3 ,3"), [4, 2, 3]);
  for (const bad of ["", "a", "5-3", "1-", "1.5", "1,,2", "-1"]) assert.throws(() => parseSeeds(bad), /invalid seed spec/, bad);
});
