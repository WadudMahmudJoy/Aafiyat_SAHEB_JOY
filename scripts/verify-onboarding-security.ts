import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { mailboxKey,mailboxVerifier,newMailboxCode,attemptVerifier,validAttemptCookie,passwordInput } from "../src/lib/onboarding-secrets";
const key=randomBytes(32).toString("base64"),id=randomUUID();let n=0;
function check(name:string,f:()=>void){f();n++;console.log("PASS: "+name);}
check("independent verification key fails closed",()=>{assert.throws(()=>mailboxKey(undefined,"auth",undefined));assert.throws(()=>mailboxKey(key,key,undefined));assert.throws(()=>mailboxKey(key,"auth",key));assert.equal(mailboxKey(key,"auth",undefined).length,32);});
check("mailbox codes are cryptographic eight-digit values with attempt-bound keyed verifiers",()=>{for(let i=0;i<100;i++){const code=newMailboxCode();assert.match(code,/^\d{8}$/);const hash=mailboxVerifier(Buffer.from(key,"base64"),id,id,code);assert.match(hash,/^[a-f0-9]{64}$/);assert.notEqual(hash,mailboxVerifier(randomBytes(32),id,id,code));assert.notEqual(hash,mailboxVerifier(Buffer.from(key,"base64"),randomUUID(),id,code));}});
check("onboarding cookie contains an independent 256-bit capability, not a role",()=>{const raw=id+"."+randomBytes(32).toString("base64url");assert(validAttemptCookie(raw));assert.match(attemptVerifier(raw),/^[a-f0-9]{64}$/);for(const bad of ["OWNER",raw+"x",id+".weak"])assert.equal(validAttemptCookie(bad),false);});
check("password input is bounded and confirmed without trimming",()=>{assert.equal(passwordInput("  a-long-password  ","  a-long-password  ",12,128),"  a-long-password  ");for(const [p,c]of [["short","short"],["a".repeat(129),"a".repeat(129)],["a-valid-password","mismatch"]])assert.throws(()=>passwordInput(p,c,12,128));});
console.log(`${n} onboarding crypto/input checks passed.`);
