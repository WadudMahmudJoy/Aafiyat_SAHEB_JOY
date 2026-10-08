import "server-only";
import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withLocalOwnerEnrollment } from "@/lib/local-owner-enrollment-scope";
import type { Prisma } from "@/generated/prisma/client";

const refuse = () => new Error("Local Owner operation refused; no credentials or session details are reported.");

export async function verifyLocalOwnerDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || url.hostname !== "127.0.0.1" ||
      url.port !== "55432" || url.pathname !== "/aafiyat_dev") throw refuse();
  const [identity] = await prisma.$queryRaw<{ db: string; schema: string }[]>`
    SELECT current_database() AS db, current_schema() AS schema`;
  if (identity.db !== "aafiyat_dev" || identity.schema !== "public") throw refuse();
}

export async function checkOwnerBootstrap() {
  await verifyLocalOwnerDatabase();
  if (await prisma.adminUser.count({ where: { role: { name: "OWNER" } } })) throw refuse();
  if (!await prisma.adminRole.findUnique({ where: { name: "OWNER" } })) throw refuse();
}

// Explicit local invocation only. No import/startup side effects, promotion,
// account merging, or default credentials. Atomic creation with a DB-wide lock.
export async function provisionInactiveOwner(input: { email: string; name: string; password: string }) {
  await checkOwnerBootstrap();
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 100 ||
      input.password.length < 12 || input.password.length > 128) throw refuse();
  const hash = await (await auth.$context).password.hash(input.password);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(88007, 1)`;
    if (await tx.adminUser.count({ where: { role: { name: "OWNER" } } })) throw refuse();
    // Case-insensitive collision check also refuses legacy differently-cased identities.
    if (await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } })) throw refuse();
    const role = await tx.adminRole.findUniqueOrThrow({ where: { name: "OWNER" } });
    const userId = randomUUID();
    await tx.user.create({ data: { id: userId, email, name, emailVerified: false } });
    await tx.account.create({ data: { id: randomUUID(), userId, accountId: userId, providerId: "credential", password: hash } });
    const member = await tx.adminUser.create({ data: { userId, roleId: role.id, active: false } });
    return { userId, membershipId: member.id, active: false as const };
  });
}

// Initial enrollment only. Never returns an existing factor or replaces one.
// A transaction-scoped DB lock serializes local operator attempts across processes.
export async function enrollPendingOwner(userId: string, headers: Headers, password: string) {
  await verifyLocalOwnerDatabase();
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(88007, 1)`;
    const member = await tx.adminUser.findUnique({ where: { userId }, include: { role: true, user: true } });
    if (!member || member.role.name !== "OWNER" || member.active || member.disabledAt ||
        member.user.twoFactorEnabled || await tx.adminUser.count({ where: { role: { name: "OWNER" } } }) !== 1 ||
        await tx.twoFactor.count({ where: { userId } })) throw refuse();
    const authenticated = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
    if (!authenticated || authenticated.user.id !== userId) throw refuse();
    const session = await tx.session.findUnique({ where: { id: authenticated.session.id } });
    if (!session || session.userId !== userId || session.token !== authenticated.session.token ||
        session.expiresAt <= new Date() || session.mfaVerifiedAt) throw refuse();
    const result = await withLocalOwnerEnrollment({ userId, sessionId: session.id }, () =>
      auth.api.enableTwoFactor({ headers, body: { password, method: "totp" } }));
    if (result.method !== "totp") throw refuse();
    return result;
  }, { timeout: 15_000 });
}

async function activationEvidence(tx: Prisma.TransactionClient, userId: string, authenticated: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>) {
  const row = await tx.session.findUnique({ where: { id: authenticated.session.id }, include: {
    user: { include: { twofactors: true, adminUser: { include: { role: true } } } },
  } });
  const member = row?.user.adminUser;
  const now = Date.now();
  const proof = row?.mfaVerifiedAt?.getTime() ?? NaN;
  if (!row || row.userId !== userId || authenticated.session.userId !== userId || row.token !== authenticated.session.token ||
      row.createdAt.getTime() !== authenticated.session.createdAt.getTime() || row.expiresAt.getTime() <= now ||
      !Number.isFinite(proof) || proof < row.createdAt.getTime() || proof > now || proof >= row.expiresAt.getTime() ||
      now - proof > 5 * 60 * 1000 || !row.user.twoFactorEnabled || row.user.twofactors.length !== 1 ||
      row.user.twofactors[0].verified !== true || !member || member.role.name !== "OWNER" ||
      member.active || member.disabledAt || await tx.adminUser.count({ where: { role: { name: "OWNER" } } }) !== 1 ||
      await tx.adminUser.count({ where: { active: true, role: { name: "OWNER" } } })) throw refuse();
  return { userId, sessionId: row.id, membershipId: member.id, eligible: true as const };
}

export async function checkPendingOwnerActivation(userId: string, headers: Headers) {
  await verifyLocalOwnerDatabase();
  const authenticated = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
  if (!authenticated || authenticated.user.id !== userId) throw refuse();
  return prisma.$transaction(tx => activationEvidence(tx, userId, authenticated));
}

export async function findPendingOwner(email: string) {
  await verifyLocalOwnerDatabase();
  const owners = await prisma.adminUser.findMany({ where: { role: { name: "OWNER" } }, include: { user: true } });
  if (owners.length !== 1 || owners[0].active || owners[0].disabledAt ||
      owners[0].user.email.toLowerCase() !== email.trim().toLowerCase()) throw refuse();
  return { userId: owners[0].userId, email: owners[0].user.email };
}

// Interrupted setup: retrieve only the same unverified factor with the password.
// No resets, replacement, backup-code delivery, or verified-secret retrieval.
export async function resumePendingOwnerEnrollment(userId: string, headers: Headers, password: string) {
  await verifyLocalOwnerDatabase();
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(88007, 1)`;
    const member = await tx.adminUser.findUnique({ where: { userId }, include: { role: true, user: true } });
    const factors = await tx.twoFactor.findMany({ where: { userId } });
    if (!member || member.active || member.disabledAt || member.role.name !== "OWNER" || member.user.twoFactorEnabled ||
        await tx.adminUser.count({ where: { role: { name: "OWNER" } } }) !== 1 || factors.length !== 1 || factors[0].verified !== false) throw refuse();
    const authenticated = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
    if (!authenticated || authenticated.user.id !== userId) throw refuse();
    const session = await tx.session.findUnique({ where: { id: authenticated.session.id } });
    if (!session || session.userId !== userId || session.token !== authenticated.session.token || session.expiresAt <= new Date() || session.mfaVerifiedAt) throw refuse();
    return withLocalOwnerEnrollment({ userId, sessionId: session.id }, () => auth.api.getTOTPURI({ headers, body: { password } }));
  }, { timeout: 15_000 });
}

export async function activatePendingOwner(userId: string, headers: Headers) {
  await verifyLocalOwnerDatabase();
  const authenticated = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
  if (!authenticated || authenticated.user.id !== userId) throw refuse();
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(88007, 1)`;
    // Same lifecycle lock as the login proof writer: no in-flight old challenge
    // can write proof after the activation boundary.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008, hashtext(${userId}))`;
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${authenticated.session.id} FOR UPDATE`;
    const evidence = await activationEvidence(tx, userId, authenticated);
    const challenges = await tx.verification.findMany({ where: { value: userId }, select: { identifier: true } });
    await tx.verification.deleteMany({ where: { OR: [{ value: userId }, {
      identifier: { in: challenges.map(record => `2fa-attempts-${record.identifier}`) },
    }] } });
    await tx.session.deleteMany({ where: { userId, id: { not: evidence.sessionId } } });
    const result = await tx.adminUser.updateMany({ where: { id: evidence.membershipId, userId, active: false, disabledAt: null },
      data: { active: true, updatedAt: new Date() } });
    if (result.count !== 1) throw refuse();
    return { userId, sessionId: evidence.sessionId, active: true as const };
  });
}
