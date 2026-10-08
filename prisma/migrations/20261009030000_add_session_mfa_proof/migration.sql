-- AlterTable
ALTER TABLE "auth_sessions" ADD COLUMN     "mfa_verified_at" TIMESTAMPTZ(6);
