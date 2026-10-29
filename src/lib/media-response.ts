import "server-only";
import { prisma } from "./prisma";
import { identifier,digest } from "./media-validation";
import { readObject } from "./media-storage";
import { requireAdminPermission } from "./admin-authorization";
export async function mediaResponse(request:Request,value:string,privatePreview:boolean){try{if(privatePreview)await requireAdminPermission("catalog:read",request.headers);const id=identifier(value);
 const rows=privatePreview?await prisma.$queryRaw<{key:string;hash:string}[]>`SELECT a.object_key AS key,a.stored_hash AS hash FROM media_assets a JOIN product_media m ON m.asset_id=a.id WHERE a.id=${id}::uuid AND a.state='ready' LIMIT 1`:
 await prisma.$queryRaw<{key:string;hash:string}[]>`SELECT a.object_key AS key,a.stored_hash AS hash FROM media_assets a JOIN product_media m ON m.asset_id=a.id JOIN products p ON p.id=m.product_id JOIN categories c ON c.id=p.category_id WHERE a.id=${id}::uuid AND a.state='ready' AND p.lifecycle='active' AND p.archived_at IS NULL AND c.active AND EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active AND v.archived_at IS NULL AND v.currency='BDT' AND v.price_minor>0) LIMIT 1`;
 if(!rows[0])throw new Error();const bytes=await readObject(rows[0].key);if(digest(bytes)!==rows[0].hash)throw new Error();return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"image/webp","Content-Length":String(bytes.length),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}});
 }catch{return new Response("Image unavailable",{status:404,headers:{"Cache-Control":"no-store"}});}}
