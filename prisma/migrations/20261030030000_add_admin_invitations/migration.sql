BEGIN;
CREATE TABLE admin_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(btrim(email)) AND email ~ '^[!-~]+@[a-z0-9.-]+\.[a-z0-9-]+$'),
 role admin_role_name NOT NULL CHECK(role IN ('PRODUCT_MANAGER','ORDER_MANAGER','MARKETING_MANAGER')),
 token_hash varchar(64) NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 delivery_ciphertext text CHECK(delivery_ciphertext IS NULL OR (length(delivery_ciphertext) BETWEEN 90 AND 200 AND delivery_ciphertext LIKE 'v1.%')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','revoked','expired','consumed')),
 delivery_state text NOT NULL DEFAULT 'unconfigured' CHECK(delivery_state IN ('unconfigured','queued','sending','failed','delivered','cancelled')),
 invited_by uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz(6) NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 next_attempt_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid,
 lease_until timestamptz(6),
 last_error text CHECK(last_error IN ('provider_failure','encryption_unavailable','attempts_exhausted')),
 provider_receipt_hash varchar(64) CHECK(provider_receipt_hash ~ '^[a-f0-9]{64}$'),
 delivered_at timestamptz(6),
 revoked_at timestamptz(6),
 revoked_by uuid REFERENCES admin_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 expired_at timestamptz(6),
 consumed_at timestamptz(6),
 consumed_user_id text REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
 CHECK((lease_id IS NULL)=(lease_until IS NULL)),
 CHECK((delivery_state='sending')=(lease_id IS NOT NULL)),
 CHECK(delivery_state NOT IN ('queued','sending') OR delivery_ciphertext IS NOT NULL),
 CHECK((delivery_state='delivered')=(delivered_at IS NOT NULL)),
 CHECK(delivered_at IS NULL OR (delivery_ciphertext IS NULL AND provider_receipt_hash IS NOT NULL)),
 CHECK((state='revoked')=(revoked_at IS NOT NULL AND revoked_by IS NOT NULL)),
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
 CHECK((state='expired')=(expired_at IS NOT NULL)),
 CHECK((state='consumed')=(consumed_at IS NOT NULL AND consumed_user_id IS NOT NULL)),
 CHECK((consumed_at IS NULL)=(consumed_user_id IS NULL)),
 CHECK(state NOT IN ('revoked','expired','consumed') OR (delivery_ciphertext IS NULL AND lease_id IS NULL AND delivery_state IN ('cancelled','delivered'))),
 CHECK(state<>'delivered' OR delivery_state='delivered'),
 CHECK(state<>'pending' OR delivery_state<>'delivered')
);
CREATE UNIQUE INDEX admin_invitations_active_email_key ON admin_invitations(email) WHERE state IN ('pending','delivered');
CREATE INDEX admin_invitations_state_expiry_id_idx ON admin_invitations(state,expires_at,id);
CREATE INDEX admin_invitations_delivery_due_idx ON admin_invitations(delivery_state,next_attempt_at,id) WHERE state='pending';
CREATE INDEX admin_invitations_inviter_created_idx ON admin_invitations(invited_by,created_at DESC,id);
CREATE INDEX admin_invitations_revoked_by_idx ON admin_invitations(revoked_by);
CREATE INDEX admin_invitations_consumed_user_idx ON admin_invitations(consumed_user_id);
CREATE FUNCTION protect_admin_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD.email,OLD.role,OLD.token_hash,OLD.invited_by,OLD.created_at,OLD.expires_at) IS DISTINCT FROM
    (NEW.id,NEW.email,NEW.role,NEW.token_hash,NEW.invited_by,NEW.created_at,NEW.expires_at) THEN
  RAISE EXCEPTION 'Invitation identity and issuance are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.state IN ('revoked','expired','consumed') OR NEW.version<>OLD.version+1 OR NEW.attempts<OLD.attempts THEN
  RAISE EXCEPTION 'Invitation transition rejected' USING ERRCODE='23514';
 END IF;
 IF OLD.expires_at<=clock_timestamp() AND NEW.state<>'expired' THEN
  -- A confirmed provider receipt may arrive across the expiry boundary. Keep
  -- delivery evidence while expiring access; never resurrect the invitation.
  IF NEW.delivery_state='delivered' AND NEW.delivered_at IS NOT NULL AND NEW.provider_receipt_hash IS NOT NULL THEN
   NEW.state='expired'; NEW.expired_at=clock_timestamp();
  ELSE
   RAISE EXCEPTION 'Invitation has expired' USING ERRCODE='23514';
  END IF;
 END IF;
 IF OLD.delivered_at IS NOT NULL AND (NEW.delivered_at IS DISTINCT FROM OLD.delivered_at OR NEW.provider_receipt_hash IS DISTINCT FROM OLD.provider_receipt_hash OR NEW.delivery_state<>'delivered') THEN
  RAISE EXCEPTION 'Delivery receipt is immutable' USING ERRCODE='23514';
 END IF;
 NEW.updated_at=GREATEST(clock_timestamp(),OLD.updated_at+interval '1 microsecond');
 RETURN NEW;
END $$;
CREATE TRIGGER admin_invitation_transition BEFORE UPDATE ON admin_invitations FOR EACH ROW EXECUTE FUNCTION protect_admin_invitation();
ALTER TABLE admin_invitations ENABLE ALWAYS TRIGGER admin_invitation_transition;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK(action IN (
 'settings.update','offer.create','offer.update','content.save','content.upload','content.remove-image',
 'admin.role','admin.activate','admin.deactivate','admin.revoke',
 'invitation.create','invitation.revoke','invitation.expire','invitation.delivery'
));
COMMIT;
