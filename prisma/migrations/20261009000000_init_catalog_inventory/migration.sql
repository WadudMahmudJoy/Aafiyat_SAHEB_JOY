-- Apply the initial schema and custom constraints atomically.
BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "seo_title" TEXT,
    "seo_description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'draft',
    "archived_at" TIMESTAMPTZ(6),
    "seo_title" TEXT,
    "seo_description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "size_code" TEXT NOT NULL,
    "size_label" TEXT NOT NULL,
    "color_code" TEXT NOT NULL,
    "color_label" TEXT NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'BDT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "variant_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "low_stock_threshold" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("variant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_active_sort_order_id_idx" ON "categories"("active", "sort_order", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_category_id_lifecycle_created_at_id_idx" ON "products"("category_id", "lifecycle", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "product_variants_product_id_active_id_idx" ON "product_variants"("product_id", "active", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_product_id_size_code_color_code_key" ON "product_variants"("product_id", "size_code", "color_code");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_product_id_id_key" ON "product_variants"("product_id", "id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma cannot express these PostgreSQL CHECK constraints in its schema.
-- Slugs use canonical lowercase ASCII URL segments; SKUs use trimmed uppercase.
ALTER TABLE "categories"
    ADD CONSTRAINT "categories_name_nonempty" CHECK (btrim("name") <> ''),
    ADD CONSTRAINT "categories_slug_normalized" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "products"
    ADD CONSTRAINT "products_name_nonempty" CHECK (btrim("name") <> ''),
    ADD CONSTRAINT "products_slug_normalized" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    ADD CONSTRAINT "products_lifecycle_allowed" CHECK ("lifecycle" IN ('draft', 'active', 'discontinued', 'archived')),
    ADD CONSTRAINT "products_archive_consistent" CHECK (("lifecycle" = 'archived') = ("archived_at" IS NOT NULL));

ALTER TABLE "product_variants"
    ADD CONSTRAINT "product_variants_sku_normalized" CHECK ("sku" <> '' AND "sku" = upper(btrim("sku"))),
    ADD CONSTRAINT "product_variants_size_code_normalized" CHECK ("size_code" <> '' AND "size_code" = lower(btrim("size_code"))),
    ADD CONSTRAINT "product_variants_color_code_normalized" CHECK ("color_code" <> '' AND "color_code" = lower(btrim("color_code"))),
    ADD CONSTRAINT "product_variants_labels_nonempty" CHECK (btrim("size_label") <> '' AND btrim("color_label") <> ''),
    ADD CONSTRAINT "product_variants_price_nonnegative" CHECK ("price_minor" >= 0),
    ADD CONSTRAINT "product_variants_currency_supported" CHECK ("currency" = 'BDT'),
    ADD CONSTRAINT "product_variants_archive_inactive" CHECK ("archived_at" IS NULL OR NOT "active");

ALTER TABLE "inventory_balances"
    ADD CONSTRAINT "inventory_balances_on_hand_nonnegative" CHECK ("on_hand" >= 0),
    ADD CONSTRAINT "inventory_balances_reserved_nonnegative" CHECK ("reserved" >= 0),
    ADD CONSTRAINT "inventory_balances_reserved_within_stock" CHECK ("reserved" <= "on_hand"),
    ADD CONSTRAINT "inventory_balances_threshold_nonnegative" CHECK ("low_stock_threshold" IS NULL OR "low_stock_threshold" >= 0);

COMMIT;
