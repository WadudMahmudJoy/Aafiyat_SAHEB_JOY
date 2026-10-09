# Aafiyat Development Status

Checkpoint: Tasks 001–009C completed; Task 009C variant/pricing checkpoint verification, 10 October 2026.

## Completed work

- Task 001: repository preflight and requirements baseline.
- Task 002: PostgreSQL database blueprint.
- Task 002A: focused payment, promotion, consent, badge, and phasing corrections.
- Task 003: minimal Next.js foundation in the existing repository root.
- Task 004: local Docker Compose PostgreSQL and model-free Prisma setup.
- Task 005: four initial models and verified initial migration.
- Task 006: server-side Prisma runtime connection and idempotent category seed.
- Task 007: server-only public catalog read service with safe DTOs and cursor pagination.
- Task 007A: 21 live PostgreSQL integration checks passed; fixtures rolled back.
- Tasks 008A–008E: Better Auth identity/session schema, roles, HTTP handler, and session-bound MFA proof.
- Tasks 008F–008I: server-side MFA authorization and controlled local Owner onboarding; security fixes verified.
- Tasks 008K–008M: disposable preview, Windows popup visibility fix, offline QR/manual-key UI, and operator acceptance completed.
- Task 008O: TEST-only rehearsal utility, exact-ID cleanup, guarded recovery journal, and operator guide.
- Task 008P and focused fixes: safe login diagnostics and memory-only confirmed password reuse; full interactive rehearsal operator-confirmed PASS.
- Task 008Q and polish: branded email/password and separate TOTP login, server-protected /admin entry, role-only session API, sign-out/session-expiry handling, and favicon.
- Task 008R and polish: unified OWNER dashboard, server-permission-derived staff navigation, responsive shell, safe identity display, and upcoming module placeholders. Existing four-role RBAC and mandatory MFA preserved.
- Task 009A: protected read-only /admin/products and /admin/products/[id], integrated with dashboard navigation; name/slug search, category filters, and stable bounded cursor pagination.
- Catalogue requires server-authorized catalog:read; exact inventory is selected and returned only with inventory:manage. Existing MFA, membership, and session checks remain mandatory; public catalogue is unchanged.
- Task 009B: protected /admin/products/new and /admin/products/[id]/edit provide DRAFT creation and six-field metadata editing only; authorized Add/Edit navigation is integrated.
- Draft writes require catalog:write, current MFA-backed active membership, same-origin requests, and server validation. Category references and duplicate slugs are checked; row locking and exact microsecond revisions prevent stale overwrites. Lifecycle and privileged fields cannot be submitted.
- Task 009C: protected DRAFT variant creation/editing routes manage SKU, size/color codes and labels, and BDT prices. Global SKU and product size/color uniqueness are enforced; exact BIGINT poisha conversion rejects malformed, negative, and overflowing amounts.
- Variant writes retain existing catalog:write, fresh session-bound MFA, active membership, same-origin protection, and field allowlisting. Parent-first locks, exact revisions, and product/variant binding guard lifecycle races, stale edits, and cross-product tampering. Inventory and public catalogue contracts are unchanged.
- Authentication is **NOT production-ready**. Production deployment, recovery policy, and operational security review remain pending.

## Current stack

- Next.js 16.4.0 App Router, React 19.3.0, and strict TypeScript 6.0.3.
- Tailwind CSS 4.3.3, ESLint 9.39.5, and pnpm 11.1.2.
- Prisma CLI/Client/PostgreSQL adapter 7.10.0; pg driver 8.23.1.
- Better Auth 1.7.7 owns identity, credential accounts, sessions, and TOTP factors.
- Node.js 24; src/ directory and @/* import alias.
- Modular monolith; commerce integrations remain unimplemented.

## Local database

- Docker Compose project: aafiyat-saheb-joy-local; service: postgres.
- Image: postgres:18.6-bookworm; verified running version: PostgreSQL 18.6.
- Host binding: 127.0.0.1:55432; container port: 5432.
- Database: aafiyat_dev; schema: public; named persistent volume: postgres_data.
- Local .env is ignored; .env.example contains placeholders, not passwords.
- Initial migration: 20261009000000_init_catalog_inventory; applied and current.
- Three additive authentication migrations add framework tables, admin roles/memberships, and private session MFA proof.
- Models: Category, Product, ProductVariant, InventoryBalance.
- Available inventory is derived from on_hand minus reserved.
- Generated Prisma Client is ignored; regenerate with pnpm exec prisma generate.

## Seed and completed verification

- Seed command: pnpm run db:seed; restricted to the existing local database.
- Categories: T-Shirt (t-shirts), Half Shirt (half-shirts), Full Shirt (full-shirts).
- Categories continued: Panjabi (panjabi), Sherwani (sherwani).
- First seed created five; second created zero and preserved all existing fields.
- Prisma retrieved exactly five categories; catalog product/inventory tables remain empty.
- Runtime connection, missing-URL failure, and client reuse on module reload passed.
- Migration checksum/status and supported-schema drift comparison passed.
- Verified 17 CHECK constraints, 3 restrictive FKs, 4 PKs, and 12 indexes.
- All 41 invalid-write probes and valid boundary tests passed; probes rolled back.
- TypeScript, ESLint, production build, and whitespace checks passed.
- Docker Engine was unavailable in Task 004; live verification passed in Task 005.
- Catalog visibility, stock labels, DTO protection, pagination, and BIGINT checks passed.
- After live catalog testing: five categories; zero products, variants, or balances.
- Authentication checks: 21 onboarding, 23 MFA/live authorization, 22 authorization, and 19 HTTP checks passed; viewer suite expanded to 16 checks.
- Rehearsal guards (18) and credential reuse/login checks (22) passed, including post-activation login.
- Latest disposable fixture cleanup restored all 12 table fingerprints, including migration metadata. Four roles, no auth users/admin memberships; no real Owner exists.
- Automated viewer checks cover exact QR/URI round-trip, manual-key matching/fallback, transport, native lifecycle, and parent cleanup.
- Separately, operator-confirmed Task 008M: all seven manual checks passed—QR visibility/scanning, labels, Show/Hide, Done/X, Ctrl+C/timeout, and no observed secret output/persistent files.
- Operator-confirmed Task 008P: inactive creation, enrollment, MFA login, atomic activation, permissions/revocation, post-activation login, exact cleanup, all 12 fingerprints, and final preflight passed.
- No real Owner account exists; only disposable fixtures were provisioned/activated. Interactive rehearsal is not rerun for this checkpoint.
- Login checkpoint: 10 form/transport/accessibility, 11 live login/access, 19 HTTP, 23 MFA, and 22 authorization checks passed (85 total); all 12 fixture fingerprints restored.
- Desktop/mobile design accepted by the operator; 375×667 and 320×568 spacing verified without horizontal overflow, with accessible controls preserved. Favicon returns HTTP 200.
- Unauthenticated /admin redirects to the fixed login route; session API returns generic 401 without private data; login remains public. TypeScript, ESLint, production build, and whitespace checks passed.
- Dashboard checkpoint: 13 policy/access, 9 presentation/UTF-8, 7 session/sign-out, 10 login form, 12 live login, 19 HTTP, 23 MFA, and 22 authorization checks passed (115 total); all 12 database fingerprints restored.
- Supervisor accepted desktop/mobile design. Chrome checks at 320×568, 375×667, 393×852, 768×1024, and 1440×900 passed without horizontal overflow; keyboard Workspace menu open/close and focus verified.
- Offline preview is explicitly unauthenticated, uses a disabled mock sign-out, writes UTF-8 directly, and is ignored by Git. Original file-origin warning was not reproduced in clean Chrome under file:// or HTTP; no preview scripts or external resources exist.
- Catalogue checkpoint: 20 database/service and 11 route/presentation/grammar checks, 21 live public catalogue checks, and 115 affected dashboard/login/HTTP/MFA/RBAC checks passed (167 total), plus public contract regressions. TypeScript, ESLint, production build, and whitespace checks passed.
- Product listing/detail designs approved by the supervisor; prior TEST previews verified at all five dashboard viewport sizes. All 12 database fingerprints restored; five categories, four roles, no products or authentication identities remain.
- Draft checkpoint: 20 write/security and 11 form/navigation/route checks, plus affected catalogue, public, dashboard, login, HTTP, MFA, and RBAC checks passed (198 total), with additional public contract regressions. TypeScript, ESLint, production build, and whitespace checks passed.
- Add/Edit designs approved by the supervisor; prior disposable previews verified responsive controls and keyboard focus at all five viewport sizes. Fixture rollback restored all 12 fingerprints; final read-only preflight passed with five categories, four roles, and no products, Owner memberships, or authentication identities. Real-admin browser acceptance remains pending.
- Variant checkpoint: 25 write/security, 5 concurrency/recovery, and 10 form/route checks plus 198 affected regressions passed (238 total), with additional public contract checks. TypeScript, ESLint, production build, and whitespace checks passed; all 12 fingerprints restored and final local preflight passed.
- Add/Edit Variant designs approved by the supervisor; prior static TEST previews passed all five viewport sizes and keyboard checks. Price helper wording simplified without changing monetary limits. Five categories and four roles remain; no test products, variants, balances, authentication identities, or permanent Owner exist. Real-admin browser acceptance remains pending.

## Scope and pending decisions

- Reviews are deferred, disabled, and hidden in V1; no review module exists.
- COD availability and collection/stock policy require business confirmation.
- Exchange start time, three-day boundary, eligibility, and charges remain unresolved.
- Delivery zones/rates, reservation duration, and late-payment policy need confirmation.
- Promotion precedence/rounding, tax, consent channels/wording, and retention remain open.
- Authentication/order-claim policy and final cloud providers are not selected.
- Conditional launch modules and simplifying cardinalities await confirmation.
- See the requirements and database blueprint for the authoritative detail.

Remaining: real-admin browser/MFA acceptance, production deployment, recovery policy, and operational security review. Authentication is not production-ready.
Next work requires separate review and authorization; no real Owner provisioning is included.
Inventory adjustments, media management, and publishing remain upcoming. Orders, marketing, and administration business modules, staff onboarding, customers, and payments remain unimplemented; real-admin catalogue, draft, and variant-editing acceptance is pending.
