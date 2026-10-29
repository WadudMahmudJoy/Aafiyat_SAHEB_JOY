import assert from "node:assert/strict";
import sharp from "sharp";
import { decodeImage,objectKey,contentObjectKey,validObjectKey,strictFields } from "../src/lib/media-validation";
async function verify(){
const png=await sharp({create:{width:8,height:8,channels:4,background:"#125634"}}).png().toBuffer();
const decoded=await decodeImage(new File([png],"image.png",{type:"image/png"}));assert.equal(decoded.width,8);assert.equal(decoded.mime,"image/webp");assert.equal((await sharp(decoded.bytes).metadata()).format,"webp");
const uuid="00110000-0000-4000-8000-000000000001";assert(validObjectKey(objectKey(uuid,uuid)));assert(validObjectKey(contentObjectKey(uuid,uuid)));assert.throws(()=>validObjectKey("other/"+uuid+"/"+uuid+".webp"));
for(const file of [new File([png],"bad.jpg",{type:"image/jpeg"}),new File(['<svg onload="alert(1)"/>'],"x.svg",{type:"image/svg+xml"}),new File([Buffer.alloc(8*1024*1024+1)],"large.png",{type:"image/png"}),new File([png.subarray(0,20)],"truncated.png",{type:"image/png"})])await assert.rejects(decodeImage(file));
assert.throws(()=>objectKey("../bad","forged"));const f=new FormData();f.set("name","test");assert.equal(strictFields(f,["name"]).name,"test");f.append("name","duplicate");assert.throws(()=>strictFields(f,["name"]));
console.log("PASS: canonical image decode, MIME/signature, size, truncated/executable rejection, key and duplicate allowlists (8 checks).");

}
verify().catch(e=>{console.error(e);process.exitCode=1;});
