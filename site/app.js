// Score page (static, no build step). Reads data/curve.json, data/drift.json, data/changelog.json and
// data/scores/<date of the latest curve point>.json; `?data=sample` reads the synthetic files in data/sample/ instead.
//
// Data contract. Public-safe only (decision 0001 C3): scores, counts, strata, templates, paths and classes; no values, no ids.
//   Levels   {L1, L2, L3, L4}, each a 95% Wilson interval {p, lo, hi, n} (src/bench/score.ts).
//   curve.json   [{date: "YYYY-MM-DD", normalization, method?, overall: Levels, byStratum: {name: Levels}, heldOut: Levels,
//                  train: Levels, events: ["surface-added: …", "oracle expanded: 88→120", "method change: …", …],
//                  noise?: {overall?: Levels, byStratum: {name: Levels}, coverage?: Coverage},
//                  patches?: {automatic, assisted}, divergencesRemoved?: {automatic, assisted}, oracleRefreshed?: boolean,
//                  oracleSeqs?: number, sample?: true}]
//                noise = agreement of two real sandbox recordings of the same sequences: ceiling = noise p, floor = 1 − p.
//                  overall is present only when the pair covers every scored template, byStratum only for the strata
//                  it covers whole. Coverage = {seqs, oracleSeqs, templates, oracleTemplates, strata, inSample}:
//                  inSample = the normalization rules were written from this pair.
//                patches = align-loop patches since the scaffold freeze (cumulative sealed-log totals, decision 0002 §3),
//                  H2's unit: automatic = JSON-pointer edits applied, assisted = PRs merged. divergencesRemoved = the same
//                  classes' train divergences removed (held-out gate's count before minus after), also cumulative.
//                oracleRefreshed = tonight's sandbox slice was recorded; oracleSeqs = sequences in the scored oracle.
//                method = the compare method (src/bench/compare.ts METHOD; absent = m1): m1 event-type sets, m2 plus causal
//                  event order. A change is annotated by the nightly ("method change: causal event order").
//   scores/<date>.json  {date, normalization, method?, overall: Split, byStratum: {name: Split}, noiseCoverage?: Coverage, sample?: true},
//                Split = {train: Levels, heldOut: Levels, noise?: Levels}
//   drift.json   [{date, endpoint, template, path, cls, sample?: true}]
//   changelog.json  [{date, class: "automatic" | "assisted" | "surface-added", file?, pointers?, withheld?, pr?, note?, commit?,
//                  divergencesRemoved?, sample?: true}] in sealed-log order (src/nightly.ts changelog()): automatic = one
//                  held-out gate batch of JSON-pointer edits to one data file; assisted = one merged PR; surface-added = a
//                  scaffold change and its note. divergencesRemoved = train divergences, gate before minus after.
//                  withheld = pointers into fraud or risk fields, counted but not named (decision 0001 R8).
// test/site.test.ts imports this module in Node, so everything above main() is DOM-free.

/** Loads the page data through `get(url)`, which resolves to parsed JSON, or null when the file does not exist. */
export async function load(get, base = "data/") {
  const curve = [...((await get(`${base}curve.json`)) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const drift = (await get(`${base}drift.json`)) ?? [];
  const changelog = (await get(`${base}changelog.json`)) ?? [];
  const last = curve.at(-1);
  const scores = last ? await get(`${base}scores/${last.date}.json`) : null;
  const sample = [...curve, ...drift, ...changelog, scores].some((x) => x?.sample === true);
  return { curve, drift, changelog, scores, sample };
}

/** Strata that appear on any night, sorted. */
export const strata = (curve) => [...new Set(curve.flatMap((pt) => Object.keys(pt.byStratum ?? {})))].sort();

/**
 * One row per night that has `stratum` ("all" = every stratum): the L3/L4 intervals, their ceilings (null on a night
 * without a noise floor), and the night's annotations, including a change of normalization version.
 */
export function series(curve, stratum) {
  const rows = [];
  curve.forEach((pt, i) => {
    const levels = stratum === "all" ? pt.overall : pt.byStratum?.[stratum];
    if (!levels) return;
    const noise = stratum === "all" ? pt.noise?.overall : pt.noise?.byStratum?.[stratum];
    const events = [...(pt.events ?? [])];
    // Nights before the nightly annotated it itself ("method change: normalization vX") get the label here.
    const label = `normalization ${pt.normalization}`;
    if (i > 0 && pt.normalization !== curve[i - 1].normalization && !events.some((e) => e.endsWith(label))) events.push(label);
    rows.push({ date: pt.date, events, L3: levels.L3, L4: levels.L4, ceiling: { L3: noise?.L3?.p ?? null, L4: noise?.L4?.p ?? null } });
  });
  return rows;
}

/**
 * Each reporting night's cumulative patches (already totals; share = automatic / both, null at 0) and, when the night
 * reports them, train divergences removed per class with the same share (`removed`, else null).
 */
export function automation(curve) {
  const share = (a, b) => (a + b ? a / (a + b) : null);
  return curve
    .filter((pt) => pt.patches)
    .map(({ date, patches: { automatic = 0, assisted = 0 }, divergencesRemoved: r }) => ({
      date,
      events: [],
      automatic,
      assisted,
      share: share(automatic, assisted),
      removed: r ? { automatic: r.automatic, assisted: r.assisted, share: share(r.automatic, r.assisted) } : null,
    }));
}

/** Changelog rows newest first (the file is oldest first): the date, class, patch count, what changed, and removals. */
export function changes(changelog) {
  const what = (c) =>
    c.class === "automatic" ? `${c.file}: ${[...c.pointers, ...(c.withheld ? [`${c.withheld} fraud or risk pointer(s) withheld`] : [])].join(", ")}` : c.class === "assisted" ? `PR #${c.pr}${c.file ? `: ${c.file}` : ""}` : `${c.note}${c.commit ? ` (${c.commit.slice(0, 7)})` : ""}`;
  const patches = (c) => (c.class === "automatic" ? c.pointers.length + (c.withheld ?? 0) : c.class === "assisted" ? 1 : null);
  return [...changelog]
    .reverse()
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((c) => ({ date: c.date, class: c.class, patches: patches(c), what: what(c), removed: c.divergencesRemoved ?? null }));
}

/** What the latest night's noise pair covers, as a sentence; null without a pair. */
export function coverageText(pt) {
  const c = pt?.noise?.coverage;
  if (!c) return null;
  const part = c.templates < c.oracleTemplates ? `: the ceiling is shown only for ${c.strata.length ? c.strata.join(", ") : "no stratum"}` : "";
  const sample = c.inSample ? " In-sample: the normalization rules were written from this pair, so its floor flatters them." : "";
  return `Noise pair: ${c.seqs} of ${c.oracleSeqs} oracle sequences, ${c.templates} of ${c.oracleTemplates} templates${part}.${sample}`;
}

/** Pixel scales of a w×h chart for 0–1 values over `dates`; a single date sits in the middle, no date gives no NaN. */
export function scales(dates, w, h, pad = { t: 24, r: 12, b: 28, l: 44 }) {
  const ts = dates.map((d) => Date.parse(d));
  const min = Math.min(...ts);
  const max = Math.max(...ts);
  const iw = w - pad.l - pad.r;
  return {
    pad,
    x: (d) => pad.l + (max > min ? ((Date.parse(d) - min) / (max - min)) * iw : iw / 2),
    y: (v) => pad.t + (1 - v) * (h - pad.t - pad.b),
  };
}

/** SVG path data through [x, y] points, and a closed band between an upper and a lower edge. */
export const line = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
export const band = (upper, lower) => (upper.length ? `${line(upper)}L${line([...lower].reverse()).slice(1)}Z` : "");

const pct1 = (v) => (v * 100).toFixed(1);
export const pct = (v) => `${pct1(v)}%`;
/** "92.4% [89.4–94.6] (420)", or "—" for an empty interval. */
export const cell = (w) => (!w || !w.n ? "—" : `${pct(w.p)} [${pct1(w.lo)}–${pct1(w.hi)}] (${w.n})`);

// ---- DOM ----

const SVG = "http://www.w3.org/2000/svg";
const LEVEL_DEFS = [
  { key: "L3", label: "L3 value", color: "var(--s1)" },
  { key: "L4", label: "L4 sequence", color: "var(--s2)" },
];

/** An HTML element; string children become text nodes (data never goes through innerHTML). */
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

function s(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const $ = (id) => document.getElementById(id);
const val = (v) => (typeof v === "number" ? v : v.p);

/**
 * A 0–100% time chart into `box`: per def a 2px line with an end dot, plus an optional Wilson band and ceiling step line;
 * annotations as hairlines; a crosshair tooltip on hover and on keyboard focus (arrow keys move it).
 * def = {label, color, get(row) → interval | number, band?, ceiling?(row) → number | null, text?(row) → string}.
 */
function chart(box, rows, defs, label) {
  if (!rows.length) return box.replaceChildren(h("p", { class: "muted" }, "No data."));
  const w = box.clientWidth;
  const hgt = 240;
  const sc = scales(rows.map((r) => r.date), w, hgt);
  const right = w - sc.pad.r;
  const svg = s("svg", { width: w, height: hgt, role: "img", "aria-label": label, tabindex: 0 });
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(s("line", { x1: sc.pad.l, x2: right, y1: sc.y(v), y2: sc.y(v), class: v ? "grid" : "axis" }));
    svg.append(s("text", { x: sc.pad.l - 6, y: sc.y(v) + 4, class: "tick", "text-anchor": "end" }, `${v * 100}%`));
  }
  const first = rows[0].date;
  const last = rows.at(-1).date;
  // ponytail: first and last dates only; add intermediate ticks when a long curve needs them.
  const xLabels = first === last ? [[first, "middle"]] : [[first, "start"], [last, "end"]];
  for (const [d, anchor] of xLabels) svg.append(s("text", { x: sc.x(d), y: hgt - 8, class: "tick", "text-anchor": anchor }, d));
  let free = 0; // where the next annotation label may start: a label that would overlap the previous one is left to the tooltip
  for (const r of rows.filter((r) => r.events.length)) {
    const x = sc.x(r.date);
    svg.append(s("line", { x1: x, x2: x, y1: 4, y2: hgt - sc.pad.b, class: "annot" }));
    const text = r.events.map((e) => e.split(":")[0]).join(", ");
    // Labels sit above the plot, clear of ceilings near 100%.
    // ponytail: width estimated at ~6px per 11px glyph; measure with getComputedTextLength() if labels clip or collide.
    const lx = Math.min(x + 4, w - text.length * 6);
    if (lx < free) continue;
    svg.append(s("text", { x: lx, y: 14, class: "tick" }, text));
    free = lx + text.length * 6 + 8;
  }
  for (const d of defs) {
    const at = (f) => rows.map((r) => [sc.x(r.date), sc.y(f(r))]);
    if (d.band) svg.append(s("path", { d: band(at((r) => d.get(r).hi), at((r) => d.get(r).lo)), style: `fill:${d.color}`, class: "band" }));
    if (d.ceiling) {
      // Step line: each night's ceiling holds until the next night's; the first starts at the left edge, the last runs to the right.
      const steps = rows.flatMap((r, i) => {
        const c = d.ceiling(r);
        if (c === null) return [];
        const x0 = i ? sc.x(r.date) : sc.pad.l;
        const x1 = i < rows.length - 1 ? sc.x(rows[i + 1].date) : right;
        return [`M${x0.toFixed(1)},${sc.y(c).toFixed(1)}H${x1.toFixed(1)}`];
      });
      if (steps.length) svg.append(s("path", { d: steps.join(""), style: `stroke:${d.color}`, class: "ceiling" }));
    }
    const pts = at((r) => val(d.get(r)));
    svg.append(s("path", { d: line(pts), style: `stroke:${d.color}`, class: "series" }));
    const [x, y] = pts.at(-1);
    svg.append(s("circle", { cx: x, cy: y, r: 4, style: `fill:${d.color}`, class: "dot" }));
  }
  const cross = s("line", { y1: sc.pad.t, y2: hgt - sc.pad.b, class: "cross", visibility: "hidden" });
  svg.append(cross);
  const tip = h("div", { class: "tip", role: "status" });
  tip.hidden = true;
  let cur = rows.length - 1;
  const show = (i) => {
    cur = i;
    const r = rows[i];
    const x = sc.x(r.date);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.setAttribute("visibility", "visible");
    tip.replaceChildren(
      h("div", { class: "muted" }, r.date),
      ...defs.map((d) => {
        const c = d.ceiling?.(r);
        const v = d.text ? d.text(r) : cell(d.get(r));
        return h("div", {}, h("span", { class: "key", style: `background:${d.color}` }), h("b", {}, v), ` ${d.label}`, c == null ? "" : `, ceiling ${pct(c)}`);
      }),
      ...r.events.map((e) => h("div", { class: "muted" }, e)),
    );
    tip.hidden = false;
    tip.style.left = `${Math.max(0, Math.min(x + 12, w - tip.offsetWidth))}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  };
  const nearest = (px) => rows.reduce((b, r, i) => (Math.abs(sc.x(r.date) - px) < Math.abs(sc.x(rows[b].date) - px) ? i : b), 0);
  svg.addEventListener("pointermove", (e) => show(nearest(e.clientX - svg.getBoundingClientRect().left)));
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(cur));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    show(Math.max(0, Math.min(rows.length - 1, cur + step)));
  });
  box.replaceChildren(svg, tip);
}

function table(head, rows) {
  return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...head.map((c) => h("th", {}, c)))), h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, c)))))));
}

function renderCurve(data) {
  const rows = series(data.curve, $("stratum").value);
  const defs = LEVEL_DEFS.map((l) => ({ ...l, get: (r) => r[l.key], band: true, ceiling: (r) => r.ceiling[l.key] }));
  chart($("curve-chart"), rows, defs, `Nightly L3 and L4 agreement, ${$("stratum").selectedOptions[0].text}`);
  const c = (v) => (v === null ? "none: invalid" : pct(v));
  $("curve-table").replaceChildren(
    table(
      ["Night", "L3", "L4", "L3 ceiling", "L4 ceiling", "Annotations"],
      rows.map((r) => [r.date, cell(r.L3), cell(r.L4), c(r.ceiling.L3), c(r.ceiling.L4), r.events.join("; ")]),
    ),
  );
}

function renderAutomation(data) {
  const all = automation(data.curve);
  const rows = all.filter((r) => r.share !== null);
  const end = all.at(-1);
  const removed = end?.removed?.share == null ? "" : ` Train divergences removed: ${end.removed.automatic} by automatic patches, ${end.removed.assisted} by assisted ones: ${pct(end.removed.share)} automatic by divergences removed.`;
  $("automation-summary").textContent = rows.length
    ? `${end.automatic} automatic patches (JSON-pointer edits) and ${end.assisted} assisted patches (merged PRs) since the scaffold freeze: ${pct(end.share)} automatic by patch count, H2's unit.${removed}`
    : "No align-loop patches have been recorded yet.";
  $("automation-chart").hidden = !rows.length;
  if (rows.length) {
    const defs = [{ label: "automatic, share of patches", color: "var(--s1)", get: (r) => r.share, text: (r) => `${pct(r.share)} (${r.automatic} of ${r.automatic + r.assisted} patches)` }];
    // ponytail: the second line needs every plotted night to report removals; points before it do not, and then it is left out.
    if (rows.every((r) => r.removed?.share != null)) {
      defs.push({ label: "automatic, share of train divergences removed", color: "var(--s2)", get: (r) => r.removed.share, text: (r) => `${pct(r.removed.share)} (${r.removed.automatic} of ${r.removed.automatic + r.removed.assisted} divergences)` });
    }
    chart($("automation-chart"), rows, defs, "Cumulative automatic share, by patches and by train divergences removed");
  }
}

function renderChanges(data) {
  const rows = changes(data.changelog);
  const n = (cls) => rows.filter((r) => r.class === cls).length;
  $("changes-summary").textContent = rows.length
    ? `${rows.length} entries: ${n("automatic")} automatic gate batches, ${n("assisted")} merged assisted PRs, ${n("surface-added")} surface-added`
    : "No changes logged yet";
  const unit = (r) => (r.patches === null ? "" : r.class === "automatic" ? ` · ${r.patches} JSON-pointer edits` : " · 1 merged PR");
  const gone = (r) => (r.removed === null ? "" : r.removed >= 0 ? ` · ${r.removed} train divergences removed` : ` · ${-r.removed} train divergences added`);
  // Files and pointers as code; a surface-added note is prose.
  const what = (r) => (r.class === "surface-added" ? h("div", { class: "muted" }, r.what) : h("code", {}, r.what));
  $("changes-list").replaceChildren(...rows.map((r) => h("li", {}, h("div", {}, h("b", {}, r.date), ` · ${r.class}${unit(r)}${gone(r)}`), what(r))));
}

function renderScores(data) {
  const { scores } = data;
  const date = data.curve.at(-1).date;
  if (!scores) {
    $("scores").replaceChildren(h("p", { class: "muted" }, `No per-stratum file (scores/${date}.json) for the latest night.`));
    return;
  }
  const rows = [];
  const add = (name, split) => {
    rows.push([name, "train", ...["L1", "L2", "L3", "L4"].map((l) => cell(split.train?.[l]))]);
    rows.push(["", "held-out", ...["L1", "L2", "L3", "L4"].map((l) => cell(split.heldOut?.[l]))]);
    rows.push(["", "ceiling", ...["L1", "L2", "L3", "L4"].map((l) => (split.noise ? cell(split.noise[l]) : "none: invalid"))]);
  };
  add("all strata", scores.overall ?? {});
  for (const k of Object.keys(scores.byStratum ?? {}).sort()) add(k, scores.byStratum[k]);
  $("scores").replaceChildren(h("p", { class: "muted" }, `Night of ${scores.date}.`), table(["Stratum", "Split", "L1", "L2", "L3", "L4"], rows));
}

function renderDrift(data) {
  const byDate = Map.groupBy(data.drift, (d) => d.date);
  const dates = [...byDate.keys()].sort().reverse().slice(0, 14);
  $("drift-feed").replaceChildren(
    ...(dates.length
      ? dates.map((d) =>
          h(
            "div",
            { class: "drift-day" },
            h("h3", {}, d),
            h("ul", {}, ...byDate.get(d).map((x) => h("li", {}, h("code", {}, x.path), ` ${x.cls} · ${x.endpoint} · ${x.template}`))),
          ),
        )
      : [h("p", { class: "muted" }, "No drift reported yet.")]),
  );
}

async function main() {
  const base = new URLSearchParams(location.search).get("data") === "sample" ? "data/sample/" : "data/";
  const get = async (url) => {
    const r = await fetch(url, { cache: "no-cache" });
    return r.ok ? r.json() : null;
  };
  let data;
  try {
    data = await load(get, base);
  } catch (e) {
    $("empty").hidden = false;
    $("empty").replaceChildren(h("p", {}, `Could not read the score data: ${e.message}`));
    return;
  }
  $("sample-banner").hidden = !data.sample;
  renderDrift(data);
  const last = data.curve.at(-1);
  if (!last) {
    $("empty").hidden = false;
    return;
  }
  for (const id of ["meta", "curve", "table", "automation", "changes"]) $(id).hidden = false;
  $("latest").textContent = last.date;
  $("norm").textContent = last.normalization;
  $("method").textContent = last.method ?? "m1";
  $("invalid").hidden = Boolean(last.noise?.overall);
  const cov = coverageText(last);
  $("coverage").hidden = !cov;
  $("coverage").textContent = cov ?? "";
  $("stratum").replaceChildren(h("option", { value: "all" }, "All strata"), ...strata(data.curve).map((k) => h("option", { value: k }, k)));
  $("stratum").addEventListener("change", () => renderCurve(data));
  renderScores(data);
  renderChanges(data);
  const charts = () => {
    renderCurve(data);
    renderAutomation(data);
  };
  charts();
  addEventListener("resize", charts);
}

if (typeof document !== "undefined") main();
