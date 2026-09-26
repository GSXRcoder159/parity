import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLog, type LogEntry } from "../src/align/log.ts";
import { drift } from "../src/drift.ts";
import { readJsonl } from "../src/jsonl.ts";
import type { Recording } from "../src/types.ts";

const ORACLE = { oracleSeqs: 2, oracleSha: "0".repeat(64) };
const DATE = "2026-10-04";

/** customer-crud steps 0 (POST /v1/customers) and 1 (GET /v1/customers/<id>), both answering `customer`. */
function rec(seq: string, id: string, startedAt: string, customer: object, o: Partial<Recording> = {}): Recording {
  const body = { id, object: "customer", created: Date.parse(startedAt) / 1000, email: "jane@example.com", ...customer };
  return {
    seq,
    template: "customer-crud",
    stratum: "lifecycle",
    seed: Number(seq.split("#")[1]),
    heldOut: false,
    target: "sandbox",
    runId: `run-${startedAt}`,
    startedAt,
    ms: 1,
    steps: [
      { i: 0, method: "POST", path: "/v1/customers", status: 200, body, resHeaders: {}, ms: 1 },
      { i: 1, method: "GET", path: `/v1/customers/${id}`, status: 200, body, resHeaders: {}, ms: 1 },
    ],
    events: [{ id: `evt_${id.slice(4)}`, type: "customer.created", created: 1, data: { object: { id } } }],
    ...o,
  };
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "pb-drift-"));
  return { root, log: join(root, "data/align/log.jsonl") };
};

test("drift: changes outside the noise set are reported by endpoint, template, path and class, never values; noise and fraud paths are not", () => {
  const { root, log } = setup();
  const WEEK_AGO = "2026-09-27T07:00:00.000Z";
  const TONIGHT = "2026-10-04T07:00:00.000Z";
  const before = { tax_exempt: "none", balance: 0, outcome: { risk_level: "elevated" } };
  const previous = [rec("customer-crud#1", "cus_AAAAAAAAAAAAAA", WEEK_AGO, before), rec("customer-crud#2", "cus_BBBBBBBBBBBBBB", WEEK_AGO, before)];
  // tax_exempt drifts in both sequences (one line, 2 sequences), a new field appears, balance is noise, risk_level is a
  // fraud/risk field; #2 also fires a new event. #3 has no previous recording and #4 was rate-limited: neither is compared.
  const after = { tax_exempt: "reverse", balance: 5, outcome: { risk_level: "RISKMARK" }, test_clock: null };
  const today = [
    rec("customer-crud#1", "cus_CCCCCCCCCCCCCC", TONIGHT, after),
    rec("customer-crud#2", "cus_DDDDDDDDDDDDDD", TONIGHT, after, {
      events: [
        { id: "evt_1", type: "customer.created", created: 1, data: { object: { id: "cus_DDDDDDDDDDDDDD" } } },
        { id: "evt_2", type: "customer.updated", created: 2, data: { object: { id: "cus_DDDDDDDDDDDDDD" } } },
      ],
    }),
    rec("customer-crud#3", "cus_EEEEEEEEEEEEEE", TONIGHT, after),
  ];
  const limited = rec("customer-crud#4", "cus_FFFFFFFFFFFFFF", TONIGHT, after);
  limited.steps[0]!.status = 429;
  previous.push(rec("customer-crud#4", "cus_GGGGGGGGGGGGGG", WEEK_AGO, before));
  today.push(limited);
  const noise = new Set(["customer-crud|0|$.balance", "customer-crud|1|$.balance"]);
  // An older night's line is kept; a stale line of the same date is replaced.
  mkdirSync(join(root, "site/data"), { recursive: true });
  const older = { date: "2026-09-30", endpoint: "POST /v1/refunds", template: "refund-full", path: "$.status", cls: "VALUE_MISMATCH" };
  writeFileSync(join(root, "site/data/drift.json"), JSON.stringify([older, { ...older, date: DATE }]));

  const r = drift({ date: DATE, today, previous, noise, root, log, runId: "n1", oracle: ORACLE });

  const line = (endpoint: string, path: string, cls: string) => ({ date: DATE, endpoint, template: "customer-crud", path, cls });
  assert.deepEqual(r.items, [
    line("GET /v1/customers/$c1.id", "$.tax_exempt", "VALUE_MISMATCH"),
    line("GET /v1/customers/$c1.id", "$.test_clock", "EXTRA_FIELD"),
    line("POST /v1/customers", "$.tax_exempt", "VALUE_MISMATCH"),
    line("POST /v1/customers", "$.test_clock", "EXTRA_FIELD"),
    line("events", "$", "EVENT_SET_MISMATCH"),
  ]);
  assert.equal(r.compared, 2);
  assert.equal(r.withheld, 4, "risk_level in 2 steps of 2 sequences");
  assert.equal(r.file, `drift/${DATE}.md`);

  const md = readFileSync(join(root, r.file!), "utf8");
  assert.match(md, /^# Drift 2026-10-04$/m);
  assert.match(md, /^\| `POST \/v1\/customers` \| customer-crud \| `\$\.tax_exempt` \| VALUE_MISMATCH \| 2 \|$/m);
  assert.match(md, /^\| `events` \| customer-crud \| `\$` \| EVENT_SET_MISMATCH \| 1 \|$/m);
  assert.match(md, /^4 divergences on fraud or risk fields are withheld/m);
  const feed = readFileSync(join(root, "site/data/drift.json"), "utf8");
  assert.deepEqual(JSON.parse(feed), [older, ...r.items]);
  for (const text of [md, feed]) {
    // No values (0001 C3), no ids, no fraud or risk path (0001 R8).
    for (const leak of ["reverse", "none", "jane@", "RISKMARK", "elevated", "risk_level", "outcome", "balance", "cus_", "evt_", "customer.updated"]) assert.ok(!text.includes(leak), `${leak} published`);
  }
  assert.equal(existsSync(log), false, "a report is not a note");
});

test("drift: nothing to report writes no file and logs a note", () => {
  const { root, log } = setup();
  const previous = [rec("customer-crud#1", "cus_AAAAAAAAAAAAAA", "2026-09-27T07:00:00.000Z", {})];
  // Same behavior, new ids and times: equal once normalized.
  const same = drift({ date: DATE, today: [rec("customer-crud#1", "cus_CCCCCCCCCCCCCC", "2026-10-04T07:00:00.000Z", {})], previous, noise: new Set(), root, log, runId: "n1", oracle: ORACLE });
  assert.deepEqual(same, { compared: 1, items: [], withheld: 0 });
  // The degraded night: the slice was refused, nothing clean tonight.
  const none = drift({ date: DATE, today: [], previous, noise: new Set(), root, log, runId: "n2", oracle: ORACLE });
  assert.deepEqual(none, { compared: 0, items: [], withheld: 0 });

  assert.equal(existsSync(join(root, "drift")), false);
  assert.equal(existsSync(join(root, "site/data/drift.json")), false);
  assert.deepEqual(verifyLog(log), { ok: true, entries: 2 });
  assert.deepEqual(
    readJsonl<LogEntry>(log).map((e) => [e.runId, e.kind, e.data.drift]),
    [
      ["n1", "note", { date: DATE, compared: 1, withheld: 0, reason: "no divergence outside the noise set" }],
      ["n2", "note", { date: DATE, compared: 0, withheld: 0, reason: "no clean slice recording tonight with a previous recording to compare" }],
    ],
  );
});
