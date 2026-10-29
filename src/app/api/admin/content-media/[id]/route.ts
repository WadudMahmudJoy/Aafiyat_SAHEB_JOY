import { cmsImage } from "@/lib/admin-cms";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return cmsImage(request,(await params).id,true);}
