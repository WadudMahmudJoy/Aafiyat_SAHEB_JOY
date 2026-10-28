"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { acknowledgeOrder } from "@/lib/admin-orders";
export type AckState = { message: string; saved?: boolean };
export async function acknowledgeAction(_previous: AckState, data: FormData): Promise<AckState> {
  const form=new FormData();for(const[k,v]of data.entries())if(!k.startsWith("$ACTION_"))form.append(k,v);
  const result=await acknowledgeOrder(await headers(),form);
  if(!result.ok)return {message:result.message};
  revalidatePath("/admin","layout");
  return {saved:true,message:`Acknowledged by ${result.actor} at ${result.acknowledgedAt}. Payment and fulfillment are unchanged.`};
}
