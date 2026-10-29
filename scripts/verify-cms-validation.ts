import assert from "node:assert/strict";
import { cmsInput,sizeTable } from "../src/lib/cms-validation";
const f=new FormData();for(const [k,v]of Object.entries({id:"00110000-0000-4000-8000-000000000001",version:"0",kind:"hero",slug:"homepage-hero",title:"TEST hero",subtitle:"",body:"",ctaLabel:"Shop",ctaUrl:"/products",seoTitle:"",seoDescription:"",visible:"true",state:"draft",order:"0",products:"",categories:"",table:""}))f.set(k,v);
assert.equal(cmsInput(f).title,"TEST hero");
for(const [key,value]of [["title","<script>bad</script>"],["ctaUrl","//evil.invalid"],["version","1e2"],["products","invalid"],["kind","script"]]){const copy=new FormData();for(const [k,v]of f)copy.append(k,v);copy.set(key,value);assert.throws(()=>cmsInput(copy));}
f.append("id","duplicate");assert.throws(()=>cmsInput(f));
assert.equal(sizeTable(JSON.stringify({unit:"cm",columns:["Chest"],description:"TEST",rows:[{size:"M",values:["100.50"]}]}))?.rows[0].values[0],"100.50");
for(const unit of ["px","<script>"])assert.throws(()=>sizeTable(JSON.stringify({unit,columns:["Chest"],description:"",rows:[{size:"M",values:["-1"]}]})));
console.log("PASS: CMS allowlists, duplicate rejection, safe HTML/URLs, references and structured measurements (10 checks).");
