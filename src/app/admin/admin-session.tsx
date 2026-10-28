"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_LOGIN, checkAdminSession, signOut } from "@/lib/admin-login-client";
import type { AdminDashboardData } from "@/lib/admin-dashboard";
import DashboardView from "./dashboard-view";

export default function AdminSession({ dashboard, children, currentPage = "overview" }: { dashboard: AdminDashboardData; children?: ReactNode; currentPage?: "overview" | "products" | "inventory" }) {
  const router = useRouter();
  const [state, setState] = useState<"ready" | "checking" | "unavailable">("ready");
  const [busy, setBusy] = useState(false);
  const retryCheck = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    let alive = true; let running = false;
    const check = async () => {
      if (running || !alive) return; running = true; setState("checking");
      try {
        const response = await checkAdminSession();
        if (!alive) return;
        if (response.status === 401) { router.replace(`${ADMIN_LOGIN}?reason=expired`); router.refresh(); }
        else if (response.ok) {
          const current: { role?: unknown } = await response.json();
          if (!alive) return;
          if (current.role !== dashboard.role) { router.refresh(); return; }
          setState("ready");
        } else setState("unavailable");
      } catch { if (alive) setState("unavailable"); }
      finally { running = false; }
    };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    retryCheck.current = check;
    void check();
    const timer = setInterval(() => void check(), 60_000);
    document.addEventListener("visibilitychange", visible); window.addEventListener("pageshow", check);
    return () => { alive = false; retryCheck.current = null; clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pageshow", check); };
  }, [router, dashboard.role]);
  async function leave() {
    setBusy(true); setState("checking");
    try { await signOut(); router.replace(ADMIN_LOGIN); router.refresh(); }
    catch { setState("unavailable"); setBusy(false); }
  }
  return <DashboardView dashboard={dashboard} state={state} busy={busy} onSignOut={leave} onRetry={() => { void retryCheck.current?.(); }} currentPage={currentPage}>{children}</DashboardView>;
}
