// Run: node --conditions=react-server --import tsx scripts/verify-mfa-lifecycle.ts
// One local non-admin identity; all credentials/cookies remain in memory; exact-ID cleanup.
import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { Prisma } from "../src/generated/prisma/client";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { AdminAuthorizationError, requireAdminPermission } from "../src/lib/admin-authorization";
import { GET, POST } from "../src/app/api/auth/[...all]/route";
import { symmetricEncrypt } from "better-auth/crypto";
import { getPublicCategories, getPublicProducts } from "../src/lib/catalog";

const fixtureId = `task008f-${randomUUID()}`;
const membershipId = randomUUID();
const email = `${fixtureId}@example.invalid`;
const password = randomBytes(48).toString("base64url");
const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
const challenges = new Set<string>();
type Jar = Map<string, string>;
let passed = 0;
let stage = "local safety preflight";
let fixtureAttempted = false;

async function test(name: string, run: () => Promise<void>) {
  stage = name; await run(); passed++; console.log(`PASS: ${name}`);
}

// Inspecting installed defaults established six digits, SHA-1, and 30-second steps.
function totp(uri: string) {
  const url = new URL(uri);
  assert.equal(url.protocol, "otpauth:");
  assert.equal(url.hostname, "totp");
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  assert.equal(digits, 6); assert.equal(period, 30);
  let bits = "";
  for (const char of url.searchParams.get("secret")!.toUpperCase().replace(/=+$/, "")) {
    const value = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    assert.ok(value >= 0); bits += value.toString(2).padStart(5, "0");
  }
  const bytes = bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / period)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, "0");
}

async function headers(jar: Jar) {
  return new Headers({ origin, cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") });
}

async function request(jar: Jar, path: string, body?: unknown) {
  const method = body === undefined ? "GET" : "POST";
  const requestHeaders = await headers(jar);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  const req = new Request(`${origin}/api/auth${path}`, {
    method, headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const send = () => (method === "GET" ? GET : POST)(req.clone());
  let response = await send();
  if (response.status === 429) {
    const retry = Number(response.headers.get("X-Retry-After"));
    assert.ok(Number.isFinite(retry) && retry > 0 && retry <= 10);
    await response.body?.cancel(); await setTimeout(retry * 1000 + 100);
    response = await send();
  }
  const challengeName = (await auth.$context).createAuthCookie("two_factor").name;
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (name === challengeName && value) {
      const identifier = decodeURIComponent(value).split(".", 1)[0];
      assert.match(identifier, /^2fa-[A-Za-z0-9_-]+$/);
      challenges.add(identifier);
    }
    if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
  // JSON contains sensitive successful-auth/enrollment data: never log it.
  return { status: response.status, body: await response.json() };
}

async function session(jar: Jar) {
  return auth.api.getSession({ headers: await headers(jar), query: { disableCookieCache: true, disableRefresh: true } });
}

const tables = ["categories", "products", "product_variants", "inventory_balances", "auth_users",
  "auth_sessions", "auth_accounts", "auth_verifications", "auth_two_factors", "admin_roles", "admin_users"];
async function snapshot() {
  // SQL identifiers come solely from the fixed list above; row content stays inside PostgreSQL.
  return prisma.$queryRaw<{ table_name: string; rows: number; fingerprint: string }[]>(Prisma.raw(
    tables.map(table => `SELECT '${table}' AS table_name, count(*)::int AS rows,
      md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]')) AS fingerprint
      FROM "${table}" t`).join(" UNION ALL ") + " ORDER BY table_name",
  ));
}

async function cleanup() {
  if (!fixtureAttempted) return;
  await prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: fixtureId }, select: { email: true } });
    if (user) assert.equal(user.email, email);
    await tx.adminUser.deleteMany({ where: { id: membershipId, userId: fixtureId } });
    assert.equal(await tx.adminUser.count({ where: { userId: fixtureId } }), 0);
    const owned = await tx.verification.findMany({ where: { value: fixtureId }, select: { identifier: true } });
    for (const record of owned) {
      assert.match(record.identifier, /^2fa-[A-Za-z0-9_-]+$/); challenges.add(record.identifier);
    }
    const identifiers = [...challenges].flatMap(id => [id, `2fa-attempts-${id}`]);
    await tx.verification.deleteMany({ where: { OR: [{ value: fixtureId }, { identifier: { in: identifiers } }] } });
    await tx.user.deleteMany({ where: { id: fixtureId, email } }); // Framework-only children cascade.
    assert.equal(await tx.session.count({ where: { userId: fixtureId } }), 0);
    assert.equal(await tx.account.count({ where: { userId: fixtureId } }), 0);
    assert.equal(await tx.twoFactor.count({ where: { userId: fixtureId } }), 0);
    assert.equal(await tx.verification.count({ where: { OR: [{ value: fixtureId }, { identifier: { in: identifiers } }] } }), 0);
  });
}

async function verify() {
  assert.equal(JSON.parse(readFileSync("node_modules/better-auth/package.json", "utf8")).version, "1.7.7");
  const db = new URL(process.env.DATABASE_URL!);
  assert.equal(db.hostname, "127.0.0.1"); assert.equal(db.port, "55432"); assert.equal(db.pathname, "/aafiyat_dev");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname));
  const [identity] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  assert.equal(identity.db, "aafiyat_dev");
  const before = await snapshot();
  // Native verification lookup globally cleans expired verification rows. Stop before writes
  // if existing auth data could be affected; this script is for the current empty auth DB only.
  assert.ok(before.filter(row => row.table_name.startsWith("auth_") || row.table_name === "admin_users").every(row => row.rows === 0));
  assert.equal(auth.options.emailAndPassword.disableSignUp, true);
  assert.equal(auth.options.session.additionalFields.mfaVerifiedAt.input, false);
  assert.equal(auth.options.session.additionalFields.mfaVerifiedAt.returned, false);
  const context = await auth.$context;
  const hash = await context.password.hash(password);
  let uri = "";
  const enrolling: Jar = new Map();
  const older: Jar = new Map();
  const login: Jar = new Map();
  try {
    fixtureAttempted = true;
    await prisma.$transaction(async tx => {
      await tx.user.create({ data: { id: fixtureId, email, name: "Task008E isolated non-admin fixture", emailVerified: true } });
      await tx.account.create({ data: { id: randomUUID(), userId: fixtureId, accountId: fixtureId, providerId: "credential", password: hash } });
    });
    await test("public signup remains disabled with fixture present", async () => {
      assert.equal((await request(new Map(), "/sign-up/email", { email, password, name: "Disabled signup probe" })).status, 400);
      assert.equal(await prisma.user.count({ where: { id: fixtureId } }), 1);
      assert.equal(await prisma.adminUser.count({ where: { userId: fixtureId } }), 0);
    });
    await test("password-only login creates usable pre-enrollment sessions", async () => {
      for (const jar of [enrolling, older]) {
        assert.equal((await request(jar, "/sign-in/email", { email, password, mfaVerifiedAt: new Date().toISOString() })).status, 200);
        assert.equal((await session(jar))?.user.id, fixtureId);
      }
      assert.equal(await prisma.session.count({ where: { userId: fixtureId } }), 2);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId, mfaVerifiedAt: { not: null } } }), 0);
    });
    await test("session column and server-owned configuration default proof to null", async () => {
      const [column] = await prisma.$queryRaw<{ is_nullable: string; column_default: string | null; udt_name: string }[]>`
        SELECT is_nullable, column_default, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'auth_sessions' AND column_name = 'mfa_verified_at'`;
      assert.equal(column.is_nullable, "YES"); assert.equal(column.column_default, null); assert.equal(column.udt_name, "timestamptz");
      const attempted = await context.internalAdapter.createSession(fixtureId, false, { mfaVerifiedAt: new Date() });
      assert.ok(attempted);
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: attempted.id } })).mfaVerifiedAt, null);
      await prisma.session.delete({ where: { id: attempted.id } });
    });
    const olderSession = (await session(older))!.session;
    await test("factor management and secret retrieval remain disabled", async () => {
      assert.equal((await request(enrolling, "/two-factor/enable", { password })).status, 404);
      assert.equal((await request(enrolling, "/two-factor/get-totp-uri", { password })).status, 404);
      assert.equal(await prisma.twoFactor.count({ where: { userId: fixtureId } }), 0);
    });
    // Enrollment/reset HTTP flows are deliberately unavailable. Install only this
    // fixture's encrypted, verified factor directly; do not bypass auth configuration.
    const fixtureSecret = [...randomBytes(32)].map(byte => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte % 32]).join("");
    // Installed createOTP.url base32-encodes the raw secret bytes; the database
    // encrypts the raw secret, not the URI's encoded representation.
    const secretBits = [...Buffer.from(fixtureSecret)].map(byte => byte.toString(2).padStart(8, "0")).join("");
    const encodedSecret = secretBits.match(/.{1,5}/g)!.map(bits => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(bits.padEnd(5, "0"), 2)]).join("");
    uri = `otpauth://totp/Aafiyat?secret=${encodedSecret}&digits=6&period=30`;
    await prisma.$transaction(async tx => {
      await tx.twoFactor.create({ data: { id: randomUUID(), userId: fixtureId, verified: true,
        secret: await symmetricEncrypt({ key: context.secretConfig, data: fixtureSecret }),
        backupCodes: await symmetricEncrypt({ key: context.secretConfig, data: "[]" }) } });
      await tx.user.update({ where: { id: fixtureId }, data: { twoFactorEnabled: true } });
    });
    await test("other password-only session survives enrollment with enabled user flag", async () => {
      const current = (await session(older))!;
      assert.equal(current.session.id, olderSession.id); assert.equal(current.user.twoFactorEnabled, true);
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: olderSession.id } })).mfaVerifiedAt, null);
    });
    const countBeforeLogin = await prisma.session.count({ where: { userId: fixtureId } });
    await test("post-enrollment credentials yield a challenge, not an issued session", async () => {
      const result = await request(login, "/sign-in/email", { email, password });
      assert.equal(result.status, 200); assert.equal(result.body.twoFactorRedirect, true);
      assert.deepEqual(result.body.twoFactorMethods, ["totp"]); assert.equal(result.body.token, undefined);
      assert.equal(await session(login), null);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId } }), countBeforeLogin);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId, mfaVerifiedAt: { not: null } } }), 0);
    });
    const replay = new Map(login);
    await test("invalid challenge TOTP grants no session", async () => {
      assert.equal((await request(login, "/two-factor/verify-totp", { code: "not-a-totp" })).status, 401);
      assert.equal(await session(login), null);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId } }), countBeforeLogin);
    });
    await test("concurrent challenge TOTP creates exactly one proven session", async () => {
      // Leave the native rate-limit window so neither contender is delayed by retry.
      await setTimeout(10_100);
      const beforeVerification = new Date();
      const contenders = [new Map(login), new Map(login)];
      const code = totp(uri);
      const results = await Promise.all(contenders.map(jar => request(jar, "/two-factor/verify-totp", { code })));
      stage = `concurrent results (${results.map(result => result.status).join(",")})`;
      assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
      const winner = contenders[results.findIndex(result => result.status === 200)];
      login.clear(); winner.forEach((value, key) => login.set(key, value));
      const authenticated = (await session(login))!;
      stage = "concurrent winner authoritative session";
      assert.equal(authenticated.user.id, fixtureId);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId } }), countBeforeLogin + 1);
      const proven = await prisma.session.findUniqueOrThrow({ where: { id: authenticated.session.id } });
      stage = "concurrent winner persisted proof";
      assert.ok(proven.mfaVerifiedAt && proven.mfaVerifiedAt >= beforeVerification);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId, mfaVerifiedAt: { not: null } } }), 1);
      assert.equal(Object.hasOwn(authenticated.session, "mfaVerifiedAt"), false);
      const publicResponse = await request(login, "/get-session");
      assert.equal(Object.hasOwn(publicResponse.body.session, "mfaVerifiedAt"), false);
    });
    await test("consumed challenge cannot mint another session", async () => {
      assert.equal((await request(replay, "/two-factor/verify-totp", { code: totp(uri) })).status, 401);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId } }), countBeforeLogin + 1);
      assert.equal(await prisma.session.count({ where: { userId: fixtureId, mfaVerifiedAt: { not: null } } }), 1);
    });
    await test("failed and forged challenges cannot attach proof to another session", async () => {
      const forged = new Map(replay);
      forged.set(context.createAuthCookie("two_factor").name, "forged-probe");
      assert.equal((await request(forged, "/two-factor/verify-totp", { code: totp(uri), mfaVerifiedAt: new Date().toISOString() })).status, 401);
      const current = (await session(login))!;
      const proven = await prisma.session.findUniqueOrThrow({ where: { id: current.session.id } });
      assert.equal((await request(older, "/two-factor/verify-totp", {
        code: "not-a-totp", sessionId: current.session.id, mfaVerifiedAt: proven.mfaVerifiedAt?.toISOString(),
      })).status, 401);
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: olderSession.id } })).mfaVerifiedAt, null);
      assert.deepEqual(await prisma.session.findUniqueOrThrow({ where: { id: current.session.id } }), proven);
    });
    await test("MFA disable and backup recovery remain blocked", async () => {
      assert.equal((await request(login, "/two-factor/disable", { password })).status, 404);
      assert.equal((await request(login, "/two-factor/verify-backup-code", { code: "blocked-recovery-probe" })).status, 404);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: fixtureId } })).twoFactorEnabled, true);
    });
    await test("trusted-device creation and reuse remain blocked", async () => {
      assert.equal((await request(login, "/two-factor/verify-totp", { code: totp(uri), trustDevice: true })).status, 403);
      const trusted = new Map(login); trusted.set(context.createAuthCookie("trust_device").name, "untrusted-probe");
      assert.equal((await request(trusted, "/get-session")).status, 403);
    });
    await test("admin authorization rejects old and TOTP-verified non-admin sessions", async () => {
      for (const jar of [older, enrolling, login]) {
        await assert.rejects(requireAdminPermission("admins:manage", await headers(jar)), (error: unknown) =>
          error instanceof AdminAuthorizationError && error.reason === "ADMIN_MEMBERSHIP_REQUIRED");
      }
    });
    await test("existing-session TOTP cannot borrow login MFA proof", async () => {
      const rowBefore = await prisma.session.findUniqueOrThrow({ where: { id: olderSession.id } });
      assert.equal((await request(older, "/two-factor/verify-totp", { code: totp(uri) })).status, 200);
      assert.equal((await session(older))?.session.id, olderSession.id);
      assert.deepEqual(await prisma.session.findUniqueOrThrow({ where: { id: olderSession.id } }), rowBefore);
      assert.equal(rowBefore.mfaVerifiedAt, null);
      assert.equal(Object.hasOwn((await session(older))!.session, "mfaVerifiedAt"), false);
    });
    const deny = async (jar: Jar, permission: Parameters<typeof requireAdminPermission>[0], reason: string) =>
      assert.rejects(requireAdminPermission(permission, await headers(jar)), (error: unknown) =>
        error instanceof AdminAuthorizationError && error.reason === reason);
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { name: "PRODUCT_MANAGER" } });
    await prisma.adminUser.create({ data: { id: membershipId, userId: fixtureId, roleId: role.id, active: true } });
    const current = (await session(login))!;
    const proven = await prisma.session.findUniqueOrThrow({ where: { id: current.session.id } });
    await test("live unauthenticated and disabled admin requests denied", async () => {
      await deny(new Map(), "catalog:read", "UNAUTHENTICATED");
      await prisma.adminUser.update({ where: { id: membershipId }, data: { disabledAt: new Date() } });
      await deny(login, "catalog:read", "ADMIN_DISABLED");
      await prisma.adminUser.update({ where: { id: membershipId }, data: { disabledAt: null, active: false } });
      await deny(login, "catalog:read", "ADMIN_DISABLED");
      await prisma.adminUser.update({ where: { id: membershipId }, data: { active: true } });
    });
    await test("live proven session receives only its role's permission", async () => {
      assert.deepEqual(await requireAdminPermission("catalog:write", await headers(login)), {
        adminUserId: membershipId, userId: fixtureId, role: "PRODUCT_MANAGER",
      });
      await deny(login, "admins:manage", "PERMISSION_DENIED");
    });
    await test("old password-only sessions and borrowed client proof denied", async () => {
      for (const jar of [older, enrolling]) await deny(jar, "catalog:read", "MFA_NOT_VERIFIED");
      const forged = await headers(older);
      forged.set("x-mfa-verified", proven.mfaVerifiedAt!.toISOString()); forged.set("x-admin-role", "OWNER");
      await assert.rejects(requireAdminPermission("catalog:read", forged), (error: unknown) =>
        error instanceof AdminAuthorizationError && error.reason === "MFA_NOT_VERIFIED");
    });
    await test("missing, future, and pre-session database proof denied", async () => {
      for (const proof of [null, new Date(Date.now() + 60_000), new Date(proven.createdAt.getTime() - 1)]) {
        await prisma.session.update({ where: { id: proven.id }, data: { mfaVerifiedAt: proof } });
        await deny(login, "catalog:read", "MFA_NOT_VERIFIED");
      }
      await prisma.session.update({ where: { id: proven.id }, data: { mfaVerifiedAt: proven.mfaVerifiedAt } });
    });
    await test("MFA assurance older than twelve hours denied despite live session", async () => {
      await prisma.session.update({ where: { id: proven.id }, data: {
        createdAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
        mfaVerifiedAt: new Date(Date.now() - 12 * 60 * 60 * 1000 - 1_000),
      } });
      await deny(login, "catalog:read", "MFA_NOT_VERIFIED");
      await prisma.session.update({ where: { id: proven.id }, data: {
        createdAt: proven.createdAt, mfaVerifiedAt: proven.mfaVerifiedAt,
      } });
    });
    await test("current disabled or unverified factor denies previously proven session", async () => {
      await prisma.user.update({ where: { id: fixtureId }, data: { twoFactorEnabled: false } });
      await deny(login, "catalog:read", "MFA_NOT_VERIFIED");
      await prisma.user.update({ where: { id: fixtureId }, data: { twoFactorEnabled: true } });
      await prisma.twoFactor.updateMany({ where: { userId: fixtureId }, data: { verified: false } });
      await deny(login, "catalog:read", "MFA_NOT_VERIFIED");
      await prisma.twoFactor.updateMany({ where: { userId: fixtureId }, data: { verified: true } });
    });
    await test("catalog remains five categories and empty products", async () => {
      assert.deepEqual((await getPublicCategories()).map(category => category.slug).sort(),
        ["full-shirts", "half-shirts", "panjabi", "sherwani", "t-shirts"]);
      assert.equal((await getPublicProducts()).items.length, 0);
    });
    await test("expired and deleted sessions cannot authorize", async () => {
      await prisma.session.update({ where: { id: olderSession.id }, data: { expiresAt: new Date(0) } });
      await deny(older, "catalog:read", "UNAUTHENTICATED");
      await prisma.session.delete({ where: { id: proven.id } });
      await deny(login, "catalog:read", "UNAUTHENTICATED");
    });
  } finally {
    const previousStage = stage;
    stage = "exact fixture cleanup";
    await cleanup();
    stage = previousStage;
  }
  await test("cleanup preserves all pre-existing table fingerprints and row counts", async () => {
    assert.deepEqual(await snapshot(), before);
  });
  console.log(`${passed} checks passed; 0 failed; 0 skipped. Temporary identity and all related rows removed.`);
  console.log(`Rows: ${before.find(row => row.table_name === "categories")!.rows} categories, ${before.find(row => row.table_name === "admin_roles")!.rows} roles, 0 admin memberships; authentication tables returned to their empty baseline.`);
}

verify().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`Failure type: ${error.name}; code: ${"code" in error && /^P\d{4}$/.test(String(error.code)) ? error.code : "withheld"}.`);
  }
  console.error(`MFA lifecycle verification stopped at ${stage}; ${passed} checks passed; sensitive details withheld.`);
  if (stage === "exact fixture cleanup") console.error(`Cleanup requires review for isolated fixture ID ${fixtureId}.`);
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
