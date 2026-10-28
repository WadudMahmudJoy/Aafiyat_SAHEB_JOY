import assert from "node:assert/strict";
import { existsSync } from "node:fs";

async function verify() {
assert(existsSync("src/lib/inventory-validation.ts"), "Receiving validation must be implemented");
const { validateReceiving } = await import("../src/lib/inventory-validation");
const input = {
  productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  variantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  quantity: "12", reason: "  Cafe\u0301\r\n delivery\t received  ",
  idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
let passed = 0;
function check(name: string, run: () => void) { run(); passed++; console.log(`PASS: ${name}`); }
check("normalizes reason, UUID case, and decimal quantity deterministically", () => {
  const parsed = validateReceiving({ ...input, productId: input.productId.toUpperCase(), quantity: "00012" });
  assert(parsed.valid);
  assert.equal(parsed.values.reason, "Café delivery received");
  assert.equal(parsed.values.quantity, 12);
  assert.equal(parsed.values.productId, input.productId);
});
check("rejects zero, negative, fractional, exponent, nontext, invalid and overflowing quantities", () => {
  for (const quantity of ["0", "000", "-1", "+1", "1.0", "1e3", " 1", "1 ", "1\n", "١", "2147483648", "9".repeat(100), 1, null, ""]) {
    assert.equal(validateReceiving({ ...input, quantity }).valid, false, String(quantity));
  }
  for (const quantity of ["1", "2147483647"]) assert(validateReceiving({ ...input, quantity }).valid);
});
check("rejects missing and malformed UUID fields", () => {
  for (const key of ["productId", "variantId", "idempotencyKey"]) {
    for (const value of ["", "bad", input.productId + "\n", 1, undefined]) assert.equal(validateReceiving({ ...input, [key]: value }).valid, false);
  }
});
check("requires bounded normalized reason without control characters", () => {
  for (const reason of ["", " \r\n\t", "x".repeat(501), "bad\u0000reason", "bad\u007freason", 1]) assert.equal(validateReceiving({ ...input, reason }).valid, false);
  assert(validateReceiving({ ...input, reason: "  " + "x".repeat(500) + "  " }).valid);
});
check("accepts exactly 2048 raw code units and preserves Unicode/whitespace normalization", () => {
  const reason = " ".repeat(2048 - input.reason.length) + input.reason;
  assert.equal(reason.length, 2048);
  const parsed = validateReceiving({ ...input, reason });
  assert(parsed.valid);
  assert.equal(parsed.values.reason, "Café delivery received");
});
check("rejects raw reason beyond 2048 code units even when normalization would shorten it", () => {
  for (const reason of [" ".repeat(2048) + "x", "\t".repeat(4096) + "delivery", " ".repeat(2049 - input.reason.length) + input.reason]) {
    assert(reason.length > 2048);
    assert.equal(validateReceiving({ ...input, reason }).valid, false);
  }
  // Astral characters use two JavaScript code units; the business limit remains 500.
  const astral = "😀".repeat(250);
  const atLimit = " ".repeat(1548) + astral;
  const parsed = validateReceiving({ ...input, reason: atLimit });
  assert(parsed.valid); assert.equal(parsed.values.reason, astral);
  assert.equal(validateReceiving({ ...input, reason: " " + atLimit }).valid, false);
});
check("rejects unknown, privileged, inherited, symbolic, accessor and non-record input", () => {
  for (const key of ["actorAdminId", "adminUserId", "onHand", "reserved", "createdAt", "requestFingerprint", "version", "extra"]) assert.equal(validateReceiving({ ...input, [key]: "forged" }).valid, false);
  for (const value of [null, [], "text", Object.create(input), { ...input, [Symbol("hidden")]: "forged" }, Object.defineProperty({ ...input }, "reason", { get: () => "delivery" })]) assert.equal(validateReceiving(value).valid, false);
});
check("accepts exact form fields and rejects repeats, unknowns and file values", () => {
  const data = new FormData();
  for (const [key, value] of Object.entries(input)) data.append(key, value);
  assert(validateReceiving(data).valid);
  data.append("quantity", "12"); assert.equal(validateReceiving(data).valid, false);
  data.delete("quantity"); data.set("quantity", "12"); data.set("actorAdminId", input.productId);
  assert.equal(validateReceiving(data).valid, false);
  data.delete("actorAdminId"); data.set("reason", new Blob(["reason"]), "reason.txt");
  assert.equal(validateReceiving(data).valid, false);
  const params = new URLSearchParams(input); assert(validateReceiving(params).valid);
  params.append("reason", "again"); assert.equal(validateReceiving(params).valid, false);
});
console.log(`${passed} receiving validation checks passed.`);
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
