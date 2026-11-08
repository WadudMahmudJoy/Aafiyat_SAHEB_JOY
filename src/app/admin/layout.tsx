import type { Metadata } from "next";
import type { ReactNode } from "react";
import styles from "./typography.module.css";

export const metadata: Metadata = {
  title: "Administration | Aafiyat SAHEB",
  robots: { index: false, follow: false },
};
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className={styles.admin}>{children}</div>;
}
