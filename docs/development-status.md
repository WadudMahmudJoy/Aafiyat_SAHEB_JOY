# Aafiyat Development Status

Checkpoint: Tasks 001–007A completed, 9 October 2026.

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

## Current stack

- Next.js 16.4.0 App Router, React 19.3.0, and strict TypeScript 6.0.3.
- Tailwind CSS 4.3.3, ESLint 9.39.5, and pnpm 11.1.2.
- Prisma CLI/Client/PostgreSQL adapter 7.10.0; pg driver 8.23.1.
- Node.js 24; src/ directory and @/* import alias.
- Modular monolith; application integrations remain unimplemented.

## Local database

- Docker Compose project: aafiyat-saheb-joy-local; service: postgres.
- Image: postgres:18.6-bookworm; verified running version: PostgreSQL 18.6.
- Host binding: 127.0.0.1:55432; container port: 5432.
- Database: aafiyat_dev; schema: public; named persistent volume: postgres_data.
- Local .env is ignored; .env.example contains placeholders, not passwords.
- Initial migration: 20261009000000_init_catalog_inventory; applied and current.
- Models: Category, Product, ProductVariant, InventoryBalance.
- Available inventory is derived from on_hand minus reserved.
- Generated Prisma Client is ignored; regenerate with pnpm exec prisma generate.

## Seed and completed verification

- Seed command: pnpm run db:seed; restricted to the existing local database.
- Categories: T-Shirt (t-shirts), Half Shirt (half-shirts), Full Shirt (full-shirts).
- Categories continued: Panjabi (panjabi), Sherwani (sherwani).
- First seed created five; second created zero and preserved all existing fields.
- Prisma retrieved exactly five categories; other application tables stayed empty.
- Runtime connection, missing-URL failure, and client reuse on module reload passed.
- Migration checksum/status and supported-schema drift comparison passed.
- Verified 17 CHECK constraints, 3 restrictive FKs, 4 PKs, and 12 indexes.
- All 41 invalid-write probes and valid boundary tests passed; probes rolled back.
- TypeScript, ESLint, production build, and whitespace checks passed.
- Docker Engine was unavailable in Task 004; live verification passed in Task 005.
- Catalog visibility, stock labels, DTO protection, pagination, and BIGINT checks passed.
- After live catalog testing: five categories; zero products, variants, or balances.

## Scope and pending decisions

- Reviews are deferred, disabled, and hidden in V1; no review module exists.
- COD availability and collection/stock policy require business confirmation.
- Exchange start time, three-day boundary, eligibility, and charges remain unresolved.
- Delivery zones/rates, reservation duration, and late-payment policy need confirmation.
- Promotion precedence/rounding, tax, consent channels/wording, and retention remain open.
- Authentication/order-claim policy and final cloud providers are not selected.
- Conditional launch modules and simplifying cardinalities await confirmation.
- See the requirements and database blueprint for the authoritative detail.

Next planned task: admin authentication foundation, subject to supervisor review.
No APIs, catalog management UI, customers, orders, payments, or admin features yet.
