"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { mutateCatalog } from "@/lib/admin-catalog-controls";
export type ControlState={message:string;saved?:boolean;uncertain?:boolean};
export async function catalogAction(_previous:ControlState,data:FormData):Promise<ControlState>{try{const input=new FormData();for(const[k,v]of data.entries())if(!k.startsWith("$ACTION_"))input.append(k,v);const result=await mutateCatalog(await headers(),input);if(!result.ok)return {message:result.message,uncertain:result.code==="UNAVAILABLE"};revalidatePath("/admin","layout");revalidatePath("/","layout");return {saved:true,message:result.message};}catch{return {message:"The response was interrupted. Retain the same upload file, fields and key when retrying; otherwise reload to inspect current state.",uncertain:true};}}
