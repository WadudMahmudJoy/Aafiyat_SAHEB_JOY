// Requires run-inventory-concurrency.mjs. No dotenv, transaction substitution,
// savepoints, or production edits. Only auth.api.getSession is simulated.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { getInventoryOverview, getInventoryDetail } from "../src/lib/admin-inventory-read";
import { dashboardAreas } from "../src/lib/admin-dashboard";
import type { InventoryActionState } from "../src/lib/inventory-action-state";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, rmSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";
import { symmetricEncrypt } from "better-auth/crypto";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { receiveStock, correctStock, type ReceivingResult } from "../src/lib/admin-inventory";

const { Client } = createRequire(import.meta.url)("pg");
const adminUrl = process.env.INVENTORY_TEST_ADMIN_URL!;
const database = process.env.INVENTORY_TEST_DATABASE!;
const runId = process.env.INVENTORY_TEST_RUN!;
const target = new URL(process.env.DATABASE_URL!);
assert.match(database, /^receive_verify_[0-9a-f]{32}$/);
assert.equal(target.hostname, "127.0.0.1"); assert.notEqual(target.port, "55432"); assert.equal(target.pathname, `/${database}`);
assert.equal(new URL(adminUrl).pathname, target.pathname);
const admin = new Client({ connectionString: adminUrl });
const monitor = new Client({ connectionString: adminUrl });
type Fixture = { productId: string; variantId: string };
type Input = Fixture & ({ quantity: string } | { targetOnHand: string; expectedRevision: string }) & { reason: string; idempotencyKey: string };
type TestSession = { session: { id: string; userId: string; token: string; createdAt: Date; expiresAt: Date }; user: { id: string } };
type Context = { calls: number; recovery: boolean };
const contexts = new AsyncLocalStorage<Context>();
let testSession: TestSession;
let actorId: string;
let categoryId: string;
const recoveryObservations: unknown[] = [];
const observations: unknown[] = [];
const results: { name: string; elapsedMs: number; evidence: unknown }[] = [];
let current = "isolated identity";
const transactionReference = prisma.$transaction;
const originalSession = auth.api.getSession;
const request = new Headers({ origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" });
const input = (fixture: Fixture, quantity = "1", key = randomUUID(), reason = "TEST isolated receiving"): Input => ({ ...fixture, quantity, idempotencyKey: key, reason });

async function identity() {
  await admin.connect(); await monitor.connect();
  const row = (await admin.query("SELECT current_database() AS db, current_setting('server_version_num') AS version")).rows[0];
  assert.equal(row.db, database); assert.equal(row.version, "180006");
  const [runtime] = await prisma.$queryRaw<{ db: string; role: string; ledgerUpdate: boolean; ledgerInsert: boolean }[]>`
    SELECT current_database() AS db, current_user AS role,
      has_table_privilege(current_user, 'stock_movements', 'UPDATE') AS "ledgerUpdate",
      has_table_privilege(current_user, 'stock_movements', 'INSERT') AS "ledgerInsert"`;
  assert.equal(runtime.db, database); assert.equal(runtime.role, "receiving_runtime");
  assert.equal(runtime.ledgerUpdate, false); assert.equal(runtime.ledgerInsert, true);
}
async function installAuthentication(session: TestSession) {
  testSession = session;
  Reflect.set(auth.api, "getSession", async (args: { query: unknown }) => {
    assert.deepEqual(args.query, { disableCookieCache: true, disableRefresh: true });
    const context = contexts.getStore();
    if (context) {
      context.calls++;
      if (context.recovery && context.calls > 1) {
        const rows = (await monitor.query("SELECT pid, state, xact_start::text, backend_xid::text FROM pg_stat_activity WHERE datname=$1 AND usename='receiving_runtime' ORDER BY pid", [database])).rows;
        recoveryObservations.push(rows);
        assert(rows.every((r: { xact_start: string | null }) => r.xact_start === null), "Recovery authorization must occur after all racing transactions have ended");
      }
    }
    return testSession;
  });
}
async function fixtures() {
  const now = new Date();
  testSession = { session: { id: randomUUID(), userId: randomUUID(), token: randomUUID(), createdAt: now, expiresAt: new Date(Date.now() + 3600000) }, user: { id: "" } };
  testSession.user.id = testSession.session.userId;
  actorId = randomUUID(); categoryId = randomUUID();
  const roleId = (await admin.query("SELECT id FROM admin_roles WHERE name='OWNER'")).rows[0].id;
  await admin.query("INSERT INTO categories(id,name,slug) VALUES($1,'TEST isolated category',$2)", [categoryId, `test-${runId}`]);
  await admin.query('INSERT INTO auth_users(id,name,email,"twoFactorEnabled","updatedAt") VALUES($1,\'TEST isolated operator\',$2,true,$3)', [testSession.user.id, `${runId}@example.invalid`, now]);
  await admin.query("INSERT INTO admin_users(id,user_id,role_id,active) VALUES($1,$2,$3,true)", [actorId, testSession.user.id, roleId]);
  await admin.query('INSERT INTO auth_sessions(id,"userId",token,"createdAt","updatedAt","expiresAt",mfa_verified_at) VALUES($1,$2,$3,$4,$4,$5,$4)', [testSession.session.id, testSession.user.id, testSession.session.token, now, testSession.session.expiresAt]);
  await admin.query('INSERT INTO auth_two_factors(id,secret,"backupCodes","userId",verified) VALUES($1,\'TEST-ONLY-NOT-A-REAL-SECRET\',\'[]\',$2,true)', [randomUUID(), testSession.user.id]);
  await installAuthentication(testSession);
}
async function fixture(onHand?: number, reserved = 0, threshold: number | null = null): Promise<Fixture> {
  const productId = randomUUID(); const variantId = randomUUID();
  await admin.query("INSERT INTO products(id,category_id,name,slug,description,lifecycle) VALUES($1,$2,'TEST isolated product',$3,'Disposable verification only','active')", [productId, categoryId, `test-${productId}`]);
  await admin.query("INSERT INTO product_variants(id,product_id,sku,size_code,size_label,color_code,color_label,price_minor) VALUES($1,$2,$3,'test','TEST','test','TEST',0)", [variantId, productId, `TEST-${variantId.toUpperCase()}`]);
  if (onHand !== undefined) await admin.query("INSERT INTO inventory_balances(variant_id,on_hand,reserved,low_stock_threshold) VALUES($1,$2,$3,$4)", [variantId, onHand, reserved, threshold]);
  return { productId, variantId };
}
async function state(f: Fixture) {
  const balance = (await admin.query(`SELECT variant_id, on_hand, reserved, low_stock_threshold,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision
    FROM inventory_balances WHERE variant_id=$1`, [f.variantId])).rows[0] ?? null;
  const movements = (await admin.query(`SELECT id, variant_id, movement_type, delta_on_hand, delta_reserved,
    on_hand_before,on_hand_after,reserved_before,reserved_after,actor_admin_id,reason,idempotency_key,request_fingerprint,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM stock_movements WHERE variant_id=$1 ORDER BY created_at,id`, [f.variantId])).rows;
  return { balance, movements };
}
async function conserved(f: Fixture, initial: number, quantities: number[], reserved = 0, threshold: number | null = null) {
  const data = await state(f);
  assert(data.balance); assert.equal(data.movements.length, quantities.length);
  assert.deepEqual(data.movements.map((m: { delta_on_hand: number }) => m.delta_on_hand).sort((a: number, b: number) => a - b), [...quantities].sort((a, b) => a - b));
  let total = initial;
  for (const m of data.movements) {
    assert.equal(m.on_hand_before, total); total += m.delta_on_hand;
    assert.equal(m.on_hand_after, total); assert.equal(m.delta_reserved, 0);
    assert.equal(m.reserved_before, reserved); assert.equal(m.reserved_after, reserved);
    assert.equal(m.actor_admin_id, actorId); assert(["receive", "correction"].includes(m.movement_type));
  }
  assert.equal(data.balance.on_hand, total); assert.equal(data.balance.reserved, reserved); assert.equal(data.balance.low_stock_threshold, threshold);
  return data;
}
function call(data: Input, recovery = false) {
  const context: Context = { calls: 0, recovery };
  return { context, promise: contexts.run(context, () => "targetOnHand" in data ? correctStock(request, data) : receiveStock(request, data)) };
}
async function waiters(count: number) {
  const deadline = Date.now() + 1400;
  while (Date.now() < deadline) {
    const rows = (await monitor.query(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,xact_start::text
      FROM pg_stat_activity WHERE datname=$1 AND usename='receiving_runtime' AND wait_event_type='Lock' ORDER BY pid`, [database])).rows;
    if (rows.length >= count) { assert.equal(new Set(rows.map((r: { pid: number }) => r.pid)).size, rows.length); observations.push(rows); return rows; }
    await delay(20);
  }
  throw new Error(`Expected ${count} genuinely concurrent waiting PostgreSQL connections`);
}
async function race(data: Input[], lock: "product" | "balance" = "product", recovery = false) {
  const blocker = new Client({ connectionString: adminUrl }); await blocker.connect();
  const pending: ReturnType<typeof call>[] = [];
  try {
    await blocker.query("BEGIN");
    const ids = [...new Set(data.map(d => lock === "product" ? d.productId : d.variantId))].sort();
    const table = lock === "product" ? "products" : "inventory_balances";
    const column = lock === "product" ? "id" : "variant_id";
    await blocker.query(`SELECT ${column} FROM ${table} WHERE ${column}=ANY($1::uuid[]) ORDER BY ${column} FOR UPDATE`, [ids]);
    for (const d of data) pending.push(call(d, recovery));
    const blocked = await waiters(data.length);
    await blocker.query("COMMIT");
    const outcomes = await Promise.all(pending.map(p => p.promise));
    return { outcomes, blocked, authCalls: pending.map(p => p.context.calls) };
  } catch (error) {
    await blocker.query("ROLLBACK");
    observations.push({ harnessRaceFailure: { outcomes: await Promise.all(pending.map(p => p.promise)), authCalls: pending.map(p => p.context.calls) } });
    throw error;
  } finally { await blocker.query("ROLLBACK").catch(() => {}); await blocker.end(); await Promise.allSettled(pending.map(p => p.promise)); }
}
function privateConflict(result: ReceivingResult | Awaited<ReturnType<typeof correctStock>>) {
  assert(!result.ok); assert.equal(result.code, "CONFLICT"); assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"]);
}
async function check(name: string, run: () => Promise<unknown>) {
  current = name; const started = Date.now(); const evidence = await run();
  results.push({ name, elapsedMs: Date.now() - started, evidence }); console.log(`PASS: ${name}`);
}

const counted = (f: Fixture, targetOnHand: string, expectedRevision: string, key = randomUUID()): Input => ({ ...f, targetOnHand, expectedRevision, idempotencyKey: key, reason: "TEST isolated physical count" });
async function revision(f: Fixture): Promise<string> { return (await state(f)).balance?.revision ?? "missing"; }
async function verify() {
  await identity(); await fixtures();
  await check("two corrections with one revision and independent keys commit one and reject stale loser", async () => {
    const f = await fixture(20, 3, 7); const rev = await revision(f);
    const r = await race([counted(f, "12", rev), counted(f, "30", rev)]);
    assert.equal(r.outcomes.filter(o => o.ok).length, 1); privateConflict(r.outcomes.find(o => !o.ok)!);
    const winner = r.outcomes.find(o => o.ok); assert(winner?.ok);
    return { ...r, committed: await conserved(f, 20, [winner.receipt.deltaOnHand], 3, 7) };
  });
  await check("correction racing with receiving serializes and cannot overwrite a newer received balance", async () => {
    const f = await fixture(20, 3, 7); const rev = await revision(f);
    const r = await race([counted(f, "12", rev), input(f, "5")]); assert(r.outcomes[1].ok);
    if (r.outcomes[0].ok) return { ...r, committed: await conserved(f, 20, [-8, 5], 3, 7) };
    privateConflict(r.outcomes[0]); return { ...r, committed: await conserved(f, 20, [5], 3, 7) };
  });
  await check("two corrections against missing balance initialize exactly once and reject stale missing state", async () => {
    const f = await fixture(); const r = await race([counted(f, "4", "missing"), counted(f, "9", "missing")]);
    assert.equal(r.outcomes.filter(o => o.ok).length, 1); privateConflict(r.outcomes.find(o => !o.ok)!);
    const winner = r.outcomes.find(o => o.ok); assert(winner?.ok);
    return { ...r, committed: await conserved(f, 0, [winner.receipt.deltaOnHand]) };
  });
  await check("concurrent identical correction key returns original receipt once even after revision changes", async () => {
    const f = await fixture(10); const data = counted(f, "6", await revision(f)); const r = await race([data, data]);
    assert(r.outcomes[0].ok && r.outcomes[1].ok); assert.deepEqual(r.outcomes[0].receipt, r.outcomes[1].receipt);
    const before = await state(f); const replay = await call(data).promise; assert(replay.ok); assert.deepEqual(replay.receipt, r.outcomes[0].receipt); assert.deepEqual(await state(f), before);
    return { ...r, committed: await conserved(f, 10, [-4]) };
  });
  await check("cross-operation global key collision rolls back loser before authorized conflict recovery", async () => {
    const a = await fixture(10, 2, 4); const b = await fixture(10, 2, 4); const key = randomUUID();
    const r = await race([counted(a, "6", await revision(a), key), input(b, "3", key)], "balance", true);
    assert.equal(r.outcomes.filter(o => o.ok).length, 1); privateConflict(r.outcomes.find(o => !o.ok)!);
    assert.deepEqual([...r.authCalls].sort(), [1, 2]);
    return { ...r, recoveryObservations, committed: [await conserved(a, 10, r.outcomes[0].ok ? [-4] : [], 2, 4), await conserved(b, 10, r.outcomes[1].ok ? [3] : [], 2, 4)] };
  });
  await check("stale revision after committed receiving rejects correction without changing revision", async () => {
    const f = await fixture(10, 2, 4); const rev = await revision(f); assert((await call(input(f, "2")).promise).ok);
    const before = await state(f); privateConflict(await call(counted(f, "5", rev)).promise); assert.deepEqual(await state(f), before); return before;
  });
  await check("positive then negative corrections chain exact snapshots and preserve reservations and threshold", async () => {
    const f = await fixture(10, 2, 4);
    assert((await call(counted(f, "20", await revision(f))).promise).ok);
    assert((await call(counted(f, "2", await revision(f))).promise).ok);
    return conserved(f, 10, [10, -18], 2, 4);
  });
  await check("ledger insertion failure rolls back existing balance and missing balance initialization", async () => {
    const a = await fixture(10, 2, 4); const b = await fixture(); const before = await Promise.all([a, b].map(state));
    const requests = [counted(a, "5", await revision(a)), counted(b, "5", "missing")];
    await admin.query("REVOKE INSERT ON stock_movements FROM receiving_runtime"); let outcomes;
    try { outcomes = await Promise.all(requests.map(d => call(d).promise)); } finally { await admin.query("GRANT INSERT ON stock_movements TO receiving_runtime"); }
    for (const result of outcomes) { assert(!result.ok); assert.equal(result.code, "UNAVAILABLE"); }
    assert.deepEqual(await Promise.all([a, b].map(state)), before); return { outcomes, committed: before };
  });
  await check("correction product lock timeout is bounded and leaves no stock or movement changes", async () => {
    const f = await fixture(10, 2, 4); const data = counted(f, "5", await revision(f)); const before = await state(f);
    const blocker = new Client({ connectionString: adminUrl }); await blocker.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [f.productId]);
      const started = Date.now(); const pending = call(data); const blocked = await waiters(1); const result = await pending.promise;
      const elapsedMs = Date.now() - started; assert(!result.ok); assert.equal(result.code, "UNAVAILABLE"); assert(elapsedMs >= 1800 && elapsedMs < 5000);
      assert.deepEqual(await state(f), before); return { result, elapsedMs, blocked, committed: before };
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  });
  await check("inventory reads enforce inventory permission, fresh MFA and bounded filter validation", async () => {
    const originalRole = (await admin.query("SELECT role_id FROM admin_users WHERE id=$1", [actorId])).rows[0].role_id;
    for (const name of ["ORDER_MANAGER", "MARKETING_MANAGER"]) {
      const role = (await admin.query("SELECT id FROM admin_roles WHERE name=$1", [name])).rows[0].id;
      await admin.query("UPDATE admin_users SET role_id=$1 WHERE id=$2", [role, actorId]);
      await assert.rejects(getInventoryOverview(request), (e: unknown) => (e as { reason?: string }).reason === "PERMISSION_DENIED");
      await assert.rejects(getInventoryDetail(request, randomUUID())); assert(!dashboardAreas(name).some(a => a.id === "inventory"));
    }
    await admin.query("UPDATE admin_users SET role_id=$1 WHERE id=$2", [originalRole, actorId]);
    await admin.query("UPDATE auth_sessions SET mfa_verified_at=NULL WHERE id=$1", [testSession.session.id]);
    await assert.rejects(getInventoryOverview(request));
    await admin.query("UPDATE auth_sessions SET mfa_verified_at=$1 WHERE id=$2", [testSession.session.createdAt, testSession.session.id]);
    for (const filters of [{ search: ["repeated"] }, { search: "x".repeat(101) }, { cursor: "bad" }]) await assert.rejects(getInventoryOverview(request, filters));
    assert(dashboardAreas("OWNER").some(a => a.id === "inventory" && a.href === "/admin/inventory"));
    return { deniedRoles: ["ORDER_MANAGER", "MARKETING_MANAGER"], staleMfaDenied: true };
  });
  await check("inventory overview searches product/SKU/category/IDs and paginates without overlap", async () => {
    const f = await fixture(4, 2, 3);
    for (let i = 0; i < 27; i++) await admin.query("INSERT INTO product_variants(id,product_id,sku,size_code,size_label,color_code,color_label,price_minor) VALUES($1,$2,$3,$4,'TEST','test','TEST',0)", [randomUUID(), f.productId, `PAGED-A1-${runId.toUpperCase()}-${i}`, `size-${i}`]);
    const a = await getInventoryOverview(request, { search: `PAGED-A1-${runId}` }); assert.equal(a.items.length, 25); assert(a.nextCursor);
    const b = await getInventoryOverview(request, { search: `PAGED-A1-${runId}`, cursor: a.nextCursor }); assert.equal(b.items.length, 2); assert.equal(b.nextCursor, null);
    assert(!b.items.some(v => a.items.some(x => x.variantId === v.variantId)));
    const detail = await getInventoryDetail(request, f.variantId); assert.equal(detail.variant.available, 2); assert.equal(detail.variant.threshold, 3); assert.match(detail.variant.revision, /\.\d{6}Z$/);
    for (const search of [f.variantId, detail.variant.sku, "TEST isolated category"]) assert((await getInventoryOverview(request, { search })).items.length > 0);
    assert.equal((await getInventoryOverview(request, { search: "nonexistent%_" })).items.length, 0);
    const absent = await getInventoryDetail(request, a.items[0].variantId); assert.equal(absent.variant.onHand, null); assert.equal(absent.variant.revision, "missing");
    return { firstPage: a.items.length, secondPage: b.items.length, exactRevision: detail.variant.revision };
  });
  await check("movement history has bound microsecond tuple pagination and exact immutable snapshots", async () => {
    const f = await fixture(0); for (let i = 0; i < 23; i++) assert((await call(input(f)).promise).ok);
    const a = await getInventoryDetail(request, f.variantId); assert.equal(a.movements.length, 20); assert(a.nextCursor);
    const b = await getInventoryDetail(request, f.variantId, a.nextCursor); assert.equal(b.movements.length, 3); assert.equal(b.nextCursor, null);
    assert(!b.movements.some(m => a.movements.some(x => x.id === m.id)));
    for (const m of [...a.movements, ...b.movements]) { assert.equal(m.onHandAfter, m.onHandBefore + 1); assert.equal(m.actor, "TEST isolated operator"); assert.match(m.createdAt, /\.\d{6}Z$/); }
    const other = await fixture(); assert.equal((await getInventoryDetail(request, other.variantId, a.nextCursor)).movements.length, 0);
    return { firstPage: 20, olderPage: 3, current: a.variant.onHand };
  });
  await check("thin Server Actions retain duplicates, enforce real guards, preserve same-key replay and revalidate fixed views", async () => {
    const compiled = { exports: {} as { receiveStockAction: (state: InventoryActionState, form: FormData) => Promise<InventoryActionState>; correctStockAction: (state: InventoryActionState, form: FormData) => Promise<InventoryActionState> } };
    const invalidated = new Set<string>(); let currentHeaders = request;
    runInNewContext(ts.transpile(readFileSync("src/app/admin/inventory/actions.ts", "utf8"), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), {
      module: compiled, exports: compiled.exports, FormData,
      require: (name: string) => name === "next/headers" ? { headers: async () => currentHeaders } : name === "next/cache" ? { revalidatePath: (path: string) => invalidated.add(path) } : name === "@/lib/admin-inventory" ? { receiveStock, correctStock } : createRequire(import.meta.url)(name),
    });
    const f = await fixture(10, 2, 3); const values = input(f, "3"); const form = (data: Input) => { const result = new FormData(); for (const [k, v] of Object.entries(data)) result.append(k, v); return result; };
    const idle: InventoryActionState = { status: "idle", message: "" };
    const good = form(values); good.append("$ACTION_ID_test", "transport");
    const a = await compiled.exports.receiveStockAction(idle, good); assert.equal(a.status, "saved");
    const retry = await compiled.exports.receiveStockAction(idle, good); assert.deepEqual(retry.receipt, a.receipt);
    const before = await state(f);
    for (const key of ["quantity", "actorAdminId"]) { const bad = form(values); bad.append(key, "3"); assert.equal((await compiled.exports.receiveStockAction(idle, bad)).status, "error"); }
    currentHeaders = new Headers({ origin: "https://evil.invalid" }); assert.equal((await compiled.exports.receiveStockAction(idle, form(input(f)))).status, "error"); currentHeaders = request;
    assert.deepEqual(await state(f), before);
    const correction = counted(f, "8", await revision(f)); const c = await compiled.exports.correctStockAction(idle, form(correction)); assert.equal(c.status, "saved");
    assert.equal((await compiled.exports.correctStockAction(idle, form(correction))).receipt?.id, c.receipt?.id);
    assert.equal((await compiled.exports.correctStockAction(idle, form(counted(f, "9", "missing")))).code, "CONFLICT");
    for (const path of ["/admin/inventory", `/admin/inventory/${f.variantId}`, "/admin/products", `/admin/products/${f.productId}`]) assert(invalidated.has(path));
    return { revalidated: [...invalidated], committed: await conserved(f, 10, [3, -5], 2, 3) };
  });
  if (process.env.INVENTORY_VERIFY_BROWSER === "1") await check("isolated authenticated inventory browser flows", browserFixture);
  assert.equal(prisma.$transaction, transactionReference);
  return { status: "PASSED", cases: results, concurrentObservations: observations, authentication: "Only session lookup simulated; DB-backed membership/session/MFA checks and original Prisma transactions", transactions: "Real distinct connections, no savepoints" };
}
async function browserFixture() {
  const email = `${randomUUID()}@example.invalid`; const password = `TEST-${randomUUID()}-Aa!`;
  const userId = randomUUID(); const secret = randomUUID().replaceAll("-", "");
  const context = await auth.$context;
  const hash = await context.password.hash(password);
  const owner = (await admin.query("SELECT id FROM admin_roles WHERE name='OWNER'")).rows[0].id;
  await admin.query('INSERT INTO auth_users(id,name,email,"twoFactorEnabled","updatedAt") VALUES($1,\'TEST browser operator\',$2,true,clock_timestamp())', [userId, email]);
  await admin.query('INSERT INTO auth_accounts(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,\'credential\',$2,$3,clock_timestamp())', [randomUUID(), userId, hash]);
  await admin.query("INSERT INTO admin_users(user_id,role_id,active) VALUES($1,$2,true)", [userId, owner]);
  await admin.query('INSERT INTO auth_two_factors(id,secret,"backupCodes","userId",verified) VALUES($1,$2,$3,$4,true)', [randomUUID(), await symmetricEncrypt({ key: context.secretConfig, data: secret }), await symmetricEncrypt({ key: context.secretConfig, data: "[]" }), userId]);
  await admin.query("GRANT INSERT, UPDATE, DELETE ON auth_sessions,auth_verifications,auth_two_factors,auth_users,auth_accounts TO receiving_runtime");
  const f = await fixture(10, 2, 3);
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object"); const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const generatedTypes = readFileSync("next-env.d.ts");
  const typescriptConfig = readFileSync("tsconfig.json");
  const child = spawn(process.execPath, [resolve("scripts/inventory-test-server.mjs"), String(port)], {
    env: { ...process.env, AAFIYAT_INVENTORY_TEST_RUN: runId, BETTER_AUTH_URL: origin, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  // Test-only credentials stay in the OS temporary directory, outside Git.
  const ready = process.env.INVENTORY_TEST_RESULTS! + ".browser-ready.json";
  const finished = process.env.INVENTORY_TEST_RESULTS! + ".browser-finished.json";
  try {
    let booted = false;
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
    for (let i = 0; i < 25; i++) { if (child.exitCode !== null) break; try { const r = await fetch(`${origin}/admin/login`, { signal: AbortSignal.timeout(5000) }); if (r.ok) { booted = true; break; } } catch {} await delay(500); }
    assert(booted, "Disposable Next dev server did not boot");
    writeFileSync(ready, JSON.stringify({ origin, email, password, secret, userId, ...f, finished }), { mode: 0o600 });
    console.log(`BROWSER_READY ${ready}`);
    for (let i = 0; i < 1440 && !existsSync(finished); i++) await delay(500);
    assert(existsSync(finished), "Browser verification completion missing");
    const evidence = JSON.parse(readFileSync(finished, "utf8")); assert.equal(evidence.status, "PASSED");
    const proof = (await admin.query('SELECT mfa_verified_at IS NOT NULL AS verified FROM auth_sessions WHERE "userId"=$1', [userId])).rows;
    assert(proof.some((p: { verified: boolean }) => p.verified));
    const committed = await state(f); assert.equal(committed.balance.on_hand, 10); assert.equal(committed.movements.length, 3);
    return { browser: evidence, actualMfaProof: true, committed };
  } finally {
    // Only this child is stopped; Docker cleanup remains owned by the controller.
    if (child.pid) {
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
    if (existsSync(ready)) unlinkSync(ready);
    writeFileSync("next-env.d.ts", generatedTypes);
    writeFileSync("tsconfig.json", typescriptConfig);
    const output = resolve(`.local/inventory-a1-build-${runId}`); const localRoot = resolve(".local");
    assert(output.startsWith(localRoot + sep) && output === resolve(localRoot, `inventory-a1-build-${runId}`));
    if (existsSync(output)) { assert(!lstatSync(output).isSymbolicLink()); rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); }
  }
}
verify().then(report => writeFileSync(process.env.INVENTORY_TEST_RESULTS!, JSON.stringify(report, null, 2)))
  .catch(error => { writeFileSync(process.env.INVENTORY_TEST_RESULTS!, JSON.stringify({ status: "FAILED", failedAt: current, category: error?.name, code: error?.code, cases: results, observations }, null, 2)); console.error(`FAIL: ${current}`); process.exitCode = 1; })
  .finally(async () => { Reflect.set(auth.api, "getSession", originalSession); await prisma.$disconnect(); await admin.end(); await monitor.end(); });
