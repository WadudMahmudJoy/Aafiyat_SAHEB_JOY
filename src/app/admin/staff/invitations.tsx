import { readInvitations } from "@/lib/admin-invitations";
import { InvitationCloseForm, InvitationForm } from "./invitation-form";
import styles from "../inventory/inventory.module.css";

const deliveryLabels: Record<string,string> = { unconfigured: "Delivery not configured", queued: "Pending delivery", sending: "Delivery attempt in progress", failed: "Delivery failed; retries bounded to five attempts", delivered: "Provider accepted (not proof of recipient opening)", cancelled: "Further delivery attempts cancelled" };
export default async function Invitations({ headers,cursor,destination }: { headers: Headers; cursor?: string; destination?: string }) {
  const data = await readInvitations(headers,cursor,destination);
  return <section aria-labelledby="invitations-heading">
    <h2 id="invitations-heading">Staff invitations</h2>
    <p>Prepare an invitation for a future non-Owner administrator. Account creation, acceptance and TOTP enrollment are not available yet. No invitation secret is displayed here.</p>
    <InvitationForm/>
    <h3>Invitation history</h3>
    <form method="get" className={styles.form}><label>Filter invitation email<input type="email" name="invitationEmail" maxLength={254} defaultValue={data.email}/></label><button className={styles.button}>Find invitations</button></form>
    {!data.rows.length && <p>{data.email ? "No invitations match this email." : "No staff invitations have been prepared."}</p>}
    {data.rows.map(row => <article className={styles.panel} key={row.id}>
      <h3>{row.email}</h3><p>{row.role} · {row.state} · {deliveryLabels[row.deliveryState]}</p>
      <p>Expires {row.expiresAt}<br/>Created {row.createdAt}<br/>Delivery attempts {row.attempts} · Revision {row.version}</p>
      {["pending","delivered"].includes(row.state) && <InvitationCloseForm id={row.id} version={row.version}/>}
    </article>)}
    {data.nextCursor && <a href={"?"+new URLSearchParams({ invitations: data.nextCursor, invitationEmail: data.email })}>Next invitations</a>}
  </section>;
}
