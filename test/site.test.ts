import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// site/app.js is browser JS with no build step; a computed specifier keeps tsc from asking for its types.
const app = await import(new URL("../site/app.js", import.meta.url).href);

const lv = (p: number, n: number) => ({ p, lo: p - 0.05, hi: p + 0.05, n });
const LEVELS = { L1: lv(0.9, 40), L2: lv(0.8, 40), L3: lv(0.6, 40), L4: lv(0.3, 10) };
const point = (date: string, extra: object = {}) => ({
  date,
  normalization: "v1.2",
  overall: LEVELS,
  byStratum: { errors: LEVELS },
  heldOut: LEVELS,
  train: LEVELS,
  events: [],
  ...extra,
});

/** The page's `get` over an in-memory site: a missing file is null, like a 404; `asked` lists the urls requested. */
function site(files: Record<string, unknown>) {
  const asked: string[] = [];
  const get = async (url: string) => {
    asked.push(url);
    return url in files ? structuredClone(files[url]) : null;
  };
  return { asked, get };
}

test("no data files: an empty curve, and no scores file is requested", async () => {
  const s = site({});
  const d = await app.load(s.get, "data/");
  assert.deepEqual(d, { curve: [], drift: [], scores: null, sample: false });
  assert.deepEqual(s.asked, ["data/curve.json", "data/drift.json"]);
  assert.deepEqual(app.strata(d.curve), []);
  assert.deepEqual(app.series(d.curve, "all"), []);
  assert.deepEqual(app.automation(d.curve), []);
});

test("curve.json holding [] is the same empty state", async () => {
  const d = await app.load(site({ "data/curve.json": [], "data/drift.json": [] }).get, "data/");
  assert.deepEqual(d, { curve: [], drift: [], scores: null, sample: false });
});

test("a one-point curve: the latest night's scores file, one row per series, finite chart geometry", async () => {
  const pt = point("2026-10-01", {
    events: ["surface-added: proration"],
    noise: { overall: { ...LEVELS, L3: lv(0.97, 40), L4: lv(0.8, 10) }, byStratum: {} },
    patches: { automatic: 2, assisted: 1 },
  });
  const scores = { date: "2026-10-01", overall: { train: LEVELS, heldOut: LEVELS, noise: LEVELS }, byStratum: {} };
  const s = site({ "data/curve.json": [pt], "data/scores/2026-10-01.json": scores });
  const d = await app.load(s.get, "data/");
  assert.deepEqual(s.asked, ["data/curve.json", "data/drift.json", "data/scores/2026-10-01.json"]);
  assert.deepEqual(d.scores, scores);

  assert.deepEqual(app.strata(d.curve), ["errors"]);
  assert.deepEqual(app.series(d.curve, "all"), [
    { date: "2026-10-01", events: ["surface-added: proration"], L3: LEVELS.L3, L4: LEVELS.L4, ceiling: { L3: 0.97, L4: 0.8 } },
  ]);
  // No noise for the stratum: its ceiling is null, which the page shows as invalid.
  assert.deepEqual(app.series(d.curve, "errors")[0].ceiling, { L3: null, L4: null });
  assert.deepEqual(app.automation(d.curve), [{ date: "2026-10-01", events: [], automatic: 2, assisted: 1, share: 2 / 3 }]);

  // One date sits mid-plot: plot x spans 44..388 in a 400px chart, so 216.
  const sc = app.scales(["2026-10-01"], 400, 240);
  assert.equal(sc.x("2026-10-01"), 216);
  assert.equal(app.line([[sc.x("2026-10-01"), sc.y(0.6)]]), "M216.0,99.2");
  const b = app.band([[216, sc.y(0.65)]], [[216, sc.y(0.55)]]);
  assert.equal(b, "M216.0,89.8L216.0,108.6Z");
  // No date at all still gives numbers, never NaN.
  assert.ok(Number.isFinite(app.scales([], 400, 240).x("2026-10-01")));
});

test("nights are sorted, a normalization change is annotated, and the sample flag is detected", async () => {
  const d = await app.load(
    site({ "data/curve.json": [point("2026-10-02", { normalization: "v1.3" }), point("2026-10-01")], "data/drift.json": [{ sample: true, date: "2026-10-02" }] }).get,
    "data/",
  );
  assert.deepEqual(
    app.series(d.curve, "all").map((r: { date: string; events: string[] }) => [r.date, r.events]),
    [
      ["2026-10-01", []],
      ["2026-10-02", ["normalization v1.3"]],
    ],
  );
  assert.equal(d.sample, true);
});

test("patches are cumulative totals per night (not summed); a partial noise pair has no overall ceiling and says what it covers", () => {
  const curve = [point("2026-10-01", { patches: { automatic: 174, assisted: 0 } }), point("2026-10-02", { patches: { automatic: 180, assisted: 2 } })];
  assert.deepEqual(app.automation(curve).map((r: { automatic: number; assisted: number }) => [r.automatic, r.assisted]), [[174, 0], [180, 2]]);
  const coverage = { seqs: 60, oracleSeqs: 88, templates: 15, oracleTemplates: 26, strata: ["errors"], inSample: true };
  const partial = point("2026-10-03", { noise: { byStratum: { errors: LEVELS }, coverage } });
  assert.deepEqual(app.series([partial], "all")[0].ceiling, { L3: null, L4: null });
  assert.deepEqual(app.series([partial], "errors")[0].ceiling, { L3: 0.6, L4: 0.3 });
  assert.equal(
    app.coverageText(partial),
    "Noise pair: 60 of 88 oracle sequences, 15 of 26 templates: the ceiling is shown only for errors. In-sample: the normalization rules were written from this pair, so its floor flatters them.",
  );
  assert.equal(app.coverageText(point("2026-10-04")), null);
});

test("cells: an interval with its sample size, and a dash for an empty one", () => {
  assert.equal(app.cell({ p: 0.924, lo: 0.894, hi: 0.946, n: 420 }), "92.4% [89.4–94.6] (420)");
  assert.equal(app.cell({ p: 0, lo: 0, hi: 0, n: 0 }), "—");
  assert.equal(app.cell(undefined), "—");
});

test("the pricing page exists, says it is only proposed, and the score page links to it", () => {
  const read = (f: string) => readFileSync(new URL(`../site/${f}`, import.meta.url), "utf8");
  const pricing = read("pricing.html");
  assert.match(pricing, /<p class="banner"><strong>Proposed pricing\. Nothing is for sale yet\.<\/strong><\/p>/);
  assert.doesNotMatch(pricing.match(/<title>(.*)<\/title>/)![1]!, /stripe/i); // decision 0001 C4
  assert.match(read("index.html"), /<a href="pricing\.html">/);
});
