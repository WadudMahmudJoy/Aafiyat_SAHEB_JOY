"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { writeBusiness } from "@/lib/admin-business";
export async function saveBusiness(mode:"settings"|"offers",_previous:{ok:boolean;message:string},data:FormData){
 const input=new FormData();for(const [k,v]of data.entries())if(!k.startsWith("$ACTION_"))input.append(k,v);
 const result=await writeBusiness(await headers(),mode,input);
 if(result.ok){revalidatePath("/admin","layout");revalidatePath("/","layout");}
 return result;
}
