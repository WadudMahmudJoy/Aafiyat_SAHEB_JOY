# Aafiyat — PostgreSQL Database Blueprint V1

Baseline: [project-requirements-v1.md](project-requirements-v1.md). This is a proposed relational design, not a schema or migration. No older project is used. Catalog, customers, inventory, orders, payments, and administration remain modules of one monolith.

## Conventions and assumptions

- PKs are `uuid` unless specified; required columns are `NOT NULL`, optional columns are marked `?`. FK targets are explicit below. Every PK and unique constraint has its supporting index; listed indexes are additional unless described as unique.
- All event timestamps use `timestamptz`, written and displayed internally in UTC; storefront/admin presentation may use Asia/Dhaka. Mutable entities have `created_at`, `updated_at`; append-only records have `created_at`.
- Money is `bigint` in minor units; proposed V1 currency is BDT (100 poisha per taka). BDT 5,000 = 500,000 minor units. No floats; validate bounds and checked arithmetic, including JSON/API serialization without JavaScript precision loss.
- Prices, charges, discounts, and quantities have nonnegative checks; item quantities are positive integers. Currency is `char(3)` checked against the supported set. Status fields are `text` with explicit allowed-value checks, not arbitrary strings.
- IDs are opaque, but never authorization. PII is accessible only through authorized server projections. Public catalog responses omit exact inventory; ordinary logs and notification payloads omit addresses/phone numbers.
- FKs default to `ON DELETE RESTRICT`; exceptions are named. Referenced historical entities are archived, not deleted. Cross-row sums and status transitions require transactions/controlled write paths or triggers; a row CHECK alone cannot enforce them.
- Proposed simplifications: one category per product, flat categories, one fulfillment per order, one admin role per admin, no backorders, no split shipments. These are design assumptions pending confirmation, not new business requirements.

## Core tables

Each entry gives purpose, essential columns, keys/constraints, and necessary indexes. Shared timestamps follow the conventions above.

### Catalog and media

**1. `categories` — initial product taxonomy.**
- Columns: `id uuid`, `name text`, `slug text`, `active boolean`, `sort_order integer`, `seo_title text?`, `seo_description text?`.
- Keys/constraints: PK `id`; unique normalized `slug`; nonempty name/slug. Initial labels: T-Shirt, Half Shirt, Full Shirt, Panjabi, Sherwani.
- Indexes: `(active, sort_order, id)` for public navigation. Deactivate referenced categories; deletion restricted by products.

**2. `collections` — curated merchandising groups.**
- Columns: `id uuid`, `name text`, `slug text`, `active boolean`, `seo_title text?`, `seo_description text?`.
- Keys/constraints: PK `id`; unique normalized `slug`; nonempty name/slug.
- Indexes: `(active, id)`; archive/deactivate collections; membership deletion is safe.

**3. `products` — product identity, lifecycle, presentation, and SEO.**
- Columns: `id uuid`, `category_id uuid`, `size_guide_content_id uuid?`, `name text`, `slug text`, `description text`, `lifecycle text`, `archived_at timestamptz?`, `seo_title text?`, `seo_description text?`.
- Keys/constraints: PK `id`; FKs to `categories`, `content_entries`; unique normalized `slug`; lifecycle `draft|active|discontinued|archived`; archived timestamp iff archived. Preserve slugs to keep campaign URLs stable; discontinuation stops new purchases.
- Indexes: `(category_id, lifecycle, created_at, id)`, `size_guide_content_id` where non-null. Hard deletion only for never-used drafts after reference checks.

**4. `product_variants` — sellable size/color/SKU combinations.**
- Columns: `id uuid`, `product_id uuid`, `sku text`, `size_code text`, `size_label text`, `color_code text`, `color_label text`, `price_minor bigint`, `currency char(3)`, `active boolean`, `archived_at timestamptz?`.
- Keys/constraints: PK `id`; FK `product_id -> products`; unique normalized SKU globally, unique `(product_id, size_code, color_code)`, unique `(product_id, id)` for composite references. Canonical non-null codes; price >= 0; archived variants cannot be active. SKUs are never recycled.
- Indexes: `(product_id, active, id)`. Order history restricts deletion; archive unused options instead of changing their historical identity.

**5. `collection_products` — product membership and display order.**
- Columns: `collection_id uuid`, `product_id uuid`, `sort_order integer`.
- Keys/constraints: composite PK `(collection_id, product_id)`; FKs to collections/products, `CASCADE` on deletion of these nonfinancial memberships.
- Indexes: `(collection_id, sort_order, product_id)`, `(product_id, collection_id)`.

**6. `media_assets` — object-storage references, never image bytes.**
- Columns: `id uuid`, `object_key text`, `mime_type text`, `byte_size bigint`, `width integer?`, `height integer?`, `state text`, `delete_after timestamptz?`.
- Keys/constraints: PK `id`; unique immutable object key; state `pending|ready|delete_pending|deleted`; nonnegative byte size and positive dimensions when present. Only ready assets may gain new references; enforce under asset-row lock.
- Indexes: `(delete_after, id)` where state = `delete_pending`. Keep deletion tombstones to avoid object-key reuse and to reconcile failed cleanup.

**7. `product_media` — ordered galleries with optional variant association.**
- Columns: `id uuid`, `product_id uuid`, `variant_id uuid?`, `media_asset_id uuid`, `alt_text text`, `sort_order integer`.
- Keys/constraints: PK `id`; FKs product -> products, media -> media_assets, composite `(product_id, variant_id) -> product_variants(product_id, id)`; product deletion may cascade this link only. Unique `(product_id, sort_order)`; explicit product FK still applies when variant is null.
- Indexes: `media_asset_id`, `variant_id` where non-null; gallery index supplied by the ordering constraint.

### Customers and identity

**8. `customers` — reusable profiles, separate from account ownership.**
- Columns: `id uuid`, `display_name text`, `phone_e164 text`, `guest_identity_hash text?`, `merged_into_id uuid?`, `archived_at timestamptz?`.
- Keys/constraints: PK `id`; self-FK `merged_into_id -> customers`; unique guest identity hash when present; no unique phone constraint. Check E.164 shape and no self-merge; controlled merge prevents cycles.
- Indexes: `phone_e164` for restricted staff matching, `merged_into_id` where non-null. Profile phone normalization is not verification or ownership evidence.

**9. `customer_accounts` — optional authenticated identity.**
- Columns: `id uuid`, `customer_id uuid`, `identity_issuer text`, `identity_subject text`, `verified_at timestamptz?`, `disabled_at timestamptz?`, `session_version integer`.
- Keys/constraints: PK `id`; unique FK `customer_id -> customers`; unique `(identity_issuer, identity_subject)`. Issuer/subject come from a trusted server-validated identity integration, never checkout input; nonnegative session version.
- Indexes: unique constraints support account lookup. Authentication method/provider remains unresolved; this proposal avoids storing customer passwords until that decision.

**10. `customer_addresses` — mutable saved checkout addresses.**
- Columns: `id uuid`, `customer_id uuid`, `recipient_name text`, `phone_e164 text`, `address_line1 text`, `address_line2 text?`, `locality text`, `district text`, `postal_code text?`, `country_code char(2)`, `is_default boolean`.
- Keys/constraints: PK `id`; FK customer -> customers, `CASCADE` allowed for saved-address deletion on permitted profile erasure; unique partial `(customer_id)` where `is_default`. Required address fields nonempty; normalize phone.
- Indexes: `(customer_id, id)`. Orders never read historical addresses from this table.

**11. `marketing_consent_events` — append-only, explicit consent evidence.**
- Columns: `id uuid`, `customer_id uuid`, `account_id uuid?`, `channel text`, `action text`, `destination_e164 text`, `notice_version text`, `notice_text_snapshot text`, `source text`, `occurred_at timestamptz`, `idempotency_key text`.
- Keys/constraints: PK `id`; FKs to customers/customer_accounts; unique idempotency key; action `grant|withdraw`; proposed initial channel `sms`, pending channel approval. Validate actor/profile association through controlled writes; record actual destination and exact notice shown. Future channels use channel-specific normalized destinations (extend this field design before email support); grants never transfer between channels.
- Indexes: `(customer_id, channel, occurred_at DESC, id DESC)`. No consent row is created by a hidden checkbox. Missing evidence means no consent; changing phone does not transfer consent to a new destination.

### Inventory

**12. `inventory_balances` — authoritative variant stock.**
- Columns: `variant_id uuid`, `on_hand integer`, `reserved integer`, `low_stock_threshold integer?`.
- Keys/constraints: PK/FK `variant_id -> product_variants`; checks `0 <= reserved <= on_hand`, threshold >= 0 if set. Available is derived as `on_hand - reserved`, never an independently editable value.
- Indexes: PK suffices for stock locks/lookups. Null threshold inherits current business settings; public status is Out of Stock at zero, Low Stock at positive available <= threshold, otherwise In Stock, subject to sellable lifecycle.

**13. `inventory_reservations` — one reservation per order item.**
- Columns: `id uuid`, `order_item_id uuid`, `variant_id uuid`, `quantity integer`, `state text`, `expires_at timestamptz`, `closed_at timestamptz?`.
- Keys/constraints: PK `id`; unique `order_item_id`; composite FK `(order_item_id, variant_id) -> order_items(id, variant_id)`; FK variant -> variants; quantity > 0; state `active|consumed|released|expired`; closed timestamp iff terminal. Creation enforces quantity = item quantity in the same transaction.
- Indexes: `(expires_at, id)` where active; `(variant_id, state)`. Terminal rows stay retained; expiry is an atomic transition, not a clock-dependent CHECK.

**14. `stock_movements` — append-only stock/reservation ledger.**
- Columns: `id uuid`, `variant_id uuid`, `reservation_id uuid?`, `exchange_item_id uuid?`, `actor_admin_id uuid?`, `delta_on_hand integer`, `delta_reserved integer`, `reason text`, `idempotency_key text`.
- Keys/constraints: PK `id`; FKs to variants/reservations/exchange_items/admin_users; unique idempotency key; at least one delta nonzero. Controlled writes enforce referenced variant consistency, reason/delta rules, and balance updates atomically.
- Indexes: `(variant_id, created_at DESC, id DESC)` plus non-null reservation/exchange/admin FK indexes. No direct balance edits without corresponding movements; corrections use compensating movements.

### Orders and exchanges

**15. `orders` — durable checkout, financial totals, and independent statuses.**
- Columns: `id uuid`, `order_number text`, `checkout_key text`, `customer_id uuid`, `owner_account_id uuid?`, `currency char(3)`, `merchandise_subtotal_minor bigint`, `discount_minor bigint`, `shipping_minor bigint`, `tax_minor bigint`, `grand_total_minor bigint`, `payment_mode text`, `payment_status text`, `fulfillment_status text`, `accepted_at timestamptz?`, `cancelled_at timestamptz?`, `acknowledged_at timestamptz?`, `acknowledged_by uuid?`, `delivered_at timestamptz?`, `exchange_anchor_at timestamptz?`, `exchange_deadline_at timestamptz?`, `exchange_policy_snapshot jsonb`, `contact_snapshot jsonb`, `shipping_rule_snapshot jsonb`, `offer_snapshot jsonb?`.
- Keys/constraints: PK `id`; unique order number and checkout key; FKs customer -> customers, owner -> customer_accounts, acknowledged_by -> admin_users. All money >= 0; discount <= subtotal; total = subtotal - discount + shipping + tax. Payment states `unpaid|pending|paid|partially_refunded|refunded`; fulfillment `unfulfilled|processing|shipped|delivered|cancelled`. Acknowledgement timestamp/actor both null or both present; delivered status requires delivered timestamp.
- Acceptance constraints: V1 payment_mode is `online_prepaid` only; COD is not enabled. An order row is initially a retained pending checkout, with accepted_at null and no fulfillment authorization. Set accepted_at once, only in the verified-payment/stock-consumption transaction; cross-table enforcement uses the controlled write path. Processing/shipping/delivery require acceptance; acknowledgement requires acceptance. A failed attempt leaves payment unpaid (or pending if another attempt is active), never paid; cancellation does not erase acceptance history.
- Indexes: `(owner_account_id, created_at DESC, id DESC)` where owner present; `(customer_id, created_at DESC, id DESC)` for staff only; `(created_at DESC, id DESC)`; `(accepted_at, id)` where accepted_at is non-null, acknowledged_at is null, cancelled_at is null, and fulfillment_status != `cancelled` for the global red badge; `(fulfillment_status, created_at, id)`; non-null acknowledged_by index.
- Snapshot validation requires name, normalized phone, complete delivery address, rule version/threshold/base charge, and policy version. Only whitelisted fields enter JSON. Exchange deadline is absent until a confirmed rule supplies an anchor; if populated, anchor must be present and deadline >= anchor.

**16. `order_items` — immutable product and price snapshots.**
- Columns: `id uuid`, `order_id uuid`, `variant_id uuid`, `product_name text`, `sku text`, `size_label text`, `color_label text`, `quantity integer`, `unit_price_minor bigint`, `line_discount_minor bigint`, `line_total_minor bigint`, `media_asset_id uuid?`.
- Keys/constraints: PK `id`; FKs order -> orders, variant -> variants, media -> media_assets, all RESTRICT; unique `(order_id, variant_id)` and `(id, variant_id)`; quantity > 0, monetary fields >= 0; discount <= quantity * unit price; line total = quantity * unit price - discount. Check multiplication capacity before write.
- Indexes: unique order/variant index serves item retrieval; `variant_id`, non-null media_asset_id index. Transaction enforces sums of gross lines/discounts equal order subtotal/discount; do not reprice history from catalog.

**17. `exchange_requests` — three-day exchange eligibility and decision record.**
- Columns: `id uuid`, `order_id uuid`, `requested_by_account_id uuid?`, `handled_by_admin_id uuid?`, `requested_at timestamptz`, `status text`, `reason text`, `eligibility_snapshot jsonb`, `idempotency_key text`.
- Keys/constraints: PK `id`; FKs to orders/accounts/admin_users; unique idempotency key; status `requested|approved|rejected|received|completed|cancelled`; unique `(id, order_id)` for item association. Record policy/anchor/deadline evidence and staff override reason; unresolved timing prevents automatic eligibility decisions.
- Indexes: `(order_id, requested_at DESC, id)`, `(status, requested_at, id)` and non-null actor FK indexes. Preserve decisions, including rejected requests.

**18. `exchange_items` — original items and quantities under exchange.**
- Columns: `id uuid`, `request_id uuid`, `order_id uuid`, `order_item_id uuid`, `quantity integer`, `received_quantity integer`, `restock_quantity integer`, `replacement_order_id uuid?`.
- Keys/constraints: PK `id`; composite FKs `(request_id, order_id) -> exchange_requests(id, order_id)` and `(order_item_id, order_id) -> order_items(id, order_id)` (requires additional unique `(id, order_id)` on order_items); replacement FK -> orders; unique `(request_id, order_item_id)`; `0 <= restock_quantity <= received_quantity <= quantity`, quantity > 0.
- Indexes: `order_item_id`, non-null replacement_order_id, `order_id`. Under original-item lock, enforce cumulative non-rejected/non-cancelled requested quantity <= purchased quantity. Replacement purchases use ordinary order/reservation flows; inspection-based restocking uses idempotent movements.

### Payments and shipping

**19. `payment_attempts` — merchant requests to SSLCOMMERZ.**
- Columns: `id uuid`, `order_id uuid`, `merchant_tran_id text`, `provider text`, `requested_amount_minor bigint`, `currency char(3)`, `status text`, `gateway_session_id text?`, `expires_at timestamptz?`, `idempotency_key text`.
- Keys/constraints: PK `id`; FK order -> orders; unique merchant transaction ID and idempotency key; unique `(id, order_id)`; provider `sslcommerz`; status `created|pending|verified|failed|cancelled|expired`; amount > 0. Controlled creation matches frozen order amount/currency; at most one created/pending attempt per order through a partial unique index.
- Indexes: `(order_id, created_at DESC, id)`, active expiry index. Failed attempts remain retained; gateway session IDs are internal, not credentials.

**20. `payment_events` — durable callback/IPN receipt and processing work.**
- Columns: `id uuid`, `attempt_id uuid`, `source text`, `dedup_key text`, `provider_validation_id text?`, `processing_status text`, `received_at timestamptz`, `processed_at timestamptz?`, `retry_at timestamptz?`, `lease_token uuid?`, `lease_expires_at timestamptz?`, `attempt_count integer`, `safe_summary jsonb`.
- Keys/constraints: PK `id`; FK attempt -> payment_attempts; unique `(attempt_id, dedup_key)`; source `callback|ipn|reconciliation`; processing `pending|processing|processed|rejected`; attempts >= 0. Dedup key uses stable provider identifiers/status where available; receipt dedup is supplemental to transaction-level uniqueness.
- Indexes: `(retry_at, id)` for pending work, `(lease_expires_at, id)` where processing for recovery; FK covered by dedup index. Processing requires a lease token/deadline; completion checks the current token. Store only allowlisted IDs/status/verification evidence; no raw payment payloads or card details. Unresolved merchant IDs are rejected without binding to an arbitrary order.

**21. `payment_transactions` — server-verified successful gateway payments.**
- Columns: `id uuid`, `attempt_id uuid`, `order_id uuid`, `provider text`, `provider_transaction_id text`, `validation_id text`, `amount_minor bigint`, `currency char(3)`, `verified_at timestamptz`, `allocation text`.
- Keys/constraints: PK `id`; composite FK `(attempt_id, order_id) -> payment_attempts(id, order_id)`; FK order -> orders; unique `(provider, provider_transaction_id)` and `(provider, validation_id)`; amount > 0; allocation `applied|unallocated`; partial unique `(order_id)` where applied. Apply only exact expected merchant amount/currency, not gateway fees or net settlement.
- Indexes: `(order_id, verified_at, id)`, `attempt_id`. Record extra successful payments as unallocated for reconciliation/refund; never erase them or fulfill twice.

**22. `refunds` — retained refund requests and verified outcomes.**
- Columns: `id uuid`, `payment_transaction_id uuid`, `amount_minor bigint`, `status text`, `provider_refund_id text?`, `idempotency_key text`, `reason text`, `requested_by_admin_id uuid`, `completed_at timestamptz?`.
- Keys/constraints: PK `id`; FKs to payment_transactions/admin_users; unique idempotency key and provider refund ID when present; amount > 0; status `requested|pending|succeeded|failed`; succeeded requires completion timestamp. Currency inherited from payment.
- Indexes: `(payment_transaction_id, created_at, id)`, `(status, created_at, id)`, requested_by_admin_id. Lock payment row to bound sum of requested/pending/succeeded refunds by captured amount; failed amounts release that capacity. Ambiguous provider outcomes stay pending until reconciled.

**23. `shipping_rules` — configurable base delivery charges.**
- Columns: `id uuid`, `zone_code text`, `label text`, `charge_minor bigint`, `currency char(3)`, `active boolean`, `version integer`.
- Keys/constraints: PK `id`; unique zone code; charge >= 0; version > 0; server maps address to one configured zone or rejects unsupported checkout. Proposed simple one-rate-per-zone model; actual zones/rates await confirmation.
- Indexes: `(active, zone_code)`. Checkout snapshots zone/version/base charge, global threshold, computed shipping, and currency; later edits never change historical orders.

### Administration, configuration, offers, and content

**24. `admin_roles` — small explicit permission sets.**
- Columns: `id uuid`, `name text`, `permissions jsonb` (validated array of allowed permission codes).
- Keys/constraints: PK `id`; unique name; no unknown permission codes. Role deletion restricted by users.
- Indexes: unique name suffices. Enforce permissions server-side; sensitive settings/refunds/identity claims require explicit permission.

**25. `admin_users` — admin identities and MFA enrollment.**
- Columns: `id uuid`, `role_id uuid`, `identity_issuer text`, `identity_subject text`, `disabled_at timestamptz?`, `mfa_enrolled_at timestamptz?`, `mfa_secret_ciphertext text?`, `recovery_code_hashes jsonb?`, `session_version integer`.
- Keys/constraints: PK `id`; FK role -> admin_roles; unique issuer/subject; session version >= 0. Proposed managed authentication plus MFA; if TOTP is locally held, encrypt its secret with a key outside PostgreSQL and store only hashed recovery codes. Never persist plaintext secrets or passwords.
- Indexes: `role_id`. Disabled or non-MFA admins cannot obtain privileged sessions; audit MFA resets and revoke existing sessions.

**26. `auth_sessions` — revocable customer/admin sessions.**
- Columns: `id uuid`, `customer_account_id uuid?`, `admin_user_id uuid?`, `token_hash text`, `principal_version integer`, `mfa_verified_at timestamptz?`, `expires_at timestamptz`, `revoked_at timestamptz?`.
- Keys/constraints: PK `id`; FKs to accounts/admins, `CASCADE` allowed for session cleanup; exactly one principal; unique token hash; expiry > creation. Store no bearer tokens; issue secure HttpOnly/SameSite cookies and apply CSRF controls.
- Indexes: non-null customer_account_id/admin_user_id indexes; expiry index. Every request checks principal enabled state/version/expiry; staff requests also require MFA and current permission.

**27. `business_settings` — typed settings and feature switches.**
- Columns: `id smallint` fixed to 1, `version integer`, `currency char(3)`, `free_shipping_threshold_minor bigint`, `default_low_stock_threshold integer`, `marketing_consent_ui_enabled boolean`, `consent_notice_text text`, `consent_notice_version text`, `reviews_enabled boolean`, `exchange_days integer`, `exchange_anchor text?`, `updated_by_admin_id uuid`.
- Keys/constraints: PK `id`, CHECK id = 1; FK updated_by -> admin_users; version > 0; thresholds >= 0; V1 CHECK reviews_enabled = false and exchange_days = 3; anchor null or approved value `delivery|order_placed`. Initial shipping threshold 500,000; no default consent grant. Null anchor means business confirmation pending.
- Indexes: updated_by_admin_id; singleton PK suffices. Settings updates are authorized/audited with version checks. Admin controls visibility and edits wording; each wording/purpose change creates a new notice version, and consent events preserve the exact version/text presented. Validate submitted grants against the server-issued notice version; stale wording requires presentation again. Visibility changes neither grant nor withdraw consent. Future channel-specific wording/configuration extends these settings without granting other-channel permission. Never store gateway credentials here.

**28. `offers` — simple admin-managed discount definitions.**
- Columns: `id uuid`, `code text?`, `name text`, `version integer`, `kind text`, `fixed_minor bigint?`, `percentage_bps integer?`, `starts_at timestamptz`, `ends_at timestamptz?`, `active boolean`. Future scoped extension in this same table: `scope text`, `product_id uuid?`, `category_id uuid?`, `collection_id uuid?`.
- Keys/constraints: PK `id`; unique normalized code when present; version > 0; kind `fixed|percentage` with exactly the matching value populated; fixed >= 0, basis points 0..10,000; end > start. Minimal V1 supports order-level offers/coupon codes, one winning offer per order. Future scope `order|product|category|collection` uses RESTRICT FKs to the corresponding existing table; exactly the matching target is present, all targets null for order scope. Coupon codes remain order-level; scoped automatic offers have no code. No promotion-target join tables are needed for one target per offer.
- Indexes: `(active, starts_at, id)`; future non-null target FK indexes only when scoped offers are enabled. Compute/validate server-side, cap at eligible merchandise value, use deterministic integer rounding/allocation, and snapshot applied terms and line discounts.

**29. `content_entries` — editable homepage, pages, and size guides.**
- Columns: `id uuid`, `key text`, `kind text`, `title text`, `body jsonb`, `published boolean`, `version integer`, `updated_by_admin_id uuid`.
- Keys/constraints: PK `id`; unique key; FK updated_by -> admin_users; kind `homepage|page|size_guide`; version > 0; validate structured body and sanitize rendered content. Product size-guide FK must target size_guide kind via controlled writes.
- Indexes: `(kind, published, id)`, updated_by_admin_id. Do not embed untracked object keys or arbitrary customer data in body.

**30. `content_media` — explicit content-to-asset references.**
- Columns: `content_id uuid`, `media_asset_id uuid`, `slot_key text`, `alt_text text`.
- Keys/constraints: PK `(content_id, slot_key)`; FKs content -> content_entries (`CASCADE` for link deletion), media -> media_assets (RESTRICT).
- Indexes: media_asset_id. Body references slot keys; publication validates every referenced slot and ready asset.

**31. `audit_logs` — append-only administrative activity evidence.**
- Columns: `id uuid`, `actor_admin_id uuid?`, `actor_kind text`, `action text`, `entity_type text`, `entity_id uuid?`, `request_id text`, `safe_changes jsonb`.
- Keys/constraints: PK `id`; FK actor -> admin_users RESTRICT; actor kind `admin|system`; admin kind requires actor ID. Polymorphic entity ID is an audit locator, not an FK; validate entity type allowlist. Record only redacted field names/safe changes, never credentials, full addresses, or sensitive raw payloads.
- Indexes: `(entity_type, entity_id, created_at DESC, id)`, `(actor_admin_id, created_at DESC, id)`. Restrict update/delete privileges; retention policy remains unresolved.

**32. `notifications` — small durable admin notification/outbox table.**
- Columns: `id uuid`, `recipient_admin_id uuid?`, `order_id uuid?`, `kind text`, `dedup_key text`, `safe_payload jsonb`, `read_at timestamptz?`, `delivery_status text`, `retry_at timestamptz?`, `lease_token uuid?`, `lease_expires_at timestamptz?`, `attempt_count integer`.
- Keys/constraints: PK `id`; FKs admin/order RESTRICT; unique dedup key; delivery `pending|sent|failed`; attempts >= 0; null recipient denotes shared admin inbox. Payload holds IDs and safe labels, not customer contact details.
- Indexes: `(recipient_admin_id, created_at DESC, id)` where unread; pending retry/lease-expiry indexes; non-null order_id index. Workers claim expiring leases and complete only with the current token. External sends occur after commit with dedup keys where supported; delivery is at-least-once and can repeat after ambiguous failures. Order acknowledgement, not notification delivery, drives the global red badge.

### Promotion calculation and precedence

- Evaluate active offers at server checkout time in UTC using `starts_at <= now` and `now < ends_at` (or no end). Scoped offers, when approved later, match product/category/collection membership; order coupons require a valid submitted code. Cart/display prices are indicative until authoritative checkout calculation.
- Proposed minimal precedence: no stacking; choose the eligible offer giving the greatest total merchandise saving. Ties resolve by product, collection, category, then order scope, then stable offer ID; V1 compares order-level candidates only. Business must confirm this policy before activation; advanced stacking, multi-target offers, and usage-limit modules are deferred.
- Start with variant base price * quantity. Compute percentage savings in integer minor units with explicit floor rounding; cap fixed savings at eligible gross value and allocate them proportionally across eligible lines using largest remainders with stable variant-ID ties. Effective line total = gross line value - allocated discount; effective unit display price derives from that line and must not be multiplied back to recalculate totals after rounding.
- Freeze base unit price, line discounts/totals, selected offer ID/version/code/scope/terms, applicable target/membership evidence, and calculation time in order_items/order offer_snapshot. Sum line discounts into orders.discount_minor; use the resulting post-discount subtotal for shipping. Later price, membership, wording, or schedule edits cannot alter historical totals.

## Implementation phasing

This classifies all existing 32 tables, not an implementation roadmap. CORE V1 is needed for the approved baseline; CONDITIONAL V1 is included only when its stated launch condition is confirmed; FUTURE is deferred. Optional customer accounts remain a V1 capability, not a requirement to sign in.

| Existing tables | Classification | Condition / boundary |
| --- | --- | --- |
| categories, products, product_variants, media_assets, product_media | CORE V1 | Essential catalog and media. |
| customers, customer_accounts, marketing_consent_events | CORE V1 | Guest/account identity and explicit consent evidence; no promotional sender is implied. |
| inventory_balances, inventory_reservations, stock_movements | CORE V1 | Authoritative stock and transactional ledger. |
| orders, order_items, payment_attempts, payment_events, payment_transactions, refunds, shipping_rules | CORE V1 | Prepaid acceptance, payment reconciliation/refunds, and frozen charges. |
| admin_roles, admin_users, auth_sessions, business_settings, offers, content_entries, content_media, audit_logs | CORE V1 | Minimal admin/content/settings and order-level offers; scoped offers remain a future extension. |
| collections, collection_products | CONDITIONAL V1 | Only if curated collections are included at launch. |
| customer_addresses | CONDITIONAL V1 | Only if saved-address management is included; checkout snapshots remain core. |
| exchange_requests, exchange_items | CONDITIONAL V1 | Structured exchange processing after policy details are confirmed; publish the three-day policy and provide a staff-handled request path in V1 regardless. |
| notifications | FUTURE | Dedicated inbox/external delivery is optional; the V1 badge queries orders directly. |

Totals: 26 CORE V1, 5 CONDITIONAL V1, 1 FUTURE. For deferred tables, defer dependent optional columns/FKs too (for example stock_movements.exchange_item_id); retain their documented design. Do not create placeholder tables or workers for unused modules. Core order acceptance does not depend on notifications; insert an outbox row atomically only when that module is enabled. Reviews remain outside these 32 tables and unimplemented.

## Relationship diagram

```text
categories 1--* products 1--* product_variants 1--1 inventory_balances
collections *--* products (collection_products)
products 1--* product_media *--1 media_assets 1--* content_media *--1 content_entries
customers 1--0..1 customer_accounts; customers 1--* customer_addresses/marketing_consent_events
customers 1--* orders; customer_accounts 1--* owned orders/auth_sessions
orders 1--* order_items *--1 product_variants; order_items 1--0..1 inventory_reservations
product_variants 1--* stock_movements; reservations 1--* stock_movements
orders 1--* payment_attempts 1--* payment_events/payment_transactions 1--* refunds
orders 1--* exchange_requests 1--* exchange_items *--1 order_items
admin_roles 1--* admin_users 1--* auth_sessions/audit_logs/notifications
business_settings + shipping_rules + offers --> immutable order-time snapshots
```

## Identity, history, and consent safeguards

- Normalize Bangladesh local/international phone input to canonical E.164 through a maintained server parser; reject unsupported/invalid numbers. Do not make the profile phone globally unique: households, shared numbers, and recycled numbers exist.
- Reuse profiles through an authenticated customer ID or an unguessable, server-issued guest identity token whose hash is stored. Contact matches are staff reconciliation candidates only. Guests without stable identity may temporarily create separate profiles; safer reconciliation takes precedence over false ownership merges.
- Registered history queries require `orders.owner_account_id = authenticated_account_id`. Never infer access from customer_id, phone, an order number, or a merge. A guest order starts with no account owner; claiming historical orders requires order-specific verification, explicit policy, an authorized transaction, and an audit event. OTP possession of today's phone alone is insufficient proof of old purchases.
- Do not automatically rewrite order ownership or order/contact snapshots when merging profiles. Preserve original customer links; staff may traverse approved merge links for internal matching, never for customer history authorization. Stable guest tokens are not customer order-history credentials.
- Freeze contact, identity, price, variant, currency, discount, shipping, and exchange-policy snapshots at order placement. Limit any legally required PII erasure to a separately approved process; retain financial amounts/items and record the action.
- Consent grants/withdrawals are append-only evidence for a specific channel/destination/purpose and notice version. Withdrawals suppress promotion immediately. Missing, omitted, unchecked, or hidden consent is never permission; hiding UI does not create a new consent event. Re-enabling UI does not restore withdrawn consent. Future SMS/email/other channels require separate affirmative evidence and channel-appropriate destination validation; no cross-channel grant is inferred.

## Payment lifecycle and new-order badge

- **Online prepaid V1:** pending checkout creation reserves stock but is not order acceptance. Verified successful SSLCOMMERZ payment plus valid reservation consumption atomically sets payment_status = paid and accepted_at, authorizing fulfillment. Unpaid, failed, expired, cancelled, or unallocated late payments never authorize fulfillment. Payment attempts/events remain retained for diagnosis and reconciliation.
- **Optional COD:** availability is unconfirmed and not implemented. If later approved, extend payment_mode/status constraints and define explicit COD acceptance criteria; acceptance/stock allocation may precede cash collection, but payment remains unpaid until collection is independently confirmed. Never synthesize a paid SSLCOMMERZ transaction for COD. COD collection, cancellation, and stock timing require a separate approved policy.
- **Exact badge predicate:** count orders with accepted_at non-null AND acknowledged_at null AND cancelled_at null AND fulfillment_status != cancelled. Prepaid orders enter the count only at the verified-payment/stock-consumption commit, not checkout creation, gateway session creation, browser success redirect, or callback receipt. Failed/pending checkouts and unallocated late payments are excluded. Any later COD eligibility requires explicitly approved acceptance rules first.
- **Acknowledgement:** an authorized admin marks acknowledged_at/by atomically and idempotently; this removes the order from the global red count without changing payment or fulfillment. Shipment/delivery does not implicitly acknowledge an order; cancellation excludes it without forging acknowledgement. Generate a new-order notification only at acceptance if notifications are enabled.

## Order/payment/inventory transaction principles

1. **Checkout:** server validates catalog lifecycle, price, offers, address zone, and settings. Use unique checkout key to return the original result on retries. Freeze rule versions in one consistent read; lock inventory rows in sorted variant-ID order. Atomically reserve only if `on_hand - reserved >= requested`; failure rolls back the entire checkout creation. Insert pending order/items/reservations and reserve ledger entries together; accepted_at stays null and no new-order notification is generated. No cache is stock truth.
2. **Shipping:** compute `net_merchandise = subtotal - discount`; free only when `net_merchandise > threshold`. At threshold use configured base delivery charge. Snapshot calculation inputs and resulting shipping amount. Tax, shipping, gateway fees, and later refunds do not change the comparison or reprice historical orders.
3. **Gateway initiation:** commit the payment attempt before the external call. Use its stable merchant transaction ID; do not hold DB locks during network calls. If initiation times out, reconcile the same attempt before starting another. Expiration/failure does not prove that money was never collected.
4. **Verification:** durably accept recognized callback/IPN events, then validate server-side through SSLCOMMERZ's Transaction Validation API. Match merchant transaction ID, merchant context, successful status, original amount, and currency to the stored attempt. Browser redirects or callback fields alone cannot mark an order paid. Validation/network errors remain retryable and do not fulfil the order.
5. **Apply payment:** after verification, lock order, reservation, and inventory rows using the same global lock order as checkout/expiry/cancellation. Insert the uniquely identified transaction, enforce one applied payment per order, consume only active/unexpired reservations, decrement on_hand and reserved by quantity, write ledger, mark payment paid and accepted_at, and enqueue an acceptance notification only if enabled, atomically. This commit makes the order badge-eligible. On replay, return the already-recorded outcome without resetting acceptance/acknowledgement. Stock is deducted here once, not again at shipment.
6. **Expiry/cancellation race:** workers lock the order first, then reservations and sorted balances; transition only active reservations, release reserved quantities exactly once, and append ledger. Terminal reservations cannot be consumed. Payment verification and expiry serialize on these locks. On a late success, cancelled order, or unusable reservation, record payment as unallocated and route to reconciliation/refund; never force negative stock or silently discard money. Paid cancellation requires its own audited refund/restocking workflow.
7. **Refund/exchange:** lock the payment/original order item before aggregate checks; prevent duplicate refund requests and over-refunds/over-exchanges. Call provider outside DB locks; confirmed results update refund/payment summaries atomically. Refunds alone do not restock. Inspect returned items before creating a stock movement; replacement orders reserve normally. Payment refunds do not overwrite original totals.
8. **Transitions and recovery:** immutable placed-order fields, append-only ledgers, and allowed status transitions use restricted DB write privileges plus transactional service commands/triggers as needed. All writers, including admin scripts, obey the same locks/invariants. Use bounded retries for deadlocks/serialization failures; reconcile ledger/balance and payment totals, never blindly replay external side effects. Prepaid fulfillment requires accepted_at and an applied verified payment; attempt failure changes neither an already paid order nor its acceptance. COD remains a business decision with no enabled flow.

PostgreSQL provides the row locks used here; aggregate rules need explicit locking rather than cross-row CHECKs. [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [row locking](https://www.postgresql.org/docs/18/explicit-locking.html). SSLCOMMERZ requires validation of received IPN messages through its validation API. [SSLCOMMERZ integration documentation](https://developer.sslcommerz.com/doc/v4/).

## Archiving and media-cleanup safety

- Archive/discontinue products and variants to stop new sales, keeping referenced identities/SKUs and order history. Restrict deletion of orders, items, payment attempts/transactions, refunds, stock ledger, and exchange evidence; correction means compensating records, not destructive edits.
- Cascades apply only to disposable membership/content links, saved addresses, and sessions as explicitly listed. Customer/admin deactivation revokes sessions; it does not cascade into orders, audit, consent, or financial records.
- Before scheduling media deletion, check product_media, content_media, and order_items references. Historical order thumbnails pin their media assets; alternative future policies require explicit approval. JSON bodies/snapshots cannot contain hidden unmanaged asset references.
- Cleanup locks the asset row; all new reference writers lock the same row and require ready state. After zero references, mark delete_pending and set a grace deadline, committing before object deletion. Recheck references/state under lock before issuing the external delete; pending assets cannot gain references. Retry idempotently and mark deleted only after storage confirmation; retain tombstone. CDN invalidation follows confirmed cleanup.
- Credentials and storage signing keys stay outside PostgreSQL. Store immutable object keys; derive CDN URLs and temporary signed URLs at the application boundary, not permanent access tokens in the database.

## Performance and security considerations

- Use keyset pagination on timestamp/ID for orders, movements, and audit history; fetch order items in batches. Public product pages use indexed slugs; category/collection browsing uses the listed compound indexes.
- Index every FK needed for parent deletion checks/joins, including partial indexes for nullable FKs. Avoid duplicating indexes already supplied by PK/unique prefixes; add query-specific indexes only with measured plans. Do not partition, shard, or introduce separate services in V1.
- Keep inventory rows narrow, locks short, and lock order consistent. Expiry/retry workers process bounded batches; processing jobs need lease/recovery semantics to avoid stuck work. Reconciliation checks reserved totals against active reservations and balance changes against the ledger.
- CDN/cache serves public media/catalog only. Read live PostgreSQL for reservation/checkout; cache settings with versioned invalidation, but checkout snapshots authoritative values. Use separate least-privilege migration/runtime/admin-worker DB roles; parameterized queries, encrypted transport/backups, and tested restore procedures.
- Customer history/detail responses enforce account ownership and avoid shared caching. Admin PII access is role-limited and audited. Payment/card data, secrets, bearer tokens, and raw gateway bodies must never enter audit logs, JSON payloads, notifications, or media records.
- This blueprint does not select a PostgreSQL version, host, authentication provider, or deployment service. Confirm Prisma support for intended partial indexes/checks when implementation is approved; any required SQL constraints remain mandatory regardless of ORM ergonomics.

## Future reviews — extension points only

Reviews remain disabled and hidden. No review tables, endpoints, workflows, or migrations in V1. A later approved module may reference product/account/verified order-item IDs, store moderation state, and expose only admin-approved reviews. Current stable IDs provide extension points without implementing that module.

## Critical risks and unresolved decisions

- Confirm proposed stack and managed hosting/database/object-storage/CDN providers; authentication method/provider and order-claim proof policy also need approval.
- Confirm delivery zones, charges, courier tracking/delivery evidence, unsupported areas, and whether cash-on-delivery or other non-prepaid flows are required. No such payment method is assumed implemented.
- Confirm exchange anchor (delivery remains unconfirmed), what “three days” means at the boundary, eligibility conditions, exchange shipping charges, replacement price differences, and staff override rules. Do not activate automatic deadlines until agreed.
- Confirm reservation duration, checkout/payment expiry alignment, and late-payment reconciliation/refund policy. Late gateway success and duplicate successful attempts are operational risks even with correct DB deduplication.
- Confirm tax applicability/rounding, the proposed greatest-saving/non-stacking promotion precedence and rounding, scoped-offer launch timing/usage limits, allowed free orders, default low-stock threshold, promotional channels/notice wording/version-change re-consent policy, and retention/PII-erasure policy. These are unanswered decisions, not assumed functionality.
- Confirm the simplifying cardinalities (one category, flat taxonomy, one fulfillment, one admin role), whether product slugs may change, and global versus per-admin order acknowledgement. Proposed global acknowledgement satisfies the current badge requirement without per-admin receipt tables.
- Phone reuse/merge mistakes can expose historical orders; never relax explicit account ownership checks to improve deduplication. Aggregate refund/exchange/stock invariants fail if any writer bypasses the controlled transactional path.
