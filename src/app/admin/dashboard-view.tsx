import type { AdminDashboardData } from "@/lib/admin-dashboard";
import type { ReactNode } from "react";
import styles from "./dashboard.module.css";

type Props = { dashboard: AdminDashboardData; state: "ready" | "checking" | "unavailable"; busy: boolean;
  onSignOut: () => void; onRetry: () => void; preview?: boolean; children?: ReactNode; currentPage?: "overview" | "products" | "inventory" };

export default function DashboardView({ dashboard, state, busy, onSignOut, onRetry, preview = false, children, currentPage = "overview" }: Props) {
  const ready = state === "ready";
  const navigation = <ul className={styles.navList}>
    <li><a href={preview ? "#dashboard-main" : "/admin"} aria-current={currentPage === "overview" ? "page" : undefined} className={currentPage === "overview" ? styles.current : styles.navLink}><span aria-hidden="true">◈</span> Overview</a></li>
    {dashboard.areas.map(area => <li key={area.id}>{area.href ? <a className={currentPage === area.id ? styles.current : styles.navLink} href={preview ? "#dashboard-main" : area.href} aria-current={currentPage === area.id ? "page" : undefined}>{area.label}<small>{area.id === "inventory" ? "Stock and movement ledger" : area.features.includes("Product management") ? "Draft management" : "Read-only catalogue"}</small></a> : <span className={styles.upcomingNav}>{area.label}<small>Upcoming</small></span>}</li>)}
  </ul>;
  return <div className={styles.shell}>
    <a className={styles.skip} href="#dashboard-main">Skip to main content</a>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span>Aafiyat</span><strong>SAHEB</strong><p>Where Tradition Meets Royalty</p></div>
      <p className={styles.navCaption}>MANAGEMENT WORKSPACE</p>
      {ready && <nav className={styles.desktopNav} aria-label="Administration">{navigation}</nav>}
      <div className={styles.sidebarFoot}>Tradition, thoughtfully managed.</div>
    </aside>
    <div className={styles.workspace}>
      <header className={styles.header}>
        <p className={styles.headerLabel}>AAFIYAT SAHEB <span>Administration</span></p>
        <button className={styles.signOut} type="button" onClick={preview ? undefined : onSignOut} disabled={busy || preview}
          aria-label={preview ? "Sign out is unavailable in this static test preview" : undefined}>{preview ? "Sign out (mock)" : busy ? "Signing out…" : "Sign out"}</button>
      </header>
      {ready && <details className={styles.mobileNav}><summary>Workspace navigation</summary><nav aria-label="Mobile administration">{navigation}</nav></details>}
      <main id="dashboard-main" tabIndex={-1} className={styles.main} aria-busy={state === "checking" || busy}>
        {children && <div hidden={!ready} inert={!ready}>{children}</div>}
        {ready ? (children ? null : <>
          <div className={styles.heading}><div><p className={styles.eyebrow}>YOUR WORKSPACE</p><h1>Overview</h1><p className={styles.intro}>A clear view of the work ahead.</p></div><span className={preview ? `${styles.secure} ${styles.previewStatus}` : styles.secure}>{preview ? "TEST PREVIEW — NOT AUTHENTICATED" : "MFA-verified session"}</span></div>
          <section className={styles.identity} aria-labelledby="identity-heading">
            <div className={styles.initial} aria-hidden="true">{dashboard.identity.name.trim().slice(0, 1).toUpperCase() || "A"}</div>
            <div><h2 id="identity-heading">{dashboard.identity.name}</h2><p>{dashboard.identity.email}</p></div>
            <div className={styles.role}><span>{preview ? "Sample role" : "Authorized role"}</span><strong>{dashboard.roleLabel}</strong></div>
          </section>
          <section className={styles.notice} aria-labelledby="readiness-heading"><span aria-hidden="true">01</span><div><h2 id="readiness-heading">Your management foundation is ready.</h2><p>Use the available management areas below. Each area is shown according to your verified permissions.</p></div></section>
          <div className={styles.sectionHeading}><h2>Management areas</h2><p>Shown according to your authorized permissions.</p></div>
          {dashboard.areas.length ? <div className={styles.grid}>{dashboard.areas.map(area => <section className={styles.area} key={area.id} aria-labelledby={`area-${area.id}`}>
            <div className={styles.areaTop}><span className={styles.areaMark} aria-hidden="true">{area.label.slice(0, 1)}</span><span className={styles.badge}>{area.href ? area.id === "inventory" ? "Operational" : area.features.includes("Product management") ? "Draft metadata" : "Read-only" : "Upcoming"}</span></div>
            <h3 id={`area-${area.id}`}>{area.href ? <a href={preview ? "#dashboard-main" : area.href}>{area.label}</a> : area.label}</h3><p>{area.description}</p><ul>{area.features.map(feature => <li key={feature}>{feature}{area.href && feature === "Product management" ? " — Draft metadata" : !area.href && feature !== "Product catalog" ? " — Upcoming" : ""}</li>)}</ul>
          </section>)}</div> : <p className={styles.empty}>No management modules are available for your current permissions.</p>}
        </>) : <section className={styles.connection} aria-live="polite"><p className={styles.eyebrow}>SECURE WORKSPACE</p><h1>{state === "checking" ? "Checking your session…" : "Connection unavailable"}</h1><p>{state === "checking" ? "Please wait while we confirm your access." : "We cannot confirm access right now. Retry or sign out safely."}</p>{state === "unavailable" && <button type="button" className={styles.retry} onClick={onRetry}>Retry</button>}</section>}
        {ready && <footer className={styles.footer}>Aafiyat SAHEB <span>Private administration · Where Tradition Meets Royalty</span></footer>}
      </main>
    </div>
  </div>;
}
