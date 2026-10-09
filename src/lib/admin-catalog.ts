import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminDashboard } from "@/lib/admin-dashboard";
import { hasAdminPermission } from "@/lib/admin-permissions";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class InvalidFilter extends Error {}
type Input = { search?: unknown; category?: unknown; cursor?: unknown; limit?: number };
function text(value: unknown, max: number) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > max) throw new InvalidFilter();
  return value.trim();
}
function identifier(value: unknown) {
  const result = text(value, 36);
  if (result && !uuid.test(result)) throw new InvalidFilter();
  return result.toLowerCase();
}
function pageSize(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new InvalidFilter();
  return limit;
}
const categorySelect = { id: true, name: true, slug: true, active: true } satisfies Prisma.CategorySelect;
const variantSelect = (inventory: boolean) => ({
  id: true, sku: true, sizeCode: true, sizeLabel: true, colorCode: true, colorLabel: true,
  priceMinor: true, currency: true, active: true, archivedAt: true,
  inventoryBalance: inventory ? { select: { onHand: true, reserved: true, lowStockThreshold: true } } : false,
} satisfies Prisma.ProductVariantSelect);
type VariantRow = { id: string; sku: string; sizeCode: string; sizeLabel: string; colorCode: string; colorLabel: string;
  priceMinor: bigint; currency: string; active: boolean; archivedAt: Date | null;
  inventoryBalance?: { onHand: number; reserved: number; lowStockThreshold: number | null } | null };
function variantDto(row: VariantRow, inventory: boolean) {
  return { id: row.id, sku: row.sku, sizeCode: row.sizeCode, sizeLabel: row.sizeLabel, colorCode: row.colorCode,
    colorLabel: row.colorLabel, priceMinor: row.priceMinor.toString(), currency: row.currency.trim(), active: row.active,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    ...(inventory ? { inventory: row.inventoryBalance ? { ...row.inventoryBalance,
      available: row.inventoryBalance.onHand - row.inventoryBalance.reserved } : null } : {}),
  };
}

export async function getAdminProducts(requestHeaders: Headers, input: Input = {}) {
  // One uncached authorization/identity read; no caller-provided roles or stock flags.
  const dashboard = await getAdminDashboard(requestHeaders, "catalog:read");
  const canViewInventory = hasAdminPermission(dashboard.role, "inventory:manage");
  try {
    const filters = { search: text(input.search, 100), category: identifier(input.category) };
    const cursor = identifier(input.cursor); const limit = pageSize(input.limit);
    const [rows, categories] = await Promise.all([
      prisma.product.findMany({
        where: { ...(cursor ? { id: { gt: cursor } } : {}), ...(filters.category ? { categoryId: filters.category } : {}),
          ...(filters.search ? { OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { slug: { contains: filters.search, mode: "insensitive" } }] } : {}) },
        orderBy: { id: "asc" }, take: limit + 1,
        select: { id: true, name: true, slug: true, lifecycle: true, category: { select: categorySelect },
          _count: { select: { variants: true } }, variants: { orderBy: { id: "asc" }, take: 1, select: variantSelect(canViewInventory) } },
      }),
      prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 101, select: categorySelect }),
    ]);
    const items = rows.slice(0, limit).map(row => ({ id: row.id, name: row.name, slug: row.slug, lifecycle: row.lifecycle,
      category: row.category, variantCount: row._count.variants, exampleVariant: row.variants[0] ? variantDto(row.variants[0], canViewInventory) : null }));
    return { dashboard, canViewInventory, items, filters, categories: categories.slice(0, 100), categoriesTruncated: categories.length > 100,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null, error: null };
  } catch (error) {
    return { dashboard, canViewInventory, items: [], filters: { search: "", category: "" }, categories: [], categoriesTruncated: false,
      nextCursor: null, error: error instanceof InvalidFilter ? "Invalid filters. Use a search of up to 100 characters and valid category/page selections." : "The catalogue is temporarily unavailable. Please retry." };
  }
}

export async function getAdminProduct(requestHeaders: Headers, productId: string, cursorInput?: unknown) {
  const dashboard = await getAdminDashboard(requestHeaders, "catalog:read");
  const canViewInventory = hasAdminPermission(dashboard.role, "inventory:manage");
  try {
    const id = identifier(productId);
    if (!id) throw new InvalidFilter();
    const cursor = identifier(cursorInput);
    const product = await prisma.product.findUnique({ where: { id }, select: {
      id: true, name: true, slug: true, description: true, lifecycle: true, archivedAt: true, seoTitle: true, seoDescription: true,
      createdAt: true, updatedAt: true, category: { select: categorySelect }, _count: { select: { variants: true } },
    } });
    if (!product) return { dashboard, canViewInventory, product: null, variants: [], nextCursor: null, error: null };
    const rows = await prisma.productVariant.findMany({ where: { productId: id, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" }, take: 21, select: variantSelect(canViewInventory) });
    const variants = rows.slice(0, 20).map(row => variantDto(row, canViewInventory));
    const { _count, ...information } = product;
    return { dashboard, canViewInventory, product: { ...information, archivedAt: product.archivedAt?.toISOString() ?? null,
      createdAt: product.createdAt.toISOString(), updatedAt: product.updatedAt.toISOString(), variantCount: _count.variants },
      variants, nextCursor: rows.length > 20 ? variants[variants.length - 1].id : null, error: null };
  } catch (error) {
    return { dashboard, canViewInventory, product: null, variants: [], nextCursor: null,
      error: error instanceof InvalidFilter ? "Invalid product or variant page selection." : "Product details are temporarily unavailable. Please retry." };
  }
}
export type AdminCatalogue = Awaited<ReturnType<typeof getAdminProducts>>;
export type AdminProductDetail = Awaited<ReturnType<typeof getAdminProduct>>;
