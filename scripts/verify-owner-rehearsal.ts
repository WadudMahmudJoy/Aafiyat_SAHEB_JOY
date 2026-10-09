// Read-only PostgreSQL checks and in-memory guards; NEVER provisions an Owner.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/prisma";
import { assertJournal, bindRehearsal, cleanupRehearsal, prepareRehearsal, rehearsalSnapshot, sameSnapshot } from "../src/lib/local-owner-rehearsal";

async function verify() {
  const journal = await prepareRehearsal();
  let passed = 1;
  const check = async (run: () => unknown | Promise<unknown>) => { await run(); passed++; };
  const userId = randomUUID(); const membershipId = randomUUID();
  const user = { id: userId, email: journal.email, name: journal.name, createdAt: new Date(), emailVerified: false,
    accounts: [{ providerId: "credential", accountId: userId }],
    adminUser: { id: membershipId, disabledAt: null, role: { name: "OWNER" } } };
  // Simulated records only; not database fixtures.
  const tx = (users: unknown[], admins = 0) => ({ user: { findMany: async () => users },
    adminUser: { count: async () => admins } }) as unknown as Prisma.TransactionClient;
  await check(() => assertJournal(journal));
  await check(() => assert.throws(() => assertJournal({ ...journal, email: "real@example.com" })));
  await check(() => assert.throws(() => assertJournal({ ...journal, name: "Owner" })));
  await check(() => assert.throws(() => assertJournal({ ...journal, baseline: journal.baseline.map(r => r.name === "auth_users" ? { ...r, rows: 1 } : r) })));
  await check(async () => assert.equal(await bindRehearsal(journal, tx([])), null));
  await check(async () => assert.equal((await bindRehearsal(journal, tx([user])))?.userId, userId));
  await check(() => assert.rejects(bindRehearsal(journal, tx([user, user]))));
  await check(() => assert.rejects(bindRehearsal(journal, tx([{ ...user, email: "real@example.com" }]))));
  await check(() => assert.rejects(bindRehearsal(journal, tx([{ ...user, createdAt: new Date(0) }]))));
  await check(() => assert.rejects(bindRehearsal({ ...journal, userId: randomUUID() }, tx([user]))));
  await check(() => assert.rejects(bindRehearsal({ ...journal, membershipId: randomUUID() }, tx([user]))));
  await check(() => assert.rejects(bindRehearsal(journal, tx([], 1))));
  await check(() => assert.rejects(cleanupRehearsal(journal, "DELETE"))); // Refuses before any database mutation.
  const originalTransaction = prisma.$transaction;
  // Simulate cleanup SQL/ORM calls; the real client executes only database-identity reads.
  async function simulateCleanup(unknownChallenge = false, unrelatedChange = false) {
    let deleted = false; let mutations = 0;
    const identifier = "2fa-disposable-in-memory-probe";
    const fixture = { ...journal, userId, membershipId };
    const fake = {
      $executeRaw: async () => 1,
      $queryRaw: async () => journal.baseline.map(row =>
        unrelatedChange && row.name === "categories" ? { ...row, fingerprint: "0".repeat(32) } :
        !deleted && row.name === "auth_users" ? { ...row, rows: 1 } : row),
      user: { findMany: async () => deleted ? [] : [user], delete: async (args: { where: { id: string } }) => {
        assert.equal(args.where.id, userId); deleted = true; mutations++; return user;
      } },
      adminUser: { count: async () => 0, deleteMany: async (args: { where: { id: string; userId: string } }) => {
        assert.deepEqual(args.where, { id: membershipId, userId }); mutations++; return { count: 1 };
      } },
      verification: { findMany: async () => [{ id: "exact-probe", identifier,
        value: unknownChallenge ? "unrelated-user" : userId }],
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        assert.deepEqual(args.where.id.in, ["exact-probe"]); mutations++; return { count: 1 };
      } },
    };
    Object.defineProperty(prisma, "$transaction", { configurable: true, value:
      async (operation: (db: Prisma.TransactionClient) => Promise<unknown>) => operation(fake as unknown as Prisma.TransactionClient) });
    try {
      if (unknownChallenge || unrelatedChange) {
        await assert.rejects(cleanupRehearsal(fixture, `DELETE TEST ${journal.tag}`));
        assert.equal(mutations, 0);
      } else {
        await cleanupRehearsal(fixture, `DELETE TEST ${journal.tag}`); assert.equal(mutations, 3);
      }
    } finally { Object.defineProperty(prisma, "$transaction", { configurable: true, value: originalTransaction }); }
  }
  await check(() => simulateCleanup());
  await check(() => simulateCleanup(true));
  await check(() => simulateCleanup(false, true));
  await check(async () => {
    const after = await prisma.$transaction(async db => {
      await db.$executeRaw`SET TRANSACTION READ ONLY`; return rehearsalSnapshot(db);
    });
    assert(sameSnapshot(after, journal.baseline));
  });
  console.log(`${passed} read-only/in-memory rehearsal checks passed; all 12 database fingerprints unchanged.`);
  console.log("Live Owner provisioning, activation, and cleanup branches NOT executed; supervisor review required.");
}
verify().catch(() => { console.error("Rehearsal guard verification failed; sensitive details withheld."); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
