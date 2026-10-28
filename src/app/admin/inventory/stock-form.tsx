"use client";
import { useActionState, useState } from "react";
import { receiveStockAction, correctStockAction } from "./actions";
import { initialInventoryState, type InventoryActionState } from "@/lib/inventory-action-state";
import styles from "./inventory.module.css";

export default function StockForm({ operation, productId, variantId, revision, idempotencyKey }: {
  operation: "receive" | "correction"; productId: string; variantId: string; revision: string; idempotencyKey: string;
}) {
  const receiving = operation === "receive";
  const [key] = useState(idempotencyKey); const [expectedRevision] = useState(revision);
  const [quantity, setQuantity] = useState(""); const [reason, setReason] = useState("");
  const [state, action, pending] = useActionState(async (previous: InventoryActionState, data: FormData): Promise<InventoryActionState> => {
    try { return await (receiving ? receiveStockAction : correctStockAction)(previous, data); }
    catch { return { status: "error", code: "UNAVAILABLE", message: "The response was interrupted. Retry the same request to confirm its outcome." }; }
  }, initialInventoryState);
  const saved = state.status === "saved"; const uncertain = state.code === "UNAVAILABLE";
  const locked = pending || saved || uncertain;
  return <section className={styles.panel} aria-labelledby={`${operation}-heading`}>
    <h2 id={`${operation}-heading`}>{receiving ? "Receive stock" : "Correct counted stock"}</h2>
    <p className={styles.note}>{receiving ? "Add units received into this variant." : "Set the physical count. Reserved units are protected; a fresh balance revision is required."}</p>
    <form action={action} className={styles.form} aria-busy={pending}>
      <input type="hidden" name="productId" value={productId} /><input type="hidden" name="variantId" value={variantId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      {!receiving && <input type="hidden" name="expectedRevision" value={expectedRevision} />}
      <div className={styles.field}><label htmlFor={`${operation}-quantity`}>{receiving ? "Quantity received" : "Counted on-hand quantity"}</label>
        <input id={`${operation}-quantity`} name={receiving ? "quantity" : "targetOnHand"} type="text" inputMode="numeric" pattern="[0-9]+" maxLength={10} required value={quantity} readOnly={locked} onChange={event => setQuantity(event.target.value)} aria-describedby={`${operation}-hint`} /></div>
      <div className={styles.field}><label htmlFor={`${operation}-reason`}>Reason for {receiving ? "receiving" : "correction"}</label>
        <textarea id={`${operation}-reason`} name="reason" maxLength={2048} required value={reason} readOnly={locked} onChange={event => setReason(event.target.value)} /></div>
      <p id={`${operation}-hint`} className={styles.formHint}>Whole units only. Maximum 2,147,483,647. Reason: up to 500 characters after whitespace normalization.</p>
      {state.message && <div role={state.status === "error" ? "alert" : "status"} className={`${styles.message} ${state.status === "error" ? styles.error : ""}`}>
        {state.message}
        {state.code === "CONFLICT" && <p><a className={styles.link} href={`/admin/inventory/${variantId}`}>Load the latest balance before starting a new operation</a></p>}
        {uncertain && <p>Your quantity, reason, revision and request key are retained. Retry this exact request to recover a committed receipt safely.</p>}
      </div>}
      {!saved && <button type="submit" className={styles.button} disabled={pending}>{pending ? "Recording…" : uncertain ? "Retry same request" : receiving ? "Record receiving" : "Record correction"}</button>}
    </form>
    {saved && state.receipt && <div className={styles.message} aria-label="Committed movement receipt">
      <p>Immutable movement receipt · {state.receipt.movementType}</p>
      <dl className={styles.receipt}><dt>Receipt</dt><dd>{state.receipt.id}</dd><dt>On hand at this movement</dt><dd>{state.receipt.onHandBefore} → {state.receipt.onHandAfter} (delta {state.receipt.deltaOnHand > 0 ? "+" : ""}{state.receipt.deltaOnHand})</dd><dt>Reserved</dt><dd>{state.receipt.reservedBefore} → {state.receipt.reservedAfter}</dd><dt>Reason</dt><dd>{state.receipt.reason}</dd><dt>Recorded at (UTC)</dt><dd>{state.receipt.createdAt}</dd></dl>
      <p className={styles.formHint}>This receipt describes the recorded movement. Other operations may have changed current stock.</p>
      <a className={styles.link} href={`/admin/inventory/${variantId}`}>Refresh current stock and start another operation</a>
    </div>}
  </section>;
}
