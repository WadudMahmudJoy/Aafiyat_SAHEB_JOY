import assert from "node:assert/strict";
import { parseOrderFilters, acknowledgeInput, money, totals } from "../src/lib/order-validation";
let count = 0;
function check(name: string, run: () => void) { run(); count++; console.log(`PASS: ${name}`); }
check("bounded exact BDT arithmetic and bigint display", () => {
  assert.equal(money("9007199254740993"), "BDT 90,071,992,547,409.93");
  assert.equal(totals([{ quantity: 2, unit: "12345", discount: "90" }], "100", "0").total, "24700");
  for (const unit of ["-1", "1.1", "1e3", "9223372036854775808"]) assert.throws(() => totals([{ quantity: 1, unit, discount: "0" }], "0", "0"));
  assert.throws(() => totals([{ quantity: 2, unit: "9223372036854775807", discount: "0" }], "0", "0"));
  assert.throws(() => totals([{ quantity: 1, unit: "1", discount: "2" }], "0", "0"));
});
check("filter allowlists, UTC day bounds and strict cursor", () => {
  assert.equal(parseOrderFilters({ from: "2024-02-29", to: "2024-02-29", payment: "paid" }).from, "2024-02-29");
  for (const value of [{ search: ["a", "b"] }, { from: "2026-02-29" }, { from: "2026-10-29", to: "2026-10-28" }, { payment: "successful" }, { fulfillment: "hacked" }, { cursor: "bad" }, { search: "a".repeat(101) }, { unexpected: "x" }]) assert.throws(() => parseOrderFilters(value));
});
check("acknowledgement retains duplicate detection and rejects actors or status input", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const form = new FormData(); form.set("orderId", id); assert.equal(acknowledgeInput(form), id);
  form.append("orderId", id); assert.throws(() => acknowledgeInput(form));
  for (const key of ["actorAdminId", "paymentStatus", "acceptedAt", "acknowledgedAt"]) { const bad = new FormData(); bad.set("orderId", id); bad.set(key, "forged"); assert.throws(() => acknowledgeInput(bad)); }
});
console.log(`${count} order validation groups passed; no database access.`);
