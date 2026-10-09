import type { Metadata } from "next";
import type { ReactNode } from "react";
import styles from "./admin.module.css";

export const metadata: Metadata = {
  title: "Administration | Aafiyat SAHEB",
  robots: { index: false, follow: false },
};
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className={styles.shell}>
    <aside className={styles.brand} aria-label="Aafiyat SAHEB">
      <div className={styles.brandTop}>AAFIYAT SAHEB <span>ADMINISTRATION</span></div>
      <div className={styles.wordmark}>
        <div className={styles.aafiyat}>Aafiyat</div>
        <div className={styles.saheb}>SAHEB</div>
        <div className={styles.goldLine} />
        <p className={styles.tagline}>Where Tradition Meets Royalty</p>
      </div>
      <p className={styles.brandFoot}>Considered tradition.<br />Careful stewardship.</p>
    </aside>
    <main className={styles.main}>{children}</main>
  </div>;
}
