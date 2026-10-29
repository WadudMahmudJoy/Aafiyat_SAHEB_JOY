BEGIN;
CREATE TABLE business_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 currency char(3) NOT NULL DEFAULT 'BDT' CHECK(currency='BDT'),
 free_shipping_threshold_minor bigint NOT NULL DEFAULT 500000 CHECK(free_shipping_threshold_minor>=0),
 low_stock_threshold integer CHECK(low_stock_threshold>=0),
 consent_visible boolean NOT NULL DEFAULT false,
 consent_notice text NOT NULL DEFAULT '' CHECK(length(consent_notice)<=1000 AND consent_notice !~ '[<>]'),
 consent_version integer NOT NULL DEFAULT 0 CHECK(consent_version>=0),
 reviews_enabled boolean NOT NULL DEFAULT false CHECK(NOT reviews_enabled),
 exchange_days integer NOT NULL DEFAULT 3 CHECK(exchange_days=3),
 exchange_anchor text NOT NULL DEFAULT 'unresolved' CHECK(exchange_anchor='unresolved'),
 updated_by uuid REFERENCES admin_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CHECK(NOT consent_visible OR length(btrim(consent_notice))>0)
);
INSERT INTO business_settings(id) VALUES(true);
CREATE TABLE offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[<>]'),
 coupon_code text UNIQUE CHECK(coupon_code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
 kind text NOT NULL CHECK(kind IN ('fixed','percentage')),
 value bigint NOT NULL CHECK(value>0 AND (kind<>'percentage' OR value<=10000)),
 starts_at timestamptz(3) NOT NULL,
 ends_at timestamptz(3) NOT NULL CHECK(ends_at>starts_at),
 active boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX offers_id_active_idx ON offers(id,active);
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 action text NOT NULL CHECK(action IN ('settings.update','offer.create','offer.update')),
 entity_id text NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 40),
 summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<=4096),
 created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_logs_entity_id_created_at_id_idx ON audit_logs(entity_id,created_at DESC,id);
CREATE FUNCTION protect_business_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Administrative audit evidence is append-only'; END $$;
CREATE TRIGGER business_audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION protect_business_audit();
ALTER TABLE audit_logs ENABLE ALWAYS TRIGGER business_audit_append_only;
COMMIT;
