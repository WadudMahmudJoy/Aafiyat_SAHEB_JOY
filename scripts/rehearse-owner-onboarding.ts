// --check is read-only. All fixture writes require future interactive operator action.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { POST } from "../src/app/api/auth/[...all]/route";
import { AdminAuthorizationError, requireAdminPermission } from "../src/lib/admin-authorization";
import { provisionInactiveOwner, enrollPendingOwner, activatePendingOwner } from "../src/lib/local-owner-bootstrap";
import { assertJournal, bindRehearsal, challengeHash, cleanupRehearsal, prepareRehearsal,
  type RehearsalJournal } from "../src/lib/local-owner-rehearsal";
import { showLocalEnrollmentUri } from "./local-owner-secret-view";

const root = resolve(".");
const directory = resolve(root, ".local");
const journalPath = resolve(directory, "owner-rehearsal.json");
const lockPath = resolve(directory, "owner-rehearsal.lock");
// Static stages and numeric statuses only. Never report an exception or auth body.
let stage = "argument validation";
let httpStatus: number | undefined;
let authErrorCode: string | undefined;
const diagnosticAuthCodes = new Set([
  "INVALID_EMAIL_OR_PASSWORD", "FAILED_TO_CREATE_SESSION", "INVALID_EMAIL", "EMAIL_NOT_VERIFIED",
  "INVALID_CODE", "INVALID_TWO_FACTOR_COOKIE", "TOTP_NOT_ENABLED", "TWO_FACTOR_NOT_ENABLED",
  "ACCOUNT_TEMPORARILY_LOCKED", "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE", "AUTH_UNAVAILABLE",
]);
function markStage(value: string) { stage = value; httpStatus = undefined; authErrorCode = undefined; }
function safeDirectory() {
  if (root !== "D:\\Aafiyat_SAHEB_JOY" || (existsSync(directory) && lstatSync(directory).isSymbolicLink())) throw new Error("Wrong local workspace.");
  mkdirSync(directory, { recursive: true });
}
function readJournal() {
  if (lstatSync(journalPath).isSymbolicLink()) throw new Error("Invalid journal.");
  const j: unknown = JSON.parse(readFileSync(journalPath, "utf8")); assertJournal(j); return j;
}
function save(j: RehearsalJournal) {
  assertJournal(j);
  const temporary = resolve(directory, `owner-rehearsal-${randomUUID()}.json`);
  // Only hashes/fixture identifiers/fingerprints. Never credentials, cookies, or TOTP data.
  writeFileSync(temporary, JSON.stringify(j, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, journalPath);
}
function lock(allowStale: boolean) {
  safeDirectory();
  if (existsSync(lockPath)) {
    if (lstatSync(lockPath).isSymbolicLink()) throw new Error("Invalid lock.");
    const record: { pid: number } = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(record.pid) || record.pid <= 0) throw new Error("Invalid lock.");
    let alive = true;
    try { process.kill(record.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive || !allowStale) throw new Error("Another operator run may still be active.");
    unlinkSync(lockPath); // Recovery only, after confirmation; never kill another process.
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  return () => unlinkSync(lockPath);
}
async function ask(label: string) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return await new Promise<string>((resolveAnswer, reject) => {
    const cancel = () => { reader.close(); reject(new Error("Cancelled.")); };
    reader.once("SIGINT", cancel); reader.once("close", cancel);
    reader.question(label, value => { reader.off("SIGINT", cancel); reader.off("close", cancel); resolveAnswer(value); });
  }); } finally { reader.close(); }
}
async function hidden(label: string) {
  process.stdout.write(label); emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise<string>((resolveAnswer, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("keypress", listener); process.stdin.off("end", cancel); process.stdin.off("close", cancel);
      process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n");
    };
    const cancel = () => { value = ""; finish(); reject(new Error("Cancelled.")); };
    const listener = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) cancel();
      else if (["enter", "return"].includes(key.name ?? "")) { finish(); resolveAnswer(value); }
      else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on("keypress", listener); process.stdin.once("end", cancel); process.stdin.once("close", cancel);
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  });
}
async function cleanup() {
  safeDirectory(); const j = readJournal();
  console.log(`Cleanup is restricted to disposable TEST run ${j.tag}. Stop any other authentication server or operator process first.`);
  const confirmation = await ask(`Type DELETE TEST ${j.tag}: `);
  if (confirmation !== `DELETE TEST ${j.tag}`) throw new Error("Cancelled.");
  const release = lock(true);
  try {
    await cleanupRehearsal(j, confirmation);
    unlinkSync(journalPath);
    console.log("PASS: exact TEST fixture removed; all 12 table fingerprints restored.");
  } finally { release(); }
}
async function start() {
  markStage("operator lock");
  if (existsSync(journalPath)) throw new Error("Existing journal requires reviewed cleanup; never overwrite it.");
  const release = lock(false);
  const jars: Map<string, string>[] = [];
  let j: RehearsalJournal | undefined;
  let password = ""; // Disposable rehearsal only; never journaled or retained beyond finally.
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  const headers = (jar: Map<string, string>) => new Headers({ origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
  try {
    if (await ask("Stop other auth servers. Type START DISPOSABLE OWNER REHEARSAL: ") !== "START DISPOSABLE OWNER REHEARSAL") throw new Error("Cancelled.");
    markStage("local database preflight");
    j = await prepareRehearsal(); save(j); // Recovery journal exists before any fixture write.
    console.log(`TEST identity: ${j.email}`);
    markStage("disposable password input");
    password = await hidden("Choose disposable password (hidden, 12–128 characters): ");
    let repeated = "";
    try {
      repeated = await hidden("Repeat disposable password (hidden): ");
      if (password !== repeated) throw new Error("Passwords differ.");
    } finally { repeated = ""; }
    markStage("inactive TEST identity creation");
    const pending = await provisionInactiveOwner({ email: j.email, name: j.name, password });
    j.userId = pending.userId; j.membershipId = pending.membershipId; save(j);
    markStage("exact TEST identity binding");
    const bound = await prisma.$transaction(tx => bindRehearsal(j!, tx));
    if (!bound) throw new Error("Fixture missing.");
    console.log("PASS: initial TEST Owner is inactive.");
    async function request(jar: Map<string, string>, path: string, body: unknown) {
      markStage(path === "/sign-in/email" ? "credential HTTP request" :
        path === "/two-factor/verify-totp" ? "TOTP verification HTTP request" : "authentication HTTP request");
      const h = headers(jar); h.set("content-type", "application/json");
      const req = new Request(`${origin}/api/auth${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
      let response = await POST(req.clone());
      httpStatus = response.status;
      if (response.status === 429) {
        const retry = Number(response.headers.get("X-Retry-After"));
        if (!Number.isFinite(retry) || retry <= 0 || retry > 10) throw new Error("Rate limited.");
        await response.body?.cancel(); await delay(retry * 1000 + 100);
        response = await POST(req.clone()); // Preserve framework rate limits; one bounded retry.
        httpStatus = response.status;
      }
      if (!response.ok) {
        stage = path === "/sign-in/email" ? "credential HTTP rejection" :
          path === "/two-factor/verify-totp" ? "TOTP verification HTTP rejection" : "authentication HTTP rejection";
        // Read in memory; report only these installed-framework constants, never arbitrary response text.
        authErrorCode = "UNCLASSIFIED_AUTH_ERROR";
        try {
          const body: { code?: unknown } = await response.clone().json();
          if (typeof body?.code === "string" && diagnosticAuthCodes.has(body.code)) authErrorCode = body.code;
        } catch { /* Status and static stage are sufficient for non-JSON failures. */ }
        throw new Error("Authentication refused.");
      }
      stage = "authentication cookie processing";
      const challengeCookie = (await auth.$context).createAuthCookie("two_factor").name;
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0]; const separator = pair.indexOf("=");
        const key = pair.slice(0, separator); const value = pair.slice(separator + 1);
        if (key === challengeCookie && value) {
          const id = decodeURIComponent(value).split(".", 1)[0];
          if (!/^2fa-[A-Za-z0-9_-]+$/.test(id)) throw new Error("Unexpected challenge.");
          j!.challengeHashes.push(challengeHash(id)); save(j!); // Before any operator TOTP verification.
        }
        if (!value || /max-age=0/i.test(cookie)) jar.delete(key); else jar.set(key, value);
      }
      stage = "authentication response parsing";
      return response.json();
    }
    async function login(requireTotp: boolean) {
      const jar = new Map<string, string>(); jars.push(jar);
      const result = await request(jar, "/sign-in/email", { email: bound!.email, password });
      stage = "credential login response validation";
      if (Boolean(result.twoFactorRedirect) !== requireTotp) throw new Error("Unexpected login state.");
      if (requireTotp) await request(jar, "/two-factor/verify-totp", { code: await hidden("Fresh login TOTP (hidden): ") });
      return jar;
    }
    async function denied(jar: Map<string, string>, permission = "admins:manage") {
      try { await requireAdminPermission(permission as "admins:manage", headers(jar)); }
      catch (error) {
        if (error instanceof AdminAuthorizationError && error.reason !== "AUTHORIZATION_UNAVAILABLE") return;
        throw error;
      }
      throw new Error("Unexpected permission grant.");
    }
    const old = await login(false);
    markStage("password-only authorization denial check"); await denied(old);
    const enrollment = await login(false);
    markStage("controlled enrollment");
    let uri = "";
    try {
      uri = (await enrollPendingOwner(bound.userId!, headers(enrollment), password)).totpURI;
      await showLocalEnrollmentUri(uri);
    } finally { uri = ""; }
    await request(enrollment, "/two-factor/verify-totp", { code: await hidden("Enrollment TOTP (hidden): ") });
    const authenticated = await auth.api.getSession({ headers: headers(enrollment), query: { disableCookieCache: true, disableRefresh: true } });
    const row = authenticated && await prisma.session.findUnique({ where: { id: authenticated.session.id } });
    if (!row || row.mfaVerifiedAt !== null) throw new Error("Enrollment gained login proof.");
    await denied(enrollment); await denied(old);
    console.log("PASS: enrollment and old password-only sessions grant no admin access.");
    const activation = await login(true); await denied(activation);
    markStage("controlled activation");
    if (await ask("Confirm intended TEST identity. Type ACTIVATE TEST OWNER: ") !== "ACTIVATE TEST OWNER") throw new Error("Cancelled.");
    await activatePendingOwner(bound.userId!, headers(activation));
    await requireAdminPermission("admins:manage", headers(activation));
    await denied(activation, "unknown:permission"); await denied(old); await denied(enrollment);
    console.log("PASS: controlled activation, allowed permission, unknown-permission denial, and old-session revocation.");
    const current = await login(true);
    await requireAdminPermission("catalog:write", headers(current));
    await request(current, "/sign-out", {}); await denied(current);
    console.log("PASS: fresh post-activation login authorizes; signed-out session is denied.");
    console.log("OWNER policy grants every listed permission; unauthorized probes use an unknown permission and unauthenticated/revoked sessions.");
  } finally {
    password = ""; // Release this reference; JavaScript does not guarantee secure memory erasure.
    // Normal sign-out only. Deleting fixture records always needs the separate confirmation.
    for (const jar of jars) {
      try { await auth.api.signOut({ headers: headers(jar) }); } catch { /* Exact cleanup remains mandatory. */ }
      jar.clear();
    }
    release();
  }
  await cleanup();
}
async function run() {
  if (process.argv.length !== 3 || !["--check", "--start", "--cleanup"].includes(process.argv[2])) throw new Error("One operation flag required.");
  if (process.argv[2] === "--check") {
    markStage("read-only preflight");
    await prepareRehearsal();
    console.log("PASS: read-only local rehearsal preflight; no identity, journal, or database writes."); return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.platform !== "win32") throw new Error("Interactive Windows terminal required.");
  if (process.argv[2] === "--cleanup") await cleanup(); else await start();
}
run().catch(() => {
  const status = Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? `; HTTP ${httpStatus}` : "";
  const code = authErrorCode && (diagnosticAuthCodes.has(authErrorCode) || authErrorCode === "UNCLASSIFIED_AUTH_ERROR") ? `; ${authErrorCode}` : "";
  console.error(`Rehearsal stopped at ${stage}${status}${code}.`);
  console.error("Rehearsal refused, cancelled, or failed; sensitive details withheld. If a journal exists, use --cleanup after review.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
