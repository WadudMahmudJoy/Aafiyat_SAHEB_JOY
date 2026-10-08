import "server-only";
import type { AdminRoleName } from "@/generated/prisma/client";

export const ADMIN_PERMISSIONS = [
  "catalog:read", "catalog:write", "inventory:manage", "orders:read",
  "orders:manage", "marketing:manage", "content:manage", "settings:manage",
  "admins:manage", "audit:read",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

// Explicit grants: no wildcard, client claims, or database-defined permission strings.
const ROLE_PERMISSIONS = {
  OWNER: [
    "catalog:read", "catalog:write", "inventory:manage", "orders:read",
    "orders:manage", "marketing:manage", "content:manage", "settings:manage",
    "admins:manage", "audit:read",
  ],
  PRODUCT_MANAGER: ["catalog:read", "catalog:write", "inventory:manage"],
  ORDER_MANAGER: ["orders:read", "orders:manage"],
  MARKETING_MANAGER: ["catalog:read", "marketing:manage", "content:manage"],
} satisfies Record<AdminRoleName, readonly AdminPermission[]>;

// Policy lookup only; this does not authenticate or authorize a request by itself.
export function hasAdminPermission(role: string, permission: string): boolean {
  return Object.hasOwn(ROLE_PERMISSIONS, role) &&
    (ROLE_PERMISSIONS[role as AdminRoleName] as readonly string[]).includes(permission);
}
