import type { ReceivingReceipt } from "./admin-inventory";
export type InventoryActionState = { status: "idle" | "error" | "saved"; code?: string; message: string; receipt?: ReceivingReceipt };
export const initialInventoryState: InventoryActionState = { status: "idle", message: "" };
