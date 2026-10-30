import "server-only";
import { invitationEncryptionKey } from "./invitation-secrets";

// E2A ships a local sink adapter only. A production provider needs separate setup.
export function invitationDeliveryConfig() {
  const key = invitationEncryptionKey(process.env.ADMIN_INVITATION_ENCRYPTION_KEY, process.env.BETTER_AUTH_SECRET);
  const mode = process.env.ADMIN_INVITATION_DELIVERY;
  if (!mode || mode === "disabled") return { key, endpoint: null };
  if (mode !== "local-sink" || process.env.NODE_ENV === "production") throw new Error("Invitation delivery configuration unavailable.");
  const endpoint = new URL(process.env.ADMIN_INVITATION_MAIL_SINK_URL ?? "");
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/messages") throw new Error("Invitation delivery configuration unavailable.");
  // No configurable production HTTP destination, redirects or arbitrary URLs.
  return { key, endpoint: endpoint.toString() };
}
