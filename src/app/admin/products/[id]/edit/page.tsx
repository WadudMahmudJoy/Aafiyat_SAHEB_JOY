import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getDraftEditor, DraftWriteError } from "@/lib/admin-product-drafts";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "../../../admin-session";
import { CatalogueError } from "../../catalogue-view";
import DraftForm from "../../draft-form";
export const dynamic = "force-dynamic";
export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  let editor;
  try { editor = await getDraftEditor(await headers(), (await params).id); }
  catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(error.reason === "PERMISSION_DENIED" ? "/admin/products" : "/admin/login?reason=expired");
    if (error instanceof DraftWriteError && error.code === "NOT_FOUND") notFound();
    return <CatalogueError message={error instanceof DraftWriteError ? error.message : undefined} />;
  }
  const product = editor.product!;
  return <AdminSession dashboard={editor.dashboard} currentPage="products"><p><a href={`/admin/products/${product.id}/media`}>Manage images and publishing →</a></p><DraftForm productId={product.id} version={product.version} values={{ name: product.name, categoryId: product.categoryId, slug: product.slug, description: product.description, seoTitle: product.seoTitle, seoDescription: product.seoDescription }} categories={editor.categories} truncated={editor.truncated} /></AdminSession>;
}
