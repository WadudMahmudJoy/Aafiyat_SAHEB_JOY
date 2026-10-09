"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { beginAdminLogin, finishAdminLogin, signOut, validCredentials, validTotp } from "@/lib/admin-login-client";
import styles from "../admin.module.css";

export default function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [code, setCode] = useState(""); const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const pending = useRef(false); const totpInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (step === "totp") totpInput.current?.focus(); }, [step]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    if (step === "credentials" && !validCredentials(email, password)) {
      setError("Enter a valid email address and your password."); return;
    }
    if (step === "totp" && !validTotp(code)) { setError("Enter the six-digit code from your authenticator."); return; }
    pending.current = true; setBusy(true); setError("");
    try {
      if (step === "credentials") { await beginAdminLogin(email, password); setStep("totp"); }
      else { const destination = await finishAdminLogin(code); router.replace(destination); router.refresh(); }
    } catch {
      setError(step === "credentials" ? "Sign-in could not be completed. Check your details or contact your administrator."
        : "Verification could not be completed. Try a current code, or start again.");
    } finally {
      setPassword(""); setVisible(false); setCode(""); setBusy(false); pending.current = false;
    }
  }
  async function restart() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await signOut(); setStep("credentials"); setCode(""); }
    catch { setError("Unable to restart sign-in. Please try again shortly."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <form onSubmit={submit} className={styles.form} aria-busy={busy}>
    {step === "credentials" ? <>
      <label htmlFor="admin-email">Email address</label>
      <input id="admin-email" name="email" type="email" autoComplete="username" required
        value={email} onChange={e => setEmail(e.target.value)} disabled={busy} spellCheck={false} autoCapitalize="none" />
      <label htmlFor="admin-password">Password</label>
      <div className={styles.passwordRow}>
        <input id="admin-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password"
          required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} />
        <button type="button" className={styles.reveal} onClick={() => setVisible(!visible)} disabled={busy}
          aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible} aria-controls="admin-password">
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </> : <>
      <div className={styles.stepHeading}>Verify your identity</div>
      <p id="totp-help" className={styles.help}>Enter the six-digit code from your authenticator app.</p>
      <label htmlFor="admin-totp">Authenticator code</label>
      <input ref={totpInput} id="admin-totp" name="code" className={styles.code} type="text" inputMode="numeric"
        autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code}
        onChange={e => setCode(e.target.value)} disabled={busy} aria-describedby="totp-help" />
    </>}
    <div className={styles.feedback} aria-live="polite" aria-atomic="true">
      {error && <p role="alert">{error}</p>}
      {busy && <span>{step === "credentials" ? "Signing in…" : "Verifying…"}</span>}
    </div>
    <button className={styles.primary} type="submit" disabled={busy}>
      {busy ? "Please wait…" : step === "credentials" ? "Sign in" : "Verify & continue"}<span aria-hidden="true">↗</span>
    </button>
    {step === "totp" && <button type="button" className={styles.textButton} onClick={restart} disabled={busy}>Start again</button>}
  </form>;
}
