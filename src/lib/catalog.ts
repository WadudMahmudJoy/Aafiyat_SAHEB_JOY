import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { publicStockStatus } from "@/lib/business-rules";

export type PublicCategory = { id: string; name: string; slug: string };
export type PublicProductSummary = {
  id: string;
  name: string;
  slug: string;
  category: PublicCategory;
  coverImage?: { url: string; altText: string };
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
  images?: { url: string; altText: string; variantId: string | null; isCover: boolean }[];
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
  gallery: { some: { asset: { state: "ready" } } },
  variants: { some: { active: true, archivedAt: null, currency: "BDT", priceMinor: { gt: BigInt(0) } } },
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
  defaultThreshold: number | null = null,
): PublicStockStatus {
  return publicStockStatus(balance,defaultThreshold);
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

  const [schema] = await prisma.$queryRaw<{ available: boolean }[]>`SELECT to_regclass('public.media_assets') IS NOT NULL AS available`;
  if (!schema.available) return { items: [], nextCursor: null };
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
  const visible = rows.slice(0, limit);
  const covers = await prisma.productMedia.findMany({ where: { productId: { in: visible.map(p => p.id) }, isCover: true, asset: { state: "ready" } }, select: { productId: true, assetId: true, altText: true } });
  const items = visible.map(p => { const cover=covers.find(m=>m.productId===p.id); return { ...p, ...(cover ? { coverImage: { url: `/api/media/${cover.assetId}`, altText: cover.altText } } : {}) }; });
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1].id : null,
  };
}

export async function getPublicProductBySlug(slug: string): Promise<PublicProductDetail | null> {
  const [schema] = await prisma.$queryRaw<{ available: boolean }[]>`SELECT to_regclass('public.media_assets') IS NOT NULL AS available`;
  if (!schema.available) return null;
  const product = await prisma.product.findFirst({
    where: { ...publicProductWhere, slug: normalizedSlug(slug) },
    select: {
      ...summarySelect,
      description: true,
      seoTitle: true,
      seoDescription: true,
      variants: {
        where: { active: true, archivedAt: null, currency: "BDT", priceMinor: { gt: BigInt(0) } },
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
  const [settingsSchema]=await prisma.$queryRaw<{available:boolean}[]>`SELECT to_regclass('public.business_settings') IS NOT NULL AS available`;
  const defaultThreshold=settingsSchema.available?(await prisma.$queryRaw<{value:number|null}[]>`SELECT low_stock_threshold AS value FROM business_settings WHERE id=true`)[0]?.value??null:null;

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    category: product.category,
    description: product.description,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    images: (await prisma.productMedia.findMany({ where: { productId: product.id, asset: { state: "ready" } }, orderBy: { sortOrder: "asc" }, select: { assetId: true, altText: true, variantId: true, isCover: true } })).map(m => ({ url: `/api/media/${m.assetId}`, altText: m.altText, variantId: m.variantId, isCover: m.isCover })),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      sizeCode: variant.sizeCode,
      sizeLabel: variant.sizeLabel,
      colorCode: variant.colorCode,
      colorLabel: variant.colorLabel,
      priceMinor: variant.priceMinor.toString(),
      currency: variant.currency,
      stockStatus: getPublicStockStatus(variant.inventoryBalance,defaultThreshold),
    })),
  };
}
