// Run: node --conditions=react-server --import tsx scripts/verify-admin-inventory.ts
// Single connection, real SQL, savepoint-backed service boundaries, outer ROLLBACK.
// This deliberately does not claim multi-connection concurrency coverage.
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";

let stage = "preflight"; let passed = 0;
async function check(name: string, run: () => unknown | Promise<unknown>) {
  stage = name; await run(); passed++; console.log(`PASS: ${name}`);
}
async function snapshot(tx: Prisma.TransactionClient) {
  const tables = await tx.$queryRaw<{ name: string }[]>`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const result = [];
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const rows = await tx.$queryRawUnsafe<{ count: bigint; hash: string }[]>(`SELECT count(*) AS count, md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) AS hash FROM public.${quoted} t`);
    result.push({ name, ...rows[0] });
  }
  return result;
}
async function preflight() {
  stage = "local URL identity";
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55432"); assert.equal(url.pathname, "/aafiyat_dev");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw<{ db: string; ledger: string | null }[]>`SELECT current_database() AS db, to_regclass('public.stock_movements')::text AS ledger`;
    assert.equal(identity.db, "aafiyat_dev"); assert.equal(identity.ledger, "stock_movements");
    stage = "migration history and checksum preflight";
    const applied = await tx.$queryRaw<{ migration_name: string; checksum: string; finished: boolean; rolledBack: boolean }[]>`SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack" FROM _prisma_migrations ORDER BY migration_name`;
    const local = readdirSync("prisma/migrations", { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.deepEqual(applied.map(m => m.migration_name), local);
    for (const m of applied) {
      assert(m.finished && !m.rolledBack);
      assert.equal(m.checksum, createHash("sha256").update(readFileSync(`prisma/migrations/${m.migration_name}/migration.sql`)).digest("hex"));
    }
    stage = "ledger constraints preflight";
    const checks = await tx.$queryRaw<{ name: string; valid: boolean }[]>`SELECT conname AS name, convalidated AS valid FROM pg_constraint WHERE conrelid = 'public.stock_movements'::regclass`;
    for (const name of ["stock_movements_type_delta_valid", "stock_movements_snapshots_nonnegative", "stock_movements_reserved_within_stock", "stock_movements_snapshot_arithmetic", "stock_movements_reserved_unchanged", "stock_movements_reason_nonempty", "stock_movements_fingerprint_sha256", "stock_movements_variant_id_fkey", "stock_movements_actor_admin_id_fkey"]) assert(checks.some(c => c.name === name && c.valid));
    stage = "ledger trigger preflight";
    const triggers = await tx.$queryRaw<{ enabled: string }[]>`SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid = 'public.stock_movements'::regclass AND tgname = 'stock_movements_append_only'`;
    assert.equal(triggers[0]?.enabled, "A");
    const indexes = await tx.$queryRaw<{ valid: boolean }[]>`SELECT indisvalid AND indisunique AS valid FROM pg_index WHERE indexrelid = 'public.stock_movements_idempotency_key_key'::regclass`;
    assert.equal(indexes[0]?.valid, true);
    stage = "public table fingerprint preflight";
    return snapshot(tx);
  }, { timeout: 15000 });
}

async function verify() {
  assert(existsSync("src/lib/admin-inventory.ts"), "Receiving service must be implemented");
  const { receiveStock } = await import("../src/lib/admin-inventory");
  const baseline = await preflight();
  console.log("PASS: local identity, all migration checksums, ledger constraints, unique index and ALWAYS trigger preflight");
  const original = { transaction: prisma.$transaction, session: auth.api.getSession, admin: prisma.adminUser.findUnique, stored: prisma.session.findUnique };
  const rollback = new Error("Intentional receiving fixture rollback");
  const now = new Date();
  const session = { session: { id: randomUUID(), userId: String(randomUUID()), token: randomUUID(), createdAt: now, expiresAt: new Date(Date.now() + 600000) }, user: { id: "" } };
  session.user.id = session.session.userId;
  const headers = new Headers({ origin: String(auth.options.baseURL), "sec-fetch-site": "same-origin" });
  let signedIn = true; let proof: Date | null = now; let reads = 0; let transactions = 0;
  let fault: "ledger" | "balance" | "unrelated" | "timeout" | null = null;
  let hideReceipt = false; let revokeOnRecovery = false;
  let invalidState: "unknownProduct" | "archivedProduct" | "activeArchivedVariant" | null = null;
  let lockTrace: string[] = [];
  try {
    await original.transaction.call(prisma, async (tx: Prisma.TransactionClient) => {
      stage = "rollback fixture setup";
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      const category = await tx.category.findFirstOrThrow({ select: { id: true } });
      const role = await tx.adminRole.findUniqueOrThrow({ where: { name: "OWNER" }, select: { id: true } });
      await tx.user.create({ data: { id: session.user.id, name: "TEST receiving rollback", email: `${session.user.id}@example.invalid` } });
      const admin = await tx.adminUser.create({ data: { userId: session.user.id, roleId: role.id, active: true } });
      const product = await tx.product.create({ data: { categoryId: category.id, name: "TEST receiving", slug: randomUUID(), description: "Rollback-only receiving fixture" } });
      const other = await tx.product.create({ data: { categoryId: category.id, name: "TEST other", slug: randomUUID(), description: "Rollback-only binding fixture" } });
      const variant = await tx.productVariant.create({ data: { productId: product.id, sku: randomUUID().toUpperCase(), sizeCode: "test", sizeLabel: "TEST", colorCode: "test", colorLabel: "TEST", priceMinor: BigInt(0) } });
      const foreign = await tx.productVariant.create({ data: { productId: other.id, sku: randomUUID().toUpperCase(), sizeCode: "test", sizeLabel: "TEST", colorCode: "test", colorLabel: "TEST", priceMinor: BigInt(0) } });
      const input = { productId: product.id, variantId: variant.id, quantity: "12", reason: "  Initial\r\n delivery  ", idempotencyKey: randomUUID() };
      const fresh = (patch = {}) => ({ ...input, idempotencyKey: randomUUID(), ...patch });
      Reflect.set(auth.api, "getSession", async (args: { query: unknown }) => {
        assert.deepEqual(args.query, { disableCookieCache: true, disableRefresh: true });
        return signedIn ? session : null;
      });
      Reflect.set(prisma.adminUser, "findUnique", async (args: Prisma.AdminUserFindUniqueArgs) => { reads++; return tx.adminUser.findUnique(args); });
      Reflect.set(prisma.session, "findUnique", async () => ({ ...session.session, mfaVerifiedAt: proof, user: { twoFactorEnabled: true, twofactors: [{ verified: true }] } }));
      Reflect.set(prisma, "$transaction", async (callback: (client: Prisma.TransactionClient) => Promise<unknown>, options: { maxWait: number; timeout: number }) => {
        assert(options.maxWait > 0 && options.maxWait <= 5000 && options.timeout > 0 && options.timeout <= 15000);
        transactions++;
        lockTrace = [];
        const name = `receiving_${transactions}`;
        await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
        const client = new Proxy(tx, { get(target, prop) {
          if (prop === "$queryRaw") return async (sql: TemplateStringsArray, ...args: unknown[]) => {
            const query = sql.join("?");
            if (query.includes("FOR UPDATE")) {
              const table = query.includes("FROM products ") ? "products" : query.includes("FROM product_variants") ? "product_variants" : "inventory_balances";
              lockTrace.push(table);
            }
            if (hideReceipt && query.includes("FROM stock_movements")) { hideReceipt = false; return []; }
            const result = await target.$queryRaw(sql, ...args);
            // DB constraints exclude these states; inject only the read result
            // to exercise the service's independent fail-closed eligibility.
            if (query.includes("FROM products ") && invalidState === "unknownProduct") return [{ lifecycle: "unknown", unarchived: true }];
            if (query.includes("FROM products ") && invalidState === "archivedProduct") return [{ lifecycle: "active", unarchived: false }];
            if (query.includes("FROM product_variants") && invalidState === "activeArchivedVariant") return [{ active: true, unarchived: false }];
            if (fault === "balance" && query.includes("UPDATE inventory_balances")) throw new Error("SECRET balance failure");
            return result;
          };
          if (prop === "stockMovement") return { create: async (args: Prisma.StockMovementCreateArgs) => {
            const result = await target.stockMovement.create(args);
            if (fault === "ledger") throw new Error("SECRET ledger failure");
            if (fault === "unrelated") throw { code: "P2002", meta: { modelName: "StockMovement", target: ["id"] }, message: "SECRET unrelated unique" };
            if (fault === "timeout") throw { code: "P2028", message: "SECRET ambiguous timeout" };
            return result;
          } };
          return Reflect.get(target, prop);
        } });
        try { const result = await callback(client); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`); return result; }
        catch (error) {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
          if (revokeOnRecovery) { signedIn = false; revokeOnRecovery = false; }
          throw error;
        }
      });
      const state = async () => ({ balances: await tx.inventoryBalance.findMany({ orderBy: { variantId: "asc" } }), movements: await tx.stockMovement.findMany({ orderBy: { id: "asc" } }) });
      async function denied(code: string, data: unknown = fresh(), request = headers) {
        const before = await state();
        const result = await receiveStock(request, data);
        assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, code);
        assert(!JSON.stringify(result).includes("SECRET")); assert.deepEqual(await state(), before);
        return result;
      }
      await check("unauthenticated, absent/stale MFA, inactive membership and permission denial produce no mutation", async () => {
        const start = transactions;
        signedIn = false; await denied("ACCESS_DENIED"); signedIn = true;
        proof = null; await denied("ACCESS_DENIED");
        const created = session.session.createdAt;
        session.session.createdAt = new Date(Date.now() - 14 * 3600000); proof = new Date(Date.now() - 13 * 3600000);
        await denied("ACCESS_DENIED"); session.session.createdAt = created; proof = now;
        await tx.adminUser.update({ where: { id: admin.id }, data: { active: false } }); await denied("ACCESS_DENIED");
        const deniedRole = await tx.adminRole.findUniqueOrThrow({ where: { name: "ORDER_MANAGER" } });
        await tx.adminUser.update({ where: { id: admin.id }, data: { active: true, roleId: deniedRole.id } }); await denied("ACCESS_DENIED");
        await tx.adminUser.update({ where: { id: admin.id }, data: { roleId: role.id } });
        assert.equal(transactions, start);
      });
      await check("configured-origin protection rejects cross-origin, cross-site and missing origin before transaction", async () => {
        const start = transactions;
        for (const request of [new Headers(), new Headers({ origin: "https://evil.invalid" }), new Headers({ origin: String(auth.options.baseURL), "sec-fetch-site": "cross-site" })]) await denied("ACCESS_DENIED", fresh(), request);
        assert.equal(transactions, start);
      });
      await check("unknown/actor injection and repeated fields are denied before transaction", async () => {
        const start = transactions;
        await denied("VALIDATION", fresh({ actorAdminId: admin.id }));
        const form = new FormData(); for (const [k, v] of Object.entries(fresh())) form.append(k, v); form.append("quantity", "12");
        await denied("VALIDATION", form); assert.equal(transactions, start);
      });
      await check("cross-product binding and nonexistent identifiers fail without balance initialization", async () => {
        await denied("NOT_FOUND", fresh({ variantId: foreign.id }));
        await denied("NOT_FOUND", fresh({ productId: randomUUID() }));
        await denied("NOT_FOUND", fresh({ variantId: randomUUID() }));
      });
      await check("discontinued/archived products and inactive/archived variants deny receiving", async () => {
        for (const lifecycle of ["discontinued", "archived"]) {
          await tx.product.update({ where: { id: product.id }, data: { lifecycle, archivedAt: lifecycle === "archived" ? now : null } }); await denied("INELIGIBLE");
        }
        await tx.product.update({ where: { id: product.id }, data: { lifecycle: "draft", archivedAt: null } });
        for (const archivedAt of [null, now]) {
          await tx.productVariant.update({ where: { id: variant.id }, data: { active: false, archivedAt } }); await denied("INELIGIBLE");
        }
        await tx.productVariant.update({ where: { id: variant.id }, data: { active: true, archivedAt: null } });
      });
      await check("unknown and inconsistent lifecycle read states fail closed (synthetic read probes)", async () => {
        for (const value of ["unknownProduct", "archivedProduct", "activeArchivedVariant"] as const) {
          invalidState = value; await denied("INELIGIBLE");
        }
        invalidState = null;
      });
      let receipt: unknown;
      await check("draft receive initializes missing balance and inserts exact server-derived snapshots/fingerprint", async () => {
        const beforeCount = await tx.stockMovement.count();
        const result = await receiveStock(headers, input); assert(result.ok); receipt = result.receipt;
        assert.deepEqual(lockTrace, ["products", "product_variants", "inventory_balances"]);
        assert(Object.isFrozen(result.receipt));
        assert.equal(await tx.stockMovement.count(), beforeCount + 1);
        const movement = await tx.stockMovement.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
        assert.equal(movement.actorAdminId, admin.id); assert.equal(movement.movementType, "receive");
        assert.deepEqual([movement.deltaOnHand, movement.deltaReserved, movement.onHandBefore, movement.onHandAfter, movement.reservedBefore, movement.reservedAfter], [12, 0, 0, 12, 0, 0]);
        assert.equal(movement.reason, "Initial delivery");
        const canonical = JSON.stringify({ version: 1, operation: "receive", actorAdminId: admin.id, productId: product.id, variantId: variant.id, quantity: "12", reason: "Initial delivery" });
        assert.equal(movement.requestFingerprint, createHash("sha256").update(canonical, "utf8").digest("hex"));
        assert.match(result.receipt.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
        assert.equal((await tx.inventoryBalance.findUniqueOrThrow({ where: { variantId: variant.id } })).onHand, 12);
      });
      await check("authorized normalized same-key replay returns original immutable receipt without balance/revision writes", async () => {
        const before = await state(); const startReads = reads;
        const result = await receiveStock(headers, { ...input, reason: "Initial delivery", quantity: "0012", productId: product.id.toUpperCase() });
        assert(result.ok); assert.deepEqual(result.receipt, receipt); assert.deepEqual(await state(), before); assert(reads > startReads);
      });
      await check("same-key payload changes, variant changes and different actor cannot disclose receipt", async () => {
        for (const patch of [{ quantity: "13" }, { reason: "changed" }, { productId: other.id, variantId: foreign.id }]) {
          const result = await denied("CONFLICT", { ...input, ...patch }); assert(!("receipt" in result));
        }
        const member = await tx.adminUser.create({ data: { userId: (await tx.user.create({ data: { id: randomUUID(), name: "TEST other actor", email: `${randomUUID()}@example.invalid` } })).id, roleId: role.id, active: true } });
        const originalId = session.user.id; session.user.id = member.userId; session.session.userId = member.userId;
        await denied("CONFLICT", input); session.user.id = originalId; session.session.userId = originalId;
      });
      await check("replay still enforces current lifecycle and authorization", async () => {
        await tx.productVariant.update({ where: { id: variant.id }, data: { active: false } }); await denied("INELIGIBLE", input);
        await tx.productVariant.update({ where: { id: variant.id }, data: { active: true } });
        signedIn = false; await denied("ACCESS_DENIED", input); signedIn = true;
      });
      await check("active receive preserves reserved/threshold and advances future microsecond revision exactly", async () => {
        await tx.product.update({ where: { id: product.id }, data: { lifecycle: "active" } });
        await tx.$executeRaw`UPDATE inventory_balances SET reserved = 4, low_stock_threshold = 7, updated_at = '2099-01-01T00:00:00.123456Z'::timestamptz WHERE variant_id = ${variant.id}::uuid`;
        const result = await receiveStock(headers, fresh({ quantity: "3" })); assert(result.ok);
        assert.deepEqual([result.receipt.onHandBefore, result.receipt.onHandAfter, result.receipt.reservedBefore, result.receipt.reservedAfter], [12, 15, 4, 4]);
        const [row] = await tx.$queryRaw<{ reserved: number; threshold: number; revision: string }[]>`SELECT reserved, low_stock_threshold AS threshold, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision FROM inventory_balances WHERE variant_id = ${variant.id}::uuid`;
        assert.deepEqual(row, { reserved: 4, threshold: 7, revision: "2099-01-01T00:00:00.123457Z" });
      });
      await check("independent keys accumulate independently; INTEGER maximum succeeds and overflow fails", async () => {
        const a = await receiveStock(headers, fresh({ quantity: "1" }));
        const manager = await tx.adminRole.findUniqueOrThrow({ where: { name: "PRODUCT_MANAGER" } });
        await tx.adminUser.update({ where: { id: admin.id }, data: { roleId: manager.id } });
        const b = await receiveStock(headers, fresh({ quantity: "1" })); assert(a.ok && b.ok);
        await tx.adminUser.update({ where: { id: admin.id }, data: { roleId: role.id } });
        assert.equal(b.receipt.onHandAfter, 17);
        const max = await receiveStock(headers, fresh({ quantity: "2147483630" })); assert(max.ok); assert.equal(max.receipt.onHandAfter, 2147483647);
        await denied("OVERFLOW", fresh({ quantity: "1" }));
        await denied("VALIDATION", fresh({ quantity: "2147483648" }));
      });
      await check("ledger/balance failures roll back initialization and both writes; sensitive diagnostics stay private", async () => {
        for (const failure of ["balance", "ledger", "unrelated", "timeout"] as const) {
          fault = failure; const start = transactions;
          await denied("UNAVAILABLE", fresh({ productId: other.id, variantId: foreign.id }));
          assert.equal(transactions, start + 1); fault = null;
        }
      });
      await check("real global unique violation rolls back before freshly authorized matching recovery", async () => {
        hideReceipt = true; const start = transactions; const startReads = reads;
        // Use the original quantity even though current stock is now at maximum.
        // Temporarily lower balance so the attempted UPDATE can reach the unique arbiter.
        await tx.$executeRaw`UPDATE inventory_balances SET on_hand = 17 WHERE variant_id = ${variant.id}::uuid`;
        const before = await state(); const result = await receiveStock(headers, input);
        assert(result.ok); assert.deepEqual(result.receipt, receipt); assert.equal(transactions, start + 2); assert.equal(reads, startReads + 2); assert.deepEqual(await state(), before);
      });
      await check("global key collision across products rolls back attempted initialization and returns private conflict", async () => {
        hideReceipt = true; await denied("CONFLICT", { ...input, productId: other.id, variantId: foreign.id });
        assert.equal(await tx.inventoryBalance.findUnique({ where: { variantId: foreign.id } }), null);
      });
      await check("authorization revoked after unique failure denies recovery without exposing movement", async () => {
        hideReceipt = true; revokeOnRecovery = true; await denied("ACCESS_DENIED", input); signedIn = true;
      });
      throw rollback;
    }, { timeout: 60000, maxWait: 5000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally {
    Reflect.set(prisma, "$transaction", original.transaction); Reflect.set(auth.api, "getSession", original.session);
    Reflect.set(prisma.adminUser, "findUnique", original.admin); Reflect.set(prisma.session, "findUnique", original.stored);
    const previousStage = stage;
    const after = await preflight(); assert.deepEqual(after, baseline); stage = previousStage;
    console.log(`PASS: outer rollback proved all ${baseline.length} public table fingerprints restored, including ledger and auth`);
  }
  console.log(`${passed} receiving service checks passed; real single-connection PostgreSQL; concurrency tests deferred.`);
}
verify().catch(error => { console.error(`Receiving verification failed at ${stage}; category ${error instanceof Error ? error.name : "unknown"}, code ${error?.code ?? "none"}; sensitive diagnostics withheld.`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
