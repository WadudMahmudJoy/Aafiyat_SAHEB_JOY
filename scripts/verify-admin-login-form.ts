import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { beginAdminLogin, finishAdminLogin, signOut, validCredentials, validTotp } from "../src/lib/admin-login-client";

let passed = 0;
const test = async (name: string, run: () => unknown | Promise<unknown>) => { await run(); passed++; console.log(`PASS: ${name}`); };
async function verify() {
  await test("email/password validation; no password trimming", () => {
    assert(validCredentials("admin@example.invalid", " local test value "));
    assert(!validCredentials("bad", "input")); assert(!validCredentials("a@b.invalid", ""));
  });
  await test("TOTP accepts exactly six ASCII digits", () => {
    assert(validTotp("012345")); for (const code of ["12345", "1234567", "abcdef", "１２３４５６"]) assert(!validTotp(code));
  });
  await test("invalid fields make no network request", async () => {
    const noFetch: typeof fetch = async () => { throw new Error("Unexpected fetch"); };
    await assert.rejects(beginAdminLogin("bad", "", noFetch)); await assert.rejects(finishAdminLogin("bad", noFetch));
  });
  await test("network/credential errors remain generic", async () => {
    await assert.rejects(beginAdminLogin("a@b.invalid", "test input", async () => Response.json({ secret: "untrusted response" }, { status: 401 })),
      error => error instanceof Error && !error.message.includes("untrusted response"));
  });
  await test("untrusted redirects cannot change destination; cookies stay same-origin", async () => {
    const send: typeof fetch = async (path, options) => {
      assert.equal(options?.credentials, "same-origin"); assert.equal(options?.cache, "no-store");
      assert(["/api/auth/two-factor/verify-totp", "/api/admin/session"].includes(String(path)));
      return Response.json({ redirect: "https://untrusted.invalid", callbackURL: "//untrusted.invalid" });
    };
    assert.equal(await finishAdminLogin("123456", send), "/admin");
  });
  await test("TOTP success with server authorization denial never navigates", async () => {
    let signedOut = false;
    await assert.rejects(finishAdminLogin("123456", async path => {
      if (path === "/api/admin/session") return new Response(null, { status: 401 });
      if (path === "/api/auth/sign-out") signedOut = true;
      return Response.json({});
    })); assert(signedOut);
  });
  await test("sign-out failure is not reported as success", async () => assert.rejects(signOut(async () => new Response(null, { status: 503 }))));
  const source = readFileSync("src/app/admin/login/login-form.tsx", "utf8");
  const runtimeRequire = createRequire(import.meta.url);
  function render(state?: "totp", busy = false) {
    let index = 0;
    const compiledModule = { exports: {} as { default: React.ComponentType } };
    const compiled = ts.transpile(source, { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
    runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, require: (name: string) => {
      if (name === "react") return { ...React, useState: (initial: unknown) => {
        const i = index++; return React.useState(i === 0 && state ? state : i === 5 ? busy : initial);
      } };
      if (name === "next/navigation") return { useRouter: () => ({ replace() {}, refresh() {} }) };
      if (name.includes("admin.module.css")) return { default: {} };
      if (name === "@/lib/admin-login-client") return { beginAdminLogin, finishAdminLogin, signOut, validCredentials, validTotp };
      return runtimeRequire(name);
    } });
    return renderToStaticMarkup(React.createElement(compiledModule.exports.default));
  }
  await test("credential form labels, autocomplete, password concealment and toggle", () => {
    const html = render();
    for (const content of ['for="admin-email"', 'for="admin-password"', 'type="password"', 'autoComplete="current-password"', 'aria-label="Show password"', 'aria-pressed="false"']) assert(html.includes(content));
    assert(!html.includes("Sign up"));
  });
  await test("separate TOTP state has readable label and numeric six-digit validation", () => {
    const html = render("totp");
    for (const content of ['for="admin-totp"', 'inputMode="numeric"', 'pattern="[0-9]{6}"', 'autoComplete="one-time-code"', 'aria-describedby="totp-help"', 'Start again']) assert(html.includes(content));
    assert(!html.includes('id="admin-password"'));
  });
  await test("busy state announces progress and disables submissions", () => {
    const html = render("totp", true); assert(html.includes('aria-busy="true"')); assert(html.includes("disabled")); assert(html.includes('aria-live="polite"'));
  });
  console.log(`${passed} form/transport/accessibility checks passed; no database fixtures or browser demo sessions.`);
}
verify().catch(() => { console.error("Admin login form verification failed; details withheld."); process.exitCode = 1; });
