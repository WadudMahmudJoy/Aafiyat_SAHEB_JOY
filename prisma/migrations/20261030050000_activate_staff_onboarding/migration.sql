BEGIN;

ALTER TABLE auth_two_factors ADD CONSTRAINT auth_two_factors_id_user_id_key UNIQUE (id,"userId");
ALTER TABLE admin_onboarding
 ADD COLUMN enrollment_factor_id text,
 ADD COLUMN enrollment_started_at timestamptz(6),
 ADD COLUMN enrollment_failures integer NOT NULL DEFAULT 0 CHECK (enrollment_failures BETWEEN 0 AND 5),
 ADD COLUMN enrollment_locked_until timestamptz(6),
 ADD COLUMN activated_at timestamptz(6),
 ADD CONSTRAINT admin_onboarding_enrollment_factor_fkey FOREIGN KEY (enrollment_factor_id,user_id)
   REFERENCES auth_two_factors(id,"userId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT admin_onboarding_enrollment_shape CHECK (
   (enrollment_factor_id IS NULL)=(enrollment_started_at IS NULL)
   AND (enrollment_factor_id IS NULL OR (user_id IS NOT NULL AND enrollment_started_at>=provisioned_at))
   AND (enrollment_locked_until IS NOT NULL)=(enrollment_failures=5)
   AND (state='completed')=(activated_at IS NOT NULL)
   AND (activated_at IS NULL OR (enrollment_factor_id IS NOT NULL AND activated_at>=enrollment_started_at))
 );
ALTER TABLE admin_onboarding DROP CONSTRAINT admin_onboarding_state_check;
-- E2B1's anonymous CHECK for provisioned user/state shape.
ALTER TABLE admin_onboarding DROP CONSTRAINT admin_onboarding_check6;
ALTER TABLE admin_onboarding
 ADD CONSTRAINT admin_onboarding_state_check CHECK (state IN ('verifying','mailbox_verified','provisioned','completed','expired','abandoned')),
 ADD CONSTRAINT admin_onboarding_bound_user_state CHECK (user_id IS NULL OR state IN ('provisioned','completed','expired','abandoned'));

CREATE OR REPLACE FUNCTION protect_admin_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE destination text; assigned admin_role_name; bound_email text; bound_role admin_role_name; enabled boolean; verified boolean; factor_enabled boolean; invitation_state text; delivery_state text; invitation_expiry timestamptz;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'verifying' OR NEW.user_id IS NOT NULL
     OR NEW.enrollment_failures<>0 OR NEW.version<>1 THEN
   RAISE EXCEPTION 'Onboarding must start with an unbound invitation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (OLD.id,OLD.invitation_id,OLD.capability_hash,OLD.created_at,OLD.expires_at) IS DISTINCT FROM (NEW.id,NEW.invitation_id,NEW.capability_hash,NEW.created_at,NEW.expires_at)
    OR NEW.version<>OLD.version+1 OR NEW.mail_requests<OLD.mail_requests OR NEW.verification_attempts<OLD.verification_attempts
    OR OLD.state IN ('expired','abandoned','completed') OR (OLD.user_id IS NOT NULL AND (NEW.user_id,NEW.membership_id,NEW.provisioned_at) IS DISTINCT FROM (OLD.user_id,OLD.membership_id,OLD.provisioned_at)) THEN
  RAISE EXCEPTION 'Onboarding transition rejected' USING ERRCODE='23514';
 END IF;
 IF NEW.state IN ('mailbox_verified','provisioned') AND NOT EXISTS(SELECT 1 FROM admin_mailbox_challenges WHERE id=NEW.verified_challenge_id AND onboarding_id=NEW.id AND consumed_at=NEW.mailbox_verified_at AND invalidated_at IS NULL) THEN
  RAISE EXCEPTION 'Mailbox proof binding rejected' USING ERRCODE='23514';
 END IF;
 IF NEW.state='provisioned' AND OLD.state<>'provisioned' THEN
  IF OLD.state<>'mailbox_verified' OR NEW.enrollment_factor_id IS NOT NULL THEN
   RAISE EXCEPTION 'Initial onboarding provisioning transition rejected' USING ERRCODE='23514';
  END IF;
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
 -- Once provisioned, the invitation deadline governs enrollment. The
 -- original mailbox and attempt deadlines still govern initial provisioning.
 IF OLD.state='provisioned' AND (
     NEW.state NOT IN ('provisioned','completed','expired','abandoned')
     OR (NEW.mailbox_verified_at,NEW.verified_challenge_id,NEW.mail_requests,NEW.verification_attempts,NEW.last_mail_at)
       IS DISTINCT FROM (OLD.mailbox_verified_at,OLD.verified_challenge_id,OLD.mail_requests,OLD.verification_attempts,OLD.last_mail_at)
     OR (OLD.enrollment_factor_id IS NOT NULL AND
       (NEW.enrollment_factor_id,NEW.enrollment_started_at) IS DISTINCT FROM (OLD.enrollment_factor_id,OLD.enrollment_started_at))
 ) THEN
  RAISE EXCEPTION 'Provisioned onboarding binding is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.state='provisioned' AND NEW.state='provisioned' THEN
  IF NEW.enrollment_factor_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM admin_invitations i JOIN admin_users m ON m.id=NEW.membership_id
    JOIN admin_roles r ON r.id=m.role_id JOIN auth_users u ON u.id=NEW.user_id
    JOIN auth_two_factors f ON f.id=NEW.enrollment_factor_id AND f."userId"=u.id
    WHERE i.id=NEW.invitation_id AND i.state='delivered' AND i.expires_at>clock_timestamp()
      AND i.email=u.email AND r.name=i.role AND m.user_id=u.id AND NOT m.active AND m.disabled_at IS NULL
      AND u."emailVerified" AND u."twoFactorEnabled" IS FALSE AND f.verified IS FALSE
  ) THEN RAISE EXCEPTION 'Enrollment binding rejected' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.state='completed' THEN
  IF OLD.state<>'provisioned' OR OLD.enrollment_factor_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM admin_invitations i JOIN admin_users m ON m.id=NEW.membership_id
    JOIN admin_roles r ON r.id=m.role_id JOIN auth_users u ON u.id=NEW.user_id
    JOIN auth_two_factors f ON f.id=NEW.enrollment_factor_id AND f."userId"=u.id
    WHERE i.id=NEW.invitation_id AND i.state='consumed' AND i.consumed_user_id=u.id
      AND i.consumed_at=NEW.activated_at AND i.expires_at>clock_timestamp()
      AND i.email=u.email AND r.name=i.role AND m.user_id=u.id AND m.active AND m.disabled_at IS NULL
      AND m.authorization_not_before>=NEW.activated_at
      AND u."emailVerified" AND u."twoFactorEnabled" AND f.verified
      AND (SELECT count(*) FROM auth_two_factors WHERE "userId"=u.id)=1
  ) THEN RAISE EXCEPTION 'Onboarding completion rejected' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.updated_at=GREATEST(clock_timestamp(),OLD.updated_at+interval '1 microsecond'); RETURN NEW;
END $$;
DROP TRIGGER admin_onboarding_transition ON admin_onboarding;
CREATE TRIGGER admin_onboarding_transition BEFORE INSERT OR UPDATE ON admin_onboarding
 FOR EACH ROW EXECUTE FUNCTION protect_admin_onboarding();
ALTER TABLE admin_onboarding ENABLE ALWAYS TRIGGER admin_onboarding_transition;

-- Prevent a governance action from independently activating an incomplete
-- invited membership. The atomic recipient transition consumes first.
CREATE FUNCTION guard_invited_staff_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.active AND NOT OLD.active AND EXISTS(
   SELECT 1 FROM admin_onboarding o JOIN admin_invitations i ON i.id=o.invitation_id
   WHERE o.membership_id=OLD.id AND o.state<>'completed'
     AND (o.state<>'provisioned' OR i.state<>'consumed' OR i.consumed_user_id IS DISTINCT FROM OLD.user_id)
 ) THEN RAISE EXCEPTION 'Invited staff activation requires onboarding' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invited_staff_activation BEFORE UPDATE OF active ON admin_users
 FOR EACH ROW EXECUTE FUNCTION guard_invited_staff_activation();
ALTER TABLE admin_users ENABLE ALWAYS TRIGGER invited_staff_activation;

-- Existing E2A transition enforcement makes consumption irreversible.
-- Require the matching activation to be complete before this transaction commits.
CREATE FUNCTION guard_staff_invitation_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM admin_onboarding o JOIN admin_users m ON m.id=o.membership_id
   JOIN admin_roles r ON r.id=m.role_id JOIN auth_users u ON u.id=o.user_id
   JOIN auth_two_factors f ON f.id=o.enrollment_factor_id AND f."userId"=u.id
   WHERE o.invitation_id=NEW.id AND o.user_id=NEW.consumed_user_id AND o.state='completed'
     AND o.activated_at=NEW.consumed_at AND m.active AND m.disabled_at IS NULL AND m.user_id=u.id
     AND m.authorization_not_before>=NEW.consumed_at AND r.name=NEW.role AND u.email=NEW.email
     AND u."emailVerified" AND u."twoFactorEnabled" AND f.verified AND NEW.expires_at>clock_timestamp()
     AND EXISTS(SELECT 1 FROM audit_logs a WHERE a.actor_id=m.id AND a.action='onboarding.activate' AND a.entity_id=o.id::text)
 ) THEN RAISE EXCEPTION 'Invitation consumption requires completed activation' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER staff_invitation_consumption AFTER UPDATE ON admin_invitations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.state='consumed' AND OLD.state IS DISTINCT FROM NEW.state)
 EXECUTE FUNCTION guard_staff_invitation_consumption();
ALTER TABLE admin_invitations ENABLE ALWAYS TRIGGER staff_invitation_consumption;

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK(action IN (
 'settings.update','offer.create','offer.update','content.save','content.upload','content.remove-image',
 'admin.role','admin.activate','admin.deactivate','admin.revoke','invitation.create','invitation.revoke','invitation.expire','invitation.delivery',
 'onboarding.start','onboarding.mail','onboarding.verify','onboarding.provision','onboarding.close','onboarding.enroll','onboarding.activate'
));
COMMIT;
