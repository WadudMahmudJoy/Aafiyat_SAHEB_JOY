import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";

type EnrollmentScope = {
  tx: Prisma.TransactionClient;
  userId: string;
  sessionId: string;
  path: "/two-factor/enable" | "/two-factor/get-totp-uri" | "/two-factor/verify-totp";
};

const enrollment = new AsyncLocalStorage<EnrollmentScope>();
export const currentStaffEnrollment = () => enrollment.getStore();

export function withStaffEnrollment<T>(scope: EnrollmentScope, run: () => Promise<T>) {
  return enrollment.run(scope, run);
}

// Better Auth 1.7.7's Prisma adapter resolves db[model] at operation time.
// Within the validated scope, factor, user and session writes share our tx.
export const authPrisma = new Proxy(prisma, {
  get(client, property) {
    const scope = currentStaffEnrollment();
    const target = scope && !String(property).startsWith("_") ? scope.tx : client;
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
