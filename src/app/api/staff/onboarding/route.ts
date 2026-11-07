import { NextResponse } from "next/server";
import { ONBOARDING_COOKIE,runOnboarding,onboardingStatus } from "@/lib/staff-onboarding";
import { auth } from "@/lib/auth";
import type { NextRequest } from "next/server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store, private","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"};
const failure=()=>NextResponse.json({ok:false,message:"Unable to continue. Check your invitation or contact the inviting administrator."},{status:400,headers});
export async function POST(request:NextRequest){
  try{
    const base=auth.options.baseURL;
    if(typeof base!=="string"||request.headers.get("origin")!==new URL(base).origin||request.headers.get("sec-fetch-site")==="cross-site"||request.headers.get("x-staff-onboarding")!=="1"||request.headers.get("content-type")?.split(";",1)[0].trim()!=="application/json"||!request.body)return failure();
    const reader=request.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096)return failure();chunks.push(value);}}finally{await reader.cancel();}
    const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const envelope=await runOnboarding(request.headers,request.cookies.get(ONBOARDING_COOKIE)?.value,input);
    const response=NextResponse.json(envelope.result,{headers});
    if(envelope.capability)response.cookies.set(ONBOARDING_COOKIE,envelope.capability,{httpOnly:true,secure:new URL(base).protocol==="https:",sameSite:"strict",path:"/api/staff/onboarding",maxAge:1800});
    return response;
  }catch{return failure();}
}
export async function GET(request:NextRequest){
  if(request.headers.get("x-staff-onboarding")!=="1"||request.headers.get("sec-fetch-site")==="cross-site")return failure();
  return NextResponse.json(await onboardingStatus(request.cookies.get(ONBOARDING_COOKIE)?.value),{headers});
}
