import { headers } from "next/headers";
import { notFound,redirect } from "next/navigation";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import { getOrderDetail } from "@/lib/admin-orders";
import AdminSession from "../../admin-session";
import { OrderDetailView, OrdersError } from "../../orders/order-view";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 let data;try{data=await getOrderDetail(await headers(),(await params).id,(await searchParams).cursor);}catch(error){if(error instanceof AdminAuthorizationError)redirect(error.reason==="PERMISSION_DENIED"?"/admin":"/admin/login?reason=expired");return <OrdersError/>;}if(!data)notFound();
 return <AdminSession dashboard={data.dashboard} currentPage="orders"><OrderDetailView data={data}/></AdminSession>;
}
