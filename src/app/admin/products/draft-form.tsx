"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { createDraftAction, updateDraftAction } from "./draft-actions";
import { draftLimits, emptyDraft, initialDraftState, type DraftValues } from "@/lib/product-draft-validation";
import styles from "./draft.module.css";

export type DraftFormProps = { productId?: string; version?: string; values?: DraftValues; categories: { id: string; name: string; active: boolean }[]; truncated?: boolean };
export default function DraftForm({ productId, version, values = emptyDraft, categories, truncated }: DraftFormProps) {
  const [input, setInput] = useState(values);
  const [state, action, pending] = useActionState(productId ? updateDraftAction.bind(null, productId) : createDraftAction, initialDraftState);
  const created = !productId && state.status === "saved";
  const change = (key: keyof DraftValues, value: string) => setInput(previous => ({ ...previous, [key]: value }));
  const field = (key: keyof DraftValues, label: string, required = false, multiline = false) => {
    const props = { id: key, name: key, value: input[key], required, maxLength: draftLimits[key], "aria-invalid": !!state.fields[key], "aria-describedby": state.fields[key] ? `${key}-error` : undefined, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(key, event.target.value) };
    return <div className={styles.field}><label htmlFor={key}>{label}{required ? " *" : " (optional)"}</label>{multiline ? <textarea {...props} rows={key === "description" ? 6 : 3} /> : <input {...props} type="text" />} {state.fields[key] && <p className={styles.error} id={`${key}-error`}>{state.fields[key]}</p>}</div>;
  };
  return <section aria-labelledby="draft-heading" className={styles.editor}>
    <p className={styles.eyebrow}>PRODUCT INFORMATION · DRAFT ONLY</p><h1 id="draft-heading">{productId ? "Edit product draft" : "Add product draft"}</h1>
    <p className={styles.intro}>Save product information privately. Variants and BDT prices are managed separately. Publishing, stock changes, and images are upcoming.</p>
    <form action={action} aria-busy={pending}>
      {productId && <input type="hidden" name="version" value={state.version ?? version ?? ""} />}
      <fieldset disabled={pending || created}><legend className={styles.legend}>Product metadata</legend>
        <div className={styles.grid}>{field("name", "Product name", true)}<div className={styles.field}><label htmlFor="categoryId">Category *</label><select id="categoryId" name="categoryId" value={input.categoryId} required aria-invalid={!!state.fields.categoryId} aria-describedby={state.fields.categoryId ? "categoryId-error" : undefined} onChange={event => change("categoryId", event.target.value)}><option value="">Choose a category</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}{category.active ? "" : " (inactive)"}</option>)}</select>{state.fields.categoryId && <p className={styles.error} id="categoryId-error">{state.fields.categoryId}</p>}</div></div>
        {truncated && <p className={styles.note}>The first 100 categories and any current category are shown.</p>}
        {field("slug", "Slug", true)}<p className={styles.note}>Use letters, numbers, and single hyphens. Slugs are trimmed and saved in lowercase.</p>
        {field("description", "Description", false, true)}
        <div className={styles.grid}>{field("seoTitle", "SEO title")}{field("seoDescription", "SEO description", false, true)}</div>
      </fieldset>
      <div aria-live="polite" aria-atomic="true">{pending && <p role="status">Saving draft…</p>}{state.message && <p className={state.status === "error" ? styles.errorBox : styles.success} role={state.status === "error" ? "alert" : "status"}>{state.message}</p>}</div>
      {state.conflict && <button type="button" className={styles.secondary} onClick={() => window.location.reload()}>Reload latest draft (discards unsaved changes)</button>}
      <div className={styles.actions}><button className={styles.primary} type="submit" disabled={pending || created || !categories.length}>{pending ? "Saving…" : productId ? "Save changes" : "Create draft"}</button><Link prefetch={false} href={productId ? `/admin/products/${productId}` : "/admin/products"} aria-disabled={pending} tabIndex={pending ? -1 : undefined} onClick={event => { if (pending) event.preventDefault(); }}>{created ? "Back to catalogue" : "Cancel"}</Link>{state.status === "saved" && state.productId && <Link prefetch={false} href={`/admin/products/${state.productId}`}>View saved product →</Link>}</div>
      {!categories.length && <p role="alert">No categories are available. A draft cannot be created without a category.</p>}
    </form>
  </section>;
}
