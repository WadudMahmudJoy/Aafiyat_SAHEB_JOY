import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getVariantEditor, VariantWriteError } from "@/lib/admin-product-variants";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "../admin-session";
import { CatalogueError } from "./catalogue-view";
import VariantForm from "./variant-form";
export default async function VariantEditor({ productId, variantId }: { productId: string; variantId?: string }) {
  let editor;
  try { editor = await getVariantEditor(await headers(), productId, variantId); }
  catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(error.reason === "PERMISSION_DENIED" ? "/admin/products" : "/admin/login?reason=expired");
    if (error instanceof VariantWriteError && error.code === "NOT_FOUND") notFound();
    return <CatalogueError message={error instanceof VariantWriteError ? error.message : undefined} />;
  }
  return <AdminSession dashboard={editor.dashboard} currentPage="products"><VariantForm productId={editor.product.id} productName={editor.product.name} variantId={editor.variant?.id} version={editor.variant?.version} values={editor.variant?.values} /></AdminSession>;
}
