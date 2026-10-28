import { draftUuid } from "./product-draft-validation";

const receivingFields = ["productId", "variantId", "quantity", "reason", "idempotencyKey"] as const;
export type ReceivingInput = {
  productId: string; variantId: string; quantity: number; reason: string; idempotencyKey: string;
};
type Validation = { valid: true; values: ReceivingInput } | { valid: false };

// Pass structured entries directly: converting FormData/URLSearchParams to an
// object first would lose the information required to reject repeated fields.
export function validateReceiving(input: unknown): Validation {
  let entries: [string, unknown][];
  if (input instanceof FormData || input instanceof URLSearchParams) {
    entries = Array.from(input.entries());
  } else {
    if (!input || typeof input !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return { valid: false };
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== "string" || !receivingFields.includes(key as typeof receivingFields[number]))) return { valid: false };
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (keys.some(key => !("value" in descriptors[key as string]))) return { valid: false };
    entries = keys.map(key => [key as string, descriptors[key as string].value]);
  }
  if (entries.length !== receivingFields.length) return { valid: false };
  const record: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) {
    if (!receivingFields.includes(key as typeof receivingFields[number]) ||
        Object.hasOwn(record, key) || typeof value !== "string") return { valid: false };
    record[key] = value;
  }
  for (const key of ["productId", "variantId", "idempotencyKey"] as const) {
    if (record[key].length !== 36 || !draftUuid.test(record[key])) return { valid: false };
  }
  if (!/^[0-9]+$/.test(record.quantity)) return { valid: false };
  const decimal = record.quantity.replace(/^0+/, "");
  if (!decimal || decimal.length > 10) return { valid: false };
  const quantity = Number(decimal);
  if (quantity > 2_147_483_647) return { valid: false };
  // Bound raw UTF-16 code units before normalization; the business limit stays 500.
  if (record.reason.length > 2048) return { valid: false };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(record.reason)) return { valid: false };
  const reason = record.reason.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!reason || reason.length > 500) return { valid: false };
  return { valid: true, values: {
    productId: record.productId.toLowerCase(), variantId: record.variantId.toLowerCase(),
    idempotencyKey: record.idempotencyKey.toLowerCase(), quantity, reason,
  } };
}
