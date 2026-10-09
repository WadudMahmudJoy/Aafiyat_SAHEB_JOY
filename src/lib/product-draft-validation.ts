export const draftFields = ["name", "categoryId", "slug", "description", "seoTitle", "seoDescription"] as const;
export type DraftField = typeof draftFields[number];
export type DraftValues = Record<DraftField, string>;
export type DraftErrors = Partial<Record<DraftField | "version", string>>;
export const draftLimits = { name: 200, categoryId: 36, slug: 160, description: 10000, seoTitle: 200, seoDescription: 500 };
export const emptyDraft: DraftValues = { name: "", categoryId: "", slug: "", description: "", seoTitle: "", seoDescription: "" };
export const draftUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateDraft(input: unknown) {
  const values = { ...emptyDraft }; const fields: DraftErrors = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { values, fields, valid: false };
  const record = input as Record<string, unknown>;
  for (const key of draftFields) {
    const value = record[key];
    if (typeof value !== "string" || value.length > draftLimits[key] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      fields[key] = `Use text of at most ${draftLimits[key]} characters.`; continue;
    }
    values[key] = value.replace(/\r\n?/g, "\n").trim().normalize("NFC");
    if (values[key].length > draftLimits[key]) fields[key] = `Use text of at most ${draftLimits[key]} characters.`;
  }
  values.slug = values.slug.toLowerCase(); values.categoryId = values.categoryId.toLowerCase();
  if (!values.name) fields.name ??= "Enter a product name.";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(values.slug)) fields.slug ??= "Use lowercase letters, numbers, and single hyphens.";
  if (!draftUuid.test(values.categoryId)) fields.categoryId ??= "Choose a valid category.";
  const unexpected = Object.keys(record).some(key => !draftFields.includes(key as DraftField));
  return { values, fields, valid: !unexpected && Object.keys(fields).length === 0 };
}
// Six fractional digits retain PostgreSQL precision; this is a revision, not authorization.
export function validDraftVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value.slice(0, 23) + "Z";
}
export type DraftFormState = { status: "idle" | "error" | "saved"; message: string; fields: DraftErrors; productId?: string; version?: string; conflict?: boolean };
export const initialDraftState: DraftFormState = { status: "idle", message: "", fields: {} };
