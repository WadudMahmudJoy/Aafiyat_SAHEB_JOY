import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireAdminPermission } from "@/lib/admin-authorization";
import { validateReceiving, type ReceivingInput } from "@/lib/inventory-validation";

export type ReceivingReceipt = Readonly<{
  id: string; productId: string; variantId: string; movementType: string;
  deltaOnHand: number; deltaReserved: number;
  onHandBefore: number; onHandAfter: number; reservedBefore: number; reservedAfter: number;
  reason: string; idempotencyKey: string; createdAt: string;
}>;
type FailureCode = "ACCESS_DENIED" | "VALIDATION" | "NOT_FOUND" | "INELIGIBLE" | "CONFLICT" | "OVERFLOW" | "UNAVAILABLE";
export type ReceivingResult = { ok: true; receipt: ReceivingReceipt } | { ok: false; code: FailureCode; message: string };
class ReceivingError extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
const messages: Record<FailureCode, string> = {
  ACCESS_DENIED: "Stock receiving access denied.",
  VALIDATION: "Supply only valid product, variant, positive whole quantity, reason and idempotency key fields.",
  NOT_FOUND: "Product or variant unavailable.",
  INELIGIBLE: "This product or variant cannot receive stock.",
  CONFLICT: "This idempotency key cannot be used for this request.",
  OVERFLOW: "Receiving would exceed the supported stock quantity.",
  UNAVAILABLE: "Receiving could not be confirmed. Retry the same request with the same idempotency key.",
};
const transactionOptions = { maxWait: 5000, timeout: 15000, isolationLevel: "ReadCommitted" as const };

async function writer(headers: Headers) {
  try {
    // Same configured-origin protection as admin product/variant writes. Never
    // derive a trusted origin from Host or forwarded request headers.
    const base = auth.options.baseURL;
    if (typeof base !== "string" || headers.get("origin") !== new URL(base).origin ||
        headers.get("sec-fetch-site") === "cross-site") throw new Error();
    return await requireAdminPermission("inventory:manage", headers);
  } catch { throw new ReceivingError("ACCESS_DENIED"); }
}

async function lockEligible(tx: Prisma.TransactionClient, input: ReceivingInput) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
  // Global order: Product -> bound Variant -> Inventory Balance. Lifecycle is
  // read under these locks even for replay; eligibility never changes here.
  const [product] = await tx.$queryRaw<{ lifecycle: string; unarchived: boolean }[]>`
    SELECT lifecycle, archived_at IS NULL AS unarchived
    FROM products WHERE id = ${input.productId}::uuid FOR UPDATE`;
  if (!product) throw new ReceivingError("NOT_FOUND");
  if (!["draft", "active"].includes(product.lifecycle) || product.unarchived !== true) throw new ReceivingError("INELIGIBLE");
  const [variant] = await tx.$queryRaw<{ active: boolean; unarchived: boolean }[]>`
    SELECT active, archived_at IS NULL AS unarchived FROM product_variants
    WHERE id = ${input.variantId}::uuid AND product_id = ${input.productId}::uuid FOR UPDATE`;
  if (!variant) throw new ReceivingError("NOT_FOUND");
  if (variant.active !== true || variant.unarchived !== true) throw new ReceivingError("INELIGIBLE");
}

type MovementRow = ReceivingReceipt & { actorAdminId: string; requestFingerprint: string };
async function movement(tx: Prisma.TransactionClient, key: string): Promise<MovementRow | undefined> {
  const rows = await tx.$queryRaw<MovementRow[]>`
    SELECT m.id, v.product_id AS "productId", m.variant_id AS "variantId",
      m.movement_type AS "movementType", m.delta_on_hand AS "deltaOnHand", m.delta_reserved AS "deltaReserved",
      m.on_hand_before AS "onHandBefore", m.on_hand_after AS "onHandAfter",
      m.reserved_before AS "reservedBefore", m.reserved_after AS "reservedAfter",
      m.reason, m.idempotency_key AS "idempotencyKey", m.actor_admin_id AS "actorAdminId",
      m.request_fingerprint AS "requestFingerprint",
      to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id
    WHERE m.idempotency_key = ${key}::uuid`;
  return rows[0];
}
function receipt(row: MovementRow, input: ReceivingInput, actor: string, fingerprint: string): ReceivingReceipt {
  if (row.actorAdminId !== actor || row.productId !== input.productId || row.variantId !== input.variantId ||
      row.requestFingerprint !== fingerprint || row.movementType !== "receive") throw new ReceivingError("CONFLICT");
  // Never disclose another actor's movement or internal fingerprint on conflict.
  return Object.freeze({
    id: row.id, productId: row.productId, variantId: row.variantId, movementType: row.movementType,
    deltaOnHand: row.deltaOnHand, deltaReserved: row.deltaReserved,
    onHandBefore: row.onHandBefore, onHandAfter: row.onHandAfter,
    reservedBefore: row.reservedBefore, reservedAfter: row.reservedAfter,
    reason: row.reason, idempotencyKey: row.idempotencyKey, createdAt: row.createdAt,
  });
}

// Only this exact global idempotency constraint permits post-rollback recovery.
// Other unique violations, lock failures and ambiguous commit outcomes fail closed.
function idempotencyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; meta?: { modelName?: string; target?: unknown; driverAdapterError?: {
    cause?: { kind?: string; constraint?: { fields?: string[]; index?: string } };
  } } };
  if (e.code !== "P2002" || e.meta?.modelName !== "StockMovement") return false;
  const target = e.meta.target;
  if (Array.isArray(target) && target.length === 1 && ["idempotency_key", "idempotencyKey"].includes(target[0])) return true;
  const cause = e.meta.driverAdapterError?.cause;
  return cause?.kind === "UniqueConstraintViolation" &&
    (cause.constraint?.index === "stock_movements_idempotency_key_key" ||
      (cause.constraint?.fields?.length === 1 && cause.constraint.fields[0] === "idempotency_key"));
}

// Backend service only. Call with current server request headers and unflattened
// input. Authorization is uncached and re-evaluated on every call and recovery.
export async function receiveStock(headers: Headers, rawInput: unknown): Promise<ReceivingResult> {
  try {
    const { adminUserId } = await writer(headers);
    const parsed = validateReceiving(rawInput);
    if (!parsed.valid) throw new ReceivingError("VALIDATION");
    const input = parsed.values;
    // Fixed key order, explicit version, decimal quantity text, normalized UUIDs
    // and NFC/whitespace-normalized reason form the V1 canonical UTF-8 payload.
    const canonical = JSON.stringify({
      version: 1, operation: "receive", actorAdminId: adminUserId,
      productId: input.productId, variantId: input.variantId,
      quantity: String(input.quantity), reason: input.reason,
    });
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    try {
      const saved = await prisma.$transaction(async tx => {
        await lockEligible(tx, input);
        const existing = await movement(tx, input.idempotencyKey);
        if (existing) return receipt(existing, input, adminUserId, fingerprint);
        await tx.$executeRaw`INSERT INTO inventory_balances (variant_id)
          VALUES (${input.variantId}::uuid) ON CONFLICT (variant_id) DO NOTHING`;
        const [balance] = await tx.$queryRaw<{ onHand: number; reserved: number }[]>`
          SELECT on_hand AS "onHand", reserved FROM inventory_balances
          WHERE variant_id = ${input.variantId}::uuid FOR UPDATE`;
        if (!balance || !Number.isInteger(balance.onHand) || !Number.isInteger(balance.reserved) ||
            balance.onHand < 0 || balance.reserved < 0 || balance.reserved > balance.onHand) throw new ReceivingError("UNAVAILABLE");
        const next = BigInt(balance.onHand) + BigInt(input.quantity);
        if (next > BigInt(2147483647)) throw new ReceivingError("OVERFLOW");
        const after = Number(next);
        // Exact DB revision never round-trips through Date. Future reservation/
        // order writers must independently follow this convention as well.
        const updated = await tx.$queryRaw<{ variantId: string }[]>`
          UPDATE inventory_balances SET on_hand = ${after},
            updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE variant_id = ${input.variantId}::uuid RETURNING variant_id AS "variantId"`;
        if (updated.length !== 1) throw new ReceivingError("UNAVAILABLE");
        await tx.stockMovement.create({ data: {
          variantId: input.variantId, movementType: "receive", deltaOnHand: input.quantity, deltaReserved: 0,
          onHandBefore: balance.onHand, onHandAfter: after, reservedBefore: balance.reserved, reservedAfter: balance.reserved,
          actorAdminId: adminUserId, reason: input.reason, idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint,
        }, select: { id: true } });
        const row = await movement(tx, input.idempotencyKey);
        if (!row) throw new ReceivingError("UNAVAILABLE");
        return receipt(row, input, adminUserId, fingerprint);
      }, transactionOptions);
      return { ok: true, receipt: saved };
    } catch (error) {
      // $transaction has rejected and rolled back completely before this path.
      if (!idempotencyViolation(error)) throw error;
      const current = await writer(headers);
      if (current.adminUserId !== adminUserId) throw new ReceivingError("CONFLICT");
      const saved = await prisma.$transaction(async tx => {
        await lockEligible(tx, input);
        const row = await movement(tx, input.idempotencyKey);
        if (!row) throw new ReceivingError("UNAVAILABLE");
        return receipt(row, input, current.adminUserId, fingerprint);
      }, transactionOptions);
      return { ok: true, receipt: saved };
    }
  } catch (error) {
    const code = error instanceof ReceivingError ? error.code : "UNAVAILABLE";
    return { ok: false, code, message: messages[code] };
  }
}
