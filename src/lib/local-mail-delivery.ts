import "server-only";
import { createHash } from "node:crypto";

// Shared approved local-sink protocol. The caller obtains endpoint from the
// fail-closed delivery configuration; no request-supplied destination URL.
export async function sendLocalMail(endpoint:string,message:{id:string;to:string;subject:string;text:string}):Promise<string> {
  const response=await fetch(endpoint,{method:"POST",redirect:"error",signal:AbortSignal.timeout(2000),headers:{"content-type":"application/json","idempotency-key":message.id},body:JSON.stringify({to:message.to,subject:message.subject,text:message.text})});
  if(!response.ok||!response.body)throw new Error("Provider did not confirm acceptance.");
  const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4096)throw new Error("Invalid provider confirmation.");chunks.push(value);}}finally{await reader.cancel();}
  const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(data.accepted!==true||typeof data.messageId!=="string"||!/^[A-Za-z0-9_-]{1,100}$/.test(data.messageId))throw new Error("Invalid provider confirmation.");
  return createHash("sha256").update("invitation-provider-receipt:v1\0").update(data.messageId).digest("hex");
}
