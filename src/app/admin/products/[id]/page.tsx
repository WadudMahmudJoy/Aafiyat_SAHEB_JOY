import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getAdminProduct } from "@/lib/admin-catalog";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "../../admin-session";
import { CatalogueError, ProductDetailView } from "../catalogue-view";

export const dynamic = "force-dynamic";
export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let detail;
  try { detail = await getAdminProduct(await headers(), (await params).id, (await searchParams).cursor); }
  catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(error.reason === "PERMISSION_DENIED" ? "/admin" : "/admin/login?reason=expired");
    return <CatalogueError />;
  }
  if (!detail.product && !detail.error) notFound();
  return <AdminSession dashboard={detail.dashboard} currentPage="products"><ProductDetailView detail={detail} /></AdminSession>;
}
