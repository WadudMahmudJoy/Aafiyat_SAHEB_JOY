# Aafiyat Development Status

Checkpoint: Tasks 001–008M completed, 9 October 2026; local GUI acceptance operator-confirmed.

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
- Temporary identities removed; all 11 database fingerprints restored. Four roles, no auth users/admin memberships; no real Owner exists.
- Automated viewer checks cover exact QR/URI round-trip, manual-key matching/fallback, transport, native lifecycle, and parent cleanup.
- Separately, operator-confirmed Task 008M: all seven manual checks passed—QR visibility/scanning, labels, Show/Hide, Done/X, Ctrl+C/timeout, and no observed secret output/persistent files.
- No real Owner account exists; these tasks performed no real provisioning or activation. No new human GUI acceptance is claimed in 008N.

## Scope and pending decisions

- Reviews are deferred, disabled, and hidden in V1; no review module exists.
- COD availability and collection/stock policy require business confirmation.
- Exchange start time, three-day boundary, eligibility, and charges remain unresolved.
- Delivery zones/rates, reservation duration, and late-payment policy need confirmation.
- Promotion precedence/rounding, tax, consent channels/wording, and retention remain open.
- Authentication/order-claim policy and final cloud providers are not selected.
- Conditional launch modules and simplifying cardinalities await confirmation.
- See the requirements and database blueprint for the authoritative detail.

Next: controlled Owner onboarding rehearsal and Admin Login UI, subject to separate authorization.
No real Owner provisioning, admin UI/CRUD, customers, orders, or payments implemented.
