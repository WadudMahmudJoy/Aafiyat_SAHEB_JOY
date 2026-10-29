import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { auth } from "./auth";
import { getAdminDashboard } from "./admin-dashboard";
import { requireAdminPermission } from "./admin-authorization";
import { BusinessInputError,strictBusinessFields,minorUnits,plainText,boundedInteger,booleanText,utcInstant } from "./business-rules";
import { storageConfigured } from "./media-storage";
type Settings={version:bigint;free_shipping_threshold_minor:bigint;low_stock_threshold:number|null;consent_visible:boolean;consent_notice:string;consent_version:number;exchange_days:number;exchange_anchor:string;reviews_enabled:boolean};
type OfferRow={id:string;name:string;coupon_code:string|null;kind:string;value:bigint;starts_at:Date;ends_at:Date;active:boolean;version:bigint};
class Conflict extends Error{}
function revision(value:string){if(!/^[1-9]\d{0,18}$/.test(value)||BigInt(value)>BigInt("9223372036854775806"))throw new BusinessInputError();return BigInt(value);}
function uuid(value:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new BusinessInputError();return value.toLowerCase();}
const settingsDto=(r:Settings)=>({...r,version:r.version.toString(),free_shipping_threshold_minor:r.free_shipping_threshold_minor.toString()});
const offerDto=(r:OfferRow)=>({...r,version:r.version.toString(),value:r.value.toString(),starts_at:r.starts_at.toISOString(),ends_at:r.ends_at.toISOString()});
export async function readBusiness(headers:Headers,mode:"settings"|"offers",cursor?:string){
 const permission=mode==="settings"?"settings:manage":"marketing:manage";
 const dashboard=await getAdminDashboard(headers,permission);
 const after=cursor?uuid(cursor):null;
 const [present]=await prisma.$queryRaw<{present:boolean}[]>`SELECT to_regclass('public.business_settings') IS NOT NULL AND to_regclass('public.offers') IS NOT NULL AS present`;
 if(!present.present)return {dashboard,available:false as const,settings:null,offers:[],nextCursor:null,audit:[],storage:storageConfigured()};
 const [settings]=await prisma.$queryRaw<Settings[]>`SELECT * FROM business_settings WHERE id=true`;
 const offers=mode==="offers"?await prisma.$queryRaw<OfferRow[]>`SELECT * FROM offers WHERE (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT 21`:[];
 const prefix=mode==="settings"?"settings.update":"offer.%";
 const audit=await prisma.$queryRaw<{id:string;action:string;entity_id:string;summary:Prisma.JsonValue;at:string}[]>`SELECT id,action,entity_id,summary,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM audit_logs WHERE action LIKE ${prefix} ORDER BY created_at DESC,id DESC LIMIT 20`;
 return {dashboard,available:true as const,settings:mode==="settings"?settingsDto(settings):null,offers:offers.slice(0,20).map(offerDto),nextCursor:offers.length>20?offers[19].id:null,audit,storage:storageConfigured()};
}
export type BusinessResult={ok:boolean;message:string};
export async function writeBusiness(headers:Headers,mode:"settings"|"offers",form:FormData):Promise<BusinessResult>{
 try{
  const base=auth.options.baseURL;if(typeof base!=="string"||headers.get("origin")!==new URL(base).origin||headers.get("sec-fetch-site")==="cross-site")return {ok:false,message:"Access denied."};
  const actor=await requireAdminPermission(mode==="settings"?"settings:manage":"marketing:manage",headers);
  if(mode==="settings"){
   const v=strictBusinessFields(form,["version","threshold","lowStock","consentVisible","consentNotice"]);
   const version=revision(v.version),threshold=minorUnits(v.threshold),low=v.lowStock===""?null:boundedInteger(v.lowStock),visible=booleanText(v.consentVisible),notice=plainText(v.consentNotice,1000);
   if(visible&&!notice)throw new BusinessInputError();
   await prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;
    const [old]=await tx.$queryRaw<Settings[]>`SELECT * FROM business_settings WHERE id=true FOR UPDATE`;
    if(!old||old.version!==version)throw new Conflict();
    const noticeVersion=old.consent_version+(old.consent_notice===notice?0:1);
    await tx.$executeRaw`UPDATE business_settings SET free_shipping_threshold_minor=${threshold},low_stock_threshold=${low},consent_visible=${visible},consent_notice=${notice},consent_version=${noticeVersion},version=version+1,updated_by=${actor.adminUserId}::uuid,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=true`;
    await tx.auditLog.create({data:{actorId:actor.adminUserId,action:"settings.update",entityId:"business_settings",summary:{version:(version+BigInt(1)).toString(),noticeVersion,changed:["shipping","lowStock","consent"]}}});
   },{maxWait:5000,timeout:10000});
  }else{
   const v=strictBusinessFields(form,["id","version","name","coupon","kind","value","startsAt","endsAt","active"]);
   const id=uuid(v.id),version=v.version==="0"?BigInt(0):revision(v.version),name=plainText(v.name,120,true),coupon=plainText(v.coupon,40).toUpperCase()||null,active=booleanText(v.active);
   if(coupon&&!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(coupon)||!["fixed","percentage"].includes(v.kind))throw new BusinessInputError();
   // percentage is entered in percentage points; 12.34% becomes 1234 basis points.
   const value=minorUnits(v.value);if(value<=BigInt(0)||v.kind==="percentage"&&value>BigInt(10000))throw new BusinessInputError();
   const start=utcInstant(v.startsAt),end=utcInstant(v.endsAt);if(start>=end)throw new BusinessInputError();
   await prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;
    if(version===BigInt(0))await tx.$executeRaw`INSERT INTO offers(id,name,coupon_code,kind,value,starts_at,ends_at,active,updated_by) VALUES(${id}::uuid,${name},${coupon},${v.kind},${value},${start}::timestamptz,${end}::timestamptz,${active},${actor.adminUserId}::uuid)`;
    else {const count=await tx.$executeRaw`UPDATE offers SET name=${name},coupon_code=${coupon},kind=${v.kind},value=${value},starts_at=${start}::timestamptz,ends_at=${end}::timestamptz,active=${active},version=version+1,updated_by=${actor.adminUserId}::uuid,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${id}::uuid AND version=${version}`;if(count!==1)throw new Conflict();}
    await tx.auditLog.create({data:{actorId:actor.adminUserId,action:version===BigInt(0)?"offer.create":"offer.update",entityId:id,summary:{version:(version+BigInt(1)).toString(),kind:v.kind,active}}});
   },{maxWait:5000,timeout:10000});
  }
  return {ok:true,message:"Saved. Reload current data before another change."};
 }catch(e){if(e instanceof Conflict)return {ok:false,message:"This record changed. Reload before saving."};if(e instanceof BusinessInputError)return {ok:false,message:"Check the supplied fields, amounts and UTC schedule."};return {ok:false,message:"Save was not confirmed. Check access, duplicate identifiers and current data before retrying."};}
}
export function previewOffer(subtotal:bigint,kind:string,value:bigint){if(subtotal<BigInt(0)||subtotal>BigInt("9223372036854775807")||value<=BigInt(0)||value>BigInt("9223372036854775807")||!["fixed","percentage"].includes(kind)||kind==="percentage"&&value>BigInt(10000))throw new BusinessInputError();const d=kind==="fixed"?value:subtotal*value/BigInt(10000);return d>subtotal?subtotal:d;}
