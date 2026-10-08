// Run: node --conditions=react-server --import tsx scripts/verify-public-catalog-live.ts
// All fixtures and service reads share one transaction, which always rolls back.
import "dotenv/config";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { getPublicCategories, getPublicProducts, getPublicProductBySlug } from "../src/lib/catalog";

const id = (n: number) => `007a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const categoryIds = [id(1), id(2), id(3)];
const productIds = Array.from({ length: 9 }, (_, i) => id(i + 10));
const variantIds = Array.from({ length: 8 }, (_, i) => id(i + 20));
const prefix = "task-007a-live";
const timestamp = new Date("2026-10-09T00:00:00.000Z");
let passed = 0;
let failed = 0;

async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch {
    failed++;
    console.error(`FAIL ${name}`);
  }
}

async function snapshot() {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw<{ db: string; schema: string; user: string }[]>`
      SELECT current_database() AS db, current_schema() AS schema, current_user AS "user"
    `;
    assert.deepEqual(identity, { db: "aafiyat_dev", schema: "public", user: "aafiyat_dev" });
    const categories = await tx.category.findMany({ orderBy: { id: "asc" } });
    const [fingerprints] = await tx.$queryRaw<Record<string, string>[]>`
      SELECT
        (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '' ORDER BY id), '')) FROM products p) AS products,
        (SELECT md5(coalesce(string_agg(to_jsonb(v)::text, '' ORDER BY id), '')) FROM product_variants v) AS variants,
        (SELECT md5(coalesce(string_agg(to_jsonb(b)::text, '' ORDER BY variant_id), '')) FROM inventory_balances b) AS balances
    `;
    return {
      categories, fingerprints,
      counts: { categories: categories.length, products: await tx.product.count(),
        variants: await tx.productVariant.count(), balances: await tx.inventoryBalance.count() },
    };
  });
}

async function verify() {
  const target = new URL(process.env.DATABASE_URL!);
  assert.equal(target.protocol, "postgresql:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "55432");
  assert.equal(target.pathname, "/aafiyat_dev");
  assert.equal(target.username, "aafiyat_dev");
  assert.equal(target.searchParams.get("schema"), "public");
  const before = await snapshot();
  // Abort on collisions; never clean up or overwrite records belonging to another run.
  assert.equal(await prisma.category.count({ where: { OR: [
    { id: { in: categoryIds } }, { slug: { startsWith: prefix } },
  ] } }), 0);
  assert.equal(await prisma.product.count({ where: { OR: [
    { id: { in: productIds } }, { slug: { startsWith: prefix } },
  ] } }), 0);
  assert.equal(await prisma.productVariant.count({ where: { OR: [
    { id: { in: variantIds } }, { sku: { startsWith: "TASK-007A-LIVE" } },
  ] } }), 0);

  const rollback = new Error("Intentional catalog integration rollback");
  try {
    await prisma.$transaction(async (tx) => {
      await tx.category.createMany({ data: [
        { id: id(1), name: "Task 007A A", slug: `${prefix}-a`, sortOrder: 10001 },
        { id: id(2), name: "Task 007A B", slug: `${prefix}-b`, sortOrder: 10002 },
        { id: id(3), name: "Task 007A Hidden", slug: `${prefix}-hidden`, active: false },
      ] });
      await tx.product.createMany({ data: productIds.map((productId, i) => ({
        id: productId, categoryId: i === 8 ? id(3) : i === 4 ? id(2) : id(1),
        name: `Task 007A Product ${i}`, slug: `${prefix}-product-${i}`, description: "Rollback-only fixture",
        lifecycle: i === 5 ? "draft" : i === 6 ? "discontinued" : i === 7 ? "archived" : "active",
        archivedAt: i === 7 ? timestamp : null, createdAt: timestamp,
      })) });
      const stocks = [
        { code: "available", onHand: 10, reserved: 2, lowStockThreshold: 2 },
        { code: "low", onHand: 5, reserved: 3, lowStockThreshold: 2 },
        { code: "zero", onHand: 0, reserved: 0, lowStockThreshold: 2 },
        { code: "reserved", onHand: 5, reserved: 5, lowStockThreshold: 2 },
        { code: "missing", onHand: 0, reserved: 0, lowStockThreshold: null },
        { code: "null-threshold", onHand: 1, reserved: 0, lowStockThreshold: null },
        { code: "inactive", onHand: 5, reserved: 0, lowStockThreshold: 2 },
        { code: "archived", onHand: 5, reserved: 0, lowStockThreshold: 2 },
      ];
      await tx.productVariant.createMany({ data: stocks.map((stock, i) => ({
        id: variantIds[i], productId: id(10), sku: `TASK-007A-LIVE-${stock.code.toUpperCase()}`,
        sizeCode: stock.code, sizeLabel: stock.code, colorCode: "black", colorLabel: "Black",
        priceMinor: BigInt(i === 0 ? "9007199254740993" : i === 4 ? "9223372036854775807" : "199900"),
        active: i < 6, archivedAt: i === 7 ? timestamp : null,
      })) });
      await tx.inventoryBalance.createMany({ data: stocks.flatMap((stock, i) => i === 4 ? [] : [{
        variantId: variantIds[i], onHand: stock.onHand, reserved: stock.reserved,
        lowStockThreshold: stock.lowStockThreshold,
      }]) });

      // Route only the service's read methods to this real PostgreSQL transaction.
      // No query results or filters are mocked. Restore before rollback/disconnect.
      const bindings: [object, string, unknown][] = [
        [prisma.category, "findMany", tx.category.findMany],
        [prisma.product, "findMany", tx.product.findMany],
        [prisma.product, "findFirst", tx.product.findFirst],
      ];
      const originals = bindings.map(([object, method]) => Reflect.get(object, method));
      try {
        bindings.forEach(([object, method, implementation]) => assert.ok(Reflect.set(object, method, implementation)));
        const listing = await getPublicProducts({ categorySlug: `${prefix}-a`, limit: 50 });
        const detail = await getPublicProductBySlug(`${prefix}-product-0`);
        assert.ok(detail, "Fixture detail unavailable; stop integration checks");
        await check("active products visible", () => assert.deepEqual(listing.items.map((p) => p.id), [id(10), id(11), id(12), id(13)]));
        for (const [index, lifecycle] of [[5, "draft"], [6, "discontinued"], [7, "archived"]] as const) {
          await check(`${lifecycle} hidden in listing and detail`, async () => {
            assert.ok(!listing.items.some((p) => p.id === id(index + 10)));
            assert.equal(await getPublicProductBySlug(`${prefix}-product-${index}`), null);
          });
        }
        await check("inactive-category product hidden", async () => {
          assert.equal(await getPublicProductBySlug(`${prefix}-product-8`), null);
          assert.deepEqual(await getPublicProducts({ categorySlug: `${prefix}-hidden` }), { items: [], nextCursor: null });
        });
        await check("active category projection and seeded category preservation", async () => {
          const categories = await getPublicCategories();
          assert.ok(!categories.some((c) => c.id === id(3)));
          assert.deepEqual(categories.filter((c) => categoryIds.includes(c.id)).map((c) => c.id), [id(1), id(2)]);
          for (const c of categories) assert.deepEqual(Object.keys(c).sort(), ["id", "name", "slug"]);
          assert.deepEqual(await tx.category.findMany({ where: { id: { in: before.categories.map((c) => c.id) } }, orderBy: { id: "asc" } }), before.categories);
        });
        await check("inactive and archived variants excluded", () => {
          assert.deepEqual(detail.variants.map((v) => v.id).sort(), variantIds.slice(0, 6).sort());
        });
        for (const [index, expected] of [
          [0, "In Stock"], [1, "Low Stock"], [2, "Out of Stock"],
          [3, "Out of Stock"], [4, "Out of Stock"], [5, "In Stock"],
        ] as const) {
          await check(`stock ${stocks[index].code}`, () => assert.equal(detail.variants.find((v) => v.id === variantIds[index])?.stockStatus, expected));
        }
        await check("public DTOs contain no internal fields", () => {
          for (const p of listing.items) assert.deepEqual(Object.keys(p).sort(), ["category", "id", "name", "slug"]);
          assert.deepEqual(Object.keys(detail).sort(), ["category", "description", "id", "name", "seoDescription", "seoTitle", "slug", "variants"]);
          assert.deepEqual(Object.keys(detail.category).sort(), ["id", "name", "slug"]);
          for (const v of detail.variants) assert.deepEqual(Object.keys(v).sort(), ["colorCode", "colorLabel", "currency", "id", "priceMinor", "sizeCode", "sizeLabel", "sku", "stockStatus"]);
          assert.ok(!/"(?:onHand|on_hand|reserved|inventoryBalance|lowStockThreshold|available)"\s*:/.test(JSON.stringify(detail)));
        });
        await check("category filtering and normalized slug", async () => {
          assert.deepEqual((await getPublicProducts({ categorySlug: ` ${prefix.toUpperCase()}-B ` })).items.map((p) => p.id), [id(14)]);
          assert.deepEqual(await getPublicProducts({ categorySlug: `${prefix}-absent` }), { items: [], nextCursor: null });
        });
        await check("BIGINT exactness and JSON serialization", () => {
          assert.equal(detail.variants.find((v) => v.id === id(20))?.priceMinor, "9007199254740993");
          assert.equal(detail.variants.find((v) => v.id === id(24))?.priceMinor, "9223372036854775807");
          assert.deepEqual(JSON.parse(JSON.stringify(detail)), detail);
        });
        await check("equal created_at fixture timestamps", async () => {
          const rows = await tx.product.findMany({ where: { id: { in: productIds } }, select: { createdAt: true } });
          assert.equal(rows.length, 9);
          assert.ok(rows.every((row) => row.createdAt.getTime() === timestamp.getTime()));
        });
        for (const limit of [1, 2, 3]) {
          await check(`stable cursor pagination with page size ${limit}`, async () => {
            async function pages() {
              const ids: string[] = [];
              let cursor: string | undefined;
              for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
                const page = await getPublicProducts({ categorySlug: `${prefix}-a`, cursor, limit });
                assert.ok(page.items.length <= limit);
                ids.push(...page.items.map((p) => p.id));
                if (!page.nextCursor) return ids;
                assert.equal(page.nextCursor, page.items[page.items.length - 1].id);
                cursor = page.nextCursor;
              }
              throw new Error("Pagination failed to terminate");
            }
            const first = await pages();
            assert.deepEqual(first, [id(10), id(11), id(12), id(13)]);
            assert.equal(new Set(first).size, first.length);
            assert.deepEqual(await pages(), first);
          });
        }
        await check("cursor past final product is empty", async () => {
          assert.deepEqual(await getPublicProducts({ categorySlug: `${prefix}-a`, cursor: id(13) }), { items: [], nextCursor: null });
        });
      } finally {
        bindings.forEach(([object, method], i) => Reflect.set(object, method, originals[i]));
      }
      throw rollback;
    }, { maxWait: 5_000, timeout: 30_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    // A mismatch stops verification; never delete anything as a cleanup fallback.
    const after = await snapshot();
    assert.deepEqual(after, before, "Database changed after rollback");
    assert.equal(await prisma.category.count({ where: { id: { in: categoryIds } } }), 0);
    assert.equal(await prisma.product.count({ where: { id: { in: productIds } } }), 0);
    assert.equal(await prisma.productVariant.count({ where: { id: { in: variantIds } } }), 0);
    assert.equal(await prisma.inventoryBalance.count({ where: { variantId: { in: variantIds } } }), 0);
    console.log("PASS rollback: all fixtures absent, seeded categories and original table fingerprints unchanged.");
    console.log(`Post-test row counts: ${JSON.stringify(after.counts)}`);
  }
  console.log(`Live integration results: ${passed} PASS / ${failed} FAIL`);
  if (failed) throw new Error("Live catalog integration checks failed");
}

verify().catch((error: unknown) => {
  console.error(error instanceof assert.AssertionError ? error.message : "Live catalog verification failed; fixtures must remain isolated.");
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
