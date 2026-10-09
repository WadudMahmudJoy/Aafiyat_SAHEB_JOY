import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const runtimeRequire=createRequire(import.meta.url);
const compiledModule={exports:{} as {default:React.ComponentType<Record<string,unknown>>}};
const source=readFileSync('src/app/admin/dashboard-view.tsx','utf8');
runInNewContext(ts.transpile(source,{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),{
 module:compiledModule,exports:compiledModule.exports,require:(name:string)=>name.endsWith('.css')?{__esModule:true,default:new Proxy({},{get:(_,key)=>key})}:runtimeRequire(name),
});
const areas=[{id:'products',label:'Products and Inventory',description:'Care for the catalog, from product details to stock.',features:['Product catalog','Product management','Inventory management']},{id:'orders',label:'Orders',description:'Keep customer orders moving with clarity and care.',features:['Order history','Order management']},{id:'marketing',label:'Marketing',description:'Shape the brand experience and future campaigns.',features:['Offers and campaigns','Content management']},{id:'administration',label:'Administration',description:'Manage business settings, staff access, and accountability.',features:['Business settings','Administrator management','Activity auditing']}];
const dashboard={identity:{name:'TEST Operator',email:'dashboard@example.invalid'},role:'OWNER',roleLabel:'owner',areas:areas.map(area=>({...area,href:area.id==='products'?'/admin/products':null}))};
function render(state='ready',selected=areas,preview=false) {return renderToStaticMarkup(React.createElement(compiledModule.exports.default,{dashboard:{...dashboard,areas:selected.map(area=>({...area,href:area.id==='products'?'/admin/products':null}))},state,busy:false,preview,onSignOut(){},onRetry(){}}));}
function previewHtml() { return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Aafiyat SAHEB - Offline TEST Preview</title><style>body{margin:0;font-family:Arial,sans-serif}'+readFileSync('src/app/admin/dashboard.module.css','utf8')+'</style></head><body>'+render('ready',areas,true)+'</body></html>'; }
if(process.argv.includes('--preview')){
 // Offline presentation fixture only: no authentication, cookies, or database connection.
 // Direct UTF-8 output avoids legacy Windows PowerShell native-pipeline decoding.
 mkdirSync('.local',{recursive:true});
 writeFileSync('.local/dashboard-preview.html',previewHtml(),'utf8');
 console.log('Offline TEST preview written to .local/dashboard-preview.html. No authentication or database access.');
}else{
 let passed=0;
 function test(name:string,run:()=>unknown){run();passed++;console.log(`PASS: ${name}`);}
 test('only overview and implemented product catalogue have operational links',()=>{const html=render();assert.equal((html.match(/href="\/admin"/g)||[]).length,2);assert.equal((html.match(/href="\/admin\/products"/g)||[]).length,3);assert(!/href="\/admin\/(orders|marketing|administration)/.test(html));assert(html.includes('Upcoming'));});
 test('native mobile navigation and desktop navigation are labeled',()=>{const html=render();for(const label of ['aria-label="Administration"','aria-label="Mobile administration"','<summary>Workspace navigation</summary>','aria-current="page"','href="#dashboard-main"'])assert(html.includes(label));});
 test('restricted presentation contains only supplied server areas',()=>{const html=render('ready',[areas[1]]);assert(html.includes('Order management'));for(const denied of ['Products and Inventory','Marketing','Administration</h3>','Administrator management'])assert(!html.includes(denied));});
 test('checking and error states conceal identity and navigation',()=>{for(const state of ['checking','unavailable']){const html=render(state);assert(!html.includes('dashboard@example.invalid'));assert(!html.includes('Order management'));assert(!html.includes('<nav'));assert(html.includes('aria-live="polite"'));}assert(render('unavailable').includes('Retry'));});
 test('empty state is explicit; no fabricated business metrics',()=>{const html=render('ready',[]);assert(html.includes('No management modules are available'));assert(!html.includes('revenue'));assert(!html.includes('total orders'));});
 test('offline preview declares UTF-8 and preserves original Unicode symbols',()=>{const html=previewHtml();assert(html.indexOf('<meta charset="utf-8">')<1024);const decoded=Buffer.from(html,'utf8').toString('utf8');assert.equal(decoded,html);assert(decoded.includes('\u25c8'));assert(decoded.includes('\u00b7'));assert(!decoded.includes('\ufffd'));});
 test('offline preview disclaims authentication and disables sign-out',()=>{const html=previewHtml();assert(html.includes('TEST PREVIEW — NOT AUTHENTICATED'));assert(!html.includes('MFA-verified session'));assert(html.includes('Sample role'));assert(/<button[^>]+disabled=""[^>]*>Sign out \(mock\)<\/button>/.test(html));assert(!html.includes('href="/admin"'));assert(!html.includes('<script'));});
 test('real dashboard preserves verified status and operational sign-out',()=>{const html=render();assert(html.includes('MFA-verified session'));assert(!html.includes('NOT AUTHENTICATED'));assert(!html.includes('Sign out (mock)'));assert(!html.includes('disabled=""'));});
 test('identity output is escaped; sign-out remains available',()=>{dashboard.identity.name='<script>test</script>';const html=render();assert(html.includes('&lt;script&gt;test&lt;/script&gt;'));assert(html.includes('Sign out'));});
 console.log(`${passed} dashboard presentation/accessibility checks passed.`);
}

async function verifySessionLifecycle() {
 let passed=0;
 for(const mode of ['signout','signout-failure','expired','role-change','unavailable','retry','cleanup'] as const){
  const state: unknown[]=['ready',false];let index=0;let effect:(()=>()=>void)|undefined;
  const retryRef={current:null as (()=>Promise<void>)|null}; const replacements:string[]=[];let refreshed=0;let removed=0;let cleared=0;let calls=0;
  const entry={exports:{} as {default:(props:unknown)=>React.ReactElement<{onSignOut:()=>Promise<void>;onRetry:()=>void}>}};
  runInNewContext(ts.transpile(readFileSync('src/app/admin/admin-session.tsx','utf8'),{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),{
   module:entry,exports:entry.exports,
   document:{visibilityState:'visible',addEventListener(){},removeEventListener(){removed++;}},window:{addEventListener(){},removeEventListener(){removed++;}},setInterval:()=>1,clearInterval:()=>{cleared++;},
   require:(name:string)=>{
    if(name==='react')return {...React,useState:()=>{const i=index++;return [state[i],(value:unknown)=>{state[i]=value;}];},useRef:()=>retryRef,useEffect:(fn:()=>()=>void)=>{effect=fn;}};
    if(name==='next/navigation')return {useRouter:()=>({replace:(path:string)=>replacements.push(path),refresh:()=>{refreshed++;}})};
    if(name==='./dashboard-view')return {default:()=>null};
    if(name==='@/lib/admin-login-client')return {ADMIN_LOGIN:'/admin/login',signOut:async()=>{if(mode==='signout-failure')throw new Error('Unavailable');},checkAdminSession:async()=>{calls++;return mode==='expired'?new Response(null,{status:401}):mode==='unavailable'||(mode==='retry'&&calls===1)?new Response(null,{status:503}):Response.json({role:mode==='role-change'?'ORDER_MANAGER':'OWNER'});}};
    return runtimeRequire(name);
   },
  });
  const rendered=entry.exports.default({dashboard});const stop=effect!();await new Promise(resolve=>setImmediate(resolve));
  if(mode==='signout'||mode==='signout-failure'){await rendered.props.onSignOut();if(mode==='signout'){assert.deepEqual(replacements,['/admin/login']);assert.equal(refreshed,1);}else{assert.deepEqual(replacements,[]);assert.equal(state[0],'unavailable');assert.equal(state[1],false);}}
  if(mode==='expired'){assert.deepEqual(replacements,['/admin/login?reason=expired']);assert.equal(state[0],'checking');}
  if(mode==='role-change'){assert.equal(refreshed,1);assert.equal(state[0],'checking');}
  if(mode==='unavailable'){assert.equal(state[0],'unavailable');assert.deepEqual(replacements,[]);}
  if(mode==='retry'){assert.equal(state[0],'unavailable');rendered.props.onRetry();await new Promise(resolve=>setImmediate(resolve));assert.equal(state[0],'ready');assert.equal(calls,2);}
  stop();assert.equal(retryRef.current,null);assert.equal(removed,2);assert.equal(cleared,1);
  passed++;console.log(`PASS: dashboard session lifecycle ${mode}`);
 }
 console.log(`${passed} dashboard session/sign-out checks passed.`);
}
if(!process.argv.includes('--preview'))verifySessionLifecycle().catch(()=>{console.error('Dashboard session checks failed; details withheld.');process.exitCode=1;});
