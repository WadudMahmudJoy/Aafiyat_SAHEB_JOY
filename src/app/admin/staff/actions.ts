"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { changeStaff } from "@/lib/admin-governance";
export async function staffAction(_previous:{ok:boolean;message:string},data:FormData){const input=new FormData();for(const [k,v] of data)if(!k.startsWith("$ACTION_"))input.append(k,v);const result=await changeStaff(await headers(),input);if(result.ok)revalidatePath("/admin","layout");return result;}
