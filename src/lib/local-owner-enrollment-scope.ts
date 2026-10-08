import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

// In-process operator capability. Never derived from an HTTP header/body/cookie.
const scope = new AsyncLocalStorage<{ userId: string; sessionId: string }>();
export function withLocalOwnerEnrollment<T>(identity: { userId: string; sessionId: string }, run: () => Promise<T>) {
  return scope.run(identity, run);
}
export function currentLocalOwnerEnrollment() {
  return scope.getStore();
}
