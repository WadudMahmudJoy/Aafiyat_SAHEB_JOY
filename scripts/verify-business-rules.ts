import assert from "node:assert/strict";
import { minorUnits,freeShippingEligible,publicStockStatus,plainText,internalDestination,strictBusinessFields,offerPreview,withinOfferSchedule,INITIAL_BUSINESS_POLICY } from "../src/lib/business-rules";
let passed=0;
function check(name:string,run:()=>void){run();passed++;console.log("PASS: "+name);}
check("strict greater-than shipping boundary and configurable exact threshold",()=>{
  const threshold=minorUnits("5000");
  assert.equal(threshold.toString(),"500000");
  assert(!freeShippingEligible(minorUnits("4999.99"),threshold));
  assert(!freeShippingEligible(minorUnits("5000.00"),threshold));
  assert(freeShippingEligible(minorUnits("5000.01"),threshold));
  assert(!freeShippingEligible(BigInt(0),BigInt(0)));
});
check("minor-unit validation and BIGINT limit",()=>{
  assert.equal(minorUnits("92233720368547758.07").toString(),"9223372036854775807");
  for(const v of ["92233720368547758.08","-1","1e3","1.001","1x",".01",1])assert.throws(()=>minorUnits(v));
});
check("low-stock inheritance and per-variant overrides",()=>{
  assert.equal(publicStockStatus(null,5),"Out of Stock");
  assert.equal(publicStockStatus({onHand:4,reserved:4,lowStockThreshold:null},5),"Out of Stock");
  assert.equal(publicStockStatus({onHand:4,reserved:0,lowStockThreshold:null},5),"Low Stock");
  assert.equal(publicStockStatus({onHand:4,reserved:0,lowStockThreshold:2},5),"In Stock");
  assert.equal(publicStockStatus({onHand:4,reserved:0,lowStockThreshold:0},5),"In Stock");
});
check("plain text and internal destinations reject executable content and redirects",()=>{
  assert.equal(plainText(" cafe\u0301 ",20),"café");
  for(const x of ["<script>alert(1)</script>","\u0000"])assert.throws(()=>plainText(x,100));
  for(const x of ["https://evil.invalid","//evil.invalid","/\\evil","/admin","/products/%2e%2e","/products?a=javascript:alert(1)"])assert.throws(()=>internalDestination(x));
  assert.equal(internalDestination("/products/test-shirt"),"/products/test-shirt");
});
check("form allowlist preserves repeated-field and actor-injection rejection",()=>{
  const f=new FormData();f.set("name","TEST");assert.equal(strictBusinessFields(f,["name"]).name,"TEST");
  f.append("name","another");assert.throws(()=>strictBusinessFields(f,["name"]));f.delete("name");f.set("actorId","forged");assert.throws(()=>strictBusinessFields(f,["name"]));
});
check("offer preview uses checked integer arithmetic and caps at subtotal",()=>{
  assert.equal(offerPreview(BigInt(999),"percentage",BigInt(10)),BigInt(99));
  assert.equal(offerPreview(BigInt(100),"fixed",BigInt(200)),BigInt(100));
  assert.throws(()=>offerPreview(BigInt(100),"percentage",BigInt(101)));
});
check("offer schedule includes start and excludes end",()=>{
  const s="2026-10-30T00:00:00.000Z",e="2026-10-31T00:00:00.000Z";
  assert(withinOfferSchedule(s,s,e));assert(!withinOfferSchedule(e,s,e));assert.throws(()=>withinOfferSchedule(s,e,s));
});
check("consent, exchange anchor and reviews remain inactive or unresolved",()=>{
  assert.equal(INITIAL_BUSINESS_POLICY.promotionalConsentVisible,false);
  assert.equal(INITIAL_BUSINESS_POLICY.consentNoticeVersion,0);
  assert.equal(INITIAL_BUSINESS_POLICY.exchangeDays,3);
  assert.equal(INITIAL_BUSINESS_POLICY.exchangeStartEvent,"unresolved");
  assert.equal(INITIAL_BUSINESS_POLICY.reviewsEnabled,false);
});
console.log(passed+" business-rule groups passed; no database access.");
