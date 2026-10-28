import assert from "node:assert/strict";

async function verify() {
  const { validateCorrection } = await import("../src/lib/inventory-validation");
  assert.equal(typeof validateCorrection, "function", "Correction validation must be implemented");
  const input = {
    productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", variantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    targetOnHand: "12", expectedRevision: "2026-10-28T00:01:02.123456Z", reason: "  Cafe\u0301\r\n counted\t stock ",
    idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  let passed = 0;
  function check(name: string, run: () => void) { run(); passed++; console.log(`PASS: ${name}`); }
  check("normalizes UUIDs, unsigned decimal target and reason while retaining exact revision", () => {
    const p = validateCorrection({ ...input, productId: input.productId.toUpperCase(), targetOnHand: "00012" });
    assert(p.valid); assert.equal(p.values.targetOnHand, 12); assert.equal(p.values.productId, input.productId);
    assert.equal(p.values.reason, "Café counted stock"); assert.equal(p.values.expectedRevision, input.expectedRevision);
    for (const targetOnHand of ["0", "0000", "1", "2147483647"]) assert(validateCorrection({ ...input, targetOnHand }).valid);
  });
  check("rejects negative, fractional, exponent, nontext, malformed and overflowing counts", () => {
    for (const targetOnHand of ["", "-1", "+1", "1.0", "1e3", " 1", "1 ", "1\n", "١", "2147483648", "9".repeat(100), 1, null]) assert.equal(validateCorrection({ ...input, targetOnHand }).valid, false);
  });
  check("accepts missing state or exact Gregorian UTC six-digit revisions without truncation", () => {
    for (const expectedRevision of ["missing", "2000-02-29T23:59:59.000001Z", "2024-02-29T00:00:00.999999Z", input.expectedRevision, "2026-10-28T00:01:02.123457Z"]) {
      const p = validateCorrection({ ...input, expectedRevision }); assert(p.valid); assert.equal(p.values.expectedRevision, expectedRevision);
    }
  });
  check("rejects absent, imprecise, timezone-offset, invalid-calendar and noncanonical revisions", () => {
    for (const expectedRevision of [undefined, null, "", "Missing", " missing", "missing ", "2026-10-28T00:01:02.123Z", "2026-10-28T00:01:02.1234567Z", "2026-10-28T00:01:02.123456+00:00", "2026-02-29T00:00:00.123456Z", "1900-02-29T00:00:00.123456Z", "2026-04-31T00:00:00.123456Z", "2026-00-01T00:00:00.123456Z", "2026-13-01T00:00:00.123456Z", "2026-01-00T00:00:00.123456Z", "2026-01-01T24:00:00.123456Z", "2026-01-01T00:60:00.123456Z", "2026-01-01T00:00:60.123456Z", "0000-01-01T00:00:00.123456Z", input.expectedRevision + "\n"]) assert.equal(validateCorrection({ ...input, expectedRevision }).valid, false, String(expectedRevision));
  });
  check("rejects missing/malformed UUIDs and missing fields", () => {
    for (const key of ["productId", "variantId", "idempotencyKey"]) for (const value of [undefined, "bad", input.productId + "\n", 1]) assert.equal(validateCorrection({ ...input, [key]: value }).valid, false);
    for (const key of Object.keys(input)) { const value = { ...input } as Record<string, string>; delete value[key]; assert.equal(validateCorrection(value).valid, false); }
  });
  check("preserves receiving reason limits, control rejection, NFC and whitespace rules", () => {
    const raw = " ".repeat(2048 - input.reason.length) + input.reason;
    const p = validateCorrection({ ...input, reason: raw }); assert(p.valid); assert.equal(p.values.reason, "Café counted stock");
    for (const reason of [" " + raw, " ".repeat(4096) + "count", "", " \r\n\t", "x".repeat(501), "bad\u0000reason", "bad\u007freason", 1]) assert.equal(validateCorrection({ ...input, reason }).valid, false);
    assert(validateCorrection({ ...input, reason: "x".repeat(500) }).valid);
  });
  check("rejects privileged fields, exotic objects, accessors and symbols", () => {
    for (const key of ["quantity", "actorAdminId", "adminUserId", "onHandBefore", "reserved", "deltaOnHand", "requestFingerprint", "updatedAt", "createdAt", "extra"]) assert.equal(validateCorrection({ ...input, [key]: "forged" }).valid, false);
    for (const value of [null, [], "text", Object.create(input), { ...input, [Symbol("hidden")]: "forged" }, Object.defineProperty({ ...input }, "reason", { get: () => "count" })]) assert.equal(validateCorrection(value).valid, false);
  });
  check("structured forms reject repeated, unknown and file fields", () => {
    const form = new FormData(); for (const [key, value] of Object.entries(input)) form.append(key, value);
    assert(validateCorrection(form).valid);
    for (const key of Object.keys(input)) { form.append(key, input[key as keyof typeof input]); assert.equal(validateCorrection(form).valid, false); form.delete(key); form.set(key, input[key as keyof typeof input]); }
    form.set("actorAdminId", input.productId); assert.equal(validateCorrection(form).valid, false); form.delete("actorAdminId");
    form.set("reason", new Blob(["reason"]), "reason.txt"); assert.equal(validateCorrection(form).valid, false);
    const params = new URLSearchParams(input); assert(validateCorrection(params).valid); params.append("expectedRevision", "missing"); assert.equal(validateCorrection(params).valid, false);
  });
  console.log(`${passed} correction validation checks passed.`);
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
