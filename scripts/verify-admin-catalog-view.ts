import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { catalogueHref, formatCataloguePrice } from '../src/lib/admin-catalog-format';
const runtimeRequire=createRequire(import.meta.url);
function compile(file:string,modules:Record<string,unknown>={}){
 const compiledModule={exports:{} as Record<string,React.ComponentType<Record<string,unknown>>>};
 runInNewContext(ts.transpile(readFileSync(file,'utf8'),{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),{module:compiledModule,exports:compiledModule.exports,require:(name:string)=>name.endsWith('.css')?{__esModule:true,default:new Proxy({},{get:(_,key)=>`${file.includes('/products/')?'catalogue':'dashboard'}_${String(key)}`})}:name in modules?modules[name]:runtimeRequire(name)});
 return compiledModule.exports;
}
function MockLink({prefetch, ...props}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {prefetch?:boolean}) {void prefetch;return React.createElement('a',props);}
const view=compile('src/app/admin/products/catalogue-view.tsx',{'@/lib/admin-catalog-format':{catalogueHref,formatCataloguePrice},'next/link':{__esModule:true,default:MockLink}});
const shell=compile('src/app/admin/dashboard-view.tsx');
const id='009a0000-0000-4000-8000-000000000001';
const category={id,name:'TEST T-Shirt',slug:'test-t-shirts',active:true};
const dashboard={identity:{name:'TEST layout operator',email:'layout@example.invalid'},role:'OWNER',roleLabel:'owner',areas:[{id:'products',label:'Products and Inventory',description:'Read-only catalogue',features:['Product catalog','Inventory management'],href:'/admin/products'}]};
const variant={id,sku:'TEST-LAYOUT-ONLY',sizeCode:'m',sizeLabel:'M',colorCode:'forest',colorLabel:'Forest',active:true,archivedAt:null,priceMinor:'9223372036854775807',currency:'BDT',inventory:{onHand:10,reserved:4,available:6,lowStockThreshold:null}};
const product={id,name:'TEST layout product',slug:'test-layout-product',category,lifecycle:'draft',variantCount:1,exampleVariant:variant};
const catalogue={dashboard,canViewInventory:true,items:[product],filters:{search:'',category:''},categories:[category],categoriesTruncated:false,nextCursor:id,error:null};
const detail={dashboard,canViewInventory:true,product:{...product,description:'TEST layout description',createdAt:'2026-10-09T00:00:00.000Z',updatedAt:'2026-10-09T00:00:00.000Z',archivedAt:null,seoTitle:null,seoDescription:null},variants:[variant],nextCursor:null,error:null};
const render=(component:React.ComponentType<Record<string,unknown>>,props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(component,props));
async function verify(){
 let passed=0;const test=async(name:string,run:()=>unknown|Promise<unknown>)=>{await run();passed++;console.log(`PASS: ${name}`);};
 await test('zero, singular and plural product/variant counts are correct',()=>{for(const count of [0,1,2]){const noun=count===1?'product':'products';const variantNoun=count===1?'variant':'variants';const list=render(view.CatalogueView,{catalogue:{...catalogue,items:Array.from({length:count},(_,i)=>({...product,id:String(i),variantCount:count}))}});assert(list.includes(`${count} ${noun} shown`));if(count)assert(list.includes(`${count} ${variantNoun}<`));const html=render(view.ProductDetailView,{detail:{...detail,product:{...detail.product,variantCount:count}}});assert(html.includes(`${count} ${variantNoun} total.`));}});
 await test('GET filters have accessible labels and preserve search/category',()=>{const html=render(view.CatalogueView,{catalogue});for(const text of ['method="get"','action="/admin/products"','for="product-search"','for="product-category"','maxLength="100"'])assert(html.includes(text));});
 await test('table has caption, scoped headers, keyboard-scrollable region and safe links',()=>{const html=render(view.CatalogueView,{catalogue});for(const text of ['<caption>','scope="col"','tabindex="0"','role="region"',`href="/admin/products/${id}"`])assert(html.includes(text));});
 await test('empty catalogue and filtered empty results are explicit',()=>{let html=render(view.CatalogueView,{catalogue:{...catalogue,items:[]}});assert(html.includes('No products have been added'));html=render(view.CatalogueView,{catalogue:{...catalogue,items:[],filters:{search:'none',category:''}}});assert(html.includes('Try clearing or changing'));});
 await test('generic error state offers only safe read navigation',()=>{const html=render(view.CatalogueView,{catalogue:{...catalogue,error:'The catalogue is temporarily unavailable.'}});assert(html.includes('role="alert"'));assert(!html.includes('TEST layout product'));assert(html.includes('Reload catalogue'));});
 await test('restricted list/detail UI omit exact inventory',()=>{for(const html of [render(view.CatalogueView,{catalogue:{...catalogue,canViewInventory:false}}),render(view.ProductDetailView,{detail:{...detail,canViewInventory:false}})]){assert(!html.includes('On hand:'));assert(!html.includes('Reserved:'));assert(!html.includes('Available · first variant'));}assert(render(view.ProductDetailView,{detail:{...detail,canViewInventory:false}}).includes('restricted by server permissions'));});
 await test('detail distinguishes product, variant and inventory data',()=>{const html=render(view.ProductDetailView,{detail});for(const text of ['Product information','Product variants','Inventory information','On hand: 10','Reserved: 4','Available: 6','Not configured'])assert(html.includes(text));});
 await test('untrusted product/search text is escaped',()=>{const html=render(view.CatalogueView,{catalogue:{...catalogue,items:[{...product,name:'<script>test</script>'}],filters:{search:'" onfocus="test',category:''}}});assert(html.includes('&lt;script&gt;test&lt;/script&gt;'));assert(!html.includes('<script>'));});
 await test('catalogue shell marks products current without granting missing areas',()=>{const html=render(shell.default,{dashboard,state:'ready',busy:false,currentPage:'products',children:React.createElement(view.CatalogueView,{catalogue}),onSignOut(){},onRetry(){}});assert(html.includes('Read-only catalogue'));assert(html.includes('Product catalogue'));assert(!html.includes('/admin/orders'));assert(!html.includes('Upcoming</h1>'));});
 class Denied extends Error{constructor(public reason:string){super('Denied');}}
 const redirect=(path:string)=>{throw new Error(`REDIRECT:${path}`);};let denial:string|null=null;const requestHeaders=new Headers();let received:Headers|null=null;
 const services={getAdminProducts:async(headers:Headers)=>{received=headers;if(denial)throw new Denied(denial);return catalogue;},getAdminProduct:async(headers:Headers)=>{received=headers;if(denial)throw new Denied(denial);return detail;}};
 const modules={'next/headers':{headers:async()=>requestHeaders},'next/navigation':{redirect,notFound(){throw new Error('NOT_FOUND');}},'@/lib/admin-catalog':services,'@/lib/admin-authorization':{AdminAuthorizationError:Denied},'../admin-session':{default:()=>null},'../../admin-session':{default:()=>null},'./catalogue-view':view,'../catalogue-view':view};
 const list=compile('src/app/admin/products/page.tsx',modules).default as unknown as (props:unknown)=>Promise<React.ReactElement>;
 const item=compile('src/app/admin/products/[id]/page.tsx',modules).default as unknown as (props:unknown)=>Promise<React.ReactElement>;
 const args={searchParams:Promise.resolve({}),params:Promise.resolve({id})};
 await test('authorized server routes pass exact request headers to guarded services',async()=>{await list(args);assert.equal(received,requestHeaders);await item(args);assert.equal(received,requestHeaders);});
 await test('unauthorized direct routes use fixed redirects without rendering private data',async()=>{for(const reason of ['PERMISSION_DENIED','UNAUTHENTICATED','MFA_NOT_VERIFIED','ADMIN_DISABLED']){denial=reason;for(const route of [list,item])await assert.rejects(route(args),new RegExp(reason==='PERMISSION_DENIED'?'REDIRECT:/admin$':'REDIRECT:/admin/login\\?reason=expired'));}denial=null;});
 console.log(`${passed} catalogue route/presentation checks passed; no database writes.`);
}
if(process.argv.includes('--preview')){
 const markup=render(shell.default,{dashboard,state:'ready',busy:false,currentPage:'products',preview:true,children:React.createElement(React.Fragment,null,React.createElement('p',{'className':'info'},'TEST PREVIEW — NOT AUTHENTICATED. Static layout fixtures only; filters and links are visual mocks.'),React.createElement(process.argv.includes('--detail')?view.ProductDetailView:view.CatalogueView,process.argv.includes('--detail')?{detail}:{catalogue})),onSignOut(){},onRetry(){}}).replace(/action="\/admin\/products"/g,'action="#dashboard-main"').replace(/href="\/admin\/products[^\"]*"/g,'href="#dashboard-main"').replace('type="submit"','type="submit" disabled');
 mkdirSync('.local',{recursive:true});writeFileSync('.local/dashboard-preview.html','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST catalogue preview</title><style>body{margin:0;font-family:Arial,sans-serif}'+readFileSync('src/app/admin/dashboard.module.css','utf8').replace(/\.([a-zA-Z][\w-]*)/g,'.dashboard_$1')+readFileSync('src/app/admin/products/catalogue.module.css','utf8').replace(/\.([a-zA-Z][\w-]*)/g,'.catalogue_$1')+'</style></head><body>'+markup+'</body></html>','utf8');console.log('Static TEST catalogue preview written to .local/dashboard-preview.html; no authentication or database connection.');
}else verify().catch(()=>{console.error('Catalogue route/view verification failed; details withheld.');process.exitCode=1;});
