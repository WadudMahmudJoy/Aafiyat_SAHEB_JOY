// --check is read-only. --create requires an explicit interactive local operator.
import "dotenv/config";
import { createInterface, emitKeypressEvents } from "node:readline";
import { checkOwnerBootstrap, provisionInactiveOwner, findPendingOwner, enrollPendingOwner,
  resumePendingOwnerEnrollment, activatePendingOwner, verifyLocalOwnerDatabase } from "../src/lib/local-owner-bootstrap";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { GET, POST } from "../src/app/api/auth/[...all]/route";
import { showLocalEnrollmentUri } from "./local-owner-secret-view";

async function hiddenPassword(label = "Password (hidden): "): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive terminal required.");
  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cancel = () => { value = ""; finish(); reject(new Error("Cancelled.")); };
    const finish = () => {
      process.stdin.off("keypress", listener); process.stdin.off("end", cancel);
      process.stdin.off("close", cancel); process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n");
    };
    const listener = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) cancel();
      else if (key.name === "return" || key.name === "enter") { finish(); resolve(value); }
      else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on("keypress", listener);
    process.stdin.once("end", cancel); process.stdin.once("close", cancel);
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  });
}

async function ask(label: string) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return await new Promise<string>((resolve, reject) => {
    const cancel = () => { reader.close(); reject(new Error("Cancelled.")); };
    reader.once("SIGINT", cancel); reader.once("close", cancel);
    reader.question(label, answer => {
      reader.off("SIGINT", cancel); reader.off("close", cancel); resolve(answer);
    });
  }); }
  finally { reader.close(); }
}

async function onboarding(mode: "--enroll" | "--activate") {
  await verifyLocalOwnerDatabase();
  const email = await ask("Confirm intended pending Owner email: ");
  const pending = await findPendingOwner(email);
  const password = await hiddenPassword();
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  const jar = new Map<string, string>();
  const challenges = new Set<string>();
  const operatorSessions = new Set<string>();
  const challengeCookie = (await auth.$context).createAuthCookie("two_factor").name;
  const headers = () => new Headers({ origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
  async function request(path: string, body?: unknown) {
    const method = body === undefined ? "GET" : "POST";
    const h = headers(); if (body !== undefined) h.set("content-type", "application/json");
    const req = new Request(`${origin}/api/auth${path}`, { method, headers: h,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await (method === "GET" ? GET : POST)(req);
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]; const equals = pair.indexOf("=");
      const key = pair.slice(0, equals); const value = pair.slice(equals + 1);
      if (key === challengeCookie && value) {
        const identifier = decodeURIComponent(value).split(".", 1)[0];
        if (!/^2fa-[A-Za-z0-9_-]+$/.test(identifier)) throw new Error("Unexpected challenge.");
        challenges.add(identifier);
      }
      if (!value || /max-age=0/i.test(cookie)) jar.delete(key); else jar.set(key, value);
    }
    if (!response.ok) throw new Error("Authentication refused.");
    const authenticated = await auth.api.getSession({ headers: headers(),
      query: { disableCookieCache: true, disableRefresh: true } });
    if (authenticated?.user.id === pending.userId) operatorSessions.add(authenticated.session.id);
    return response.json();
  }
  try {
    const login = await request("/sign-in/email", { email: pending.email, password });
    if (mode === "--enroll") {
      if (login.twoFactorRedirect) throw new Error("Already enrolled; use separate activation login.");
      const factors = await prisma.twoFactor.count({ where: { userId: pending.userId } });
      let uri: string;
      if (factors === 0) uri = (await enrollPendingOwner(pending.userId, headers(), password)).totpURI;
      else uri = (await resumePendingOwnerEnrollment(pending.userId, headers(), password)).totpURI;
      console.log("Enrollment data will appear only in a private local window; it is not logged.");
      await showLocalEnrollmentUri(uri); uri = "";
      const code = await hiddenPassword("Authenticator TOTP (hidden): ");
      await request("/two-factor/verify-totp", { code });
      console.log("Enrollment verified; Owner remains inactive. Run a separate activation operation.");
    } else {
      if (!login.twoFactorRedirect) throw new Error("Verified enrollment required before activation.");
      await request("/two-factor/verify-totp", { code: await hiddenPassword("Login TOTP (hidden): ") });
      if (await ask("Type ACTIVATE VERIFIED OWNER to activate this identity: ") !== "ACTIVATE VERIFIED OWNER") throw new Error("Cancelled.");
      await activatePendingOwner(pending.userId, headers());
      console.log("Owner activated with verified login proof; other sessions and pending challenges revoked.");
    }
  } finally {
    // Do not leave the operator command's session behind after success/failure.
    const cookie = headers();
    jar.clear();
    try { await auth.api.signOut({ headers: cookie }); } catch { /* No privilege is granted by logout failure. */ }
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008, hashtext(${pending.userId}))`;
      // Exact server-identified sessions only; also covers a failed sign-out.
      await tx.session.deleteMany({ where: { userId: pending.userId, id: { in: [...operatorSessions] } } });
      await tx.verification.deleteMany({ where: { OR: [
        { identifier: { in: [...challenges] }, value: pending.userId },
        { identifier: { in: [...challenges].map(id => `2fa-attempts-${id}`) } },
      ] } });
    });
  }
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--create", "--enroll", "--activate"].includes(args[0])) throw new Error("Use one operation flag only; credentials are never CLI arguments.");
  if (args[0] === "--enroll" || args[0] === "--activate") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive terminal required.");
    await onboarding(args[0]); return;
  }
  await checkOwnerBootstrap();
  if (args[0] === "--check") { console.log("Local database verified; no Owner exists. No records changed."); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive terminal required.");
  if (await ask("Type CREATE INACTIVE OWNER to proceed: ") !== "CREATE INACTIVE OWNER") throw new Error("Cancelled.");
  const email = await ask("Intended Owner email: "); const name = await ask("Owner name: ");
  let password = await hiddenPassword();
  let repeated = await hiddenPassword();
  try {
    if (password !== repeated) throw new Error("Passwords differ.");
    await provisionInactiveOwner({ email, name, password });
    console.log("Inactive Owner created. Enrollment and separately reviewed activation are still required.");
  } finally { password = ""; repeated = ""; }
}

run().catch(() => { console.error("Local Owner bootstrap refused or failed; sensitive details withheld."); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
