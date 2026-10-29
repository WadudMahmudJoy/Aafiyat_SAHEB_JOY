import { mediaResponse } from "@/lib/media-response";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return mediaResponse(request,(await params).id,true);}
