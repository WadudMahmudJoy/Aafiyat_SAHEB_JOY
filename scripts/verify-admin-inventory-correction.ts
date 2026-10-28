// Run: node --conditions=react-server --import tsx scripts/verify-admin-inventory-correction.ts
// Real PostgreSQL SQL, single connection, savepoint-backed service calls inside
// one outer transaction that always rolls back. Not concurrency verification.
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { receiveStock } from "../src/lib/admin-inventory";

let stage = "correction service export"; let passed = 0;
async function check(name: string, run: () => unknown | Promise<unknown>) {
  stage = name; await run(); passed++; console.log(`PASS: ${name}`);
}
async function snapshot(tx: Prisma.TransactionClient) {
  const tables = await tx.$queryRaw<{ name: string }[]>`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  assert.equal(tables.length, 13);
  const result = [];
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const [row] = await tx.$queryRawUnsafe<{ count: bigint; hash: string }[]>(`SELECT count(*) AS count, md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) AS hash FROM public.${quoted} t`);
    result.push({ name, ...row });
  }
  return result;
}
async function preflight() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55432"); assert.equal(url.pathname, "/aafiyat_dev");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw<{ db: string; ledger: string | null }[]>`SELECT current_database() AS db, to_regclass('public.stock_movements')::text AS ledger`;
    assert.equal(identity.db, "aafiyat_dev"); assert.equal(identity.ledger, "stock_movements");
    const applied = await tx.$queryRaw<{ name: string; checksum: string; finished: boolean; rolledBack: boolean }[]>`SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack" FROM _prisma_migrations ORDER BY migration_name`;
    const local = readdirSync("prisma/migrations", { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.equal(local.length, 5); assert.deepEqual(applied.map(m => m.name), local);
    for (const m of applied) {
      assert(m.finished && !m.rolledBack);
      assert.equal(m.checksum, createHash("sha256").update(readFileSync(`prisma/migrations/${m.name}/migration.sql`)).digest("hex"));
    }
    const checks = await tx.$queryRaw<{ name: string; valid: boolean }[]>`SELECT conname AS name, convalidated AS valid FROM pg_constraint WHERE conrelid = 'public.stock_movements'::regclass`;
    for (const name of ["stock_movements_type_delta_valid", "stock_movements_snapshots_nonnegative", "stock_movements_reserved_within_stock", "stock_movements_snapshot_arithmetic", "stock_movements_reserved_unchanged", "stock_movements_reason_nonempty", "stock_movements_fingerprint_sha256", "stock_movements_variant_id_fkey", "stock_movements_actor_admin_id_fkey"]) assert(checks.some(c => c.name === name && c.valid));
    const [trigger] = await tx.$queryRaw<{ enabled: string }[]>`SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid = 'public.stock_movements'::regclass AND tgname = 'stock_movements_append_only'`;
    assert.equal(trigger?.enabled, "A");
    const [index] = await tx.$queryRaw<{ valid: boolean }[]>`SELECT indisvalid AND indisunique AS valid FROM pg_index WHERE indexrelid = 'public.stock_movements_idempotency_key_key'::regclass`;
    assert.equal(index?.valid, true);
    return snapshot(tx);
  }, { timeout: 15000 });
}

async function verify() {
  const { correctStock } = await import("../src/lib/admin-inventory");
  assert.equal(typeof correctStock, "function", "Correction service must be implemented");
  stage = "read-only database preflight";
  const baseline = await preflight();
  console.log("PASS: local identity, all five migration checksums, ledger checks/index/ALWAYS trigger and 13-table baseline verified");
  const original = { transaction: prisma.$transaction, auth: auth.api.getSession, admin: prisma.adminUser.findUnique, stored: prisma.session.findUnique };
  const rollback = new Error("Intentional correction fixture rollback");
  const now = new Date();
  const session = { session: { id: randomUUID(), userId: String(randomUUID()), token: randomUUID(), createdAt: now, expiresAt: new Date(Date.now() + 600000) }, user: { id: "" } };
  session.user.id = session.session.userId;
  let signedIn = true; let proof: Date | null = now; let reads = 0; let transactions = 0;
  let fault: "balance" | "ledger" | "ledgerCheck" | "unrelated" | "timeout" | null = null;
  let hideReceipt = false; let revokeRecovery = false;
  let invalidState: "unknownProduct" | "archivedProduct" | "archivedVariant" | null = null;
  let locks: string[] = [];
  const headers = new Headers({ origin: String(auth.options.baseURL), "sec-fetch-site": "same-origin" });
  try {
    await original.transaction.call(prisma, async (tx: Prisma.TransactionClient) => {
      stage = "rollback fixture setup";
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      const category = await tx.category.findFirstOrThrow({ select: { id: true } });
      const role = await tx.adminRole.findUniqueOrThrow({ where: { name: "OWNER" } });
      await tx.user.create({ data: { id: session.user.id, name: "TEST correction rollback", email: `${session.user.id}@example.invalid` } });
      const admin = await tx.adminUser.create({ data: { userId: session.user.id, roleId: role.id, active: true } });
      const otherUser = await tx.user.create({ data: { id: randomUUID(), name: "TEST other actor", email: `${randomUUID()}@example.invalid` } });
      await tx.adminUser.create({ data: { userId: otherUser.id, roleId: role.id, active: true } });
      const product = await tx.product.create({ data: { categoryId: category.id, name: "TEST correction", slug: randomUUID(), description: "Rollback fixture" } });
      const other = await tx.product.create({ data: { categoryId: category.id, name: "TEST other product", slug: randomUUID(), description: "Rollback fixture" } });
      async function variant(productId = product.id) {
        return tx.productVariant.create({ data: { productId, sku: randomUUID().toUpperCase(), sizeCode: randomUUID(), sizeLabel: "TEST", colorCode: "test", colorLabel: "TEST", priceMinor: BigInt(0) } });
      }
      const v = await variant(); const foreign = await variant(other.id); const boundary = await variant(); const recovery = await variant();
      const base = { productId: product.id, variantId: v.id, targetOnHand: "10", expectedRevision: "missing", reason: "  Initial\r\n count  ", idempotencyKey: randomUUID() };
      const fresh = (patch = {}) => ({ ...base, idempotencyKey: randomUUID(), ...patch });
      const revision = async (id = v.id) => (await tx.$queryRaw<{ revision: string }[]>`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision FROM inventory_balances WHERE variant_id = ${id}::uuid`)[0]?.revision ?? "missing";
      const state = async () => ({ balances: await tx.inventoryBalance.findMany({ orderBy: { variantId: "asc" } }), movements: await tx.stockMovement.findMany({ orderBy: { id: "asc" } }), products: await tx.product.findMany({ orderBy: { id: "asc" } }), variants: await tx.productVariant.findMany({ orderBy: { id: "asc" } }), revision: await revision() });
      Reflect.set(auth.api, "getSession", async (args: { query: unknown }) => {
        assert.deepEqual(args.query, { disableCookieCache: true, disableRefresh: true }); return signedIn ? session : null;
      });
      Reflect.set(prisma.adminUser, "findUnique", async (args: Prisma.AdminUserFindUniqueArgs) => { reads++; return tx.adminUser.findUnique(args); });
      Reflect.set(prisma.session, "findUnique", async () => ({ ...session.session, mfaVerifiedAt: proof, user: { twoFactorEnabled: true, twofactors: [{ verified: true }] } }));
      Reflect.set(prisma, "$transaction", async (callback: (client: Prisma.TransactionClient) => Promise<unknown>, options: { maxWait: number; timeout: number }) => {
        assert(options.maxWait > 0 && options.maxWait <= 5000 && options.timeout > 0 && options.timeout <= 15000);
        const name = `correction_${++transactions}`; locks = [];
        await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
        const client = new Proxy(tx, { get(target, prop) {
          if (prop === "$queryRaw") return async (sql: TemplateStringsArray, ...args: unknown[]) => {
            const query = sql.join("?");
            if (query.includes("FOR UPDATE")) locks.push(query.includes("FROM products ") ? "products" : query.includes("FROM product_variants") ? "product_variants" : "inventory_balances");
            if (hideReceipt && query.includes("FROM stock_movements")) { hideReceipt = false; return []; }
            const result = await target.$queryRaw(sql, ...args);
            if (invalidState === "unknownProduct" && query.includes("FROM products ")) return [{ lifecycle: "unknown", unarchived: true }];
            if (invalidState === "archivedProduct" && query.includes("FROM products ")) return [{ lifecycle: "draft", unarchived: false }];
            if (invalidState === "archivedVariant" && query.includes("FROM product_variants")) return [{ active: true, unarchived: false }];
            if (fault === "balance" && query.includes("UPDATE inventory_balances")) throw new Error("SECRET balance failure");
            return result;
          };
          if (prop === "stockMovement") return { create: async (args: Prisma.StockMovementCreateArgs) => {
            if (fault === "ledgerCheck") return target.stockMovement.create({ ...args, data: { ...args.data, requestFingerprint: "invalid" } });
            const result = await target.stockMovement.create(args);
            if (fault === "ledger") throw new Error("SECRET ledger failure");
            if (fault === "unrelated") throw { code: "P2002", meta: { modelName: "StockMovement", target: ["id"] }, message: "SECRET unique" };
            if (fault === "timeout") throw { code: "P2028", message: "SECRET ambiguous timeout" };
            return result;
          } };
          return Reflect.get(target, prop);
        } });
        try { const result = await callback(client); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`); return result; }
        catch (error) {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
          if (revokeRecovery) { signedIn = false; revokeRecovery = false; }
          throw error;
        }
      });
      async function denied(code: string, data: unknown = fresh(), request = headers) {
        const before = await state(); const result = await correctStock(request, data);
        assert(!result.ok); assert.equal(result.code, code); assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"]);
        assert(!JSON.stringify(result).includes("SECRET")); assert.deepEqual(await state(), before); return result;
      }
      await check("uncached authorization denies absent/stale MFA, unauthenticated, inactive/disabled and permission-limited callers before transactions", async () => {
        const start = transactions;
        signedIn = false; await denied("ACCESS_DENIED"); signedIn = true;
        proof = null; await denied("ACCESS_DENIED");
        const created = session.session.createdAt; session.session.createdAt = new Date(Date.now() - 14 * 3600000); proof = new Date(Date.now() - 13 * 3600000);
        await denied("ACCESS_DENIED"); session.session.createdAt = created; proof = now;
        for (const data of [{ active: false }, { active: true, disabledAt: now }]) { await tx.adminUser.update({ where: { id: admin.id }, data }); await denied("ACCESS_DENIED"); }
        const deniedRole = await tx.adminRole.findUniqueOrThrow({ where: { name: "ORDER_MANAGER" } });
        await tx.adminUser.update({ where: { id: admin.id }, data: { active: true, disabledAt: null, roleId: deniedRole.id } }); await denied("ACCESS_DENIED");
        await tx.adminUser.update({ where: { id: admin.id }, data: { roleId: role.id } }); assert.equal(transactions, start);
      });
      await check("configured-origin checks and privileged/repeated-field rejection occur before transaction", async () => {
        const start = transactions;
        for (const request of [new Headers(), new Headers({ origin: "null" }), new Headers({ origin: "https://evil.invalid" }), new Headers({ origin: String(auth.options.baseURL), "sec-fetch-site": "cross-site" })]) await denied("ACCESS_DENIED", fresh(), request);
        await denied("VALIDATION", fresh({ actorAdminId: admin.id })); await denied("VALIDATION", fresh({ expectedRevision: undefined }));
        const form = new FormData(); for (const [k, value] of Object.entries(base)) form.append(k, value); form.append("targetOnHand", "10"); await denied("VALIDATION", form);
        assert.equal(transactions, start);
      });
      await check("invalid product/variant binding and unknown IDs deny without initialization", async () => {
        await denied("NOT_FOUND", fresh({ variantId: foreign.id })); await denied("NOT_FOUND", fresh({ productId: randomUUID() })); await denied("NOT_FOUND", fresh({ variantId: randomUUID() }));
      });
      await check("missing balance rejects zero no-op and concrete revision without persisting balance or movement", async () => {
        await denied("NO_CHANGE", fresh({ targetOnHand: "0" }));
        await denied("CONFLICT", fresh({ expectedRevision: "2026-10-28T00:00:00.000001Z" }));
        assert.equal(await tx.inventoryBalance.findUnique({ where: { variantId: v.id } }), null);
      });
      let originalReceipt: unknown;
      await check("draft missing-state correction initializes once with exact server-derived actor, delta, snapshots and canonical fingerprint", async () => {
        const result = await correctStock(headers, base); assert(result.ok); originalReceipt = result.receipt;
        assert(Object.isFrozen(result.receipt)); assert.equal(result.receipt.movementType, "correction");
        assert.deepEqual([result.receipt.deltaOnHand, result.receipt.deltaReserved, result.receipt.onHandBefore, result.receipt.onHandAfter, result.receipt.reservedBefore, result.receipt.reservedAfter], [10, 0, 0, 10, 0, 0]);
        assert.equal(locks[0], "products"); assert.equal(locks[1], "product_variants"); assert(locks.slice(2).every(name => name === "inventory_balances"));
        const row = await tx.stockMovement.findUniqueOrThrow({ where: { idempotencyKey: base.idempotencyKey } }); assert.equal(row.actorAdminId, admin.id);
        const canonical = JSON.stringify({ version: 1, operation: "correction", actorAdminId: admin.id, productId: product.id, variantId: v.id, targetOnHand: "10", expectedRevision: "missing", reason: "Initial count" });
        assert.equal(row.requestFingerprint, createHash("sha256").update(canonical, "utf8").digest("hex"));
        assert.match(result.receipt.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      });
      await check("identical normalized replay precedes missing-revision and no-op rejection", async () => {
        const before = await state(); const start = reads;
        const result = await correctStock(headers, { ...base, productId: product.id.toUpperCase(), targetOnHand: "00010", reason: "Initial count" });
        assert(result.ok); assert.deepEqual(result.receipt, originalReceipt); assert.deepEqual(await state(), before); assert(reads > start);
      });
      await check("existing balance rejects missing/stale revisions including a one-microsecond mismatch", async () => {
        await denied("CONFLICT", fresh());
        await tx.$executeRaw`UPDATE inventory_balances SET updated_at = '2099-01-01T00:00:00.123456Z'::timestamptz WHERE variant_id = ${v.id}::uuid`;
        await denied("CONFLICT", fresh({ targetOnHand: "14", expectedRevision: "2099-01-01T00:00:00.123455Z" }));
        await denied("CONFLICT", fresh({ targetOnHand: "14", expectedRevision: "2099-01-01T00:00:00.123457Z" }));
      });
      await check("positive and negative corrections preserve reserved/threshold and advance exact future revision by one microsecond", async () => {
        await tx.$executeRaw`UPDATE inventory_balances SET reserved = 4, low_stock_threshold = 7 WHERE variant_id = ${v.id}::uuid`;
        const positive = await correctStock(headers, fresh({ targetOnHand: "14", expectedRevision: await revision() })); assert(positive.ok);
        assert.deepEqual([positive.receipt.deltaOnHand, positive.receipt.onHandBefore, positive.receipt.onHandAfter, positive.receipt.reservedBefore, positive.receipt.reservedAfter], [4, 10, 14, 4, 4]);
        assert.equal(await revision(), "2099-01-01T00:00:00.123457Z");
        const negative = await correctStock(headers, fresh({ targetOnHand: "8", expectedRevision: await revision() })); assert(negative.ok);
        assert.deepEqual([negative.receipt.deltaOnHand, negative.receipt.onHandBefore, negative.receipt.onHandAfter], [-6, 14, 8]);
        assert.equal(await revision(), "2099-01-01T00:00:00.123458Z");
        const balance = await tx.inventoryBalance.findUniqueOrThrow({ where: { variantId: v.id } }); assert.equal(balance.reserved, 4); assert.equal(balance.lowStockThreshold, 7);
      });
      await check("unchanged target and target below reservations reject without revision or ledger changes", async () => {
        await denied("NO_CHANGE", fresh({ targetOnHand: "8", expectedRevision: await revision() }));
        for (const targetOnHand of ["3", "0"]) await denied("BELOW_RESERVED", fresh({ targetOnHand, expectedRevision: await revision() }));
      });
      await check("a counted target equal to reserved stock is permitted and preserves its threshold", async () => {
        const bound = await variant();
        await tx.inventoryBalance.create({ data: { variantId: bound.id, onHand: 7, reserved: 4, lowStockThreshold: 2 } });
        const result = await correctStock(headers, fresh({ variantId: bound.id, targetOnHand: "4", expectedRevision: await revision(bound.id) }));
        assert(result.ok); assert.deepEqual([result.receipt.deltaOnHand, result.receipt.onHandBefore, result.receipt.onHandAfter, result.receipt.reservedAfter], [-3, 7, 4, 4]);
        const balance = await tx.inventoryBalance.findUniqueOrThrow({ where: { variantId: bound.id } }); assert.equal(balance.lowStockThreshold, 2);
      });
      await check("draft, active and discontinued products with active or inactive unarchived variants can reconcile without lifecycle/metadata writes", async () => {
        let targetOnHand = 8;
        for (const lifecycle of ["draft", "active", "discontinued"]) for (const active of [true, false]) {
          await tx.product.update({ where: { id: product.id }, data: { lifecycle } }); await tx.productVariant.update({ where: { id: v.id }, data: { active } });
          const before = { product: await tx.product.findUnique({ where: { id: product.id } }), variant: await tx.productVariant.findUnique({ where: { id: v.id } }) };
          const result = await correctStock(headers, fresh({ targetOnHand: String(++targetOnHand), expectedRevision: await revision() })); assert(result.ok);
          assert.deepEqual({ product: await tx.product.findUnique({ where: { id: product.id } }), variant: await tx.productVariant.findUnique({ where: { id: v.id } }) }, before);
        }
      });
      await check("archived and unknown/inconsistent lifecycle states deny even an otherwise matching replay", async () => {
        await tx.product.update({ where: { id: product.id }, data: { lifecycle: "archived", archivedAt: now } }); await denied("INELIGIBLE", base);
        await tx.product.update({ where: { id: product.id }, data: { lifecycle: "active", archivedAt: null } });
        await tx.productVariant.update({ where: { id: v.id }, data: { active: false, archivedAt: now } }); await denied("INELIGIBLE", base);
        await tx.productVariant.update({ where: { id: v.id }, data: { active: true, archivedAt: null } });
        for (const value of ["unknownProduct", "archivedProduct", "archivedVariant"] as const) { invalidState = value; await denied("INELIGIBLE", base); } invalidState = null;
      });
      await check("old authorized replay after later corrections returns original historical receipt and leaves current revision untouched", async () => {
        const before = await state(); const result = await correctStock(headers, base); assert(result.ok);
        assert.deepEqual(result.receipt, originalReceipt); assert.equal(result.receipt.onHandAfter, 10); assert.deepEqual(await state(), before);
        signedIn = false; await denied("ACCESS_DENIED", base); signedIn = true;
      });
      await check("changed target, revision, reason, actor and binding have private idempotency conflicts", async () => {
        for (const patch of [{ targetOnHand: "11" }, { expectedRevision: await revision() }, { reason: "Different count" }, { productId: other.id, variantId: foreign.id }]) await denied("CONFLICT", { ...base, ...patch });
        const id = session.user.id; session.user.id = otherUser.id; session.session.userId = otherUser.id; await denied("CONFLICT", base); session.user.id = id; session.session.userId = id;
      });
      await check("correction and receive keys share the global namespace without cross-operation replay", async () => {
        const receive = await receiveStock(headers, { productId: product.id, variantId: v.id, quantity: "1", reason: "TEST receipt", idempotencyKey: randomUUID() }); assert(receive.ok);
        await denied("CONFLICT", fresh({ expectedRevision: await revision(), idempotencyKey: receive.receipt.idempotencyKey }));
        const before = await state(); const result = await receiveStock(headers, { productId: product.id, variantId: v.id, quantity: "10", reason: "Initial count", idempotencyKey: base.idempotencyKey });
        assert(!result.ok); assert.equal(result.code, "CONFLICT"); assert.deepEqual(await state(), before);
      });
      await check("INTEGER extremes derive exact positive and negative signed deltas, including valid existing zero target", async () => {
        const manager = await tx.adminRole.findUniqueOrThrow({ where: { name: "PRODUCT_MANAGER" } }); await tx.adminUser.update({ where: { id: admin.id }, data: { roleId: manager.id } });
        const max = await correctStock(headers, fresh({ variantId: boundary.id, targetOnHand: "2147483647" })); assert(max.ok); assert.equal(max.receipt.deltaOnHand, 2147483647);
        const zero = await correctStock(headers, fresh({ variantId: boundary.id, targetOnHand: "0", expectedRevision: await revision(boundary.id) })); assert(zero.ok); assert.equal(zero.receipt.deltaOnHand, -2147483647);
        await denied("NO_CHANGE", fresh({ variantId: boundary.id, targetOnHand: "0", expectedRevision: await revision(boundary.id) }));
        await denied("VALIDATION", fresh({ targetOnHand: "2147483648" }));
        await tx.adminUser.update({ where: { id: admin.id }, data: { roleId: role.id } });
      });
      await check("balance/ledger faults and real ledger CHECK failure roll back both writes and missing initialization without leaking diagnostics", async () => {
        for (const failure of ["balance", "ledger", "ledgerCheck", "unrelated", "timeout"] as const) for (const existing of [true, false]) {
          fault = failure; const start = transactions;
          await denied("UNAVAILABLE", existing ? fresh({ targetOnHand: "20", expectedRevision: await revision() }) : fresh({ productId: other.id, variantId: foreign.id }));
          assert.equal(transactions, start + 1); fault = null;
        }
      });
      const collision = fresh({ variantId: recovery.id, targetOnHand: "2" });
      await check("forced genuine global unique failure rolls back before reauthorized matching recovery (single-connection probe)", async () => {
        const saved = await correctStock(headers, collision); assert(saved.ok);
        // Test-only recreation of the pre-attempt missing state, plus a hidden
        // lookup, forces a real INSERT uniqueness failure; no concurrency claim.
        await tx.inventoryBalance.delete({ where: { variantId: recovery.id } });
        const before = await state(); const start = transactions; const startReads = reads; hideReceipt = true;
        const replay = await correctStock(headers, collision); assert(replay.ok); assert.deepEqual(replay.receipt, saved.receipt);
        assert.deepEqual(await state(), before); assert.equal(transactions, start + 2); assert.equal(reads, startReads + 2);
      });
      await check("global key collision across products rolls back attempted balance initialization and returns private conflict", async () => {
        hideReceipt = true; const start = transactions;
        await denied("CONFLICT", { ...collision, productId: other.id, variantId: foreign.id }); assert.equal(transactions, start + 2);
        assert.equal(await tx.inventoryBalance.findUnique({ where: { variantId: foreign.id } }), null);
      });
      await check("revoked authorization after unique failure prevents recovery and disclosure", async () => {
        hideReceipt = true; revokeRecovery = true; await denied("ACCESS_DENIED", collision); signedIn = true;
      });
      throw rollback;
    }, { timeout: 60000, maxWait: 5000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally {
    Reflect.set(prisma, "$transaction", original.transaction); Reflect.set(auth.api, "getSession", original.auth);
    Reflect.set(prisma.adminUser, "findUnique", original.admin); Reflect.set(prisma.session, "findUnique", original.stored);
    const previous = stage; stage = "13-table restoration"; assert.deepEqual(await preflight(), baseline); stage = previous;
    console.log("PASS: all 13 table fingerprints restored, including ledger/auth/migration history; outer fixtures rolled back");
  }
  console.log(`${passed} correction service checks passed; real single-connection SQL with simulated authentication; multi-connection tests deferred.`);
}
verify().catch(error => { console.error(`Correction verification failed at ${stage}; category ${error instanceof Error ? error.name : "unknown"}, code ${error?.code ?? "none"}; sensitive diagnostics withheld.`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
