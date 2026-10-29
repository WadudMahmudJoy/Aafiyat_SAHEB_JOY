import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { reconcileMediaAsset } from "../src/lib/admin-catalog-controls";

// Invoke periodically with: node --conditions=react-server --import tsx scripts/reconcile-media.ts
// Every run revisits all tombstones: a late storage write has no provable upper bound.
async function main() {
  let failures = 0;
  const claim=randomUUID();
  const rows = await prisma.$queryRaw<{id:string;productId:string}[]>`WITH picked AS (SELECT id FROM media_assets WHERE reconcile_after<=clock_timestamp() AND (state='deleted' OR (state='delete_pending' AND delete_after<=clock_timestamp()) OR (state='pending' AND created_at<clock_timestamp()-interval '24 hours')) ORDER BY reconcile_after,id FOR UPDATE SKIP LOCKED LIMIT 100) UPDATE media_assets a SET reconcile_claim_id=${claim}::uuid,reconcile_after=clock_timestamp()+interval '1 minute' FROM picked WHERE a.id=picked.id RETURNING a.id,a.product_id AS "productId"`;
  for (const row of rows) {
    try { await reconcileMediaAsset(row.productId,row.id,claim); }
    catch { failures++; }
  }
  if (failures) { console.error(`Media reconciliation: ${failures} failed; retry on the next scheduled run.`); process.exitCode=1; }
  else console.log("Media reconciliation pass completed.");
}
main().catch(()=>{console.error("Media reconciliation failed; retry on the next scheduled run.");process.exitCode=1;}).finally(()=>prisma.$disconnect());
