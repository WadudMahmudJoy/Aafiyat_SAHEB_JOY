import "server-only";
import { AdminAuthorizationError, requireAdminPermission } from "@/lib/admin-authorization";

// Every existing reference role has one of these read permissions. No new grants.
export async function requireAdminEntry(headers: Headers) {
  try { return await requireAdminPermission("catalog:read", headers); }
  catch (error) {
    if (!(error instanceof AdminAuthorizationError) || error.reason !== "PERMISSION_DENIED") throw error;
    return requireAdminPermission("orders:read", headers);
  }
}
