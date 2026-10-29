import sharp from "sharp";
import { createHash } from "node:crypto";
import { draftUuid,validDraftVersion } from "./product-draft-validation";
export class CatalogControlError extends Error { constructor(readonly code:string,message:string){super(message);} }
export function reject(code="VALIDATION",message="Check the supplied fields."):never{throw new CatalogControlError(code,message);}
export function strictFields(form:FormData,keys:string[]){const entries=[...form.entries()];if(entries.length!==keys.length)reject();const values:Record<string,FormDataEntryValue>={};for(const[k,v]of entries){if(!keys.includes(k)||Object.hasOwn(values,k))reject();values[k]=v;}return values;}
export function identifier(value:unknown){if(typeof value!=="string"||value.length!==36||!draftUuid.test(value))reject();return value.toLowerCase();}
export function revision(value:unknown){if(!validDraftVersion(value))reject("CONFLICT","Reload the latest revision.");return value as string;}
export function normalized(value:unknown,max:number,required=false){if(typeof value!=="string"||value.length>2048||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))reject();const text=value.normalize("NFC").replace(/\s+/g," ").trim();if(text.length>max||required&&!text)reject();return text;}
export const digest=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
export function objectKey(productId:string,assetId:string){return `products/${identifier(productId)}/${identifier(assetId)}.webp`;}
export function validObjectKey(key:string){if(!/^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/.test(key))reject();const [,p,a]=key.split("/");return key===objectKey(p,a.slice(0,-5));}
export async function decodeImage(file:unknown){
 if(!(file instanceof File)||file.size<12||file.size>8*1024*1024)reject("IMAGE","Choose a PNG, JPEG or WebP image up to 8 MiB.");
 const raw=Buffer.from(await file.arrayBuffer());let mime="";
 if(raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime="image/png";
 else if(raw[0]===255&&raw[1]===216&&raw[2]===255)mime="image/jpeg";
 else if(raw.subarray(0,4).toString()==="RIFF"&&raw.subarray(8,12).toString()==="WEBP")mime="image/webp";
 if(!mime||file.type!==mime)reject("IMAGE","The image signature does not match its declared type.");
 try{const image=sharp(raw,{limitInputPixels:40_000_000,failOn:"warning"});const meta=await image.metadata();if(!meta.width||!meta.height||meta.width>8192||meta.height>8192||(meta.pages??1)!==1)reject("IMAGE","Use a single image no larger than 8192 pixels per side.");
  // Decode and re-encode: no original filename, active payload, EXIF or arbitrary metadata is published.
  const result=await image.rotate().webp({quality:85}).toBuffer({resolveWithObject:true});if(result.data.length>8*1024*1024)reject("IMAGE","Encoded image exceeds the size limit.");
  return {bytes:result.data,width:result.info.width,height:result.info.height,mime:"image/webp",sourceHash:digest(raw),storedHash:digest(result.data)};
 }catch(error){if(error instanceof CatalogControlError)throw error;reject("IMAGE","This image could not be safely decoded.");}
}
