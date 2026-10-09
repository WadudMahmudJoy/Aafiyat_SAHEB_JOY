import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireAdminPermission } from "@/lib/admin-authorization";
import { getAdminDashboard } from "@/lib/admin-dashboard";
import { draftUuid, validateDraft, validDraftVersion, type DraftErrors, type DraftValues } from "@/lib/product-draft-validation";

type FailureCode = "VALIDATION" | "CATEGORY" | "DUPLICATE_SLUG" | "CONFLICT" | "NOT_DRAFT" | "NOT_FOUND" | "UNAVAILABLE";
export class DraftWriteError extends Error {
  constructor(public code: FailureCode, message: string, public fields: DraftErrors = {}) { super(message); }
}
type Result = { ok: true; productId: string; version: string } | { ok: false; code: FailureCode; message: string; fields: DraftErrors };
function failure(error: unknown): Result {
  if (error instanceof DraftWriteError) return { ok: false, code: error.code, message: error.message, fields: error.fields };
  // The unique constraint arbitrates races. No raw Prisma/SQL error is returned or logged.
  const adapter = (error as { meta?: { driverAdapterError?: { cause?: { kind?: string; constraint?: { index?: string } } } } } | null)?.meta?.driverAdapterError?.cause;
  if ((error && typeof error === "object" && "code" in error && error.code === "P2002") ||
      (adapter?.kind === "UniqueConstraintViolation" && adapter.constraint?.index === "products_slug_key")) return { ok: false, code: "DUPLICATE_SLUG", message: "This slug is already in use. Choose another.", fields: { slug: "This slug is already in use." } };
  return { ok: false, code: "UNAVAILABLE", message: "The draft could not be saved. Check the catalogue before retrying.", fields: {} };
}
async function writer(requestHeaders: Headers) {
  // Supplement Next's built-in Server Action origin/host check with the configured,
  // authoritative auth origin. Never derive trust from forwarded/client host headers.
  const configured = auth.options.baseURL;
  if (typeof configured !== "string" || requestHeaders.get("origin") !== new URL(configured).origin || requestHeaders.get("sec-fetch-site") === "cross-site") {
    throw new Error("Product write request denied.");
  }
  await requireAdminPermission("catalog:write", requestHeaders);
}
function metadata(input: unknown): DraftValues {
  const parsed = validateDraft(input);
  if (!parsed.valid) throw new DraftWriteError("VALIDATION", "Check the product fields. Only product metadata is accepted.", parsed.fields);
  return parsed.values;
}
type DraftRow = DraftValues & { id: string; lifecycle: string; archivedAt: Date | null; version: string };
const revision = async (tx: Prisma.TransactionClient, id: string) => {
  const rows = await tx.$queryRaw<{ version: string }[]>`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM products WHERE id = ${id}::uuid`;
  return rows[0].version;
};
export async function createDraftProduct(requestHeaders: Headers, input: unknown): Promise<Result> {
  await writer(requestHeaders);
  try {
    const values = metadata(input);
    return await prisma.$transaction(async tx => {
      const category = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM categories WHERE id = ${values.categoryId}::uuid FOR KEY SHARE`;
      if (!category.length) throw new DraftWriteError("CATEGORY", "Choose an existing category.", { categoryId: "This category is unavailable." });
      const product = await tx.product.create({ data: { ...values, seoTitle: values.seoTitle || null, seoDescription: values.seoDescription || null, lifecycle: "draft", archivedAt: null }, select: { id: true } });
      return { ok: true as const, productId: product.id, version: await revision(tx, product.id) };
    });
  } catch (error) { return failure(error); }
}
export async function updateDraftProduct(requestHeaders: Headers, id: string, version: unknown, input: unknown): Promise<Result> {
  await writer(requestHeaders);
  try {
    if (typeof id !== "string" || !draftUuid.test(id) || !validDraftVersion(version)) throw new DraftWriteError("VALIDATION", "Reload the draft to obtain a valid edit revision.", { version: "Reload the latest draft." });
    const values = metadata(input);
    return await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ lifecycle: string; archivedAt: Date | null; version: string }[]>`SELECT lifecycle, archived_at AS "archivedAt", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM products WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows.length) throw new DraftWriteError("NOT_FOUND", "This product is unavailable.");
      if (rows[0].lifecycle !== "draft" || rows[0].archivedAt) throw new DraftWriteError("NOT_DRAFT", "Only draft products can be edited.");
      if (rows[0].version !== version) throw new DraftWriteError("CONFLICT", "This draft changed since you opened it. Reload the latest draft and reapply your changes.");
      const category = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM categories WHERE id = ${values.categoryId}::uuid FOR KEY SHARE`;
      if (!category.length) throw new DraftWriteError("CATEGORY", "Choose an existing category.", { categoryId: "This category is unavailable." });
      // Only these six fields are writable. Advance the exact revision even for a
      // same-value save; row locking plus the predicate prevents lost updates.
      const updated = await tx.$queryRaw<{ id: string }[]>`UPDATE products SET name = ${values.name}, slug = ${values.slug}, category_id = ${values.categoryId}::uuid, description = ${values.description}, seo_title = ${values.seoTitle || null}, seo_description = ${values.seoDescription || null}, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond') WHERE id = ${id}::uuid AND lifecycle = 'draft' AND archived_at IS NULL AND updated_at = ${version}::timestamptz RETURNING id`;
      if (updated.length !== 1) throw new DraftWriteError("CONFLICT", "The draft changed. Reload before saving.");
      return { ok: true as const, productId: id.toLowerCase(), version: await revision(tx, id) };
    });
  } catch (error) { return failure(error); }
}
export async function getDraftEditor(requestHeaders: Headers, id?: string) {
  const dashboard = await getAdminDashboard(requestHeaders, "catalog:write");
  let product: DraftRow | null = null;
  if (id !== undefined) {
    if (!draftUuid.test(id)) throw new DraftWriteError("NOT_FOUND", "This product is unavailable.");
    const rows = await prisma.$queryRaw<DraftRow[]>`SELECT id, name, slug, category_id AS "categoryId", description, coalesce(seo_title, '') AS "seoTitle", coalesce(seo_description, '') AS "seoDescription", lifecycle, archived_at AS "archivedAt", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM products WHERE id = ${id}::uuid`;
    product = rows[0] ?? null;
    if (!product) throw new DraftWriteError("NOT_FOUND", "This product is unavailable.");
    if (product.lifecycle !== "draft" || product.archivedAt) throw new DraftWriteError("NOT_DRAFT", "Only draft products can be edited.");
  }
  const categories = await prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 101, select: { id: true, name: true, active: true } });
  const truncated = categories.length > 100; const options = categories.slice(0, 100);
  if (product && !options.some(c => c.id === product!.categoryId)) {
    const current = await prisma.category.findUnique({ where: { id: product.categoryId }, select: { id: true, name: true, active: true } });
    if (current) options.push(current);
  }
  return { dashboard, product, categories: options, truncated };
}
