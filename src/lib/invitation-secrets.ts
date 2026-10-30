import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function normalizeInvitationEmail(raw: string): string {
  if (typeof raw !== "string" || raw.length > 300 || /[^\x20-\x7e]/.test(raw)) throw new Error("Invalid invitation email.");
  const email = raw.trim().toLowerCase();
  const [local, domain, extra] = email.split("@");
  if (email.length > 254 || !local || local.length > 64 || extra !== undefined || !domain ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) ||
      !domain.includes(".") || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("Invalid invitation email.");
  return email;
}

// No fallback to Better Auth's key, and no derivation from a session/MFA secret.
export function invitationEncryptionKey(raw: string | undefined, authenticationSecret: string | undefined): Buffer | null {
  if (raw === undefined) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw || raw === authenticationSecret ||
      (authenticationSecret && key.equals(Buffer.from(authenticationSecret)))) throw new Error("Invitation delivery configuration unavailable.");
  return key;
}
export const createInvitationSecret = () => randomBytes(32).toString("base64url");
export function invitationVerifier(secret: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, "base64url").toString("base64url") !== secret) throw new Error("Invalid invitation material.");
  return createHash("sha256").update("aafiyat-admin-invitation-v1\0").update(secret).digest("hex");
}
export function sealInvitationSecret(secret: string, id: string, key: Buffer): string {
  invitationVerifier(secret);
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`admin-invitation:v1:${id}`));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),encrypted.toString("base64url")].join(".");
}
export function openInvitationSecret(sealed: string, id: string, key: Buffer): string {
  if (sealed.length > 200) throw new Error("Invalid invitation material.");
  const [v,iv,tag,data,extra] = sealed.split(".");
  if (v !== "v1" || extra !== undefined || !iv || !tag || !data) throw new Error("Invalid invitation material.");
  const decipher = createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));
  decipher.setAAD(Buffer.from(`admin-invitation:v1:${id}`));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  const secret = Buffer.concat([decipher.update(Buffer.from(data,"base64url")),decipher.final()]).toString("utf8");
  invitationVerifier(secret); return secret;
}
