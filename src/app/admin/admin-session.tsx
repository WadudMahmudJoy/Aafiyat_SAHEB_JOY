"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_LOGIN, checkAdminSession, signOut } from "@/lib/admin-login-client";
import styles from "./admin.module.css";

export default function AdminSession({ role }: { role: string }) {
  const router = useRouter();
  const [state, setState] = useState<"ready" | "checking" | "unavailable">("ready");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true; let running = false;
    const check = async () => {
      if (running || !alive) return; running = true; setState("checking");
      try {
        const response = await checkAdminSession();
        if (!alive) return;
        if (response.status === 401) { router.replace(`${ADMIN_LOGIN}?reason=expired`); router.refresh(); }
        else setState(response.ok ? "ready" : "unavailable");
      } catch { if (alive) setState("unavailable"); }
      finally { running = false; }
    };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    document.addEventListener("visibilitychange", visible); window.addEventListener("pageshow", check);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pageshow", check); };
  }, [router]);
  async function leave() {
    setBusy(true); setState("checking");
    try { await signOut(); router.replace(ADMIN_LOGIN); router.refresh(); }
    catch { setState("unavailable"); setBusy(false); }
  }
  return <section className={styles.card} aria-labelledby="admin-heading" aria-busy={busy || state === "checking"}>
    <p className={styles.eyebrow}>AAFIYAT SAHEB · ADMINISTRATION</p>
    <h1 id="admin-heading">Welcome inside.</h1>
    <div aria-live="polite">
      {state === "ready" ? <><p className={styles.intro}>Your secure admin session is active.</p>
        <p className={styles.role}>Authorized role <strong>{role}</strong></p></>
        : <p className={styles.notice}>{state === "checking" ? "Checking your session…" : "Connection unavailable. Please reload or try signing out again."}</p>}
    </div>
    <button className={styles.primary} type="button" onClick={leave} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>
    <p className={styles.footnote}>A private space for authorized administrators.</p>
  </section>;
}
