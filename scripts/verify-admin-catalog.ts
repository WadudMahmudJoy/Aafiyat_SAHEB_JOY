import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auth } from '../src/lib/auth';
import { prisma } from '../src/lib/prisma';
import { getAdminProducts, getAdminProduct } from '../src/lib/admin-catalog';
import { getPublicProducts, getPublicProductBySlug } from '../src/lib/catalog';
import { formatCataloguePrice, catalogueHref } from '../src/lib/admin-catalog-format';
import { AdminAuthorizationError } from '../src/lib/admin-authorization';
import { prepareRehearsal, sameSnapshot } from '../src/lib/local-owner-rehearsal';

let passed=0;let stage='local preflight';
async function test(name:string,run:()=>unknown|Promise<unknown>){stage=name;await run();passed++;console.log(`PASS: ${name}`);}
async function verify(){
 const baseline=await prepareRehearsal();
 assert(baseline.baseline.filter(r=>['products','product_variants','inventory_balances'].includes(r.name)).every(r=>r.rows===0));
 const categories=await prisma.category.findMany({orderBy:{id:'asc'}});
 const prefix=randomUUID().slice(0,8);const id=(n:number)=>`${prefix}-009a-4000-8000-${String(n).padStart(12,'0')}`;
 const marker=`test-009a-${prefix}`;const now=new Date();const session={session:{id:'009a-memory-session',userId:'009a-memory-user',token:randomUUID(),createdAt:now,expiresAt:new Date(Date.now()+600000)},user:{id:'009a-memory-user'}};
 let role='OWNER';let active=true;let proof=true;let revoked=false;let expired=false;let signedIn=true;let reads=0;
 const originals={auth:auth.api.getSession,admin:prisma.adminUser.findUnique,session:prisma.session.findUnique,user:prisma.user.findUniqueOrThrow,products:prisma.product.findMany,product:prisma.product.findUnique,publicDetail:prisma.product.findFirst,variants:prisma.productVariant.findMany,categories:prisma.category.findMany};
 const request=new Headers();const rollback=new Error('Intentional catalogue fixture rollback');
 try{
  Reflect.set(auth.api,'getSession',async()=>signedIn?session:null);
  Reflect.set(prisma.adminUser,'findUnique',async()=>({id:'009a-memory-membership',userId:session.user.id,active,disabledAt:null,role:{name:role}}));
  Reflect.set(prisma.session,'findUnique',async()=>revoked?null:({...session.session,expiresAt:expired?new Date(0):session.session.expiresAt,mfaVerifiedAt:proof?now:null,user:{twoFactorEnabled:true,twofactors:[{verified:true}]}}));
  Reflect.set(prisma.user,'findUniqueOrThrow',async()=>({name:'TEST catalogue operator',email:'catalogue@example.invalid'}));
  await test('real empty product database and five category filters',async()=>{const page=await getAdminProducts(request);assert.equal(page.items.length,0);assert.equal(page.categories.length,5);assert.equal(page.nextCursor,null);assert.equal(page.error,null);});
  await prisma.$transaction(async tx=>{
   stage="transaction-only product fixtures";
   await tx.product.createMany({data:['active','draft','discontinued','archived'].map((lifecycle,i)=>({id:id(i+1),categoryId:categories[i<2?0:1].id,name:`TEST ${marker} ${i}`,slug:`${marker}-${i}`,description:'Transaction-only TEST product',lifecycle,archivedAt:lifecycle==='archived'?now:null,createdAt:now}))});
   stage="transaction-only variant fixtures";
   await tx.productVariant.createMany({data:Array.from({length:25},(_,i)=>({id:id(100+i),productId:id(1),sku:`TEST-009A-${prefix.toUpperCase()}-${i}`,sizeCode:`test-${i}`,sizeLabel:`Test size ${i}`,colorCode:'forest',colorLabel:'Forest',priceMinor:i===1?BigInt('9223372036854775807'):BigInt(119900),currency:'BDT',active:i!==1&&i!==2,archivedAt:i===2?now:null}))});
   await tx.inventoryBalance.createMany({data:[{variantId:id(100),onHand:10,reserved:4,lowStockThreshold:null},{variantId:id(102),onHand:5,reserved:5,lowStockThreshold:2}]});
   Reflect.set(prisma.product,'findMany',async(args:Parameters<typeof tx.product.findMany>[0])=>{reads++;return tx.product.findMany(args);});
   Reflect.set(prisma.product,'findUnique',async(args:Parameters<typeof tx.product.findUnique>[0])=>{reads++;return tx.product.findUnique(args);});
   Reflect.set(prisma.product,'findFirst',async(args:Parameters<typeof tx.product.findFirst>[0])=>tx.product.findFirst(args));
   Reflect.set(prisma.productVariant,'findMany',async(args:Parameters<typeof tx.productVariant.findMany>[0])=>tx.productVariant.findMany(args));
   Reflect.set(prisma.category,'findMany',async(args:Parameters<typeof tx.category.findMany>[0])=>tx.category.findMany(args));
   await test('OWNER sees every existing lifecycle and bounded variant example',async()=>{const page=await getAdminProducts(request);assert.deepEqual(page.items.map(p=>p.lifecycle),['active','draft','discontinued','archived']);assert.equal(page.items[0].variantCount,25);assert.equal(page.items[0].exampleVariant!.inventory!.available,6);assert.equal(page.items[0].exampleVariant!.inventory!.lowStockThreshold,null);assert.equal(page.items[1].exampleVariant,null);});
   await test('case-insensitive name and slug search',async()=>{assert.equal((await getAdminProducts(request,{search:`TEST ${marker.toUpperCase()} 1`})).items[0].lifecycle,'draft');assert.equal((await getAdminProducts(request,{search:`${marker.toUpperCase()}-2`})).items[0].lifecycle,'discontinued');});
   await test('category filtering and combined search',async()=>{assert.equal((await getAdminProducts(request,{category:categories[1].id})).items.length,2);assert.equal((await getAdminProducts(request,{category:categories[1].id,search:`${marker}-0`})).items.length,0);});
   await test('stable nonduplicated cursor pages with equal creation timestamps',async()=>{const a=await getAdminProducts(request,{limit:2});const b=await getAdminProducts(request,{limit:2,cursor:a.nextCursor});assert.equal(a.items.length,2);assert.equal(b.items.length,2);assert.equal(b.nextCursor,null);assert.equal(new Set([...a.items,...b.items].map(p=>p.id)).size,4);assert.equal((await getAdminProducts(request,{cursor:id(999)})).items.length,0);});
   await test('invalid limits, duplicate parameters, cursors and oversized search are rejected without product reads',async()=>{const previous=reads;for(const input of [{limit:0},{limit:51},{limit:1.5},{search:'x'.repeat(101)},{search:['bad','duplicate']},{category:'invalid'},{cursor:'invalid'}])assert((await getAdminProducts(request,input)).error);assert.equal(reads,previous);});
   await test('product detail paginates all variants including inactive and archived',async()=>{const detail=await getAdminProduct(request,id(1));assert.equal(detail.product!.variantCount,25);assert.equal(detail.variants.length,20);assert.equal(detail.variants[1].active,false);assert(detail.variants[2].archivedAt);const next=await getAdminProduct(request,id(1),detail.nextCursor);assert.equal(next.variants.length,5);assert.equal(next.nextCursor,null);assert.equal(new Set([...detail.variants,...next.variants].map(v=>v.id)).size,25);});
   await test('BIGINT prices serialize and format without Number precision loss',async()=>{const detail=await getAdminProduct(request,id(1));assert.equal(detail.variants[1].priceMinor,'9223372036854775807');assert.doesNotThrow(()=>JSON.stringify(detail));assert(formatCataloguePrice(detail.variants[1].priceMinor,'BDT').endsWith('.07'));assert.equal(formatCataloguePrice('1','BDT'),'BDT 0.01');});
   await test('missing and fully reserved balances are explicit, not unlimited',async()=>{const detail=await getAdminProduct(request,id(1));assert.equal(detail.variants[1].inventory,null);assert.equal(detail.variants[2].inventory!.available,0);});
   await test('missing product returns no detail; invalid variant cursor is safe',async()=>{assert.equal((await getAdminProduct(request,id(999))).product,null);assert((await getAdminProduct(request,id(1),'bad')).error);});
   await test('PRODUCT_MANAGER receives inventory; MARKETING_MANAGER receives no exact stock DTO',async()=>{role='PRODUCT_MANAGER';assert((await getAdminProducts(request)).canViewInventory);role='MARKETING_MANAGER';const page=await getAdminProducts(request);const detail=await getAdminProduct(request,id(1));assert(!page.canViewInventory);assert(!('inventory' in page.items[0].exampleVariant!));assert(!('inventory' in detail.variants[0]));assert(!JSON.stringify(detail).includes('reserved'));role='OWNER';});
   const deny=async()=>{const previous=reads;await assert.rejects(getAdminProducts(request),e=>e instanceof AdminAuthorizationError);await assert.rejects(getAdminProduct(request,id(1)),e=>e instanceof AdminAuthorizationError);assert.equal(reads,previous);};
   await test('ORDER_MANAGER direct data access denied',async()=>{role='ORDER_MANAGER';await deny();role='OWNER';});
   await test('unauthenticated data access denied',async()=>{signedIn=false;await deny();signedIn=true;});
   await test('password-only session denied',async()=>{proof=false;await deny();proof=true;});
   await test('inactive administrator denied',async()=>{active=false;await deny();active=true;});
   await test('expired and revoked sessions denied',async()=>{expired=true;await deny();expired=false;revoked=true;await deny();revoked=false;});
   await test('public catalogue remains active-only with safe stock DTOs',async()=>{const products=await getPublicProducts();assert.equal(products.items.length,1);assert.equal(await getPublicProductBySlug(`${marker}-1`),null);assert.equal(await getPublicProductBySlug(`${marker}-3`),null);const detail=await getPublicProductBySlug(`${marker}-0`);assert.equal(detail!.variants.length,23);assert(!JSON.stringify(detail).includes('onHand'));assert(!JSON.stringify(detail).includes('reserved'));});
   await test('pagination links preserve filters and cannot redirect externally',()=>{const link=catalogueHref({search:'https://untrusted.invalid & <script>',category:categories[0].id},id(1));assert(link.startsWith('/admin/products?'));assert.equal(new URL(link,'http://localhost').searchParams.get('cursor'),id(1));});
   await test('database failures return generic catalogue error',async()=>{const original=prisma.product.findMany;try{Reflect.set(prisma.product,'findMany',async()=>{throw new Error('sensitive driver details');});const page=await getAdminProducts(request);assert(page.error);assert(!page.error!.includes('sensitive'));}finally{Reflect.set(prisma.product,'findMany',original);}});
   throw rollback;
  },{timeout:20000});
 }catch(error){if(error!==rollback)throw error;}
 finally{Reflect.set(auth.api,'getSession',originals.auth);Reflect.set(prisma.adminUser,'findUnique',originals.admin);Reflect.set(prisma.session,'findUnique',originals.session);Reflect.set(prisma.user,'findUniqueOrThrow',originals.user);Reflect.set(prisma.product,'findMany',originals.products);Reflect.set(prisma.product,'findUnique',originals.product);Reflect.set(prisma.product,'findFirst',originals.publicDetail);Reflect.set(prisma.productVariant,'findMany',originals.variants);Reflect.set(prisma.category,'findMany',originals.categories);
  const previous=stage;await test('all twelve fingerprints restored after transaction rollback',async()=>assert(sameSnapshot(baseline.baseline,(await prepareRehearsal()).baseline)));stage=previous;
 }
 console.log(`${passed} admin catalogue checks passed; all product fixtures rolled back; no auth identities created.`);
}
verify().catch(()=>{console.error(`Admin catalogue check failed at ${stage}; details withheld.`);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();});
