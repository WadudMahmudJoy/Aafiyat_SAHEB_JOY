import { plainText,internalDestination,booleanText,boundedInteger,BusinessInputError,strictBusinessFields } from "./business-rules";
import { identifier } from "./media-validation";
export const CMS_KINDS=["hero","banner","story","page","size-guide"] as const;
export type CmsKind=typeof CMS_KINDS[number];
export type SizeTable={unit:"cm"|"in";columns:string[];rows:{size:string;values:string[]}[];description:string};
export function sizeTable(raw:string):SizeTable|null{
 if(!raw.trim())return null;if(raw.length>12000)throw new BusinessInputError();
 const v=JSON.parse(raw);if(!v||!["cm","in"].includes(v.unit)||!Array.isArray(v.columns)||v.columns.length<1||v.columns.length>8||!Array.isArray(v.rows)||v.rows.length<1||v.rows.length>30||Object.keys(v).some(k=>!["unit","columns","rows","description"].includes(k)))throw new BusinessInputError();
 return {unit:v.unit,columns:v.columns.map((x:unknown)=>plainText(x,40,true)),description:plainText(v.description,500),rows:v.rows.map((r:{size:unknown;values:unknown[]})=>{if(!r||Object.keys(r).some(k=>!["size","values"].includes(k))||!Array.isArray(r.values)||r.values.length!==v.columns.length)throw new BusinessInputError();return {size:plainText(r.size,30,true),values:r.values.map(x=>{if(typeof x!=="string"||!/^\d{1,4}(?:\.\d{1,2})?$/.test(x)||Number(x)<=0)throw new BusinessInputError();return x;})};})};
}
export function cmsInput(form:FormData){
 const v=strictBusinessFields(form,["id","version","kind","slug","title","subtitle","body","ctaLabel","ctaUrl","seoTitle","seoDescription","visible","state","order","products","categories","table"]);
 const id=identifier(v.id);if(!CMS_KINDS.includes(v.kind as CmsKind)||!["draft","published"].includes(v.state)||!/^(0|[1-9]\d{0,15})$/.test(v.version))throw new BusinessInputError();
 const slug=plainText(v.slug,100,true).toLowerCase();if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||v.kind==="hero"&&slug!=="homepage-hero")throw new BusinessInputError();
 const refs=(raw:string)=>{if(raw.length>750)throw new BusinessInputError();const ids=raw.trim()?raw.split(",").map(x=>identifier(x.trim())):[];if(ids.length>20||new Set(ids).size!==ids.length)throw new BusinessInputError();return ids;};
 const table=sizeTable(v.table);if(v.kind==="size-guide"&&!table)throw new BusinessInputError();if(v.kind!=="size-guide"&&table)throw new BusinessInputError();
 return {id,version:BigInt(v.version),kind:v.kind as CmsKind,slug,title:plainText(v.title,160,true),subtitle:plainText(v.subtitle,500),body:plainText(v.body,10000),ctaLabel:plainText(v.ctaLabel,60),ctaUrl:v.ctaUrl?internalDestination(v.ctaUrl):"",seoTitle:plainText(v.seoTitle,70),seoDescription:plainText(v.seoDescription,160),visible:booleanText(v.visible),state:v.state,order:boundedInteger(v.order,10000),products:refs(v.products),categories:refs(v.categories),table};
}
