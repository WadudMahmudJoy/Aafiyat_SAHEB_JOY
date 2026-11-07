import "server-only";
import { isAPIError } from "better-auth/api";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "./auth";
import { STAFF_ROLES } from "./admin-governance";
import { invitationNow, invitationTransactionOptions, lockInvitationTransaction } from "./admin-invitations";
import { prisma } from "./prisma";
import { withStaffEnrollment } from "./staff-enrollment-scope";

const recentPasswordMs = 5 * 60_000;
const retryDelayMs = 15 * 60_000;
const denied = { ok: false, stage: "unavailable", message: "This account cannot continue onboarding. The invitation may have expired or been revoked. Contact the inviting administrator." } as const;
const signIn = { ok: false, stage: "sign_in", message: "Sign in with your invited email and password to continue." } as const;
const completed = { ok: true, stage: "completed", message: "Your staff membership is active. Sign in again with your password and authenticator code to open administration." } as const;
const ready = { ok: true, stage: "setup", message: "Confirm your password to open the authenticator setup key." } as const;
const pending = { ok: true, stage: "verify", message: "Use your authenticator app to verify and activate your staff membership." } as const;
const badCode = { ...pending, ok: false, message: "The authenticator code was incorrect or expired. Try the current code." } as const;
const locked = { ...pending, ok: false, message: "Too many authenticator attempts. Wait 15 minutes, then sign in again to continue." } as const;

type Operation = { operation: "status" } | { operation: "setup"; password: string } | { operation: "activate"; code: string };
type Status = typeof denied | typeof signIn | typeof completed | typeof ready | typeof pending | typeof badCode | typeof locked;
type Result = Status | (typeof pending & { setupKey: string }) | { ok: false; message: string };
type Envelope = { result: Result; clearCookies?: boolean };

const binding = {
  invitation: true,
  member: { include: { role: true } },
  user: { select: { email: true, emailVerified: true, twoFactorEnabled: true, twofactors: { select: { id: true, verified: true } } } },
} satisfies Prisma.AdminOnboardingInclude;
type Onboarding = Prisma.AdminOnboardingGetPayload<{ include: typeof binding }>;

function eligible(row: Onboarding, userId: string, now: Date) {
  const { invitation, user, member } = row;
  return row.state === "provisioned" && row.userId === userId && !!row.provisionedAt &&
    !!row.verifiedChallengeId && !!row.mailboxVerifiedAt && !!member && member.userId === userId &&
    member.id === row.membershipId && !member.active && member.disabledAt === null &&
    invitation.state === "delivered" && invitation.deliveryState === "delivered" && !!invitation.deliveredAt &&
    !!invitation.providerReceiptHash && !invitation.consumedAt && invitation.expiresAt > now &&
    invitation.role === member.role.name && STAFF_ROLES.some(role => role === invitation.role) &&
    !!user?.emailVerified && user.email === invitation.email && user.twoFactorEnabled === false &&
    (row.enrollmentFactorId
      ? user.twofactors.length === 1 && user.twofactors[0].id === row.enrollmentFactorId && user.twofactors[0].verified === false
      : user.twofactors.length === 0);
}

function recentSession(session: { createdAt: Date; expiresAt: Date }, row: Onboarding, now: Date) {
  const created = session.createdAt.getTime();
  return session.expiresAt > now && created <= now.getTime() && now.getTime() - created <= recentPasswordMs &&
    !!row.member && session.createdAt > row.member.authorizationNotBefore;
}

function setupKey(uri: string) {
  const url = new URL(uri);
  const secret = url.searchParams.get("secret");
  if (url.protocol !== "otpauth:" || url.hostname !== "totp" || !secret || !/^[A-Z2-7]{20,128}$/i.test(secret)) {
    throw new Error("Invalid authenticator setup.");
  }
  return secret;
}

async function revokeEnrollmentSessions(tx: Prisma.TransactionClient, userId: string) {
  const challenges = await tx.verification.findMany({
    where: { value: userId, identifier: { startsWith: "2fa-" } },
    select: { identifier: true },
  });
  const identifiers = challenges.flatMap(({ identifier }) => [identifier, `2fa-attempts-${identifier}`]);
  if (identifiers.length) await tx.verification.deleteMany({ where: { identifier: { in: identifiers } } });
  return (await tx.session.deleteMany({ where: { userId } })).count;
}

export async function staffActivation(headers: Headers, input: Operation): Promise<Envelope> {
  try {
    if (headers.get("origin") !== auth.options.baseURL || headers.get("sec-fetch-site") === "cross-site") return { result: denied };
    const actor = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
    if (!actor || actor.session.userId !== actor.user.id) return { result: signIn };
    const userId = actor.user.id;

    if (input.operation === "status") {
      const row = await prisma.adminOnboarding.findUnique({ where: { userId }, include: binding });
      if (row?.state === "completed" && row.invitation.state === "consumed" &&
        row.invitation.consumedUserId === userId && row.member?.active) return { result: completed };
      const now = new Date();
      if (!row || !eligible(row, userId, now)) return { result: denied };
      if (!recentSession(actor.session, row, now)) return { result: signIn };
      return { result: row.enrollmentFactorId ? pending : ready };
    }

    return await prisma.$transaction(async tx => {
      await lockInvitationTransaction(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008,hashtext(${userId}))`;
      const found = await tx.adminOnboarding.findUnique({ where: { userId }, select: { id: true, invitationId: true, membershipId: true } });
      if (!found?.membershipId) return { result: denied };
      await tx.$queryRaw`SELECT id FROM admin_users WHERE id=${found.membershipId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM admin_invitations WHERE id=${found.invitationId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM admin_onboarding WHERE id=${found.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id=${actor.session.id} FOR UPDATE`;
      const row = await tx.adminOnboarding.findUniqueOrThrow({ where: { id: found.id }, include: binding });
      const session = await tx.session.findUnique({ where: { id: actor.session.id } });
      const now = await invitationNow(tx);
      if (!eligible(row, userId, now)) return { result: denied };
      if (!session || session.userId !== userId || session.token !== actor.session.token ||
        session.mfaVerifiedAt !== null || !recentSession(session, row, now)) return { result: signIn };
      const scope = { tx, userId, sessionId: session.id };

      if (input.operation === "setup") {
        const confirmSetupWindow = async () => {
          const finished = await invitationNow(tx);
          if (row.invitation.expiresAt <= finished || !recentSession(session, row, finished)) {
            throw new Error("Enrollment expired.");
          }
        };
        if (row.enrollmentFactorId) {
          const response = await withStaffEnrollment({ ...scope, path: "/two-factor/get-totp-uri" },
            () => auth.api.getTOTPURI({ headers, body: { password: input.password } }));
          await confirmSetupWindow();
          return { result: { ...pending, setupKey: setupKey(response.totpURI) } };
        }
        const response = await withStaffEnrollment({ ...scope, path: "/two-factor/enable" },
          () => auth.api.enableTwoFactor({ headers, body: { password: input.password, method: "totp" } }));
        const factor = await tx.twoFactor.findMany({ where: { userId }, select: { id: true, verified: true } });
        if (!("totpURI" in response) || !response.totpURI || factor.length !== 1 || factor[0].verified !== false) {
          throw new Error("Unexpected enrollment state.");
        }
        const secret = setupKey(response.totpURI);
        await tx.adminOnboarding.update({
          where: { id: row.id },
          data: { enrollmentFactorId: factor[0].id, enrollmentStartedAt: now, version: { increment: 1 } },
        });
        await tx.auditLog.create({ data: { actorId: found.membershipId, action: "onboarding.enroll", entityId: row.id, summary: { state: "pending" } } });
        await confirmSetupWindow();
        return { result: { ...pending, setupKey: secret } };
      }

      if (!row.enrollmentFactorId) return { result: ready };
      if (row.enrollmentLockedUntil && row.enrollmentLockedUntil > now) return { result: locked };
      try {
        await withStaffEnrollment({ ...scope, path: "/two-factor/verify-totp" },
          () => auth.api.verifyTOTP({ headers, body: { code: input.code } }));
      } catch (error) {
        if (!isAPIError(error) || error.body?.code !== "INVALID_CODE") throw error;
        const failures = row.enrollmentLockedUntil ? 1 : row.enrollmentFailures + 1;
        await tx.adminOnboarding.update({
          where: { id: row.id },
          data: { enrollmentFailures: failures, enrollmentLockedUntil: failures === 5 ? new Date(now.getTime() + retryDelayMs) : null, version: { increment: 1 } },
        });
        return { result: failures === 5 ? locked : badCode };
      }
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId }, select: { twoFactorEnabled: true, twofactors: { select: { id: true, verified: true } } },
      });
      if (!user.twoFactorEnabled || user.twofactors.length !== 1 ||
        user.twofactors[0].id !== row.enrollmentFactorId || user.twofactors[0].verified !== true ||
        await tx.session.findUnique({ where: { id: session.id }, select: { id: true } })) {
        throw new Error("Unexpected authenticator verification state.");
      }

      const activatedAt = await invitationNow(tx);
      if (row.invitation.expiresAt <= activatedAt || !recentSession(session, row, activatedAt)) throw new Error("Activation expired.");
      await tx.adminInvitation.update({
        where: { id: row.invitationId },
        data: { state: "consumed", consumedUserId: userId, consumedAt: activatedAt, version: { increment: 1 } },
      });
      await tx.$executeRaw`UPDATE admin_users SET active=true,
        governance_version=governance_version+1,
        authorization_not_before=GREATEST(clock_timestamp(),authorization_not_before+interval '1 millisecond'),
        updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
        WHERE id=${found.membershipId}::uuid`;
      const revokedSessions = await revokeEnrollmentSessions(tx, userId);
      await tx.adminOnboarding.update({
        where: { id: row.id },
        data: { state: "completed", activatedAt, enrollmentFailures: 0, enrollmentLockedUntil: null, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: { actorId: found.membershipId, action: "onboarding.activate", entityId: row.id, summary: { state: "completed", toRole: row.invitation.role, revokedSessions } },
      });
      return { result: completed, clearCookies: true };
    }, invitationTransactionOptions);
  } catch {
    return { result: { ok: false, message: "Onboarding could not continue. Check your password or try again. If the invitation is unavailable, contact the inviting administrator." } };
  }
}
