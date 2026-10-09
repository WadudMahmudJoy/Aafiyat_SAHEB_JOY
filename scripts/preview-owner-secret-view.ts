// Disposable local presentation only: no dotenv, auth, database, or filesystem access.
import { randomBytes } from "node:crypto";
import { LocalEnrollmentDisplayError, showLocalEnrollmentUri } from "./local-owner-secret-view";

async function preview() {
  if (process.argv.length !== 2 || process.platform !== "win32" ||
      !process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Preview requires an interactive Windows terminal and no arguments.");
    process.exitCode = 1; return;
  }
  const bytes = randomBytes(20);
  // Twenty random bytes encode to exactly 32 unpadded Base32 characters.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  let secret = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  for (let offset = 0; offset < bits.length; offset += 5) {
    secret += alphabet[parseInt(bits.slice(offset, offset + 5), 2)];
  }
  bytes.fill(0); bits = "";
  const uri = new URL("otpauth://totp/Aafiyat%20TEST:Disposable%20GUI%20acceptance");
  uri.searchParams.set("secret", secret);
  uri.searchParams.set("issuer", "Aafiyat TEST");
  uri.searchParams.set("algorithm", "SHA1");
  uri.searchParams.set("digits", "6");
  uri.searchParams.set("period", "30");
  secret = "";
  console.log("Opening disposable TEST viewer. No database or account is used. Do not capture or share its contents.");
  try {
    await showLocalEnrollmentUri(uri.toString());
    console.log("DONE: disposable preview closed successfully.");
  } finally {
    uri.searchParams.delete("secret");
  }
}

preview().catch(error => {
  if (error instanceof LocalEnrollmentDisplayError && error.reason === "cancelled") {
    console.log("CANCELLED: disposable preview closed without completion (including window timeout).");
    process.exitCode = 2;
  } else {
    console.error("FAILED: disposable preview unavailable, interrupted, or expired; sensitive details withheld.");
    process.exitCode = 1;
  }
});
