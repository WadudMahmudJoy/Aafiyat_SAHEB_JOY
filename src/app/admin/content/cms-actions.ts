"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { saveCms,uploadCms,removeCmsImage } from "@/lib/admin-cms";
export async function cmsAction(operation:"save"|"upload"|"remove",_previous:{ok:boolean;message:string;uncertain?:boolean},data:FormData){try{const f=new FormData();for(const [k,v]of data)if(!k.startsWith("$ACTION_"))f.append(k,v);const h=await headers();const r=operation==="save"?await saveCms(h,f):operation==="upload"?await uploadCms(h,f):await removeCmsImage(h,f);if(r.ok)revalidatePath("/admin/content","layout");return {...r,uncertain:operation==="upload"&&!r.ok};}catch{return {ok:false,message:"Response interrupted. Retain this exact upload when retrying, or reload current data.",uncertain:true};}}
