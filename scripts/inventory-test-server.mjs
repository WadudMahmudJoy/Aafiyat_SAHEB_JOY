// Disposable browser-test server. Application/authentication code is unchanged;
// only the database/origin/build directory are isolated by the test controller.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import next from "next";

const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, "127.0.0.1"); assert.notEqual(url.port, "55432");
assert.match(url.pathname, /^\/receive_verify_[a-f0-9]{32}$/);
assert.match(process.env.INVENTORY_TEST_RUN, /^[a-f0-9-]{36}$/);
const port = Number(process.argv[2]); assert(port > 0);
const app = next({ dev: true, dir: process.cwd(), hostname: "127.0.0.1", port, turbopack: true });
await app.prepare();
const server = createServer(app.getRequestHandler());
server.on("upgrade", app.getUpgradeHandler());
server.listen(port, "127.0.0.1");
