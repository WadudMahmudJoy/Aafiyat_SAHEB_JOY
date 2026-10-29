// One-time, explicitly authorized Task 010-C local migration. No media migration.
import assert from "node:assert/strict";
import { readFileSync,writeFileSync,readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash,randomUUID,randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require=createRequire(import.meta.url),{Client}=require("pg"),dotenv=require("dotenv");
assert.equal(process.env.AAFIYAT_APPLY_REVIEWED_ORDERS,"010-C");
const env=dotenv.parse(readFileSync(".env"));const url=new URL(env.DATABASE_URL);
assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"55432");assert.equal(url.pathname,"/aafiyat_dev");
if(process.env.DATABASE_URL)assert.equal(process.env.DATABASE_URL,url.toString());
const backup=readFileSync(join(tmpdir(),"aafiyat-010c-backup-location.txt"),"utf8").trim();
const sha=b=>createHash("sha256").update(b).digest("hex");
function command(bin,args,options={}){const r=spawnSync(bin,args,{windowsHide:true,maxBuffer:64*1024*1024,...options});if(r.status!==0)throw new Error(`${bin} operation failed; sensitive diagnostics withheld`);return r.stdout;}
const docker=(args,opts)=>command("docker",args,opts);
const pending="20261028000000_add_orders_customers";
const migrations=readdirSync("prisma/migrations",{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort();assert.equal(migrations.length,6);assert.equal(migrations[5],pending);
for(const name of migrations){const f=`prisma/migrations/${name}/migration.sql`;assert(readFileSync(f).equals(command("git",["show",`HEAD:${f}`])));}
assert.equal(command("git",["rev-parse","HEAD"]).toString().trim(),"3cb1503be1c26b83e42683cfaaabc94a0c3b5b45");
async function snapshot(client){await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");try{
 const identity=(await client.query("SELECT current_database() db,current_setting('server_version_num') version,(pg_control_system()).system_identifier::text system")).rows[0];
 const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;const data=[];
 for(const {tablename}of tables){const q='"'+tablename.replaceAll('"','""')+'"';data.push({table:tablename,...(await client.query(`SELECT count(*)::text count,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) hash FROM public.${q} t`)).rows[0]});}
 const history=(await client.query("SELECT migration_name,checksum,finished_at IS NOT NULL finished,rolled_back_at IS NOT NULL rolled_back FROM _prisma_migrations ORDER BY migration_name")).rows;
 return {identity,tables:data,history};
 }finally{await client.query("ROLLBACK");}}
const dev=new Client({connectionString:url.toString(),connectionTimeoutMillis:3000,options:"-c default_transaction_read_only=on -c statement_timeout=10000"});
const run=randomUUID(),container=`aafiyat-orders-backup-010c-${run}`,db=`restore_${run.replaceAll("-","")}`,password=randomBytes(24).toString("hex");let created=false;
const report={task:"010-C-phase1",run,status:"RUNNING",backupId:backup.split(/[\\/]/).at(-1)};
try{
 await dev.connect();const before=await snapshot(dev);assert.equal(before.identity.db,"aafiyat_dev");assert.equal(before.identity.version,"180006");assert.equal(before.tables.length,13);assert.equal(before.history.length,5);
 for(let i=0;i<5;i++){const h=before.history[i];assert(h.finished&&!h.rolled_back);assert.equal(h.migration_name,migrations[i]);assert.equal(h.checksum,sha(readFileSync(`prisma/migrations/${h.migration_name}/migration.sql`)));}
 report.before=before;writeFileSync(join(backup,"before.json"),JSON.stringify(before,null,2));
 const ids=docker(["ps","-q"]).toString().trim().split(/\s+/).filter(Boolean);const infos=JSON.parse(docker(["inspect",...ids]).toString());const matches=infos.filter(i=>(i.NetworkSettings.Ports["5432/tcp"]??[]).some(b=>b.HostIp==="127.0.0.1"&&b.HostPort==="55432"));assert.equal(matches.length,1);const source=matches[0];
 const system=docker(["exec",source.Id,"psql","-XAt","-U",decodeURIComponent(url.username),"-d","aafiyat_dev","-c","SELECT (pg_control_system()).system_identifier"]).toString().trim();assert.equal(system,before.identity.system);
 const dump=docker(["exec",source.Id,"pg_dump","-U",decodeURIComponent(url.username),"-d","aafiyat_dev","--format=custom","--no-owner","--no-acl"]);assert(dump.length>1000);assert.equal(dump.subarray(0,5).toString(),"PGDMP");writeFileSync(join(backup,"aafiyat_dev-before-orders.dump"),dump);report.backupSha256=sha(dump);assert.equal(sha(readFileSync(join(backup,"aafiyat_dev-before-orders.dump"))),report.backupSha256);
 const acl=command("pwsh",["-NoProfile","-Command","$p=Get-Content -LiteralPath (Join-Path $env:TEMP 'aafiyat-010c-backup-location.txt');$a=Get-Acl -LiteralPath $p.Trim();if(-not $a.AreAccessRulesProtected){exit 1};if(@($a.Access|Where-Object {$_.IdentityReference -match 'Everyone|Users|Authenticated Users'}).Count){exit 1}"],{encoding:"utf8"});void acl;
 docker(["run","-d","--name",container,"--label",`verification.run=${run}`,"--publish","127.0.0.1::5432","--tmpfs","/var/lib/postgresql:rw,size=536870912","--env","POSTGRES_PASSWORD","--env",`POSTGRES_DB=${db}`,"postgres:18.6-bookworm"],{env:{...process.env,POSTGRES_PASSWORD:password}});created=true;
 const info=JSON.parse(docker(["inspect",container]).toString())[0];assert.equal(info.Config.Labels["verification.run"],run);assert(info.Mounts.every(m=>m.Type==="tmpfs"));const binding=info.NetworkSettings.Ports["5432/tcp"][0];assert.equal(binding.HostIp,"127.0.0.1");assert.notEqual(binding.HostPort,"55432");
 for(let i=0;i<40;i++){const ready=spawnSync("docker",["exec",container,"pg_isready","-U","postgres","-d",db],{windowsHide:true});if(ready.status===0)break;assert(i<39);await delay(250);}
 docker(["exec","-i",container,"pg_restore","-U","postgres","-d",db,"--exit-on-error","--no-owner","--no-acl"],{input:dump});
 const restored=new Client({connectionString:`postgresql://postgres:${password}@127.0.0.1:${binding.HostPort}/${db}`});await restored.connect();try{const state=await snapshot(restored);assert.deepEqual(state.tables,before.tables);assert.deepEqual(state.history,before.history);}finally{await restored.end();}
 report.backupRestoreVerified=true;assert.deepEqual(await snapshot(dev),before);console.log("PASS: restricted backup restored successfully in disposable PostgreSQL; all original fingerprints and history match.");
 // No other migration may be added between verification and the deploy call.
 assert.deepEqual(readdirSync("prisma/migrations",{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort(),migrations);
 command(process.execPath,[require.resolve("prisma/build/index.js"),"migrate","deploy"],{env:{...process.env,DATABASE_URL:url.toString()},encoding:"utf8"});report.migrationApplied=true;
 const after=await snapshot(dev);assert.equal(after.history.length,6);assert.equal(after.tables.length,18);for(const h of after.history){assert(h.finished&&!h.rolled_back);assert.equal(h.checksum,sha(readFileSync(`prisma/migrations/${h.migration_name}/migration.sql`)));}
 assert.deepEqual(after.tables.filter(t=>t.table!=="_prisma_migrations"&&before.tables.some(b=>b.table===t.table)),before.tables.filter(t=>t.table!=="_prisma_migrations"));
 const added=after.tables.filter(t=>!before.tables.some(b=>b.table===t.table));assert.deepEqual(added.map(t=>t.table),["customer_accounts","customers","order_events","order_items","orders"]);assert(added.every(t=>t.count==="0"));report.after=after;report.status="PASSED";console.log("PASS: exactly the reviewed Orders/Customers migration applied; 12 original data tables preserved; five new tables empty; six applied migrations.");
}catch(e){report.status="FAILED";report.failure={name:e?.name,code:e?.code};process.exitCode=1;console.error("STOP: controlled local migration verification failed; inspect restricted backup audit.");}
finally{await dev.end();if(created){const current=JSON.parse(docker(["inspect",container]).toString())[0];assert.equal(current.Config.Labels["verification.run"],run);docker(["stop","--time","3",container]);docker(["rm",container]);report.restoreContainerRemoved=true;}writeFileSync(join(backup,"phase1-result.json"),JSON.stringify(report,null,2));writeFileSync(join(tmpdir(),"aafiyat-010c-phase1-summary.json"),JSON.stringify({status:report.status,run,backupId:report.backupId,backupSha256:report.backupSha256,backupRestoreVerified:report.backupRestoreVerified,migrationApplied:report.migrationApplied,restoreContainerRemoved:report.restoreContainerRemoved}));}
