import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as validation from '../src/lib/variant-validation';
import { catalogueHref, formatCataloguePrice } from '../src/lib/admin-catalog-format';
const require = createRequire(import.meta.url);
const id = '009b0000-0000-4000-8000-000000000001';
const category = { id, name: 'TEST T-Shirt', active: true, slug: 't-shirts' };
const values = { sku: 'TEST-009C-M-GREEN', sizeCode: 'm', sizeLabel: 'Medium', colorCode: 'forest', colorLabel: 'Forest green', price: '1250.01' };
const version = '2026-10-09T00:00:00.123456Z';
const dashboard = { identity: { name: 'TEST operator', email: 'draft@example.invalid' }, role: 'OWNER', roleLabel: 'owner', areas: [{ id: 'products', label: 'Products and Inventory', description: 'Product catalogue', features: ['Product catalog','Product management'], href: '/admin/products' }] };
let stage='presentation setup';
let state: validation.VariantFormState = validation.initialVariantState; let pending = false;
function MockLink({ prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) { void prefetch; return React.createElement('a', props); }
function compile(file: string, modules: Record<string, unknown> = {}) {
  const compiled = { exports: {} as Record<string, React.ComponentType<Record<string, unknown>>> };
  runInNewContext(ts.transpile(readFileSync(file,'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }), {
    module: compiled, exports: compiled.exports, window: { location: { reload() {} } },
    require: (name: string) => name.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, key) => `${file.includes('variant-form')?'draft':file.includes('catalogue-view')?'catalogue':'dashboard'}_${String(key)}` }) }
      : name in modules ? modules[name] : require(name),
  }); return compiled.exports;
}
const form = compile('src/app/admin/products/variant-form.tsx', { react: { ...React, useActionState: () => [state, '#draft-preview', pending] }, 'next/link': { __esModule: true, default: MockLink }, './variant-actions': { saveVariantAction() {} }, '@/lib/variant-validation': validation }).default;
const shell = compile('src/app/admin/dashboard-view.tsx').default;
const catalogue = compile('src/app/admin/products/catalogue-view.tsx', { 'next/link': { __esModule: true, default: MockLink }, '@/lib/admin-catalog-format': { catalogueHref, formatCataloguePrice } });
const render = (component: React.ComponentType<Record<string,unknown>>, props: Record<string,unknown>) => renderToStaticMarkup(React.createElement(component, props));
const props = { productId: id, productName: 'TEST product draft' }; const edit = { ...props, variantId: id, version, values };

async function verify() {
  let passed=0; const check=async(label:string,run:()=>unknown|Promise<unknown>)=>{stage=label;await run();passed++;console.log('PASS: '+label);};
  await check('six supported fields have labels, required validation and exact text price input',()=>{const html=render(form,props);for(const key of validation.variantFields){assert(html.includes('name="'+key+'"'));assert(html.includes('for="'+key+'"'));}assert(html.includes('inputMode="decimal"'));assert(!html.includes('type="number"'));assert(!html.includes('name="currency"'));assert(!html.includes('name="active"'));});
  await check('edit values and full microsecond revision are prefilled',()=>{const html=render(form,edit);assert(html.includes('Edit variant'));assert(html.includes('value="1250.01"'));assert(html.includes(version));assert(html.includes('Save changes'));assert(html.includes('>Cancel<'));});
  await check('loading disables fieldset/save and announces progress',()=>{pending=true;const html=render(form,edit);assert(html.includes('<fieldset disabled'));assert(html.includes('aria-busy="true"'));assert(html.includes('Saving variant'));pending=false;});
  await check('create confirmation prevents duplicate submission',()=>{state={status:'saved',message:'Variant saved. Inventory unchanged.',fields:{},variantId:id,version};const html=render(form,props);assert(html.includes('<fieldset disabled'));assert(html.includes('Back to product'));assert(html.includes('role="status"'));state=validation.initialVariantState;});
  await check('edit success keeps editing enabled with fresh revision',()=>{state={status:'saved',message:'Variant saved.',fields:{},variantId:id,version:'2026-10-09T00:00:00.123457Z'};const html=render(form,edit);assert(!html.includes('<fieldset disabled'));assert(html.includes(state.version!));state=validation.initialVariantState;});
  await check('duplicate field feedback and conflict reload retain inputs',()=>{state={status:'error',message:'Reload latest values.',fields:{sku:'SKU already exists.'},conflict:true};const html=render(form,edit);for(const part of ['aria-invalid="true"','aria-describedby="sku-error"','id="sku-error"','role="alert"','discards unsaved changes','value="1250.01"'])assert(html.includes(part));state=validation.initialVariantState;});
  await check('Cancel navigates to fixed parent and untrusted labels are escaped',()=>{assert(render(form,edit).includes('href="/admin/products/'+id+'"'));assert(!render(form,{...props,productName:'<script>unsafe</script>'}).includes('<script>'));});
  await check('Add/Edit variant controls require write permission and draft parent',()=>{const product={id,name:'TEST',slug:'test',description:'',lifecycle:'draft',category,variantCount:1,archivedAt:null,createdAt:'TEST',updatedAt:'TEST',seoTitle:null,seoDescription:null};const variant={id,...values,priceMinor:'125001',currency:'BDT',active:true,archivedAt:null};const detail={dashboard,canViewInventory:false,canWriteProducts:true,product,variants:[variant],nextCursor:null,error:null};let html=render(catalogue.ProductDetailView,{detail});assert(html.includes('Add Variant'));assert(html.includes('Edit Variant'));for(const patch of [{canWriteProducts:false},{product:{...product,lifecycle:'active'}}]){html=render(catalogue.ProductDetailView,{detail:{...detail,...patch}});assert(!html.includes('Add Variant'));assert(!html.includes('Edit Variant'));}html=render(catalogue.ProductDetailView,{detail:{...detail,variants:[{...variant,archivedAt:'TEST'}]}});assert(!html.includes('Edit Variant'));});
  await check('server editor calls guard with exact IDs and denies without private form',async()=>{class Denied extends Error{constructor(public reason:string){super('Denied');}}class WriteError extends Error{constructor(public code:string){super('Only draft products.');}}let denial='';let received:unknown[]=[];const request=new Headers();const modules={'next/headers':{headers:async()=>request},'next/navigation':{redirect(path:string){throw new Error('REDIRECT:'+path);},notFound(){throw new Error('NOT_FOUND');}},'@/lib/admin-product-variants':{getVariantEditor:async(...args:unknown[])=>{received=args;if(denial==='NOT_DRAFT')throw new WriteError(denial);if(denial)throw new Denied(denial);return{dashboard,product:{id,name:'TEST'},variant:{id,version,values}};},VariantWriteError:WriteError},'@/lib/admin-authorization':{AdminAuthorizationError:Denied},'../admin-session':{default:()=>null},'./catalogue-view':catalogue,'./variant-form':{default:form}};const editor=compile('src/app/admin/products/variant-editor.tsx',modules).default as unknown as(props:unknown)=>Promise<React.ReactElement>;await editor({productId:id,variantId:id});assert.deepEqual(received,[request,id,id]);for(const reason of ['PERMISSION_DENIED','UNAUTHENTICATED','MFA_NOT_VERIFIED','ADMIN_DISABLED']){denial=reason;await assert.rejects(editor({productId:id}),new RegExp(reason==='PERMISSION_DENIED'?'REDIRECT:/admin/products$':'REDIRECT:/admin/login'));}denial='NOT_DRAFT';assert(!renderToStaticMarkup(await editor({productId:id})).includes('<form'));});
  await check('new/edit pages force dynamic rendering; shared CSS supports mobile and keyboard controls',()=>{for(const path of ['src/app/admin/products/[id]/variants/new/page.tsx','src/app/admin/products/[id]/variants/[variantId]/edit/page.tsx'])assert(readFileSync(path,'utf8').includes('force-dynamic'));const css=readFileSync('src/app/admin/products/draft.module.css','utf8');assert(css.includes('grid-template-columns: 1fr'));assert(css.includes(':focus-visible'));assert(css.includes('min-height: 44px'));assert(css.includes('flex-wrap: wrap'));});
  console.log(passed+' variant presentation/route checks passed; no database access.');
}
if(process.argv.includes('--preview')) {
 const markup=render(shell,{dashboard,state:'ready',busy:false,currentPage:'products',preview:true,children:React.createElement(React.Fragment,null,React.createElement('p',null,'TEST PREVIEW — NOT AUTHENTICATED. Disposable static values; saving is disabled.'),React.createElement(form,process.argv.includes('--edit')?edit:props)),onSignOut(){},onRetry(){}}).replace(/href="\/admin[^\"]*"/g,'href="#dashboard-main"').replace('type="submit"','type="submit" disabled');
 const css=[['src/app/admin/dashboard.module.css','dashboard'],['src/app/admin/products/draft.module.css','draft']].map(([file,prefix])=>readFileSync(file,'utf8').replace(/\.([a-zA-Z][\w-]*)/g,'.'+prefix+'_$1')).join('\n');
 mkdirSync('.local',{recursive:true});writeFileSync('.local/dashboard-preview.html','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST variant preview</title><style>body{margin:0;font-family:Arial,sans-serif}'+css+'</style></head><body>'+markup+'</body></html>','utf8');console.log('Ignored TEST variant preview created; no authentication or database access.');
} else verify().catch(()=>{console.error('Variant presentation failed at '+stage+'; sensitive details withheld.');process.exitCode=1;});
