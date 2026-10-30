import assert from "node:assert/strict";
import { randomUUID,randomBytes,createHmac,createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync,writeFileSync,existsSync,unlinkSync,rmSync,lstatSync } from "node:fs";
import { resolve,sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn,spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { symmetricEncrypt } from "better-auth/crypto";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { changeInvitation,readInvitations,lockInvitationTransaction } from "../src/lib/admin-invitations";
import { deliverNextInvitation,recordInvitationDelivery } from "../src/lib/invitation-delivery";
import { invitationVerifier,openInvitationSecret,sealInvitationSecret,createInvitationSecret } from "../src/lib/invitation-secrets";
import { readAudit,changeStaff } from "../src/lib/admin-governance";
import { requireAdminPermission } from "../src/lib/admin-authorization";
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

const key = randomBytes(32).toString("base64"), knownSecrets: string[] = [];
const inbox = new Map<string,{ to:string; subject:string; text:string }>();
let sinkMode = "success", deliveries = 0;
const sink = createHttpServer(async (req,res) => {
  let raw=""; for await (const chunk of req) { raw+=chunk.toString(); if(raw.length>4096) {res.writeHead(413).end();return;} }
  const message=JSON.parse(raw),id=String(req.headers["idempotency-key"]??"");
  deliveries++;
  if(sinkMode==="failure"){res.writeHead(503).end();return;}
  if(sinkMode==="unconfirmed"){res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({accepted:false}));return;}
  assert.equal(req.url,"/messages");assert.match(id,/^[a-f0-9-]{36}$/);
  inbox.set(id,message);
  res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({accepted:true,messageId:sinkMode==="unsafe-receipt"?String(message.text).match(/Secret: ([A-Za-z0-9_-]{43})/)![1]:"sink_"+id}));
});
function createForm(email:string,role="PRODUCT_MANAGER") {const f=new FormData();for(const [k,v]of Object.entries({operation:"create",email,role}))f.set(k,v);return f;}
async function closeForm(id:string,operation="revoke",version?:string) {const f=new FormData();for(const [k,v]of Object.entries({operation,id,version:version??(await prisma.adminInvitation.findUniqueOrThrow({where:{id}})).version.toString(),confirm:"CONFIRM"}))f.set(k,v);return f;}
const newEmail=()=>randomUUID()+"@example.invalid";
async function rowFor(email:string){return prisma.adminInvitation.findFirstOrThrow({where:{email},orderBy:{createdAt:"desc"}});}
async function makeRaw(invitedBy:string,email=newEmail(),expired=false,ttl=172800000) {
  const id=randomUUID(),secret=createInvitationSecret();knownSecrets.push(secret);
  const createdAt=new Date(Date.now()-(expired?3600000:0)),expiresAt=new Date(createdAt.getTime()+(expired?1800000:ttl));
  return prisma.adminInvitation.create({data:{id,email,role:"ORDER_MANAGER",invitedBy,tokenHash:invitationVerifier(secret),deliveryCiphertext:sealInvitationSecret(secret,id,Buffer.from(key,"base64")),deliveryState:"queued",createdAt,expiresAt}});
}
async function forceDue(id:string){await admin.query("UPDATE admin_invitations SET next_attempt_at=clock_timestamp()-interval '1 second',version=version+1 WHERE id=$1",[id]);}

async function verify() {
  await admin.connect();assert.equal((await admin.query("SELECT current_database() db")).rows[0].db,database);
  assert.equal((await admin.query("SELECT count(*)::int n FROM _prisma_migrations")).rows[0].n,11);
  await new Promise<void>(r=>sink.listen(0,"127.0.0.1",r));const address=sink.address();assert(address&&typeof address==="object");
  const endpoint=`http://127.0.0.1:${address.port}/messages`;
  const owner=await identity("OWNER","TEST Invitation Owner"),staff=await identity("PRODUCT_MANAGER","TEST Invitation staff");
  const ownerJar=await login(owner),staffJar=await login(staff),h=headers(ownerJar);
  const identitiesBefore=await prisma.user.count();
  delete process.env.ADMIN_INVITATION_ENCRYPTION_KEY;delete process.env.ADMIN_INVITATION_DELIVERY;delete process.env.ADMIN_INVITATION_MAIL_SINK_URL;
  let firstId="",cryptoId="";
  await check("Owner creation persists without accounts or fictitious delivery",async()=>{
    const email=newEmail();const r=await changeInvitation(h,createForm("  "+email.toUpperCase()+"  "));assert(r.ok);assert(r.message.includes("Delivery not configured"));
    const row=await rowFor(email);firstId=row.id;assert.equal(row.email,email);assert.equal(row.state,"pending");assert.equal(row.deliveryState,"unconfigured");assert.equal(row.deliveryCiphertext,null);assert.match(row.tokenHash,/^[a-f0-9]{64}$/);assert.equal(await prisma.user.count(),identitiesBefore);assert.deepEqual(Object.keys(r).sort(),["message","ok"]);
    const read=await readInvitations(h);assert(read.rows.some(x=>x.id===row.id));for(const forbidden of ["tokenHash","deliveryCiphertext","leaseId","consumedUserId"])assert(!JSON.stringify(read).includes(forbidden));
  });
  await check("approved non-Owner roles only; Owner and forged fields rejected",async()=>{
    for(const role of ["PRODUCT_MANAGER","ORDER_MANAGER","MARKETING_MANAGER"]){const email=newEmail();assert((await changeInvitation(h,createForm(email,role))).ok);assert.equal((await rowFor(email)).role,role);}
    const count=await prisma.adminInvitation.count();assert(!(await changeInvitation(h,createForm(newEmail(),"OWNER"))).ok);
    const f=createForm(newEmail());f.set("actorId",owner.member);assert(!(await changeInvitation(h,f)).ok);assert.equal(await prisma.adminInvitation.count(),count);
  });
  await check("concurrent normalized duplicate active invitations have one winner",async()=>{
    const email=newEmail();const r=await Promise.all([changeInvitation(h,createForm(email)),changeInvitation(h,createForm(email.toUpperCase()))]);assert.equal(r.filter(x=>x.ok).length,1);assert.equal(await prisma.adminInvitation.count({where:{email}}),1);assert(r.some(x=>x.message.includes("active invitation")));
  });
  await check("invalid email and existing authentication identities cannot be claimed",async()=>{
    const n=await prisma.adminInvitation.count();for(const email of ["bad","a\n@example.invalid","a..b@example.invalid",owner.email.toUpperCase(),staff.email])assert(!(await changeInvitation(h,createForm(email))).ok);assert.equal(await prisma.adminInvitation.count(),n);
  });
  await check("256-bit secrets are hashed and encrypted independently; never returned",async()=>{
    process.env.ADMIN_INVITATION_ENCRYPTION_KEY=key;const email=newEmail(),r=await changeInvitation(h,createForm(email));assert(r.ok);const row=await rowFor(email);cryptoId=row.id;assert(row.deliveryCiphertext);const secret=openInvitationSecret(row.deliveryCiphertext,row.id,Buffer.from(key,"base64"));knownSecrets.push(secret);assert.equal(Buffer.from(secret,"base64url").length,32);assert.equal(invitationVerifier(secret),row.tokenHash);assert(!JSON.stringify(row,(_,v)=>typeof v==="bigint"?v.toString():v).includes(secret));assert(!JSON.stringify(r).includes(secret));assert(!JSON.stringify(await readInvitations(h)).includes(secret));
  });
  await check("revocation erases delivery material and persists terminal state",async()=>{
    assert((await changeInvitation(h,await closeForm(cryptoId))).ok);const row=await prisma.adminInvitation.findUniqueOrThrow({where:{id:cryptoId}});assert.equal(row.state,"revoked");assert.equal(row.deliveryCiphertext,null);assert.equal(row.revokedBy,owner.member);assert(!(await changeInvitation(h,await closeForm(cryptoId))).ok);
    await assert.rejects(admin.query("UPDATE admin_invitations SET state='pending',revoked_at=NULL,revoked_by=NULL,version=version+1 WHERE id=$1",[cryptoId]));
  });
  await check("optimistic conflicting close operations reject stale versions",async()=>{
    const version=(await prisma.adminInvitation.findUniqueOrThrow({where:{id:firstId}})).version.toString();const r=await Promise.all([changeInvitation(h,await closeForm(firstId,"revoke",version)),changeInvitation(h,await closeForm(firstId,"expire",version))]);assert.equal(r.filter(x=>x.ok).length,1);assert(r.some(x=>x.message.includes("changed")));
  });
  await check("natural and explicit expiry are irreversible; normalized destination can be reissued",async()=>{
    const expired=await makeRaw(owner.member,newEmail(),true);assert((await readInvitations(h)).rows.find(x=>x.id===expired.id)?.state==="expired");assert((await changeInvitation(h,createForm(expired.email))).ok);assert.equal((await prisma.adminInvitation.findUniqueOrThrow({where:{id:expired.id}})).state,"expired");
    const current=await rowFor(expired.email);assert((await changeInvitation(h,await closeForm(current.id,"expire"))).ok);assert.equal((await rowFor(expired.email)).state,"expired");assert(!(await changeInvitation(h,await closeForm(current.id))).ok);
  });
  await check("database rejects invalid roles, verifiers, expiry and identity mutation",async()=>{
    const row=await makeRaw(owner.member);for(const [column,value]of [["role","OWNER"],["token_hash","bad"],["state","invalid"]])await assert.rejects(admin.query(`UPDATE admin_invitations SET ${column}=$1,version=version+1 WHERE id=$2`,[value,row.id]));
    await assert.rejects(admin.query("UPDATE admin_invitations SET expires_at=created_at-interval '1 second',version=version+1 WHERE id=$1",[row.id]));assert((await changeInvitation(h,await closeForm(row.id))).ok);
  });
  await check("disabled delivery makes no network attempt or false success",async()=>{
    const count=deliveries;assert.equal((await deliverNextInvitation()).status,"unconfigured");assert.equal(deliveries,count);const row=await prisma.adminInvitation.findFirstOrThrow({where:{state:"pending"}});assert.equal(row.attempts,0);
  });
  const deliveryOwner=await identity("OWNER","TEST Delivery Owner"),deliveryJar=await login(deliveryOwner),dh=headers(deliveryJar);
  process.env.ADMIN_INVITATION_DELIVERY="local-sink";process.env.ADMIN_INVITATION_MAIL_SINK_URL=endpoint;
  await check("provider failure is persisted, bounded and never reported delivered",async()=>{
    const email=newEmail();assert((await changeInvitation(dh,createForm(email))).ok);let row=await rowFor(email);sinkMode="failure";
    for(let i=1;i<=5;i++){sinkMode=i===2?"unconfirmed":"failure";const result=await deliverNextInvitation();assert.equal(result.status,"failed");row=await rowFor(email);assert.equal(row.attempts,i);assert.equal(row.deliveredAt,null);assert.equal(row.state,"pending");if(i<5)await forceDue(row.id);}
    assert.equal(row.deliveryCiphertext,null);assert.equal(row.lastError,"attempts_exhausted");const n=deliveries;assert.equal((await deliverNextInvitation()).status,"idle");assert.equal(deliveries,n);sinkMode="success";
  });
  await check("real local sink confirmation, secret verification and idempotent receipt",async()=>{
    const email=newEmail();assert((await changeInvitation(dh,createForm(email,"ORDER_MANAGER"))).ok);const before=await rowFor(email);assert(before.deliveryCiphertext);const secret=openInvitationSecret(before.deliveryCiphertext,before.id,Buffer.from(key,"base64"));knownSecrets.push(secret);
    const result=await deliverNextInvitation();assert.equal(result.status,"delivered");const row=await rowFor(email);assert.equal(row.deliveryState,"delivered");assert.equal(row.state,"delivered");assert.equal(row.deliveryCiphertext,null);assert(row.deliveredAt);assert(inbox.get(row.id)?.text.includes(secret));assert.equal(invitationVerifier(secret),row.tokenHash);assert.equal(inbox.get(row.id)?.to,email);assert.equal(row.providerReceiptHash,createHash("sha256").update("invitation-provider-receipt:v1\0").update("sink_"+row.id).digest("hex"));
    const n=deliveries;await deliverNextInvitation();assert.equal(deliveries,n);assert(!JSON.stringify(await readAudit(dh,{entity:row.id})).includes(secret));
  });
  await check("lease-safe concurrent workers do not duplicate a live claim",async()=>{
    const row=await makeRaw(deliveryOwner.member);const before=deliveries;const r=await Promise.all([deliverNextInvitation(),deliverNextInvitation()]);assert.equal(r.filter(x=>x.status==="delivered").length,1);assert.equal(deliveries,before+1);assert.equal((await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}})).attempts,1);
  });
  await check("provider receipt metadata cannot persist an echoed invitation secret",async()=>{
    const row=await makeRaw(deliveryOwner.member);const secret=openInvitationSecret(row.deliveryCiphertext!,row.id,Buffer.from(key,"base64"));sinkMode="unsafe-receipt";
    try{assert.equal((await deliverNextInvitation()).status,"delivered");const current=await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}});assert.match(current.providerReceiptHash!,/^[a-f0-9]{64}$/);assert(!JSON.stringify(current,(_,v)=>typeof v==="bigint"?v.toString():v).includes(secret));}finally{sinkMode="success";}
  });
  await check("live leases exclude peers; expired claims recover with the same idempotency identity",async()=>{
    const row=await makeRaw(deliveryOwner.member);
    await admin.query("UPDATE admin_invitations SET delivery_state='sending',attempts=1,lease_id=$1,lease_until=clock_timestamp()+interval '30 seconds',version=version+1 WHERE id=$2",[randomUUID(),row.id]);
    const before=deliveries;assert.equal((await deliverNextInvitation()).status,"idle");assert.equal(deliveries,before);
    await admin.query("UPDATE admin_invitations SET lease_until=clock_timestamp()-interval '1 second',version=version+1 WHERE id=$1",[row.id]);
    assert.equal((await deliverNextInvitation()).status,"delivered");const current=await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}});assert.equal(current.attempts,2);assert.equal(current.providerReceiptHash,createHash("sha256").update("invitation-provider-receipt:v1\0").update("sink_"+row.id).digest("hex"));assert(inbox.has(row.id));
  });
  await check("post-confirmation audit failure preserves a retryable lease and idempotent recovery",async()=>{
    const row=await makeRaw(deliveryOwner.member),before=deliveries,accepted=inbox.size;
    await admin.query("CREATE FUNCTION test_invitation_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='invitation.delivery' AND NEW.summary->>'state'='delivered' THEN RAISE EXCEPTION 'TEST receipt audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER test_invitation_receipt_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_invitation_receipt_fail()");
    try{assert.equal((await deliverNextInvitation()).status,"unavailable");const current=await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}});assert.equal(current.state,"pending");assert.equal(current.deliveryState,"sending");assert(current.deliveryCiphertext);assert.equal(current.deliveredAt,null);assert.equal(deliveries,before+1);}finally{await admin.query("DROP TRIGGER test_invitation_receipt_fail ON audit_logs;DROP FUNCTION test_invitation_receipt_fail()");}
    await admin.query("UPDATE admin_invitations SET lease_until=clock_timestamp()-interval '1 second',version=version+1 WHERE id=$1",[row.id]);assert.equal((await deliverNextInvitation()).status,"delivered");assert.equal(deliveries,before+2);assert.equal(inbox.size,accepted+1);assert.equal(await prisma.auditLog.count({where:{entityId:row.id,action:"invitation.delivery",summary:{path:["state"],equals:"delivered"}}}),1);
  });
  await check("confirmed mail receipt remains accurate when finalization crosses expiry",async()=>{
    const row=await makeRaw(deliveryOwner.member,newEmail(),false,250);const secret=openInvitationSecret(row.deliveryCiphertext!,row.id,Buffer.from(key,"base64"));
    const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","idempotency-key":row.id},body:JSON.stringify({to:row.email,subject:"TEST delayed receipt",text:`Secret: ${secret}`})});const receipt=await response.json();assert.equal(receipt.accepted,true);
    const receiptHash=createHash("sha256").update("invitation-provider-receipt:v1\0").update(receipt.messageId).digest("hex");await delay(300);
    const result=await prisma.$transaction(async tx=>{await lockInvitationTransaction(tx);await tx.$queryRaw`SELECT id FROM admin_invitations WHERE id=${row.id}::uuid FOR UPDATE`;return recordInvitationDelivery(tx,row,receiptHash,"provider_failure");});
    assert.equal(result.status,"expired");const current=await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}});assert.equal(current.state,"expired");assert.equal(current.deliveryState,"delivered");assert(current.expiredAt);assert(current.deliveredAt);assert.equal(current.providerReceiptHash,receiptHash);assert.equal(current.deliveryCiphertext,null);
    assert.equal(await prisma.auditLog.count({where:{entityId:row.id,action:"invitation.expire"}}),1);assert.equal(await prisma.auditLog.count({where:{entityId:row.id,action:"invitation.delivery",summary:{path:["state"],equals:"delivered"}}}),1);
  });
  await check("revocation and expiry prevent subsequent delivery attempts",async()=>{
    const row=await makeRaw(deliveryOwner.member);assert((await changeInvitation(dh,await closeForm(row.id))).ok);const expired=await makeRaw(deliveryOwner.member,newEmail(),true);const before=deliveries;await deliverNextInvitation();assert.equal(deliveries,before);assert.equal((await prisma.adminInvitation.findUniqueOrThrow({where:{id:expired.id}})).state,"expired");assert.equal((await prisma.adminInvitation.findUniqueOrThrow({where:{id:expired.id}})).deliveryCiphertext,null);
  });
  await check("missing/stale MFA and non-Owner invitations are denied atomically",async()=>{
    const count=await prisma.adminInvitation.count(),audit=await prisma.auditLog.count();const session=await auth.api.getSession({headers:h,query:{disableCookieCache:true,disableRefresh:true}});const stored=await prisma.session.findUniqueOrThrow({where:{id:session!.session.id}});
    for(const proof of [null,new Date(Date.now()-13*3600000)]){await admin.query("UPDATE auth_sessions SET mfa_verified_at=$1 WHERE id=$2",[proof,stored.id]);assert(!(await changeInvitation(h,createForm(newEmail()))).ok);}await admin.query("UPDATE auth_sessions SET mfa_verified_at=$1 WHERE id=$2",[stored.mfaVerifiedAt,stored.id]);
    for(const role of ["PRODUCT_MANAGER","ORDER_MANAGER","MARKETING_MANAGER"]){const who=role==="PRODUCT_MANAGER"?staff:await identity(role);const jar=role==="PRODUCT_MANAGER"?staffJar:await login(who);assert(!(await changeInvitation(headers(jar),createForm(newEmail()))).ok);await assert.rejects(readInvitations(headers(jar)));}
    assert.equal(await prisma.adminInvitation.count(),count);assert.equal(await prisma.auditLog.count(),audit);
  });
  await check("anonymous, cross-origin, duplicate fields and forged session inputs denied",async()=>{
    const before=await prisma.adminInvitation.count();const evil=headers(ownerJar);evil.set("origin","https://evil.invalid");const sameOriginCrossSite=headers(ownerJar);sameOriginCrossSite.set("sec-fetch-site","cross-site");for(const bad of [new Headers({origin}),evil,sameOriginCrossSite])assert(!(await changeInvitation(bad,createForm(newEmail()))).ok);
    const f=createForm(newEmail());f.append("role","OWNER");assert(!(await changeInvitation(h,f)).ok);const g=createForm(newEmail());g.set("session",storedPlaceholder());assert(!(await changeInvitation(h,g)).ok);assert.equal(await prisma.adminInvitation.count(),before);
  });
  await check("audit failure rolls back invitation creation, revocation and delivery claim",async()=>{
    const row=await makeRaw(deliveryOwner.member);const before=await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}}),n=await prisma.adminInvitation.count(),sent=deliveries;
    await admin.query("CREATE FUNCTION test_invitation_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'invitation.%' THEN RAISE EXCEPTION 'TEST audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER test_invitation_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_invitation_audit_fail()");
    try{assert(!(await changeInvitation(dh,createForm(newEmail()))).ok);assert.equal(await prisma.adminInvitation.count(),n);assert(!(await changeInvitation(dh,await closeForm(row.id))).ok);assert.deepEqual(await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}}),before);assert.equal((await deliverNextInvitation()).status,"unavailable");assert.equal(deliveries,sent);assert.deepEqual(await prisma.adminInvitation.findUniqueOrThrow({where:{id:row.id}}),before);}finally{await admin.query("DROP TRIGGER test_invitation_audit_fail ON audit_logs;DROP FUNCTION test_invitation_audit_fail()");}
    assert((await changeInvitation(dh,await closeForm(row.id))).ok);
  });
  await check("durable hourly abuse limit cannot be bypassed by concurrency",async()=>{
    const limited=await identity("OWNER","TEST Rate-limit Owner"),jar=await login(limited),lh=headers(jar);
    for(let i=0;i<9;i++)assert((await changeInvitation(lh,createForm(newEmail()))).ok);
    const r=await Promise.all([changeInvitation(lh,createForm(newEmail())),changeInvitation(lh,createForm(newEmail()))]);assert.equal(r.filter(x=>x.ok).length,1);assert(r.some(x=>x.message.includes("limit")));assert.equal(await prisma.adminInvitation.count({where:{invitedBy:limited.member}}),10);
    // No queued rows from the rate-limit probe may contaminate later delivery probes.
    for(const row of await prisma.adminInvitation.findMany({where:{invitedBy:limited.member}}))assert((await changeInvitation(lh,await closeForm(row.id))).ok);
  });
  await check("migration recreation/rollback and append-only audit preserve history",async()=>{
    const before=(await admin.query("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) hash FROM admin_invitations t")).rows[0];await admin.query("BEGIN");try{await admin.query("DROP TABLE admin_invitations;DROP FUNCTION protect_admin_invitation()");await admin.query(readFileSync("prisma/migrations/20261030030000_add_admin_invitations/migration.sql","utf8").replace(/^BEGIN;\s*/,"").replace(/COMMIT;\s*$/,""));}finally{await admin.query("ROLLBACK");}assert.deepEqual((await admin.query("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) hash FROM admin_invitations t")).rows[0],before);
    for(const sql of ["UPDATE audit_logs SET entity_id='bad'","DELETE FROM audit_logs","TRUNCATE audit_logs"])await assert.rejects(admin.query(sql));
  });
  await check("existing governance cutoff still rejects role-revoked invitation requests",async()=>{
    const other=await identity("OWNER","TEST Governance regression Owner"),otherJar=await login(other),oh=headers(otherJar);const actor=await requireAdminPermission("admins:manage",oh);assert.equal(actor.adminUserId,other.member);
    const f=new FormData();for(const [k,v]of Object.entries({id:other.member,version:"1",operation:"deactivate",role:"PRODUCT_MANAGER",confirm:"CONFIRM"}))f.set(k,v);assert((await changeStaff(h,f)).ok);assert(!(await changeInvitation(oh,createForm(newEmail()))).ok);await assert.rejects(requireAdminPermission("admins:manage",oh));
    for(const secret of knownSecrets){assert(!JSON.stringify(await readInvitations(h)).includes(secret));assert(!JSON.stringify(await readAudit(h,{})).includes(secret));}
    const logs=spawnSync("docker",["logs",process.env.INVENTORY_TEST_CONTAINER!],{encoding:"utf8",windowsHide:true,maxBuffer:16*1024*1024});assert.equal(logs.status,0);for(const secret of knownSecrets)assert(!(logs.stdout+logs.stderr).includes(secret));
  });
  if(process.env.INVITATION_BROWSER==="1")await check("actual password/TOTP invitation browser acceptance",browserFixture);
  return {status:"PASSED",cases:results,mailSink:{attempts:deliveries,accepted:inbox.size},knownSecretCount:knownSecrets.length};
}
function storedPlaceholder(){return "forged-client-session";}

async function browserFixture() {
  const owner=await identity("OWNER","TEST Browser invitation Owner"),staff=await identity("PRODUCT_MANAGER","TEST Browser invitation staff");
  const listener=createHttpServer();await new Promise<void>(r=>listener.listen(0,"127.0.0.1",r));const address=listener.address();assert(address&&typeof address==="object");const port=address.port;await new Promise<void>(r=>listener.close(()=>r()));
  const origin=`http://127.0.0.1:${port}`,generated=readFileSync("next-env.d.ts"),config=readFileSync("tsconfig.json");
  const child=spawn(process.execPath,[resolve("scripts/inventory-test-server.mjs"),String(port)],{env:{...process.env,ADMIN_INVITATION_DELIVERY:"disabled",AAFIYAT_INVENTORY_TEST_RUN:run,BETTER_AUTH_URL:origin,NODE_ENV:"development",NEXT_TELEMETRY_DISABLED:"1"},windowsHide:true,stdio:"ignore"});
  const ready=process.env.INVENTORY_TEST_RESULTS+".browser-ready.json",finished=process.env.INVENTORY_TEST_RESULTS+".browser-finished.json";
  try {
    let booted=false;for(let i=0;i<40;i++){try{if((await fetch(origin+"/admin/login",{signal:AbortSignal.timeout(5000)})).ok){booted=true;break;}}catch{}await delay(500);}assert(booted);
    writeFileSync(ready,JSON.stringify({origin,owner,staff,databaseUrl:process.env.INVENTORY_TEST_ADMIN_URL,encryptionKey:key,finished}),{mode:0o600});console.log(`BROWSER_READY ${ready}`);
    for(let i=0;i<2400&&!existsSync(finished);i++)await delay(500);assert(existsSync(finished));const record=JSON.parse(readFileSync(finished,"utf8"));assert.equal(record.status,"PASSED");
  } finally {
    if(child.pid)spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});if(existsSync(ready))unlinkSync(ready);writeFileSync("next-env.d.ts",generated);writeFileSync("tsconfig.json",config);
    const output=resolve(`.local/inventory-a1-build-${run}`);assert(output.startsWith(resolve(".local")+sep));if(existsSync(output)){assert(!lstatSync(output).isSymbolicLink());rmSync(output,{recursive:true,force:true,maxRetries:3,retryDelay:300});}
  }
}

verify().then(result=>writeFileSync(process.env.INVENTORY_TEST_RESULTS!,JSON.stringify(result,null,2))).catch(e=>{writeFileSync(process.env.INVENTORY_TEST_RESULTS!,JSON.stringify({status:"FAILED",failedAt:current,name:e?.name,code:e?.code,assertion:e instanceof assert.AssertionError?e.message:undefined,cases:results},null,2));console.error("FAIL: "+current+" "+e?.name);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();await admin.end();await new Promise<void>(r=>sink.close(()=>r()));});
