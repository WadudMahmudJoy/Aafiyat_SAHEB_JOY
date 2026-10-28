# Task 010-B — Orders and Customer Administration V1

Verified 28 October 2026 (Asia/Dhaka). Implemented locally for review; no commit, push, deployment or development-database migration.

## 1. Initial repository and database state

- Branch `main`, HEAD `db907e71a12212534431cac31115f75385c2639c`. Index empty. Only the pre-existing `next-env.d.ts` development-type-path modification was present.
- Next.js and eslint-config-next remain exactly `16.4.3`; package files and authentication policy are unchanged.
- Development identity verified read-only: `aafiyat_dev`, localhost port `55432`, PostgreSQL `180006` (18.6). Five applied migrations match their original file checksums; all 13 public tables fingerprinted.
- Requirements, database blueprint, implemented Prisma schema, permissions, inventory services and the inventory verification report were inspected. Implemented tables take precedence over the proposed blueprint.
- Original receiving/correction modules, all five applied migration files and the pre-existing `next-env.d.ts` were hash-checked and preserved. Build-generated configuration edits were restored.

## 2. Schema and additive migration

`20261028000000_add_orders_customers` adds five tables and the corresponding Prisma models:

- `customers`: reusable staff-support profile, canonical E.164-shaped contact, optional email, archive marker. Phone/email are not identity keys and are not globally unique.
- `customer_accounts`: optional external issuer/subject association, verification and disabled markers. No authentication integration, association writer, claim mechanism or consent grant is enabled. These records are separate from administrator authentication.
- `orders`: immutable order-specific contact/address, financial and shipping/policy snapshots; independent payment/fulfillment states; acceptance/cancellation/delivery markers; atomic acknowledgement actor/time.
- `order_items`: immutable name/SKU/size/color/quantity/price/discount snapshots with restrictive variant and order references.
- `order_events`: database-derived, append-only recorded/acknowledged evidence with restrictive administrator references and a unique acknowledgement event per order.

Financial values use signed PostgreSQL BIGINT with nonnegative checks; multiplication and sums use widened numeric arithmetic in constraints. Deferred constraint triggers require 1–200 items and match gross/discount aggregates to the order header. Application display/calculation uses BigInt and decimal strings, avoiding JavaScript number precision loss. Currency is BDT only.

Composite account/customer foreign keys prevent cross-profile ownership binding. Supporting FK, timestamp/ID pagination, payment/fulfillment and partial new-order indexes are included. Snapshot gates prohibit order/item deletion, truncation and later item insertion. Creation transaction binding is database-derived; newly inserted orders cannot be pre-acknowledged. Acknowledgement history cannot be overwritten or forged through ordinary direct event inserts.

**Status-write boundary:** this batch has no order creation, acceptance, payment or fulfillment writer. The snapshot trigger permits acknowledgement changes only. A separately reviewed future protocol/migration must extend this gate with verified payment and stock prerequisites. SQL fixture inserts with synthetic accepted/paid states were confined to disposable databases and do not represent gateway verification.

The migration was applied and verified only in new disposable PostgreSQL 18.6 instances. Transactional recreation followed by rollback restored all five isolated table fingerprints. The established development database still has only its original five migrations.

## 3. Implemented orders behavior

- `/admin/orders`: 25-row timestamp/UUID keyset pages; bounded literal search by order number, order UUID, snapshot contact name/phone; payment/fulfillment allowlists; inclusive UTC date filters implemented as half-open day ranges.
- `/admin/orders/[id]`: frozen item/contact/shipping/financial snapshots, current independent states, explicit accepted/unaccepted distinction and staff acknowledgement. Evidence is paginated in 20-row timestamp/UUID pages with order-bound cursors.
- Thin acknowledgement Server Action preserves duplicate FormData entries for strict service validation. Only Next action transport fields are removed. Client actor/status/timestamp injection is rejected.
- Acknowledgement requires configured origin and uncached, current `orders:manage` authorization including active membership, database-bound session and fresh session-bound MFA.
- A bounded real Prisma transaction locks the order, rechecks accepted/non-cancelled eligibility, writes actor/time only when absent, and atomically records the trigger-derived event. Repeats return the retained acknowledgement; two concurrent requests produce one event. No payment, fulfillment or stock fields change.
- The red badge derives only from accepted, unacknowledged, non-cancelled database rows. It is visible only with `orders:read`, revalidates after acknowledgement and handles zero, large counts and unavailable queries. Unavailable migration/database state is never represented as zero.

## 4. Implemented customer behavior

- `/admin/customers`: bounded search by profile name, phone, email or UUID with 25-row keyset pages.
- `/admin/customers/[id]`: profile, explicit guest/verified/unverified/disabled account association and 25-row profile-ID-bound order-history pages.
- Customer administration reuses `orders:read` because it exposes the same restricted order-support PII. No permission or role grants changed.
- Contact matching never merges profiles, creates account ownership, grants customer access to history or implies marketing consent. Order ownership remains independent of current profile contact values. No customer login, destructive deletion, merge or consent action was added.

## 5. UI and integration

- Dedicated Orders and Customers navigation uses existing permissions with accurate desktop/mobile active indicators.
- Native labeled filters, keyboard-scrollable tables, loading/empty/error states, escaped text, pending/disabled acknowledgement and safe same-order retry messaging.
- Customer/order links round-trip through authorized pages. The existing session shell hides/inerts private contents while checking access; role changes are reauthorized server-side.
- Dashboard, catalogue, drafts, variants and inventory remain present. Public exact-stock behavior is unchanged.
- Before approved schema deployment, Orders/Customers show a generic unavailable/foundation-awaiting-deployment state. No live figures or accepted orders are fabricated.

## 6. Isolated test evidence

Final database/service run: `fc9e8953-7fec-415b-8dbd-a9a71bec6847`, PostgreSQL 18.6, localhost port `50223`, database `receive_verify_fc9e89537fec415b8dbda9a71bec6847`, container `aafiyat-orders-010b-fc9e8953-7fec-415b-8dbd-a9a71bec6847`. Empty identity, random localhost binding, tmpfs-only storage and reviewed migration checksums were checked before test fixtures.

**15 service/integration groups passed:**

1. Financial mismatch, missing items, pre-acknowledgement and true INTEGER×BIGINT overflow rejection.
2. Snapshot/item/evidence protection, late insertion denial and restrictive customer/variant references.
3. Anonymous, insufficient-role, missing/stale MFA denial.
4. Origin, duplicate-field and actor/status injection denial.
5. Pending/cancelled acknowledgement denial and exact badge eligibility.
6. Two real concurrent acknowledgement transactions, separate observed waiting backend PIDs, one committed audit effect.
7. Safe identical-order retry preserving actor/time and payment/fulfillment fields.
8. Real event INSERT privilege failure rolling back acknowledgement and badge effect.
9. Real order lock contention with bounded approximately two-second timeout and no partial acknowledgement.
10. Order snapshots surviving product price/profile edits.
11. Order number/contact/date/status filters and nonoverlapping 25/2 keyset pages.
12. Same-contact profiles remain separate; foreign-customer cursor and composite account-binding privacy.
13. Customer 25/2 pagination and existing ORDER_MANAGER access.
14. Actual receiving/correction services and matching stock ledger still work with new order foreign keys.
15. Actual acknowledgement Server Action with real service/guards, duplicate rejection, origin denial and revalidation; only Next request/cache boundaries simulated.

No Prisma transaction function was replaced and savepoints did not simulate commits. Service probes simulated `auth.api.getSession` only; membership, token/session binding and MFA checks used the isolated database. The final controller also passed transactional migration recreation/rollback with all five isolated table fingerprints restored.

Sanitized raw evidence is outside Git in the OS temporary directory under `aafiyat-orders-010b-<run-id>/orders-results.json`. The browser evidence run was `c97cd1ed-78df-4445-8679-a49a50ecac62` (port `52856`), with 13 overlapping service groups plus the actual authenticated browser group. Subsequent additions strengthened financial/creation guards, FK tests and service/Action regressions; the final run above verifies the final migration. The browser-facing code did not change after browser acceptance.

## 7. Browser and responsive verification

- Actual password and TOTP HTTP flow in a disposable server/database, with encrypted synthetic factor and confirmed database-backed MFA proof. No auth-policy bypass or permanent Owner provisioning.
- Accepted synthetic order acknowledgement: disabled pending button, one committed acknowledgement event, red badge `3 → 2`, payment remained paid and fulfillment remained unfulfilled as seeded.
- Actual order search, two distinct profiles sharing contact details, order/customer round-trip links and desktop/mobile active navigation.
- Anonymous access to all four new routes redirected to login without private rows. Changing the isolated browser operator to PRODUCT_MANAGER denied Orders/Customers routes and removed private navigation; its fixture role was restored afterward.
- All four routes passed document-overflow checks at **320, 375, 393, 768 and 1440px**: 20 route/viewport combinations. Client/scroll widths matched (305, 360, 378, 753, 1425px respectively with desktop scrollbars). Wide tables scroll within their region.
- Mobile 393px and desktop 1440px screenshots were inspected. Native keyboard controls and accessible labels/regions were checked. No dedicated screen-reader application or load qualification was performed.

## 8. Regression/static outcomes

| Verification | Actual outcome |
|---|---|
| Existing database-free inventory, dashboard/session, catalogue, draft, variant and login checks | 79 passed |
| New order validation groups | 3 passed |
| New order/customer presentation and boundary groups | 8 passed |
| Existing authorization regression, forced read-only | 22 passed |
| Existing dashboard policy/access regression, forced read-only | 13 passed |
| Final isolated service/integration groups | 15 passed |
| Transactional migration recreation/rollback | Passed; five isolated fingerprints restored |
| Prisma schema validation | Passed |
| TypeScript | Passed |
| ESLint | Passed |
| Next.js 16.4.3 production build | Passed; all four new dynamic routes present |
| Whitespace and sensitive-artifact review | Passed |

Build used a process-only HTTPS authentication origin and read-only PostgreSQL options. The local HTTP `.env`, production HTTPS requirement and authentication implementation were unchanged. Legacy development service-fixture suites that assume exactly five local migration directories were not rerun against a mismatched migration set; actual inventory service regressions ran in the isolated six-migration environment instead.

Initial test issues were corrected and relevant checks rerun: a synthetic session omitted `expiresAt`; a UI VM lacked `URLSearchParams`; and a SQL-generation replacement collapsed a dollar-quote delimiter. Final migration/service/validation/UI/static runs pass. No unresolved correctness defect was confirmed.

## 9. Development preservation and cleanup

Every isolated attempt compared read-only development snapshots before/after; all matched. A separate read-only audit after browser/build confirmed the original five migration checksums and **all 13 fingerprints**:

| Table | Before/after |
|---|---|
| `_prisma_migrations` | Preserved |
| `admin_roles` | Preserved |
| `admin_users` | Preserved |
| `auth_accounts` | Preserved |
| `auth_sessions` | Preserved |
| `auth_two_factors` | Preserved |
| `auth_users` | Preserved |
| `auth_verifications` | Preserved |
| `categories` | Preserved |
| `inventory_balances` | Preserved |
| `product_variants` | Preserved |
| `products` | Preserved |
| `stock_movements` | Preserved |

Task-created containers were individually identity/label-checked, stopped and removed; their tmpfs data was destroyed. Test servers stopped, temporary credential-ready files removed and isolated build output removed. Pre-existing Docker resources were preserved. Docker Desktop was started to provide the requested disposable infrastructure; no existing database was reset or synchronized.

## 10. Dependencies and limits

- The new migration is pending supervisory review and a separate authorized deployment. Orders/Customers are not operational on the unmigrated development database.
- No public checkout, customer authentication/claiming, guest identity token, payment gateway, COD, acceptance, reservation, deduction, fulfillment transition, refund, exchange or consent writer exists in this batch.
- Later checkout/payment/stock integration needs an approved transaction/idempotency protocol, verified gateway evidence, reservation/ledger extensions and a reviewed extension of the order write gate. Existing manual stock movement rules were not broadened.
- Snapshot shipping/policy JSON is stored independently; this task does not finalize shipping zones/rates, promotions, tax, free-order or exchange policies.
- Current audit evidence covers order recording and acknowledgement. Payment/delivery transitions and persistent PII-read auditing are not implemented.
- Service authentication simulation is distinct from real browser authentication and actual multi-connection database transactions. The tests do not establish production DB-role provisioning, provider integration, all network failure modes or performance readiness.
- Raw results, credentials, screenshots, logs and generated Prisma artifacts are excluded from the intended checkpoint.

## 11. Final Git state and recommended next batch

Branch/HEAD remain `main` / `db907e71a12212534431cac31115f75385c2639c`; index empty, no commit or push. Six existing files modified by this task and 19 new files; the pre-existing modified `next-env.d.ts` remains intact (7 modified / 19 untracked total).

Next: supervisory review of this additive migration and admin foundation, followed by separately authorized schema deployment. Product media/content administration can be the next independent accelerated batch; approve the checkout/payment/reservation protocol before activating order acceptance or fulfillment.

## 12. Exact task file manifest

Modified:

- `prisma/schema.prisma`
- `scripts/verify-admin-dashboard.ts`
- `src/app/admin/admin-session.tsx`
- `src/app/admin/dashboard-view.tsx`
- `src/app/admin/dashboard.module.css`
- `src/lib/admin-dashboard.ts`

Created:

- `docs/task-010-b-orders-customers-verification.md`
- `prisma/migrations/20261028000000_add_orders_customers/migration.sql`
- `scripts/run-orders-verification.mjs`
- `scripts/verify-order-validation.ts`
- `scripts/verify-orders-integration.ts`
- `scripts/verify-orders-migration.mjs`
- `scripts/verify-orders-ui.ts`
- `src/app/admin/customers/[id]/page.tsx`
- `src/app/admin/customers/loading.tsx`
- `src/app/admin/customers/page.tsx`
- `src/app/admin/orders/[id]/page.tsx`
- `src/app/admin/orders/acknowledge-form.tsx`
- `src/app/admin/orders/actions.ts`
- `src/app/admin/orders/loading.tsx`
- `src/app/admin/orders/order-view.tsx`
- `src/app/admin/orders/orders.css`
- `src/app/admin/orders/page.tsx`
- `src/lib/admin-orders.ts`
- `src/lib/order-validation.ts`

Preserved existing local modification, outside this task's changes: `next-env.d.ts`.

## 13. Task 010-BG checkpoint audit

The initial 7-modified/19-untracked manifest above matched the working tree. The checkpoint excludes the pre-existing `next-env.d.ts` modification and adds one `.gitattributes` rule scoped solely to the new migration, enforcing LF checkout bytes despite Windows `core.autocrlf=true`. No SQL, service, authorization or UI behavior changed during the checkpoint review. The intended checkpoint therefore contains the 25 task files listed above plus `.gitattributes` (26 files).

The reviewed migration SHA-256 is `f7aaf2272944ea7ab7ea109a9871c170be1775c5123422d880d8c8987455758b`. Working and staged migration bytes must match this checksum and the preserved PostgreSQL 18.6 verification evidence. All five previously applied migration files remain byte-for-byte unchanged. This checkpoint does not deploy the new migration.

Fresh checkpoint checks passed: Prisma validation, TypeScript, ESLint, all 90 database-free checks, dependency/lockfile/installed-version consistency, whitespace and sensitive-artifact scans. A read-only live database audit confirmed five applied migrations and all 13 preserved table fingerprints. Previous isolated concurrency/rollback/browser evidence was reviewed without rerunning database suites.
