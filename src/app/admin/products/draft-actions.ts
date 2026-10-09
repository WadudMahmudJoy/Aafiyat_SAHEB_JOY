"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createDraftProduct, updateDraftProduct } from "@/lib/admin-product-drafts";
import { draftFields, type DraftFormState } from "@/lib/product-draft-validation";

function fields(data: FormData, editing: boolean) {
  const allowed = new Set<string>([...draftFields, ...(editing ? ["version"] : [])]);
  if ([...data.keys()].some(key => !allowed.has(key) && !key.startsWith("$ACTION_")) || [...allowed].some(key => data.getAll(key).length !== 1)) throw new Error("Invalid submission.");
  return Object.fromEntries(draftFields.map(key => [key, data.get(key)]));
}
function state(result: Awaited<ReturnType<typeof createDraftProduct>>): DraftFormState {
  if (result.ok) {
    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${result.productId}`);
    revalidatePath(`/admin/products/${result.productId}/edit`);
  }
  return result.ok ? { status: "saved", message: "Draft saved. It is not published.", fields: {}, productId: result.productId, version: result.version }
    : { status: "error", message: result.message, fields: result.fields, conflict: result.code === "CONFLICT" };
}
export async function createDraftAction(_previous: DraftFormState, data: FormData): Promise<DraftFormState> {
  try { return state(await createDraftProduct(await headers(), fields(data, false))); }
  catch { return { status: "error", message: "Unable to save. Check your session, permissions, and submission, then try again.", fields: {} }; }
}
export async function updateDraftAction(id: string, _previous: DraftFormState, data: FormData): Promise<DraftFormState> {
  try { return state(await updateDraftProduct(await headers(), id, data.get("version"), fields(data, true))); }
  catch { return { status: "error", message: "Unable to save. Check your session, permissions, and submission, then try again.", fields: {} }; }
}
