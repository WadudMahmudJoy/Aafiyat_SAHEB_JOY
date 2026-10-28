import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { InventoryDetail, InventoryOverview } from "../src/lib/admin-inventory-read";

const runtime = createRequire(import.meta.url);
function load(file: string, overrides: Record<string, unknown> = {}) {
  const compiled = { exports: {} };
  runInNewContext(ts.transpile(readFileSync(file, "utf8"), { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }), {
    module: compiled, exports: compiled.exports, require: (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : name.endsWith(".css") ? { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) } : runtime(name),
  });
  return compiled.exports;
}
const form = load("src/app/admin/inventory/stock-form.tsx", { "./actions": { receiveStockAction: async () => {}, correctStockAction: async () => {} }, "@/lib/inventory-action-state": { initialInventoryState: { status: "idle", message: "" } } });
const view = load("src/app/admin/inventory/inventory-view.tsx", { "./stock-form": form }) as { InventoryOverviewView: React.ComponentType<{ data: InventoryOverview }>; InventoryDetailView: React.ComponentType<{ data: InventoryDetail }> };
const dashboard: InventoryOverview["dashboard"] = { identity: { name: "TEST Operator", email: "test@example.invalid" }, role: "OWNER", roleLabel: "owner", areas: [{ id: "inventory", label: "Inventory", description: "Stock", features: ["Stock receiving", "Counted corrections"], href: "/admin/inventory" }] };
const variant: InventoryDetail["variant"] = { productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", variantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", productName: "TEST Product", productSlug: "test-product", category: "TEST Category", sku: "TEST-SKU", sizeLabel: "Large", colorLabel: "Gold", lifecycle: "active", productArchived: false, active: true, archived: false, onHand: 12, reserved: 2, available: 10, threshold: 3, revision: "2026-10-28T00:01:02.123456Z" };
const detail: InventoryDetail = { dashboard, variant, canReceive: true, canCorrect: true, nextCursor: null, movements: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", movementType: "correction", actor: "<script>actor</script>", reason: "<img src=x onerror=bad>", createdAt: variant.revision, deltaOnHand: -2, onHandBefore: 14, onHandAfter: 12, reservedBefore: 2, reservedAfter: 2 }] };
let passed = 0;
function check(name: string, run: () => void) { run(); passed++; console.log(`PASS: ${name}`); }
const render = (data = detail) => renderToStaticMarkup(React.createElement(view.InventoryDetailView, { data }));
check("overview exposes search, exact quantities, status and stable variant links", () => {
  const html = renderToStaticMarkup(React.createElement(view.InventoryOverviewView, { data: { dashboard, items: [variant], search: "TEST", nextCursor: variant.variantId } }));
  for (const text of ["Search product, SKU, category or identifier", "TEST-SKU", "/admin/inventory/" + variant.variantId, "On hand", "Reserved", "Available", "Next variants", "search=TEST"]) assert(html.includes(text));
});
check("forms retain separate hidden keys and exact correction revision with accessible labels", () => {
  const html = render();
  for (const text of ['for="receive-quantity"', 'for="correction-quantity"', 'for="receive-reason"', 'for="correction-reason"', 'name="expectedRevision"', variant.revision, 'name="quantity"', 'name="targetOnHand"', 'maxLength="2048"']) assert(html.includes(text), text);
  assert.equal((html.match(/name="idempotencyKey"/g) ?? []).length, 2); assert(html.includes("Record receiving")); assert(html.includes("Record correction"));
});
check("archived state has no mutation forms and missing balances are explicitly uninitialized", () => {
  const archived = render({ ...detail, canReceive: false, canCorrect: false }); assert(!archived.includes('name="idempotencyKey"')); assert(archived.includes("Correction unavailable"));
  const absent = render({ ...detail, variant: { ...variant, onHand: null, reserved: null, available: null, revision: "missing" } }); assert(absent.includes("Not initialized")); assert(absent.includes("No balance has been initialized"));
});
check("history and product navigation are accurate and actor/reason are escaped", () => {
  const html = render(); assert(html.includes(`/admin/products/${variant.productId}`)); assert(html.includes("14 → 12")); assert(html.includes("Historical snapshots"));
  assert(html.includes("&lt;script&gt;actor")); assert(html.includes("&lt;img")); assert(!html.includes("<script>actor"));
});
check("inventory navigation is active in both desktop and mobile shell without upcoming labels", () => {
  const shell = load("src/app/admin/dashboard-view.tsx") as { default: React.ComponentType<Record<string, unknown>> };
  const html = renderToStaticMarkup(React.createElement(shell.default, { dashboard, state: "ready", busy: false, onSignOut() {}, onRetry() {}, currentPage: "inventory" }));
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 2); assert(html.includes("Stock and movement ledger")); assert(!html.includes("Counted corrections — Upcoming"));
  const checking = renderToStaticMarkup(React.createElement(shell.default, { dashboard, state: "checking", busy: false, onSignOut() {}, onRetry() {} }, React.createElement("span", null, "TEST_FORM_STATE")));
  assert(checking.includes('hidden=""')); assert(checking.includes('inert=""')); assert(checking.includes("TEST_FORM_STATE"));
});
console.log(`${passed} inventory presentation groups passed; synthetic render fixtures only, no database access.`);
