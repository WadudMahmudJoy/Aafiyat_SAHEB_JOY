import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { readBusiness } from "@/lib/admin-business";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import AdminSession from "./admin-session";
import BusinessView from "./business-view";
export default async function BusinessPage({mode,cursor}:{mode:"settings"|"offers";cursor?:string}){
 let data;try{data=await readBusiness(await headers(),mode,cursor);}catch(e){if(e instanceof AdminAuthorizationError)redirect(e.reason==="PERMISSION_DENIED"?"/admin":"/admin/login?reason=expired");return <section role="alert"><h1>Administration unavailable</h1><p>Check your session and reload.</p></section>;}
 return <AdminSession dashboard={data.dashboard} currentPage={mode==="settings"?"settings":"marketing"}><BusinessView data={data} mode={mode}/></AdminSession>;
}
