// Run: node --conditions=react-server --import tsx scripts/verify-admin-authorization.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AdminRoleName, Prisma } from "../src/generated/prisma/client";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { ADMIN_PERMISSIONS, hasAdminPermission } from "../src/lib/admin-permissions";
import { AdminAuthorizationError, requireAdminPermission } from "../src/lib/admin-authorization";

let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
  await run();
  passed++;
  console.log(`PASS: ${name}`);
}

async function snapshot() {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    assert.equal(identity.db, "aafiyat_dev");
    return {
      categories: await tx.category.findMany({ orderBy: { id: "asc" } }),
      roles: await tx.adminRole.findMany({ orderBy: { name: "asc" } }),
      admins: await tx.adminUser.count(), users: await tx.user.count(),
      sessions: await tx.session.count(), accounts: await tx.account.count(),
      twoFactors: await tx.twoFactor.count(), verifications: await tx.verification.count(),
      products: await tx.product.count(), variants: await tx.productVariant.count(),
      inventory: await tx.inventoryBalance.count(),
    };
  });
}

const requestHeaders = new Headers();
const deny = (permission: Parameters<typeof requireAdminPermission>[0], reason: string, headers = requestHeaders) =>
  assert.rejects(requireAdminPermission(permission, headers), (error: unknown) =>
    error instanceof AdminAuthorizationError && error.reason === reason);

async function verify() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55432");
  assert.equal(url.pathname, "/aafiyat_dev");
  const before = await snapshot();
  await test("five categories, four reference roles, no admin bootstrap", () => {
    assert.deepEqual(before.categories.map(c => c.slug).sort(), ["full-shirts", "half-shirts", "panjabi", "sherwani", "t-shirts"]);
    assert.deepEqual(before.roles.map(r => r.name).sort(), ["MARKETING_MANAGER", "ORDER_MANAGER", "OWNER", "PRODUCT_MANAGER"]);
    assert.equal(before.admins, 0);
    assert.equal(before.users, 0);
  });
  await test("live unauthenticated request denied", () => deny("catalog:read", "UNAUTHENTICATED"));
  await test("live invalid signed session cookie denied", () => deny("catalog:read", "UNAUTHENTICATED",
    new Headers({ cookie: "better-auth.session_token=invalid-signature" })));

  // In-memory probes only: no identity, session, or admin fixture is inserted.
  type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>;
  type Membership = Prisma.AdminUserGetPayload<{
    select: { id: true; userId: true; active: true; disabledAt: true; authorizationNotBefore: true; role: { select: { name: true } } };
  }>;
  const now = new Date();
  const validSession = {
    session: { id: "008b-session-probe", userId: "008b-user-probe", token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now, ipAddress: null, userAgent: null },
    user: { id: "008b-user-probe", name: "In-memory probe", email: "probe@example.invalid",
      emailVerified: true, image: null, createdAt: now, updatedAt: now, twoFactorEnabled: true },
  } satisfies NonNullable<SessionResult>;
  let session: SessionResult = validSession;
  const activeAdmin: Membership = {
    id: "008b-admin-probe", userId: validSession.user.id, active: true, disabledAt: null, authorizationNotBefore: new Date(0), role: { name: "OWNER" },
  };
  let membership: Membership | null = activeAdmin;
  let membershipReads = 0;
  const originalSession = auth.api.getSession;
  const originalMembership = prisma.adminUser.findUnique;
  const originalDatabaseSession = prisma.session.findUnique;
  const storedSession = {
    ...validSession.session, mfaVerifiedAt: null,
    user: { twoFactorEnabled: true, twofactors: [{ verified: true }] },
  };
  try {
    // Contract probes have no persisted session, so any fake public MFA marker
    // must fail the new authoritative database gate.
    Reflect.set(prisma.session, "findUnique", async () => storedSession);
    assert.ok(Reflect.set(auth.api, "getSession", async (args: { query: unknown }) => {
      assert.deepEqual(args.query, { disableCookieCache: true, disableRefresh: true });
      return session;
    }));
    assert.ok(Reflect.set(prisma.adminUser, "findUnique", async (args: Prisma.AdminUserFindUniqueArgs) => {
      membershipReads++;
      assert.deepEqual(args.where, { userId: validSession.user.id });
      assert.deepEqual(args.select, { id: true, userId: true, active: true, disabledAt: true, authorizationNotBefore: true, role: { select: { name: true } } });
      return membership;
    }));
    await test("missing session skips membership lookup", async () => {
      session = null;
      await deny("catalog:read", "UNAUTHENTICATED");
      assert.equal(membershipReads, 0);
    });
    await test("expired session denied", async () => {
      session = { ...validSession, session: { ...validSession.session, expiresAt: new Date(0) } };
      await deny("catalog:read", "UNAUTHENTICATED");
    });
    await test("session identity mismatch denied", async () => {
      session = { ...validSession, session: { ...validSession.session, userId: "different-user" } };
      await deny("catalog:read", "UNAUTHENTICATED");
    });
    session = validSession;
    await test("membership cutoff rejects a retained pre-change session", async () => {
      membership = { ...activeAdmin, authorizationNotBefore: now };
      await deny("admins:manage", "UNAUTHENTICATED");
      membership = activeAdmin;
    });
    await test("missing admin membership denied", async () => {
      membership = null;
      await deny("catalog:read", "ADMIN_MEMBERSHIP_REQUIRED");
    });
    await test("inactive membership denied", async () => {
      membership = { ...activeAdmin, active: false };
      await deny("catalog:read", "ADMIN_DISABLED");
    });
    await test("disabled timestamp denies even an active OWNER", async () => {
      membership = { ...activeAdmin, disabledAt: now };
      await deny("catalog:read", "ADMIN_DISABLED");
    });
    await test("insufficient permissions and forged client claims denied", async () => {
      membership = { ...activeAdmin, role: { name: "PRODUCT_MANAGER" } };
      await deny("settings:manage", "PERMISSION_DENIED", new Headers({ "x-admin-role": "OWNER", "x-mfa-verified": "true" }));
    });
    await test("explicit permission matrix for all four roles", () => {
      const expected: Record<AdminRoleName, readonly string[]> = {
        OWNER: ADMIN_PERMISSIONS,
        PRODUCT_MANAGER: ["catalog:read", "catalog:write", "inventory:manage"],
        ORDER_MANAGER: ["orders:read", "orders:manage"],
        MARKETING_MANAGER: ["catalog:read", "marketing:manage", "content:manage"],
      };
      for (const role of Object.keys(expected) as AdminRoleName[]) {
        for (const permission of ADMIN_PERMISSIONS) {
          assert.equal(hasAdminPermission(role, permission), expected[role].includes(permission), `${role}: ${permission}`);
        }
      }
      assert.equal(hasAdminPermission("UNKNOWN", "catalog:read"), false);
      assert.equal(hasAdminPermission("__proto__", "catalog:read"), false);
      assert.equal(hasAdminPermission("OWNER", "unknown:permission"), false);
    });
    for (const [role, permission] of [
      ["OWNER", "admins:manage"], ["PRODUCT_MANAGER", "inventory:manage"],
      ["ORDER_MANAGER", "orders:manage"], ["MARKETING_MANAGER", "content:manage"],
    ] as const) {
      await test(`${role} valid grant still denied without session MFA proof`, async () => {
        membership = { ...activeAdmin, role: { name: role } };
        await deny(permission, "MFA_NOT_VERIFIED");
      });
    }
    await test("unenrolled OWNER denied", async () => {
      membership = activeAdmin;
      session = { ...validSession, user: { ...validSession.user, twoFactorEnabled: false } };
      await deny("admins:manage", "MFA_NOT_VERIFIED");
    });
    await test("untrusted session MFA marker does not bypass denial", async () => {
      session = validSession;
      Reflect.set(session.session, "mfaVerifiedAt", now);
      await deny("admins:manage", "MFA_NOT_VERIFIED");
      Reflect.deleteProperty(session.session, "mfaVerifiedAt");
    });
    await test("database token and identity binding mismatches denied", async () => {
      storedSession.token = randomUUID();
      await deny("admins:manage", "UNAUTHENTICATED");
      storedSession.token = validSession.session.token;
      storedSession.userId = "different-user";
      await deny("admins:manage", "UNAUTHENTICATED");
      storedSession.userId = validSession.user.id;
      storedSession.createdAt = new Date(now.getTime() - 1);
      await deny("admins:manage", "UNAUTHENTICATED");
      storedSession.createdAt = now;
    });
    await test("authoritative session database failure denies access", async () => {
      Reflect.set(prisma.session, "findUnique", async () => { throw new Error("In-memory session failure probe"); });
      await deny("admins:manage", "AUTHORIZATION_UNAVAILABLE");
      Reflect.set(prisma.session, "findUnique", async () => storedSession);
    });
    await test("membership database failure denies access", async () => {
      Reflect.set(prisma.adminUser, "findUnique", async () => { throw new Error("In-memory database failure probe"); });
      await deny("admins:manage", "AUTHORIZATION_UNAVAILABLE");
    });
    await test("authentication verification failure denies access", async () => {
      Reflect.set(auth.api, "getSession", async () => { throw new Error("In-memory authentication failure probe"); });
      await deny("admins:manage", "AUTHORIZATION_UNAVAILABLE");
    });
  } finally {
    Reflect.set(auth.api, "getSession", originalSession);
    Reflect.set(prisma.adminUser, "findUnique", originalMembership);
    Reflect.set(prisma.session, "findUnique", originalDatabaseSession);
  }
  await test("database unchanged; no test fixtures created", async () => assert.deepEqual(await snapshot(), before));
  console.log(`${passed} checks passed; 0 failed. Rows: 5 categories, 4 roles, 0 admin memberships, 0 auth users.`);
}

verify().catch(() => {
  console.error(`Admin authorization verification failed after ${passed} passed checks; details withheld.`);
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
