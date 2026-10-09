import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminDashboard } from "@/lib/admin-dashboard";
import AdminSession from "./admin-session";

export const dynamic = "force-dynamic";
export default async function AdminPage() {
  let dashboard;
  try { dashboard = await getAdminDashboard(await headers()); }
  catch { redirect("/admin/login?reason=expired"); }
  return <AdminSession dashboard={dashboard} />;
}
