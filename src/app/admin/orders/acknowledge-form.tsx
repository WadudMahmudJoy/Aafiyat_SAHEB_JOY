"use client";
import { useActionState } from "react";
import { acknowledgeAction, type AckState } from "./actions";
import styles from "../inventory/inventory.module.css";
export default function AcknowledgeForm({orderId}:{orderId:string}) {
  const [state,action,pending]=useActionState(async(previous:AckState,data:FormData):Promise<AckState>=>{try{return await acknowledgeAction(previous,data);}catch{return {message:"Response interrupted. Retry acknowledgement for this same order safely."};}},{message:""});
  return <form action={action} aria-busy={pending}><input type="hidden" name="orderId" value={orderId}/><p className={styles.note}>Acknowledgement records that staff have seen this accepted order. It does not authorize payment or fulfillment.</p>{state.message&&<p role={state.saved?"status":"alert"} className={styles.message}>{state.message}</p>}{!state.saved&&<button className={styles.button} disabled={pending}>{pending?"Acknowledging…":"Acknowledge order"}</button>}</form>;
}
