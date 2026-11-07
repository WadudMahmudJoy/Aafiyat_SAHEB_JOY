"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Stage = "sign_in" | "login_code" | "setup" | "verify" | "unavailable" | "completed";
type Reply = { ok: boolean; stage?: Stage; message?: string; setupKey?: string };

async function post(path: string, body: object) {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-staff-onboarding": "1" },
    body: JSON.stringify(body),
  });
  return { success: response.ok, body: await response.json() };
}

export default function StaffActivation({ back }: { back?: () => void }) {
  const [stage, setStage] = useState<Stage>("sign_in");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [showSetup, setShowSetup] = useState(false);

  function update(reply: Reply) {
    if (reply.stage) setStage(reply.stage);
    setMessage(reply.message ?? "");
    if (reply.setupKey) setSetupKey(reply.setupKey);
    if (reply.stage === "completed" || reply.stage === "sign_in" || reply.stage === "unavailable") {
      setSetupKey("");
      setShowSetup(false);
    }
  }

  useEffect(() => {
    let active = true;
    post("/api/staff/activation", { operation: "status" })
      .then(({ body }) => { if (active) update(body); })
      .catch(() => { if (active) setMessage("Could not check onboarding. Sign in to try again."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    form.reset();
    setBusy(true);
    setMessage("");
    try {
      if (stage === "sign_in" || stage === "login_code") {
        const login = stage === "sign_in"
          ? await post("/api/auth/sign-in/email", { email: data.get("email"), password: data.get("password") })
          : await post("/api/auth/two-factor/verify-totp", { code: data.get("code") });
        if (!login.success) {
          setMessage(stage === "sign_in" ? "Sign-in failed. Check your email and password." : "Sign-in verification failed. Try the current authenticator code.");
          return;
        }
        if (login.body.twoFactorRedirect === true) {
          setStage("login_code");
          setMessage("Enter the code from your authenticator to finish signing in.");
          return;
        }
        update((await post("/api/staff/activation", { operation: "status" })).body);
      } else if (stage === "setup" || showSetup) {
        const { body } = await post("/api/staff/activation", { operation: "setup", password: data.get("password") });
        update(body);
        if (body.ok) setShowSetup(false);
      } else if (stage === "verify") {
        update((await post("/api/staff/activation", { operation: "activate", code: data.get("code") })).body);
      }
    } catch {
      setMessage("Could not continue. Try again. If your session ended, sign in again to check your progress.");
    } finally {
      setBusy(false);
    }
  }

  function restartSignIn() {
    setStage("sign_in");
    setSetupKey("");
    setShowSetup(false);
    setMessage("");
  }

  const passwordSetup = stage === "setup" || (stage === "verify" && showSetup);
  const showForm = stage !== "completed" && stage !== "unavailable";

  return <section aria-label="Staff activation" aria-busy={busy}>
    <h2>Continue staff onboarding</h2>
    {setupKey && stage === "verify" && !showSetup && <div>
      <p>Add a time-based account in your authenticator and enter this setup key. Keep it private.</p>
      <p><code aria-label="Authenticator setup key">{setupKey}</code></p>
    </div>}
    {showForm && <form key={stage + showSetup} method="post" onSubmit={submit}>
      <fieldset disabled={busy}>
        {stage === "sign_in" && <>
          <label>Invited email<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label>
          <button type="submit">Sign in to continue</button>
        </>}
        {passwordSetup && <>
          <label>Confirm your password<input name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} /></label>
          <button type="submit">Show authenticator setup key</button>
        </>}
        {!passwordSetup && (stage === "verify" || stage === "login_code") && <>
          <label>Authenticator code<input name="code" autoComplete="one-time-code" required inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} /></label>
          <button type="submit">{stage === "verify" ? "Verify and activate" : "Finish signing in"}</button>
        </>}
      </fieldset>
    </form>}
    {stage === "verify" && !setupKey && !showSetup && <p><button type="button" disabled={busy} onClick={() => setShowSetup(true)}>Show the existing setup key</button></p>}
    {stage !== "sign_in" && stage !== "completed" && <p><button type="button" disabled={busy} onClick={restartSignIn}>Return to sign-in</button></p>}
    {stage === "completed" && <p><Link href="/admin/login">Open administrator sign-in</Link></p>}
    {stage === "sign_in" && back && <p><button type="button" disabled={busy} onClick={back}>Return to invitation entry</button></p>}
    <p role="status" aria-live="polite">{busy ? "Working…" : message}</p>
  </section>;
}
