import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { auth } from '../src/lib/auth';
import { saveDraftVariant, getVariantEditor } from '../src/lib/admin-product-variants';
import { prepareRehearsal, sameSnapshot } from '../src/lib/local-owner-rehearsal';
let stage='local preflight';let passed=0;
async function verify(){
 const baseline=await prepareRehearsal();assert(baseline.baseline.filter(r=>['products','product_variants','inventory_balances'].includes(r.name)).every(r=>r.rows===0));
 const category=await prisma.category.findFirstOrThrow();const marker='test-009c-lock-'+randomUUID();const productId=randomUUID();
 const now=new Date();const identity={session:{id:randomUUID(),userId:randomUUID(),token:randomUUID(),createdAt:now,expiresAt:new Date(Date.now()+600000)},user:{id:''}};identity.user.id=identity.session.userId;
 const originals={auth:auth.api.getSession,admin:prisma.adminUser.findUnique,session:prisma.session.findUnique,user:prisma.user.findUniqueOrThrow};
 const headers=new Headers({origin:String(auth.options.baseURL),'sec-fetch-site':'same-origin'});
 const values={sku:marker.toUpperCase(),sizeCode:'m',sizeLabel:'Medium',colorCode:'green',colorLabel:'Green',price:'1250.01'};
 try {
  Reflect.set(auth.api,'getSession',async()=>identity);Reflect.set(prisma.adminUser,'findUnique',async()=>({id:randomUUID(),userId:identity.user.id,active:true,disabledAt:null,role:{name:'OWNER'}}));Reflect.set(prisma.session,'findUnique',async()=>({...identity.session,mfaVerifiedAt:now,user:{twoFactorEnabled:true,twofactors:[{verified:true}]}}));Reflect.set(prisma.user,'findUniqueOrThrow',async()=>({name:'TEST',email:'lock@example.invalid'}));
  stage='exact isolated fixture creation';await prisma.product.create({data:{id:productId,categoryId:category.id,name:marker,slug:marker,description:'TEST concurrency fixture'}});
  const created=await saveDraftVariant(headers,productId,null,null,values);assert(created.ok);
  stage='concurrent stale saves';const outcomes=await Promise.all([saveDraftVariant(headers,productId,created.variantId,created.version,{...values,price:'1300.01'}),saveDraftVariant(headers,productId,created.variantId,created.version,{...values,price:'1400.01'})]);assert.equal(outcomes.filter(r=>r.ok).length,1);assert.equal(outcomes.filter(r=>!r.ok&&r.code==='CONFLICT').length,1);passed++;console.log('PASS: two concurrent saves yield one success and one stale conflict');
  stage='parent lifecycle transition blocks variant writer';let ready!:()=>void;let release!:()=>void;const locked=new Promise<void>(resolve=>{ready=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const transition=prisma.$transaction(async tx=>{await tx.product.update({where:{id:productId},data:{lifecycle:'active'}});ready();await gate;},{timeout:10000});
  let pending:ReturnType<typeof saveDraftVariant>|undefined;
  try {
   await Promise.race([locked,transition]);const version=(await prisma.$queryRaw<{version:string}[]>`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM product_variants WHERE id=${created.variantId}::uuid`)[0].version;
   pending=saveDraftVariant(headers,productId,created.variantId,version,{...values,price:'1500'});
   let waiting=false;
   for(let i=0;i<30&&!waiting;i++){const rows=await prisma.$queryRaw<{waiting:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM products%FOR UPDATE%') AS waiting`;waiting=rows[0].waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,50));}
   assert(waiting);passed++;console.log('PASS: variant write waits for conflicting parent lifecycle transaction');
  }finally{release();await transition;}
  assert(pending);const denied=await pending;assert(!denied.ok&&denied.code==='NOT_DRAFT');assert(![BigInt(150000)].includes((await prisma.productVariant.findUniqueOrThrow({where:{id:created.variantId}})).priceMinor));passed++;console.log('PASS: committed non-draft parent transition denies pending variant update');
  await assert.rejects(getVariantEditor(headers,productId));assert.equal(await prisma.inventoryBalance.count(),0);passed++;console.log('PASS: non-draft editor denied and concurrent operations never initialize inventory');
 }finally{
  Reflect.set(auth.api,'getSession',originals.auth);Reflect.set(prisma.adminUser,'findUnique',originals.admin);Reflect.set(prisma.session,'findUnique',originals.session);Reflect.set(prisma.user,'findUniqueOrThrow',originals.user);
  // Exact UUID and marker checked again before deleting this committed test fixture.
  const row=await prisma.product.findUnique({where:{id:productId}});if(row){assert.equal(row.slug,marker);assert.equal(row.name,marker);await prisma.$transaction(async tx=>{await tx.productVariant.deleteMany({where:{productId}});await tx.product.delete({where:{id:productId}});});}
  assert(sameSnapshot(baseline.baseline,(await prepareRehearsal()).baseline));passed++;console.log('PASS: exact concurrency fixture removed; all twelve baseline fingerprints restored');
 }
 console.log(passed+' concurrency/recovery checks passed; no authentication identities created.');
}
verify().catch(()=>{console.error('Variant concurrency verification failed at '+stage+'; sensitive details withheld.');process.exitCode=1;}).finally(async()=>prisma.$disconnect());
