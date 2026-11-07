import "server-only";
import { randomBytes,randomUUID,timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { BetterAuthOptions } from "better-auth";
import { prisma } from "./prisma";
import { auth } from "./auth";
import { STAFF_ROLES } from "./admin-governance";
import { invitationVerifier,credentialEmailAccepted } from "./invitation-secrets";
import { invitationDeliveryConfig } from "./invitation-delivery-config";
import { sendLocalMail } from "./local-mail-delivery";
import { expireInvitation,invitationNow,lockInvitationTransaction,invitationTransactionOptions } from "./admin-invitations";
import { attemptVerifier,validAttemptCookie,mailboxKey,newMailboxCode,mailboxVerifier,passwordInput } from "./onboarding-secrets";

export const ONBOARDING_COOKIE="aafiyat_staff_onboarding";
export type OnboardingResult={ok:boolean;message:string;stage?:"verifying"|"mailbox_verified"|"provisioned"};
type Envelope={result:OnboardingResult;capability?:string};
const denied=():OnboardingResult=>({ok:false,message:"Unable to continue. Check your invitation or contact the inviting administrator."});
const unavailable=():OnboardingResult=>({ok:false,message:"Mailbox verification delivery is unavailable. Contact the inviting administrator."});
const progress=(state:string):OnboardingResult=>({ok:true,stage:state as OnboardingResult["stage"],message:state==="provisioned"?"Password setup complete. Sign in to enroll your authenticator and activate your staff membership.":state==="mailbox_verified"?"Mailbox verified. Choose and confirm your password.":"Invitation accepted for verification only. Request a mailbox code to continue."});
const equal=(a:string,b:string)=>/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
function eligible(inv:{email:string;state:string;deliveryState:string;expiresAt:Date;role:string;deliveredAt:Date|null;providerReceiptHash:string|null},now:Date){return credentialEmailAccepted(inv.email)&&inv.state==="delivered"&&inv.deliveryState==="delivered"&&inv.deliveredAt!==null&&inv.providerReceiptHash!==null&&inv.expiresAt>now&&STAFF_ROLES.includes(inv.role as typeof STAFF_ROLES[number]);}
function trusted(headers:Headers){const base=auth.options.baseURL;if(typeof base!=="string"||headers.get("origin")!==new URL(base).origin||headers.get("sec-fetch-site")==="cross-site")throw new Error("Denied");}
const budgets={start:30,request_code:30,verify:120,provision:20} as const;
async function budget(operation:keyof typeof budgets){return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;await tx.$executeRaw`SELECT pg_advisory_xact_lock(88011,1)`;
  const now=await invitationNow(tx),row=await tx.staffOnboardingLimit.findUnique({where:{scope:operation}});
  if(row&&now.getTime()-row.windowStart.getTime()<60000&&row.attempts>=budgets[operation])return false;
  await tx.staffOnboardingLimit.upsert({where:{scope:operation},create:{scope:operation,windowStart:now,attempts:1},update:!row||now.getTime()-row.windowStart.getTime()>=60000?{windowStart:now,attempts:1}:{attempts:{increment:1}}});return true;
},invitationTransactionOptions);}
async function audit(tx:Prisma.TransactionClient,actor:string,action:string,id:string,state:string){await tx.auditLog.create({data:{actorId:actor,action,entityId:id,summary:{kind:"recipient",state}}});}
async function closeAttempt(tx:Prisma.TransactionClient,id:string,state:"expired"|"abandoned",actor:string){
  const row=await tx.adminOnboarding.findUniqueOrThrow({where:{id}});if(["expired","abandoned"].includes(row.state))return;
  const now=await invitationNow(tx);await tx.adminMailboxChallenge.updateMany({where:{onboardingId:id,consumedAt:null,invalidatedAt:null},data:{invalidatedAt:now}});
  await tx.adminOnboarding.update({where:{id},data:{state,closedAt:now,version:{increment:1}}});await audit(tx,actor,"onboarding.close",id,state);
}
async function bound(tx:Prisma.TransactionClient,raw:string|undefined){
  if(!raw||!validAttemptCookie(raw))return null;const id=raw.split(".")[0];const first=await tx.adminOnboarding.findUnique({where:{id}});if(!first||!equal(first.capabilityHash,attemptVerifier(raw)))return null;
  await tx.$queryRaw`SELECT id FROM admin_invitations WHERE id=${first.invitationId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM admin_onboarding WHERE id=${id}::uuid FOR UPDATE`;
  const row=await tx.adminOnboarding.findUniqueOrThrow({where:{id},include:{invitation:true,verifiedChallenge:true}}),now=await invitationNow(tx);
  if(!eligible(row.invitation,now)||["expired","abandoned"].includes(row.state))return null;
  if(row.expiresAt<=now){if(row.state!=="provisioned")await closeAttempt(tx,id,"expired",row.invitation.invitedBy);return null;}
  return row;
}
async function begin(raw:string|undefined,id:string,secret:string):Promise<Envelope>{
  if(!/^[a-f0-9-]{36}$/.test(id))return {result:denied()};const hash=invitationVerifier(secret);
  return prisma.$transaction(async tx=>{
    await lockInvitationTransaction(tx);await tx.$queryRaw`SELECT id FROM admin_invitations WHERE id=${id}::uuid FOR UPDATE`;
    const inv=await tx.adminInvitation.findUnique({where:{id}}),now=await invitationNow(tx);
    if(!inv||!eligible(inv,now)||!equal(inv.tokenHash,hash))return {result:denied()};
    const resumed=await bound(tx,raw);if(resumed?.invitationId===id)return {result:progress(resumed.state)};
    const active=await tx.adminOnboarding.findMany({where:{invitationId:id,state:{in:["verifying","mailbox_verified","provisioned"]}}});
    for(const row of active)if(row.expiresAt<=now&&row.state!=="provisioned")await closeAttempt(tx,row.id,"expired",inv.invitedBy);
    if(active.some(row=>row.expiresAt>now)||await tx.user.findFirst({where:{email:{equals:inv.email,mode:"insensitive"}},select:{id:true}})||await tx.adminOnboarding.count({where:{invitationId:id}})>=3)return {result:denied()};
    const attemptId=randomUUID(),capability=attemptId+"."+randomBytes(32).toString("base64url");
    await tx.adminOnboarding.create({data:{id:attemptId,invitationId:id,capabilityHash:attemptVerifier(capability),createdAt:now,expiresAt:new Date(Math.min(inv.expiresAt.getTime(),now.getTime()+1800000))}});
    await audit(tx,inv.invitedBy,"onboarding.start",attemptId,"verifying");return {result:progress("verifying"),capability};
  },invitationTransactionOptions);
}
async function requestCode(raw:string|undefined):Promise<OnboardingResult>{
  const claim=await prisma.$transaction(async tx=>{
    await lockInvitationTransaction(tx);const row=await bound(tx,raw);if(!row||!["verifying","mailbox_verified"].includes(row.state))return {error:denied()};
    let config:ReturnType<typeof invitationDeliveryConfig>,key:Buffer;
    try{config=invitationDeliveryConfig();key=mailboxKey(process.env.STAFF_ONBOARDING_VERIFICATION_KEY,process.env.BETTER_AUTH_SECRET,process.env.ADMIN_INVITATION_ENCRYPTION_KEY);if(!config.endpoint)return {error:unavailable()};}catch{return {error:unavailable()};}
    const now=await invitationNow(tx);
    if(row.mailRequests>=3||row.verificationAttempts>=10||row.lastMailAt&&now.getTime()-row.lastMailAt.getTime()<60000||await tx.adminMailboxChallenge.count({where:{onboarding:{invitationId:row.invitationId},createdAt:{gte:new Date(now.getTime()-3600000)}}})>=5)return {error:denied()};
    const old=await tx.adminMailboxChallenge.findMany({where:{onboardingId:row.id}});let code=newMailboxCode();while(old.some(c=>equal(c.verifier,mailboxVerifier(key,row.id,c.id,code))))code=newMailboxCode();
    await tx.adminMailboxChallenge.updateMany({where:{onboardingId:row.id,consumedAt:null,invalidatedAt:null},data:{invalidatedAt:now}});
    const id=randomUUID();await tx.adminMailboxChallenge.create({data:{id,onboardingId:row.id,verifier:mailboxVerifier(key,row.id,id,code),createdAt:now,expiresAt:new Date(Math.min(now.getTime()+600000,row.expiresAt.getTime(),row.invitation.expiresAt.getTime()))}});
    await tx.adminOnboarding.update({where:{id:row.id},data:{state:"verifying",mailboxVerifiedAt:null,verifiedChallengeId:null,mailRequests:{increment:1},lastMailAt:now,version:{increment:1}}});await audit(tx,row.invitation.invitedBy,"onboarding.mail",row.id,"pending");
    return {id,code,endpoint:config.endpoint,attemptId:row.id};
  },invitationTransactionOptions);
  if("error"in claim)return claim.error!;
  return prisma.$transaction(async tx=>{
    await lockInvitationTransaction(tx);const row=await bound(tx,raw);if(!row||row.id!==claim.attemptId||row.state!=="verifying")return denied();
    const challenge=await tx.adminMailboxChallenge.findUniqueOrThrow({where:{id:claim.id}}),started=await invitationNow(tx);
    if(challenge.deliveryState!=="pending"||challenge.invalidatedAt||challenge.consumedAt||challenge.expiresAt<=started)return denied();
    let receipt:string|null=null;
    try{receipt=await sendLocalMail(claim.endpoint,{id:claim.id,to:row.invitation.email,subject:"Aafiyat mailbox verification",text:`Your Aafiyat mailbox verification code is ${claim.code}. Expires: ${challenge.expiresAt.toISOString()}. This does not activate an administrator account.`});}catch{/* Never log code, request or provider payload. */}
    const now=await invitationNow(tx),expired=now>=challenge.expiresAt||now>=row.expiresAt||now>=row.invitation.expiresAt;
    await tx.adminMailboxChallenge.update({where:{id:claim.id},data:{deliveryState:receipt?"delivered":"failed",deliveredAt:receipt?now:null,receiptHash:receipt,invalidatedAt:!receipt||expired?now:null}});
    await audit(tx,row.invitation.invitedBy,"onboarding.mail",row.id,receipt?"delivered":"failed");
    if(row.invitation.expiresAt<=now){await expireInvitation(tx,row.invitationId);return denied();}
    if(row.expiresAt<=now){await closeAttempt(tx,row.id,"expired",row.invitation.invitedBy);return denied();}
    return receipt&&!expired?{ok:true,stage:"verifying",message:"Verification message accepted by the mail provider. Enter the eight-digit code from your mailbox."}:unavailable();
  },invitationTransactionOptions);
}
async function verifyCode(raw:string|undefined,code:string):Promise<OnboardingResult>{return prisma.$transaction(async tx=>{
  await lockInvitationTransaction(tx);const row=await bound(tx,raw);if(!row||row.state!=="verifying"||row.verificationAttempts>=10||!/^\d{8}$/.test(code))return denied();
  const key=mailboxKey(process.env.STAFF_ONBOARDING_VERIFICATION_KEY,process.env.BETTER_AUTH_SECRET,process.env.ADMIN_INVITATION_ENCRYPTION_KEY),now=await invitationNow(tx);
  const challenge=await tx.adminMailboxChallenge.findFirst({where:{onboardingId:row.id,consumedAt:null,invalidatedAt:null},orderBy:{createdAt:"desc"}});
  if(!challenge||challenge.deliveryState!=="delivered"||challenge.expiresAt<=now||challenge.attempts>=5)return denied();
  const valid=equal(challenge.verifier,mailboxVerifier(key,row.id,challenge.id,code));
  await tx.adminMailboxChallenge.update({where:{id:challenge.id},data:{attempts:{increment:1},...(valid?{consumedAt:now}:challenge.attempts>=4?{invalidatedAt:now}:{})}});
  await tx.adminOnboarding.update({where:{id:row.id},data:{verificationAttempts:{increment:1},version:{increment:1},...(valid?{state:"mailbox_verified",mailboxVerifiedAt:now,verifiedChallengeId:challenge.id}:{})}});
  if(!valid)return denied();await audit(tx,row.invitation.invitedBy,"onboarding.verify",row.id,"mailbox_verified");return progress("mailbox_verified");
},invitationTransactionOptions);}
async function provision(raw:string|undefined,password:string,confirmation:string):Promise<OnboardingResult>{
  const context=await auth.$context;
  let input:string;try{input=passwordInput(password,confirmation,context.password.config.minPasswordLength,context.password.config.maxPasswordLength);}catch{return {ok:false,message:`Use ${context.password.config.minPasswordLength}–${context.password.config.maxPasswordLength} characters and matching password confirmation.`};}
  const ready=await prisma.$transaction(async tx=>{await lockInvitationTransaction(tx);const row=await bound(tx,raw),now=await invitationNow(tx);return row?.state==="provisioned"?"done":row?.state==="mailbox_verified"&&row.mailboxVerifiedAt?now.getTime()-row.mailboxVerifiedAt.getTime()<=600000?"ready":"expired":"denied";},invitationTransactionOptions);
  if(ready!=="ready")return ready==="done"?progress("provisioned"):ready==="expired"?{ok:false,message:"Mailbox verification expired. Request a new code to continue."}:denied();
  // Pinned Better Auth 1.7.7 uses this exact configured hasher and credential
  // tuple. Write its existing tables through the same Prisma transaction as
  // membership/progress/audit; internalAdapter writes are not transaction-bound.
  const options:BetterAuthOptions=auth.options;
  if(options.databaseHooks?.user?.create||options.databaseHooks?.account?.create||options.user?.validateUserInfo)throw new Error("Provisioning integration requires review.");
  const hash=await context.password.hash(input);
  return prisma.$transaction(async tx=>{
    await lockInvitationTransaction(tx);const row=await bound(tx,raw);if(!row)return denied();if(row.state==="provisioned")return progress("provisioned");
    const now=await invitationNow(tx),proof=row.mailboxVerifiedAt,challenge=row.verifiedChallenge;
    if(row.state!=="mailbox_verified"||!proof||proof>now||now.getTime()-proof.getTime()>600000||!challenge||challenge.onboardingId!==row.id||!challenge.consumedAt||challenge.invalidatedAt||challenge.consumedAt.getTime()!==proof.getTime()||await tx.user.findFirst({where:{email:{equals:row.invitation.email,mode:"insensitive"}},select:{id:true}}))return denied();
    const userId=randomUUID(),membershipId=randomUUID();await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008,hashtext(${userId}))`;
    const role=await tx.adminRole.findUniqueOrThrow({where:{name:row.invitation.role}});
    await tx.user.create({data:{id:userId,email:row.invitation.email,name:"Invited staff",emailVerified:true,twoFactorEnabled:false,createdAt:now,updatedAt:now}});
    await tx.account.create({data:{id:randomUUID(),userId,providerId:"credential",accountId:userId,password:hash,createdAt:now,updatedAt:now}});
    await tx.adminUser.create({data:{id:membershipId,userId,roleId:role.id,active:false,disabledAt:null,authorizationNotBefore:now}});
    await tx.adminOnboarding.update({where:{id:row.id},data:{state:"provisioned",userId,membershipId,provisionedAt:now,version:{increment:1}}});
    await audit(tx,membershipId,"onboarding.provision",row.id,"inactive");
    const finalTime=await invitationNow(tx);
    if(row.invitation.expiresAt<=finalTime||row.expiresAt<=finalTime||proof>finalTime||finalTime.getTime()-proof.getTime()>600000)throw new Error("Provisioning deadline expired.");
    return progress("provisioned");
  },invitationTransactionOptions);
}
export async function runOnboarding(headers:Headers,raw:string|undefined,input:unknown):Promise<Envelope>{
  try{
    trusted(headers);if(!input||typeof input!=="object"||Array.isArray(input))return {result:denied()};const values=input as Record<string,unknown>,op=values.operation;
    if(typeof op!=="string"||!Object.hasOwn(budgets,op))return {result:denied()};
    const allowed=op==="start"?["operation","invitationId","secret"]:op==="verify"?["operation","code"]:op==="provision"?["operation","password","confirmation"]:["operation"];
    if(Object.keys(values).length!==allowed.length||allowed.some(k=>typeof values[k]!=="string")||Object.keys(values).some(k=>!allowed.includes(k)))return {result:denied()};
    if(!await budget(op as keyof typeof budgets))return {result:{ok:false,message:"Too many requests. Try again later."}};
    if(op==="start")return await begin(raw,values.invitationId as string,values.secret as string);
    const result=op==="request_code"?await requestCode(raw):op==="verify"?await verifyCode(raw,values.code as string):await provision(raw,values.password as string,values.confirmation as string);return {result};
  }catch{return {result:denied()};}
}
export async function onboardingStatus(raw:string|undefined):Promise<OnboardingResult>{
  try{if(!raw||!validAttemptCookie(raw))return denied();const row=await prisma.adminOnboarding.findUnique({where:{id:raw.split(".")[0]},include:{invitation:true}});const now=new Date();return row&&equal(row.capabilityHash,attemptVerifier(raw))&&row.expiresAt>now&&eligible(row.invitation,now)&&["verifying","mailbox_verified","provisioned"].includes(row.state)?progress(row.state):denied();}catch{return denied();}
}
