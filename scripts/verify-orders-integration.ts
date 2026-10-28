// Controlled only by run-orders-verification.mjs. Synthetic fixture SQL is never
// used against development. Actual shared Prisma transactions are not replaced.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync, existsSync, unlinkSync, rmSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { symmetricEncrypt } from "better-auth/crypto";
import { receiveStock, correctStock } from "../src/lib/admin-inventory";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";
import { acknowledgeOrder, getOrders, getOrderDetail, getCustomers, getCustomerDetail } from "../src/lib/admin-orders";
import { getAdminDashboard, dashboardAreas } from "../src/lib/admin-dashboard";
const {Client}=createRequire(import.meta.url)("pg");
const target=new URL(process.env.DATABASE_URL!);const run=process.env.INVENTORY_TEST_RUN!;const database=process.env.INVENTORY_TEST_DATABASE!;
assert.equal(target.hostname,"127.0.0.1");assert.notEqual(target.port,"55432");assert.equal(target.pathname,`/${database}`);assert.equal(database,`receive_verify_${run.replaceAll("-","")}`);
const admin=new Client({connectionString:process.env.INVENTORY_TEST_ADMIN_URL});const monitor=new Client({connectionString:process.env.INVENTORY_TEST_ADMIN_URL});
const original=auth.api.getSession;const transaction=prisma.$transaction;let signedIn=true;let current="identity";const cases:{name:string;elapsedMs:number}[]=[];
const headers=new Headers({origin:String(auth.options.baseURL),"sec-fetch-site":"same-origin"});
let originalCreated:Date;let authenticatedCreated:Date;
let userId:string,actorId:string,sessionId:string,ownerRole:string,variantId:string,customerId:string;
async function check(name:string,run:()=>Promise<void>){current=name;const start=Date.now();await run();cases.push({name,elapsedMs:Date.now()-start});console.log(`PASS: ${name}`);}
async function expectSQL(sql:string,args:unknown[]=[],code?:string){try{await admin.query("BEGIN");await admin.query(sql,args);await admin.query("COMMIT");assert.fail("Expected database rejection");}catch(e){assert.notEqual((e as {code?:string}).code,undefined);if(code)assert.equal((e as {code:string}).code,code);}finally{await admin.query("ROLLBACK");}}
const form=(id:string)=>{const f=new FormData();f.set("orderId",id);return f;};
async function makeOrder(options:{customer?:string;number?:string;accepted?:boolean;cancelled?:boolean;total?:string;owner?:string;items?:boolean;created?:string;quantity?:number;unit?:string;preAcknowledged?:boolean}={}){
 const id=randomUUID();await admin.query("BEGIN");try{
 await admin.query(`INSERT INTO orders(id,order_number,customer_id,owner_account_id,subtotal_minor,discount_minor,shipping_minor,tax_minor,total_minor,payment_status,fulfillment_status,accepted_at,cancelled_at,contact_name,contact_phone,contact_email,shipping_address,shipping_rule_snapshot,policy_snapshot,created_at,acknowledged_at,acknowledged_by)
 VALUES($1,$2,$3,$4,10000,0,100,0,$5,$6,$7,$8,$9,'TEST order contact','+8801712345678','snapshot@example.invalid','TEST frozen address', '{"version":1,"source":"isolated-fixture"}','{"version":1,"source":"isolated-fixture"}',COALESCE($10::timestamptz,clock_timestamp()),$11,$12)`,
 [id,options.number??`TEST-${id}`,options.customer??customerId,options.owner??null,options.total??"10100",options.accepted?"paid":"unpaid",options.cancelled?"cancelled":"unfulfilled",options.accepted?new Date():null,options.cancelled?new Date():null,options.created??null,options.preAcknowledged?new Date():null,options.preAcknowledged?actorId:null]);
 if(options.items!==false)await admin.query("INSERT INTO order_items(order_id,variant_id,product_name,sku,size_label,color_label,quantity,unit_price_minor,discount_minor,total_minor) VALUES($1,$2,'TEST frozen product','TEST-FROZEN','Large','Gold',$3,$4,0,10000)",[id,variantId,options.quantity??2,options.unit??"5000"]);
 await admin.query("COMMIT");return id;
 }catch(e){await admin.query("ROLLBACK");throw e;}
}
async function seed(){await admin.connect();await monitor.connect();const identity=(await admin.query("SELECT current_database() db,current_setting('server_version_num') version")).rows[0];assert.equal(identity.db,database);assert.equal(identity.version,"180006");
 const migrations=(await admin.query("SELECT migration_name FROM _prisma_migrations ORDER BY migration_name")).rows;assert.equal(migrations.length,6);
 originalCreated=new Date();authenticatedCreated=originalCreated;userId=randomUUID();actorId=randomUUID();sessionId=randomUUID();const token=randomUUID(),now=originalCreated;ownerRole=(await admin.query("SELECT id FROM admin_roles WHERE name='OWNER'")).rows[0].id;
 await admin.query('INSERT INTO auth_users(id,name,email,"twoFactorEnabled","updatedAt") VALUES($1,\'TEST order operator\',$2,true,$3)',[userId,`${userId}@example.invalid`,now]);
 await admin.query("INSERT INTO admin_users(id,user_id,role_id,active) VALUES($1,$2,$3,true)",[actorId,userId,ownerRole]);
 await admin.query('INSERT INTO auth_sessions(id,"userId",token,"createdAt","updatedAt","expiresAt",mfa_verified_at) VALUES($1,$2,$3,$4,$4,$5,$4)',[sessionId,userId,token,now,new Date(Date.now()+3600000)]);
 await admin.query('INSERT INTO auth_two_factors(id,secret,"backupCodes","userId",verified) VALUES($1,\'TEST-NOT-REAL\',\'[]\',$2,true)',[randomUUID(),userId]);
 Reflect.set(auth.api,"getSession",async(args:{query:unknown})=>{assert.deepEqual(args.query,{disableCookieCache:true,disableRefresh:true});return signedIn?{user:{id:userId},session:{id:sessionId,userId,token,createdAt:authenticatedCreated,expiresAt:new Date(now.getTime()+3600000)}}:null;});
 const category=randomUUID(),product=randomUUID();variantId=randomUUID();customerId=randomUUID();
 await admin.query("INSERT INTO categories(id,name,slug) VALUES($1,'TEST orders category',$2)",[category,`test-${run}`]);await admin.query("INSERT INTO products(id,category_id,name,slug,description) VALUES($1,$2,'TEST catalogue product',$3,'TEST only')",[product,category,`test-${run}`]);
 await admin.query("INSERT INTO product_variants(id,product_id,sku,size_code,size_label,color_code,color_label,price_minor) VALUES($1,$2,$3,'large','Large','gold','Gold',5000)",[variantId,product,`TEST-${run.toUpperCase()}`]);
 await admin.query("INSERT INTO customers(id,display_name,phone_e164,email) VALUES($1,'TEST profile','+8801712345678','profile@example.invalid')",[customerId]);
}
async function verify(){await seed();await getAdminDashboard(headers);
 const accepted=await makeOrder({accepted:true}),pending=await makeOrder(),cancelled=await makeOrder({accepted:true,cancelled:true});
 await check("migration constraints reject inconsistent financial totals, missing items and oversized line arithmetic",async()=>{
  await assert.rejects(makeOrder({accepted:true,preAcknowledged:true}),e=>(e as {code:string}).code==="23514");await assert.rejects(makeOrder({total:"10101"}),e=>(e as {code:string}).code==="23514");await assert.rejects(makeOrder({items:false}),e=>(e as {code:string}).code==="23514");await assert.rejects(makeOrder({quantity:2147483647,unit:"9223372036854775807"}),e=>(e as {code:string}).code==="23514");
  await expectSQL("INSERT INTO order_items(order_id,variant_id,product_name,sku,size_label,color_label,quantity,unit_price_minor,discount_minor,total_minor) VALUES($1,$2,'TEST','TEST','L','G',2147483647,9223372036854775807,0,1)",[accepted,variantId]);
 });
 await check("order snapshots, item mutation, late insertion, deletion, truncate and forged evidence are denied",async()=>{
  for(const sql of ["UPDATE orders SET contact_name='changed' WHERE id=$1","UPDATE orders SET payment_status='paid' WHERE id=$1","DELETE FROM orders WHERE id=$1","UPDATE order_items SET product_name='changed' WHERE order_id=$1","DELETE FROM order_items WHERE order_id=$1","INSERT INTO order_events(order_id,kind) VALUES($1,'recorded')"])await expectSQL(sql,[pending],"55000");
  await expectSQL("INSERT INTO order_items(order_id,variant_id,product_name,sku,size_label,color_label,quantity,unit_price_minor,discount_minor,total_minor) VALUES($1,$2,'TEST','TEST','L','G',1,10000,0,10000)",[pending,variantId],"55000");
  for(const [sql,id] of [["DELETE FROM product_variants WHERE id=$1",variantId],["DELETE FROM customers WHERE id=$1",customerId]])await assert.rejects(admin.query(sql,[id]),e=>["23503","23001"].includes((e as {code:string}).code));
  await expectSQL("TRUNCATE order_events",[],"55000");await expectSQL("TRUNCATE order_items",[],"55000");
 });
 await check("unknown, anonymous, insufficient role, missing and stale MFA deny reads and acknowledgements",async()=>{
  signedIn=false;await assert.rejects(getOrders(headers,{}));assert.equal((await acknowledgeOrder(headers,form(accepted))).ok,false);signedIn=true;
  for(const role of ["PRODUCT_MANAGER","MARKETING_MANAGER"]){await admin.query("UPDATE admin_users SET role_id=(SELECT id FROM admin_roles WHERE name=$1) WHERE id=$2",[role,actorId]);await assert.rejects(getCustomers(headers,{}),e=>(e as {reason:string}).reason==="PERMISSION_DENIED");await assert.rejects(getOrderDetail(headers,accepted),e=>(e as {reason:string}).reason==="PERMISSION_DENIED");assert.equal((await acknowledgeOrder(headers,form(accepted))).ok,false);assert(!dashboardAreas(role).some(a=>a.id==="customers"));}
  await admin.query("UPDATE admin_users SET role_id=$1 WHERE id=$2",[ownerRole,actorId]);
  await admin.query("UPDATE auth_sessions SET mfa_verified_at=NULL WHERE id=$1",[sessionId]);await assert.rejects(getOrders(headers,{}),e=>(e as {reason:string}).reason==="MFA_NOT_VERIFIED");assert.equal((await acknowledgeOrder(headers,form(accepted))).ok,false);
  authenticatedCreated=new Date(Date.now()-14*3600000);await admin.query('UPDATE auth_sessions SET "createdAt"=$1,mfa_verified_at=$2 WHERE id=$3',[authenticatedCreated,new Date(Date.now()-13*3600000),sessionId]);await assert.rejects(getCustomers(headers,{}),e=>(e as {reason:string}).reason==="MFA_NOT_VERIFIED");
  // Restore the original session binding/proof without replacing auth policy.
  const session=await originalSessionFixture();authenticatedCreated=session;await admin.query('UPDATE auth_sessions SET "createdAt"=$1,mfa_verified_at=$1 WHERE id=$2',[session,sessionId]);
 });
 await check("origin and duplicate/actor injection deny before mutations",async()=>{
  for(const h of [new Headers(),new Headers({origin:"https://evil.invalid"}),new Headers({origin:String(auth.options.baseURL),"sec-fetch-site":"cross-site"})])assert.equal((await acknowledgeOrder(h,form(accepted))).ok,false);
  for(const key of ["orderId","actorAdminId","paymentStatus"]){const f=form(accepted);f.append(key,accepted);const r=await acknowledgeOrder(headers,f);assert(!r.ok);assert.equal(r.code,"VALIDATION",`Invalid field ${key}: ${r.code}`);}
 });
 await check("pending and cancelled orders cannot be acknowledged and badge counts only eligible accepted orders",async()=>{
  for(const id of [pending,cancelled,randomUUID()]){const r=await acknowledgeOrder(headers,form(id));assert(!r.ok);assert.equal(r.code,"INELIGIBLE");}assert.equal((await getAdminDashboard(headers)).newOrders,"1");
 });
 await check("genuine concurrent acknowledgements serialize across separate backends with one audit effect",async()=>{
  const blocker=new Client({connectionString:process.env.INVENTORY_TEST_ADMIN_URL});await blocker.connect();await blocker.query("BEGIN");await blocker.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[accepted]);
  try{const calls=[acknowledgeOrder(headers,form(accepted)),acknowledgeOrder(headers,form(accepted))];let pids:number[]=[];
   for(let i=0;i<60;i++){const rows=(await monitor.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND usename='receiving_runtime' AND wait_event_type='Lock'",[database])).rows;if(rows.length>=2){pids=rows.map((r:{pid:number})=>r.pid);break;}await delay(20);}assert(new Set(pids).size>=2);
   await blocker.query("COMMIT");const results=await Promise.all(calls);assert(results.every(r=>r.ok));assert.deepEqual(results[0],results[1]);assert.equal((await admin.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='acknowledged'",[accepted])).rows[0].n,1);
   assert.equal((await getAdminDashboard(headers)).newOrders,"0");
  }finally{await blocker.query("ROLLBACK");await blocker.end();}
 });
 await check("idempotent retry preserves original acknowledgement actor/time and payment/fulfillment",async()=>{
  const before=(await admin.query("SELECT * FROM orders WHERE id=$1",[accepted])).rows[0];assert((await acknowledgeOrder(headers,form(accepted))).ok);assert.deepEqual((await admin.query("SELECT * FROM orders WHERE id=$1",[accepted])).rows[0],before);
  await expectSQL("UPDATE orders SET acknowledged_by=NULL,acknowledged_at=NULL WHERE id=$1",[accepted],"55000");
 });
 await check("audit insertion failure rolls back acknowledgement and badge count",async()=>{
  const id=await makeOrder({accepted:true});await admin.query("REVOKE INSERT ON order_events FROM receiving_runtime");try{const r=await acknowledgeOrder(headers,form(id));assert(!r.ok);assert.equal(r.code,"UNAVAILABLE");}finally{await admin.query("GRANT INSERT ON order_events TO receiving_runtime");}
  assert.equal((await admin.query("SELECT acknowledged_at FROM orders WHERE id=$1",[id])).rows[0].acknowledged_at,null);assert.equal((await admin.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1",[id])).rows[0].n,1);
 });
 await check("lock timeout is bounded and acknowledgement remains atomic",async()=>{
  const id=await makeOrder({accepted:true});const blocker=new Client({connectionString:process.env.INVENTORY_TEST_ADMIN_URL});await blocker.connect();await blocker.query("BEGIN");await blocker.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[id]);try{const start=Date.now(),r=await acknowledgeOrder(headers,form(id));assert(!r.ok);assert.equal(r.code,"UNAVAILABLE");assert(Date.now()-start>=1800&&Date.now()-start<5000);}finally{await blocker.query("ROLLBACK");await blocker.end();}
  assert.equal((await admin.query("SELECT acknowledged_at FROM orders WHERE id=$1",[id])).rows[0].acknowledged_at,null);
 });
 await check("order snapshots survive product/customer edits and exact financial strings remain intact",async()=>{
  const before=await getOrderDetail(headers,accepted);assert(before);await admin.query("UPDATE product_variants SET price_minor=999999 WHERE id=$1",[variantId]);await admin.query("UPDATE customers SET display_name='TEST edited profile',phone_e164='+8801912345678' WHERE id=$1",[customerId]);const after=await getOrderDetail(headers,accepted);assert.deepEqual(after?.items,before.items);assert.deepEqual(after?.order,before.order);assert.equal(after?.order.total,"10100");
 });
 await check("order number/contact search, payment/fulfillment/date filters and keyset pages are bounded",async()=>{
  for(let i=0;i<27;i++)await makeOrder({number:`PAGED-${run}-${i}`,created:"2026-10-27T12:00:00.123456Z"});
  const a=await getOrders(headers,{search:`PAGED-${run}`,from:"2026-10-27",to:"2026-10-27",payment:"unpaid",fulfillment:"unfulfilled"});assert.equal(a.items.length,25);assert(a.nextCursor);const b=await getOrders(headers,{search:`PAGED-${run}`,cursor:a.nextCursor});assert.equal(b.items.length,2);assert(!b.items.some(o=>a.items.some(x=>x.id===o.id)));assert.equal((await getOrders(headers,{search:`PAGED-${run}`,from:"2026-10-28"})).items.length,0);
  assert((await getOrders(headers,{search:"+8801712345678"})).items.length>0);await assert.rejects(getOrders(headers,{payment:"forged"}));
 });
 await check("customer matching never merges profiles or grants account ownership; cross-customer cursors reveal no history",async()=>{
  const other=randomUUID(),account=randomUUID();await admin.query("INSERT INTO customers(id,display_name,phone_e164,email) VALUES($1,'TEST same contact','+8801912345678','profile@example.invalid')",[other]);await admin.query("INSERT INTO customer_accounts(id,customer_id,identity_issuer,identity_subject) VALUES($1,$2,'test-only',$3)",[account,other,randomUUID()]);
  const same=await getCustomers(headers,{search:"profile@example.invalid"});assert.equal(same.items.length,2);assert(same.items.some(c=>c.association.startsWith("Unverified")));assert(same.items.some(c=>c.association.startsWith("Guest")));
  const foreign=await makeOrder({customer:other,owner:account});assert.equal((await getCustomerDetail(headers,customerId,foreign))?.orders.length,0);assert.equal((await getCustomerDetail(headers,other))?.orders.length,1);
  await assert.rejects(makeOrder({customer:customerId,owner:account}),e=>(e as {code:string}).code==="23503");
  await admin.query("UPDATE customer_accounts SET verified_at=clock_timestamp() WHERE id=$1",[account]);assert((await getCustomerDetail(headers,other))?.customer.association.startsWith("Verified"));assert((await getOrderDetail(headers,accepted))?.order.association.startsWith("Guest"));
 });
 await check("customer listing is paginated and role separation follows existing orders permissions",async()=>{
  for(let i=0;i<27;i++)await admin.query("INSERT INTO customers(display_name,phone_e164) VALUES($1,'+8801712345678')",[`PAGED-CUSTOMER-${run}-${i}`]);const a=await getCustomers(headers,{search:`PAGED-CUSTOMER-${run}`});assert.equal(a.items.length,25);const b=await getCustomers(headers,{search:`PAGED-CUSTOMER-${run}`,cursor:a.nextCursor});assert.equal(b.items.length,2);
  await admin.query("UPDATE admin_users SET role_id=(SELECT id FROM admin_roles WHERE name='ORDER_MANAGER') WHERE id=$1",[actorId]);assert((await getOrders(headers,{})).items.length>0);assert((await getCustomers(headers,{})).items.length>0);await admin.query("UPDATE admin_users SET role_id=$1 WHERE id=$2",[ownerRole,actorId]);
 });
 await check("new order foreign keys preserve actual receiving/correction transactions and ledger behavior",async()=>{
  const productId=(await admin.query("SELECT product_id FROM product_variants WHERE id=$1",[variantId])).rows[0].product_id;
  const received=await receiveStock(headers,{productId,variantId,quantity:"5",reason:"TEST isolated regression",idempotencyKey:randomUUID()});assert(received.ok);
  const revision=(await admin.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') revision FROM inventory_balances WHERE variant_id=$1`,[variantId])).rows[0].revision;
  const corrected=await correctStock(headers,{productId,variantId,targetOnHand:"3",expectedRevision:revision,reason:"TEST isolated correction regression",idempotencyKey:randomUUID()});assert(corrected.ok);assert.equal(corrected.receipt.deltaOnHand,-2);assert.equal((await admin.query("SELECT on_hand FROM inventory_balances WHERE variant_id=$1",[variantId])).rows[0].on_hand,3);
 });
 await check("actual acknowledgement Server Action retains duplicates and guards mutation authority",async()=>{
  let request=headers;const invalidated:string[]=[];const compiled={exports:{} as {acknowledgeAction:(state:unknown,data:FormData)=>Promise<{saved?:boolean}>}};
  runInNewContext(ts.transpile(readFileSync("src/app/admin/orders/actions.ts","utf8"),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),{module:compiled,exports:compiled.exports,FormData,require:(name:string)=>name==="next/headers"?{headers:async()=>request}:name==="next/cache"?{revalidatePath:(path:string)=>invalidated.push(path)}:name==="@/lib/admin-orders"?{acknowledgeOrder}:createRequire(import.meta.url)(name)});
  const id=await makeOrder({accepted:true});const valid=form(id);valid.set("$ACTION_ID_test","transport");assert.equal((await compiled.exports.acknowledgeAction({},valid)).saved,true);assert(invalidated.includes("/admin"));const bad=form(id);bad.append("orderId",id);assert.equal((await compiled.exports.acknowledgeAction({},bad)).saved,undefined);request=new Headers();assert.equal((await compiled.exports.acknowledgeAction({},form(id))).saved,undefined);
 });
 if(process.env.ORDERS_VERIFY_BROWSER==="1")await check("actual password/TOTP browser and committed acknowledgement",browserFixture);
 assert.equal(prisma.$transaction,transaction);return {status:"PASSED",cases,authentication:"Session lookup simulated only for service probes; DB session/membership/MFA remain real",transactions:"Original Prisma interactive transactions; concurrent lock waiters observed on separate PostgreSQL backends"};
}
async function originalSessionFixture(){return originalCreated;}
async function browserFixture(){
 const email=`${randomUUID()}@example.invalid`,password=`TEST-${randomUUID()}-Aa!`,secret=randomUUID().replaceAll("-",""),id=randomUUID();const context=await auth.$context;
 await admin.query('INSERT INTO auth_users(id,name,email,"twoFactorEnabled","updatedAt") VALUES($1,\'TEST browser order operator\',$2,true,clock_timestamp())',[id,email]);await admin.query('INSERT INTO auth_accounts(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,\'credential\',$2,$3,clock_timestamp())',[randomUUID(),id,await context.password.hash(password)]);
 await admin.query("INSERT INTO admin_users(user_id,role_id,active) VALUES($1,$2,true)",[id,ownerRole]);await admin.query('INSERT INTO auth_two_factors(id,secret,"backupCodes","userId",verified) VALUES($1,$2,$3,$4,true)',[randomUUID(),await symmetricEncrypt({key:context.secretConfig,data:secret}),await symmetricEncrypt({key:context.secretConfig,data:"[]"}),id]);await admin.query("GRANT INSERT,UPDATE,DELETE ON auth_sessions,auth_verifications,auth_two_factors,auth_users,auth_accounts TO receiving_runtime");
 const orderId=await makeOrder({accepted:true,number:`BROWSER-${run}`});const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();assert(address&&typeof address==="object");const port=address.port;await new Promise<void>(r=>server.close(()=>r()));const origin=`http://127.0.0.1:${port}`;
 const generated=readFileSync("next-env.d.ts"),config=readFileSync("tsconfig.json");const child=spawn(process.execPath,[resolve("scripts/inventory-test-server.mjs"),String(port)],{env:{...process.env,AAFIYAT_INVENTORY_TEST_RUN:run,BETTER_AUTH_URL:origin,NODE_ENV:"development",NEXT_TELEMETRY_DISABLED:"1"},windowsHide:true,stdio:"ignore"});const ready=process.env.INVENTORY_TEST_RESULTS+".browser-ready.json",finished=process.env.INVENTORY_TEST_RESULTS+".browser-finished.json";
 try{let booted=false;for(let i=0;i<35;i++){try{const r=await fetch(origin+"/admin/login",{signal:AbortSignal.timeout(5000)});if(r.ok){booted=true;break;}}catch{}await delay(500);}assert(booted);writeFileSync(ready,JSON.stringify({origin,email,password,secret,userId:id,orderId,customerId,finished}),{mode:0o600});console.log(`BROWSER_READY ${ready}`);for(let i=0;i<1800&&!existsSync(finished);i++)await delay(500);assert(existsSync(finished));const evidence=JSON.parse(readFileSync(finished,"utf8"));assert.equal(evidence.status,"PASSED");assert((await admin.query('SELECT 1 FROM auth_sessions WHERE "userId"=$1 AND mfa_verified_at IS NOT NULL',[id])).rowCount>0);assert.equal((await admin.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='acknowledged'",[orderId])).rows[0].n,1);return;
 }finally{if(child.pid)spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});if(existsSync(ready))unlinkSync(ready);writeFileSync("next-env.d.ts",generated);writeFileSync("tsconfig.json",config);const output=resolve(`.local/inventory-a1-build-${run}`),local=resolve(".local");assert(output.startsWith(local+sep));if(existsSync(output)){assert(!lstatSync(output).isSymbolicLink());rmSync(output,{recursive:true,force:true,maxRetries:3,retryDelay:300});}}
}
verify().then(report=>writeFileSync(process.env.INVENTORY_TEST_RESULTS!,JSON.stringify(report,null,2))).catch(e=>{writeFileSync(process.env.INVENTORY_TEST_RESULTS!,JSON.stringify({status:"FAILED",failedAt:current,category:e?.name,code:e?.code,cases},null,2));console.error(`FAIL: ${current}; ${e?.name} ${e?.code??""}; safe comparison ${(/^[A-Z_]{1,30}$/.test(String(e?.actual))?e.actual:"withheld")} expected ${(/^[A-Z_]{1,30}$/.test(String(e?.expected))?e.expected:"withheld")}`);process.exitCode=1;}).finally(async()=>{Reflect.set(auth.api,"getSession",original);await prisma.$disconnect();await admin.end();await monitor.end();});
