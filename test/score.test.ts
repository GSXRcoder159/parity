import { test } from "node:test";
import assert from "node:assert/strict";
import type { SeqResult } from "../src/bench/compare.ts";
import { renderMarkdown, toJson } from "../src/bench/report.ts";
import { score, wilson } from "../src/bench/score.ts";
import { RULES } from "../src/bench/normalize.ts";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-4, `${a} ≉ ${b}`);

test("wilson matches known intervals", () => {
  const w = wilson(8, 10);
  assert.equal(w.p, 0.8);
  close(w.lo, 0.4902);
  close(w.hi, 0.9433);
  assert.deepEqual([w.k, w.n], [8, 10]);
  const z = wilson(0, 10);
  assert.equal(z.lo, 0);
  close(z.hi, 0.2775);
  const all = wilson(10, 10);
  close(all.lo, 0.7225);
  assert.equal(all.hi, 1);
  assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 0, k: 0, n: 0 });
});

const res = (template: string, stratum: SeqResult["stratum"], heldOut: boolean, l3: boolean[], L4: boolean): SeqResult => ({
  seq: `${template}#1`,
  template,
  stratum,
  heldOut,
  steps: l3.map((L3, i) => ({ i, L1: true, L2: true, L3 })),
  L4,
  eventsMatch: L4,
  divergences: l3.flatMap((ok, i) =>
    ok ? [] : [{ seq: `${template}#1`, step: i, path: "$.amount_refunded", cls: "VALUE_MISMATCH" as const, expected: 500, actual: 0 }],
  ),
});
const results = [
  res("customer-crud", "lifecycle", false, [true, true, true], true),
  res("refund-full", "refunds", false, [true, false], false),
  res("refund-partial-then-rest", "refunds", true, [false, true, false], false),
];

test("score: L1–L3 per step, L4 per sequence, split by stratum and held-out", () => {
  const s = score(results);
  assert.deepEqual([s.overall.L1.k, s.overall.L1.n], [8, 8]);
  assert.deepEqual([s.overall.L3.k, s.overall.L3.n], [5, 8]);
  assert.deepEqual([s.overall.L4.k, s.overall.L4.n], [1, 3]);
  assert.deepEqual(Object.keys(s.byStratum).sort(), ["lifecycle", "refunds"]);
  assert.deepEqual([s.byStratum.refunds!.L3.k, s.byStratum.refunds!.L3.n], [2, 5]);
  assert.deepEqual([s.heldOut.L3.k, s.heldOut.L3.n, s.heldOut.L4.n], [1, 3, 1]);
  assert.deepEqual([s.train.L3.k, s.train.L3.n, s.train.L4.k, s.train.L4.n], [4, 5, 1, 2]);
});

test("markdown report has every required section; the invalid-score warning depends on noise", () => {
  const s = score(results);
  const base = { title: "W0 noise", date: "2026-09-25", target: "twin", oracle: "sandbox", score: s, normalization: "v1", results };
  const md = renderMarkdown(base);
  for (const h of ["# W0 noise", "**Summary:**", "## Noise floor and ceiling", "## Per stratum", "## Held-out vs train", "## Top divergence paths", "## Per-template L4", "## Normalization"]) {
    assert.ok(md.includes(h), h);
  }
  assert.match(md, /Any score without the noise floor and ceiling is invalid/);
  assert.match(md, /L3 62\.5% \[30\.6–86\.3\] \(8\)/);
  assert.match(md, /\| refunds \| 100\.0% \[56\.6–100\.0\] \(5\) \|/);
  assert.match(md, /\| `\$\.amount_refunded` \| VALUE_MISMATCH \| 3 \| refund-full#1 step 1: expected `500` → actual `0` \|/);
  assert.match(md, /\| refund-partial-then-rest \| refunds \| yes \| 0\.0% \[0\.0–79\.3\] \(1\) \|/);
  for (const r of RULES) assert.ok(md.includes(r.name), r.name);

  const withNoise = renderMarkdown({ ...base, noise: s });
  assert.doesNotMatch(withNoise, /is invalid/);
  assert.match(withNoise, /\| L3 \| 62\.5% \[30\.6–86\.3\] \(8\) \| 37\.5% \[13\.7–69\.4\] \(8\) \| 62\.5% \[30\.6–86\.3\] \(8\) \|/);

  assert.match(renderMarkdown({ ...base, normalization: "raw" }), /`raw`: no normalization rules applied/);
  const trainOnly = results.filter((r) => !r.heldOut);
  assert.match(renderMarkdown({ ...base, score: score(trainOnly), results: trainOnly }), /\| held-out \| — \(0\) \| — \(0\) \| — \(0\) \| — \(0\) \|/);
  const json = JSON.parse(JSON.stringify(toJson(base)));
  assert.equal(json.results.length, 3);
  assert.equal(json.score.overall.L4.n, 3);
  assert.equal(json.rules.length, RULES.length);
});
