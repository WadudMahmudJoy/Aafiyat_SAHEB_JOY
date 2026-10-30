import "server-only";
import { prisma } from "./prisma";
import { auth } from "./auth";
import { requireAdminPermission } from "./admin-authorization";
import { getAdminDashboard } from "./admin-dashboard";
import { ADMIN_PERMISSIONS,hasAdminPermission } from "./admin-permissions";
import { strictBusinessFields,plainText } from "./business-rules";
import { identifier } from "./media-validation";
export const STAFF_ROLES=["PRODUCT_MANAGER","ORDER_MANAGER","MARKETING_MANAGER"] as const;
export const AUDIT_ACTIONS=["settings.update","offer.create","offer.update","content.save","content.upload","content.remove-image","admin.role","admin.activate","admin.deactivate","admin.revoke","invitation.create","invitation.revoke","invitation.expire","invitation.delivery"] as const;
const permissions=["OWNER",...STAFF_ROLES].map(role=>({role,permissions:ADMIN_PERMISSIONS.filter(p=>hasAdminPermission(role,p))}));
class Conflict extends Error{}
class Policy extends Error{}
function version(raw:string){if(!/^[1-9]\d{0,18}$/.test(raw)||BigInt(raw)>BigInt("9223372036854775806"))throw new Policy();return BigInt(raw);}
export async function readStaff(headers:Headers,query:{q?:string;cursor?:string}){
 const viewer=await requireAdminPermission("admins:manage",headers);const dashboard=await getAdminDashboard(headers,"admins:manage");const q=plainText(query.q??"",100),cursor=query.cursor?identifier(query.cursor):undefined;
 const rows=await prisma.adminUser.findMany({where:{...(cursor?{id:{gt:cursor}}:{}),...(q?{user:{OR:[{name:{contains:q,mode:"insensitive"}},{email:{contains:q,mode:"insensitive"}}]}}:{})},orderBy:{id:"asc"},take:21,select:{id:true,active:true,disabledAt:true,governanceVersion:true,createdAt:true,updatedAt:true,role:{select:{name:true}},user:{select:{name:true,email:true,twoFactorEnabled:true,twofactors:{select:{verified:true}}}}}});
 return {dashboard,viewerId:viewer.adminUserId,permissions,rows:rows.slice(0,20).map(r=>({id:r.id,name:r.user.name,email:r.user.email,role:r.role.name,active:r.active&&r.disabledAt===null,mfa:r.user.twoFactorEnabled===true&&r.user.twofactors.length===1&&r.user.twofactors[0].verified===true,version:r.governanceVersion.toString(),createdAt:r.createdAt.toISOString(),updatedAt:r.updatedAt.toISOString()})),nextCursor:rows.length>20?rows[19].id:null,q};
}
export async function changeStaff(headers:Headers,form:FormData){try{
 const base=auth.options.baseURL;if(typeof base!=="string"||headers.get("origin")!==new URL(base).origin||headers.get("sec-fetch-site")==="cross-site")throw new Policy();
 const actor=await requireAdminPermission("admins:manage",headers);if(actor.role!=="OWNER")throw new Policy();
 const v=strictBusinessFields(form,["id","version","operation","role","confirm"]),id=identifier(v.id),expected=version(v.version);
 if(!["role","activate","deactivate","revoke"].includes(v.operation)||v.confirm!=="CONFIRM"||!STAFF_ROLES.includes(v.role as typeof STAFF_ROLES[number]))throw new Policy();
 if(id===actor.adminUserId)throw new Policy();
 const target=await prisma.adminUser.findUnique({where:{id},select:{userId:true}});if(!target)throw new Policy();
 await prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;await tx.$executeRaw`SET LOCAL statement_timeout='5s'`;
  // Serializes last-Owner decisions. Per-identity locks match bootstrap and session MFA proof writes.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(88009,1)`;
  for(const user of [...new Set([actor.userId,target.userId])].sort())await tx.$executeRaw`SELECT pg_advisory_xact_lock(88008,hashtext(${user}))`;
  await tx.$queryRaw`SELECT id FROM admin_users WHERE id IN (${actor.adminUserId}::uuid,${id}::uuid) ORDER BY id FOR UPDATE`;
  const fresh=await requireAdminPermission("admins:manage",headers,tx);if(fresh.adminUserId!==actor.adminUserId||fresh.role!=="OWNER")throw new Policy();
  const old=await tx.adminUser.findUniqueOrThrow({where:{id},include:{role:true,user:{select:{twoFactorEnabled:true,twofactors:{select:{verified:true}}}}}});
  if(old.userId!==target.userId||old.governanceVersion!==expected)throw new Conflict();
  const active=old.active&&old.disabledAt===null;
  if(v.operation==="role"&&(old.role.name==="OWNER"||old.role.name===v.role)||v.operation==="activate"&&(active||old.role.name==="OWNER"||!old.user.twoFactorEnabled||old.user.twofactors.length!==1||!old.user.twofactors[0].verified)||v.operation==="deactivate"&&!active)throw new Policy();
  if(v.operation==="deactivate"&&old.role.name==="OWNER"&&await tx.adminUser.count({where:{active:true,disabledAt:null,role:{name:"OWNER"}}})<=1)throw new Policy();
  const nextRole=v.operation==="role"?await tx.adminRole.findUniqueOrThrow({where:{name:v.role as typeof STAFF_ROLES[number]}}):old.role;
  // Millisecond precision matches Better Auth's createdAt and challenge timestamps. Equality fails closed.
  await tx.$executeRaw`UPDATE admin_users SET role_id=${nextRole.id}::uuid,active=${v.operation==="activate"?true:v.operation==="deactivate"?false:old.active},disabled_at=CASE WHEN ${v.operation}='deactivate' THEN clock_timestamp() WHEN ${v.operation}='activate' THEN NULL ELSE disabled_at END,governance_version=governance_version+1,authorization_not_before=GREATEST(clock_timestamp(),authorization_not_before+interval '1 millisecond'),updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${id}::uuid`;
  const revoked=await tx.session.deleteMany({where:{userId:old.userId}});
  await tx.auditLog.create({data:{actorId:actor.adminUserId,action:"admin."+v.operation,entityId:id,summary:{version:(expected+BigInt(1)).toString(),fromRole:old.role.name,toRole:nextRole.name,active:v.operation==="activate"?true:v.operation==="deactivate"?false:active,revokedSessions:revoked.count}}});
 },{maxWait:5000,timeout:15000});return {ok:true,message:"Administrator updated. Existing sessions revoked; fresh password and TOTP login required."};
 }catch(e){return {ok:false,message:e instanceof Conflict?"This membership changed. Reload before trying again.":"Change denied or not confirmed. Check permission, MFA, membership state and confirmation; reload current data."};}}
function instant(raw:string){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(raw))throw new Policy();const d=new Date(raw);if(!Number.isFinite(d.getTime())||d.toISOString()!==raw.slice(0,23)+"Z")throw new Policy();return raw;}
export async function readAudit(headers:Headers,query:{action?:string;actor?:string;entity?:string;cursor?:string}){
 const dashboard=await getAdminDashboard(headers,"audit:read"),action=query.action??"",actor=query.actor?identifier(query.actor):null,entity=plainText(query.entity??"",40);
 if(action&&!AUDIT_ACTIONS.includes(action as typeof AUDIT_ACTIONS[number]))throw new Policy();
 let at:string|null=null,id:string|null=null;if(query.cursor){if(query.cursor.length>240)throw new Policy();const cursor=JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8"));if(!Array.isArray(cursor)||cursor.length!==2)throw new Policy();at=instant(cursor[0]);id=identifier(cursor[1]);}
 const rows=await prisma.$queryRaw<{id:string;actor_id:string;actor_name:string;action:string;entity_id:string;at:string;summary:unknown}[]>`SELECT a.id,a.actor_id,u.name AS actor_name,a.action,a.entity_id,to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,a.summary FROM audit_logs a JOIN admin_users m ON m.id=a.actor_id JOIN auth_users u ON u.id=m.user_id WHERE (${action}='' OR a.action=${action}) AND (${actor}::uuid IS NULL OR a.actor_id=${actor}::uuid) AND (${entity}='' OR a.entity_id=${entity}) AND (${at}::timestamptz IS NULL OR (a.created_at,a.id)<(${at}::timestamptz,${id}::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT 21`;
 // Do not render arbitrary historic JSON payloads: only known safe scalar categories.
 const safe=["version","noticeVersion","changed","kind","state","active","retainedTombstone","fromRole","toRole","revokedSessions","attempts"];
 const output=rows.slice(0,20).map(r=>({...r,summary:Object.fromEntries(Object.entries(r.summary as Record<string,unknown>).filter(([k,v])=>safe.includes(k)&&(typeof v==="boolean"||typeof v==="number"||typeof v==="string"&&/^[A-Za-z0-9_.-]{1,40}$/.test(v)||k==="changed"&&Array.isArray(v)&&v.every(x=>["shipping","lowStock","consent"].includes(x)))))}));
 const last=output.at(-1);return {dashboard,rows:output,nextCursor:rows.length>20&&last?Buffer.from(JSON.stringify([last.at,last.id])).toString("base64url"):null};
}
