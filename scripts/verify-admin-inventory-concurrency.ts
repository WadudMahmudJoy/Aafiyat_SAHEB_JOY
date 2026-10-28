// Requires run-inventory-concurrency.mjs. No dotenv, transaction substitution,
// savepoints, or production edits. Only auth.api.getSession is simulated.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../src/lib/prisma";
import { auth } from "../src/lib/auth";
import { receiveStock, type ReceivingResult } from "../src/lib/admin-inventory";

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
type Input = Fixture & { quantity: string; reason: string; idempotencyKey: string };
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
    FROM stock_movements WHERE variant_id=$1 ORDER BY on_hand_before,id`, [f.variantId])).rows;
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
    assert.equal(m.actor_admin_id, actorId); assert.equal(m.movement_type, "receive");
  }
  assert.equal(data.balance.on_hand, total); assert.equal(data.balance.reserved, reserved); assert.equal(data.balance.low_stock_threshold, threshold);
  return data;
}
function call(data: Input, recovery = false) {
  const context: Context = { calls: 0, recovery };
  return { context, promise: contexts.run(context, () => receiveStock(request, data)) };
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
function privateConflict(result: ReceivingResult) {
  assert(!result.ok); assert.equal(result.code, "CONFLICT"); assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"]);
}
async function check(name: string, run: () => Promise<unknown>) {
  current = name; const started = Date.now(); const evidence = await run();
  results.push({ name, elapsedMs: Date.now() - started, evidence }); console.log(`PASS: ${name}`);
}

// Delay one genuine PostgreSQL response on a transparent localhost TCP proxy.
// No SQL, transaction API, client result, or clock is replaced. This exercises
// the service's actual 15s interactive timeout while its DB transaction is open.
async function transactionTimeout() {
  const f = await fixture(9, 2, 4);
  const before = await state(f); const sockets = new Set<import("node:net").Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let delayed = false; let pausedPid: unknown;
  const server = createServer(client => {
    sockets.add(client);
    const upstream = connect({ host: target.hostname, port: Number(target.port) }); sockets.add(upstream);
    let clientBuffer = Buffer.alloc(0); let startup = true; let buffering = false; let buffered: Buffer[] = [];
    client.on("data", chunk => {
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      if (startup && clientBuffer.length >= 4) {
        const length = clientBuffer.readInt32BE(0);
        if (clientBuffer.length < length) { upstream.write(chunk); return; }
        clientBuffer = clientBuffer.subarray(length); startup = false;
      }
      while (!startup && clientBuffer.length >= 5) {
        const length = clientBuffer.readInt32BE(1);
        if (clientBuffer.length < length + 1) break;
        const frame = clientBuffer.subarray(0, length + 1); clientBuffer = clientBuffer.subarray(length + 1);
        if (!delayed && (frame[0] === 80 || frame[0] === 81) && frame.includes(Buffer.from("SET LOCAL statement_timeout"))) {
          delayed = true; buffering = true;
          const timer = setTimeout(() => { buffering = false; for (const part of buffered) client.write(part); buffered = []; timers.delete(timer); }, 16500);
          timers.add(timer);
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", chunk => { if (buffering) buffered.push(chunk); else client.write(chunk); });
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); }); upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const proxyUrl = new URL(target); proxyUrl.port = String(address.port); proxyUrl.searchParams.set("application_name", "009d2c2v_timeout"); proxyUrl.searchParams.set("sslmode", "disable");
  const workerResultPath = process.env.INVENTORY_TEST_RESULTS! + ".timeout.json";
  const started = Date.now();
  try {
    const worker = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/verify-admin-inventory-concurrency.ts"], {
      env: { ...process.env, DATABASE_URL: proxyUrl.toString(), INVENTORY_TIMEOUT_WORKER: "1", INVENTORY_TIMEOUT_INPUT: JSON.stringify(input(f)), INVENTORY_TIMEOUT_SESSION: JSON.stringify(testSession), INVENTORY_TEST_RESULTS: workerResultPath },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let workerOutput = "";
    worker.stdout.on("data", chunk => { workerOutput += String(chunk); }); worker.stderr.on("data", chunk => { workerOutput += String(chunk); });
    const completion = new Promise<number | null>((resolve, reject) => { worker.on("exit", resolve); worker.on("error", reject); });
    const deadline = Date.now() + 10000;
    while (!delayed && Date.now() < deadline) await delay(25);
    assert(delayed, "Proxy must delay the actual service statement response");
    pausedPid = (await monitor.query("SELECT pid,state,xact_start::text FROM pg_stat_activity WHERE datname=$1 AND application_name='009d2c2v_timeout' AND xact_start IS NOT NULL", [database])).rows;
    const code = await completion;
    assert.equal(code, 0, `Timeout worker failed: ${workerOutput}`);
    const elapsedMs = Date.now() - started;
    assert(elapsedMs >= 15000 && elapsedMs < 25000);
    const { readFileSync } = await import("node:fs");
    const workerEvidence = JSON.parse(readFileSync(workerResultPath, "utf8"));
    assert.equal(workerEvidence.result.ok, false); assert.equal(workerEvidence.result.code, "UNAVAILABLE");
    assert.deepEqual(await state(f), before);
    const retry = await call(workerEvidence.input).promise; assert(retry.ok);
    return { elapsedMs, pausedPid, worker: workerEvidence, committedAfterRetry: await conserved(f, 9, [1], 2, 4) };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function verify() {
  await identity(); await fixtures();
  await check("two independent keys serialize on separate connections without losing stock or changing reserved/threshold", async () => {
    const f = await fixture(30, 7, 11); const r = await race([input(f, "8"), input(f, "13")]); assert(r.outcomes.every(o => o.ok));
    return { ...r, committed: await conserved(f, 30, [8, 13], 7, 11) };
  });
  await check("concurrent receiving initializes an absent balance exactly once", async () => {
    const f = await fixture(); assert.equal((await state(f)).balance, null);
    const r = await race([input(f, "3"), input(f, "5")]); assert(r.outcomes.every(o => o.ok));
    return { ...r, committed: await conserved(f, 0, [3, 5]) };
  });
  await check("four concurrent independent keys commit four chained movements with exact total", async () => {
    const f = await fixture(10, 2, 3); const r = await race([1, 2, 3, 4].map(n => input(f, String(n)))); assert(r.outcomes.every(o => o.ok));
    return { ...r, committed: await conserved(f, 10, [1, 2, 3, 4], 2, 3) };
  });
  await check("identical competing keys return one immutable receipt and one committed adjustment; replay preserves revision", async () => {
    const f = await fixture(); const data = input(f, "6"); const r = await race([data, data]);
    assert(r.outcomes[0].ok && r.outcomes[1].ok); assert.deepEqual(r.outcomes[0].receipt, r.outcomes[1].receipt);
    const before = await conserved(f, 0, [6]); const replay = await call(data).promise; assert(replay.ok); assert.deepEqual(replay.receipt, r.outcomes[0].receipt); assert.deepEqual(await state(f), before);
    return { ...r, replay, committed: before };
  });
  await check("same key with competing quantities or reasons produces private conflicts", async () => {
    const evidence = [];
    for (const changed of ["quantity", "reason"]) {
      const f = await fixture(0); const a = input(f, "4"); const b = { ...a, [changed]: changed === "quantity" ? "9" : "TEST changed reason" };
      const r = await race([a, b]); const winner = r.outcomes.find(o => o.ok); assert(winner?.ok);
      for (const loser of r.outcomes.filter(o => !o.ok)) privateConflict(loser);
      assert.equal(r.outcomes.filter(o => o.ok).length, 1);
      evidence.push({ ...r, committed: await conserved(f, 0, [winner.receipt.deltaOnHand]) });
    }
    return evidence;
  });
  await check("global same-key race across products triggers real unique conflict, rollback, reauthorization and private conflict", async () => {
    const a = await fixture(5, 2, 1); const b = await fixture(5, 2, 1); const key = randomUUID();
    const r = await race([input(a, "5", key), input(b, "5", key)], "balance", true);
    assert.equal(r.outcomes.filter(o => o.ok).length, 1); privateConflict(r.outcomes.find(o => !o.ok)!);
    assert.deepEqual([...r.authCalls].sort(), [1, 2]); assert.equal(recoveryObservations.length, 1);
    return { ...r, recoveryObservations, committed: await Promise.all([a, b].map(async (f, i) => conserved(f, 5, r.outcomes[i].ok ? [5] : [], 2, 1))) };
  });
  await check("actual Prisma and PostgreSQL global-constraint metadata classify only the intended uniqueness failure", async () => {
    const m = (await admin.query("SELECT * FROM stock_movements ORDER BY created_at LIMIT 1")).rows[0];
    let prismaError: unknown;
    try {
      await prisma.$transaction(tx => tx.stockMovement.create({ data: { variantId: m.variant_id, movementType: "receive", deltaOnHand: m.delta_on_hand, deltaReserved: 0,
        onHandBefore: m.on_hand_before, onHandAfter: m.on_hand_after, reservedBefore: m.reserved_before, reservedAfter: m.reserved_after,
        actorAdminId: m.actor_admin_id, reason: m.reason, idempotencyKey: m.idempotency_key, requestFingerprint: m.request_fingerprint } }));
    } catch (error) {
      const e = error as { code?: string; meta?: { modelName?: string; target?: unknown; driverAdapterError?: { cause?: { originalCode?: string; kind?: string; constraint?: { fields?: string[]; index?: string } } } } };
      const cause = e.meta?.driverAdapterError?.cause;
      const metadata = { code: e.code, modelName: e.meta?.modelName, postgresCode: cause?.originalCode,
        kind: cause?.kind, constraintIndex: cause?.constraint?.index };
      observations.push({ actualPrismaUniqueMetadata: metadata });
      assert.equal(e.code, "P2002"); assert.equal(e.meta?.modelName, "StockMovement");
      assert.equal(e.meta?.driverAdapterError?.cause?.kind, "UniqueConstraintViolation");
      assert.equal(e.meta?.driverAdapterError?.cause?.constraint?.index, "stock_movements_idempotency_key_key");
      prismaError = metadata;
    }
    assert(prismaError);
    let postgresError: unknown;
    await admin.query("BEGIN");
    try { await admin.query("INSERT INTO stock_movements(variant_id,movement_type,delta_on_hand,on_hand_before,on_hand_after,reserved_before,reserved_after,actor_admin_id,reason,idempotency_key,request_fingerprint) SELECT variant_id,movement_type,delta_on_hand,on_hand_before,on_hand_after,reserved_before,reserved_after,actor_admin_id,reason,idempotency_key,request_fingerprint FROM stock_movements WHERE id=$1", [m.id]); }
    catch (error) { const e = error as { code?: string; constraint?: string; table?: string }; assert.equal(e.code, "23505"); assert.equal(e.constraint, "stock_movements_idempotency_key_key"); postgresError = { code: e.code, constraint: e.constraint, table: e.table }; }
    finally { await admin.query("ROLLBACK"); }
    assert(postgresError); return { prismaError, postgresError };
  });
  await check("product lock waits are bounded by actual PostgreSQL 2s lock_timeout and roll back without writes", async () => {
    const f = await fixture(10, 3, 2); const before = await state(f);
    const blocker = new Client({ connectionString: adminUrl }); await blocker.connect();
    let result: ReceivingResult; const started = Date.now();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [f.productId]);
      const pending = call(input(f)); const blocked = await waiters(1); result = await pending.promise;
      const elapsedMs = Date.now() - started; assert(!result.ok); assert.equal(result.code, "UNAVAILABLE"); assert(elapsedMs >= 1800 && elapsedMs < 5000);
      assert.deepEqual(await state(f), before); return { elapsedMs, result, blocked, committed: before };
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  });
  await check("concurrent INTEGER-boundary receiving commits one valid movement and rejects overflow", async () => {
    const f = await fixture(2147483646, 1, 8); const r = await race([input(f), input(f)]);
    assert.equal(r.outcomes.filter(o => o.ok).length, 1); const failure = r.outcomes.find(o => !o.ok); assert(failure && !failure.ok); assert.equal(failure.code, "OVERFLOW");
    return { ...r, committed: await conserved(f, 2147483646, [1], 1, 8) };
  });
  await check("real ledger INSERT permission failure atomically rolls back balance update and absent-balance initialization", async () => {
    const existing = await fixture(20, 4, 6); const missing = await fixture(); const before = await Promise.all([existing, missing].map(state));
    await admin.query("REVOKE INSERT ON stock_movements FROM receiving_runtime");
    let outcomes;
    try { outcomes = await Promise.all([existing, missing].map(f => call(input(f, "7")).promise)); }
    finally { await admin.query("GRANT INSERT ON stock_movements TO receiving_runtime"); }
    for (const r of outcomes) { assert(!r.ok); assert.equal(r.code, "UNAVAILABLE"); assert(!JSON.stringify(r).includes("permission")); }
    assert.deepEqual(await Promise.all([existing, missing].map(state)), before);
    return { outcomes, committed: before };
  });
  await check("real balance UPDATE permission failure leaves neither balance adjustment nor movement", async () => {
    const f = await fixture(15, 3, 4); const before = await state(f);
    await admin.query("REVOKE UPDATE ON inventory_balances FROM receiving_runtime"); let result;
    try { result = await call(input(f)).promise; } finally { await admin.query("GRANT UPDATE ON inventory_balances TO receiving_runtime"); }
    assert(!result.ok); assert.equal(result.code, "UNAVAILABLE"); assert.deepEqual(await state(f), before); return { result, committed: before };
  });
  await check("actual service interactive timeout under delayed database response rolls back and permits same-key retry", transactionTimeout);
  await check("discarded client response after confirmed commit is recovered by same-key retry", async () => {
    const f = await fixture(2, 1, 3); const data = input(f, "8");
    const committed = await call(data).promise; assert(committed.ok);
    // Deliberately lose only the client-visible response after successful commit.
    const before = await state(f); const retry = await call(data).promise;
    assert(retry.ok); assert.deepEqual(retry.receipt, committed.receipt); assert.deepEqual(await state(f), before);
    return { simulation: "Response discarded after service returned a confirmed commit; not all network failure modes", retry, committed: await conserved(f, 2, [8], 1, 3) };
  });
  assert.equal(prisma.$transaction, transactionReference);
  const totals = (await admin.query("SELECT (SELECT count(*)::int FROM stock_movements) AS movements,(SELECT count(*)::int FROM inventory_balances) AS balances,(SELECT sum(delta_on_hand)::text FROM stock_movements) AS received,(SELECT count(*)::int FROM stock_movements WHERE on_hand_after::bigint<>on_hand_before::bigint+delta_on_hand::bigint OR reserved_before<>reserved_after) AS invalid_movements")).rows[0];
  assert.equal(totals.invalid_movements, 0);
  return { status: "PASSED", cases: results, concurrentObservations: observations, totals, authentication: "Only auth.api.getSession simulated. Membership, role, stored-session binding and MFA queries use real isolated DB.", transactions: "Original shared Prisma $transaction untouched; real BEGIN/COMMIT/ROLLBACK on separate connections; no savepoints" };
}

async function timeoutWorker() {
  await identity();
  const parsed = JSON.parse(process.env.INVENTORY_TIMEOUT_SESSION!);
  parsed.session.createdAt = new Date(parsed.session.createdAt); parsed.session.expiresAt = new Date(parsed.session.expiresAt);
  await installAuthentication(parsed);
  const data = JSON.parse(process.env.INVENTORY_TIMEOUT_INPUT!) as Input;
  const started = Date.now(); const result = await call(data).promise;
  assert.equal(prisma.$transaction, transactionReference);
  return { result, elapsedMs: Date.now() - started, input: data };
}
const work = process.env.INVENTORY_TIMEOUT_WORKER ? timeoutWorker : verify;
work().then(report => writeFileSync(process.env.INVENTORY_TEST_RESULTS!, JSON.stringify(report, null, 2) + "\n"))
  .catch(error => {
    writeFileSync(process.env.INVENTORY_TEST_RESULTS!, JSON.stringify({ status: "FAILED", failedAt: current, error: { name: error?.name, code: error?.code }, cases: results, concurrentObservations: observations }, null, 2) + "\n");
    console.error(`FAIL: ${current}; ${error?.name ?? "unknown"}; details in isolated evidence`); process.exitCode = 1;
  }).finally(async () => { Reflect.set(auth.api, "getSession", originalSession); await prisma.$disconnect(); await admin.end(); await monitor.end(); });
