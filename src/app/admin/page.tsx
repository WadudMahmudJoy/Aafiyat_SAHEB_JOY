import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminEntry } from "@/lib/admin-entry";
import AdminSession from "./admin-session";

export const dynamic = "force-dynamic";
export default async function AdminPage() {
  let principal;
  try { principal = await requireAdminEntry(await headers()); }
  catch { redirect("/admin/login?reason=expired"); }
  return <AdminSession role={principal.role.replaceAll("_", " ").toLowerCase()} />;
}
