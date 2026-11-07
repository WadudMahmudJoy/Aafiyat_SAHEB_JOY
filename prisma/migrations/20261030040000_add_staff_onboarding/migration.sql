BEGIN;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_id_user_id_key UNIQUE(id,user_id);
CREATE TABLE admin_onboarding (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 invitation_id uuid NOT NULL REFERENCES admin_invitations(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 capability_hash varchar(64) NOT NULL UNIQUE CHECK(capability_hash ~ '^[a-f0-9]{64}$'),
 state varchar(24) NOT NULL DEFAULT 'verifying' CHECK(state IN ('verifying','mailbox_verified','provisioned','expired','abandoned')),
 created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz(6) NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 mail_requests integer NOT NULL DEFAULT 0 CHECK(mail_requests BETWEEN 0 AND 3),
 verification_attempts integer NOT NULL DEFAULT 0 CHECK(verification_attempts BETWEEN 0 AND 10),
 last_mail_at timestamptz(6),
 mailbox_verified_at timestamptz(6),
 verified_challenge_id uuid,
 user_id text UNIQUE REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 membership_id uuid UNIQUE,
 UNIQUE(membership_id,user_id),
 provisioned_at timestamptz(6),
 closed_at timestamptz(6),
 FOREIGN KEY(membership_id,user_id) REFERENCES admin_users(id,user_id) MATCH FULL ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
 CHECK((mailbox_verified_at IS NULL)=(verified_challenge_id IS NULL)),
 CHECK(state NOT IN ('mailbox_verified','provisioned') OR mailbox_verified_at IS NOT NULL),
 CHECK(state<>'verifying' OR mailbox_verified_at IS NULL),
 CHECK((user_id IS NULL)=(provisioned_at IS NULL)),
 CHECK(state<>'provisioned' OR user_id IS NOT NULL),
 CHECK(user_id IS NULL OR state IN ('provisioned','expired','abandoned')),
 CHECK((state IN ('expired','abandoned'))=(closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX admin_onboarding_active_invitation_key ON admin_onboarding(invitation_id) WHERE state IN ('verifying','mailbox_verified','provisioned');
CREATE UNIQUE INDEX admin_onboarding_provisioned_invitation_key ON admin_onboarding(invitation_id) WHERE user_id IS NOT NULL;
CREATE INDEX admin_onboarding_invitation_created_idx ON admin_onboarding(invitation_id,created_at DESC);
CREATE INDEX admin_onboarding_expiry_idx ON admin_onboarding(state,expires_at);
CREATE TABLE admin_mailbox_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 onboarding_id uuid NOT NULL REFERENCES admin_onboarding(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 verifier varchar(64) NOT NULL CHECK(verifier ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz(6) NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 delivery_state varchar(16) NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','delivered','failed')),
 delivered_at timestamptz(6),
 receipt_hash varchar(64) CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 consumed_at timestamptz(6),
 invalidated_at timestamptz(6),
 UNIQUE(onboarding_id,id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
 CHECK((delivery_state='delivered')=(delivered_at IS NOT NULL)),
 CHECK((delivered_at IS NULL)=(receipt_hash IS NULL)),
 CHECK(consumed_at IS NULL OR (invalidated_at IS NULL AND delivery_state='delivered')),
 CHECK(delivery_state<>'failed' OR invalidated_at IS NOT NULL)
);
CREATE UNIQUE INDEX admin_mailbox_challenges_active_key ON admin_mailbox_challenges(onboarding_id) WHERE consumed_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX admin_mailbox_challenges_expiry_idx ON admin_mailbox_challenges(expires_at);
CREATE FUNCTION protect_mailbox_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD.onboarding_id,OLD.verifier,OLD.created_at,OLD.expires_at) IS DISTINCT FROM (NEW.id,NEW.onboarding_id,NEW.verifier,NEW.created_at,NEW.expires_at)
    OR OLD.consumed_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL OR NEW.attempts<OLD.attempts
    OR (NEW.consumed_at IS NOT NULL AND (OLD.delivery_state<>'delivered' OR OLD.expires_at<=clock_timestamp())) THEN
  RAISE EXCEPTION 'Mailbox challenge transition rejected' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER mailbox_challenge_transition BEFORE UPDATE ON admin_mailbox_challenges FOR EACH ROW EXECUTE FUNCTION protect_mailbox_challenge();
ALTER TABLE admin_mailbox_challenges ENABLE ALWAYS TRIGGER mailbox_challenge_transition;
ALTER TABLE admin_onboarding ADD CONSTRAINT admin_onboarding_verified_challenge_fkey FOREIGN KEY(id,verified_challenge_id) REFERENCES admin_mailbox_challenges(onboarding_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TABLE staff_onboarding_limits (
 scope varchar(24) PRIMARY KEY CHECK(scope IN ('start','request_code','verify','provision')),
 window_start timestamptz(6) NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 1000)
);
CREATE FUNCTION protect_admin_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE destination text; assigned admin_role_name; bound_email text; bound_role admin_role_name; enabled boolean; verified boolean; factor_enabled boolean; invitation_state text; delivery_state text; invitation_expiry timestamptz;
BEGIN
 IF (OLD.id,OLD.invitation_id,OLD.capability_hash,OLD.created_at,OLD.expires_at) IS DISTINCT FROM (NEW.id,NEW.invitation_id,NEW.capability_hash,NEW.created_at,NEW.expires_at)
    OR NEW.version<>OLD.version+1 OR NEW.mail_requests<OLD.mail_requests OR NEW.verification_attempts<OLD.verification_attempts
    OR OLD.state IN ('expired','abandoned') OR (OLD.user_id IS NOT NULL AND (NEW.user_id,NEW.membership_id,NEW.provisioned_at) IS DISTINCT FROM (OLD.user_id,OLD.membership_id,OLD.provisioned_at)) THEN
  RAISE EXCEPTION 'Onboarding transition rejected' USING ERRCODE='23514';
 END IF;
 IF NEW.state IN ('mailbox_verified','provisioned') AND NOT EXISTS(SELECT 1 FROM admin_mailbox_challenges WHERE id=NEW.verified_challenge_id AND onboarding_id=NEW.id AND consumed_at=NEW.mailbox_verified_at AND invalidated_at IS NULL) THEN
  RAISE EXCEPTION 'Mailbox proof binding rejected' USING ERRCODE='23514';
 END IF;
 IF NEW.state='provisioned' THEN
  SELECT email,role,state,admin_invitations.delivery_state,expires_at INTO destination,assigned,invitation_state,delivery_state,invitation_expiry FROM admin_invitations WHERE id=NEW.invitation_id;
  IF invitation_state<>'delivered' OR delivery_state<>'delivered' OR invitation_expiry<=clock_timestamp() OR NEW.expires_at<=clock_timestamp()
     OR NEW.mailbox_verified_at>clock_timestamp() OR NEW.mailbox_verified_at<clock_timestamp()-interval '10 minutes' THEN
   RAISE EXCEPTION 'Onboarding provisioning deadline expired' USING ERRCODE='23514';
  END IF;
  SELECT u.email,r.name,m.active,u."emailVerified",u."twoFactorEnabled" INTO bound_email,bound_role,enabled,verified,factor_enabled
   FROM admin_users m JOIN auth_users u ON u.id=m.user_id JOIN admin_roles r ON r.id=m.role_id WHERE m.id=NEW.membership_id AND u.id=NEW.user_id;
  IF bound_email IS DISTINCT FROM destination OR bound_role IS DISTINCT FROM assigned OR bound_role='OWNER' OR enabled IS DISTINCT FROM false OR verified IS DISTINCT FROM true OR factor_enabled IS DISTINCT FROM false
     OR NOT EXISTS(SELECT 1 FROM admin_mailbox_challenges WHERE id=NEW.verified_challenge_id AND onboarding_id=NEW.id AND consumed_at IS NOT NULL AND invalidated_at IS NULL) THEN
   RAISE EXCEPTION 'Onboarding identity binding rejected' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.updated_at=GREATEST(clock_timestamp(),OLD.updated_at+interval '1 microsecond'); RETURN NEW;
END $$;
CREATE TRIGGER admin_onboarding_transition BEFORE UPDATE ON admin_onboarding FOR EACH ROW EXECUTE FUNCTION protect_admin_onboarding();
ALTER TABLE admin_onboarding ENABLE ALWAYS TRIGGER admin_onboarding_transition;
CREATE FUNCTION close_invitation_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IN ('revoked','expired') AND OLD.state IS DISTINCT FROM NEW.state THEN
  UPDATE admin_mailbox_challenges SET invalidated_at=clock_timestamp() WHERE onboarding_id IN (SELECT id FROM admin_onboarding WHERE invitation_id=NEW.id) AND consumed_at IS NULL AND invalidated_at IS NULL;
  UPDATE admin_onboarding SET state=CASE WHEN NEW.state='expired' THEN 'expired' ELSE 'abandoned' END,closed_at=clock_timestamp(),version=version+1 WHERE invitation_id=NEW.id AND state IN ('verifying','mailbox_verified','provisioned');
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER admin_invitation_close_onboarding AFTER UPDATE ON admin_invitations FOR EACH ROW EXECUTE FUNCTION close_invitation_onboarding();
ALTER TABLE admin_invitations ENABLE ALWAYS TRIGGER admin_invitation_close_onboarding;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK(action IN (
 'settings.update','offer.create','offer.update','content.save','content.upload','content.remove-image',
 'admin.role','admin.activate','admin.deactivate','admin.revoke','invitation.create','invitation.revoke','invitation.expire','invitation.delivery',
 'onboarding.start','onboarding.mail','onboarding.verify','onboarding.provision','onboarding.close'
));
COMMIT;
