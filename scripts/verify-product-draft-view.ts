import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as validation from '../src/lib/product-draft-validation';
import { catalogueHref, formatCataloguePrice } from '../src/lib/admin-catalog-format';
const require = createRequire(import.meta.url);
const id = '009b0000-0000-4000-8000-000000000001';
const category = { id, name: 'TEST T-Shirt', active: true, slug: 't-shirts' };
const values = { name: 'TEST product draft', categoryId: id, slug: 'test-product-draft', description: 'Private TEST draft description', seoTitle: '', seoDescription: '' };
const version = '2026-10-09T00:00:00.123456Z';
const dashboard = { identity: { name: 'TEST operator', email: 'draft@example.invalid' }, role: 'OWNER', roleLabel: 'owner', areas: [{ id: 'products', label: 'Products and Inventory', description: 'Product catalogue', features: ['Product catalog','Product management'], href: '/admin/products' }] };
let stage='presentation setup';
let state: validation.DraftFormState = validation.initialDraftState; let pending = false;
function MockLink({ prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) { void prefetch; return React.createElement('a', props); }
function compile(file: string, modules: Record<string, unknown> = {}) {
  const compiled = { exports: {} as Record<string, React.ComponentType<Record<string, unknown>>> };
  runInNewContext(ts.transpile(readFileSync(file,'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }), {
    module: compiled, exports: compiled.exports, window: { location: { reload() {} } },
    require: (name: string) => name.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, key) => `${file.includes('draft-form')?'draft':file.includes('catalogue-view')?'catalogue':'dashboard'}_${String(key)}` }) }
      : name in modules ? modules[name] : require(name),
  }); return compiled.exports;
}
const form = compile('src/app/admin/products/draft-form.tsx', { react: { ...React, useActionState: () => [state, '#draft-preview', pending] }, 'next/link': { __esModule: true, default: MockLink }, './draft-actions': { createDraftAction() {}, updateDraftAction() {} }, '@/lib/product-draft-validation': validation }).default;
const shell = compile('src/app/admin/dashboard-view.tsx').default;
const catalogue = compile('src/app/admin/products/catalogue-view.tsx', { 'next/link': { __esModule: true, default: MockLink }, '@/lib/admin-catalog-format': { catalogueHref, formatCataloguePrice } });
const render = (component: React.ComponentType<Record<string,unknown>>, props: Record<string,unknown>) => renderToStaticMarkup(React.createElement(component, props));
const props = { categories: [category] }; const edit = { ...props, productId: id, version, values };
async function verify() {
  let passed = 0; const check = async(label: string, run: () => unknown | Promise<unknown>) => { stage=label;await run(); passed++; console.log(`PASS: ${label}`); };
  await check('create form has six supported fields, required labels and bounded inputs', () => { const html = render(form,props); for(const key of validation.draftFields) assert(html.includes(`name="${key}"`)); for(const key of ['name','categoryId','slug'])assert((html.match(/<(?:input|select)[^>]*>/g)||[]).some(tag=>tag.includes(`name="${key}"`)&&tag.includes('required=""'))); assert(html.includes('<label for="description">')); assert(html.includes('maxLength="10000"')); for(const forbidden of ['lifecycle','priceMinor','role','token'])assert(!html.includes(`name="${forbidden}"`)); });
  await check('edit prepopulates metadata and preserves full revision precision', () => { const html=render(form,edit);assert(html.includes('Edit product draft'));assert(html.includes(`value="${values.name}"`));assert(html.includes(version));assert(html.includes('Private TEST draft description')); });
  await check('pending submission disables fields/buttons and announces progress', () => { pending=true;const html=render(form,props);assert(html.includes('aria-busy="true"'));assert(html.includes('<fieldset disabled'));assert(html.includes('Saving draft'));pending=false; });
  await check('create confirmation links to exact product and prevents duplicate resubmission', () => { state={status:'saved',message:'Draft saved. It is not published.',fields:{},productId:id,version};const html=render(form,props);assert(html.includes(`href="/admin/products/${id}"`));assert(html.includes('<fieldset disabled'));assert(html.includes('role="status"'));state=validation.initialDraftState; });
  await check('edit success carries fresh revision without disabling further edits', () => { state={status:'saved',message:'Draft saved.',fields:{},productId:id,version:'2026-10-09T00:00:00.123457Z'};const html=render(form,edit);assert(html.includes(state.version!));assert(!html.includes('<fieldset disabled'));state=validation.initialDraftState; });
  await check('field errors are associated, conflict retains values and offers explicit reload', () => { state={status:'error',message:'Reload the latest draft and reapply your changes.',fields:{slug:'This slug is already in use.'},conflict:true};const html=render(form,edit);for(const text of ['aria-invalid="true"','aria-describedby="slug-error"','id="slug-error"','role="alert"','discards unsaved changes',`value="${values.name}"`])assert(html.includes(text));state=validation.initialDraftState; });
  await check('Cancel is navigation only; missing categories prevent creation', () => { assert(render(form,edit).includes(`href="/admin/products/${id}"`));const html=render(form,{categories:[]});assert(html.includes('No categories are available'));assert(html.includes('type="submit" disabled')); });
  await check('untrusted metadata is escaped; validation normalizes without accepting privileged fields', () => { const html=render(form,{...edit,values:{...values,name:'<script>test</script>'}});assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(validation.validateDraft({...values,slug:' TEST-SLUG '}).valid);assert.equal(validation.validateDraft({...values,slug:' TEST-SLUG '}).values.slug,'test-slug');assert(!validation.validateDraft({...values,lifecycle:'active'}).valid); });
  await check('Add/Edit controls require server write grant and edit requires draft', () => {
    const product={id,...values,lifecycle:'draft',category,variantCount:0,exampleVariant:null,archivedAt:null,createdAt:'TEST',updatedAt:'TEST'};
    const page={dashboard,canViewInventory:false,canWriteProducts:true,items:[product],categories:[category],categoriesTruncated:false,filters:{search:'',category:''},nextCursor:null,error:null};
    assert(render(catalogue.CatalogueView,{catalogue:page}).includes('Add Product'));assert(!render(catalogue.CatalogueView,{catalogue:{...page,canWriteProducts:false}}).includes('Add Product'));
    const detail={dashboard,canViewInventory:false,canWriteProducts:true,product,variants:[],nextCursor:null,error:null};assert(render(catalogue.ProductDetailView,{detail}).includes('Edit Product'));for(const lifecycle of ['active','discontinued','archived'])assert(!render(catalogue.ProductDetailView,{detail:{...detail,product:{...product,lifecycle}}}).includes('Edit Product'));assert(!render(catalogue.ProductDetailView,{detail:{...detail,canWriteProducts:false}}).includes('Edit Product'));
  });
  class Denied extends Error { constructor(public reason:string){super('Denied');} } class DraftError extends Error { constructor(public code:string){super('Only draft products can be edited.');} }
  let denial: string | null = null; const requestHeaders = new Headers(); let received: Headers | null = null;
  const modules={'next/headers':{headers:async()=>requestHeaders},'next/navigation':{redirect(path:string){throw new Error(`REDIRECT:${path}`);},notFound(){throw new Error('NOT_FOUND');}},'@/lib/admin-product-drafts':{getDraftEditor:async(headers:Headers)=>{received=headers;if(denial==='NOT_DRAFT'||denial==='NOT_FOUND')throw new DraftError(denial);if(denial)throw new Denied(denial);return {dashboard,categories:[category],product:{id,...values,version}};},DraftWriteError:DraftError},'@/lib/admin-authorization':{AdminAuthorizationError:Denied},'../../admin-session':{default:()=>null},'../../../admin-session':{default:()=>null},'../catalogue-view':catalogue,'../../catalogue-view':catalogue,'../draft-form':{default:form},'../../draft-form':{default:form}};
  const create=compile('src/app/admin/products/new/page.tsx',modules);const update=compile('src/app/admin/products/[id]/edit/page.tsx',modules);
  const routes=[create.default,update.default] as unknown as ((props:unknown)=>Promise<React.ReactElement>)[];
  await check('new/edit server pages guard current request and disable private route caching',async()=>{for(const route of routes){await route({params:Promise.resolve({id})});assert.equal(received,requestHeaders);}assert.equal(create.dynamic,'force-dynamic');assert.equal(update.dynamic,'force-dynamic');});
  await check('direct unauthorized editor routes redirect safely; non-draft has no edit form',async()=>{for(const reason of ['PERMISSION_DENIED','UNAUTHENTICATED','MFA_NOT_VERIFIED','ADMIN_DISABLED']){denial=reason;for(const route of routes)await assert.rejects(route({params:Promise.resolve({id})}),new RegExp(reason==='PERMISSION_DENIED'?'REDIRECT:/admin/products$':'REDIRECT:/admin/login\\?reason=expired'));}denial='NOT_DRAFT';const html=renderToStaticMarkup(await routes[1]({params:Promise.resolve({id})}));assert(!html.includes('<form'));assert(html.includes('Only draft products'));denial='NOT_FOUND';await assert.rejects(routes[1]({params:Promise.resolve({id})}),/NOT_FOUND/);denial=null;});
  console.log(`${passed} draft form/navigation/route checks passed; no database access.`);
}
if(process.argv.includes('--preview')) {
  const markup=render(shell,{dashboard,state:'ready',busy:false,currentPage:'products',preview:true,children:React.createElement(React.Fragment,null,React.createElement('p',null,'TEST PREVIEW — NOT AUTHENTICATED. Disposable static fields; saving is disabled.'),React.createElement(form,process.argv.includes('--edit')?edit:props)),onSignOut(){},onRetry(){}}).replace(/href="\/admin[^\"]*"/g,'href="#dashboard-main"').replace('type="submit"','type="submit" disabled');
  const css=[['src/app/admin/dashboard.module.css','dashboard'],['src/app/admin/products/draft.module.css','draft']].map(([file,prefix])=>readFileSync(file,'utf8').replace(/\.([a-zA-Z][\w-]*)/g,`.${prefix}_$1`)).join('\n');
  mkdirSync('.local',{recursive:true});writeFileSync('.local/dashboard-preview.html',`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST draft form preview</title><style>body{margin:0;font-family:Arial,sans-serif}${css}</style></head><body>${markup}</body></html>`,'utf8');console.log('Static TEST draft preview written to ignored .local/dashboard-preview.html; no authentication or database connection.');
} else verify().catch(()=>{console.error(`Draft presentation verification failed at ${stage}; sensitive details withheld.`);process.exitCode=1;});
