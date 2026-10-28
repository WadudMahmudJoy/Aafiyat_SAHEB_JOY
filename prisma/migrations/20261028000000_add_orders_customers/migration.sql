-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "display_name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "email" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "identity_issuer" TEXT NOT NULL,
    "identity_subject" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "owner_account_id" UUID,
    "currency" CHAR(3) NOT NULL DEFAULT 'BDT',
    "subtotal_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "shipping_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "payment_mode" TEXT NOT NULL DEFAULT 'online_prepaid',
    "payment_status" TEXT NOT NULL DEFAULT 'unpaid',
    "fulfillment_status" TEXT NOT NULL DEFAULT 'unfulfilled',
    "accepted_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" UUID,
    "delivered_at" TIMESTAMPTZ(6),
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "contact_email" TEXT,
    "shipping_address" TEXT NOT NULL,
    "shipping_rule_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "creation_xid" BIGINT NOT NULL DEFAULT txid_current(),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "size_label" TEXT NOT NULL,
    "color_label" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_created_at_id_idx" ON "customers"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "customers_phone_e164_idx" ON "customers"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_customer_id_key" ON "customer_accounts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_identity_issuer_identity_subject_key" ON "customer_accounts"("identity_issuer", "identity_subject");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_customer_id_id_key" ON "customer_accounts"("customer_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_created_at_id_idx" ON "orders"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "orders_customer_id_created_at_id_idx" ON "orders"("customer_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "orders_owner_account_id_idx" ON "orders"("owner_account_id");

-- CreateIndex
CREATE INDEX "orders_acknowledged_by_idx" ON "orders"("acknowledged_by");

-- CreateIndex
CREATE INDEX "orders_payment_status_created_at_id_idx" ON "orders"("payment_status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "orders_fulfillment_status_created_at_id_idx" ON "orders"("fulfillment_status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "order_items_variant_id_idx" ON "order_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_variant_id_key" ON "order_items"("order_id", "variant_id");

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_id_idx" ON "order_events"("order_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "order_events_actor_admin_id_idx" ON "order_events"("actor_admin_id");

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_owner_account_id_fkey" FOREIGN KEY ("customer_id", "owner_account_id") REFERENCES "customer_accounts"("customer_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_admin_id_fkey" FOREIGN KEY ("actor_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- No customer login, identity-claim, consent or checkout writer is introduced.
ALTER TABLE customers ADD CONSTRAINT customers_profile_valid CHECK (
 length(btrim(display_name)) BETWEEN 1 AND 200 AND phone_e164 ~ '^\+[1-9][0-9]{6,14}$' AND (email IS NULL OR length(email) BETWEEN 3 AND 254));
ALTER TABLE customer_accounts ADD CONSTRAINT customer_account_identity_valid CHECK (
 length(btrim(identity_issuer)) BETWEEN 1 AND 200 AND length(btrim(identity_subject)) BETWEEN 1 AND 500);
ALTER TABLE orders ADD CONSTRAINT order_finances_valid CHECK (
 currency='BDT' AND subtotal_minor>=0 AND discount_minor BETWEEN 0 AND subtotal_minor AND shipping_minor>=0 AND tax_minor>=0 AND total_minor>=0 AND
 total_minor::numeric = subtotal_minor::numeric-discount_minor::numeric+shipping_minor::numeric+tax_minor::numeric);
ALTER TABLE orders ADD CONSTRAINT order_states_valid CHECK (
 payment_mode='online_prepaid' AND payment_status IN ('unpaid','pending','paid','partially_refunded','refunded') AND
 fulfillment_status IN ('unfulfilled','processing','shipped','delivered','cancelled') AND
 (accepted_at IS NULL OR payment_status IN ('paid','partially_refunded','refunded')) AND
 (fulfillment_status NOT IN ('processing','shipped','delivered') OR accepted_at IS NOT NULL) AND
 ((cancelled_at IS NOT NULL)=(fulfillment_status='cancelled')) AND
 ((delivered_at IS NOT NULL)=(fulfillment_status='delivered')) AND
 ((acknowledged_at IS NULL)=(acknowledged_by IS NULL)) AND
 (acknowledged_at IS NULL OR accepted_at IS NOT NULL));
ALTER TABLE orders ADD CONSTRAINT order_snapshot_valid CHECK (
 length(btrim(order_number)) BETWEEN 1 AND 64 AND length(btrim(contact_name)) BETWEEN 1 AND 200 AND
 contact_phone ~ '^\+[1-9][0-9]{6,14}$' AND length(btrim(shipping_address)) BETWEEN 1 AND 2000 AND
 (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254) AND
 jsonb_typeof(shipping_rule_snapshot)='object' AND shipping_rule_snapshot ? 'version' AND
 jsonb_typeof(policy_snapshot)='object' AND policy_snapshot ? 'version');
ALTER TABLE order_items ADD CONSTRAINT order_item_snapshot_valid CHECK (
 quantity>0 AND unit_price_minor>=0 AND discount_minor>=0 AND total_minor>=0 AND
 quantity::numeric*unit_price_minor::numeric<=9223372036854775807 AND
 discount_minor::numeric<=quantity::numeric*unit_price_minor::numeric AND
 total_minor::numeric=quantity::numeric*unit_price_minor::numeric-discount_minor::numeric AND
 length(btrim(product_name)) BETWEEN 1 AND 300 AND length(btrim(sku)) BETWEEN 1 AND 100 AND
 length(btrim(size_label)) BETWEEN 1 AND 100 AND length(btrim(color_label)) BETWEEN 1 AND 100);
ALTER TABLE order_events ADD CONSTRAINT order_event_valid CHECK (
 (kind='recorded' AND actor_admin_id IS NULL) OR (kind='acknowledged' AND actor_admin_id IS NOT NULL));
CREATE UNIQUE INDEX order_ack_event_once ON order_events(order_id) WHERE kind='acknowledged';
CREATE INDEX order_unacknowledged_accepted ON orders(created_at DESC,id DESC)
 WHERE accepted_at IS NOT NULL AND acknowledged_at IS NULL AND cancelled_at IS NULL AND fulfillment_status<>'cancelled';

-- Creation transaction binding and acknowledgement fields are server-owned.
CREATE FUNCTION initialize_order_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.creation_xid := txid_current();
 IF NEW.acknowledged_at IS NOT NULL OR NEW.acknowledged_by IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='New orders cannot be pre-acknowledged';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER orders_initialize BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION initialize_order_record();
ALTER TABLE orders ENABLE ALWAYS TRIGGER orders_initialize;

-- Historical rows cannot be rewritten. Payment/acceptance/fulfillment protocols
-- must deliberately extend this gate in a separately reviewed future migration.
CREATE FUNCTION protect_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Order history is retained'; END IF;
 IF (to_jsonb(NEW)-'acknowledged_at'-'acknowledged_by') IS DISTINCT FROM (to_jsonb(OLD)-'acknowledged_at'-'acknowledged_by') THEN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Order snapshots and status transitions are protected';
 END IF;
 IF OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at,NEW.acknowledged_by) IS DISTINCT FROM (OLD.acknowledged_at,OLD.acknowledged_by) THEN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Acknowledgement is immutable';
 END IF;
 IF NEW.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS NULL AND
    (OLD.accepted_at IS NULL OR OLD.cancelled_at IS NOT NULL OR OLD.fulfillment_status='cancelled') THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Order is not eligible for acknowledgement';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER orders_protect BEFORE UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_snapshot();
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON orders FOR EACH STATEMENT EXECUTE FUNCTION protect_order_snapshot();
ALTER TABLE orders ENABLE ALWAYS TRIGGER orders_protect;
ALTER TABLE orders ENABLE ALWAYS TRIGGER orders_no_truncate;
CREATE FUNCTION protect_order_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Order items are immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND creation_xid=txid_current()) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Items must be recorded with the order';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_items_protect BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION protect_order_item();
CREATE TRIGGER order_items_no_truncate BEFORE TRUNCATE ON order_items FOR EACH STATEMENT EXECUTE FUNCTION protect_order_item();
ALTER TABLE order_items ENABLE ALWAYS TRIGGER order_items_protect;
ALTER TABLE order_items ENABLE ALWAYS TRIGGER order_items_no_truncate;
CREATE FUNCTION check_order_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE; gross numeric; discounts numeric; item_count bigint;
BEGIN
 IF TG_TABLE_NAME='orders' THEN SELECT * INTO o FROM orders WHERE id=NEW.id;
 ELSE SELECT * INTO o FROM orders WHERE id=NEW.order_id; END IF;
 SELECT count(*),COALESCE(sum(quantity::numeric*unit_price_minor::numeric),0),COALESCE(sum(discount_minor::numeric),0)
 INTO item_count,gross,discounts FROM order_items WHERE order_id=o.id;
 IF item_count<1 OR item_count>200 OR gross<>o.subtotal_minor OR discounts<>o.discount_minor THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Order item totals do not match';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_totals_at_commit AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_totals();
CREATE CONSTRAINT TRIGGER item_totals_at_commit AFTER INSERT ON order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_totals();
CREATE FUNCTION record_order_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN INSERT INTO order_events(order_id,kind) VALUES(NEW.id,'recorded');
 ELSIF OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL THEN
  INSERT INTO order_events(order_id,kind,actor_admin_id,created_at) VALUES(NEW.id,'acknowledged',NEW.acknowledged_by,NEW.acknowledged_at);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER order_evidence AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION record_order_evidence();
CREATE FUNCTION protect_order_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Order evidence is append-only'; END IF;
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Order evidence is database-derived'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_events_protect BEFORE INSERT OR UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION protect_order_evidence();
CREATE TRIGGER order_events_no_truncate BEFORE TRUNCATE ON order_events FOR EACH STATEMENT EXECUTE FUNCTION protect_order_evidence();
ALTER TABLE order_events ENABLE ALWAYS TRIGGER order_events_protect;
ALTER TABLE order_events ENABLE ALWAYS TRIGGER order_events_no_truncate;
