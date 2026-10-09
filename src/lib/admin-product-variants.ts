import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireAdminPermission } from "@/lib/admin-authorization";
import { getAdminDashboard } from "@/lib/admin-dashboard";
import { draftUuid } from "@/lib/product-draft-validation";
import { validateVariant, validDraftVersion, priceInput, type VariantErrors } from "@/lib/variant-validation";
export class VariantWriteError extends Error { constructor(public code: string, message: string, public fields: VariantErrors = {}) { super(message); } }
type Result = { ok: true; variantId: string; version: string } | { ok: false; code: string; message: string; fields: VariantErrors };
async function writer(headers: Headers) {
  const base = auth.options.baseURL;
  if (typeof base !== "string" || headers.get("origin") !== new URL(base).origin || headers.get("sec-fetch-site") === "cross-site") throw new Error("Variant write denied.");
  await requireAdminPermission("catalog:write", headers);
}
async function parent(tx: Prisma.TransactionClient, productId: string) {
  if (typeof productId !== "string" || !draftUuid.test(productId)) throw new VariantWriteError("NOT_FOUND", "Product unavailable.");
  // Parent first, then variant: lifecycle transitions and concurrent edits serialize.
  const rows = await tx.$queryRaw<{ lifecycle: string; archivedAt: Date | null }[]>`SELECT lifecycle, archived_at AS "archivedAt" FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
  if (!rows.length) throw new VariantWriteError("NOT_FOUND", "Product unavailable.");
  if (rows[0].lifecycle !== "draft" || rows[0].archivedAt) throw new VariantWriteError("NOT_DRAFT", "Variants can be managed only for draft products.");
}
function failure(error: unknown): Result {
  if (error instanceof VariantWriteError) return { ok: false, code: error.code, message: error.message, fields: error.fields };
  const e = error as { code?: string; meta?: { target?: string[]; driverAdapterError?: { cause?: { kind?: string; constraint?: { index?: string } } } } };
  const cause = e?.meta?.driverAdapterError?.cause;
  const index = cause?.constraint?.index;
  if (e?.code === "P2002" || cause?.kind === "UniqueConstraintViolation") {
    const combination = index === "product_variants_product_id_size_code_color_code_key" || e?.meta?.target?.includes("size_code") || e?.meta?.target?.includes("sizeCode");
    return combination ? { ok: false, code: "DUPLICATE_COMBINATION", message: "This product already has that size/color combination.", fields: { sizeCode: "Size/color combination already exists.", colorCode: "Size/color combination already exists." } }
      : { ok: false, code: "DUPLICATE_SKU", message: "This SKU is already in use. Choose another.", fields: { sku: "This SKU is already in use." } };
  }
  return { ok: false, code: "UNAVAILABLE", message: "The variant could not be saved. Check the product before retrying.", fields: {} };
}
export async function saveDraftVariant(headers: Headers, productId: string, variantId: string | null, version: unknown, input: unknown): Promise<Result> {
  await writer(headers);
  try {
    const parsed = validateVariant(input);
    if (!parsed.valid || parsed.priceMinor === null) throw new VariantWriteError("VALIDATION", "Check the variant fields. Only metadata and a BDT price are accepted.", parsed.fields);
    if (variantId !== null && (typeof variantId !== "string" || !draftUuid.test(variantId) || !validDraftVersion(version))) throw new VariantWriteError("VALIDATION", "Reload the variant to obtain a valid revision.", { version: "Reload the latest variant." });
    return await prisma.$transaction(async tx => {
      await parent(tx, productId);
      const v = parsed.values;
      let id: string;
      if (variantId === null) {
        const row = await tx.productVariant.create({ data: { productId: productId.toLowerCase(), sku: v.sku, sizeCode: v.sizeCode, sizeLabel: v.sizeLabel, colorCode: v.colorCode, colorLabel: v.colorLabel, priceMinor: parsed.priceMinor!, currency: "BDT" }, select: { id: true } });
        // Existing schema defaults apply. No lifecycle toggle or inventory initialization.
        id = row.id;
      } else {
        const rows = await tx.$queryRaw<{ version: string; currency: string; archivedAt: Date | null }[]>`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version, currency, archived_at AS "archivedAt" FROM product_variants WHERE id = ${variantId}::uuid AND product_id = ${productId}::uuid FOR UPDATE`;
        if (!rows.length) throw new VariantWriteError("NOT_FOUND", "Variant unavailable for this product.");
        if (rows[0].archivedAt || rows[0].currency !== "BDT") throw new VariantWriteError("UNSUPPORTED", "Archived or unsupported-currency variants cannot be edited here.");
        if (rows[0].version !== version) throw new VariantWriteError("CONFLICT", "This variant changed. Reload the latest values and reapply your changes.");
        await tx.$executeRaw`UPDATE product_variants SET sku = ${v.sku}, size_code = ${v.sizeCode}, size_label = ${v.sizeLabel}, color_code = ${v.colorCode}, color_label = ${v.colorLabel}, price_minor = ${parsed.priceMinor}, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond') WHERE id = ${variantId}::uuid AND product_id = ${productId}::uuid`;
        id = variantId.toLowerCase();
      }
      const rows = await tx.$queryRaw<{ version: string }[]>`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM product_variants WHERE id = ${id}::uuid`;
      return { ok: true as const, variantId: id, version: rows[0].version };
    });
  } catch (error) { return failure(error); }
}
export async function getVariantEditor(headers: Headers, productId: string, variantId?: string) {
  const dashboard = await getAdminDashboard(headers, "catalog:write");
  return prisma.$transaction(async tx => {
    await parent(tx, productId);
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId.toLowerCase() }, select: { id: true, name: true } });
    let variant = null;
    if (variantId !== undefined) {
      if (!draftUuid.test(variantId)) throw new VariantWriteError("NOT_FOUND", "Variant unavailable.");
      const rows = await tx.$queryRaw<{ id: string; sku: string; sizeCode: string; sizeLabel: string; colorCode: string; colorLabel: string; priceMinor: bigint; currency: string; archivedAt: Date | null; version: string }[]>`SELECT id, sku, size_code AS "sizeCode", size_label AS "sizeLabel", color_code AS "colorCode", color_label AS "colorLabel", price_minor AS "priceMinor", currency, archived_at AS "archivedAt", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM product_variants WHERE id = ${variantId}::uuid AND product_id = ${productId}::uuid`;
      const row = rows[0]; if (!row) throw new VariantWriteError("NOT_FOUND", "Variant unavailable for this product.");
      if (row.archivedAt || row.currency !== "BDT") throw new VariantWriteError("UNSUPPORTED", "This variant cannot be edited here.");
      variant = { id: row.id, version: row.version, values: { sku: row.sku, sizeCode: row.sizeCode, sizeLabel: row.sizeLabel, colorCode: row.colorCode, colorLabel: row.colorLabel, price: priceInput(row.priceMinor) } };
    }
    return { dashboard, product, variant };
  });
}
