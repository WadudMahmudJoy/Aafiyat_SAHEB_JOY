import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCategoryControls } from "@/lib/admin-catalog-controls";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "../admin-session";
import { CategoriesView,ControlsError } from "../products/catalog-controls-view";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){let data;try{data=await getCategoryControls(await headers(),(await searchParams).cursor);}catch(e){if(e instanceof AdminAuthorizationError)redirect(e.reason==="PERMISSION_DENIED"?"/admin":"/admin/login?reason=expired");return <ControlsError/>;}return <AdminSession dashboard={data.dashboard} currentPage="categories"><CategoriesView data={data}/></AdminSession>;}
