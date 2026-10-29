// Shared policy primitives. These configure future consumers; they do not accept orders,
// grant consent, calculate exchange eligibility, or redeem offers.
const MAX_MINOR=BigInt("9223372036854775807");
export class BusinessInputError extends Error {
  constructor(){super("Check the supplied fields.");}
}
const invalid=():never=>{throw new BusinessInputError();};
export function minorUnits(value:unknown):bigint {
  if(typeof value!=="string"||value.length>23||!/^\d+(?:\.\d{1,2})?$/.test(value))return invalid();
  const [whole,fraction=""]=value.split(".");
  const result=BigInt(whole)*BigInt(100)+BigInt(fraction.padEnd(2,"0"));
  if(result>MAX_MINOR)return invalid();
  return result;
}
export function freeShippingEligible(postDiscountMerchandiseMinor:bigint,thresholdMinor:bigint):boolean {
  if(postDiscountMerchandiseMinor<BigInt(0)||thresholdMinor<BigInt(0)||postDiscountMerchandiseMinor>MAX_MINOR||thresholdMinor>MAX_MINOR)return invalid();
  return postDiscountMerchandiseMinor>thresholdMinor;
}
export function publicStockStatus(balance:{onHand:number;reserved:number;lowStockThreshold:number|null}|null,defaultThreshold:number|null) {
  if(!balance)return "Out of Stock" as const;
  const available=balance.onHand-balance.reserved;
  if(available<=0)return "Out of Stock" as const;
  const threshold=balance.lowStockThreshold??defaultThreshold;
  if(threshold!==null&&(!Number.isInteger(threshold)||threshold<0||threshold>2147483647))return invalid();
  return threshold!==null&&available<=threshold?"Low Stock" as const:"In Stock" as const;
}
export function plainText(value:unknown,max:number,required=false):string {
  if(typeof value!=="string"||value.length>Math.max(2048,max*2)||/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))return invalid();
  const result=value.normalize("NFC").replace(/\r\n?/g,"\n").trim();
  if(result.length>max||(required&&!result))return invalid();
  return result;
}
export function internalDestination(value:unknown):string {
  if(typeof value!=="string"||value.length>180||!/^\/(?:products(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?|categories\/[a-z0-9]+(?:-[a-z0-9]+)*|about|contact|policies(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?)?$/.test(value))return invalid();
  return value;
}
export function strictBusinessFields(form:FormData,allowed:readonly string[]):Record<string,string> {
  const values:Record<string,string>={};
  for(const [key,value]of form.entries()){
    if(!allowed.includes(key)||Object.hasOwn(values,key)||typeof value!=="string")return invalid();
    values[key]=value;
  }
  if(allowed.some(key=>!Object.hasOwn(values,key)))return invalid();
  return values;
}
export function boundedInteger(value:unknown,max=2147483647):number {
  if(typeof value!=="string"||!/^\d{1,10}$/.test(value))return invalid();
  const result=Number(value);if(result>max)return invalid();return result;
}
export function booleanText(value:unknown):boolean {
  if(value!=="true"&&value!=="false")return invalid();return value==="true";
}
export function utcInstant(value:unknown):string {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))return invalid();
  const date=new Date(value);if(!Number.isFinite(date.getTime())||date.toISOString()!==value)return invalid();return value;
}
export function offerPreview(subtotalMinor:bigint,kind:"percentage"|"fixed",value:bigint):bigint {
  if(subtotalMinor<BigInt(0)||subtotalMinor>MAX_MINOR||value<=BigInt(0)||value>MAX_MINOR)return invalid();
  if(kind!=="percentage"&&kind!=="fixed")return invalid();
  if(kind==="percentage"&&value>BigInt(100))return invalid();
  const discount=kind==="percentage"?subtotalMinor*value/BigInt(100):value;
  return discount>subtotalMinor?subtotalMinor:discount;
}
export function withinOfferSchedule(now:string,start:string,end:string):boolean {
  const n=utcInstant(now),s=utcInstant(start),e=utcInstant(end);
  if(s>=e)return invalid();
  return n>=s&&n<e;
}
export const INITIAL_BUSINESS_POLICY=Object.freeze({
  freeShippingThresholdMinor:"500000",
  lowStockThreshold:null as number|null,
  promotionalConsentVisible:false,
  consentNoticeVersion:0,
  exchangeDays:3,
  exchangeStartEvent:"unresolved",
  reviewsEnabled:false,
});
