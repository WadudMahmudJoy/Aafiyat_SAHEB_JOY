import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { auth } from "./auth";
import { requireAdminPermission } from "./admin-authorization";
import { STAFF_ROLES } from "./admin-governance";
import { strictBusinessFields } from "./business-rules";
import { identifier } from "./media-validation";
import { normalizeInvitationEmail, createInvitationSecret, invitationVerifier, sealInvitationSecret } from "./invitation-secrets";
import { invitationDeliveryConfig } from "./invitation-delivery-config";

export class InvitationPolicyError extends Error {
  constructor(message = "Invitation change denied. Check access, MFA and supplied fields.") { super(message); }
}
export type InvitationResult = { ok: boolean; message: string };
export const invitationTransactionOptions = { maxWait: 5000, timeout: 15000 };
export async function lockInvitationTransaction(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout='5s'`;
  // Same first lock as governance; no actor/row lock inversion with revocation.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(88009,1)`;
}
export async function invitationNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}
export async function expireInvitation(tx: Prisma.TransactionClient, id: string, actorId?: string, confirmedDelivery?: { hash: string; at: Date }) {
  const old = await tx.adminInvitation.findUniqueOrThrow({ where: { id } });
  if (!["pending","delivered"].includes(old.state)) return;
  await tx.adminInvitation.update({ where: { id }, data: { state: "expired", expiredAt: await invitationNow(tx), version: { increment: 1 }, deliveryCiphertext: null, leaseId: null, leaseUntil: null, deliveryState: confirmedDelivery || old.deliveredAt ? "delivered" : "cancelled", deliveredAt: confirmedDelivery?.at ?? old.deliveredAt, providerReceiptHash: confirmedDelivery?.hash ?? old.providerReceiptHash } });
  await tx.auditLog.create({ data: { actorId: actorId ?? old.invitedBy, action: "invitation.expire", entityId: id, summary: { state: "expired", kind: actorId ? "manual" : "automatic" } } });
}
function trustedOrigin(headers: Headers) {
  const base = auth.options.baseURL;
  if (typeof base !== "string" || headers.get("origin") !== new URL(base).origin || headers.get("sec-fetch-site") === "cross-site") throw new InvitationPolicyError();
}
function expectedVersion(raw: string) {
  if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) >= BigInt("9223372036854775807")) throw new InvitationPolicyError();
  return BigInt(raw);
}
export async function changeInvitation(headers: Headers, form: FormData): Promise<InvitationResult> {
  try {
    trustedOrigin(headers);
    const actor = await requireAdminPermission("admins:manage", headers);
    if (actor.role !== "OWNER") throw new InvitationPolicyError();
    const operation = form.get("operation");
    const fields = strictBusinessFields(form, operation === "create" ? ["operation","email","role"] : ["operation","id","version","confirm"]);
    if (!["create","revoke","expire"].includes(fields.operation)) throw new InvitationPolicyError();
    const email = operation === "create" ? normalizeInvitationEmail(fields.email) : null;
    if (operation === "create" && !STAFF_ROLES.includes(fields.role as typeof STAFF_ROLES[number])) throw new InvitationPolicyError("Choose an approved non-Owner role and a valid email.");
    const id = email ? randomUUID() : identifier(fields.id);
    const version = email ? null : expectedVersion(fields.version);
    if (!email && fields.confirm !== "CONFIRM") throw new InvitationPolicyError("Type CONFIRM to revoke or expire the invitation.");
    const delivery = email ? invitationDeliveryConfig() : null;
    await prisma.$transaction(async tx => {
      await lockInvitationTransaction(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008,hashtext(${actor.userId}))`;
      await tx.$queryRaw`SELECT id FROM admin_users WHERE id=${actor.adminUserId}::uuid FOR UPDATE`;
      const fresh = await requireAdminPermission("admins:manage", headers, tx);
      if (fresh.role !== "OWNER" || fresh.adminUserId !== actor.adminUserId) throw new InvitationPolicyError();
      const now = await invitationNow(tx);
      if (email) {
        // Refuse any existing identity, including inactive/unverified identities.
        // Email display matching never binds ownership or grants membership.
        if (await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } })) throw new InvitationPolicyError("This destination is unavailable for a new invitation.");
        const due = await tx.adminInvitation.findMany({ where: { email, state: { in: ["pending","delivered"] }, expiresAt: { lte: now } }, select: { id: true } });
        for (const row of due) await expireInvitation(tx, row.id);
        if (await tx.adminInvitation.findFirst({ where: { email, state: { in: ["pending","delivered"] } }, select: { id: true } })) throw new InvitationPolicyError("An active invitation already exists for this destination.");
        const hourAgo = new Date(now.getTime()-3600000);
        const [actorCount,totalCount] = await Promise.all([
          tx.adminInvitation.count({ where: { invitedBy: actor.adminUserId, createdAt: { gte: hourAgo } } }),
          tx.adminInvitation.count({ where: { createdAt: { gte: hourAgo } } }),
        ]);
        if (actorCount >= 10 || totalCount >= 100) throw new InvitationPolicyError("Invitation limit reached. Try again after the hourly window.");
        const secret = createInvitationSecret();
        await tx.adminInvitation.create({ data: {
          id, email, role: fields.role as typeof STAFF_ROLES[number], invitedBy: actor.adminUserId,
          tokenHash: invitationVerifier(secret), deliveryCiphertext: delivery?.key ? sealInvitationSecret(secret,id,delivery.key) : null,
          expiresAt: new Date(now.getTime()+48*3600000), createdAt: now,
          deliveryState: delivery?.key && delivery.endpoint ? "queued" : "unconfigured",
        } });
        await tx.auditLog.create({ data: { actorId: actor.adminUserId, action: "invitation.create", entityId: id, summary: { toRole: fields.role, state: "pending" } } });
      } else {
        await tx.$queryRaw`SELECT id FROM admin_invitations WHERE id=${id}::uuid FOR UPDATE`;
        const old = await tx.adminInvitation.findUnique({ where: { id } });
        if (!old || old.version !== version) throw new InvitationPolicyError("This invitation changed. Reload before trying again.");
        if (!["pending","delivered"].includes(old.state)) throw new InvitationPolicyError("This invitation is already terminal. Reload current data.");
        if (fields.operation === "expire" || old.expiresAt <= now) await expireInvitation(tx,id,actor.adminUserId);
        else {
          await tx.adminInvitation.update({ where: { id }, data: { state: "revoked", revokedAt: now, revokedBy: actor.adminUserId, version: { increment: 1 }, deliveryCiphertext: null, leaseId: null, leaseUntil: null, deliveryState: old.deliveredAt ? "delivered" : "cancelled" } });
          await tx.auditLog.create({ data: { actorId: actor.adminUserId, action: "invitation.revoke", entityId: id, summary: { state: "revoked" } } });
        }
      }
    }, invitationTransactionOptions);
    return { ok: true, message: email ? delivery?.key && delivery.endpoint ? "Invitation prepared. Pending delivery; provider confirmation has not been received." : "Invitation prepared. Delivery not configured. No message has been sent." : "Invitation closed. Reload to see its current status." };
  } catch (e) {
    return { ok: false, message: e instanceof InvitationPolicyError ? e.message : "Invitation change denied or unavailable. Check the email, access and configuration; reload current data." };
  }
}

export async function readInvitations(headers: Headers, cursor?: string, destination?: string) {
  const actor = await requireAdminPermission("admins:manage", headers);
  if (actor.role !== "OWNER") throw new InvitationPolicyError();
  const email = destination?.trim() ? normalizeInvitationEmail(destination) : "";
  const rows = await prisma.adminInvitation.findMany({ where: { ...(cursor ? { id: { gt: identifier(cursor) } } : {}), ...(email ? { email } : {}) }, orderBy: { id: "asc" }, take: 21,
    select: { id: true, email: true, role: true, state: true, deliveryState: true, expiresAt: true, createdAt: true, version: true, attempts: true } });
  const now = Date.now();
  return { rows: rows.slice(0,20).map(r => ({ ...r, version: r.version.toString(), expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString(), state: ["pending","delivered"].includes(r.state) && r.expiresAt.getTime() <= now ? "expired" : r.state })), nextCursor: rows.length > 20 ? rows[19].id : null, email };
}
