import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { reconcileContentAsset } from "../src/lib/admin-cms";
async function main(){const claim=randomUUID();const rows=await prisma.$queryRaw<{id:string;entry_id:string}[]>`WITH picked AS (SELECT id FROM content_assets WHERE reconcile_after<=clock_timestamp() AND (state='deleted' OR state='delete_pending' AND delete_after<=clock_timestamp() OR state='pending' AND created_at<clock_timestamp()-interval '24 hours') ORDER BY reconcile_after,id FOR UPDATE SKIP LOCKED LIMIT 100) UPDATE content_assets a SET claim_id=${claim}::uuid,reconcile_after=clock_timestamp()+interval '1 minute' FROM picked WHERE a.id=picked.id RETURNING a.id,a.entry_id`;let failed=0;for(const r of rows)try{await reconcileContentAsset(r.entry_id,r.id,claim);}catch{failed++;}if(failed){console.error("Content reconciliation has retryable failures.");process.exitCode=1;}}
main().catch(()=>{console.error("Content reconciliation unavailable.");process.exitCode=1;}).finally(()=>prisma.$disconnect());
