import { validDraftVersion } from "./product-draft-validation";
export { validDraftVersion };
export const variantFields = ["sku", "sizeCode", "sizeLabel", "colorCode", "colorLabel", "price"] as const;
export type VariantField = typeof variantFields[number];
export type VariantValues = Record<VariantField, string>;
export type VariantErrors = Partial<Record<VariantField | "version", string>>;
export const variantLimits = { sku: 100, sizeCode: 100, sizeLabel: 200, colorCode: 100, colorLabel: 200, price: 21 };
export const emptyVariant: VariantValues = { sku: "", sizeCode: "", sizeLabel: "", colorCode: "", colorLabel: "", price: "" };
// BDT: 100 poisha per taka. No Number conversion or binary floating point.
export function parseBdtPrice(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 21 || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return minor <= BigInt("9223372036854775807") ? minor : null;
}
export function priceInput(minor: bigint | string) { const n = BigInt(minor); return (n / BigInt(100)).toString() + "." + (n % BigInt(100)).toString().padStart(2, "0"); }
export function validateVariant(input: unknown) {
  const values = { ...emptyVariant }; const fields: VariantErrors = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { values, fields, valid: false, priceMinor: null };
  const record = input as Record<string, unknown>;
  for (const key of variantFields) {
    const value = record[key];
    if (typeof value !== "string" || value.length > variantLimits[key] || /[\u0000-\u001f\u007f]/.test(value)) { fields[key] = "Enter valid text within the field limit."; continue; }
    values[key] = value.trim().normalize("NFC");
    if (!values[key] || values[key].length > variantLimits[key]) fields[key] = "This field is required and must fit the field limit.";
  }
  values.sku = values.sku.toUpperCase(); values.sizeCode = values.sizeCode.toLowerCase(); values.colorCode = values.colorCode.toLowerCase();
  for (const key of ["sku", "sizeCode", "colorCode"] as const) if (values[key].length > variantLimits[key]) fields[key] = "Normalized code exceeds the field limit.";
  const priceMinor = parseBdtPrice(values.price);
  if (priceMinor === null) fields.price = "Enter a nonnegative BDT amount with up to two decimals within the supported range.";
  return { values, fields, priceMinor, valid: priceMinor !== null && !Object.keys(fields).length && !Object.keys(record).some(key => !variantFields.includes(key as VariantField)) };
}
export type VariantFormState = { status: "idle" | "error" | "saved"; message: string; fields: VariantErrors; version?: string; variantId?: string; conflict?: boolean };
export const initialVariantState: VariantFormState = { status: "idle", message: "", fields: {} };
