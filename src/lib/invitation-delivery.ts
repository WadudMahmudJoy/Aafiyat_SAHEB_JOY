import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma";
import { expireInvitation, invitationNow, invitationTransactionOptions, lockInvitationTransaction } from "./admin-invitations";
import { invitationDeliveryConfig } from "./invitation-delivery-config";
import { invitationVerifier, openInvitationSecret } from "./invitation-secrets";
import type { AdminInvitation, Prisma } from "@/generated/prisma/client";

async function receipt(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Provider did not confirm acceptance.");
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { done,value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) throw new Error("Invalid provider confirmation."); chunks.push(value); }
  } finally { await reader.cancel(); }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (data.accepted !== true || typeof data.messageId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(data.messageId)) throw new Error("Invalid provider confirmation.");
  return createHash("sha256").update("invitation-provider-receipt:v1\0").update(data.messageId).digest("hex");
}

// Shared finalization for real HTTP delivery and deterministic delayed-receipt
// probes. The caller holds the governance advisory lock and invitation row lock.
export async function recordInvitationDelivery(tx: Prisma.TransactionClient, row: AdminInvitation, receiptHash: string | null, lastError: string) {
  const finished = await invitationNow(tx);
  if (row.expiresAt <= finished) {
    await expireInvitation(tx,row.id,undefined,receiptHash ? { hash: receiptHash, at: finished } : undefined);
    if (receiptHash) await tx.auditLog.create({ data: { actorId: row.invitedBy, action: "invitation.delivery", entityId: row.id, summary: { kind: "worker", state: "delivered", attempts: row.attempts } } });
    return { status: "expired", id: row.id };
  }
  const status = receiptHash ? "delivered" : "failed";
  const updated = await tx.adminInvitation.update({ where: { id: row.id }, data: {
    version: { increment: 1 }, state: receiptHash ? "delivered" : "pending", deliveryState: status,
    deliveredAt: receiptHash ? finished : null, providerReceiptHash: receiptHash, leaseId: null, leaseUntil: null,
    deliveryCiphertext: receiptHash || row.attempts >= 5 ? null : row.deliveryCiphertext,
    lastError: receiptHash ? null : row.attempts >= 5 ? "attempts_exhausted" : lastError,
    nextAttemptAt: new Date(finished.getTime()+Math.min(3600000,30000*2**row.attempts)),
  } });
  // The database guard also handles expiry between the above clock read and UPDATE.
  if (updated.state === "expired") await tx.auditLog.create({ data: { actorId: row.invitedBy, action: "invitation.expire", entityId: row.id, summary: { kind: "automatic", state: "expired" } } });
  await tx.auditLog.create({ data: { actorId: row.invitedBy, action: "invitation.delivery", entityId: row.id, summary: { kind: "worker", state: status, attempts: row.attempts } } });
  return { status: updated.state === "expired" ? "expired" : status, id: row.id };
}

// Operator worker only: no browser action, public endpoint, signup or redemption.
// Durable bounded claims plus a final row lock prevent stale workers from sending.
export async function deliverNextInvitation(): Promise<{ status: string; id?: string }> {
  try {
    const config = invitationDeliveryConfig();
    const claim = await prisma.$transaction(async tx => {
      await lockInvitationTransaction(tx);
      const now = await invitationNow(tx);
      const due = await tx.adminInvitation.findMany({ where: { state: { in: ["pending","delivered"] }, expiresAt: { lte: now } }, take: 20, orderBy: { expiresAt: "asc" }, select: { id: true } });
      for (const row of due) await expireInvitation(tx,row.id);
      if (!config.endpoint || !config.key) return null;
      const exhausted = await tx.adminInvitation.findMany({ where: { state: "pending", deliveryState: "sending", attempts: 5, leaseUntil: { lte: now } }, take: 20 });
      for (const row of exhausted) {
        await tx.adminInvitation.update({ where: { id: row.id }, data: { version: { increment: 1 }, deliveryState: "failed", deliveryCiphertext: null, leaseId: null, leaseUntil: null, lastError: "attempts_exhausted" } });
        await tx.auditLog.create({ data: { actorId: row.invitedBy, action: "invitation.delivery", entityId: row.id, summary: { kind: "worker", state: "failed", attempts: row.attempts } } });
      }
      const row = await tx.adminInvitation.findFirst({ where: { state: "pending", deliveryCiphertext: { not: null }, attempts: { lt: 5 }, expiresAt: { gt: new Date(now.getTime()+5000) }, nextAttemptAt: { lte: now }, OR: [{ deliveryState: { in: ["queued","failed","unconfigured"] } },{ deliveryState: "sending", leaseUntil: { lte: now } }] }, orderBy: [{ nextAttemptAt: "asc" },{ id: "asc" }] });
      if (!row) return null;
      const lease = randomUUID();
      await tx.adminInvitation.update({ where: { id: row.id }, data: { version: { increment: 1 }, attempts: { increment: 1 }, deliveryState: "sending", leaseId: lease, leaseUntil: new Date(now.getTime()+30000), lastError: null } });
      await tx.auditLog.create({ data: { actorId: row.invitedBy, action: "invitation.delivery", entityId: row.id, summary: { kind: "worker", state: "sending", attempts: row.attempts+1 } } });
      return { id: row.id, lease };
    }, invitationTransactionOptions);
    if (!claim) return { status: config.key && config.endpoint ? "idle" : "unconfigured" };
    return await prisma.$transaction(async tx => {
      await lockInvitationTransaction(tx);
      await tx.$queryRaw`SELECT id FROM admin_invitations WHERE id=${claim.id}::uuid FOR UPDATE`;
      const row = await tx.adminInvitation.findUniqueOrThrow({ where: { id: claim.id } });
      const now = await invitationNow(tx);
      if (row.state !== "pending" || row.deliveryState !== "sending" || row.leaseId !== claim.lease || !row.leaseUntil || row.leaseUntil.getTime() <= now.getTime()+3000) return { status: "cancelled", id: row.id };
      if (row.expiresAt.getTime() <= now.getTime()+3000) {
        if (row.expiresAt <= now) await expireInvitation(tx,row.id);
        return { status: "cancelled", id: row.id };
      }
      let messageId: string | null = null, lastError = "encryption_unavailable";
      try {
        const secret = openInvitationSecret(row.deliveryCiphertext!,row.id,config.key!);
        if (!timingSafeEqual(Buffer.from(invitationVerifier(secret),"hex"),Buffer.from(row.tokenHash,"hex"))) throw new Error("Invalid invitation material.");
        lastError = "provider_failure";
        const response = await fetch(config.endpoint!, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000), headers: { "content-type": "application/json", "idempotency-key": row.id }, body: JSON.stringify({ to: row.email, subject: "Aafiyat staff invitation prepared", text: `A staff invitation for ${row.role} has been prepared. Redemption is not yet available. Reference: ${row.id}. Secret: ${secret}. Expires: ${row.expiresAt.toISOString()}.` }) });
        messageId = await receipt(response);
      } catch { /* Never log request, token, ciphertext, provider body or raw errors. */ }
      return recordInvitationDelivery(tx,row,messageId,lastError);
    }, invitationTransactionOptions);
  } catch { return { status: "unavailable" }; }
}
