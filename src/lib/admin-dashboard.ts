import "server-only";
import { requireAdminEntry } from "@/lib/admin-entry";
import { hasAdminPermission, type AdminPermission } from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";
import { requireAdminPermission } from "@/lib/admin-authorization";

const AREAS = [
  { id: "products", label: "Products and Inventory", description: "Care for the product catalog, variants and pricing.",
    features: [{ label: "Product catalog", permission: "catalog:read" }, { label: "Product management", permission: "catalog:write" }] },
  { id: "inventory", label: "Inventory", description: "Receive stock, reconcile physical counts and review the movement ledger.",
    features: [{ label: "Stock receiving", permission: "inventory:manage" }, { label: "Counted corrections", permission: "inventory:manage" }, { label: "Stock movement history", permission: "inventory:manage" }] },
  { id: "categories", label: "Categories", description: "Manage category metadata, ordering and public visibility.",
    features: [{ label: "Category administration", permission: "catalog:read" }] },
  { id: "orders", label: "Orders", description: "Keep customer orders moving with clarity and care.",
    features: [{ label: "Order history", permission: "orders:read" }, { label: "Order management", permission: "orders:manage" }] },
  { id: "customers", label: "Customers", description: "Review customer profiles and staff-only associated order history.",
    features: [{ label: "Customer support", permission: "orders:read" }] },
  { id: "marketing", label: "Marketing", description: "Shape the brand experience and future campaigns.",
    features: [{ label: "Offers and campaigns", permission: "marketing:manage" }, { label: "Content management", permission: "content:manage" }] },
  { id: "content", label: "Content", description: "Homepage, pages and size guides.", features: [{ label: "Content management", permission: "content:manage" }] },
  { id: "settings", label: "Business settings", description: "Shipping, consent and policy configuration.", features: [{ label: "Business settings", permission: "settings:manage" }] },
  { id: "staff", label: "Administrators", description: "Existing membership governance.", features: [{ label: "Administrator management", permission: "admins:manage" }] },
  { id: "audit", label: "Audit history", description: "Recorded administrative changes.", features: [{ label: "Activity auditing", permission: "audit:read" }] },
  { id: "administration", label: "Administration", description: "Manage business settings, staff access, and accountability.",
    features: [{ label: "Business settings", permission: "settings:manage" }, { label: "Administrator management", permission: "admins:manage" }, { label: "Activity auditing", permission: "audit:read" }] },
] satisfies { id: string; label: string; description: string; features: { label: string; permission: AdminPermission }[] }[];

// Policy projection only. The caller must use a server-authorized principal.
export function dashboardAreas(role: string) {
  return AREAS.map(area => ({ id: area.id, label: area.label, description: area.description,
    href: area.id === "products" ? "/admin/products" : area.id === "inventory" ? "/admin/inventory" : area.id === "categories" ? "/admin/categories" : area.id === "orders" ? "/admin/orders" : area.id === "customers" ? "/admin/customers" : area.id === "marketing" ? "/admin/marketing" : area.id === "settings" ? "/admin/settings" : area.id === "content" ? "/admin/content" : area.id === "staff" ? "/admin/staff" : area.id === "audit" ? "/admin/audit" : null,
    features: area.features.filter(feature => hasAdminPermission(role, feature.permission)).map(feature => feature.label),
  })).filter(area => area.features.length > 0);
}

// Uncached, request-bound authorization precedes every private identity lookup.
export async function getAdminDashboard(requestHeaders: Headers, permission?: AdminPermission) {
  const principal = permission ? await requireAdminPermission(permission, requestHeaders) : await requireAdminEntry(requestHeaders);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: principal.userId }, select: { name: true, email: true } });
  let newOrders: string | null | undefined;
  if (hasAdminPermission(principal.role, "orders:read")) {
    try { const [row] = await prisma.$queryRaw<{ count: string }[]>`SELECT count(*)::text AS count FROM orders WHERE accepted_at IS NOT NULL AND acknowledged_at IS NULL AND cancelled_at IS NULL AND fulfillment_status<>'cancelled'`; newOrders = row.count; }
    catch { newOrders = null; } // Unapplied foundation/unavailable DB never implies zero.
  }
  return { ...(newOrders === undefined ? {} : { newOrders }), identity: user, role: principal.role, roleLabel: principal.role.replaceAll("_", " ").toLowerCase(),
    areas: dashboardAreas(principal.role) };
}

export type AdminDashboardData = Awaited<ReturnType<typeof getAdminDashboard>>;
