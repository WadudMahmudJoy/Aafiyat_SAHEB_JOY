"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { saveVariantAction } from "./variant-actions";
import { emptyVariant, initialVariantState, variantLimits, type VariantValues, type VariantField } from "@/lib/variant-validation";
import styles from "./draft.module.css";
export type VariantFormProps = { productId: string; productName: string; variantId?: string; version?: string; values?: VariantValues };
export default function VariantForm({ productId, productName, variantId, version, values = emptyVariant }: VariantFormProps) {
  const [input, setInput] = useState(values);
  const [state, action, pending] = useActionState(saveVariantAction.bind(null, productId, variantId ?? null), initialVariantState);
  const created = !variantId && state.status === "saved";
  const field = (key: VariantField, label: string) => <div className={styles.field}><label htmlFor={key}>{label} *</label><input id={key} name={key} type="text" inputMode={key === "price" ? "decimal" : undefined} required maxLength={variantLimits[key]} value={input[key]} onChange={event => setInput(previous => ({ ...previous, [key]: event.target.value }))} aria-invalid={!!state.fields[key]} aria-describedby={state.fields[key] ? key + "-error" : key === "price" ? "price-help" : undefined} />{state.fields[key] && <p id={key + "-error"} className={styles.error}>{state.fields[key]}</p>}</div>;
  return <section className={styles.editor} aria-labelledby="variant-heading"><p className={styles.eyebrow}>DRAFT VARIANT · METADATA AND BDT PRICING</p><h1 id="variant-heading">{variantId ? "Edit variant" : "Add variant"}</h1><p className={styles.intro}>{productName}. Inventory, publishing, and images are not changed here.</p>
    <form action={action} aria-busy={pending}>{variantId && <input type="hidden" name="version" value={state.version ?? version ?? ""} />}<fieldset disabled={pending || created}><legend className={styles.legend}>Variant information</legend>{field("sku", "SKU")}<p className={styles.note}>SKU is saved in uppercase; size and color codes in lowercase. Codes are identifiers; labels are customer-readable text.</p><div className={styles.grid}>{field("sizeCode", "Size code")}{field("sizeLabel", "Size label")}{field("colorCode", "Color code")}{field("colorLabel", "Color label")}</div>{field("price", "Price (BDT)")}<p className={styles.note} id="price-help">Enter the price in BDT, for example 1250 or 1250.50. Up to two decimal places; no commas.</p></fieldset>
    <div aria-live="polite" aria-atomic="true">{pending && <p role="status">Saving variant…</p>}{state.message && <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? styles.errorBox : styles.success}>{state.message}</p>}</div>{state.conflict && <button type="button" className={styles.secondary} onClick={() => window.location.reload()}>Reload latest variant (discards unsaved changes)</button>}
    <div className={styles.actions}><button className={styles.primary} type="submit" disabled={pending || created}>{pending ? "Saving…" : variantId ? "Save changes" : "Create variant"}</button><Link prefetch={false} href={`/admin/products/${productId}`} aria-disabled={pending} tabIndex={pending ? -1 : undefined} onClick={event => { if (pending) event.preventDefault(); }}>{created ? "Back to product" : "Cancel"}</Link></div></form></section>;
}
