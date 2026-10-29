import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { auth } from "./auth";
import { requireAdminPermission } from "./admin-authorization";
import { getAdminDashboard } from "./admin-dashboard";
import { cmsInput,type CmsKind } from "./cms-validation";
import { BusinessInputError } from "./business-rules";
import { identifier,strictFields,decodeImage,digest,contentObjectKey,CatalogControlError } from "./media-validation";
import { storeVerified,readObject,deleteObject,storageConfigured } from "./media-storage";
type Tx=Prisma.TransactionClient;
class Conflict extends Error{}
async function transaction<T>(run:(tx:Tx)=>Promise<T>){return prisma.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;await tx.$executeRaw`SET LOCAL statement_timeout='5s'`;return run(tx);},{maxWait:5000,timeout:15000});}
async function writer(headers:Headers){const base=auth.options.baseURL;if(typeof base!=="string"||headers.get("origin")!==new URL(base).origin||headers.get("sec-fetch-site")==="cross-site")throw new Error("Access denied");return requireAdminPermission("content:manage",headers);}
const select={id:true,kind:true,slug:true,title:true,subtitle:true,body:true,ctaLabel:true,ctaUrl:true,seoTitle:true,seoDescription:true,state:true,visible:true,sortOrder:true,measurements:true,version:true,coverId:true,references:{orderBy:{sortOrder:"asc" as const},select:{productId:true,categoryId:true}},cover:{select:{state:true}}} satisfies Prisma.ContentEntrySelect;
export async function readCms(headers:Headers,kinds:CmsKind[],cursor?:string){
 const dashboard=await getAdminDashboard(headers,"content:manage");const after=cursor?identifier(cursor):null;
 const [schema]=await prisma.$queryRaw<{available:boolean}[]>`SELECT to_regclass('public.content_entries') IS NOT NULL AS available`;
 if(!schema.available)return {dashboard,available:false,entries:[],nextCursor:null,products:[],categories:[],storage:storageConfigured()};
 const rows=await prisma.contentEntry.findMany({where:{kind:{in:kinds},...(after?{id:{gt:after}}:{})},orderBy:{id:"asc"},take:21,select});
 const products=await prisma.product.findMany({where:{lifecycle:"active",archivedAt:null,category:{active:true},variants:{some:{active:true,archivedAt:null,priceMinor:{gt:BigInt(0)},currency:"BDT"}},gallery:{some:{asset:{state:"ready"}}}},orderBy:{id:"asc"},take:100,select:{id:true,name:true}});
 const categories=await prisma.category.findMany({where:{active:true},orderBy:[{sortOrder:"asc"},{id:"asc"}],take:100,select:{id:true,name:true}});
 return {dashboard,available:true,entries:rows.slice(0,20).map(r=>({...r,version:r.version.toString()})),nextCursor:rows.length>20?rows[19].id:null,products,categories,storage:storageConfigured()};
}
async function checkReferences(tx:Tx,products:string[],categories:string[],published:boolean){
 for(const id of [...products].sort()){const [p]=await tx.$queryRaw<{eligible:boolean}[]>`SELECT (p.lifecycle='active' AND p.archived_at IS NULL AND c.active AND EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active AND v.archived_at IS NULL AND v.currency='BDT' AND v.price_minor>0) AND EXISTS(SELECT 1 FROM product_media m JOIN media_assets a ON a.id=m.asset_id WHERE m.product_id=p.id AND a.state='ready')) AS eligible FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=${id}::uuid FOR SHARE OF p,c`;if(!p||published&&!p.eligible)throw new BusinessInputError();}
 for(const id of [...categories].sort()){const [c]=await tx.$queryRaw<{active:boolean}[]>`SELECT active FROM categories WHERE id=${id}::uuid FOR SHARE`;if(!c||published&&!c.active)throw new BusinessInputError();}
}
export async function saveCms(headers:Headers,form:FormData){
 try{const actor=await writer(headers),v=cmsInput(form);
 await transaction(async tx=>{
  const [old]=await tx.$queryRaw<{version:bigint;kind:string;cover_id:string|null}[]>`SELECT version,kind,cover_id FROM content_entries WHERE id=${v.id}::uuid FOR UPDATE`;
  if(v.version===BigInt(0)?!!old:!old||old.version!==v.version)throw new Conflict();
  if(old&&old.kind!==v.kind)throw new BusinessInputError();
  const published=v.state==="published";
  if(published&&(["hero","banner"].includes(v.kind)&&!old?.cover_id||v.kind==="page"&&!v.body||v.kind==="size-guide"&&!v.products.length&&!v.categories.length))throw new BusinessInputError();
  await checkReferences(tx,v.products,v.categories,published);
  const data={kind:v.kind,slug:v.slug,title:v.title,subtitle:v.subtitle,body:v.body,ctaLabel:v.ctaLabel,ctaUrl:v.ctaUrl,seoTitle:v.seoTitle,seoDescription:v.seoDescription,state:v.state,visible:v.visible,sortOrder:v.order,measurements:v.table===null?Prisma.DbNull:v.table as unknown as Prisma.InputJsonValue,updatedBy:actor.adminUserId};
  if(old)await tx.contentEntry.update({where:{id:v.id},data:{...data,version:{increment:1},updatedAt:new Date()}});
  else await tx.contentEntry.create({data:{id:v.id,...data}});
  await tx.contentReference.deleteMany({where:{entryId:v.id}});
  for(const [i,id]of v.products.entries())await tx.contentReference.create({data:{entryId:v.id,productId:id,sortOrder:i}});
  for(const [i,id]of v.categories.entries())await tx.contentReference.create({data:{entryId:v.id,categoryId:id,sortOrder:v.products.length+i}});
  await tx.auditLog.create({data:{actorId:actor.adminUserId,action:"content.save",entityId:v.id,summary:{kind:v.kind,state:v.state,version:(v.version+BigInt(1)).toString()}}});
 });return {ok:true,message:"Content saved. Reload current data before another operation."};
 }catch(e){return {ok:false,message:e instanceof Conflict?"This content changed. Reload before saving.":e instanceof BusinessInputError?"Check text, references, image requirements and measurements.":"Content save was not confirmed. Check access, identifiers and current data."};}
}
export async function uploadCms(headers:Headers,form:FormData){
 try{const actor=await writer(headers),v=strictFields(form,["entryId","version","idempotencyKey","file"]),entryId=identifier(v.entryId),key=identifier(v.idempotencyKey);
 if(typeof v.version!=="string"||!/^[1-9]\d{0,15}$/.test(v.version))throw new BusinessInputError();const version=BigInt(v.version);
 if(!storageConfigured())throw new Error("Storage unavailable");const image=await decodeImage(v.file),attempt=randomUUID(),fingerprint=digest(JSON.stringify({v:1,actor:actor.adminUserId,entryId,version:version.toString(),source:image.sourceHash}));
 const asset=await transaction(async tx=>{
  const [entry]=await tx.$queryRaw<{version:bigint}[]>`SELECT version FROM content_entries WHERE id=${entryId}::uuid FOR UPDATE`;if(!entry)throw new BusinessInputError();
  let saved=await tx.contentAsset.findUnique({where:{idempotencyKey:key}});
  if(saved){if(saved.entryId!==entryId||saved.actorId!==actor.adminUserId||saved.fingerprint!==fingerprint)throw new Conflict();if(saved.readyAt)return saved;if(saved.state!=="pending")throw new Conflict();}
  else {if(entry.version!==version)throw new Conflict();const id=randomUUID();saved=await tx.contentAsset.create({data:{id,entryId,actorId:actor.adminUserId,objectKey:contentObjectKey(entryId,id),idempotencyKey:key,fingerprint,storedHash:image.storedHash,byteSize:image.bytes.length,width:image.width,height:image.height}});}
  const count=await tx.$executeRaw`UPDATE content_assets SET attempt_id=${attempt}::uuid,attempt_until=clock_timestamp()+interval '60 seconds' WHERE id=${saved.id}::uuid AND state='pending' AND created_at>clock_timestamp()-interval '24 hours' AND (attempt_id IS NULL OR attempt_until<clock_timestamp())`;if(count!==1)throw new Conflict();return saved;
 });
 if(asset.readyAt)return {ok:true,message:"Previously recorded image receipt. Reload current content."};
 try{await storeVerified(asset.objectKey,image.bytes);}catch(e){await prisma.$executeRaw`UPDATE content_assets SET attempt_id=NULL,attempt_until=NULL WHERE id=${asset.id}::uuid AND state='pending' AND attempt_id=${attempt}::uuid`;throw e;}
 const again=await writer(headers);if(again.adminUserId!==actor.adminUserId)throw new Error();
 await transaction(async tx=>{
  const [entry]=await tx.$queryRaw<{version:bigint;cover_id:string|null}[]>`SELECT version,cover_id FROM content_entries WHERE id=${entryId}::uuid FOR UPDATE`;
  const [current]=await tx.$queryRaw<{state:string;valid:boolean}[]>`SELECT state,(attempt_id=${attempt}::uuid AND attempt_until>clock_timestamp()) valid FROM content_assets WHERE id=${asset.id}::uuid FOR UPDATE`;
  if(current.state!=="pending"||!current.valid||entry.version!==version)throw new Conflict();
  await tx.$executeRaw`UPDATE content_assets SET state='ready',ready_at=clock_timestamp(),attempt_id=NULL,attempt_until=NULL WHERE id=${asset.id}::uuid`;
  await tx.contentEntry.update({where:{id:entryId},data:{coverId:asset.id,version:{increment:1}}});
  if(entry.cover_id)await tx.$executeRaw`UPDATE content_assets SET state='delete_pending',delete_after=clock_timestamp()+interval '24 hours' WHERE id=${entry.cover_id}::uuid`;
  await tx.auditLog.create({data:{actorId:actor.adminUserId,action:"content.upload",entityId:entryId,summary:{version:(version+BigInt(1)).toString()}}});
 });return {ok:true,message:"Image verified and linked. Reload before another operation."};
 }catch(e){return {ok:false,message:e instanceof Conflict?"Content or upload attempt changed. Reload to inspect the result.":e instanceof CatalogControlError?e.message:"Upload was not confirmed. Retain the same file, fields and key for an ambiguous retry."};}
}
export async function publicCms(kind:CmsKind,slug?:string){
 const [schema]=await prisma.$queryRaw<{available:boolean}[]>`SELECT to_regclass('public.content_entries') IS NOT NULL AS available`;if(!schema.available)return [];
 const rows=await prisma.contentEntry.findMany({where:{kind,state:"published",visible:true,...(slug?{slug}:{})},orderBy:[{sortOrder:"asc"},{id:"asc"}],take:50,select});
 const output=[];
 for(const r of rows){
  const products=await prisma.product.findMany({where:{id:{in:r.references.flatMap(x=>x.productId?[x.productId]:[])},lifecycle:"active",archivedAt:null,category:{active:true},gallery:{some:{asset:{state:"ready"}}},variants:{some:{active:true,archivedAt:null,priceMinor:{gt:BigInt(0)},currency:"BDT"}}},select:{id:true,slug:true,name:true}});
  const categories=await prisma.category.findMany({where:{id:{in:r.references.flatMap(x=>x.categoryId?[x.categoryId]:[])},active:true},select:{id:true,slug:true,name:true}});
  if(["hero","banner"].includes(r.kind)&&r.cover?.state!=="ready")continue;
  output.push({slug:r.slug,title:r.title,subtitle:r.subtitle,body:r.body,ctaLabel:r.ctaLabel,ctaUrl:r.ctaUrl,seoTitle:r.seoTitle,seoDescription:r.seoDescription,measurements:r.measurements,image:r.cover?.state==="ready"?"/api/content-media/"+r.coverId:null,products:r.references.flatMap(x=>products.filter(p=>p.id===x.productId)),categories:r.references.flatMap(x=>categories.filter(c=>c.id===x.categoryId))});
 }return output;
}
export async function cmsImage(request:Request,id:string,privatePreview:boolean){try{
 if(privatePreview)await requireAdminPermission("content:manage",request.headers);
 const row=await prisma.contentAsset.findUnique({where:{id:identifier(id)},select:{objectKey:true,storedHash:true,state:true,covers:{select:{state:true,visible:true}}}});
 if(!row||row.state!=="ready"||!row.covers.length||!privatePreview&&!row.covers.some(x=>x.state==="published"&&x.visible))throw new Error();
 const bytes=await readObject(row.objectKey);if(digest(bytes)!==row.storedHash)throw new Error();
 return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"image/webp","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}});
 }catch{return new Response("Image unavailable",{status:404,headers:{"Cache-Control":"no-store"}});}}
export async function removeCmsImage(headers:Headers,form:FormData){try{
 const actor=await writer(headers),v=strictFields(form,["entryId","version"]),id=identifier(v.entryId);if(typeof v.version!=="string"||!/^[1-9]\d{0,15}$/.test(v.version))throw new BusinessInputError();
 await transaction(async tx=>{const [entry]=await tx.$queryRaw<{version:bigint;state:string;cover_id:string|null}[]>`SELECT version,state,cover_id FROM content_entries WHERE id=${id}::uuid FOR UPDATE`;if(!entry||entry.version!==BigInt(v.version as string))throw new Conflict();if(entry.state!=="draft"||!entry.cover_id)throw new BusinessInputError();await tx.contentEntry.update({where:{id},data:{coverId:null,version:{increment:1}}});await tx.$executeRaw`UPDATE content_assets SET state='delete_pending',delete_after=clock_timestamp()+interval '24 hours' WHERE id=${entry.cover_id}::uuid`;await tx.auditLog.create({data:{actorId:actor.adminUserId,action:"content.remove-image",entityId:id,summary:{retainedTombstone:true}}});});return {ok:true,message:"Image association removed; object retained for delayed reconciliation."};
 }catch{return {ok:false,message:"Removal not confirmed. Reload and unpublish the entry before removing its image."};}}
export async function reconcileContentAsset(entryId:string,assetId:string,claimId:string){
 const entry=identifier(entryId),asset=identifier(assetId),claim=identifier(claimId);
 const key=await transaction(async tx=>{await tx.$queryRaw`SELECT id FROM content_entries WHERE id=${entry}::uuid FOR UPDATE`;const [a]=await tx.$queryRaw<{object_key:string;state:string;eligible:boolean}[]>`SELECT object_key,state,(claim_id=${claim}::uuid AND reconcile_after>clock_timestamp() AND (state='deleted' OR state='delete_pending' AND delete_after<=clock_timestamp() OR state='pending' AND created_at<clock_timestamp()-interval '24 hours')) eligible FROM content_assets WHERE id=${asset}::uuid AND entry_id=${entry}::uuid FOR UPDATE`;if(!a?.eligible||await tx.contentEntry.count({where:{coverId:asset}}))throw new Conflict();if(a.state!=="deleted")await tx.$executeRaw`UPDATE content_assets SET state='delete_pending',delete_after=COALESCE(delete_after,clock_timestamp()),attempt_id=NULL,attempt_until=NULL WHERE id=${asset}::uuid`;return a.object_key;});
 await deleteObject(key);
 await transaction(async tx=>{await tx.$queryRaw`SELECT id FROM content_entries WHERE id=${entry}::uuid FOR UPDATE`;const rows=await tx.$queryRaw<{id:string}[]>`SELECT id FROM content_assets WHERE id=${asset}::uuid AND claim_id=${claim}::uuid AND reconcile_after>clock_timestamp() FOR UPDATE`;if(!rows.length||await tx.contentEntry.count({where:{coverId:asset}}))throw new Conflict();await tx.$executeRaw`UPDATE content_assets SET state='deleted' WHERE id=${asset}::uuid AND state='delete_pending'`;});
}
