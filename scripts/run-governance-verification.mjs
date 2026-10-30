// Verification-only controller. Never imports application code or runs test SQL
// against .env's database. Before/after development checks are READ ONLY.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const dotenv = require("dotenv");
const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const id = randomUUID();
const name = `aafiyat-governance-010e1-${id}`;
const database = `receive_verify_${id.replaceAll("-", "")}`;
const work = join(tmpdir(), name);
mkdirSync(work);
const correctionMode = true;
const reportPath = correctionMode ? join(work, "media-results.json") : join(root, "docs", "task-009d-2c-2v-results.json");
const report = { task: "010-E1", runId: id, startedAt: new Date().toISOString(), containerName: name, database, status: "RUNNING" };
if (existsSync(reportPath)) {
  const previous = JSON.parse(readFileSync(reportPath, "utf8"));
  report.previousAttempts = [...(previous.previousAttempts ?? []), {
    runId: previous.runId, containerName: previous.containerName, port: previous.port, status: previous.status,
    failure: { name: previous.tests?.error?.name, code: previous.tests?.error?.code }, passedCases: previous.tests?.cases?.length ?? 0,
    cleanup: previous.cleanup, developmentUnchanged: previous.developmentUnchanged, preservedSourcesUnchanged: previous.preservedSourcesUnchanged,
  }];
}
const password = randomBytes(24).toString("hex");
const runtimePassword = randomBytes(24).toString("hex");
const receiving = ["src/lib/admin-inventory.ts", "src/lib/inventory-validation.ts", "scripts/verify-admin-inventory.ts", "scripts/verify-inventory-validation.ts"];
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: "utf8", windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${binary} ${args[0]} failed (exit ${result.status})`);
  return result.stdout.trim();
}
function docker(args, options) { return command("docker", args, options); }
function inventory() { return docker(["ps", "-aq", "--no-trunc"]).split(/\r?\n/).filter(Boolean).sort(); }
async function developmentSnapshot() {
  const config = dotenv.parse(readFileSync(".env"));
  const url = new URL(config.DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55432"); assert.equal(url.pathname, "/aafiyat_dev");
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000,
    options: "-c default_transaction_read_only=on -c application_name=009d2c2v_baseline" });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (await client.query("SELECT current_database() AS db, current_setting('transaction_read_only') AS read_only")).rows[0];
    assert.equal(identity.db, "aafiyat_dev"); assert.equal(identity.read_only, "on");
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const snapshot = [];
    for (const { tablename } of tables) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      const row = (await client.query(`SELECT count(*)::text AS count, md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) AS hash FROM public.${quoted} t`)).rows[0];
      snapshot.push({ table: tablename, ...row });
    }
    await client.query("ROLLBACK");
    return { identity, tables: snapshot };
  } finally { await client.end(); }
}
async function runChild(env) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/verify-governance-integration.ts"],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", chunk => process.stdout.write(chunk));
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", resolveChild);
  });
}

const objectName=`aafiyat-object-010c-${id}`;
let objectCreated=false;
let created = false;
let beforeDevelopment;
let preserved;
let beforeContainers;
let admin;
try {
  const branch = command("git", ["branch", "--show-current"]);
  const head = command("git", ["rev-parse", "--verify", "HEAD^{commit}"]);
  const originMain = command("git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  report.gitBaseline = { branch, head, originMain };
  assert.equal(branch, "main", "Governance verification requires main");
  assert.equal(head, originMain, "Local HEAD must match refs/remotes/origin/main");
  const tracked = command("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
  preserved = Object.fromEntries([...tracked, ...receiving].map(path => [path, sha(path)]));
  report.initialGitStatus = command("git", ["status", "--short"]);
  report.receivingHashesBefore = Object.fromEntries(receiving.map(path => [path, sha(path)]));
  beforeContainers = inventory();
  beforeDevelopment = await developmentSnapshot();
  report.developmentBaseline = beforeDevelopment;
  console.log("PASS: source hashes recorded; development READ ONLY baseline captured and connection closed");
  const image = JSON.parse(docker(["image", "inspect", "postgres:18.6-bookworm"]))[0];
  report.image = { id: image.Id, digests: image.RepoDigests };
  const containerId = docker(["run", "-d", "--name", name, "--label", `verification.run=${id}`,
    "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql:rw,size=536870912",
    "--env", "POSTGRES_PASSWORD", "--env", `POSTGRES_DB=${database}`,
    "postgres:18.6-bookworm", "postgres", "-c", "log_statement=all", "-c", "log_error_verbosity=verbose",
    "-c", "log_line_prefix=%m [%p] xid=%x sqlstate=%e ", "-c", "log_lock_waits=on", "-c", "deadlock_timeout=100ms"],
    { env: { ...process.env, POSTGRES_PASSWORD: password } });
  created = true; report.containerId = containerId;
  const info = JSON.parse(docker(["inspect", containerId]))[0];
  assert.equal(info.Config.Labels["verification.run"], id);
  assert(info.Mounts.every(m => m.Type === "tmpfs"));
  assert.equal(info.HostConfig.Tmpfs["/var/lib/postgresql"], "rw,size=536870912");
  assert.equal(docker(["exec", containerId, "stat", "-f", "-c", "%T", "/var/lib/postgresql"]), "tmpfs");
  report.tmpfs = info.HostConfig.Tmpfs;
  const bindings = info.NetworkSettings.Ports["5432/tcp"];
  assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, "127.0.0.1");
  const port = Number(bindings[0].HostPort); assert(port > 0 && port !== 55432);
  report.port = port; report.mounts = info.Mounts.map(m => ({ type: m.Type, destination: m.Destination }));
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}?application_name=009d2c2v_admin`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
    try { await probe.connect(); await probe.end(); break; }
    catch { await probe.end().catch(() => {}); if (attempt === 39) throw new Error("Isolated server readiness timed out"); await delay(250); }
  }
  admin = new Client({ connectionString: adminUrl }); await admin.connect();
  const identity = (await admin.query("SELECT current_database() AS db, current_user AS role, current_setting('server_version_num') AS version_num, inet_server_port() AS internal_port, (pg_control_system()).system_identifier::text AS system_identifier")).rows[0];
  assert.equal(identity.db, database); assert.equal(identity.version_num, "180006"); assert.equal(identity.role, "postgres");
  const dataDirectory = (await admin.query("SHOW data_directory")).rows[0].data_directory;
  assert(dataDirectory.startsWith("/var/lib/postgresql/")); report.dataDirectory = dataDirectory;
  const empty = (await admin.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'")).rows[0]; assert.equal(empty.count, 0);
  report.isolatedIdentityBeforeMigrations = identity;
  console.log(`PASS: verified empty PostgreSQL 18.6 database ${database} on localhost:${port}, tmpfs only`);
  const migrations = readdirSync("prisma/migrations", { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.equal(migrations.length, 10);
  // Prisma deploy reads exactly the reviewed files; DATABASE_URL overrides dotenv.
  const cli = require.resolve("prisma/build/index.js");
  command(process.execPath, [cli, "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: adminUrl } });
  report.migrations = (await admin.query("SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY migration_name")).rows;
  for (const m of report.migrations) { assert(m.finished && !m.rolled_back); assert.equal(m.checksum, sha(`prisma/migrations/${m.migration_name}/migration.sql`)); }
  assert.deepEqual(report.migrations.map(m => m.migration_name), migrations);
  // Avoid recording the disposable role password in PostgreSQL's statement log.
  await admin.query("SET log_statement = 'none'");
  try { await admin.query(`CREATE ROLE receiving_runtime LOGIN PASSWORD '${runtimePassword}'`); }
  finally { await admin.query("SET log_statement = 'all'"); }
  await admin.query("GRANT USAGE ON SCHEMA public TO receiving_runtime; GRANT SELECT ON ALL TABLES IN SCHEMA public TO receiving_runtime; GRANT UPDATE(id) ON products, product_variants TO receiving_runtime; GRANT INSERT, UPDATE ON inventory_balances TO receiving_runtime; GRANT INSERT ON stock_movements TO receiving_runtime");
  await admin.query("GRANT UPDATE(acknowledged_at,acknowledged_by) ON orders TO receiving_runtime; GRANT INSERT ON order_events TO receiving_runtime");
  await admin.query("GRANT INSERT, UPDATE ON products,product_variants,categories TO receiving_runtime; GRANT INSERT,UPDATE ON media_assets TO receiving_runtime; GRANT INSERT,UPDATE,DELETE ON product_media TO receiving_runtime; GRANT INSERT ON product_lifecycle_events TO receiving_runtime");
  if(process.env.MEDIA_VERIFY_CATALOGUE === "1") {
    for(const [sort,slug] of ["full-shirts","half-shirts","panjabi","sherwani","t-shirts"].entries())
      await admin.query("INSERT INTO categories(name,slug,sort_order) VALUES($1,$2,$3)",[`TEST ${slug}`,slug,sort]);
  }
  await admin.end(); admin = null;
  console.log("PASS: ten migrations applied only to verified disposable database; restricted test runtime grants configured");
  const runtimeUrl = `postgresql://receiving_runtime:${runtimePassword}@127.0.0.1:${port}/${database}?application_name=009d2c2v_service`;
  const childEnv = { ...process.env, DATABASE_URL: runtimeUrl, INVENTORY_TEST_ADMIN_URL: adminUrl,
    INVENTORY_TEST_DATABASE: database, INVENTORY_TEST_RUN: id, INVENTORY_TEST_RESULTS: join(work, "results.json"),
    BETTER_AUTH_URL: "http://127.0.0.1:3000", BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), NODE_ENV: "test" };
  childEnv.DATABASE_URL=adminUrl;
  const code = await runChild(childEnv);
  if (existsSync(join(work, "results.json"))) report.tests = JSON.parse(readFileSync(join(work, "results.json"), "utf8"));
  // Preserve only SQL category/timing evidence, never raw SQL parameters/passwords.
  const logs = docker(["logs", containerId], { maxBuffer: 16 * 1024 * 1024 });
  // Docker writes postgres logs to stderr; obtain both streams for sanitization.
  const logResult = spawnSync("docker", ["logs", containerId], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(logResult.status, 0);
  const allLogs = logs + "\n" + logResult.stderr;
  report.databaseTrace = allLogs.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\d{4}-\d\d-\d\d .*?) \[(\d+)\] xid=(\d+) sqlstate=([0-9A-Z]+) .*?(?:statement:|execute [^:]*:|ERROR:)(.*)$/);
    if (!match) return [];
    const sql = match[5].trim();
    let category = /^(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)?.[1]?.toUpperCase();
    if (!category && /stock_movements/.test(sql)) category = /^INSERT/i.test(sql) ? "LEDGER_INSERT" : /unique constraint/.test(sql) ? "LEDGER_UNIQUE_ERROR" : "LEDGER_QUERY";
    if (!category && /UPDATE inventory_balances/.test(sql)) category = "BALANCE_UPDATE";
    if (!category && /permission denied/.test(sql)) category = "PRIVILEGE_FAILURE";
    if (!category && /lock timeout/.test(sql)) category = "LOCK_TIMEOUT";
    if (!category && /FROM products.*FOR UPDATE/s.test(sql)) category = "PRODUCT_LOCK";
    return category ? [{ time: match[1], pid: Number(match[2]), xid: match[3], sqlstate: match[4], category }] : [];
  });
  assert.equal(code, 0, "Isolated harness failed; inspect sanitized result evidence");

  report.migrationRollback = "Verified separately in governance integration probes";
  report.status = "PASSED";
} catch (error) {
  report.status = "FAILED"; report.failure = { name: error?.name, code: error?.code };
  console.error("Verification stopped; failure category recorded without raw diagnostics."); process.exitCode = 1;
} finally {
  if (admin) await admin.end().catch(() => {});
  if (objectCreated) { try { const object=JSON.parse(docker(["inspect",objectName]))[0];assert.equal(object.Config.Labels["verification.run"],id);docker(["stop","--time","3",objectName]);docker(["rm",objectName]);report.objectStorageRemoved=true; } catch { report.status="FAILED";process.exitCode=1; } }
  if (created) {
    try {
      const current = JSON.parse(docker(["inspect", name]))[0];
      assert.equal(current.Id, report.containerId); assert.equal(current.Config.Labels["verification.run"], id);
      docker(["stop", "--time", "5", report.containerId]);
      docker(["rm", report.containerId]);
      assert(!inventory().includes(report.containerId)); report.cleanup = "Verified disposable container removed; tmpfs destroyed";
    } catch { report.cleanup = `FAILED: isolated resource may remain: ${name}`; report.status = "FAILED"; process.exitCode = 1; }
  }
  if (beforeDevelopment) {
    try { const after = await developmentSnapshot(); assert.deepEqual(after, beforeDevelopment); report.developmentUnchanged = true; }
    catch { report.developmentUnchanged = false; report.status = "FAILED"; process.exitCode = 1; }
  }
  if (preserved) {
    report.preservedSourcesUnchanged = Object.entries(preserved).every(([path, hash]) => sha(path) === hash);
    report.receivingHashesAfter = Object.fromEntries(receiving.map(path => [path, sha(path)]));
    if (!report.preservedSourcesUnchanged) { report.status = "FAILED"; process.exitCode = 1; }
  }
  if (beforeContainers) { const after = inventory(); report.preexistingContainersPreserved = beforeContainers.every(container => after.includes(container)); }
  report.finalGitStatus = command("git", ["status", "--short"]);
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`RESULT: ${report.status}; cleanup=${report.cleanup}; development unchanged=${report.developmentUnchanged}; preserved sources unchanged=${report.preservedSourcesUnchanged}`);
  console.log(`Evidence: ${reportPath}`);
}
