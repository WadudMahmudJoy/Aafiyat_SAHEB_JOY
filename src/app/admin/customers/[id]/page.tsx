import { headers } from "next/headers";
import { notFound,redirect } from "next/navigation";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import { getCustomerDetail } from "@/lib/admin-orders";
import AdminSession from "../../admin-session";
import { CustomerDetailView, OrdersError } from "../../orders/order-view";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 let data;try{data=await getCustomerDetail(await headers(),(await params).id,(await searchParams).cursor);}catch(error){if(error instanceof AdminAuthorizationError)redirect(error.reason==="PERMISSION_DENIED"?"/admin":"/admin/login?reason=expired");return <OrdersError/>;}if(!data)notFound();
 return <AdminSession dashboard={data.dashboard} currentPage="customers"><CustomerDetailView data={data}/></AdminSession>;
}
