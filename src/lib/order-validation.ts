import { draftUuid } from "./product-draft-validation";
export const paymentStates = ["unpaid", "pending", "paid", "partially_refunded", "refunded"] as const;
export const fulfillmentStates = ["unfulfilled", "processing", "shipped", "delivered", "cancelled"] as const;
export class OrderInputError extends Error { constructor() { super("Check the filters or order identifier."); } }
export function orderId(value: unknown) { if (typeof value !== "string" || value.length !== 36 || !draftUuid.test(value)) throw new OrderInputError(); return value.toLowerCase(); }
export function boundedText(value: unknown, max = 100) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new OrderInputError();
  return value.trim();
}
function day(value: unknown) {
  const text = boundedText(value, 10); if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text < "0001-01-01" || new Date(text + "T00:00:00Z").toISOString().slice(0, 10) !== text) throw new OrderInputError();
  return text;
}
export function parseOrderFilters(raw: Record<string, unknown>) {
  if (Object.keys(raw).some(k => !["search", "payment", "fulfillment", "from", "to", "cursor"].includes(k))) throw new OrderInputError();
  const search = boundedText(raw.search); const payment = boundedText(raw.payment, 20); const fulfillment = boundedText(raw.fulfillment, 20);
  if (payment && !(paymentStates as readonly string[]).includes(payment) || fulfillment && !(fulfillmentStates as readonly string[]).includes(fulfillment)) throw new OrderInputError();
  const from = day(raw.from), to = day(raw.to); if (from && to && from > to) throw new OrderInputError();
  return { search, payment, fulfillment, from, to, cursor: raw.cursor === undefined || raw.cursor === "" ? null : orderId(raw.cursor) };
}
export function acknowledgeInput(form: FormData) {
  const entries = [...form.entries()]; if (entries.length !== 1 || entries[0][0] !== "orderId") throw new OrderInputError(); return orderId(entries[0][1]);
}
const maximum = BigInt("9223372036854775807");
function amount(text: string) { if (!/^(0|[1-9]\d{0,18})$/.test(text)) throw new OrderInputError(); const n = BigInt(text); if (n > maximum) throw new OrderInputError(); return n; }
export function totals(lines: { quantity: number; unit: string; discount: string }[], shipping: string, tax: string) {
  if (!lines.length || lines.length > 200) throw new OrderInputError();
  let subtotal = BigInt("0"), discount = BigInt("0");
  for (const line of lines) { if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 2147483647) throw new OrderInputError(); const gross = BigInt(line.quantity) * amount(line.unit), d = amount(line.discount); if (gross > maximum || d > gross) throw new OrderInputError(); subtotal += gross; discount += d; }
  const total = subtotal - discount + amount(shipping) + amount(tax); if (subtotal > maximum || discount > maximum || total > maximum) throw new OrderInputError();
  return { subtotal: String(subtotal), discount: String(discount), total: String(total) };
}
export function money(text: string) { const n = amount(text); return `BDT ${(n / BigInt("100")).toLocaleString("en-US")}.${String(n % BigInt("100")).padStart(2, "0")}`; }
