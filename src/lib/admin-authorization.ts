import "server-only";
import type { AdminRoleName } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasAdminPermission, type AdminPermission } from "@/lib/admin-permissions";

type DenialReason =
  | "UNAUTHENTICATED"
  | "ADMIN_MEMBERSHIP_REQUIRED"
  | "ADMIN_DISABLED"
  | "PERMISSION_DENIED"
  | "MFA_NOT_VERIFIED"
  | "AUTHORIZATION_UNAVAILABLE";

export class AdminAuthorizationError extends Error {
  constructor(public readonly reason: DenialReason) {
    super("Admin access denied.");
    this.name = "AdminAuthorizationError";
  }
}

type AdminPrincipal = {
  adminUserId: string;
  userId: string;
  role: AdminRoleName;
};

// Conservative server policy: session refresh cannot extend MFA assurance forever.
// Changing this limit requires a separate security-policy review.
const MAX_MFA_PROOF_AGE_MS = 12 * 60 * 60 * 1000;

// Call on the server with the current request's headers; never accept a role,
// membership, or session object supplied by a caller. Do not cache this result.
export async function requireAdminPermission(
  permission: AdminPermission,
  requestHeaders: Headers,
): Promise<AdminPrincipal> {
  let authenticated;
  try {
    authenticated = await auth.api.getSession({
      headers: requestHeaders,
      query: { disableCookieCache: true, disableRefresh: true },
    });
  } catch {
    throw new AdminAuthorizationError("AUTHORIZATION_UNAVAILABLE");
  }

  const expiresAt = authenticated?.session.expiresAt.getTime() ?? NaN;
  if (
    !authenticated ||
    !authenticated.session.id ||
    !authenticated.user.id ||
    authenticated.session.userId !== authenticated.user.id ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    throw new AdminAuthorizationError("UNAUTHENTICATED");
  }

  let admin;
  try {
    admin = await prisma.adminUser.findUnique({
      where: { userId: authenticated.user.id },
      select: {
        id: true, userId: true, active: true, disabledAt: true,
        role: { select: { name: true } },
      },
    });
  } catch {
    throw new AdminAuthorizationError("AUTHORIZATION_UNAVAILABLE");
  }
  if (!admin) throw new AdminAuthorizationError("ADMIN_MEMBERSHIP_REQUIRED");
  if (!admin.active || admin.disabledAt !== null) {
    throw new AdminAuthorizationError("ADMIN_DISABLED");
  }
  if (!hasAdminPermission(admin.role.name, permission)) {
    throw new AdminAuthorizationError("PERMISSION_DENIED");
  }
  let current;
  try {
    current = await prisma.session.findUnique({
      where: { id: authenticated.session.id },
      select: {
        id: true, userId: true, token: true, createdAt: true, expiresAt: true, mfaVerifiedAt: true,
        user: { select: { twoFactorEnabled: true, twofactors: { select: { verified: true } } } },
      },
    });
  } catch {
    throw new AdminAuthorizationError("AUTHORIZATION_UNAVAILABLE");
  }
  const now = Date.now();
  if (!current || current.id !== authenticated.session.id || current.userId !== authenticated.user.id ||
      current.token !== authenticated.session.token || !Number.isFinite(current.expiresAt.getTime()) ||
      current.expiresAt.getTime() <= now || current.createdAt.getTime() !== authenticated.session.createdAt.getTime()) {
    throw new AdminAuthorizationError("UNAUTHENTICATED");
  }
  const proof = current.mfaVerifiedAt?.getTime() ?? NaN;
  const created = current.createdAt.getTime();
  if (!Number.isFinite(created) || created > now || !Number.isFinite(proof) || proof < created ||
      proof > now || now - proof > MAX_MFA_PROOF_AGE_MS || proof >= current.expiresAt.getTime() || current.user.twoFactorEnabled !== true ||
      current.user.twofactors.length !== 1 || current.user.twofactors[0].verified !== true) {
    throw new AdminAuthorizationError("MFA_NOT_VERIFIED");
  }

  return { adminUserId: admin.id, userId: admin.userId, role: admin.role.name };
}
