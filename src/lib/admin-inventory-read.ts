import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminDashboard } from "@/lib/admin-dashboard";
import { draftUuid } from "@/lib/product-draft-validation";

export class InventoryReadError extends Error {
  constructor(readonly code: "VALIDATION" | "NOT_FOUND") { super("Inventory unavailable."); }
}
export type InventoryRow = {
  productId: string; variantId: string; productName: string; productSlug: string; category: string;
  sku: string; sizeLabel: string; colorLabel: string; lifecycle: string; productArchived: boolean;
  active: boolean; archived: boolean; onHand: number | null; reserved: number | null;
  available: number | null; threshold: number | null; revision: string;
};
export type InventoryMovement = {
  id: string; movementType: string; actor: string; createdAt: string; reason: string;
  deltaOnHand: number; onHandBefore: number; onHandAfter: number; reservedBefore: number; reservedAfter: number;
};
function text(value: unknown, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new InventoryReadError("VALIDATION");
  return value.trim();
}
function cursor(value: unknown) {
  const result = text(value, 36);
  if (result && !draftUuid.test(result)) throw new InventoryReadError("VALIDATION");
  return result.toLowerCase() || null;
}
async function inventoryRows(tx: Prisma.TransactionClient, id: string | null, after: string | null, search: string) {
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  return tx.$queryRaw<InventoryRow[]>`
    SELECT p.id AS "productId", v.id AS "variantId", p.name AS "productName", p.slug AS "productSlug", c.name AS category,
      v.sku, v.size_label AS "sizeLabel", v.color_label AS "colorLabel", p.lifecycle,
      p.archived_at IS NOT NULL AS "productArchived", v.active, v.archived_at IS NOT NULL AS archived,
      b.on_hand AS "onHand", b.reserved, b.on_hand - b.reserved AS available, b.low_stock_threshold AS threshold,
      COALESCE(to_char(b.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'missing') AS revision
    FROM product_variants v JOIN products p ON p.id = v.product_id JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_balances b ON b.variant_id = v.id
    WHERE (${id}::uuid IS NULL OR v.id = ${id}::uuid) AND (${after}::uuid IS NULL OR v.id > ${after}::uuid)
      AND (${search} = '' OR p.name ILIKE ${pattern} OR p.slug ILIKE ${pattern} OR v.sku ILIKE ${pattern}
        OR c.name ILIKE ${pattern} OR c.slug ILIKE ${pattern} OR v.id::text ILIKE ${pattern} OR p.id::text ILIKE ${pattern})
    ORDER BY v.id LIMIT 26`;
}
const readOptions = { maxWait: 5000, timeout: 10000, isolationLevel: "RepeatableRead" as const };
export async function getInventoryOverview(headers: Headers, params: Record<string, unknown> = {}) {
  const dashboard = await getAdminDashboard(headers, "inventory:manage");
  const search = text(params.search, 100); const after = cursor(params.cursor);
  const rows = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    return inventoryRows(tx, null, after, search);
  }, readOptions);
  const items = rows.slice(0, 25);
  return { dashboard, search, items, nextCursor: rows.length > 25 ? items.at(-1)!.variantId : null };
}
export async function getInventoryDetail(headers: Headers, variantId: string, historyCursor?: unknown) {
  const dashboard = await getAdminDashboard(headers, "inventory:manage");
  const id = cursor(variantId); if (!id) throw new InventoryReadError("VALIDATION");
  const after = cursor(historyCursor);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    const [variant] = await inventoryRows(tx, id, null, "");
    if (!variant) throw new InventoryReadError("NOT_FOUND");
    // The UUID cursor resolves its timestamp in SQL, retaining all six digits.
    // It is bound to this variant; another variant's cursor reveals no history.
    const rows = await tx.$queryRaw<InventoryMovement[]>`
      SELECT m.id, m.movement_type AS "movementType", u.name AS actor,
        to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt", m.reason,
        m.delta_on_hand AS "deltaOnHand", m.on_hand_before AS "onHandBefore", m.on_hand_after AS "onHandAfter",
        m.reserved_before AS "reservedBefore", m.reserved_after AS "reservedAfter"
      FROM stock_movements m JOIN admin_users a ON a.id = m.actor_admin_id JOIN auth_users u ON u.id = a.user_id
      WHERE m.variant_id = ${id}::uuid AND (${after}::uuid IS NULL OR (m.created_at, m.id) <
        (SELECT created_at, id FROM stock_movements WHERE id = ${after}::uuid AND variant_id = ${id}::uuid))
      ORDER BY m.created_at DESC, m.id DESC LIMIT 21`;
    return { variant, movements: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19].id : null };
  }, readOptions);
  const v = result.variant;
  return { dashboard, ...result,
    canReceive: !v.productArchived && !v.archived && v.active && ["draft", "active"].includes(v.lifecycle),
    canCorrect: !v.productArchived && !v.archived && ["draft", "active", "discontinued"].includes(v.lifecycle),
  };
}
export type InventoryOverview = Awaited<ReturnType<typeof getInventoryOverview>>;
export type InventoryDetail = Awaited<ReturnType<typeof getInventoryDetail>>;
