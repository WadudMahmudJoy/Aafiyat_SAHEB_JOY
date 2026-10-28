import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireAdminPermission } from "@/lib/admin-authorization";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getAdminDashboard } from "@/lib/admin-dashboard";
import { acknowledgeInput, boundedText, orderId, parseOrderFilters } from "@/lib/order-validation";

export type OrderRow = { id: string; orderNumber: string; customerId: string; contactName: string; paymentStatus: string; fulfillmentStatus: string; total: string; createdAt: string; acceptedAt: string | null; acknowledgedAt: string | null; cancelledAt: string | null; association: string };
export type CustomerRow = { id: string; displayName: string; phone: string; email: string | null; createdAt: string; association: string };
const projection = Prisma.sql`o.id, o.order_number AS "orderNumber",o.customer_id AS "customerId",o.contact_name AS "contactName",
 o.payment_status AS "paymentStatus",o.fulfillment_status AS "fulfillmentStatus",o.total_minor::text AS total,
 to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
 to_char(o.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "acceptedAt",
 to_char(o.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "acknowledgedAt",
 to_char(o.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelledAt",
 CASE WHEN o.owner_account_id IS NULL THEN 'Guest order — no account ownership' WHEN a.disabled_at IS NOT NULL THEN 'Disabled account association'
 WHEN a.verified_at IS NOT NULL THEN 'Verified account association' ELSE 'Unverified account association' END AS association`;
const customerProjection = Prisma.sql`c.id,c.display_name AS "displayName",c.phone_e164 AS phone,c.email,
 to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
 CASE WHEN a.id IS NULL THEN 'Guest profile — no account association' WHEN a.disabled_at IS NOT NULL THEN 'Disabled account association'
 WHEN a.verified_at IS NOT NULL THEN 'Verified account association' ELSE 'Unverified account association' END AS association`;
const readOptions = { maxWait: 5000, timeout: 10000, isolationLevel: "RepeatableRead" as const };
async function read<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) { return prisma.$transaction(async tx => {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`; await tx.$executeRaw`SET LOCAL statement_timeout='5s'`; return run(tx);
}, readOptions); }
function like(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }
export async function getOrders(headers: Headers, raw: Record<string, unknown>) {
  const dashboard = await getAdminDashboard(headers, "orders:read"); const filters = parseOrderFilters(raw);
  const { search, payment, fulfillment, from, to, cursor } = filters; const pattern = like(search);
  const rows = await read(tx => tx.$queryRaw<OrderRow[]>`SELECT ${projection} FROM orders o LEFT JOIN customer_accounts a ON a.id=o.owner_account_id
   WHERE (${search}='' OR o.order_number ILIKE ${pattern} OR o.id::text=${search} OR o.contact_name ILIKE ${pattern} OR o.contact_phone ILIKE ${pattern})
   AND (${payment}='' OR o.payment_status=${payment}) AND (${fulfillment}='' OR o.fulfillment_status=${fulfillment})
   AND (${from}='' OR o.created_at>=NULLIF(${from},'')::date::timestamp AT TIME ZONE 'UTC')
   AND (${to}='' OR o.created_at<(NULLIF(${to},'')::date+1)::timestamp AT TIME ZONE 'UTC')
   AND (${cursor}::uuid IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM orders WHERE id=${cursor}::uuid))
   ORDER BY o.created_at DESC,o.id DESC LIMIT 26`);
  return { dashboard, filters, items: rows.slice(0,25), nextCursor: rows.length>25 ? rows[24].id : null };
}
export async function getOrderDetail(headers: Headers, value: string, historyCursor?: unknown) {
  const dashboard = await getAdminDashboard(headers, "orders:read"); const id = orderId(value);
  const cursor = historyCursor === undefined || historyCursor === "" ? null : orderId(historyCursor);
  const detail = await read(async tx => {
    const [order] = await tx.$queryRaw<(OrderRow & { phone: string; email: string | null; address: string; subtotal: string; discount: string; shipping: string; tax: string; acknowledger: string | null })[]>`
      SELECT ${projection},o.contact_phone AS phone,o.contact_email AS email,o.shipping_address AS address,
      o.subtotal_minor::text AS subtotal,o.discount_minor::text AS discount,o.shipping_minor::text AS shipping,o.tax_minor::text AS tax,u.name AS acknowledger
      FROM orders o LEFT JOIN customer_accounts a ON a.id=o.owner_account_id LEFT JOIN admin_users m ON m.id=o.acknowledged_by LEFT JOIN auth_users u ON u.id=m.user_id WHERE o.id=${id}::uuid`;
    if (!order) return null;
    const items = await tx.$queryRaw<{ id: string; productName: string; sku: string; sizeLabel: string; colorLabel: string; quantity: number; unit: string; discount: string; total: string }[]>`
      SELECT id,product_name AS "productName",sku,size_label AS "sizeLabel",color_label AS "colorLabel",quantity,unit_price_minor::text AS unit,discount_minor::text AS discount,total_minor::text AS total FROM order_items WHERE order_id=${id}::uuid ORDER BY id LIMIT 200`;
    const events = await tx.$queryRaw<{ id: string; kind: string; actor: string | null; createdAt: string }[]>`SELECT e.id,e.kind,u.name AS actor,
      to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM order_events e
      LEFT JOIN admin_users m ON m.id=e.actor_admin_id LEFT JOIN auth_users u ON u.id=m.user_id WHERE e.order_id=${id}::uuid
      AND (${cursor}::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM order_events WHERE id=${cursor}::uuid AND order_id=${id}::uuid))
      ORDER BY e.created_at DESC,e.id DESC LIMIT 21`;
    return { order, items, events: events.slice(0,20), nextCursor: events.length>20 ? events[19].id : null };
  });
  return detail && { dashboard, ...detail, canAcknowledge: hasAdminPermission(dashboard.role,"orders:manage") && !!detail.order.acceptedAt && !detail.order.cancelledAt && detail.order.fulfillmentStatus!=="cancelled" && !detail.order.acknowledgedAt };
}
// Customer PII belongs to the same staff order-support boundary. No new grants.
export async function getCustomers(headers: Headers, raw: Record<string, unknown>) {
  const dashboard = await getAdminDashboard(headers,"orders:read");
  if (Object.keys(raw).some(k=>!["search","cursor"].includes(k))) throw new Error("Invalid filters");
  const search=boundedText(raw.search), cursor=raw.cursor===undefined||raw.cursor===""?null:orderId(raw.cursor), pattern=like(search);
  const rows=await read(tx=>tx.$queryRaw<CustomerRow[]>`SELECT ${customerProjection} FROM customers c LEFT JOIN customer_accounts a ON a.customer_id=c.id
    WHERE (${search}='' OR c.display_name ILIKE ${pattern} OR c.phone_e164 ILIKE ${pattern} OR c.email ILIKE ${pattern} OR c.id::text=${search})
    AND (${cursor}::uuid IS NULL OR (c.created_at,c.id)<(SELECT created_at,id FROM customers WHERE id=${cursor}::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT 26`);
  return {dashboard,search,items:rows.slice(0,25),nextCursor:rows.length>25?rows[24].id:null};
}
export async function getCustomerDetail(headers:Headers,value:string,after?:unknown) {
  const dashboard=await getAdminDashboard(headers,"orders:read"); const id=orderId(value), cursor=after===undefined||after===""?null:orderId(after);
  const data=await read(async tx=>{
    const [customer]=await tx.$queryRaw<CustomerRow[]>`SELECT ${customerProjection} FROM customers c LEFT JOIN customer_accounts a ON a.customer_id=c.id WHERE c.id=${id}::uuid`; if(!customer)return null;
    const orders=await tx.$queryRaw<OrderRow[]>`SELECT ${projection} FROM orders o LEFT JOIN customer_accounts a ON a.id=o.owner_account_id WHERE o.customer_id=${id}::uuid
      AND (${cursor}::uuid IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM orders WHERE id=${cursor}::uuid AND customer_id=${id}::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT 26`;
    return {customer,orders:orders.slice(0,25),nextCursor:orders.length>25?orders[24].id:null};
  }); return data&&{dashboard,...data};
}
export type Acknowledgement = { ok: true; orderId: string; acknowledgedAt: string; actor: string } | { ok:false; code:"ACCESS_DENIED"|"VALIDATION"|"INELIGIBLE"|"UNAVAILABLE"; message:string };
export async function acknowledgeOrder(headers:Headers,form:FormData):Promise<Acknowledgement>{
  let principal;
  try { const base=auth.options.baseURL; if(typeof base!=="string"||headers.get("origin")!==new URL(base).origin||headers.get("sec-fetch-site")==="cross-site")throw new Error(); principal=await requireAdminPermission("orders:manage",headers); }
  catch{return {ok:false,code:"ACCESS_DENIED",message:"Order management access denied."};}
  let id;try{id=acknowledgeInput(form);}catch{return {ok:false,code:"VALIDATION",message:"Supply only a valid order identifier."};}
  try{return await prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;await tx.$executeRaw`SET LOCAL statement_timeout='5s'`;
    const [row]=await tx.$queryRaw<{eligible:boolean}[]>`SELECT accepted_at IS NOT NULL AND cancelled_at IS NULL AND fulfillment_status<>'cancelled' AS eligible FROM orders WHERE id=${id}::uuid FOR UPDATE`;
    if(!row?.eligible)return {ok:false as const,code:"INELIGIBLE" as const,message:"Only accepted, non-cancelled orders can be acknowledged."};
    await tx.$executeRaw`UPDATE orders SET acknowledged_at=clock_timestamp(),acknowledged_by=${principal.adminUserId}::uuid WHERE id=${id}::uuid AND acknowledged_at IS NULL`;
    const [receipt]=await tx.$queryRaw<{acknowledgedAt:string;actor:string}[]>`SELECT to_char(o.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "acknowledgedAt",u.name AS actor FROM orders o JOIN admin_users a ON a.id=o.acknowledged_by JOIN auth_users u ON u.id=a.user_id WHERE o.id=${id}::uuid`;
    return {ok:true as const,orderId:id,...receipt};
  },{maxWait:5000,timeout:10000});}catch{return {ok:false,code:"UNAVAILABLE",message:"Acknowledgement could not be confirmed. Retry the same order safely."};}
}
