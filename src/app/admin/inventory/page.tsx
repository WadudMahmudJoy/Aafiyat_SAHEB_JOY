import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import { getInventoryOverview, InventoryReadError } from "@/lib/admin-inventory-read";
import AdminSession from "../admin-session";
import { InventoryError, InventoryOverviewView } from "./inventory-view";
export const dynamic = "force-dynamic";
export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let data;
  try { data = await getInventoryOverview(await headers(), await searchParams); }
  catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(error.reason === "PERMISSION_DENIED" ? "/admin" : "/admin/login?reason=expired");
    return <InventoryError invalid={error instanceof InventoryReadError} />;
  }
  return <AdminSession dashboard={data.dashboard} currentPage="inventory"><InventoryOverviewView data={data} /></AdminSession>;
}
