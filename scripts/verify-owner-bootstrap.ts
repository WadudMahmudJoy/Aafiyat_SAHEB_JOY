// Temporary local identities only; never prints credentials, factor URIs, or cookies.
import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { AdminAuthorizationError, requireAdminPermission } from "../src/lib/admin-authorization";
import { checkOwnerBootstrap, provisionInactiveOwner, enrollPendingOwner, checkPendingOwnerActivation,
  resumePendingOwnerEnrollment, activatePendingOwner, findPendingOwner } from "../src/lib/local-owner-bootstrap";
import { GET, POST } from "../src/app/api/auth/[...all]/route";
import { showLocalEnrollmentUri } from "./local-owner-secret-view";

const tag = `task008g-${randomUUID()}`;
const ownerEmail = `${tag}-owner@example.invalid`;
const otherEmail = `${tag}-other@example.invalid`;
const otherId = randomUUID();
const password = randomBytes(48).toString("base64url");
const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
type Jar = Map<string, string>;
const challenges = new Set<string>();
let passed = 0;
let stage = "preflight";
let writes = false;
const tables = ["categories", "products", "product_variants", "inventory_balances", "admin_roles", "admin_users",
  "auth_users", "auth_accounts", "auth_sessions", "auth_two_factors", "auth_verifications"];
const snapshot = () => prisma.$queryRaw<{ name: string; rows: number; fingerprint: string }[]>(Prisma.raw(
  tables.map(table => `SELECT '${table}' AS name, count(*)::int AS rows,
    md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS fingerprint FROM "${table}" t`)
    .join(" UNION ALL ") + " ORDER BY name"));
const headers = (jar: Jar) => new Headers({ origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
const session = (jar: Jar) => auth.api.getSession({ headers: headers(jar), query: { disableCookieCache: true, disableRefresh: true } });
async function test(name: string, run: () => Promise<void>) { stage = name; await run(); passed++; console.log(`PASS: ${name}`); }

async function request(jar: Jar, path: string, body?: unknown) {
  const method = body === undefined ? "GET" : "POST";
  const requestHeaders = headers(jar);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const req = new Request(`${origin}/api/auth${path}`, { method, headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const send = () => (method === "GET" ? GET : POST)(req.clone());
  let response = await send();
  if (response.status === 429) {
    const retry = Number(response.headers.get("X-Retry-After"));
    assert.ok(retry > 0 && retry <= 10); await response.body?.cancel(); await setTimeout(retry * 1000 + 100);
    response = await send();
  }
  const name = (await auth.$context).createAuthCookie("two_factor").name;
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0]; const separator = pair.indexOf("=");
    const key = pair.slice(0, separator); const value = pair.slice(separator + 1);
    if (key === name && value) {
      const identifier = decodeURIComponent(value).split(".", 1)[0];
      assert.match(identifier, /^2fa-[A-Za-z0-9_-]+$/); challenges.add(identifier);
    }
    if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) jar.delete(key); else jar.set(key, value);
  }
  return { status: response.status, body: await response.json() };
}
function totp(uri: string) {
  const encoded = new URL(uri).searchParams.get("secret")!;
  const bits = [...encoded.replace(/=+$/, "")].map(char => {
    const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); assert.ok(n >= 0); return n.toString(2).padStart(5, "0");
  }).join("");
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)))).update(counter).digest();
  return ((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

async function verify() {
  await checkOwnerBootstrap();
  const before = await snapshot();
  assert.ok(before.filter(row => row.name.startsWith("auth_") || row.name === "admin_users").every(row => row.rows === 0));
  const context = await auth.$context;
  await test("private secret viewer refuses non-interactive execution", async () => {
    assert.equal(Boolean(process.stdin.isTTY && process.stdout.isTTY), false);
    await assert.rejects(showLocalEnrollmentUri("otpauth://totp/Aafiyat?secret=PLACEHOLDER"));
  });
  const hash = await context.password.hash(password);
  const owner: Jar = new Map(); const old: Jar = new Map(); const other: Jar = new Map(); const login: Jar = new Map();
  try {
    writes = true;
    await prisma.$transaction(async tx => {
      await tx.user.create({ data: { id: otherId, name: "Temporary non-Owner", email: otherEmail } });
      await tx.account.create({ data: { id: randomUUID(), userId: otherId, accountId: otherId, providerId: "credential", password: hash } });
    });
    await test("bootstrap refuses existing account rather than promoting or overwriting", async () => {
      await assert.rejects(provisionInactiveOwner({ email: otherEmail, name: "Collision probe", password }));
      assert.equal(await prisma.adminUser.count(), 0);
    });
    const pending = await provisionInactiveOwner({ email: ownerEmail, name: "Temporary pending Owner", password });
    await test("resume selects exact single inactive Owner without account duplication", async () => {
      assert.equal((await findPendingOwner(ownerEmail)).userId, pending.userId);
      await assert.rejects(findPendingOwner(otherEmail));
      assert.equal(await prisma.user.count(), 2);
    });
    await test("explicit bootstrap creates inactive membership and refuses another Owner", async () => {
      assert.equal(pending.active, false);
      assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { userId: pending.userId } })).active, false);
      await assert.rejects(provisionInactiveOwner({ email: `${tag}-duplicate@example.invalid`, name: "Duplicate", password }));
      assert.equal(await prisma.adminUser.count(), 1);
    });
    await test("public signup and public enrollment remain disabled", async () => {
      assert.equal((await request(new Map(), "/sign-up/email", { name: "Denied", email: ownerEmail, password })).status, 400);
      assert.equal((await request(new Map(), "/two-factor/enable", { password })).status, 404);
    });
    for (const jar of [owner, old]) assert.equal((await request(jar, "/sign-in/email", { email: ownerEmail, password })).status, 200);
    assert.equal((await request(other, "/sign-in/email", { email: otherEmail, password })).status, 200);
    await test("non-Owner or wrong authenticated identity cannot enroll pending Owner", async () => {
      await assert.rejects(enrollPendingOwner(otherId, headers(other), password));
      await assert.rejects(enrollPendingOwner(pending.userId, headers(other), password));
      await assert.rejects(enrollPendingOwner(pending.userId, new Headers(), password));
      assert.equal(await prisma.twoFactor.count(), 0);
    });
    await test("inactive Owner and password-only activation requests denied", async () => {
      await assert.rejects(requireAdminPermission("admins:manage", headers(owner)), (error: unknown) =>
        error instanceof AdminAuthorizationError && error.reason === "ADMIN_DISABLED");
      await assert.rejects(checkPendingOwnerActivation(pending.userId, headers(owner)));
      await assert.rejects(activatePendingOwner(pending.userId, headers(owner)));
      assert.equal((await request(owner, "/two-factor/enable", { password })).status, 404);
    });
    await test("local enrollment requires current password and cannot write login proof", async () => {
      await assert.rejects(enrollPendingOwner(pending.userId, headers(owner), randomBytes(48).toString("base64url")));
      assert.equal(await prisma.twoFactor.count(), 0);
    });
    const outcomes = await Promise.allSettled([
      enrollPendingOwner(pending.userId, headers(owner), password),
      enrollPendingOwner(pending.userId, headers(owner), password),
    ]);
    const enrolled = outcomes.find(result => result.status === "fulfilled");
    assert.ok(enrolled?.status === "fulfilled");
    const factor = enrolled.value;
    const oldSessionId = (await session(old))!.session.id;
    await test("concurrent controlled enrollment creates one unverified factor; replacement denied", async () => {
      assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
      assert.equal(await prisma.twoFactor.count({ where: { userId: pending.userId } }), 1);
      assert.equal((await prisma.twoFactor.findFirstOrThrow({ where: { userId: pending.userId } })).verified, false);
      await assert.rejects(enrollPendingOwner(pending.userId, headers(owner), password));
      assert.equal(await prisma.session.count({ where: { userId: pending.userId, mfaVerifiedAt: { not: null } } }), 0);
    });
    await test("interrupted enrollment resumes identical factor only with current Owner credentials", async () => {
      const beforeFactor = await prisma.twoFactor.findFirstOrThrow({ where: { userId: pending.userId } });
      const beforeAccount = await prisma.account.findFirstOrThrow({ where: { userId: pending.userId } });
      await assert.rejects(resumePendingOwnerEnrollment(pending.userId, headers(other), password));
      await assert.rejects(resumePendingOwnerEnrollment(pending.userId, headers(owner), randomBytes(48).toString("base64url")));
      const resumed = await resumePendingOwnerEnrollment(pending.userId, headers(owner), password);
      assert.equal(resumed.totpURI, factor.totpURI);
      assert.deepEqual(await prisma.twoFactor.findFirstOrThrow({ where: { userId: pending.userId } }), beforeFactor);
      assert.deepEqual(await prisma.account.findFirstOrThrow({ where: { userId: pending.userId } }), beforeAccount);
      assert.equal((await request(owner, "/two-factor/get-totp-uri", { password })).status, 404);
    });
    await test("enrollment TOTP and surviving old sessions gain no login proof", async () => {
      assert.equal((await request(owner, "/two-factor/verify-totp", { code: "not-a-totp" })).status, 401);
      assert.equal((await request(owner, "/two-factor/verify-totp", { code: totp(factor.totpURI) })).status, 200);
      assert.equal((await session(old))!.session.id, oldSessionId);
      assert.equal(await prisma.session.count({ where: { userId: pending.userId, mfaVerifiedAt: { not: null } } }), 0);
      await assert.rejects(checkPendingOwnerActivation(pending.userId, headers(owner)));
      await assert.rejects(checkPendingOwnerActivation(pending.userId, headers(old)));
      await assert.rejects(activatePendingOwner(pending.userId, headers(owner)));
      await assert.rejects(activatePendingOwner(pending.userId, headers(old)));
      await assert.rejects(requireAdminPermission("admins:manage", headers(old)));
    });
    await test("verified factors cannot be retrieved or replaced by interrupted-setup path", async () => {
      const beforeFactor = await prisma.twoFactor.findFirstOrThrow({ where: { userId: pending.userId } });
      await assert.rejects(resumePendingOwnerEnrollment(pending.userId, headers(owner), password));
      await assert.rejects(enrollPendingOwner(pending.userId, headers(owner), password));
      assert.deepEqual(await prisma.twoFactor.findFirstOrThrow({ where: { userId: pending.userId } }), beforeFactor);
    });
    await test("fresh credential-login TOTP provides eligibility without activation", async () => {
      const challenge = await request(login, "/sign-in/email", { email: ownerEmail, password });
      assert.equal(challenge.body.twoFactorRedirect, true); assert.equal(await session(login), null);
      assert.equal((await request(login, "/two-factor/verify-totp", { code: totp(factor.totpURI) })).status, 200);
      assert.equal((await checkPendingOwnerActivation(pending.userId, headers(login))).eligible, true);
      await assert.rejects(requireAdminPermission("admins:manage", headers(login)), (error: unknown) =>
        error instanceof AdminAuthorizationError && error.reason === "ADMIN_DISABLED");
      assert.equal(await prisma.adminUser.count({ where: { active: true } }), 0);
    });
    await test("non-Owner role cannot activate any Owner", async () => {
      const role = await prisma.adminRole.findUniqueOrThrow({ where: { name: "PRODUCT_MANAGER" } });
      await prisma.adminUser.create({ data: { userId: otherId, roleId: role.id, active: false } });
      await assert.rejects(activatePendingOwner(otherId, headers(other)));
      await assert.rejects(activatePendingOwner(pending.userId, headers(other)));
    });
    const proven = await prisma.session.findUniqueOrThrow({ where: { id: (await session(login))!.session.id } });
    await test("competing active Owner prevents activation", async () => {
      const member = await prisma.adminUser.findUniqueOrThrow({ where: { userId: otherId } });
      const ownerRole = await prisma.adminRole.findUniqueOrThrow({ where: { name: "OWNER" } });
      try {
        await prisma.adminUser.update({ where: { id: member.id }, data: { roleId: ownerRole.id, active: true } });
        await assert.rejects(activatePendingOwner(pending.userId, headers(login)));
      } finally {
        await prisma.adminUser.update({ where: { id: member.id }, data: { roleId: member.roleId, active: false } });
      }
    });
    await test("missing or stale activation proof cannot promote membership", async () => {
      for (const proof of [null, new Date(proven.createdAt.getTime() - 1)]) {
        await prisma.session.update({ where: { id: proven.id }, data: { mfaVerifiedAt: proof } });
        await assert.rejects(activatePendingOwner(pending.userId, headers(login)));
      }
      await prisma.session.update({ where: { id: proven.id }, data: { createdAt: new Date(Date.now() - 600_000), mfaVerifiedAt: new Date(Date.now() - 360_000) } });
      await assert.rejects(activatePendingOwner(pending.userId, headers(login)));
      await prisma.session.update({ where: { id: proven.id }, data: { createdAt: proven.createdAt, mfaVerifiedAt: proven.mfaVerifiedAt } });
      assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { userId: pending.userId } })).active, false);
    });
    // Pause a real successful login after challenge consumption, before session
    // creation. Activation must invalidate its eventual proof across this boundary.
    const racing: Jar = new Map();
    assert.equal((await request(racing, "/sign-in/email", { email: ownerEmail, password })).body.twoFactorRedirect, true);
    const originalCreate = context.internalAdapter.createSession;
    let release!: () => void; let consumed!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { consumed = resolve; });
    let racingVerification: ReturnType<typeof request> | undefined;
    try {
      Reflect.set(context.internalAdapter, "createSession", async (...args: Parameters<typeof originalCreate>) => {
        if (args[0] === pending.userId) { consumed(); await barrier; }
        return originalCreate(...args);
      });
      racingVerification = request(racing, "/two-factor/verify-totp", { code: totp(factor.totpURI) });
      // Timeout guarantees finally releases a stalled fixture rather than hanging.
      await Promise.race([reached, setTimeout(15_000).then(() => { throw new Error("Fixture barrier timeout"); })]);
      await test("concurrent activation permits one winner and revokes all older sessions", async () => {
        const results = await Promise.allSettled([
          activatePendingOwner(pending.userId, headers(login)), activatePendingOwner(pending.userId, headers(login)),
        ]);
        assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(results.filter(result => result.status === "rejected").length, 1);
        assert.equal(await prisma.adminUser.count({ where: { active: true, role: { name: "OWNER" } } }), 1);
        assert.equal(await prisma.session.count({ where: { userId: pending.userId } }), 1);
        assert.equal(await prisma.verification.count({ where: { value: pending.userId } }), 0);
      });
      release();
      await test("consumed pre-activation challenge cannot establish elevated session afterward", async () => {
        assert.equal((await racingVerification!).status, 500);
        assert.equal(await prisma.session.count({ where: { userId: pending.userId } }), 1);
      });
    } finally {
      release(); Reflect.set(context.internalAdapter, "createSession", originalCreate);
      await racingVerification?.catch(() => undefined);
    }
    await test("revoked enrollment and password-only cookies cannot authorize", async () => {
      for (const jar of [owner, old, racing]) {
        await assert.rejects(requireAdminPermission("admins:manage", headers(jar)), (error: unknown) =>
          error instanceof AdminAuthorizationError && error.reason === "UNAUTHENTICATED");
      }
    });
    await test("activated proven Owner receives explicit authorized permissions only", async () => {
      assert.equal((await requireAdminPermission("admins:manage", headers(login))).role, "OWNER");
      assert.equal((await requireAdminPermission("catalog:write", headers(login))).userId, pending.userId);
      await assert.rejects(requireAdminPermission("unknown:permission" as "admins:manage", headers(login)), (error: unknown) =>
        error instanceof AdminAuthorizationError && error.reason === "PERMISSION_DENIED");
      await assert.rejects(activatePendingOwner(pending.userId, headers(login)));
      await assert.rejects(resumePendingOwnerEnrollment(pending.userId, headers(login), password));
    });
  } finally {
    const previous = stage; stage = "exact fixture cleanup";
    if (writes) await prisma.$transaction(async tx => {
      const users = await tx.user.findMany({ where: { email: { in: [ownerEmail, otherEmail] } }, select: { id: true, email: true } });
      for (const user of users) {
        if (user.email === otherEmail) assert.equal(user.id, otherId);
        const records = await tx.verification.findMany({ where: { value: user.id }, select: { identifier: true } });
        for (const record of records) { assert.match(record.identifier, /^2fa-[A-Za-z0-9_-]+$/); challenges.add(record.identifier); }
      }
      const ids = users.map(user => user.id);
      await tx.verification.deleteMany({ where: { OR: [{ value: { in: ids } }, {
        identifier: { in: [...challenges].flatMap(id => [id, `2fa-attempts-${id}`]) },
      }] } });
      await tx.adminUser.deleteMany({ where: { userId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: ids }, email: { in: [ownerEmail, otherEmail] } } });
    });
    stage = previous;
  }
  await test("all eleven table fingerprints restored; no permanent accounts", async () => assert.deepEqual(await snapshot(), before));
  console.log(`${passed} onboarding checks passed; 0 failed; 0 skipped. Only temporary fixture Owner activated; all fixtures removed.`);
}
verify().catch(() => { console.error(`Bootstrap verification failed at ${stage}; ${passed} passed; sensitive details withheld.`); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
