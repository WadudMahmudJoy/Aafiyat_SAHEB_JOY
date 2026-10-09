import "server-only";
import { requireAdminEntry } from "@/lib/admin-entry";
import { hasAdminPermission, type AdminPermission } from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";
import { requireAdminPermission } from "@/lib/admin-authorization";

const AREAS = [
  { id: "products", label: "Products and Inventory", description: "Care for the catalog, from product details to stock.",
    features: [{ label: "Product catalog", permission: "catalog:read" }, { label: "Product management", permission: "catalog:write" }, { label: "Inventory management", permission: "inventory:manage" }] },
  { id: "orders", label: "Orders", description: "Keep customer orders moving with clarity and care.",
    features: [{ label: "Order history", permission: "orders:read" }, { label: "Order management", permission: "orders:manage" }] },
  { id: "marketing", label: "Marketing", description: "Shape the brand experience and future campaigns.",
    features: [{ label: "Offers and campaigns", permission: "marketing:manage" }, { label: "Content management", permission: "content:manage" }] },
  { id: "administration", label: "Administration", description: "Manage business settings, staff access, and accountability.",
    features: [{ label: "Business settings", permission: "settings:manage" }, { label: "Administrator management", permission: "admins:manage" }, { label: "Activity auditing", permission: "audit:read" }] },
] satisfies { id: string; label: string; description: string; features: { label: string; permission: AdminPermission }[] }[];

// Policy projection only. The caller must use a server-authorized principal.
export function dashboardAreas(role: string) {
  return AREAS.map(area => ({ id: area.id, label: area.label, description: area.description,
    href: area.id === "products" ? "/admin/products" : null,
    features: area.features.filter(feature => hasAdminPermission(role, feature.permission)).map(feature => feature.label),
  })).filter(area => area.features.length > 0);
}

// Uncached, request-bound authorization precedes every private identity lookup.
export async function getAdminDashboard(requestHeaders: Headers, permission?: AdminPermission) {
  const principal = permission ? await requireAdminPermission(permission, requestHeaders) : await requireAdminEntry(requestHeaders);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: principal.userId }, select: { name: true, email: true } });
  return { identity: user, role: principal.role, roleLabel: principal.role.replaceAll("_", " ").toLowerCase(),
    areas: dashboardAreas(principal.role) };
}

export type AdminDashboardData = Awaited<ReturnType<typeof getAdminDashboard>>;
