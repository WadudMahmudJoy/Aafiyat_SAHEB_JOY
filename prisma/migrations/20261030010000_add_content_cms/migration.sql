BEGIN;
CREATE TABLE content_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('hero','banner','story','page','size-guide')),
 slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=100 AND (kind<>'hero' OR slug='homepage-hero')),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160 AND title !~ '[<>]'),
 subtitle text NOT NULL DEFAULT '' CHECK(length(subtitle)<=500 AND subtitle !~ '[<>]'),
 body text NOT NULL DEFAULT '' CHECK(length(body)<=10000 AND body !~ '[<>]'),
 cta_label text NOT NULL DEFAULT '' CHECK(length(cta_label)<=60 AND cta_label !~ '[<>]'),
 cta_url text NOT NULL DEFAULT '' CHECK(length(cta_url)<=180 AND (cta_url='' OR cta_url ~ '^/(products(/[a-z0-9]+(-[a-z0-9]+)*)?|categories/[a-z0-9]+(-[a-z0-9]+)*|about|contact|policies(/[a-z0-9]+(-[a-z0-9]+)*)?)?$')),
 seo_title text NOT NULL DEFAULT '' CHECK(length(seo_title)<=70 AND seo_title !~ '[<>]'),
 seo_description text NOT NULL DEFAULT '' CHECK(length(seo_description)<=160 AND seo_description !~ '[<>]'),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published')),
 visible boolean NOT NULL DEFAULT false,
 sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 10000),
 measurements jsonb CHECK(measurements IS NULL OR (kind='size-guide' AND jsonb_typeof(measurements)='object' AND octet_length(measurements::text)<=12000)),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 cover_id uuid
);
CREATE INDEX content_entries_kind_state_sort_order_id_idx ON content_entries(kind,state,sort_order,id);
CREATE TABLE content_references (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 entry_id uuid NOT NULL REFERENCES content_entries(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 product_id uuid REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 category_id uuid REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 sort_order integer NOT NULL CHECK(sort_order BETWEEN 0 AND 39),
 CHECK((product_id IS NULL)<>(category_id IS NULL)),
 UNIQUE(entry_id,sort_order)
);
CREATE INDEX content_references_product_id_idx ON content_references(product_id);
CREATE INDEX content_references_category_id_idx ON content_references(category_id);
CREATE TABLE content_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 entry_id uuid NOT NULL REFERENCES content_entries(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 actor_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 object_key text NOT NULL UNIQUE,
 idempotency_key uuid NOT NULL UNIQUE,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 stored_hash text NOT NULL CHECK(stored_hash ~ '^[0-9a-f]{64}$'),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 8388608),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 8192),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 8192 AND width::bigint*height<=40000000),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','delete_pending','deleted')),
 ready_at timestamptz(6),attempt_id uuid,attempt_until timestamptz(6),delete_after timestamptz(6),
 reconcile_after timestamptz(6) NOT NULL DEFAULT 'epoch',claim_id uuid,
 created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(entry_id,id),
 CHECK(object_key='content/'||entry_id::text||'/'||id::text||'.webp'),
 CHECK((attempt_id IS NULL)=(attempt_until IS NULL)),
 CHECK(state<>'ready' OR ready_at IS NOT NULL),
 CHECK(state NOT IN ('delete_pending','deleted') OR delete_after IS NOT NULL)
);
CREATE INDEX content_assets_reconcile_after_id_idx ON content_assets(reconcile_after,id);
ALTER TABLE content_entries ADD CONSTRAINT content_cover_bound FOREIGN KEY(id,cover_id) REFERENCES content_assets(entry_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION guard_content_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Retain content asset tombstones'; END IF;
 IF (to_jsonb(OLD)-'state'-'ready_at'-'attempt_id'-'attempt_until'-'delete_after'-'reconcile_after'-'claim_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'ready_at'-'attempt_id'-'attempt_until'-'delete_after'-'reconcile_after'-'claim_id') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Immutable content asset identity'; END IF;
 IF OLD.ready_at IS NOT NULL AND OLD.ready_at IS DISTINCT FROM NEW.ready_at THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Immutable ready receipt'; END IF;
 IF OLD.state<>NEW.state AND NOT ((OLD.state='pending' AND NEW.state IN ('ready','delete_pending')) OR (OLD.state='ready' AND NEW.state='delete_pending') OR (OLD.state='delete_pending' AND NEW.state='deleted')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid content asset transition'; END IF;
 IF NEW.state<>'ready' AND EXISTS(SELECT 1 FROM content_entries WHERE cover_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Referenced content asset must remain ready'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER content_asset_guard BEFORE UPDATE OR DELETE ON content_assets FOR EACH ROW EXECUTE FUNCTION guard_content_asset();
CREATE FUNCTION guard_content_cover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE found_state text;
BEGIN
 IF NEW.cover_id IS NOT NULL THEN SELECT state INTO found_state FROM content_assets WHERE id=NEW.cover_id AND entry_id=NEW.id FOR UPDATE; IF found_state IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Only bound ready content assets may be linked'; END IF; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER content_cover_guard BEFORE INSERT OR UPDATE OF cover_id ON content_entries FOR EACH ROW EXECUTE FUNCTION guard_content_cover();
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK(action IN ('settings.update','offer.create','offer.update','content.save','content.upload','content.remove-image'));
COMMIT;
