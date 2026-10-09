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
import { createDraftProduct, updateDraftProduct, getDraftEditor, DraftWriteError } from '../src/lib/admin-product-drafts';
import { getPublicProducts, getPublicProductBySlug } from '../src/lib/catalog';
import { prepareRehearsal, sameSnapshot } from '../src/lib/local-owner-rehearsal';
import { initialDraftState } from '../src/lib/product-draft-validation';

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
      let id = ''; let version = '';
      await check('authorized OWNER creation forces draft, no archive/variants/inventory', async () => {
        const result = await createDraftProduct(request, { ...input, name: `  ${input.name}  `, slug: input.slug.toUpperCase() }); assert(result.ok); id = result.productId; version = result.version;
        const row = await tx.product.findUniqueOrThrow({ where: { id } }); assert.equal(row.lifecycle,'draft'); assert.equal(row.archivedAt,null); assert.equal(row.slug,input.slug); assert.equal(row.name,input.name); assert.equal(row.description,'বাংলা draft\nPlain text'); assert.equal(row.seoTitle,null); assert.equal(await tx.productVariant.count(),0); assert.equal(await tx.inventoryBalance.count(),0);
      });
      await check('write-authorized editor returns prefilled fields and exact revision', async () => { const editor = await getDraftEditor(request,id); assert.equal(editor.product!.version,version); assert.equal(editor.product!.name,input.name); assert.equal(editor.categories.length,5); });
      await check('required fields, type/length/control-character validation', async () => {
        const before = writes; for (const invalid of [{name:''},{slug:'bad slug'},{categoryId:'bad'},{name:42},{description:'x'.repeat(10001)},{seoTitle:'\u0000'}]) { const result = await createDraftProduct(request,{...input,...invalid}); assert(!result.ok && result.code==='VALIDATION'); } assert.equal(writes,before);
      });
      await check('lifecycle, archive, inventory and client authorization fields cannot be assigned', async () => { for (const forbidden of ['lifecycle','archivedAt','variants','priceMinor','role']) { const result = await createDraftProduct(request,{...input,[forbidden]:'active'}); assert(!result.ok && result.code==='VALIDATION'); } });
      await check('normalized duplicate creation slug rejected by database uniqueness', async () => { const result = await createDraftProduct(request,{...input,slug:` ${input.slug.toUpperCase()} `}); assert(!result.ok && result.code==='DUPLICATE_SLUG'); assert.equal(await tx.product.count(),1); });
      await check('missing category rejects creation and updates without partial writes', async () => { const invalid = {...input,categoryId:randomUUID()}; for (const result of [await createDraftProduct(request,invalid),await updateDraftProduct(request,id,version,invalid)])assert(!result.ok && result.code==='CATEGORY'); assert.equal((await tx.product.findUniqueOrThrow({where:{id}})).categoryId,input.categoryId); });
      await check('PRODUCT_MANAGER can edit draft metadata and optional SEO', async () => { role='PRODUCT_MANAGER'; const result=await updateDraftProduct(request,id,version,{...input,name:`${input.name} edited`,categoryId:categories[1].id,seoTitle:'  TEST title  ',seoDescription:'TEST description'});assert(result.ok);assert.notEqual(result.version,version);version=result.version;assert.equal((await tx.product.findUniqueOrThrow({where:{id}})).seoTitle,'TEST title');role='OWNER'; });
      await check('stale edit rejected; first save and exact revision preserved', async () => { const stale=version;const first=await updateDraftProduct(request,id,version,input);assert(first.ok);version=first.version;const second=await updateDraftProduct(request,id,stale,{...input,name:'TEST stale overwrite'});assert(!second.ok && second.code==='CONFLICT');assert.equal((await tx.product.findUniqueOrThrow({where:{id}})).name,input.name); });
      await check('microsecond precision retained, unlike JavaScript Date truncation', async () => { await tx.$executeRaw`UPDATE products SET updated_at = '2026-10-08T00:00:00.123456Z'::timestamptz WHERE id=${id}::uuid`;const editor=await getDraftEditor(request,id);assert.equal(editor.product!.version,'2026-10-08T00:00:00.123456Z');const truncated=await updateDraftProduct(request,id,'2026-10-08T00:00:00.123000Z',input);assert(!truncated.ok && truncated.code==='CONFLICT');const exact=await updateDraftProduct(request,id,editor.product!.version,input);assert(exact.ok);version=exact.version; });
      await check('duplicate slug on edit rolls back all metadata and revision', async () => { const another=await createDraftProduct(request,{...input,slug:`${marker}-another`});assert(another.ok);const result=await updateDraftProduct(request,id,version,{...input,slug:`${marker}-another`,name:'TEST duplicate overwrite'});assert(!result.ok && result.code==='DUPLICATE_SLUG');const editor=await getDraftEditor(request,id);assert.equal(editor.product!.version,version);assert.equal(editor.product!.name,input.name); });
      await check('active, discontinued and archived metadata edits/editor access rejected', async () => { for(const lifecycle of ['active','discontinued','archived']){await tx.product.update({where:{id},data:{lifecycle,archivedAt:lifecycle==='archived'?new Date():null}});const result=await updateDraftProduct(request,id,version,input);assert(!result.ok && result.code==='NOT_DRAFT');await assert.rejects(getDraftEditor(request,id),e=>e instanceof DraftWriteError && e.code==='NOT_DRAFT');}await tx.product.update({where:{id},data:{lifecycle:'draft',archivedAt:null}});version=(await getDraftEditor(request,id)).product!.version; });
      await check('missing product and invalid revision rejected', async()=>{const missing=await updateDraftProduct(request,randomUUID(),version,input);assert(!missing.ok && missing.code==='NOT_FOUND');for(const value of ['bad','2026-02-31T00:00:00.123456Z']){const result=await updateDraftProduct(request,id,value,input);assert(!result.ok && result.code==='VALIDATION');}});
      const denied=async()=>{const before=writes;await assert.rejects(createDraftProduct(request,input));await assert.rejects(updateDraftProduct(request,id,version,input));await assert.rejects(getDraftEditor(request,id));assert.equal(writes,before);};
      await check('MARKETING_MANAGER and ORDER_MANAGER cannot mutate or open editors',async()=>{for(const value of ['MARKETING_MANAGER','ORDER_MANAGER']){role=value;await denied();}role='OWNER';});
      await check('unauthenticated and password-only writes denied',async()=>{signedIn=false;await denied();signedIn=true;proof=false;await denied();proof=true;});
      await check('inactive, expired and revoked writes denied before transactions',async()=>{active=false;await denied();active=true;expired=true;await denied();expired=false;revoked=true;await denied();revoked=false;});
      await check('missing, foreign, null origins and cross-site contexts denied',async()=>{const before=writes;for(const headers of [new Headers(),new Headers({origin:'https://foreign.invalid'}),new Headers({origin:'null'}),new Headers({origin:String(auth.options.baseURL),'sec-fetch-site':'cross-site'})]){await assert.rejects(createDraftProduct(headers,input));await assert.rejects(updateDraftProduct(headers,id,version,input));}assert.equal(writes,before);});
      await check('all drafts remain invisible in public catalogue listing/details',async()=>{assert.equal((await getPublicProducts()).items.length,0);assert.equal(await getPublicProductBySlug(marker),null);});
      const compiled={exports:{} as Record<string,(...args:unknown[])=>Promise<import('../src/lib/product-draft-validation').DraftFormState>>};const require=createRequire(import.meta.url); const invalidated=new Set<string>();
      runInNewContext(ts.transpile(readFileSync('src/app/admin/products/draft-actions.ts','utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),{module:compiled,exports:compiled.exports,require:(name:string)=>name==='next/headers'?{headers:async()=>request}:name==='next/cache'?{revalidatePath:(path:string)=>invalidated.add(path)}:name==='@/lib/admin-product-drafts'?{createDraftProduct,updateDraftProduct}:name==='@/lib/product-draft-validation'?require('../src/lib/product-draft-validation'):require(name)});
      const form=()=>{const data=new FormData();for(const [key,value]of Object.entries(input))data.set(key,value);return data;};
      await check('direct Server Action invocation still denies read-only role and forgery',async()=>{role='MARKETING_MANAGER';assert.equal((await compiled.exports.createDraftAction(initialDraftState,form())).status,'error');role='OWNER';for(const bad of ['duplicate','privileged']){const data=form();if(bad==='duplicate')data.append('name','TEST duplicate');else data.set('lifecycle','active');assert.equal((await compiled.exports.createDraftAction(initialDraftState,data)).status,'error');}});
      await check('Server Action create/update returns confirmation with fixed product ID',async()=>{const data=form();data.set('slug',`${marker}-action`);const saved=await compiled.exports.createDraftAction(initialDraftState,data);assert.equal(saved.status,'saved');assert(saved.productId);data.set('version',saved.version!);const updated=await compiled.exports.updateDraftAction(saved.productId,initialDraftState,data);assert.equal(updated.status,'saved');assert.equal(updated.productId,saved.productId);assert(updated.version!==saved.version);assert(invalidated.has('/admin/products'));assert(invalidated.has(`/admin/products/${saved.productId}`));});
      throw sentinel;
    },{timeout:30000});
  } catch(error){if(error!==sentinel)throw error;}
  finally {
    Reflect.set(auth.api,'getSession',originals.auth);Reflect.set(prisma.adminUser,'findUnique',originals.admin);Reflect.set(prisma.session,'findUnique',originals.session);Reflect.set(prisma.user,'findUniqueOrThrow',originals.user);Reflect.set(prisma,'$transaction',originals.transaction);Reflect.set(prisma,'$queryRaw',originals.raw);Reflect.set(prisma.category,'findMany',originals.categories);Reflect.set(prisma.category,'findUnique',originals.category);Reflect.set(prisma.product,'findMany',originals.products);Reflect.set(prisma.product,'findFirst',originals.product);
    const previous=stage;await check('all twelve fingerprints restored; no auth/product/variant/stock fixtures remain',async()=>assert(sameSnapshot(baseline.baseline,(await prepareRehearsal()).baseline)));stage=previous;
  }
  console.log(`${passed} draft write/security checks passed; outer transaction rolled back; no auth accounts created.`);
}
verify().catch(()=>{console.error(`Draft verification failed at ${stage}; sensitive details withheld.`);process.exitCode=1;}).finally(async()=>prisma.$disconnect());
