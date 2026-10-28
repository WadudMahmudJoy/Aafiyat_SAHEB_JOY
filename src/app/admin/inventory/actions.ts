"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { receiveStock, correctStock } from "@/lib/admin-inventory";
import type { InventoryActionState } from "@/lib/inventory-action-state";

async function execute(operation: "receive" | "correction", data: FormData): Promise<InventoryActionState> {
  try {
    // Retain all user entries and duplicates. Only Next's reserved action
    // transport fields are removed; the service owns validation and authority.
    const input = new FormData();
    for (const [key, value] of data.entries()) if (!key.startsWith("$ACTION_")) input.append(key, value);
    const result = await (operation === "receive" ? receiveStock : correctStock)(await headers(), input);
    if (!result.ok) return { status: "error", code: result.code, message: result.message };
    revalidatePath("/admin/inventory"); revalidatePath(`/admin/inventory/${result.receipt.variantId}`);
    revalidatePath("/admin/products"); revalidatePath(`/admin/products/${result.receipt.productId}`);
    return { status: "saved", message: operation === "receive" ? "Stock received. Movement recorded." : "Counted stock correction recorded.", receipt: result.receipt };
  } catch {
    return { status: "error", code: "UNAVAILABLE", message: "Unable to confirm this operation. Check your session and retry the same request with the same key." };
  }
}
export async function receiveStockAction(_previous: InventoryActionState, data: FormData) { return execute("receive", data); }
export async function correctStockAction(_previous: InventoryActionState, data: FormData) { return execute("correction", data); }
