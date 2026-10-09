import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Prisma } from '../src/generated/prisma/client';
import { auth } from '../src/lib/auth';
import { prisma } from '../src/lib/prisma';
import { getPublicProducts, getPublicProductBySlug } from '../src/lib/catalog';
import { prepareRehearsal, sameSnapshot } from '../src/lib/local-owner-rehearsal';
import { saveDraftVariant, getVariantEditor, VariantWriteError } from '../src/lib/admin-product-variants';
import { parseBdtPrice, priceInput, initialVariantState } from '../src/lib/variant-validation';

let passed = 0; let stage = 'local preflight';
async function check(label: string, run: () => unknown | Promise<unknown>) { stage = label; await run(); passed++; console.log(`PASS: ${label}`); }
async function verify() {
  const baseline = await prepareRehearsal();
  assert(baseline.baseline.filter(r => ['products','product_variants','inventory_balances'].includes(r.name)).every(r => r.rows === 0));
  const categories = await prisma.category.findMany({ orderBy: { id: 'asc' } });
  const marker = `test-009b-${randomUUID()}`;
  const input = { name: `TEST ${marker}`, categoryId: categories[0].id, slug: marker, description: 'বাংলা draft\r\nPlain text', seoTitle: '', seoDescription: '' };
  const now = new Date(); const session = { session: { id: '009b-memory-session', userId: '009b-memory-user', token: randomUUID(), createdAt: now, expiresAt: new Date(Date.now()+600000) }, user: { id: '009b-memory-user' } };
  let role = 'OWNER'; let active = true; let proof = true; let signedIn = true; let revoked = false; let expired = false; let writes = 0;
  const request = new Headers({ origin: String(auth.options.baseURL), 'sec-fetch-site': 'same-origin' });
  const originals = { auth: auth.api.getSession, admin: prisma.adminUser.findUnique, session: prisma.session.findUnique, user: prisma.user.findUniqueOrThrow,
    transaction: prisma.$transaction, raw: prisma.$queryRaw, categories: prisma.category.findMany, category: prisma.category.findUnique, products: prisma.product.findMany, product: prisma.product.findFirst };
  const sentinel = new Error('Intentional draft fixture rollback');
  try {
    Reflect.set(auth.api, 'getSession', async () => signedIn ? session : null);
    Reflect.set(prisma.adminUser, 'findUnique', async () => ({ id: '009b-memory-member', userId: session.user.id, active, disabledAt: null, role: { name: role } }));
    Reflect.set(prisma.session, 'findUnique', async () => revoked ? null : ({ ...session.session, expiresAt: expired ? new Date(0) : session.session.expiresAt, mfaVerifiedAt: proof ? now : null, user: { twoFactorEnabled: true, twofactors: [{ verified: true }] } }));
    Reflect.set(prisma.user, 'findUniqueOrThrow', async () => ({ name: 'TEST draft operator', email: 'draft@example.invalid' }));
    await originals.transaction.call(prisma, async tx => {
      let savepoint = 0;
      // The production callbacks execute real PostgreSQL SQL. Savepoints emulate
      // their transaction boundaries inside an outer transaction that never commits.
      Reflect.set(prisma, '$transaction', async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => {
        writes++; const name = `draft_test_${++savepoint}`;
        await tx.$executeRaw(Prisma.raw(`SAVEPOINT ${name}`));
        try { const result = await callback(tx); await tx.$executeRaw(Prisma.raw(`RELEASE SAVEPOINT ${name}`)); return result; }
        catch (error) { await tx.$executeRaw(Prisma.raw(`ROLLBACK TO SAVEPOINT ${name}`)); await tx.$executeRaw(Prisma.raw(`RELEASE SAVEPOINT ${name}`)); throw error; }
      });
      Reflect.set(prisma, '$queryRaw', tx.$queryRaw.bind(tx));
      Reflect.set(prisma.category, 'findMany', tx.category.findMany.bind(tx.category));
      Reflect.set(prisma.category, 'findUnique', tx.category.findUnique.bind(tx.category));
      Reflect.set(prisma.product, 'findMany', tx.product.findMany.bind(tx.product));
      Reflect.set(prisma.product, 'findFirst', tx.product.findFirst.bind(tx.product));

      const product = await tx.product.create({ data: { ...input, seoTitle:null,seoDescription:null } });
      const other = await tx.product.create({ data: { ...input,slug:marker+'-other',seoTitle:null,seoDescription:null } });
      const productId=product.id;
      const values={sku:marker.toUpperCase(),sizeCode:'m',sizeLabel:'Medium',colorCode:'forest',colorLabel:'Forest green',price:'1250.01'};
      let variantId='',version='';
      const save=(data:unknown=values)=>saveDraftVariant(request,productId,variantId,version,data);
      const expect=async(promise:ReturnType<typeof saveDraftVariant>,code:string)=>{const result=await promise;assert(!result.ok && result.code===code);};
      await check('OWNER creates normalized variant with exact BDT poisha and no inventory',async()=>{const r=await saveDraftVariant(request,productId,null,null,{...values,sku:' '+values.sku.toLowerCase()+' ',sizeCode:' M '});assert(r.ok);variantId=r.variantId;version=r.version;const row=await tx.productVariant.findUniqueOrThrow({where:{id:variantId}});assert.equal(row.priceMinor,BigInt(125001));assert.equal(row.sku,values.sku);assert.equal(row.currency,'BDT');assert.equal(row.active,true);assert.equal(row.archivedAt,null);assert.equal(await tx.inventoryBalance.count(),0);});
      await check('editor returns exact price text and microsecond revision without inventory',async()=>{const e=await getVariantEditor(request,productId,variantId);assert.equal(e.variant!.values.price,'1250.01');assert.equal(e.variant!.version,version);assert(!JSON.stringify(e).includes('onHand'));assert.equal((await getVariantEditor(request,productId)).variant,null);});
      await check('PRODUCT_MANAGER edits same variant ID and preserves active/archive/product binding',async()=>{role='PRODUCT_MANAGER';const r=await save({...values,price:'999.99',sizeLabel:'TEST medium'});assert(r.ok);assert.equal(r.variantId,variantId);assert.notEqual(r.version,version);version=r.version;const row=await tx.productVariant.findUniqueOrThrow({where:{id:variantId}});assert.equal(row.productId,productId);assert.equal(row.priceMinor,BigInt(99999));assert.equal(row.active,true);assert.equal(row.archivedAt,null);role='OWNER';});
      await check('BIGINT money zero, one-poisha and maximum exact round trips',async()=>{for(const minor of ['0','1','9007199254740993','9223372036854775807']){const price=priceInput(minor);assert.equal(parseBdtPrice(price),BigInt(minor));const r=await save({...values,price});assert(r.ok);version=r.version;const e=await getVariantEditor(request,productId,variantId);assert.equal(e.variant!.values.price,price);assert.equal((await tx.productVariant.findUniqueOrThrow({where:{id:variantId}})).priceMinor,BigInt(minor));}assert.equal(parseBdtPrice('12.5'),BigInt(1250));});
      await check('negative, overflow, exponents, commas, malformed and floating input rejected',async()=>{for(const price of ['-1','+1','1e3','1,000','.50','1.','1.001','NaN','Infinity','92233720368547758.08','9999999999999999999999',12.5]){assert.equal(parseBdtPrice(price),null);await expect(save({...values,price}),'VALIDATION');}});
      await check('required SKU, size/color labels/codes, bounds and controls validated',async()=>{for(const key of ['sku','sizeCode','sizeLabel','colorCode','colorLabel']){await expect(save({...values,[key]:''}),'VALIDATION');await expect(save({...values,[key]:'\u0000'}),'VALIDATION');}await expect(save({...values,sizeCode:'x'.repeat(101)}),'VALIDATION');});
      await check('privileged, monetary-unit, currency, lifecycle and stock mass assignment rejected',async()=>{for(const key of ['productId','id','active','archivedAt','currency','priceMinor','onHand','reserved','role','mfaVerifiedAt'])await expect(save({...values,[key]:'forged'}),'VALIDATION');});
      await check('global normalized duplicate SKU creation rejected across products',async()=>{await expect(saveDraftVariant(request,other.id,null,null,{...values,sku:' '+values.sku.toLowerCase()+' '}),'DUPLICATE_SKU');assert.equal(await tx.productVariant.count(),1);});
      await check('duplicate product size/color combination rejected',async()=>{await expect(saveDraftVariant(request,productId,null,null,{...values,sku:values.sku+'-SECOND'}),'DUPLICATE_COMBINATION');});
      const second=await saveDraftVariant(request,productId,null,null,{...values,sku:values.sku+'-SECOND',sizeCode:'l'});assert(second.ok);
      await check('duplicate SKU and combination edit roll back revision and metadata',async()=>{await expect(save({...values,sku:values.sku+'-SECOND'}),'DUPLICATE_SKU');await expect(save({...values,sizeCode:'l'}),'DUPLICATE_COMBINATION');assert.equal((await getVariantEditor(request,productId,variantId)).variant!.version,version);});
      await check('stale edit cannot overwrite newer metadata or exact revision',async()=>{const stale=version;const r=await save();assert(r.ok);version=r.version;await expect(saveDraftVariant(request,productId,variantId,stale,{...values,price:'1'}),'CONFLICT');assert.equal((await getVariantEditor(request,productId,variantId)).variant!.version,version);});
      await check('exact microsecond revisions cannot be truncated',async()=>{await tx.$executeRaw`UPDATE product_variants SET updated_at='2026-10-09T00:00:00.123456Z'::timestamptz WHERE id=${variantId}::uuid`;version=(await getVariantEditor(request,productId,variantId)).variant!.version;assert.equal(version,'2026-10-09T00:00:00.123456Z');await expect(saveDraftVariant(request,productId,variantId,'2026-10-09T00:00:00.123000Z',values),'CONFLICT');const r=await save();assert(r.ok);version=r.version;});
      await check('cross-product IDs and unknown variants rejected by writer and editor',async()=>{await expect(saveDraftVariant(request,other.id,variantId,version,values),'NOT_FOUND');await assert.rejects(getVariantEditor(request,other.id,variantId),e=>e instanceof VariantWriteError&&e.code==='NOT_FOUND');await expect(saveDraftVariant(request,productId,randomUUID(),version,values),'NOT_FOUND');});
      await check('non-DRAFT parent creation, editing and editor access denied',async()=>{for(const lifecycle of ['active','discontinued','archived']){await tx.product.update({where:{id:productId},data:{lifecycle,archivedAt:lifecycle==='archived'?new Date():null}});await expect(save(),'NOT_DRAFT');await expect(saveDraftVariant(request,productId,null,null,{...values,sku:values.sku+'-NO',sizeCode:'xl'}),'NOT_DRAFT');await assert.rejects(getVariantEditor(request,productId,variantId));}await tx.product.update({where:{id:productId},data:{lifecycle:'draft',archivedAt:null}});});
      await check('inactive status preserved; archived variants are not changed',async()=>{await tx.productVariant.update({where:{id:variantId},data:{active:false}});version=(await getVariantEditor(request,productId,variantId)).variant!.version;const r=await save();assert(r.ok);version=r.version;assert.equal((await tx.productVariant.findUniqueOrThrow({where:{id:variantId}})).active,false);await tx.productVariant.update({where:{id:variantId},data:{archivedAt:new Date()}});await expect(save(),'UNSUPPORTED');await assert.rejects(getVariantEditor(request,productId,variantId));await tx.productVariant.update({where:{id:variantId},data:{archivedAt:null}});version=(await getVariantEditor(request,productId,variantId)).variant!.version;});
      const deny=async()=>{const before=writes;await assert.rejects(save());await assert.rejects(saveDraftVariant(request,productId,null,null,values));await assert.rejects(getVariantEditor(request,productId));assert.equal(writes,before);};
      await check('read-only MARKETING and ORDER roles cannot write or open editors',async()=>{for(const name of ['MARKETING_MANAGER','ORDER_MANAGER']){role=name;await deny();}role='OWNER';});
      await check('unauthenticated, password-only, inactive, expired and revoked writes denied',async()=>{signedIn=false;await deny();signedIn=true;proof=false;await deny();proof=true;active=false;await deny();active=true;expired=true;await deny();expired=false;revoked=true;await deny();revoked=false;});
      await check('same-origin protections reject missing, null, foreign and cross-site origin',async()=>{for(const h of [new Headers(),new Headers({origin:'null'}),new Headers({origin:'https://foreign.invalid'}),new Headers({origin:String(auth.options.baseURL),'sec-fetch-site':'cross-site'})])await assert.rejects(saveDraftVariant(h,productId,variantId,version,values));});
      await check('invalid revision and product identifiers rejected safely',async()=>{await expect(saveDraftVariant(request,productId,variantId,'bad',values),'VALIDATION');await expect(saveDraftVariant(request,'bad',null,null,values),'NOT_FOUND');});
      await check('existing inventory balance remains byte-for-byte unchanged across variant saves',async()=>{await tx.inventoryBalance.create({data:{variantId,onHand:5,reserved:2,lowStockThreshold:1}});const before=await tx.inventoryBalance.findMany();const r=await save({...values,price:'500.55'});assert(r.ok);version=r.version;assert.deepEqual(await tx.inventoryBalance.findMany(),before);assert.equal(await tx.inventoryBalance.count(),1);});
      await check('drafts and all their variants remain absent from public catalogue',async()=>{assert.equal((await getPublicProducts()).items.length,0);assert.equal(await getPublicProductBySlug(marker),null);});
      const compiled={exports:{} as {saveVariantAction:(...args:unknown[])=>Promise<import('../src/lib/variant-validation').VariantFormState>}};const require=createRequire(import.meta.url);const invalidated=new Set<string>();
      runInNewContext(ts.transpile(readFileSync('src/app/admin/products/variant-actions.ts','utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),{module:compiled,exports:compiled.exports,require:(name:string)=>name==='next/headers'?{headers:async()=>request}:name==='next/cache'?{revalidatePath:(path:string)=>invalidated.add(path)}:name==='@/lib/admin-product-variants'?{saveDraftVariant}:name==='@/lib/variant-validation'?require('../src/lib/variant-validation'):require(name)});
      const form=()=>{const data=new FormData();for(const[k,v]of Object.entries(values))data.set(k,v);data.set('version',version);return data;};
      await check('direct actions reject read-only membership, repeated and privileged fields',async()=>{role='MARKETING_MANAGER';assert.equal((await compiled.exports.saveVariantAction(productId,variantId,initialVariantState,form())).status,'error');role='OWNER';for(const key of ['active','onHand','duplicate']){const data=form();if(key==='duplicate')data.append('sku',values.sku);else data.set(key,'forged');assert.equal((await compiled.exports.saveVariantAction(productId,variantId,initialVariantState,data)).status,'error');}});
      await check('save action returns precise success revision and fixed product revalidation',async()=>{const result=await compiled.exports.saveVariantAction(productId,variantId,initialVariantState,form());assert.equal(result.status,'saved');assert.equal(result.variantId,variantId);assert.notEqual(result.version,version);assert(invalidated.has('/admin/products/'+productId));});
      await check('validation retry preserves latest saved revision instead of reverting to initial version',async()=>{version=(await getVariantEditor(request,productId,variantId)).variant!.version;const invalid=form();invalid.set('price','bad');const failed=await compiled.exports.saveVariantAction(productId,variantId,initialVariantState,invalid);assert.equal(failed.status,'error');assert.equal(failed.version,version);const retry=form();retry.set('version',failed.version!);assert.equal((await compiled.exports.saveVariantAction(productId,variantId,initialVariantState,retry)).status,'saved');});
      throw sentinel;
    },{timeout:30000});
  } catch(error){if(error!==sentinel)throw error;}
  finally {
    Reflect.set(auth.api,'getSession',originals.auth);Reflect.set(prisma.adminUser,'findUnique',originals.admin);Reflect.set(prisma.session,'findUnique',originals.session);Reflect.set(prisma.user,'findUniqueOrThrow',originals.user);Reflect.set(prisma,'$transaction',originals.transaction);Reflect.set(prisma,'$queryRaw',originals.raw);Reflect.set(prisma.category,'findMany',originals.categories);Reflect.set(prisma.category,'findUnique',originals.category);Reflect.set(prisma.product,'findMany',originals.products);Reflect.set(prisma.product,'findFirst',originals.product);
    const previous=stage;await check('all twelve fingerprints restored; no auth/product/variant/stock fixtures remain',async()=>assert(sameSnapshot(baseline.baseline,(await prepareRehearsal()).baseline)));stage=previous;
  }
  console.log(`${passed} variant write/security checks passed; outer transaction rolled back; no auth accounts created.`);
}
verify().catch(()=>{console.error(`Variant verification failed at ${stage}; sensitive details withheld.`);process.exitCode=1;}).finally(async()=>prisma.$disconnect());
