import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDraftEditor } from "@/lib/admin-product-drafts";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "../../admin-session";
import { CatalogueError } from "../catalogue-view";
import DraftForm from "../draft-form";
export const dynamic = "force-dynamic";
export default async function NewProductPage() {
  let editor;
  try { editor = await getDraftEditor(await headers()); }
  catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(error.reason === "PERMISSION_DENIED" ? "/admin/products" : "/admin/login?reason=expired");
    return <CatalogueError />;
  }
  return <AdminSession dashboard={editor.dashboard} currentPage="products"><DraftForm categories={editor.categories} truncated={editor.truncated} /></AdminSession>;
}
