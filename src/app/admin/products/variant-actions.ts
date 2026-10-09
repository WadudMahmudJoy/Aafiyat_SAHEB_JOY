"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { saveDraftVariant } from "@/lib/admin-product-variants";
import { variantFields, validDraftVersion, type VariantFormState } from "@/lib/variant-validation";
export async function saveVariantAction(productId: string, variantId: string | null, _previous: VariantFormState, data: FormData): Promise<VariantFormState> {
  let version: string | undefined;
  try {
    const submittedVersion = data.get("version");
    version = validDraftVersion(submittedVersion) ? submittedVersion : undefined;
    const allowed = new Set<string>([...variantFields, ...(variantId ? ["version"] : [])]);
    if ([...data.keys()].some(key => !allowed.has(key) && !key.startsWith("$ACTION_")) || [...allowed].some(key => data.getAll(key).length !== 1)) throw new Error("Invalid submission.");
    const result = await saveDraftVariant(await headers(), productId, variantId, data.get("version"), Object.fromEntries(variantFields.map(key => [key, data.get(key)])));
    if (!result.ok) return { status: "error", message: result.message, fields: result.fields, version, conflict: result.code === "CONFLICT" };
    revalidatePath("/admin/products"); revalidatePath(`/admin/products/${productId.toLowerCase()}`); revalidatePath(`/admin/products/${productId.toLowerCase()}/variants/${result.variantId}/edit`);
    return { status: "saved", message: "Variant saved. The product remains a private draft; inventory is unchanged.", fields: {}, variantId: result.variantId, version: result.version };
  } catch { return { status: "error", message: "Unable to save. Check your session, permissions, and submission, then try again.", fields: {}, version }; }
}
