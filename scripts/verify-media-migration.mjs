// Supplemental rollback probe against an already verified task-owned container.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const [container,run]=process.argv.slice(2);
assert.match(run,/^[0-9a-f-]{36}$/);assert.equal(container,`aafiyat-media-010c-${run}`);
const inspected=spawnSync("docker",["inspect",container],{encoding:"utf8",windowsHide:true});assert.equal(inspected.status,0);
const info=JSON.parse(inspected.stdout)[0];assert.equal(info.Config.Labels["verification.run"],run);
const database=`receive_verify_${run.replaceAll("-","")}`;
assert(info.Config.Env.includes(`POSTGRES_DB=${database}`));assert(info.Mounts.every(m=>m.Type==="tmpfs"));
function sql(input){const r=spawnSync("docker",["exec","-i",container,"psql","-X","-U","postgres","-d",database,"-v","ON_ERROR_STOP=1","-qAt"],{input,encoding:"utf8",windowsHide:true,maxBuffer:4*1024*1024});if(r.status!==0)throw new Error("Isolated migration rollback probe failed; raw SQL diagnostics withheld");return r.stdout.trim();}
assert.equal(sql("SELECT current_database() || ':' || current_setting('server_version_num');"),database+":180006");
const tables=["media_assets","product_media","product_lifecycle_events"];
const fingerprint=tables.map(t=>`SELECT '${t}:' || count(*)::text || ':' || md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) FROM ${t} t;`).join("\n");
const before=sql(fingerprint);
sql(`BEGIN;
 DROP TABLE product_media,media_assets,product_lifecycle_events CASCADE;
 DROP TRIGGER product_transition_guard ON products;
 DROP FUNCTION IF EXISTS guard_media_asset(),guard_product_media(),check_gallery_shape(),guard_product_transition(),protect_product_event() CASCADE;
 ${readFileSync("prisma/migrations/20261029000000_add_product_media_lifecycle/migration.sql","utf8").replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, "")}
 SELECT count(*) FROM media_assets;
 ROLLBACK;`);
assert.equal(sql(fingerprint),before);
console.log("PASS: additive migration recreation rolled back; all three isolated table fingerprints restored.");
