import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { readCms } from "@/lib/admin-cms";
import { AdminAuthorizationError } from "@/lib/admin-authorization";
import type { CmsKind } from "@/lib/cms-validation";
import AdminSession from "../admin-session";
import CmsView from "./cms-view";
export default async function CmsPage({kinds,title,cursor}:{kinds:CmsKind[];title:string;cursor?:unknown}){let data;try{if(cursor!==undefined&&typeof cursor!=="string")throw Error();data=await readCms(await headers(),kinds,cursor);}catch(e){if(e instanceof AdminAuthorizationError)redirect(e.reason==="PERMISSION_DENIED"?"/admin":"/admin/login?reason=expired");return <section role="alert"><h1>Content unavailable</h1><p>Check access, page selection and database deployment.</p></section>;}return <AdminSession dashboard={data.dashboard} currentPage="content"><CmsView data={data} kinds={kinds} title={title}/></AdminSession>;}
