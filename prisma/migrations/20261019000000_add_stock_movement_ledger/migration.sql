-- PREPARED ONLY: requires supervisory approval before application.
-- Additive manual stock ledger; no balance, identity, or lifecycle writes.
BEGIN;

CREATE TABLE "public"."stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "variant_id" UUID NOT NULL,
    "movement_type" TEXT NOT NULL,
    "delta_on_hand" INTEGER NOT NULL,
    "delta_reserved" INTEGER NOT NULL DEFAULT 0,
    "on_hand_before" INTEGER NOT NULL,
    "on_hand_after" INTEGER NOT NULL,
    "reserved_before" INTEGER NOT NULL,
    "reserved_after" INTEGER NOT NULL,
    "actor_admin_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_movements_type_delta_valid" CHECK (
        ("movement_type" = 'receive' AND "delta_on_hand" > 0) OR
        ("movement_type" = 'correction' AND "delta_on_hand" <> 0)
    ),
    CONSTRAINT "stock_movements_snapshots_nonnegative" CHECK (
        "on_hand_before" >= 0 AND "on_hand_after" >= 0 AND
        "reserved_before" >= 0 AND "reserved_after" >= 0
    ),
    CONSTRAINT "stock_movements_reserved_within_stock" CHECK (
        "reserved_before" <= "on_hand_before" AND
        "reserved_after" <= "on_hand_after"
    ),
    -- Widen arithmetic before addition: malformed values must not overflow INTEGER.
    CONSTRAINT "stock_movements_snapshot_arithmetic" CHECK (
        "on_hand_after"::bigint = "on_hand_before"::bigint + "delta_on_hand"::bigint AND
        "reserved_after"::bigint = "reserved_before"::bigint + "delta_reserved"::bigint
    ),
    CONSTRAINT "stock_movements_reserved_unchanged" CHECK (
        "delta_reserved" = 0 AND "reserved_after" = "reserved_before"
    ),
    CONSTRAINT "stock_movements_reason_nonempty" CHECK ("reason" ~ '[^[:space:]]'),
    CONSTRAINT "stock_movements_fingerprint_sha256" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "stock_movements_variant_id_fkey" FOREIGN KEY ("variant_id")
        REFERENCES "public"."product_variants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "stock_movements_actor_admin_id_fkey" FOREIGN KEY ("actor_admin_id")
        REFERENCES "public"."admin_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "stock_movements_idempotency_key_key"
    ON "public"."stock_movements"("idempotency_key");
CREATE INDEX "stock_movements_variant_id_created_at_id_idx"
    ON "public"."stock_movements"("variant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "stock_movements_actor_admin_id_idx"
    ON "public"."stock_movements"("actor_admin_id");

-- Statement-level guards also reject attempts affecting zero rows and TRUNCATE.
-- Invoker rights; no data access and no SECURITY DEFINER privilege escalation.
CREATE FUNCTION "public"."reject_stock_movement_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $guard$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Stock movements are append-only; record a compensating movement.';
END;
$guard$;

CREATE TRIGGER "stock_movements_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "public"."stock_movements"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_stock_movement_mutation"();

ALTER TABLE "public"."stock_movements" ENABLE ALWAYS TRIGGER "stock_movements_append_only";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "public"."stock_movements" FROM PUBLIC;

-- Runtime-role grants are deployment-specific and require a separate review.
-- Owners/superusers can disable/drop guards; this is not absolute immutability.
COMMIT;
