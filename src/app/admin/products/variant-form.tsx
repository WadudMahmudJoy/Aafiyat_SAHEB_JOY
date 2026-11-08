"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { saveVariantAction } from "./variant-actions";
import { emptyVariant, initialVariantState, variantLimits, type VariantValues, type VariantField } from "@/lib/variant-validation";
import styles from "./draft.module.css";
import workflow from "./workflow.module.css";
export type VariantFormProps = { productId: string; productName: string; variantId?: string; version?: string; values?: VariantValues };
export default function VariantForm({ productId, productName, variantId, version, values = emptyVariant }: VariantFormProps) {
  const [input, setInput] = useState(values);
  const [state, action, pending] = useActionState(saveVariantAction.bind(null, productId, variantId ?? null), initialVariantState);
  const created = !variantId && state.status === "saved";
  const field = (key: VariantField, label: string) => <div className={styles.field}><label htmlFor={key}>{label} *</label><input id={key} name={key} type="text" inputMode={key === "price" ? "decimal" : undefined} required maxLength={variantLimits[key]} value={input[key]} onChange={event => setInput(previous => ({ ...previous, [key]: event.target.value }))} aria-invalid={!!state.fields[key]} aria-describedby={state.fields[key] ? key + "-error" : key === "price" ? "price-help" : undefined} />{state.fields[key] && <p id={key + "-error"} className={styles.error}>{state.fields[key]}</p>}</div>;
  const productPath = `/admin/products/${productId}`;
  return <section className={styles.editor} aria-labelledby="variant-heading"><p className={styles.eyebrow}>DRAFT VARIANT · METADATA AND BDT PRICING</p><h1 id="variant-heading">{variantId ? "Edit variant" : "Add variant"}</h1><p className={styles.intro}>Set the size, color, and BDT price for {productName}. Stock is managed in Inventory.</p>
    <div aria-live="polite" aria-atomic="true">{created && <div className={workflow.successPanel}>
      <div role="status"><h2>Variant Saved</h2><p>The product remains a private draft. Add another size or color, or continue to product images.</p></div>
      <div className={workflow.actions}>
        {/* A document navigation starts a fresh form even when the URL is the same. */}
        <a className={workflow.primary} href={`${productPath}/variants/new`}>+ Add Another Variant</a>
        <Link className={workflow.secondary} prefetch={false} href={productPath}>Back to Product</Link>
        <Link className={workflow.secondary} prefetch={false} href={`${productPath}/media#product-images`}>Next: Manage Product Images</Link>
      </div>
    </div>}</div>
    {!created && <form action={action} aria-busy={pending}>{variantId && <input type="hidden" name="version" value={state.version ?? version ?? ""} />}<fieldset disabled={pending}><legend className={styles.legend}>Variant information</legend>{field("sku", "SKU")}<p className={styles.note}>SKU is saved in uppercase; size and color codes in lowercase. Codes are identifiers; labels are customer-readable text.</p><div className={styles.grid}>{field("sizeCode", "Size code")}{field("sizeLabel", "Size label")}{field("colorCode", "Color code")}{field("colorLabel", "Color label")}</div>{field("price", "Price (BDT)")}<p className={styles.note} id="price-help">Enter the price in BDT, for example 1250 or 1250.50. Up to two decimal places; no commas.</p></fieldset>
    <div aria-live="polite" aria-atomic="true">{pending && <p role="status">Saving variant…</p>}{state.message && <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? styles.errorBox : styles.success}>{state.message}</p>}</div>{state.conflict && <button type="button" className={workflow.secondary} onClick={() => window.location.reload()}>Reload latest variant (discards unsaved changes)</button>}
    <div className={`${styles.actions} ${workflow.actions}`}><button className={workflow.primary} type="submit" disabled={pending}>{pending ? "Saving…" : variantId ? "Save Variant Changes" : "Create Variant"}</button><Link className={workflow.secondary} prefetch={false} href={productPath} aria-disabled={pending} tabIndex={pending ? -1 : undefined} onClick={event => { if (pending) event.preventDefault(); }}>{state.status === "saved" ? "Back to Product" : "Cancel"}</Link></div></form>}
  </section>;
}
