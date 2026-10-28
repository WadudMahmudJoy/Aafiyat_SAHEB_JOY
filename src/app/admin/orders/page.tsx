import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import { getOrders } from "@/lib/admin-orders";
import AdminSession from "../admin-session";
import { OrdersView, OrdersError } from "../orders/order-view";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 let data;try{data=await getOrders(await headers(),await searchParams);}catch(error){if(error instanceof AdminAuthorizationError)redirect(error.reason==="PERMISSION_DENIED"?"/admin":"/admin/login?reason=expired");return <OrdersError/>;}
 return <AdminSession dashboard={data.dashboard} currentPage="orders"><OrdersView data={data}/></AdminSession>;
}
