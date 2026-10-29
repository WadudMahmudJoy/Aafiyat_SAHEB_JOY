import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getProductControls } from "@/lib/admin-catalog-controls";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "../../../admin-session";
import { ProductControlsView,ControlsError } from "../../catalog-controls-view";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){let data;try{data=await getProductControls(await headers(),(await params).id,(await searchParams).cursor);}catch(e){if(e instanceof AdminAuthorizationError)redirect(e.reason==="PERMISSION_DENIED"?"/admin":"/admin/login?reason=expired");return <ControlsError/>;}return <AdminSession dashboard={data.dashboard} currentPage="products"><ProductControlsView data={data}/></AdminSession>;}
