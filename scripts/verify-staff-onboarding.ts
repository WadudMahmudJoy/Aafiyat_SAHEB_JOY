import assert from "node:assert/strict";
import { randomBytes,randomUUID,createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync,writeFileSync,existsSync,unlinkSync,rmSync,lstatSync } from "node:fs";
import { resolve,sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn,spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { symmetricEncrypt } from "better-auth/crypto";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { POST,GET } from "../src/app/api/staff/onboarding/route";
import { POST as activationRoute } from "../src/app/api/staff/activation/route";
import { ONBOARDING_COOKIE } from "../src/lib/staff-onboarding";
import { invitationVerifier,createInvitationSecret } from "../src/lib/invitation-secrets";
import { attemptVerifier,mailboxVerifier } from "../src/lib/onboarding-secrets";
import { requireAdminPermission } from "../src/lib/admin-authorization";
import { ADMIN_PERMISSIONS } from "../src/lib/admin-permissions";
import { changeInvitation } from "../src/lib/admin-invitations";
import { deliverNextInvitation } from "../src/lib/invitation-delivery";
const {Client}=createRequire(import.meta.url)("pg");
const url=new URL(process.env.DATABASE_URL!),run=process.env.INVENTORY_TEST_RUN!,database=process.env.INVENTORY_TEST_DATABASE!;
assert.equal(url.hostname,"127.0.0.1");assert.notEqual(url.port,"55432");assert.equal(url.pathname,`/receive_verify_${run.replaceAll("-","")}`);assert.equal(url.pathname,`/${database}`);
const admin=new Client({connectionString:process.env.INVENTORY_TEST_ADMIN_URL});
const results:{name:string;elapsedMs:number}[]=[];let current="preflight";
const origin=String(auth.options.baseURL);type Jar=Map<string,string>;
function headers(jar:Jar){return new Headers({origin,"sec-fetch-site":"same-origin",cookie:[...jar].map(([k,v])=>k+"="+v).join("; ")});}
async function request(jar:Jar,path:string,body?:unknown){const h=headers(jar);if(body)h.set("content-type","application/json");for(let tries=0;tries<4;tries++){const r=await auth.handler(new Request(origin+"/api/auth"+path,{method:body?"POST":"GET",headers:h,...(body?{body:JSON.stringify(body)}:{})}));if(r.status===429){await delay(10100);continue;}for(const cookie of r.headers.getSetCookie()){const pair=cookie.split(";",1)[0],i=pair.indexOf("=");jar.set(pair.slice(0,i),pair.slice(i+1));}return {status:r.status,body:await r.json()};}throw new Error("Rate-limit retries exhausted");}
function totp(secret:string){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=createHmac("sha1",Buffer.from(secret)).update(counter).digest(),o=h[h.length-1]&15;return ((h.readUInt32BE(o)&0x7fffffff)%1000000).toString().padStart(6,"0");}
async function identity(role:string,name="TEST Governance operator"){
 const id=randomUUID(),email=id+"@example.invalid",password="TEST-"+randomUUID()+"-Aa!",secret=randomUUID().replaceAll("-",""),context=await auth.$context;
 await admin.query('INSERT INTO auth_users(id,name,email,"twoFactorEnabled","updatedAt") VALUES($1,$2,$3,true,clock_timestamp())',[id,name,email]);await admin.query('INSERT INTO auth_accounts(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,\'credential\',$2,$3,clock_timestamp())',[randomUUID(),id,await context.password.hash(password)]);
 const member=(await admin.query("INSERT INTO admin_users(user_id,role_id,active) SELECT $1,id,true FROM admin_roles WHERE name=$2 RETURNING id",[id,role])).rows[0].id;
 await admin.query('INSERT INTO auth_two_factors(id,secret,"backupCodes","userId",verified) VALUES($1,$2,$3,$4,true)',[randomUUID(),await symmetricEncrypt({key:context.secretConfig,data:secret}),await symmetricEncrypt({key:context.secretConfig,data:"[]"}),id]);return {id,member,email,password,secret};
}
async function login(who:Awaited<ReturnType<typeof identity>>){const jar:Jar=new Map();const first=await request(jar,"/sign-in/email",{email:who.email,password:who.password});assert.equal(first.status,200);assert(first.body.twoFactorRedirect);assert.equal((await request(jar,"/two-factor/verify-totp",{code:totp(who.secret)})).status,200);return jar;}
async function check(name:string,f:()=>Promise<void>){current=name;const now=Date.now();await f();results.push({name,elapsedMs:Date.now()-now});console.log("PASS: "+name);}

const deliveryKey=randomBytes(32).toString("base64"),codeKey=randomBytes(32).toString("base64"),mailboxAccess=randomBytes(32).toString("hex");
const inbox=new Map<string,{to:string;subject:string;text:string}>();let sinkFailure=false,mailboxOrigin="";
const sink=createServer(async(req,res)=>{
  if(req.method==="GET"&&req.url==="/test-mailbox"&&req.headers.authorization===`Bearer ${mailboxAccess}`){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}).end(JSON.stringify([...inbox].map(([id,m])=>({id,...m}))));return;}
  if(req.url!=="/messages"||req.method!=="POST"){res.writeHead(404).end();return;}
  let body="";for await(const chunk of req){body+=chunk.toString();if(body.length>4096){res.writeHead(413).end();return;}}
  if(sinkFailure){res.writeHead(503).end();return;}const value=JSON.parse(body),id=String(req.headers["idempotency-key"]);inbox.set(id,value);res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({accepted:true,messageId:"sink_"+id}));
});
function absorb(jar:Jar,response:Response){for(const raw of response.headers.getSetCookie()){const pair=raw.split(";",1)[0],i=pair.indexOf("=");jar.set(pair.slice(0,i),pair.slice(i+1));}}
async function api(jar:Jar,body:Record<string,unknown>,changes?:Record<string,string|undefined>){const h=headers(jar);h.set("content-type","application/json");h.set("x-staff-onboarding","1");for(const[k,v]of Object.entries(changes??{}))if(v!==undefined)h.set(k,v);const r=await POST(new NextRequest(origin+"/api/staff/onboarding",{method:"POST",headers:h,body:JSON.stringify(body)}));absorb(jar,r);return {status:r.status,body:await r.json()};}
async function status(jar:Jar){const h=headers(jar);h.set("x-staff-onboarding","1");return (await GET(new NextRequest(origin+"/api/staff/onboarding",{headers:h}))).json();}
const email=()=>randomUUID()+"@example.invalid";
const password=()=>"TEST-"+randomUUID()+"-Aa!";
type Invite={id:string;secret:string;email:string;role:string};
let owner:Awaited<ReturnType<typeof identity>>,ownerJar:Jar,issued=0;
async function invitation(role="PRODUCT_MANAGER",destination=email()):Promise<Invite>{
  if(!owner||issued>=8){owner=await identity("OWNER","TEST Onboarding inviter");ownerJar=await login(owner);issued=0;}
  const form=new FormData();for(const[k,v]of Object.entries({operation:"create",email:destination,role}))form.set(k,v);assert((await changeInvitation(headers(ownerJar),form)).ok);issued++;
  const row=await prisma.adminInvitation.findFirstOrThrow({where:{email:destination}});assert.equal((await deliverNextInvitation()).status,"delivered");const message=inbox.get(row.id)!;assert.equal(message.to,destination);const secret=message.text.match(/Secret: ([A-Za-z0-9_-]{43})/)![1];return {id:row.id,secret,email:destination,role};
}
async function start(inv:Invite,jar:Jar=new Map()){const r=await api(jar,{operation:"start",invitationId:inv.id,secret:inv.secret});return {jar,...r};}
function latestCode(destination:string){const message=[...inbox].filter(([,m])=>m.to===destination&&m.subject==="Aafiyat mailbox verification").at(-1);assert(message);return {id:message[0],code:message[1].text.match(/code is (\d{8})/)![1]};}
async function verified(inv:Invite){const r=await start(inv);assert(r.body.ok);assert((await api(r.jar,{operation:"request_code"})).body.ok);const code=latestCode(inv.email);assert((await api(r.jar,{operation:"verify",code:code.code})).body.ok);return {...r,code};}
async function close(inv:Invite,operation="revoke"){const row=await prisma.adminInvitation.findUniqueOrThrow({where:{id:inv.id}}),form=new FormData();for(const[k,v]of Object.entries({operation,id:inv.id,version:row.version.toString(),confirm:"CONFIRM"}))form.set(k,v);assert((await changeInvitation(headers(ownerJar),form)).ok);}
async function historical(state:string,expired=false,destination=email(),lifetime=172800000):Promise<Invite>{const id=randomUUID(),secret=createInvitationSecret();await prisma.adminInvitation.create({data:{id,email:destination,role:"ORDER_MANAGER",invitedBy:owner.member,state,deliveryState:state==="revoked"?"cancelled":"delivered",tokenHash:invitationVerifier(secret),createdAt:new Date(Date.now()-172800000),expiresAt:new Date(Date.now()+(expired?-1000:lifetime)),...(state==="consumed"?{consumedAt:new Date(),consumedUserId:owner.id}:{}),...(state==="revoked"?{revokedAt:new Date(),revokedBy:owner.member}:{deliveredAt:new Date(Date.now()-172700000),providerReceiptHash:randomBytes(32).toString("hex")})}});return{id,secret,email:destination,role:"ORDER_MANAGER"};}

async function verify(){
  await admin.connect();assert.equal((await admin.query("SELECT current_database() db")).rows[0].db,database);assert.equal((await admin.query("SELECT count(*)::int n FROM _prisma_migrations")).rows[0].n,13);
  await new Promise<void>(r=>sink.listen(0,"127.0.0.1",r));const address=sink.address();assert(address&&typeof address==="object");mailboxOrigin=`http://127.0.0.1:${address.port}`;
  process.env.ADMIN_INVITATION_ENCRYPTION_KEY=deliveryKey;process.env.ADMIN_INVITATION_DELIVERY="local-sink";process.env.ADMIN_INVITATION_MAIL_SINK_URL=mailboxOrigin+"/messages";process.env.STAFF_ONBOARDING_VERIFICATION_KEY=codeKey;
  const first=await invitation("MARKETING_MANAGER","staff+"+randomUUID()+"@example.invalid");let firstJar:Jar=new Map(),firstPassword="";
  await check("delivered invitation and independent mailbox challenge are bound without issuing a session",async()=>{
    const started=await start(first);firstJar=started.jar;assert(started.body.ok);assert.equal(started.body.stage,"verifying");assert(!JSON.stringify(started.body).includes(first.secret));assert.equal(await prisma.session.count({where:{user:{email:first.email}}}),0);assert(!(await api(firstJar,{operation:"provision",password:password(),confirmation:password()})).body.ok);
    const r=await api(firstJar,{operation:"request_code"});assert(r.body.ok);const code=latestCode(first.email);assert(!JSON.stringify(r).includes(code.code));const challenge=await prisma.adminMailboxChallenge.findUniqueOrThrow({where:{id:code.id}});assert.equal(challenge.verifier,mailboxVerifier(Buffer.from(codeKey,"base64"),challenge.onboardingId,code.id,code.code));assert(!JSON.stringify(challenge).includes(code.code));assert.equal(challenge.deliveryState,"delivered");
  });
  await check("wrong and replayed mailbox codes fail; successful consumption is single-use",async()=>{
    const code=latestCode(first.email),wrong=code.code==="00000000"?"11111111":"00000000";assert(!(await api(firstJar,{operation:"verify",code:wrong})).body.ok);assert((await api(firstJar,{operation:"verify",code:code.code})).body.ok);assert(!(await api(firstJar,{operation:"verify",code:code.code})).body.ok);assert.equal((await prisma.adminMailboxChallenge.findUniqueOrThrow({where:{id:code.id}})).attempts,2);assert.equal((await status(firstJar)).stage,"mailbox_verified");
  });
  await check("pinned Better Auth password mechanism provisions exactly bound inactive records atomically",async()=>{
    firstPassword=password();const before=await prisma.session.count();const r=await api(firstJar,{operation:"provision",password:firstPassword,confirmation:firstPassword});assert(r.body.ok);assert.equal(r.body.stage,"provisioned");assert.equal(await prisma.session.count(),before);
    const user=await prisma.user.findUniqueOrThrow({where:{email:first.email},include:{accounts:true,adminUser:{include:{role:true}},twofactors:true}});assert(user.emailVerified);assert.equal(user.twoFactorEnabled,false);assert.equal(user.twofactors.length,0);assert.equal(user.accounts.length,1);assert.equal(user.accounts[0].providerId,"credential");assert.equal(user.accounts[0].accountId,user.id);assert.notEqual(user.accounts[0].password,firstPassword);assert(await(await auth.$context).password.verify({hash:user.accounts[0].password!,password:firstPassword}));assert.equal(user.adminUser?.active,false);assert.equal(user.adminUser?.role.name,"MARKETING_MANAGER");
    const progress=await prisma.adminOnboarding.findFirstOrThrow({where:{invitationId:first.id}});assert.equal(progress.userId,user.id);assert.equal(progress.membershipId,user.adminUser!.id);assert(progress.verifiedChallengeId);const inv=await prisma.adminInvitation.findUniqueOrThrow({where:{id:first.id}});assert.equal(inv.state,"delivered");assert.equal(inv.consumedAt,null);
  });
  await check("real password sign-in succeeds while every administrative permission is denied",async()=>{
    const jar:Jar=new Map();assert.equal((await request(jar,"/sign-in/email",{email:first.email,password:firstPassword})).status,200);for(const permission of ADMIN_PERMISSIONS)await assert.rejects(requireAdminPermission(permission,headers(jar)));const sessions=await prisma.session.findMany({where:{user:{email:first.email}}});assert.equal(sessions.length,1);assert(sessions.every(s=>s.mfaVerifiedAt===null));assert((await request(new Map(),"/sign-up/email",{name:"TEST forbidden",email:email(),password:password()})).status>=400);assert((await request(jar,"/two-factor/enable",{password:firstPassword})).status>=400);
  });
  await check("restart/status and repeated provisioning cannot recreate or reset the bound identity",async()=>{
    assert.equal((await status(new Map(firstJar))).stage,"provisioned");assert.equal((await start(first,new Map(firstJar))).body.stage,"provisioned");const next=password();assert((await api(firstJar,{operation:"provision",password:next,confirmation:next})).body.ok);assert.equal(await prisma.user.count({where:{email:first.email}}),1);const account=await prisma.account.findFirstOrThrow({where:{user:{email:first.email},providerId:"credential"}});assert(await(await auth.$context).password.verify({hash:account.password!,password:firstPassword}));assert(!await(await auth.$context).password.verify({hash:account.password!,password:next}));assert(!(await start(first)).body.ok);
  });
  await check("invalid, revoked, expired, consumed and undelivered invitations are generic denials",async()=>{
    assert(!(await start({...first,secret:createInvitationSecret()})).body.ok);const revoked=await historical("revoked"),expired=await historical("delivered",true);for(const inv of[revoked,expired])assert(!(await start(inv)).body.ok);
    const consumed=await historical("consumed");assert(!(await start(consumed)).body.ok);
    const id=randomUUID(),secret=createInvitationSecret();await prisma.adminInvitation.create({data:{id,email:email(),role:"ORDER_MANAGER",tokenHash:invitationVerifier(secret),invitedBy:owner.member,expiresAt:new Date(Date.now()+172800000)}});assert(!(await start({id,secret,email:"",role:"ORDER_MANAGER"})).body.ok);
  });
  await check("unsupported native sign-in addresses cannot issue invitations or provision legacy identities",async()=>{
    const destination="legacy!"+randomUUID()+"@example.invalid",form=new FormData();for(const[k,v]of Object.entries({operation:"create",email:destination,role:"PRODUCT_MANAGER"}))form.set(k,v);assert(!(await changeInvitation(headers(ownerJar),form)).ok);assert.equal(await prisma.adminInvitation.count({where:{email:destination}}),0);const legacy=await historical("delivered",false,destination);assert(!(await start(legacy)).body.ok);assert.equal(await prisma.user.count({where:{email:destination}}),0);
  });
  await check("concurrent redemption has one active attempt; possession cannot steal another attempt",async()=>{
    const inv=await invitation(),r=await Promise.all([start(inv),start(inv)]);assert.equal(r.filter(x=>x.body.ok).length,1);assert.equal(await prisma.adminOnboarding.count({where:{invitationId:inv.id,state:"verifying"}}),1);const winner=r.find(x=>x.body.ok)!;assert(!(await api(new Map(),{operation:"request_code"})).body.ok);assert((await api(winner.jar,{operation:"request_code"})).body.ok);
  });
  await check("replacement code invalidates previous code and issuance counts survive interruption",async()=>{
    const inv=await invitation(),r=await start(inv);assert(r.body.ok);assert((await api(r.jar,{operation:"request_code"})).body.ok);const old=latestCode(inv.email);assert(!(await api(r.jar,{operation:"request_code"})).body.ok);await admin.query("UPDATE admin_onboarding SET last_mail_at=clock_timestamp()-interval '61 seconds',version=version+1 WHERE invitation_id=$1",[inv.id]);assert((await api(r.jar,{operation:"request_code"})).body.ok);const current=latestCode(inv.email);assert.notEqual(old.id,current.id);assert.notEqual(old.code,current.code);assert(!(await api(r.jar,{operation:"verify",code:old.code})).body.ok);assert((await api(r.jar,{operation:"verify",code:current.code})).body.ok);assert.equal((await prisma.adminOnboarding.findFirstOrThrow({where:{invitationId:inv.id}})).mailRequests,2);
  });
  await check("role and email cannot be supplied or changed by a recipient",async()=>{
    const inv=await invitation("ORDER_MANAGER"),r=await verified(inv),p=password();for(const extra of[{email:owner.email},{role:"OWNER"},{userId:owner.id},{mfaVerifiedAt:new Date().toISOString()}])assert(!(await api(r.jar,{operation:"provision",password:p,confirmation:p,...extra})).body.ok);assert((await api(r.jar,{operation:"provision",password:p,confirmation:p})).body.ok);const user=await prisma.user.findUniqueOrThrow({where:{email:inv.email},include:{adminUser:{include:{role:true}}}});assert.equal(user.adminUser!.role.name,"ORDER_MANAGER");assert.equal(user.adminUser!.active,false);
  });
  await check("revocation during onboarding closes progress and prevents password provisioning",async()=>{
    const inv=await invitation(),r=await verified(inv);await close(inv);const p=password();assert(!(await api(r.jar,{operation:"provision",password:p,confirmation:p})).body.ok);assert(!(await status(r.jar)).ok);assert.equal((await prisma.adminOnboarding.findFirstOrThrow({where:{invitationId:inv.id}})).state,"abandoned");assert.equal(await prisma.user.count({where:{email:inv.email}}),0);
  });
  await check("explicit invitation expiry invalidates unused challenges and onboarding capability",async()=>{
    const inv=await invitation(),r=await start(inv);assert((await api(r.jar,{operation:"request_code"})).body.ok);const code=latestCode(inv.email);await close(inv,"expire");assert(!(await api(r.jar,{operation:"verify",code:code.code})).body.ok);assert.equal((await prisma.adminMailboxChallenge.findUniqueOrThrow({where:{id:code.id}})).invalidatedAt!==null,true);assert.equal((await prisma.adminOnboarding.findFirstOrThrow({where:{invitationId:inv.id}})).state,"expired");
  });
  await check("existing-account claiming and concurrent duplicate provisioning are blocked",async()=>{
    const inv=await invitation(),r=await verified(inv),p=password();const results=await Promise.all([api(r.jar,{operation:"provision",password:p,confirmation:p}),api(new Map(r.jar),{operation:"provision",password:p,confirmation:p})]);assert(results.every(x=>x.body.ok));assert.equal(await prisma.user.count({where:{email:inv.email}}),1);assert.equal(await prisma.adminUser.count({where:{user:{email:inv.email}}}),1);assert.equal(await prisma.auditLog.count({where:{action:"onboarding.provision",actor:{user:{email:inv.email}}}}),1);
    const blocked=await invitation();await prisma.user.create({data:{id:randomUUID(),email:blocked.email,name:"TEST conflicting identity"}});assert(!(await start(blocked)).body.ok);
  });
  await check("wrong-code budget is durable and prevents simultaneous code reuse",async()=>{
    const inv=await invitation(),r=await start(inv);assert((await api(r.jar,{operation:"request_code"})).body.ok);const code=latestCode(inv.email),wrong=code.code==="00000000"?"11111111":"00000000";for(let i=0;i<5;i++)assert(!(await api(r.jar,{operation:"verify",code:wrong})).body.ok);assert(!(await api(r.jar,{operation:"verify",code:code.code})).body.ok);const c=await prisma.adminMailboxChallenge.findUniqueOrThrow({where:{id:code.id}});assert.equal(c.attempts,5);assert(c.invalidatedAt);
    const other=await invitation(),v=await start(other);assert((await api(v.jar,{operation:"request_code"})).body.ok);const good=latestCode(other.email);const replies=await Promise.all([api(v.jar,{operation:"verify",code:good.code}),api(new Map(v.jar),{operation:"verify",code:good.code})]);assert.equal(replies.filter(x=>x.body.ok).length,1);
  });
  await check("delivery unavailable/failure never reveals a code or verifies a mailbox",async()=>{
    const inv=await invitation(),r=await start(inv);process.env.ADMIN_INVITATION_DELIVERY="disabled";const disabled=await api(r.jar,{operation:"request_code"});assert(!disabled.body.ok);assert(disabled.body.message.includes("unavailable"));assert.equal(await prisma.adminMailboxChallenge.count({where:{onboarding:{invitationId:inv.id}}}),0);process.env.ADMIN_INVITATION_DELIVERY="local-sink";sinkFailure=true;try{assert(!(await api(r.jar,{operation:"request_code"})).body.ok);}finally{sinkFailure=false;}const row=await prisma.adminMailboxChallenge.findFirstOrThrow({where:{onboarding:{invitationId:inv.id}}});assert.equal(row.deliveryState,"failed");assert(row.invalidatedAt);assert.equal((await status(r.jar)).stage,"verifying");
  });
  await check("expired codes/proofs fail closed and a new mailbox proof can resume safely",async()=>{
    const inv=await invitation(),id=randomUUID(),cap=id+"."+randomBytes(32).toString("base64url"),challengeId=randomUUID(),code="12345678",created=new Date(Date.now()-900000),proof=new Date(Date.now()-660000);
    await prisma.adminOnboarding.create({data:{id,invitationId:inv.id,capabilityHash:attemptVerifier(cap),createdAt:created,expiresAt:new Date(created.getTime()+1800000),mailRequests:1,lastMailAt:new Date(Date.now()-720000)}});
    await prisma.adminMailboxChallenge.create({data:{id:challengeId,onboardingId:id,verifier:mailboxVerifier(Buffer.from(codeKey,"base64"),id,challengeId,code),createdAt:new Date(Date.now()-720000),expiresAt:new Date(Date.now()-120000),deliveryState:"delivered",deliveredAt:new Date(Date.now()-720000),receiptHash:randomBytes(32).toString("hex")}});
    const jar:Jar=new Map([[ONBOARDING_COOKIE,cap]]);assert(!(await api(jar,{operation:"verify",code})).body.ok);
    // A legitimate historical consumed proof is assembled in the disposable DB;
    // no public proof-setting option or production test override exists.
    await admin.query("UPDATE admin_mailbox_challenges SET invalidated_at=clock_timestamp() WHERE id=$1",[challengeId]);
    const consumedId=randomUUID();await prisma.adminMailboxChallenge.create({data:{id:consumedId,onboardingId:id,verifier:mailboxVerifier(Buffer.from(codeKey,"base64"),id,consumedId,"87654321"),createdAt:new Date(Date.now()-720000),expiresAt:new Date(Date.now()-120000),deliveryState:"delivered",deliveredAt:new Date(Date.now()-720000),receiptHash:randomBytes(32).toString("hex"),consumedAt:proof}});
    await prisma.adminOnboarding.update({where:{id},data:{state:"mailbox_verified",mailboxVerifiedAt:proof,verifiedChallengeId:consumedId,version:{increment:1}}});const p=password();const denied=await api(jar,{operation:"provision",password:p,confirmation:p});assert(!denied.body.ok);assert(denied.body.message.includes("expired"));assert.equal(await prisma.user.count({where:{email:inv.email}}),0);
    assert((await api(jar,{operation:"request_code"})).body.ok);assert.equal((await status(jar)).stage,"verifying");assert((await api(jar,{operation:"verify",code:latestCode(inv.email).code})).body.ok);assert((await api(jar,{operation:"provision",password:p,confirmation:p})).body.ok);
  });
  await check("mailbox audit failure rolls back challenge consumption and permits one valid retry",async()=>{
    const inv=await invitation(),r=await start(inv);assert((await api(r.jar,{operation:"request_code"})).body.ok);const code=latestCode(inv.email);
    await admin.query("CREATE FUNCTION test_mailbox_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='onboarding.verify' THEN RAISE EXCEPTION 'TEST mailbox audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER test_mailbox_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_mailbox_audit_fail()");
    try{assert(!(await api(r.jar,{operation:"verify",code:code.code})).body.ok);assert.equal((await prisma.adminMailboxChallenge.findUniqueOrThrow({where:{id:code.id}})).consumedAt,null);assert.equal((await status(r.jar)).stage,"verifying");}finally{await admin.query("DROP TRIGGER test_mailbox_audit_fail ON audit_logs;DROP FUNCTION test_mailbox_audit_fail()");}
    assert((await api(r.jar,{operation:"verify",code:code.code})).body.ok);assert(!(await api(r.jar,{operation:"verify",code:code.code})).body.ok);
  });
  await check("origin, CSRF header, unbound cookies and oversized payloads are denied",async()=>{
    const inv=await invitation();const base={operation:"start",invitationId:inv.id,secret:inv.secret};for(const extra of[{origin:"https://evil.invalid"},{"sec-fetch-site":"cross-site"},{"x-staff-onboarding":"0"},{"content-type":"text/plain"}])assert.equal((await api(new Map(),base,extra)).status,400);assert.equal((await api(new Map(),{...base,secret:"x".repeat(5000)})).status,400);const fake:Jar=new Map([[ONBOARDING_COOKIE,randomUUID()+"."+randomBytes(32).toString("base64url")]]);assert(!(await api(fake,{operation:"request_code"})).body.ok);
  });
  await check("audit failure rolls back user/account/membership/progress and retry provisions once",async()=>{
    const inv=await invitation(),r=await verified(inv),p=password(),before=await prisma.adminOnboarding.findFirstOrThrow({where:{invitationId:inv.id}});
    await admin.query("CREATE FUNCTION test_onboarding_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='onboarding.provision' THEN RAISE EXCEPTION 'TEST provisioning audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER test_onboarding_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_onboarding_audit_fail()");
    try{assert(!(await api(r.jar,{operation:"provision",password:p,confirmation:p})).body.ok);assert.equal(await prisma.user.count({where:{email:inv.email}}),0);assert.deepEqual(await prisma.adminOnboarding.findFirstOrThrow({where:{invitationId:inv.id}}),before);}finally{await admin.query("DROP TRIGGER test_onboarding_audit_fail ON audit_logs;DROP FUNCTION test_onboarding_audit_fail()");}
    assert((await api(r.jar,{operation:"provision",password:p,confirmation:p})).body.ok);assert.equal(await prisma.user.count({where:{email:inv.email}}),1);
  });
  for(const delayAt of["account","audit"]){await check(`expiry during ${delayAt} write rolls back all provisioning records`,async()=>{
    const inv=await invitation(),id=randomUUID(),cap=id+"."+randomBytes(32).toString("base64url"),challengeId=randomUUID(),now=new Date(),proof=new Date(now.getTime()-1000),expires=new Date(now.getTime()+1200);
    await prisma.adminOnboarding.create({data:{id,invitationId:inv.id,capabilityHash:attemptVerifier(cap),createdAt:new Date(expires.getTime()-1800000),expiresAt:expires,mailRequests:1}});
    await prisma.adminMailboxChallenge.create({data:{id:challengeId,onboardingId:id,verifier:mailboxVerifier(Buffer.from(codeKey,"base64"),id,challengeId,"31415926"),createdAt:new Date(now.getTime()-2000),expiresAt:expires,deliveryState:"delivered",deliveredAt:new Date(now.getTime()-2000),receiptHash:randomBytes(32).toString("hex"),consumedAt:proof}});
    await prisma.adminOnboarding.update({where:{id},data:{state:"mailbox_verified",verifiedChallengeId:challengeId,mailboxVerifiedAt:proof,version:{increment:1}}});
    const trigger=delayAt==="account"?"BEFORE INSERT ON auth_accounts":"BEFORE INSERT ON audit_logs",condition=delayAt==="account"?"true":"NEW.action='onboarding.provision'";
    await admin.query(`CREATE FUNCTION test_onboarding_deadline_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$;CREATE TRIGGER test_onboarding_deadline_delay ${trigger} FOR EACH ROW EXECUTE FUNCTION test_onboarding_deadline_delay()`);
    const p=password(),started=Date.now();try{assert(!(await api(new Map([[ONBOARDING_COOKIE,cap]]),{operation:"provision",password:p,confirmation:p})).body.ok);assert(Date.now()-started>=1400);assert.equal(await prisma.user.count({where:{email:inv.email}}),0);assert.equal(await prisma.adminUser.count({where:{user:{email:inv.email}}}),0);assert.equal((await prisma.adminOnboarding.findUniqueOrThrow({where:{id}})).state,"mailbox_verified");}finally{await admin.query(`DROP TRIGGER test_onboarding_deadline_delay ON ${delayAt==="account"?"auth_accounts":"audit_logs"};DROP FUNCTION test_onboarding_deadline_delay()`);}
  });}
  await check("abandoned attempts cannot be reopened; a bounded new attempt preserves history",async()=>{
    const inv=await invitation(),id=randomUUID(),cap=id+"."+randomBytes(32).toString("base64url");await prisma.adminOnboarding.create({data:{id,invitationId:inv.id,capabilityHash:attemptVerifier(cap),createdAt:new Date(Date.now()-1860000),expiresAt:new Date(Date.now()-60000)}});const old:Jar=new Map([[ONBOARDING_COOKIE,cap]]);assert(!(await status(old)).ok);assert((await start(inv)).body.ok);assert.equal((await prisma.adminOnboarding.findUniqueOrThrow({where:{id}})).state,"expired");await assert.rejects(admin.query("UPDATE admin_onboarding SET state='verifying',closed_at=NULL,version=version+1 WHERE id=$1",[id]));
  });
  await check("durable global abuse counters fail closed and survive new request objects",async()=>{
    await admin.query("INSERT INTO staff_onboarding_limits(scope,window_start,attempts) VALUES('start',clock_timestamp(),30) ON CONFLICT(scope) DO UPDATE SET window_start=excluded.window_start,attempts=30");const r=await start(first,new Map());assert(!r.body.ok);assert(r.body.message.includes("Too many requests"));assert.equal((await prisma.staffOnboardingLimit.findUniqueOrThrow({where:{scope:"start"}})).attempts,30);await admin.query("UPDATE staff_onboarding_limits SET window_start=clock_timestamp()-interval '61 seconds'");
  });
  await check("onboarding migration recreation rolls back without loss; audit remains append-only",async()=>{
    const before=await prisma.adminOnboarding.findMany({orderBy:{id:"asc"}});await admin.query("BEGIN");try{await admin.query("DROP TRIGGER staff_invitation_consumption ON admin_invitations;DROP FUNCTION guard_staff_invitation_consumption();DROP TRIGGER invited_staff_activation ON admin_users;DROP FUNCTION guard_invited_staff_activation();DROP TRIGGER admin_invitation_close_onboarding ON admin_invitations;DROP FUNCTION close_invitation_onboarding();DROP TABLE admin_mailbox_challenges,admin_onboarding,staff_onboarding_limits;DROP FUNCTION protect_admin_onboarding();DROP FUNCTION protect_mailbox_challenge();ALTER TABLE admin_users DROP CONSTRAINT admin_users_id_user_id_key");await admin.query(readFileSync("prisma/migrations/20261030040000_add_staff_onboarding/migration.sql","utf8").replace(/^BEGIN;\s*/,"").replace(/COMMIT;\s*$/,""));}finally{await admin.query("ROLLBACK");}assert.deepEqual(await prisma.adminOnboarding.findMany({orderBy:{id:"asc"}}),before);for(const sql of["UPDATE audit_logs SET entity_id='bad'","DELETE FROM audit_logs","TRUNCATE audit_logs"])await assert.rejects(admin.query(sql));
  });
  await check("raw credentials/codes are absent from public DTOs and database logs",async()=>{
    const logs=spawnSync("docker",["logs",process.env.INVENTORY_TEST_CONTAINER!],{encoding:"utf8",windowsHide:true,maxBuffer:32*1024*1024});assert.equal(logs.status,0);const all=logs.stdout+logs.stderr;for(const message of inbox.values()){const raw=message.text.match(/Secret: ([A-Za-z0-9_-]{43})/)?.[1]??message.text.match(/code is (\d{8})/)?.[1];if(raw)assert(!all.includes(raw));}assert(!all.includes(firstPassword));const dto=JSON.stringify(await status(firstJar));for(const forbidden of["role","email","password","capabilityHash","verifier","mfaVerifiedAt"])assert(!dto.includes(forbidden));
  });
  if(process.env.STAFF_ACTIVATION_VERIFY==="1") await activationChecks();
  if(process.env.ONBOARDING_BROWSER==="1")await check("actual staff onboarding browser acceptance",browserFixture);
  return {status:"PASSED",cases:results};
}

function authCode(key: string, time = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let bits = 0, buffer = 0;
  for (const char of key.toUpperCase()) {
    const value = alphabet.indexOf(char);
    assert(value >= 0);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) bytes.push((buffer >>> (bits -= 8)) & 255);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function activateApi(jar: Jar, body: object, override?: Record<string, string>) {
  const h = headers(jar);
  h.set("content-type", "application/json");
  h.set("x-staff-onboarding", "1");
  for (const [key, value] of Object.entries(override ?? {})) h.set(key, value);
  const response = await activationRoute(new NextRequest(origin + "/api/staff/activation", {
    method: "POST", headers: h, body: JSON.stringify(body),
  }));
  absorb(jar, response);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  return { status: response.status, body: await response.json() };
}

async function provisionRecipient(inv: Invite) {
  const progress = await verified(inv);
  const chosen = password();
  assert((await api(progress.jar, { operation: "provision", password: chosen, confirmation: chosen })).body.ok);
  const jar: Jar = new Map();
  const signedIn = await request(jar, "/sign-in/email", { email: inv.email, password: chosen });
  assert.equal(signedIn.status, 200);
  assert(!signedIn.body.twoFactorRedirect);
  const user = await prisma.user.findUniqueOrThrow({ where: { email: inv.email } });
  return { inv, user, chosen, jar, capability: progress.jar };
}

type Recipient = Awaited<ReturnType<typeof provisionRecipient>>;
async function openSetup(recipient: Recipient) {
  const reply = await activateApi(recipient.jar, { operation: "setup", password: recipient.chosen });
  assert(reply.body.ok, reply.body.message);
  assert.match(reply.body.setupKey, /^[A-Z2-7]+$/i);
  assert(!("backupCodes" in reply.body) && !("token" in reply.body));
  return reply.body.setupKey as string;
}

async function pendingSnapshot(recipient: Recipient) {
  const id = recipient.user.id;
  const [invitation, onboarding, user, membership, factor, sessions, audits] = await Promise.all([
    prisma.adminInvitation.findUniqueOrThrow({ where: { id: recipient.inv.id } }),
    prisma.adminOnboarding.findUniqueOrThrow({ where: { userId: id } }),
    prisma.user.findUniqueOrThrow({ where: { id } }),
    prisma.adminUser.findUniqueOrThrow({ where: { userId: id } }),
    prisma.twoFactor.findMany({ where: { userId: id }, orderBy: { id: "asc" } }),
    prisma.session.findMany({ where: { userId: id }, orderBy: { id: "asc" } }),
    prisma.auditLog.count({ where: { action: "onboarding.activate", actor: { userId: id } } }),
  ]);
  return { invitation, onboarding, user, membership, factor, sessions, audits };
}

async function freshRoleLogin(recipient: Recipient, key: string) {
  const jar: Jar = new Map();
  const signedIn = await request(jar, "/sign-in/email", { email: recipient.inv.email, password: recipient.chosen });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.twoFactorRedirect, true);
  for (const permission of ADMIN_PERMISSIONS) await assert.rejects(requireAdminPermission(permission, headers(jar)));
  assert.equal((await request(jar, "/two-factor/verify-totp", { code: authCode(key) })).status, 200);
  const expected: Record<string, string[]> = {
    PRODUCT_MANAGER: ["catalog:read", "catalog:write", "inventory:manage"],
    ORDER_MANAGER: ["orders:read", "orders:manage"],
    MARKETING_MANAGER: ["catalog:read", "marketing:manage", "content:manage"],
  };
  for (const permission of ADMIN_PERMISSIONS) {
    if (expected[recipient.inv.role].includes(permission)) {
      assert.equal((await requireAdminPermission(permission, headers(jar))).role, recipient.inv.role);
    } else {
      await assert.rejects(requireAdminPermission(permission, headers(jar)));
    }
  }
  return jar;
}

async function activationChecks() {
  let recipient: Recipient;
  let key = "";
  await check("fresh native password login resumes after lost cookie and original attempt deadline", async () => {
    recipient = await provisionRecipient(await invitation());
    assert(!recipient.jar.has(ONBOARDING_COOKIE));
    assert.equal((await activateApi(new Map(), { operation: "status" })).body.stage, "sign_in");
    assert(!(await request(new Map(), "/sign-in/email", { email: recipient.inv.email, password: password() })).body.token);
    assert.equal((await activateApi(ownerJar, { operation: "status" })).body.stage, "unavailable");
    assert.equal((await activateApi(recipient.jar, { operation: "status", userId: owner.id })).status, 400);
    assert.equal((await activateApi(recipient.jar, { operation: "status" }, { origin: "https://evil.invalid" })).status, 400);
    // Move the *disposable* attempt's original deadline into the past, leaving
    // the bound invitation valid. Restore the ALWAYS trigger immediately.
    await admin.query("BEGIN");
    try {
      await admin.query("ALTER TABLE admin_onboarding DISABLE TRIGGER admin_onboarding_transition");
      await admin.query("UPDATE admin_onboarding SET created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '1 minute 1 second' WHERE user_id=$1", [recipient.user.id]);
      await admin.query("ALTER TABLE admin_onboarding ENABLE ALWAYS TRIGGER admin_onboarding_transition");
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    assert(!(await status(recipient.capability)).ok);
    assert(!(await api(recipient.capability, { operation: "request_code" })).body.ok);
    assert.equal((await activateApi(recipient.jar, { operation: "status" })).body.stage, "setup");
    assert(!(await activateApi(recipient.jar, { operation: "setup", password: password() })).body.ok);
    assert.equal((await activateApi(recipient.jar, { operation: "activate", code: "123456" })).body.stage, "setup");
    for (const permission of ADMIN_PERMISSIONS) await assert.rejects(requireAdminPermission(permission, headers(recipient.jar)));
  });
  await check("enrollment is scoped, concurrent setup returns one exact pending factor and native public verification denies it", async () => {
    const direct = new Map(recipient.jar);
    assert((await request(direct, "/two-factor/enable", { password: recipient.chosen })).status >= 400);
    const both = await Promise.all([openSetup(recipient), openSetup({ ...recipient, jar: new Map(recipient.jar) })]);
    key = both[0];
    assert(both[1] === key, "Concurrent setup must recover the same factor");
    const state = await pendingSnapshot(recipient);
    assert.equal(state.factor.length, 1);
    assert.equal(state.factor[0].verified, false);
    assert.equal(state.user.twoFactorEnabled, false);
    assert.equal(state.factor[0].id, state.onboarding.enrollmentFactorId);
    assert((await request(direct, "/two-factor/get-totp-uri", { password: recipient.chosen })).status >= 400);
    assert((await request(direct, "/two-factor/verify-totp", { code: authCode(key) })).status >= 400);
    const wrong = [0,1,2].map(n => String(n).padStart(6,"0")).find(value =>
      ![-30_000,0,30_000].some(offset => value === authCode(key, Date.now()+offset)))!;
    assert(!(await activateApi(recipient.jar, { operation: "activate", code: wrong })).body.ok);
    assert.equal((await pendingSnapshot(recipient)).onboarding.enrollmentFailures, 1);
    await assert.rejects(admin.query("UPDATE admin_users SET active=true WHERE user_id=$1", [recipient.user.id]));
    await assert.rejects(admin.query("UPDATE admin_invitations SET state='consumed',consumed_at=clock_timestamp(),consumed_user_id=$1,version=version+1 WHERE id=$2", [recipient.user.id,recipient.inv.id]));
  });
  await check("activation audit failure rolls back Better Auth factor and session rotation with all application writes", async () => {
    const before = await pendingSnapshot(recipient);
    await admin.query("CREATE FUNCTION test_activation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='onboarding.activate' THEN RAISE EXCEPTION 'TEST activation audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER test_activation_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_activation_failure()");
    try {
      assert(!(await activateApi(recipient.jar, { operation: "activate", code: authCode(key) })).body.ok);
      assert.deepEqual(await pendingSnapshot(recipient), before);
    } finally {
      await admin.query("DROP TRIGGER test_activation_failure ON audit_logs; DROP FUNCTION test_activation_failure()");
    }
  });
  await check("process termination after native TOTP verification rolls back and fresh login resumes the exact factor", async () => {
    const before = await pendingSnapshot(recipient);
    await admin.query("CREATE FUNCTION test_activation_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='onboarding.activate' THEN PERFORM pg_advisory_xact_lock(88013,1); END IF; RETURN NEW; END $$;CREATE TRIGGER test_activation_interrupt BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_activation_interrupt()");
    await admin.query("SELECT pg_advisory_lock(88013,1)");
    const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", resolve("scripts/verify-staff-onboarding.ts"), "--interrupt-activation"],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    const stopped = once(child, "exit");
    try {
      child.stdin.end(JSON.stringify({ cookie: headers(recipient.jar).get("cookie"), code: authCode(key) }));
      let waiting = false;
      for (let i = 0; i < 125 && child.exitCode === null; i++) {
        waiting = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=88013 AND objid=1 AND NOT granted) waiting")).rows[0].waiting;
        if (waiting) break;
        await delay(40);
      }
      assert(waiting, "Child must reach the audit barrier after verification and session rotation");
      assert(child.kill());
      await stopped;
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await stopped; }
      await admin.query("SELECT pg_advisory_unlock(88013,1)");
      await admin.query("BEGIN; SET LOCAL lock_timeout='5s'; SELECT pg_advisory_xact_lock(88009,1); ROLLBACK");
      await admin.query("DROP TRIGGER test_activation_interrupt ON audit_logs; DROP FUNCTION test_activation_interrupt()");
    }
    assert.deepEqual(await pendingSnapshot(recipient), before);
    const freshJar: Jar = new Map();
    assert.equal((await request(freshJar, "/sign-in/email", { email: recipient.inv.email, password: recipient.chosen })).status, 200);
    assert.equal((await activateApi(freshJar, { operation: "status" })).body.stage, "verify");
    assert(await openSetup({ ...recipient, jar: freshJar }) === key, "Recovery must keep the exact factor");
  });
  await check("concurrent activation consumes once, revokes all sessions, rejects replay and enforces cutoff", async () => {
    const oldJar = new Map(recipient.jar);
    const before = await pendingSnapshot(recipient);
    const obsolete = "2fa-" + randomUUID();
    for (const [identifier,value] of [[obsolete,recipient.user.id],["2fa-attempts-"+obsolete,"0"]]) {
      await prisma.verification.create({ data: { id: randomUUID(), identifier, value, expiresAt: new Date(Date.now()+60_000) } });
    }
    const results = await Promise.all([activateApi(recipient.jar, { operation: "activate", code: authCode(key) }),
      activateApi(new Map(oldJar), { operation: "activate", code: authCode(key) })]);
    assert.equal(results.filter(r => r.body.stage === "completed").length, 1);
    const after = await pendingSnapshot(recipient);
    assert.equal(after.invitation.state, "consumed");
    assert.equal(after.invitation.consumedUserId, recipient.user.id);
    assert.equal(after.onboarding.state, "completed");
    assert.equal(after.membership.active, true);
    assert.equal(after.membership.governanceVersion, before.membership.governanceVersion + BigInt(1));
    assert(after.membership.authorizationNotBefore > before.membership.authorizationNotBefore);
    assert.equal(after.sessions.length, 0);
    assert.equal(after.audits, 1);
    assert.equal(await prisma.verification.count({ where: { identifier: { in: [obsolete, "2fa-attempts-"+obsolete] } } }), 0);
    assert(!(await start(recipient.inv)).body.ok);
    assert(!(await activateApi(oldJar, { operation: "activate", code: authCode(key) })).body.ok);
    assert(!(await status(recipient.capability)).ok);
    await assert.rejects(admin.query("UPDATE admin_invitations SET state='delivered',version=version+1 WHERE id=$1", [recipient.inv.id]));
    const oldSession = before.sessions.find(s => decodeURIComponent(headers(oldJar).get("cookie")!).includes(s.token))!;
    assert(oldSession);
    await prisma.session.create({ data: { ...oldSession, mfaVerifiedAt: oldSession.createdAt } });
    for (const permission of ADMIN_PERMISSIONS) await assert.rejects(requireAdminPermission(permission, headers(oldJar)));
    await prisma.session.delete({ where: { id: oldSession.id } });
    const jar = await freshRoleLogin(recipient, key);
    assert.equal((await activateApi(jar, { operation: "status" })).body.stage, "completed");
    assert(!(await activateApi(jar, { operation: "setup", password: recipient.chosen })).body.ok);
  });
  await check("revocation during enrollment and stale password sessions fail closed", async () => {
    const revoked = await provisionRecipient(await invitation("ORDER_MANAGER"));
    const revokedKey = await openSetup(revoked);
    await close(revoked.inv);
    assert(!(await activateApi(revoked.jar, { operation: "activate", code: authCode(revokedKey) })).body.ok);
    assert.equal((await pendingSnapshot(revoked)).factor[0].verified, false);
    const stale = await provisionRecipient(await invitation("MARKETING_MANAGER"));
    await prisma.session.updateMany({ where: { userId: stale.user.id }, data: { createdAt: new Date(Date.now()-6*60_000) } });
    assert.equal((await activateApi(stale.jar, { operation: "setup", password: stale.chosen })).body.stage, "sign_in");
    assert.equal((await pendingSnapshot(stale)).factor.length, 0);
  });
  await check("verification is identity-bound, rate limits survive fresh login, and Owner factor controls stay private", async () => {
    const limited = await provisionRecipient(await invitation("MARKETING_MANAGER"));
    const limitedKey = await openSetup(limited);
    const wrong = ["000000","000001","000002","000003"].find(value =>
      ![-60_000,-30_000,0,30_000,60_000].some(offset => value === authCode(limitedKey, Date.now()+offset)))!;
    for (let i = 0; i < 5; i++) assert(!(await activateApi(limited.jar, { operation: "activate", code: wrong })).body.ok);
    const state = await pendingSnapshot(limited);
    assert.equal(state.onboarding.enrollmentFailures, 5);
    assert(state.onboarding.enrollmentLockedUntil! > new Date());
    const freshJar: Jar = new Map();
    assert.equal((await request(freshJar, "/sign-in/email", { email: limited.inv.email, password: limited.chosen })).status, 200);
    assert(!(await activateApi(freshJar, { operation: "activate", code: authCode(limitedKey) })).body.ok);
    assert.equal((await pendingSnapshot(limited)).factor[0].verified, false);

    const other = await provisionRecipient(await invitation("ORDER_MANAGER"));
    const otherKey = await openSetup(other);
    const time = Date.now();
    const stolenCode = [-30_000,0,30_000].map(offset => authCode(limitedKey,time+offset)).find(code =>
      ![-60_000,-30_000,0,30_000,60_000].some(offset => code === authCode(otherKey,time+offset)))!;
    assert(!(await activateApi(other.jar, { operation: "activate", code: stolenCode })).body.ok);
    assert.equal((await pendingSnapshot(other)).factor[0].verified, false);
    assert.equal((await activateApi(other.jar, { operation: "setup", password: other.chosen, role: "OWNER" })).status, 400);
    for (const path of ["/two-factor/enable","/two-factor/get-totp-uri","/two-factor/disable","/two-factor/verify-backup-code"]) {
      assert((await request(new Map(ownerJar), path, { password: owner.password })).status >= 400);
    }
    assert.equal((await requireAdminPermission("admins:manage", headers(ownerJar))).role, "OWNER");
  });
  await check("invitation expiry during activation audit rolls back factor, sessions, consumption and membership", async () => {
    const inv = await historical("delivered", false, email(), 7_000);
    const expiring = await provisionRecipient(inv);
    const expiringKey = await openSetup(expiring);
    const before = await pendingSnapshot(expiring);
    await admin.query("CREATE FUNCTION test_activation_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='onboarding.activate' THEN PERFORM pg_sleep(2.5); END IF; RETURN NEW; END $$;CREATE TRIGGER test_activation_expiry BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_activation_expiry()");
    try {
      await delay(Math.max(0, before.invitation.expiresAt.getTime() - Date.now() - 1_500));
      const started = Date.now();
      assert(!(await activateApi(expiring.jar, { operation: "activate", code: authCode(expiringKey) })).body.ok);
      assert(Date.now()-started >= 2400, "Must enter the activation transaction before expiry");
      assert.deepEqual(await pendingSnapshot(expiring), before);
      assert.equal((await activateApi(expiring.jar, { operation: "status" })).body.stage, "unavailable");
    } finally {
      await admin.query("DROP TRIGGER test_activation_expiry ON audit_logs; DROP FUNCTION test_activation_expiry()");
    }
  });
  await check("native fresh login gives Order and Marketing staff exactly their assigned permissions", async () => {
    for (const role of ["ORDER_MANAGER", "MARKETING_MANAGER"]) {
      const staff = await provisionRecipient(await invitation(role));
      const staffKey = await openSetup(staff);
      assert((await activateApi(staff.jar, { operation: "activate", code: authCode(staffKey) })).body.ok);
      await freshRoleLogin(staff, staffKey);
    }
  });
  await check("activation audit rows and PostgreSQL statement logs omit setup keys, TOTP, passwords and invitation secrets", async () => {
    const logs = spawnSync("docker", ["logs", process.env.INVENTORY_TEST_CONTAINER!], { encoding: "utf8", windowsHide: true, maxBuffer: 32*1024*1024 });
    assert.equal(logs.status,0);
    const audits = await prisma.auditLog.findMany({ where: { action: { in: ["onboarding.enroll", "onboarding.activate"] } }, select: { summary: true } });
    assert(audits.length >= 6);
    const audit = JSON.stringify(audits);
    assert(!/secret|password|token|backup|code/i.test(audit));
    for (const secret of [recipient.chosen, recipient.inv.secret, key]) {
      assert(!(logs.stdout + logs.stderr).includes(secret) && !audit.includes(secret));
    }
  });
}

async function browserFixture(){
  const success=await invitation("ORDER_MANAGER"),revoked=await invitation(),bad=await invitation();await close(revoked);
  const activation = process.env.STAFF_ACTIVATION_VERIFY==="1";
  const expired = activation ? await historical("delivered",true) : undefined;
  const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();assert(address&&typeof address==="object");const port=address.port;await new Promise<void>(r=>server.close(()=>r()));const base=`http://127.0.0.1:${port}`,generated=readFileSync("next-env.d.ts"),config=readFileSync("tsconfig.json");
  const child=spawn(process.execPath,[resolve("scripts/inventory-test-server.mjs"),String(port)],{env:{...process.env,AAFIYAT_INVENTORY_TEST_RUN:run,BETTER_AUTH_URL:base,NODE_ENV:"development",NEXT_TELEMETRY_DISABLED:"1"},windowsHide:true,stdio:"ignore"});
  const ready=process.env.INVENTORY_TEST_RESULTS+".browser-ready.json",finished=process.env.INVENTORY_TEST_RESULTS+".browser-finished.json";
  try{let booted=false;for(let i=0;i<40;i++){try{if((await fetch(base+"/staff/accept-invitation",{signal:AbortSignal.timeout(5000)})).ok){booted=true;break;}}catch{}await delay(500);}assert(booted);writeFileSync(ready,JSON.stringify({origin:base,success,revoked,bad,expired,mailboxOrigin,mailboxAccess,databaseUrl:process.env.INVENTORY_TEST_ADMIN_URL,finished}),{mode:0o600});console.log("BROWSER_READY "+ready);for(let i=0;i<2400&&!existsSync(finished);i++)await delay(500);assert(existsSync(finished));assert.equal(JSON.parse(readFileSync(finished,"utf8")).status,"PASSED");const user=await prisma.user.findUniqueOrThrow({where:{email:success.email},include:{adminUser:true}});assert.equal(user.adminUser?.active,activation);assert.equal(user.twoFactorEnabled,activation);assert.equal(await prisma.twoFactor.count({where:{userId:user.id,verified:true}}),activation?1:0);const redeemed=await prisma.adminInvitation.findUniqueOrThrow({where:{id:success.id}});assert.equal(redeemed.consumedUserId,activation?user.id:null);assert.equal(redeemed.consumedAt!==null,activation);
  }finally{if(child.pid)spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});if(existsSync(ready))unlinkSync(ready);writeFileSync("next-env.d.ts",generated);writeFileSync("tsconfig.json",config);const output=resolve(`.local/inventory-a1-build-${run}`);assert(output.startsWith(resolve(".local")+sep));if(existsSync(output)){assert(!lstatSync(output).isSymbolicLink());rmSync(output,{recursive:true,force:true,maxRetries:3,retryDelay:300});}}
}
async function interruptActivation() {
  const { cookie, code } = JSON.parse(readFileSync(0, "utf8"));
  const h = headers(new Map());
  h.set("cookie", cookie);
  h.set("content-type", "application/json");
  h.set("x-staff-onboarding", "1");
  await activationRoute(new NextRequest(origin+"/api/staff/activation", { method:"POST", headers:h, body:JSON.stringify({operation:"activate",code}) }));
}

if (process.argv.includes("--interrupt-activation")) {
  interruptActivation().catch(() => { process.exitCode = 1; }).finally(() => prisma.$disconnect());
} else {
  verify().then(r=>writeFileSync(process.env.INVENTORY_TEST_RESULTS!,JSON.stringify(r,null,2))).catch(e=>{writeFileSync(process.env.INVENTORY_TEST_RESULTS!,JSON.stringify({status:"FAILED",failedAt:current,name:e?.name,code:e?.code,location:typeof e?.stack==="string"?e.stack.split("\n").find((line:string)=>/^\s+at /.test(line)):undefined,cases:results},null,2));console.error("FAIL: "+current+" "+e?.name);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();await admin.end();await new Promise<void>(r=>sink.close(()=>r()));});
}
