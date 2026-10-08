import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { prisma } from "@/lib/prisma";

// Request-local server state, never accepted from a client or inferred from JSON.
// Pinned 1.7.7: pending login consumes a challenge and sets newSession;
// enrollment has an existing session, and existing-session TOTP creates none.
export function sessionMfaProof(): BetterAuthPlugin {
  const pending = new WeakMap<object, { id: string; userId: string; factorId: string; startedAt: Date; challengeCreatedAt: Date }>();
  return {
    id: "aafiyat-session-mfa-proof",
    hooks: {
      before: [{
        matcher: ctx => ctx.path === "/two-factor/verify-totp",
        handler: createAuthMiddleware(async ctx => {
          const startedAt = new Date();
          if (await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true })) return;
          const name = ctx.context.createAuthCookie("two_factor").name;
          const identifier = await ctx.getSignedCookie(name, ctx.context.secret);
          if (!identifier || !/^2fa-[A-Za-z0-9_-]+$/.test(identifier)) return;
          const challenge = await ctx.context.internalAdapter.findVerificationValue(identifier);
          if (!challenge || challenge.expiresAt <= startedAt) return;
          const user = await prisma.user.findUnique({ where: { id: challenge.value }, select: { twoFactorEnabled: true } });
          const factor = await prisma.twoFactor.findFirst({ where: { userId: challenge.value, verified: true }, select: { id: true } });
          if (user?.twoFactorEnabled !== true || !factor) return;
          pending.set(ctx.context, { id: challenge.id, userId: challenge.value, factorId: factor.id, startedAt, challengeCreatedAt: challenge.createdAt });
        }),
      }],
      after: [{
        matcher: ctx => ctx.path === "/two-factor/verify-totp",
        handler: createAuthMiddleware(async ctx => {
          const challenge = pending.get(ctx.context);
          pending.delete(ctx.context);
          const issued = ctx.context.newSession;
          if (!challenge || isAPIError(ctx.context.returned) || !issued || ctx.context.session?.session) return;
          if (issued.user.id !== challenge.userId || issued.session.userId !== challenge.userId ||
              issued.session.createdAt < challenge.startedAt) return;
          // Framework successful TOTP + consumed server challenge + exact newly issued
          // session are all required. A cookie or enrollment flag alone proves nothing.
          const now = new Date();
          const written = await prisma.$transaction(async tx => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008, hashtext(${challenge.userId}))`;
            const membership = await tx.adminUser.findUnique({ where: { userId: challenge.userId }, include: { role: true } });
            if (membership?.active && membership.role.name === "OWNER" &&
                challenge.challengeCreatedAt <= membership.updatedAt) return false;
            if (await tx.verification.findUnique({ where: { id: challenge.id } })) return false;
            const factor = await tx.twoFactor.findFirst({ where: { id: challenge.factorId, userId: challenge.userId, verified: true } });
            const user = await tx.user.findUnique({ where: { id: challenge.userId }, select: { twoFactorEnabled: true } });
            if (!factor || user?.twoFactorEnabled !== true) return false;
            const result = await tx.session.updateMany({
              where: { id: issued.session.id, userId: challenge.userId, token: issued.session.token,
                createdAt: { gte: challenge.startedAt }, expiresAt: { gt: now }, mfaVerifiedAt: null },
              data: { mfaVerifiedAt: now },
            });
            return result.count === 1;
          });
          if (!written) {
            await prisma.session.deleteMany({ where: { id: issued.session.id, userId: challenge.userId,
              token: issued.session.token, mfaVerifiedAt: null } });
            ctx.context.setNewSession(null);
            throw new APIError("INTERNAL_SERVER_ERROR", {
              code: "MFA_PROOF_UNAVAILABLE", message: "Authentication could not be completed.",
            });
          }
        }),
      }],
    },
  };
}
