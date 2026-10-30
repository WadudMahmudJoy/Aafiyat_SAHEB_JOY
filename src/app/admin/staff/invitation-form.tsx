"use client";
import { useActionState } from "react";
import { invitationAction } from "./actions";
import styles from "../inventory/inventory.module.css";

const initial = { ok: false, message: "" };
export function InvitationForm() {
  const [state,action,pending] = useActionState(invitationAction,initial);
  return <form action={action} className={styles.form} aria-busy={pending}>
    <fieldset disabled={pending || state.ok} style={{ border: 0, padding: 0, minWidth: 0, display: "grid", gap: 12 }}>
      <input type="hidden" name="operation" value="create"/>
      <label>Invitation email<input type="email" name="email" maxLength={254} required autoComplete="off"/></label>
      <label>Invitation role<select name="role" defaultValue="PRODUCT_MANAGER">
        <option value="PRODUCT_MANAGER">Product manager</option><option value="ORDER_MANAGER">Order manager</option><option value="MARKETING_MANAGER">Marketing manager</option>
      </select></label>
      <p>Product managers manage the catalogue and inventory. Order managers manage orders. Marketing managers manage offers and content. Invitations expire after 48 hours and grant no account or access.</p>
      <button className={styles.button}>{pending ? "Preparing invitation…" : "Invite staff"}</button>
    </fieldset>
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message} <a href="">Reload invitations</a></p>}
  </form>;
}
export function InvitationCloseForm({ id,version }: { id: string; version: string }) {
  const [state,action,pending] = useActionState(invitationAction,initial);
  return <form action={action} className={styles.form} aria-busy={pending}>
    <fieldset disabled={pending || state.ok} style={{ border: 0, padding: 0, minWidth: 0, display: "grid", gap: 12 }}>
      <input type="hidden" name="id" value={id}/><input type="hidden" name="version" value={version}/>
      <label>Invitation operation<select name="operation"><option value="revoke">Revoke invitation</option><option value="expire">Expire invitation now</option></select></label>
      <label>Type CONFIRM to close this invitation<input name="confirm" required pattern="CONFIRM" autoComplete="off"/></label>
      <button className={styles.button}>{pending ? "Closing invitation…" : "Close invitation"}</button>
    </fieldset>
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message} <a href="">Reload invitations</a></p>}
  </form>;
}
