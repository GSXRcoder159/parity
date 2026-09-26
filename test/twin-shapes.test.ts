import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const shapesDir = join(root, "src/twin/shapes");
const spec = JSON.parse(readFileSync(join(root, "src/twin/spec/openapi.pruned.json"), "utf8"));
const shape = (id: string) => JSON.parse(readFileSync(join(shapesDir, `${id}.json`), "utf8"));
const readDir = (dir: string) =>
  Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));

const IN_SCOPE = `
post /v1/customers
get /v1/customers
get /v1/customers/{customer}
post /v1/customers/{customer}
delete /v1/customers/{customer}
get /v1/customers/search
get /v1/customers/{customer}/payment_methods
get /v1/payment_methods
get /v1/payment_methods/{payment_method}
post /v1/payment_methods/{payment_method}
post /v1/payment_methods/{payment_method}/attach
post /v1/payment_methods/{payment_method}/detach
post /v1/products
get /v1/products
get /v1/products/{id}
post /v1/products/{id}
post /v1/prices
get /v1/prices
get /v1/prices/{price}
post /v1/prices/{price}
post /v1/subscriptions
get /v1/subscriptions
get /v1/subscriptions/{subscription_exposed_id}
post /v1/subscriptions/{subscription_exposed_id}
delete /v1/subscriptions/{subscription_exposed_id}
get /v1/invoices
get /v1/invoices/{invoice}
post /v1/invoices/{invoice}
delete /v1/invoices/{invoice}
post /v1/invoices/create_preview
post /v1/invoices/{invoice}/pay
post /v1/invoices/{invoice}/void
post /v1/invoices/{invoice}/finalize
get /v1/payment_intents
get /v1/payment_intents/{intent}
get /v1/charges
get /v1/charges/{charge}
post /v1/refunds
get /v1/refunds
get /v1/refunds/{refund}
get /v1/events
get /v1/events/{id}
post /v1/webhook_endpoints
get /v1/webhook_endpoints
get /v1/webhook_endpoints/{webhook_endpoint}
post /v1/webhook_endpoints/{webhook_endpoint}
delete /v1/webhook_endpoints/{webhook_endpoint}
post /v1/test_helpers/test_clocks
get /v1/test_helpers/test_clocks
get /v1/test_helpers/test_clocks/{test_clock}
delete /v1/test_helpers/test_clocks/{test_clock}
post /v1/test_helpers/test_clocks/{test_clock}/advance
`.trim().split("\n");

test("pruned spec holds exactly the in-scope operations", () => {
  const ops = Object.entries(spec.paths).flatMap(([p, item]) => Object.keys(item as object).map((m) => `${m} ${p}`));
  assert.deepEqual(ops.sort(), [...IN_SCOPE].sort());
});

test("every $ref in the pruned spec resolves to a kept schema", () => {
  const dangling: string[] = [];
  JSON.stringify(spec, (k, v) => {
    if (k === "$ref" && !(v.replace("#/components/schemas/", "") in spec.components.schemas)) dangling.push(v);
    return v;
  });
  assert.deepEqual(dangling, []);
});

test("templates exist for the twin's core resources", () => {
  const files = readdirSync(shapesDir);
  for (const id of ["customer", "subscription", "invoice", "price", "refund", "event", "payment_method", "charge", "payment_intent", "webhook_endpoint"]) {
    assert.ok(files.includes(`${id}.json`), `${id}.json missing`);
  }
});

test("templates use generic spec defaults", () => {
  const customer = shape("customer");
  assert.equal(customer.object, "customer");
  assert.equal(customer.livemode, false);
  assert.equal(customer.id, "");
  assert.deepEqual(customer.metadata, {});
  assert.equal(customer.email, null); // nullable
  assert.deepEqual(Object.keys(customer), Object.keys(customer).sort());
  assert.deepEqual(shape("deleted_customer"), { deleted: true, id: "", object: "customer" });
});

test("expandable fields take the string form", () => {
  assert.equal(shape("subscription").customer, "");
  assert.equal(shape("price").product, "");
});

test("generator is deterministic and the committed templates are current", () => {
  const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "parity-shapes-")));
  try {
    const sentinel = join(dirs[0]!, "keep.json"); // a dir passed on the command line is never cleared
    writeFileSync(sentinel, "{}");
    for (const d of dirs) execFileSync(process.execPath, [join(root, "scripts/gen-shapes.ts"), d]);
    assert.equal(readFileSync(sentinel, "utf8"), "{}");
    rmSync(sentinel);
    const [a, b] = dirs.map(readDir);
    assert.deepEqual(a, b);
    assert.deepEqual(a, readDir(shapesDir));
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true });
  }
});
