import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { normalizeInvitationEmail, invitationEncryptionKey, createInvitationSecret, sealInvitationSecret, openInvitationSecret, invitationVerifier } from "../src/lib/invitation-secrets";

let passed = 0;
function check(name: string, f: () => void) { f(); passed++; console.log(`PASS: ${name}`); }
check("email normalization is bounded, ASCII and deterministic", () => {
  assert.equal(normalizeInvitationEmail("  Staff.Example+Team@EXAMPLE.invalid  "), "staff.example+team@example.invalid");
  for (const bad of ["", "a\n@example.invalid", "x@y", "a..b@example.invalid", ".a@example.invalid", "a@-bad.invalid", "ü@example.invalid", "a".repeat(255)+"@example.invalid"]) assert.throws(() => normalizeInvitationEmail(bad));
});
const key = randomBytes(32).toString("base64"), id = randomUUID();
check("independent encryption key is exactly 256 bits and fail-closed", () => {
  assert.equal(invitationEncryptionKey(undefined, "auth-secret"), null);
  assert.equal(invitationEncryptionKey(key, "auth-secret")!.length, 32);
  for (const bad of ["", "weak", randomBytes(16).toString("base64"), key+"\n"]) assert.throws(() => invitationEncryptionKey(bad, "auth-secret"));
  assert.throws(() => invitationEncryptionKey(key, key));
});
const secret = createInvitationSecret();
check("secret contains 256 random bits with unique hash-only verifiers", () => {
  const secrets = new Set(Array.from({length:100}, () => createInvitationSecret()));
  assert.equal(secrets.size,100);
  for (const s of secrets) { assert.equal(Buffer.from(s,"base64url").length,32); assert.match(invitationVerifier(s),/^[a-f0-9]{64}$/); assert(!invitationVerifier(s).includes(s)); }
});
const sealed = sealInvitationSecret(secret, id, Buffer.from(key,"base64"));
check("encrypted delivery material roundtrips without plaintext", () => {
  assert(!sealed.includes(secret)); assert.equal(openInvitationSecret(sealed,id,Buffer.from(key,"base64")),secret);
});
check("ciphertext is bound to invitation identity and independent key", () => {
  assert.throws(() => openInvitationSecret(sealed,randomUUID(),Buffer.from(key,"base64")));
  assert.throws(() => openInvitationSecret(sealed,id,randomBytes(32)));
  const parts=sealed.split(".");parts[3]=Buffer.from("tampered").toString("base64url");assert.throws(() => openInvitationSecret(parts.join("."),id,Buffer.from(key,"base64")));
});
console.log(`${passed} invitation crypto/input checks passed.`);
