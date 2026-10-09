import LoginForm from "./login-form";
import styles from "../admin.module.css";

export default async function AdminLoginPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const expired = (await searchParams).reason === "expired";
  return <section className={styles.card} aria-labelledby="login-heading">
    <p className={styles.eyebrow}>PRIVATE ACCESS</p>
    <h1 id="login-heading">Welcome back.</h1>
    <p className={styles.intro}>Sign in to the Aafiyat SAHEB administration.</p>
    {expired && <p className={styles.notice} role="status">Your session has ended. Please sign in again.</p>}
    <LoginForm />
    <p className={styles.footnote}>For authorized administrators only.<br />Authenticator verification is required.</p>
  </section>;
}
