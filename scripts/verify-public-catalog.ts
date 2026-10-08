// Run: node --conditions=react-server --import tsx scripts/verify-public-catalog.ts
import "dotenv/config";
import assert from "node:assert/strict";
import type { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/prisma";
import {
  getPublicCategories,
  getPublicProducts,
  getPublicProductBySlug,
  getPublicStockStatus,
} from "../src/lib/catalog";

const restorers: (() => void)[] = [];
function intercept<T>(method: "findMany" | "findFirst", implementation: (args: T) => Promise<unknown>) {
  const original = prisma.product[method];
  assert.ok(Reflect.set(prisma.product, method, implementation));
  restorers.push(() => { Reflect.set(prisma.product, method, original); });
}
function restoreMethods() {
  for (const restore of restorers.splice(0)) restore();
}

async function snapshot() {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw<{ db: string; schema: string }[]>`
      SELECT current_database() AS db, current_schema() AS schema
    `;
    assert.deepEqual(identity, { db: "aafiyat_dev", schema: "public" });
    return {
      categories: await tx.category.findMany({ orderBy: { id: "asc" } }),
      products: await tx.product.count(),
      variants: await tx.productVariant.count(),
      balances: await tx.inventoryBalance.count(),
    };
  });
}

async function verify() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55432");
  assert.equal(url.pathname, "/aafiyat_dev");
  const before = await snapshot();
  assert.equal(before.products + before.variants + before.balances, 0);
  const categories = await getPublicCategories();
  assert.deepEqual(categories.map(({ name, slug }) => [name, slug]), [
    ["T-Shirt", "t-shirts"], ["Half Shirt", "half-shirts"],
    ["Full Shirt", "full-shirts"], ["Panjabi", "panjabi"], ["Sherwani", "sherwani"],
  ]);
  for (const category of categories) assert.deepEqual(Object.keys(category).sort(), ["id", "name", "slug"]);
  assert.deepEqual(await getPublicProducts(), { items: [], nextCursor: null });
  assert.deepEqual(await getPublicProducts({ categorySlug: "t-shirts" }), { items: [], nextCursor: null });
  assert.equal(await getPublicProductBySlug("missing-product"), null);
  console.log("PASS live reads: five ordered categories, safe category DTOs, empty listings/detail.");

  assert.equal(getPublicStockStatus(null), "Out of Stock");
  for (const [onHand, reserved, threshold, expected] of [
    [0, 0, 3, "Out of Stock"], [5, 5, 3, "Out of Stock"],
    [5, 3, 2, "Low Stock"], [5, 2, 2, "In Stock"],
    [1, 0, null, "In Stock"], [1, 0, 0, "In Stock"],
  ] as const) {
    assert.equal(getPublicStockStatus({ onHand, reserved, lowStockThreshold: threshold }), expected);
  }
  for (const limit of [0, -1, 51, 1.5, NaN]) await assert.rejects(getPublicProducts({ limit }), RangeError);
  await assert.rejects(getPublicProducts({ cursor: "invalid" }), TypeError);
  await assert.rejects(getPublicProductBySlug("../invalid"), TypeError);

  // Contract probes are in-memory only: no sample products are written to PostgreSQL.
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const summary = { id: firstId, name: "Projection probe", slug: "projection-probe", category: categories[0] };
  intercept("findMany", async (args: Prisma.ProductFindManyArgs) => {
    assert.deepEqual(args.where, {
      lifecycle: "active", archivedAt: null, category: { active: true, slug: "t-shirts" },
      id: { gt: firstId },
    });
    assert.deepEqual(args.orderBy, { id: "asc" });
    assert.equal(args.take, 2);
    assert.deepEqual(Object.keys(args.select!).sort(), ["category", "id", "name", "slug"]);
    return [{ ...summary, id: secondId }, { ...summary, id: "00000000-0000-4000-8000-000000000003" }];
  });
  assert.deepEqual(await getPublicProducts({ limit: 1, cursor: firstId, categorySlug: " T-SHIRTS " }), {
    items: [{ ...summary, id: secondId }], nextCursor: secondId,
  });
  intercept("findFirst", async (args: Prisma.ProductFindFirstArgs) => {
    assert.deepEqual(args.where, {
      lifecycle: "active", archivedAt: null, category: { active: true }, slug: "projection-probe",
    });
    const variants = args.select?.variants;
    assert.ok(variants && typeof variants === "object");
    assert.deepEqual(variants.where, { active: true, archivedAt: null });
    return {
      ...summary, description: "", seoTitle: null, seoDescription: null,
      variants: [{
        id: firstId, sku: "PROJECTION-PROBE", sizeCode: "m", sizeLabel: "M",
        colorCode: "black", colorLabel: "Black", priceMinor: BigInt("9007199254740993"), currency: "BDT",
        inventoryBalance: { onHand: 10, reserved: 8, lowStockThreshold: 2 },
      }],
    };
  });
  const detail = await getPublicProductBySlug(" PROJECTION-PROBE ");
  assert.ok(detail);
  assert.deepEqual(Object.keys(detail).sort(), ["category", "description", "id", "name", "seoDescription", "seoTitle", "slug", "variants"]);
  assert.deepEqual(Object.keys(detail.variants[0]).sort(), ["colorCode", "colorLabel", "currency", "id", "priceMinor", "sizeCode", "sizeLabel", "sku", "stockStatus"]);
  assert.equal(detail.variants[0].priceMinor, "9007199254740993");
  assert.equal(detail.variants[0].stockStatus, "Low Stock");
  assert.doesNotThrow(() => JSON.stringify(detail));
  restoreMethods();
  assert.deepEqual(await snapshot(), before);
  console.log("PASS contract checks: active filters, cursor bounds, exact prices, stock boundaries, no inventory leakage.");
  console.log("PASS database unchanged; live product/variant filtering awaits real catalog data.");
}

verify().catch((error: unknown) => {
  console.error(error instanceof assert.AssertionError || error instanceof TypeError ? error.message : "Catalog verification failed.");
  process.exitCode = 1;
}).finally(async () => {
  restoreMethods();
  await prisma.$disconnect();
});
