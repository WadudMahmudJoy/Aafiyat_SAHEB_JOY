// Run: node --conditions=react-server --import tsx scripts/verify-auth-http.ts [--http]
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { GET, POST } from "../src/app/api/auth/[...all]/route";

const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
const password = randomBytes(24).toString("base64url");
const email = `${randomUUID()}@example.invalid`;
const credentials = { email, password };
let passed = 0;
const live = process.argv.includes("--http");

async function snapshot() {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    assert.equal(identity.db, "aafiyat_dev");
    return {
      categories: await tx.category.findMany({ orderBy: { id: "asc" } }),
      products: await tx.product.count(), variants: await tx.productVariant.count(),
      inventory: await tx.inventoryBalance.count(), users: await tx.user.count(),
      admins: await tx.adminUser.count(), roles: await tx.adminRole.count(),
      sessions: await tx.session.count(), accounts: await tx.account.count(),
      twoFactors: await tx.twoFactor.count(), verifications: await tx.verification.count(),
    };
  });
}

async function request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const method = body === undefined ? "GET" : "POST";
  const req = new Request(`${origin}/api/auth${path}`, {
    method,
    headers: { origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const execute = () => live ? fetch(req.clone(), { redirect: "manual" }) : (method === "GET" ? GET : POST)(req.clone());
  let response = await execute();
  if (response.status === 429) {
    // Respect the installed limiter; never disable it or spoof a new client IP.
    const retry = Number(response.headers.get("X-Retry-After"));
    assert.ok(Number.isFinite(retry) && retry > 0 && retry <= 10);
    await response.body?.cancel();
    await setTimeout(retry * 1000 + 100);
    response = await execute();
  }
  const text = await response.text();
  for (const sensitive of [password, process.env.BETTER_AUTH_SECRET!, process.env.DATABASE_URL!]) {
    assert.ok(sensitive && !text.includes(sensitive), "Sensitive value reflected in auth response");
  }
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return { response, text };
}

async function test(name: string, run: () => unknown | Promise<unknown>) {
  await run(); passed++; console.log(`PASS: ${name}`);
}

async function verify() {
  const db = new URL(process.env.DATABASE_URL!);
  assert.equal(db.hostname, "127.0.0.1");
  assert.equal(db.port, "55432");
  assert.equal(db.pathname, "/aafiyat_dev");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname));
  const before = await snapshot();
  await test("signup rejected by HTTP handler", async () => {
    const { response, text } = await request("/sign-up/email", { ...credentials, name: "Disabled signup probe" });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(text).code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
  });
  await test("unknown credentials produce generic 401", async () => {
    const { response, text } = await request("/sign-in/email", credentials);
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(text).code, "INVALID_EMAIL_OR_PASSWORD");
    assert.ok(!text.includes(email));
  });
  await test("unauthenticated session query returns null", async () => {
    const { response, text } = await request("/get-session");
    assert.equal(response.status, 200); assert.equal(JSON.parse(text), null);
  });
  await test("invalid session cookie grants no session", async () => {
    const cookie = (await auth.$context).authCookies.sessionToken.name;
    const { text } = await request("/get-session", undefined, { cookie: `${cookie}=invalid-signature` });
    assert.equal(JSON.parse(text), null);
  });
  await test("untrusted browser origin rejected", async () => {
    const { response } = await request("/sign-in/email", credentials, { origin: "https://untrusted.example.invalid" });
    assert.equal(response.status, 403);
  });
  await test("untrusted callback URL rejected", async () => {
    const { response } = await request("/sign-in/email", { ...credentials, callbackURL: "https://untrusted.example.invalid" });
    assert.equal(response.status, 403);
  });
  await test("TOTP enrollment remains disabled pending revocation workflow", async () => {
    const { response } = await request("/two-factor/enable", { password });
    assert.equal(response.status, 404);
  });
  await test("TOTP verification needs a session or valid pending challenge", async () => {
    const { response } = await request("/two-factor/verify-totp", { code: "000000" });
    assert.equal(response.status, 401);
  });
  await test("trustDevice request rejected before second-factor handling", async () => {
    const { response, text } = await request("/two-factor/verify-totp", { code: "000000", trustDevice: true });
    assert.equal(response.status, 403); assert.equal(JSON.parse(text).code, "TRUSTED_DEVICE_DISABLED");
  });
  await test("trusted-device cookies rejected before credential handling", async () => {
    const cookie = (await auth.$context).createAuthCookie("trust_device").name;
    const { response, text } = await request("/sign-in/email", credentials, { cookie: `${cookie} = invalid-signature` });
    assert.equal(response.status, 403); assert.equal(JSON.parse(text).code, "TRUSTED_DEVICE_DISABLED");
  });
  for (const path of ["/sign-in/social", "/two-factor/send-otp", "/two-factor/verify-backup-code", "/two-factor/disable", "/update-user"]) {
    await test(`${path} outside minimal auth surface`, async () => {
      const { response } = await request(path, { ...credentials, provider: "google", code: "000000" });
      assert.equal(response.status, 404);
    });
  }
  await test("configured cookie protections and origin checks retained", async () => {
    const context = await auth.$context;
    assert.equal(context.authCookies.sessionToken.attributes.httpOnly, true);
    assert.equal(context.authCookies.sessionToken.attributes.sameSite, "lax");
    assert.equal(context.authCookies.sessionToken.attributes.secure, origin.startsWith("https:"));
    assert.deepEqual(auth.options.trustedOrigins, [origin]);
    assert.notEqual(auth.options.advanced?.disableCSRFCheck, true);
    assert.notEqual(auth.options.advanced?.disableOriginCheck, true);
    assert.equal(auth.options.session?.cookieCache?.enabled, false);
  });
  if (!live) {
    const original = auth.handler;
    try {
      await test("thrown internal errors are sanitized", async () => {
        Reflect.set(auth, "handler", async () => { throw new Error(process.env.DATABASE_URL! + password); });
        const { response, text } = await request("/get-session");
        assert.equal(response.status, 500); assert.equal(JSON.parse(text).code, "AUTH_UNAVAILABLE");
      });
      await test("returned internal error bodies are sanitized", async () => {
        Reflect.set(auth, "handler", async () => Response.json({ message: process.env.BETTER_AUTH_SECRET }, { status: 500 }));
        const { response, text } = await request("/get-session");
        assert.equal(response.status, 500); assert.equal(JSON.parse(text).code, "AUTH_UNAVAILABLE");
      });
    } finally { Reflect.set(auth, "handler", original); }
  }
  await test("all category and auth data unchanged; no accounts created", async () => assert.deepEqual(await snapshot(), before));
  console.log(`${passed} checks passed; 0 failed (${live ? "live HTTP" : "route-handler"}).`);
}

verify().catch(() => {
  console.error(`Auth security verification failed after ${passed} passed checks; sensitive details withheld.`);
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
