import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminProducts } from "@/lib/admin-catalog";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "../admin-session";
import { CatalogueError, CatalogueView } from "./catalogue-view";

export const dynamic = "force-dynamic";
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let catalogue;
  try { catalogue = await getAdminProducts(await headers(), await searchParams); }
  catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(error.reason === "PERMISSION_DENIED" ? "/admin" : "/admin/login?reason=expired");
    return <CatalogueError />;
  }
  return <AdminSession dashboard={catalogue.dashboard} currentPage="products"><CatalogueView catalogue={catalogue} /></AdminSession>;
}
