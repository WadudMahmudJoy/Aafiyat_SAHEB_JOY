// Browser transport only. No tokens, roles, or MFA flags are persisted here.
type Fetch = typeof fetch;
export const ADMIN_ENTRY = "/admin";
export const ADMIN_LOGIN = "/admin/login";
export function validCredentials(email: string, password: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && password.length > 0 && password.length <= 128;
}
export const validTotp = (code: string) => /^[0-9]{6}$/.test(code);
async function post(path: string, body: unknown, send: Fetch) {
  return send(path, { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
export async function signOut(send: Fetch = fetch) {
  const response = await post("/api/auth/sign-out", {}, send);
  if (!response.ok) throw new Error("Sign-out unavailable.");
}
export async function beginAdminLogin(email: string, password: string, send: Fetch = fetch) {
  if (!validCredentials(email, password)) throw new Error("Check the email and password fields.");
  const response = await post("/api/auth/sign-in/email", { email: email.trim(), password }, send);
  if (!response.ok) throw new Error("Sign-in could not be completed. Check your details and try again shortly.");
  const result: { twoFactorRedirect?: unknown } = await response.json();
  if (result.twoFactorRedirect !== true) {
    await signOut(send);
    throw new Error("Secure sign-in requires an enrolled authenticator. Contact your administrator.");
  }
}
export async function checkAdminSession(send: Fetch = fetch) {
  return send("/api/admin/session", { credentials: "same-origin", cache: "no-store" });
}
export async function finishAdminLogin(code: string, send: Fetch = fetch) {
  if (!validTotp(code)) throw new Error("Enter the six-digit code from your authenticator.");
  const response = await post("/api/auth/two-factor/verify-totp", { code }, send);
  if (!response.ok) throw new Error("Verification could not be completed. Try a current code, or start again.");
  const authorized = await checkAdminSession(send);
  if (!authorized.ok) {
    await signOut(send);
    throw new Error("Secure sign-in could not be completed. Contact your administrator or try again shortly.");
  }
  // Destination is fixed. Never consume callbackURL, returnTo, or redirect query parameters.
  return ADMIN_ENTRY;
}
