import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export type PublicCategory = { id: string; name: string; slug: string };
export type PublicProductSummary = {
  id: string;
  name: string;
  slug: string;
  category: PublicCategory;
};
export type PublicStockStatus = "In Stock" | "Low Stock" | "Out of Stock";
export type PublicVariant = {
  id: string;
  sku: string;
  sizeCode: string;
  sizeLabel: string;
  colorCode: string;
  colorLabel: string;
  priceMinor: string;
  currency: string;
  stockStatus: PublicStockStatus;
};
export type PublicProductDetail = PublicProductSummary & {
  description: string;
  seoTitle: string | null;
  seoDescription: string | null;
  variants: PublicVariant[];
};

const categorySelect = { id: true, name: true, slug: true } satisfies Prisma.CategorySelect;
const summarySelect = {
  id: true,
  name: true,
  slug: true,
  category: { select: categorySelect },
} satisfies Prisma.ProductSelect;
const publicProductWhere = {
  lifecycle: "active",
  archivedAt: null,
  category: { active: true },
} satisfies Prisma.ProductWhereInput;

function normalizedSlug(value: string): string {
  if (typeof value !== "string") throw new TypeError("Invalid catalog slug.");
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new TypeError("Invalid catalog slug.");
  }
  return slug;
}

export function getPublicStockStatus(
  balance: { onHand: number; reserved: number; lowStockThreshold: number | null } | null,
): PublicStockStatus {
  if (!balance) return "Out of Stock";
  const available = balance.onHand - balance.reserved;
  if (available <= 0) return "Out of Stock";
  // Business-settings integration is pending. Null never invents a global threshold.
  if (balance.lowStockThreshold !== null && available <= balance.lowStockThreshold) {
    return "Low Stock";
  }
  return "In Stock";
}

export async function getPublicCategories(): Promise<PublicCategory[]> {
  return prisma.category.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: categorySelect,
  });
}

export async function getPublicProducts(
  options: { categorySlug?: string; cursor?: string; limit?: number } = {},
): Promise<{ items: PublicProductSummary[]; nextCursor: string | null }> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("Catalog page size must be an integer from 1 to 50.");
  }
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.cursor))
  ) {
    throw new TypeError("Invalid catalog cursor.");
  }

  const rows = await prisma.product.findMany({
    where: {
      ...publicProductWhere,
      ...(options.cursor === undefined ? {} : { id: { gt: options.cursor } }),
      category: {
        active: true,
        ...(options.categorySlug === undefined ? {} : { slug: normalizedSlug(options.categorySlug) }),
      },
    },
    // Immutable UUID ordering avoids timestamp precision and deleted-anchor problems.
    orderBy: { id: "asc" },
    take: limit + 1,
    select: summarySelect,
  });
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1].id : null,
  };
}

export async function getPublicProductBySlug(slug: string): Promise<PublicProductDetail | null> {
  const product = await prisma.product.findFirst({
    where: { ...publicProductWhere, slug: normalizedSlug(slug) },
    select: {
      ...summarySelect,
      description: true,
      seoTitle: true,
      seoDescription: true,
      variants: {
        where: { active: true, archivedAt: null },
        orderBy: [{ sizeCode: "asc" }, { colorCode: "asc" }, { id: "asc" }],
        select: {
          id: true,
          sku: true,
          sizeCode: true,
          sizeLabel: true,
          colorCode: true,
          colorLabel: true,
          priceMinor: true,
          currency: true,
          inventoryBalance: { select: { onHand: true, reserved: true, lowStockThreshold: true } },
        },
      },
    },
  });
  if (!product) return null;

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    category: product.category,
    description: product.description,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      sizeCode: variant.sizeCode,
      sizeLabel: variant.sizeLabel,
      colorCode: variant.colorCode,
      colorLabel: variant.colorLabel,
      priceMinor: variant.priceMinor.toString(),
      currency: variant.currency,
      stockStatus: getPublicStockStatus(variant.inventoryBalance),
    })),
  };
}
