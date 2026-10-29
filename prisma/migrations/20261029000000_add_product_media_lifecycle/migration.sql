BEGIN;
-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "actor_admin_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'image/webp',
    "byte_size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "stored_hash" VARCHAR(64) NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "delete_after" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_media" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "asset_id" UUID NOT NULL,
    "alt_text" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_cover" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_lifecycle_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "actor_admin_id" UUID NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "revision" VARCHAR(27) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "product_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_object_key_key" ON "media_assets"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_idempotency_key_key" ON "media_assets"("idempotency_key");

-- CreateIndex
CREATE INDEX "media_assets_actor_admin_id_idx" ON "media_assets"("actor_admin_id");

-- CreateIndex
CREATE INDEX "media_assets_state_delete_after_id_idx" ON "media_assets"("state", "delete_after", "id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_product_id_id_key" ON "media_assets"("product_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_media_asset_id_key" ON "product_media"("asset_id");

-- CreateIndex
CREATE INDEX "product_media_variant_id_idx" ON "product_media"("variant_id");

-- CreateIndex
ALTER TABLE product_media ADD CONSTRAINT product_media_product_id_sort_order_key UNIQUE(product_id,sort_order) DEFERRABLE INITIALLY IMMEDIATE;

-- CreateIndex
CREATE INDEX "product_lifecycle_events_product_id_created_at_id_idx" ON "product_lifecycle_events"("product_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "product_lifecycle_events_actor_admin_id_idx" ON "product_lifecycle_events"("actor_admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_lifecycle_events_product_id_revision_key" ON "product_lifecycle_events"("product_id", "revision");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_actor_admin_id_fkey" FOREIGN KEY ("actor_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_variant_id_fkey" FOREIGN KEY ("product_id", "variant_id") REFERENCES "product_variants"("product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_asset_id_fkey" FOREIGN KEY ("product_id", "asset_id") REFERENCES "media_assets"("product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_lifecycle_events" ADD CONSTRAINT "product_lifecycle_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_lifecycle_events" ADD CONSTRAINT "product_lifecycle_events_actor_admin_id_fkey" FOREIGN KEY ("actor_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE media_assets ADD COLUMN ready_at timestamptz(6);
ALTER TABLE media_assets ADD COLUMN upload_attempt_id uuid;
ALTER TABLE media_assets ADD COLUMN upload_attempt_expires_at timestamptz(6);
ALTER TABLE media_assets ADD COLUMN reconcile_after timestamptz(6) NOT NULL DEFAULT 'epoch';
ALTER TABLE media_assets ADD COLUMN reconcile_claim_id uuid;
CREATE INDEX media_assets_reconcile_after_id_idx ON media_assets(reconcile_after,id);
ALTER TABLE media_assets ADD CONSTRAINT media_attempt_pair CHECK ((upload_attempt_id IS NULL) = (upload_attempt_expires_at IS NULL));
ALTER TABLE media_assets ADD CONSTRAINT media_asset_safe CHECK (
 (state<>'ready' OR ready_at IS NOT NULL) AND state IN ('pending','ready','delete_pending','deleted') AND mime_type='image/webp' AND byte_size BETWEEN 1 AND 8388608 AND width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192 AND width::bigint*height<=40000000 AND
 stored_hash ~ '^[0-9a-f]{64}$' AND request_fingerprint ~ '^[0-9a-f]{64}$' AND
 object_key='products/'||product_id::text||'/'||id::text||'.webp' AND (state NOT IN ('delete_pending','deleted') OR delete_after IS NOT NULL));
ALTER TABLE product_media ADD CONSTRAINT product_media_metadata_valid CHECK(sort_order BETWEEN 0 AND 19 AND char_length(btrim(alt_text)) BETWEEN 1 AND 300);
CREATE UNIQUE INDEX product_media_one_cover ON product_media(product_id) WHERE is_cover;
ALTER TABLE product_lifecycle_events ADD CONSTRAINT product_event_transition_valid CHECK (
 (from_state='draft' AND to_state IN ('active','archived')) OR (from_state='active' AND to_state='discontinued') OR (from_state='discontinued' AND to_state='archived'));
CREATE FUNCTION guard_media_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Media assets retain tombstones'; END IF;
 IF (to_jsonb(OLD)-'state'-'delete_after'-'ready_at'-'upload_attempt_id'-'upload_attempt_expires_at'-'reconcile_after'-'reconcile_claim_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'delete_after'-'ready_at'-'upload_attempt_id'-'upload_attempt_expires_at'-'reconcile_after'-'reconcile_claim_id') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Media identity is immutable'; END IF;
 IF OLD.ready_at IS NOT NULL AND OLD.ready_at IS DISTINCT FROM NEW.ready_at THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Ready receipt is immutable'; END IF;
 IF OLD.state<>NEW.state AND NOT ((OLD.state='pending' AND NEW.state IN ('ready','delete_pending')) OR (OLD.state='ready' AND NEW.state='delete_pending') OR (OLD.state='delete_pending' AND NEW.state='deleted')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid media lifecycle'; END IF;
 IF NEW.state<>'ready' AND EXISTS(SELECT 1 FROM product_media WHERE asset_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Referenced media must remain ready'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_asset_guard BEFORE UPDATE OR DELETE ON media_assets FOR EACH ROW EXECUTE FUNCTION guard_media_asset();
CREATE FUNCTION guard_product_media() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a media_assets%ROWTYPE;
BEGIN
 SELECT * INTO a FROM media_assets WHERE id=NEW.asset_id FOR UPDATE;
 IF a.id IS NULL OR a.state<>'ready' OR a.product_id<>NEW.product_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Only bound ready assets can be linked'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_media_guard BEFORE INSERT OR UPDATE ON product_media FOR EACH ROW EXECUTE FUNCTION guard_product_media();
CREATE FUNCTION check_gallery_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; n bigint; covers bigint;
BEGIN
 IF TG_OP='DELETE' THEN pid=OLD.product_id; ELSE pid=NEW.product_id; END IF;
 SELECT count(*),count(*) FILTER(WHERE is_cover) INTO n,covers FROM product_media WHERE product_id=pid;
 IF n>20 OR (n>0 AND covers<>1) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A gallery requires exactly one cover and at most twenty images'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gallery_shape AFTER INSERT OR UPDATE OR DELETE ON product_media DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_gallery_shape();
CREATE FUNCTION guard_product_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.lifecycle<>NEW.lifecycle AND NOT ((OLD.lifecycle='draft' AND NEW.lifecycle IN ('active','archived')) OR (OLD.lifecycle='active' AND NEW.lifecycle='discontinued') OR (OLD.lifecycle='discontinued' AND NEW.lifecycle='archived')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid product transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_transition_guard BEFORE UPDATE OF lifecycle ON products FOR EACH ROW EXECUTE FUNCTION guard_product_transition();
CREATE FUNCTION protect_product_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Product lifecycle evidence is append-only'; END $$;
CREATE TRIGGER product_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON product_lifecycle_events FOR EACH STATEMENT EXECUTE FUNCTION protect_product_event();
ALTER TABLE product_lifecycle_events ENABLE ALWAYS TRIGGER product_events_append_only;

COMMIT;
