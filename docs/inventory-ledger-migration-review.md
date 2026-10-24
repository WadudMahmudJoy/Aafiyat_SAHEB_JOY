# Inventory ledger migration review — Task 009D-2A

Status: PREPARED, NOT APPLIED. Baseline: `f0e4756a7e3f8fd95e7684c4758e41e5d0388670`.
Review date: 19 October 2026. Supervisory approval is required before application.

## Existing contracts

- Product lifecycle is TEXT constrained to `draft`, `active`, `discontinued`, `archived`; archived lifecycle is equivalent to a non-null archive timestamp.
- Variants have `active boolean` and nullable `archived_at`, not a lifecycle enum. Archived variants must be inactive; an inactive variant need not be archived.
- A variant has an optional inventory balance. Its UUID is the balance PK/FK; both FK actions are RESTRICT.
- Balance INTEGER quantities enforce `0 <= reserved <= on_hand`; nullable low-stock threshold must be nonnegative. Available = on_hand - reserved; it is not stored.
- Balance timestamps are `timestamptz(6)`. No existing movement ledger, balance version, or balance revision trigger exists.
- AdminUser has a UUID membership ID, an inactive-by-default flag, and nullable disabled timestamp. Its Better Auth user FK uses TEXT; both user/role FK actions are RESTRICT.
- Actual roles remain OWNER, PRODUCT_MANAGER, ORDER_MANAGER, MARKETING_MANAGER. Only OWNER/PRODUCT_MANAGER have `inventory:manage`; catalogue permissions alone never authorize stock changes.

## Proposed eligibility matrix — review required, not enforced here

| Product lifecycle | Variant state | Receive | Correction |
|---|---|---|---|
| draft | active, not archived | Allow inventory preparation | Allow physical-count correction |
| active | active, not archived | Proposed allow; confirm | Proposed allow; confirm |
| discontinued | not archived | Pending business review; deny until approved | Pending business review; deny until approved |
| draft or active | inactive, not archived | Ambiguous; deny pending review | Ambiguous; deny pending review |
| archived | any | Deny | Deny |
| any | archived | Deny | Deny |

An archived product/variant always takes precedence. Unknown states fail closed.
These are proposed stock-operation rules, not changes to metadata's existing DRAFT-only rule.
Lifecycle, active flags, publishing, and threshold configuration are outside this migration.

## Exact additive changes

- SQL: [20261019000000_add_stock_movement_ledger/migration.sql](../prisma/migrations/20261019000000_add_stock_movement_ledger/migration.sql).
- One `StockMovement` model mapped to `stock_movements`, with reverse relations on ProductVariant and AdminUser. No existing column is altered and no balance version is added.
- UUID PK; required restrictive FKs to variant and admin membership; TEXT movement type constrained to `receive|correction`.
- INTEGER `delta_on_hand`, `delta_reserved` (default zero), and before/after on-hand/reserved snapshots. Native INTEGER capacity is 0..2,147,483,647 for snapshot quantities.
- Required reason; `created_at timestamptz(6)` defaults to database `clock_timestamp()`; globally unique UUID idempotency key; required 64-character lowercase hexadecimal SHA-256 request fingerprint.
- Unique idempotency index, descending `(variant_id, created_at, id)` history index, and actor FK index. History uses a bounded tuple cursor with all six timestamp fractional digits.
- Seven CHECK constraints cover operation/delta combinations, nonnegative snapshots, reserved bounds, widened BIGINT arithmetic, unchanged reservations, nonblank reason, and fingerprint format.
- Required actor is the server-authorized `adminUserId`, not the TEXT identity ID or a client claim. Actor FK preserves attribution if membership is later disabled; it prevents deleting referenced memberships.
- No reservation/order/exchange FK placeholders, general audit module, backfill, seed, or inventory initialization is included.

## Append-only protection and limits

- A statement-level BEFORE UPDATE OR DELETE OR TRUNCATE trigger rejects ordinary mutation attempts, including zero-row statements. ENABLE ALWAYS keeps it active under replication-role execution too.
- The invoker-rights PL/pgSQL function has a fixed `pg_catalog` search path and only raises an exception. PUBLIC UPDATE/DELETE/TRUNCATE privileges are revoked on the new table.
- This is not absolute immutability. Owners/superusers and privileged migrations can disable/drop/replace guards or the table. PUBLIC revocation does not remove direct/inherited grants, owner powers, or superuser powers.
- Production needs a distinct non-owner runtime role without schema CREATE, ownership, privileged-role membership, or migration credentials; grant only required ledger SELECT/INSERT. Exact role grants are deferred because no production roles are selected.
- Restrictive FKs do not prove active membership, MFA, lifecycle eligibility, or truthful snapshots. Timestamp defaults can be overridden by privileged/direct inserts; the later service must derive/allowlist all server-owned fields.
- CHECK constraints cannot prove ledger snapshots match the live balance or that every balance update has a movement. Current direct balance privileges must not be treated as an audited write interface. Later controlled transactions and production write privileges are required; no stock writes are enabled by this migration.

## Planned transaction and replay contract — no service implemented

1. Validate same-origin request and `inventory:manage` using the existing uncached session/MFA/active-membership guard. Retain its 12-hour MFA freshness policy and server-derived actor.
2. Validate bounded whole-unit quantities, UUIDs, and reason. Server-canonicalize a versioned payload containing actor membership ID, product/variant IDs, operation, received quantity or counted target, normalized reason, and expected revision for correction; hash with SHA-256. Do not hash client-supplied authorization data.
3. Begin one transaction. Lock product, then variant bound to that product, then balance. All later stock/reservation writers must adopt a compatible global order; multi-variant batches remain outside scope.
4. Recheck lifecycle eligibility while locked. Lookup idempotency key before correction revision validation. An authorized matching actor/binding/fingerprint replay returns the original movement result without another stock change; a mismatching payload fails. Revoked/ineligible requests remain denied rather than bypassing current guards.
5. On an eligible first operation, initialize a missing balance to zero using unique `variant_id` and INSERT ON CONFLICT DO NOTHING, then lock/read it. Missing is an explicit initial state, not unlimited stock. Never initialize during a read or variant metadata write.
6. Receive adds a positive integer to current on-hand; independent receipts accumulate. Correction sets a counted target, requires a reason and exact expected revision, and rejects unchanged counts, stale counts, and target < current reserved. Reserved and threshold remain untouched.
7. Validate addition using wider arithmetic before writing INTEGER values. Derive before/after snapshots and delta from locked rows. Atomically update balance and insert its movement; uniqueness/FK/check failures roll back both, including any initialization.
8. Same-key requests on one variant serialize via parent/variant locks. A same key used across products is arbitrated by global uniqueness: on conflict roll back the entire attempted transaction, then read/compare the committed movement under current authorization. Never catch a conflict and commit an unlogged balance update. Any bounded deadlock/serialization retry reuses the same key and payload.

## Revision conclusion

Existing `updated_at` is sufficient only with a mandatory writer convention: every balance change advances it using `GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')` and compares the expected revision while holding the balance lock.
Carry revisions as exact UTC strings with six fractional digits, never JavaScript Date round-trips. A missing balance requires an explicit missing revision; if another writer initialized it after the count form loaded, correction must conflict. Idempotent replay is checked first.
Prisma `@updatedAt` alone is not that guarantee, and raw SQL does not update it automatically. All future reservation writers must follow the convention; if that cannot be guaranteed, review a database revision trigger or explicit version before enabling writes. An extra version column now would not enforce writer compliance by itself.

## Application gate and pending verification

- Static results: PASS Prisma 7.10.0 validation, schema-to-schema SQL diff (new table/indexes/FKs only), client generation, TypeScript, ESLint, additive SQL/source inspection, and `git diff --check`. No live/shadow database was connected. Generated client files remain ignored.
- SQL CHECKs, trigger/function creation and firing (including TRUNCATE/zero-row attempts), FK retention, runtime grants, migration rollback/application, and ledger/balance concurrency require a separately approved database test/application task. They are NOT database-tested here.
- Confirm active/discontinued/inactive eligibility and production role separation. No Owner is provisioned here; only isolated fixtures may be used in the later approved database test task.
- One transaction wraps the new table, indexes, function, trigger, and new-table privilege changes. Referenced tables may briefly acquire FK-related locks when eventually applied; schedule application and review actual grants first.
- Do not apply or run database integration scripts now. The artifact is intentionally pending and does not make receiving/correction operational.

References: [PostgreSQL 18 CREATE TRIGGER](https://www.postgresql.org/docs/18/sql-createtrigger.html) and the installed Prisma 7.10.0 CLI's schema-only diff/validation help. Prisma does not represent these custom CHECKs/triggers; retain the SQL during future migration review.
