import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { verifyLocalOwnerDatabase } from "@/lib/local-owner-bootstrap";

const tables = ["categories", "products", "product_variants", "inventory_balances", "admin_roles", "admin_users",
  "auth_users", "auth_accounts", "auth_sessions", "auth_two_factors", "auth_verifications", "_prisma_migrations"] as const;
type Snapshot = { name: string; rows: number; fingerprint: string }[];
export type RehearsalJournal = {
  version: 1; tag: string; startedAt: string; email: string; name: string;
  userId: string | null; membershipId: string | null; baseline: Snapshot; challengeHashes: string[];
};
const refuse = () => new Error("Local TEST rehearsal refused; sensitive details withheld.");
export const challengeHash = (identifier: string) => createHash("sha256").update(identifier).digest("hex");
export const isAuthTable = (name: string) => name.startsWith("auth_") || name === "admin_users";
export function assertJournal(value: unknown): asserts value is RehearsalJournal {
  const j = value as RehearsalJournal;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!j || j.version !== 1 || !uuid.test(j.tag) || !Number.isFinite(Date.parse(j.startedAt)) ||
      j.email !== `aafiyat-owner-test-${j.tag}@example.invalid` || j.name !== `TEST ONLY Owner rehearsal ${j.tag}` ||
      (j.userId !== null && !uuid.test(j.userId)) ||
      (j.membershipId !== null && !uuid.test(j.membershipId)) ||
      !Array.isArray(j.challengeHashes) || !j.challengeHashes.every(hash => /^[0-9a-f]{64}$/.test(hash)) ||
      !Array.isArray(j.baseline) || j.baseline.length !== tables.length) throw refuse();
  for (const table of tables) {
    const rows = j.baseline.filter(row => row.name === table);
    if (rows.length !== 1 || !Number.isInteger(rows[0].rows) || rows[0].rows < 0 ||
        !/^[0-9a-f]{32}$/.test(rows[0].fingerprint) || (isAuthTable(table) && rows[0].rows !== 0)) throw refuse();
  }
}
export async function rehearsalSnapshot(tx: Prisma.TransactionClient): Promise<Snapshot> {
  return tx.$queryRaw(Prisma.raw(tables.map(table => `SELECT '${table}' AS name, count(*)::int AS rows,
    md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS fingerprint FROM "${table}" t`)
    .join(" UNION ALL ") + " ORDER BY name"));
}
export function sameSnapshot(a: Snapshot, b: Snapshot) {
  return JSON.stringify([...a].sort((x, y) => x.name.localeCompare(y.name))) ===
    JSON.stringify([...b].sort((x, y) => x.name.localeCompare(y.name)));
}
export async function prepareRehearsal(): Promise<RehearsalJournal> {
  await verifyLocalOwnerDatabase();
  const baseline = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const snapshot = await rehearsalSnapshot(tx);
    if (snapshot.some(row => isAuthTable(row.name) && row.rows !== 0)) throw refuse();
    const categories = (await tx.category.findMany({ select: { slug: true } })).map(c => c.slug).sort();
    const roles = (await tx.adminRole.findMany({ select: { name: true } })).map(r => r.name).sort();
    if (JSON.stringify(categories) !== JSON.stringify(["full-shirts", "half-shirts", "panjabi", "sherwani", "t-shirts"]) ||
        JSON.stringify(roles) !== JSON.stringify(["MARKETING_MANAGER", "ORDER_MANAGER", "OWNER", "PRODUCT_MANAGER"])) throw refuse();
    return snapshot;
  }, { isolationLevel: "RepeatableRead" });
  const tag = randomUUID();
  return { version: 1, tag, startedAt: new Date().toISOString(), email: `aafiyat-owner-test-${tag}@example.invalid`,
    name: `TEST ONLY Owner rehearsal ${tag}`, userId: null, membershipId: null, baseline, challengeHashes: [] };
}
// Read-only binding also recovers a crash between atomic creation and journal update.
// No email-only match: exact generated TEST name, creation boundary, UUID IDs,
// credential account ownership, sole identity, and OWNER membership are required.
export async function bindRehearsal(j: RehearsalJournal, tx: Prisma.TransactionClient) {
  assertJournal(j);
  const users = await tx.user.findMany({ include: { accounts: true, adminUser: { include: { role: true } } } });
  if (users.length === 0) {
    if (await tx.adminUser.count()) throw refuse();
    return null;
  }
  if (users.length !== 1) throw refuse();
  const user = users[0]; const member = user.adminUser;
  const accounts = user.accounts;
  if (user.email !== j.email || user.name !== j.name || user.createdAt < new Date(j.startedAt) ||
      user.emailVerified || !member || member.role.name !== "OWNER" || member.disabledAt ||
      accounts.length !== 1 || accounts[0].providerId !== "credential" || accounts[0].accountId !== user.id ||
      (j.userId !== null && j.userId !== user.id) || (j.membershipId !== null && j.membershipId !== member.id)) throw refuse();
  const bound = { ...j, userId: user.id, membershipId: member.id };
  assertJournal(bound); return bound;
}
export async function cleanupRehearsal(j: RehearsalJournal, confirmation: string) {
  assertJournal(j);
  if (confirmation !== `DELETE TEST ${j.tag}`) throw refuse();
  await verifyLocalOwnerDatabase();
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(88007, 1)`;
    const initial = await bindRehearsal(j, tx);
    if (initial) await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008, hashtext(${initial.userId!}))`;
    // Fixed table names only. Freeze writes for the fingerprint comparison and
    // exact deletion; never reset, truncate, alter tables, or remove roles/categories.
    await tx.$executeRaw(Prisma.raw(`LOCK TABLE ${tables.map(t => `"${t}"`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`));
    const current = await rehearsalSnapshot(tx);
    if (!sameSnapshot(current.filter(r => !isAuthTable(r.name)), j.baseline.filter(r => !isAuthTable(r.name)))) throw refuse();
    const bound = await bindRehearsal(j, tx);
    if (bound) {
      const records = await tx.verification.findMany();
      const hashes = new Set(j.challengeHashes);
      for (const row of records) {
        if (row.value === bound.userId && /^2fa-[A-Za-z0-9_-]+$/.test(row.identifier)) hashes.add(challengeHash(row.identifier));
      }
      for (const row of records) {
        const identifier = row.identifier.startsWith("2fa-attempts-") ? row.identifier.slice("2fa-attempts-".length) : row.identifier;
        if (!/^2fa-[A-Za-z0-9_-]+$/.test(identifier) || !hashes.has(challengeHash(identifier))) throw refuse();
      }
      await tx.verification.deleteMany({ where: { id: { in: records.map(r => r.id) } } });
      const deleted = await tx.adminUser.deleteMany({ where: { id: bound.membershipId!, userId: bound.userId! } });
      if (deleted.count !== 1) throw refuse();
      await tx.user.delete({ where: { id: bound.userId! } }); // FK cascades only this fixture's framework rows.
    }
    if (!sameSnapshot(await rehearsalSnapshot(tx), j.baseline)) throw refuse(); // Roll back on any discrepancy.
  }, { timeout: 15_000 });
  const after = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`; return rehearsalSnapshot(tx);
  });
  if (!sameSnapshot(after, j.baseline)) throw refuse();
}
