import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { prisma } from "@/lib/prisma";
import { sessionMfaProof } from "@/lib/session-mfa-proof";
import { currentLocalOwnerEnrollment } from "@/lib/local-owner-enrollment-scope";
import { authPrisma, currentStaffEnrollment } from "@/lib/staff-enrollment-scope";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32 || secret.startsWith("<")) {
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 random characters.");
}

const configuredUrl = process.env.BETTER_AUTH_URL;
if (!configuredUrl) {
  throw new Error("BETTER_AUTH_URL is required for authentication.");
}
let baseUrl: URL;
try {
  baseUrl = new URL(configuredUrl);
} catch {
  throw new Error("BETTER_AUTH_URL must be a valid authentication origin.");
}
const localDevelopment =
  process.env.NODE_ENV !== "production" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
if (
  baseUrl.username ||
  baseUrl.password ||
  baseUrl.search ||
  baseUrl.hash ||
  baseUrl.pathname !== "/" ||
  (baseUrl.protocol !== "https:" && !(localDevelopment && baseUrl.protocol === "http:"))
) {
  throw new Error("BETTER_AUTH_URL must be an HTTPS origin, or a local development HTTP origin.");
}

// Only identity/session and TOTP foundation endpoints; signup still rejects below.
const allowedPaths = new Set([
  "/sign-in/email", "/sign-up/email", "/get-session", "/sign-out",
  "/two-factor/verify-totp",
]);

export const auth = betterAuth({
  appName: "Aafiyat",
  baseURL: baseUrl.origin,
  secret,
  trustedOrigins: [baseUrl.origin],
  logger: { disabled: true }, // Never emit raw auth/adapter exceptions or request data.
  rateLimit: { enabled: true },
  database: prismaAdapter(authPrisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  advanced: {
    useSecureCookies: baseUrl.protocol === "https:",
    disableOriginCheck: false,
    disableCSRFCheck: false,
  },
  session: {
    cookieCache: { enabled: false },
    additionalFields: {
      mfaVerifiedAt: { type: "date", required: false, defaultValue: null, input: false, returned: false },
    },
  },
  databaseHooks: {
    session: { create: { before: async session => ({ data: { ...session, mfaVerifiedAt: null } }) } },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      let controlledEnrollment = false;
      const localScope = currentLocalOwnerEnrollment();
      const staffScope = currentStaffEnrollment();
      if (staffScope || ctx.path === "/two-factor/verify-totp") {
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true });
        if (staffScope) {
          controlledEnrollment = ctx.path === staffScope.path &&
            ctx.headers?.get("origin") === baseUrl.origin &&
            session?.user.id === staffScope.userId && session.session.id === staffScope.sessionId;
          if (!controlledEnrollment) throw new APIError("FORBIDDEN", { message: "Enrollment access denied." });
        } else if (session) {
          // The public TOTP route handles login challenges. An inactive invited
          // staff member must verify a pending factor in the activation transaction.
          const member = await prisma.adminUser.findUnique({
            where: { userId: session.user.id },
            select: { active: true, role: { select: { name: true } } },
          });
          if (member && !member.active && member.role.name !== "OWNER") {
            throw new APIError("FORBIDDEN", { message: "Use staff onboarding to verify enrollment." });
          }
        }
      }
      if (["/two-factor/enable", "/two-factor/get-totp-uri"].includes(ctx.path ?? "") && localScope && localDevelopment) {
        const url = new URL(process.env.DATABASE_URL ?? "");
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true });
        const member = await prisma.adminUser.findUnique({ where: { userId: localScope.userId }, include: { role: true } });
        controlledEnrollment = url.hostname === "127.0.0.1" && url.port === "55432" && url.pathname === "/aafiyat_dev" &&
          session?.user.id === localScope.userId && session.session.id === localScope.sessionId &&
          member?.role.name === "OWNER" && member.active === false && member.disabledAt === null;
      }
      if (!allowedPaths.has(ctx.path ?? "") && !controlledEnrollment) {
        throw new APIError("NOT_FOUND", { code: "AUTH_PATH_DISABLED", message: "Not Found" });
      }
      const trustCookieName = ctx.context.createAuthCookie("trust_device").name;
      const trustCookie = ctx.getCookie(trustCookieName);
      const hasTrustCookieHeader = ctx.headers?.get("cookie")?.split(";").some(
        cookie => cookie.split("=", 1)[0].trim() === trustCookieName,
      );
      // Guard both creation and reuse; a short cookie lifetime alone cannot disable bypass.
      if (ctx.body?.trustDevice === true || hasTrustCookieHeader || (trustCookie !== null && trustCookie !== undefined)) {
        throw new APIError("FORBIDDEN", {
          code: "TRUSTED_DEVICE_DISABLED", message: "Trusted-device authentication is disabled.",
        });
      }
    }),
  },
  plugins: [
    twoFactor({
      issuer: "Aafiyat",
      skipVerificationOnEnable: false,
      allowPasswordless: false,
      backupCodeOptions: { storeBackupCodes: "encrypted" },
    }),
    sessionMfaProof(),
  ],
});
