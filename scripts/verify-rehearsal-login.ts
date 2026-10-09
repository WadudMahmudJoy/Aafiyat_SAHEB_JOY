// Focused disposable credential reuse test; never a real Owner or interactive rehearsal.
import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createInterface, emitKeypressEvents } from "node:readline";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { POST } from "../src/app/api/auth/[...all]/route";
import { activatePendingOwner, enrollPendingOwner, provisionInactiveOwner } from "../src/lib/local-owner-bootstrap";
import { challengeHash, prepareRehearsal, cleanupRehearsal, sameSnapshot, rehearsalSnapshot } from "../src/lib/local-owner-rehearsal";

function totp(uri: string) {
  const encoded = new URL(uri).searchParams.get("secret")!;
  const bits = [...encoded.replace(/=+$/, "")].map(char => {
    const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); assert(n >= 0); return n.toString(2).padStart(5, "0");
  }).join("");
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)))).update(counter).digest();
  return ((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

let stage = "read-only preflight";
let passed = 0;
async function verify() {
  const journal = await prepareRehearsal();
  const directory = resolve(".local"); const journalPath = resolve(directory, "owner-rehearsal.json");
  const lockPath = resolve(directory, "owner-rehearsal.lock");
  assert.equal(resolve("."), "D:\\Aafiyat_SAHEB_JOY");
  assert(!existsSync(journalPath), "Existing recovery journal requires reviewed cleanup");
  assert(!existsSync(lockPath), "Operator lock must be absent");
  if (existsSync(directory)) assert(!lstatSync(directory).isSymbolicLink());
  function save() {
    assert(!JSON.stringify(journal).includes(password), "Recovery metadata must not contain the password");
    mkdirSync(directory, { recursive: true });
    const temporary = resolve(directory, `owner-rehearsal-${randomUUID()}.json`);
    // Non-secret identifiers/hashes/fingerprints only, compatible with operator --cleanup.
    writeFileSync(temporary, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
    renameSync(temporary, journalPath);
  }
  const source = readFileSync("scripts/rehearse-owner-onboarding.ts", "utf8");
  const functionSource = source.slice(source.indexOf("async function ask("), source.indexOf("async function cleanup("));
  const input = new PassThrough() as PassThrough & { setRawMode: (value: boolean) => void };
  input.setRawMode = () => undefined;
  Object.defineProperty(input, "isTTY", { value: true });
  const terminal = new EventEmitter() as EventEmitter & { stdin: typeof input; stdout: { write: (value: string) => void } };
  let output = ""; terminal.stdin = input; terminal.stdout = { write: value => { output += value; } };
  const { hidden, ask } = runInNewContext(ts.transpile(functionSource + "\n({ hidden, ask })", { target: ts.ScriptTarget.ES2022 }),
    { process: terminal, emitKeypressEvents, createInterface }) as {
      hidden: (label: string) => Promise<string>; ask: (label: string) => Promise<string>;
    };
  const password = randomBytes(24).toString("base64url") + "Aa!@# ";
  async function enter(text: string) {
    const pending = hidden("Hidden test input: ");
    input.write(text + "\r"); return pending;
  }
  stage = "hidden input";
  const confirmation = ask("Disposable confirmation: "); input.write("CONFIRM\r");
  assert.equal(await confirmation, "CONFIRM");
  const first = await enter(password); const repeated = await enter(password); const login = await enter(password);
  assert.equal(first, password); assert.equal(repeated, password); assert.equal(login, password);
  assert(!output.includes(password)); assert.equal(input.listenerCount("keypress"), 0);
  passed += 3; console.log("PASS: repeated hidden input preserves mixed characters without echo or leftover listeners");
  const edited = await enter(password + "x\x7f"); assert.equal(edited, password); passed++;
  assert.equal(await enter("\x1b[200~" + password + "\x1b[201~"), password); passed++;
  const cancelled = assert.rejects(hidden("Cancel test input: "));
  input.write("\x03"); await cancelled; assert.equal(input.listenerCount("keypress"), 0); passed++;
  stage = "credential creation";
  mkdirSync(directory, { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  try {
    save(); // Durable exact recovery data before fixture writes.
    const fixture = await provisionInactiveOwner({ email: journal.email, name: journal.name, password: first });
    journal.userId = fixture.userId; journal.membershipId = fixture.membershipId;
    save();
    const account = await prisma.account.findFirstOrThrow({ where: { userId: fixture.userId, providerId: "credential" } });
    assert.equal(account.accountId, fixture.userId);
    assert(await (await auth.$context).password.verify({ hash: account.password!, password: login }));
    passed++; console.log("PASS: framework password hash and credential account binding");
    let jar = new Map<string, string>();
    const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
    const headers = (cookies = jar) => new Headers({ origin, cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join("; ") });
    // Exercise the rehearsal's exact request function without running its CLI.
    const requestSource = source.slice(source.indexOf("async function request(jar:"), source.indexOf("async function login(requireTotp:"));
    const allowlistSource = source.slice(source.indexOf("const diagnosticAuthCodes ="), source.indexOf("function markStage("));
    const diagnosticAuthCodes = runInNewContext(allowlistSource + "\ndiagnosticAuthCodes") as Set<string>;
    const diagnostics = { headers, origin, POST, auth, Request, delay, diagnosticAuthCodes, challengeHash,
      stage: "fixture request", httpStatus: undefined as number | undefined, authErrorCode: undefined as string | undefined,
      markStage: (value: string) => { diagnostics.stage = value; diagnostics.httpStatus = undefined; diagnostics.authErrorCode = undefined; },
      j: journal, save };
    const request = runInNewContext(ts.transpile(requestSource + "\nrequest", { target: ts.ScriptTarget.ES2022 }), diagnostics) as
      (cookies: Map<string,string>, path: string, body: unknown) => Promise<{ twoFactorRedirect?: boolean }>;
    const loginSource = source.slice(source.indexOf("async function login(requireTotp:"), source.indexOf("async function denied("));
    let enrollmentUri = ""; let totpPrompts = 0; let credentialRequests = 0;
    const reusedRequest = async (cookies: Map<string,string>, path: string, body: { password?: string }) => {
      if (path === "/sign-in/email") { assert.equal(body.password, first); credentialRequests++; }
      return request(cookies, path, body);
    };
    const reusedLogin = runInNewContext(ts.transpile(loginSource + "\nlogin", { target: ts.ScriptTarget.ES2022 }), {
      request: reusedRequest, password: first, bound: journal, jars: [], stage: "fixture login",
      hidden: async (label: string) => {
        assert.equal(label, "Fresh login TOTP (hidden): ", "Credential login must never prompt for password");
        totpPrompts++; return totp(enrollmentUri);
      },
    }) as (requiresTotp: boolean) => Promise<Map<string,string>>;
    stage = "first credential HTTP login";
    jar = await reusedLogin(false); passed++;
    const session = await auth.api.getSession({ headers: headers(), query: { disableCookieCache: true, disableRefresh: true } });
    assert.equal(session?.user.id, fixture.userId); passed++;
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: session!.session.id } })).mfaVerifiedAt, null); passed++;
    assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { userId: fixture.userId } })).active, false); passed++;
    console.log("PASS: first credential login, exact session, NULL MFA proof, inactive membership");
    stage = "second correct-password login";
    const enrollment = await reusedLogin(false); passed++;
    const beforeAccount = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    stage = "controlled TOTP enrollment";
    const factor = await enrollPendingOwner(fixture.userId, headers(enrollment), login);
    enrollmentUri = factor.totpURI;
    await request(enrollment, "/two-factor/verify-totp", { code: totp(factor.totpURI) });
    assert.equal((await prisma.twoFactor.findFirstOrThrow({ where: { userId: fixture.userId } })).verified, true);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } })).twoFactorEnabled, true);
    assert.deepEqual(await prisma.account.findUniqueOrThrow({ where: { id: account.id } }), beforeAccount); passed++;
    assert.equal(await prisma.session.count({ where: { userId: fixture.userId, mfaVerifiedAt: { not: null } } }), 0); passed++;
    console.log("PASS: second login and enrollment; credential account unchanged; enrollment grants no login proof");
    stage = "fresh correct-password post-enrollment login";
    const fresh = await reusedLogin(true);
    assert.equal(diagnostics.httpStatus, 200); passed++;
    const proven = await auth.api.getSession({ headers: headers(fresh), query: { disableCookieCache: true, disableRefresh: true } });
    assert.equal(proven?.user.id, fixture.userId);
    assert((await prisma.session.findUniqueOrThrow({ where: { id: proven!.session.id } })).mfaVerifiedAt);
    assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { userId: fixture.userId } })).active, false); passed++;
    console.log("PASS: correct password after enrollment returns HTTP 200 challenge; TOTP creates exact proven session; Owner remains inactive");
    stage = "disposable activation and final reused-password login";
    await activatePendingOwner(fixture.userId, headers(fresh));
    assert.equal(await auth.api.getSession({ headers: headers(jar), query: { disableCookieCache: true, disableRefresh: true } }), null); passed++;
    const final = await reusedLogin(true);
    const finalSession = await auth.api.getSession({ headers: headers(final), query: { disableCookieCache: true, disableRefresh: true } });
    assert.equal(finalSession?.user.id, fixture.userId);
    assert((await prisma.session.findUniqueOrThrow({ where: { id: finalSession!.session.id } })).mfaVerifiedAt); passed++;
    assert.equal(credentialRequests, 4); assert.equal(totpPrompts, 2); passed++;
    enrollmentUri = "";
    console.log("PASS: four credential logins reuse the confirmed password, including post-activation; only TOTP prompts occur; old session revoked");
    stage = "incorrect credential denial";
    await assert.rejects(request(new Map(), "/sign-in/email", { email: journal.email, password: randomBytes(24).toString("base64url") }));
    assert.equal(diagnostics.stage, "credential HTTP rejection"); assert.equal(diagnostics.httpStatus, 401);
    assert.equal(diagnostics.authErrorCode, "INVALID_EMAIL_OR_PASSWORD");
    passed++;
    await assert.rejects(request(new Map(), "/sign-in/email", { email: journal.email, password: "" }));
    assert.equal(diagnostics.stage, "credential HTTP rejection"); assert.equal(diagnostics.httpStatus, 401); passed++;
    console.log("PASS: incorrect/empty passwords after enrollment return HTTP 401; INVALID_EMAIL_OR_PASSWORD");
  } finally {
    const originalStage = stage;
    stage = "exact fixture cleanup";
    await cleanupRehearsal(journal, `DELETE TEST ${journal.tag}`);
    unlinkSync(journalPath); // Keep recovery metadata if cleanup throws.
    unlinkSync(lockPath);
    stage = originalStage;
  }
  const after = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`; return rehearsalSnapshot(tx);
  });
  assert(sameSnapshot(after, journal.baseline)); passed++;
  console.log(`${passed} focused login checks passed; all 12 fingerprints restored; no Owner remains.`);
}
verify().catch(() => {
  console.error(`Focused login failed at ${stage}; ${passed} checks passed; sensitive details withheld.`);
  if (existsSync(resolve(".local/owner-rehearsal.json"))) console.error("Recovery metadata retained; stop other auth processes and use the rehearsal --cleanup command after review.");
  process.exitCode = 1;
})
  .finally(async () => { await prisma.$disconnect(); });
