import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import { getInventoryDetail, InventoryReadError } from "@/lib/admin-inventory-read";
import AdminSession from "../../admin-session";
import { InventoryError, InventoryDetailView } from "../inventory-view";
export const dynamic = "force-dynamic";
export default async function InventoryVariantPage({ params, searchParams }: { params: Promise<{ variantId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let data;
  try { data = await getInventoryDetail(await headers(), (await params).variantId, (await searchParams).cursor); }
  catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(error.reason === "PERMISSION_DENIED" ? "/admin" : "/admin/login?reason=expired");
    if (error instanceof InventoryReadError && error.code === "NOT_FOUND") notFound();
    return <InventoryError invalid={error instanceof InventoryReadError} />;
  }
  return <AdminSession dashboard={data.dashboard} currentPage="inventory"><InventoryDetailView data={data} /></AdminSession>;
}
