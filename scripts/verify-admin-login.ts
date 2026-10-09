import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { POST } from "../src/app/api/auth/[...all]/route";
import { GET } from "../src/app/api/admin/session/route";
import { activatePendingOwner, enrollPendingOwner, provisionInactiveOwner } from "../src/lib/local-owner-bootstrap";
import { challengeHash, cleanupRehearsal, prepareRehearsal } from "../src/lib/local-owner-rehearsal";
import { beginAdminLogin, finishAdminLogin, signOut } from "../src/lib/admin-login-client";

function totp(uri: string) {
  const bits = [...new URL(uri).searchParams.get("secret")!.replace(/=+$/, "")].map(c =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)))).update(counter).digest();
  return ((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
let passed = 0; let stage = "local preflight";
async function verify() {
  const j = await prepareRehearsal(); const password = randomBytes(36).toString("base64url");
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  let jar = new Map<string,string>();
  const headers = () => new Headers({ origin, cookie: [...jar].map(([k,v]) => `${k}=${v}`).join("; ") });
  const send: typeof fetch = async (path, options) => {
    assert(typeof path === "string" && ["/api/admin/session", "/api/auth/sign-in/email", "/api/auth/two-factor/verify-totp", "/api/auth/sign-out"].includes(path));
    const h = headers(); if (options?.body) h.set("Content-Type", "application/json");
    const request = new Request(`${origin}${path}`, { ...options, headers: h });
    const execute = () => path === "/api/admin/session" ? GET(request.clone()) : POST(request.clone());
    let response = await execute();
    if (response.status === 429) {
      const retry = Number(response.headers.get("X-Retry-After")); assert(retry > 0 && retry <= 10);
      await response.body?.cancel(); await delay(retry * 1000 + 100); response = await execute();
    }
    const challengeName = (await auth.$context).createAuthCookie("two_factor").name;
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]; const separator = pair.indexOf("=");
      const key = pair.slice(0, separator); const value = pair.slice(separator + 1);
      if (key === challengeName && value) j.challengeHashes.push(challengeHash(decodeURIComponent(value).split(".", 1)[0]));
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)) jar.delete(key); else jar.set(key, value);
    }
    return response;
  };
  const sessionCheck = () => send("/api/admin/session");
  const rawLogin = () => send("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: j.email, password }) });
  const test = async (name: string, run: () => Promise<unknown>) => { stage = name; await run(); passed++; console.log(`PASS: ${name}`); };
  await test("unauthenticated admin entry denied without redirect parameter use", async () => assert.equal((await sessionCheck()).status, 401));
  try {
    const fixture = await provisionInactiveOwner({ email: j.email, name: j.name, password });
    j.userId = fixture.userId; j.membershipId = fixture.membershipId;
    await test("password-only client login rejected and signed out", async () => {
      await assert.rejects(beginAdminLogin(j.email, password, send));
      assert.equal(await prisma.session.count({ where: { userId: fixture.userId } }), 0);
    });
    await rawLogin();
    const factor = await enrollPendingOwner(fixture.userId, headers(), password);
    await send("/api/auth/two-factor/verify-totp", { method: "POST", body: JSON.stringify({ code: totp(factor.totpURI) }) });
    jar = new Map(); await beginAdminLogin(j.email, password, send);
    await test("incorrect TOTP cannot navigate to admin", async () => assert.rejects(finishAdminLogin("abcdef", send)));
    await test("inactive admin denied after genuine login TOTP; no navigation", async () => {
      await assert.rejects(finishAdminLogin(totp(factor.totpURI), send)); assert.equal((await sessionCheck()).status, 401);
    });
    jar = new Map(); await rawLogin();
    await send("/api/auth/two-factor/verify-totp", { method: "POST", body: JSON.stringify({ code: totp(factor.totpURI) }) });
    await activatePendingOwner(fixture.userId, headers());
    await signOut(send); jar = new Map();
    await test("credential challenge alone has no authenticated admin session", async () => {
      await beginAdminLogin(j.email, password, send); assert.equal((await sessionCheck()).status, 401);
    });
    await test("verified active admin navigates only to fixed /admin", async () => assert.equal(await finishAdminLogin(totp(factor.totpURI), send), "/admin"));
    await test("public session DTO contains authorized role only; no-store", async () => {
      const response = await sessionCheck(); assert.equal(response.headers.get("Cache-Control"), "no-store, private");
      assert.deepEqual(await response.json(), { role: "OWNER" });
    });
    await test("ORDER_MANAGER can enter through its existing orders read permission", async () => {
      const role = await prisma.adminRole.findUniqueOrThrow({ where: { name: "ORDER_MANAGER" } });
      try {
        await prisma.adminUser.update({ where: { id: fixture.membershipId }, data: { roleId: role.id } });
        assert.equal((await sessionCheck()).status, 200);
      } finally {
        const owner = await prisma.adminRole.findUniqueOrThrow({ where: { name: "OWNER" } });
        await prisma.adminUser.update({ where: { id: fixture.membershipId }, data: { roleId: owner.id } });
      }
    });
    await test("disabled admin session denied", async () => {
      await prisma.adminUser.update({ where: { id: fixture.membershipId }, data: { active: false } });
      assert.equal((await sessionCheck()).status, 401);
      await prisma.adminUser.update({ where: { id: fixture.membershipId }, data: { active: true } });
    });
    const authenticated = await auth.api.getSession({ headers: headers(), query: { disableCookieCache: true, disableRefresh: true } });
    const row = await prisma.session.findUniqueOrThrow({ where: { id: authenticated!.session.id } });
    await test("expired database session denied", async () => {
      await prisma.session.update({ where: { id: row.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await sessionCheck()).status, 401);
      assert.equal(await prisma.session.count({ where: { id: row.id } }), 0); // Framework removes expired sessions.
    });
    jar = new Map(); await beginAdminLogin(j.email, password, send); await finishAdminLogin(totp(factor.totpURI), send);
    const current = await auth.api.getSession({ headers: headers(), query: { disableCookieCache: true, disableRefresh: true } });
    await test("revoked session denied after secure sign-out", async () => {
      await signOut(send); assert.equal((await sessionCheck()).status, 401);
      assert.equal(await prisma.session.count({ where: { id: current!.session.id } }), 0);
    });
  } finally {
    const previousStage = stage;
    stage = "exact fixture cleanup"; await cleanupRehearsal(j, `DELETE TEST ${j.tag}`);
    stage = previousStage;
  }
  console.log(`${passed} admin login integration checks passed; all 12 fingerprints restored; no identities remain.`);
}
verify().catch(() => { console.error(`Admin login verification failed at ${stage}; sensitive details withheld.`); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
