import "server-only";
import { createHash,createHmac,randomInt } from "node:crypto";
import { invitationEncryptionKey } from "./invitation-secrets";
export function mailboxKey(raw:string|undefined,auth:string|undefined,delivery:string|undefined):Buffer {
  const key=invitationEncryptionKey(raw,auth);
  if(!key||raw===delivery)throw new Error("Mailbox verification unavailable.");
  return key;
}
export const newMailboxCode=()=>randomInt(0,100000000).toString().padStart(8,"0");
export const mailboxVerifier=(key:Buffer,attempt:string,challenge:string,code:string)=>createHmac("sha256",key).update(`staff-mailbox:v1:${attempt}:${challenge}:${code}`).digest("hex");
export const attemptVerifier=(raw:string)=>createHash("sha256").update("staff-onboarding:v1\0").update(raw).digest("hex");
export function validAttemptCookie(raw:string):boolean {
  const parts=raw.split(".");return parts.length===2&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[0])&&/^[A-Za-z0-9_-]{43}$/.test(parts[1])&&Buffer.from(parts[1],"base64url").toString("base64url")===parts[1];
}
export function passwordInput(password:unknown,confirmation:unknown,min:number,max:number):string {
  if(typeof password!=="string"||typeof confirmation!=="string"||password!==confirmation||password.length<min||password.length>max||password.includes("\0"))throw new Error("Check the password and confirmation.");
  return password;
}
