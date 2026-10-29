BEGIN;
ALTER TABLE admin_users ADD COLUMN governance_version bigint NOT NULL DEFAULT 1 CHECK(governance_version>0),
 ADD COLUMN authorization_not_before timestamptz(3) NOT NULL DEFAULT 'epoch';
CREATE INDEX admin_users_active_role_id_id_idx ON admin_users(active,role_id,id);
CREATE INDEX audit_logs_action_created_at_id_idx ON audit_logs(action,created_at DESC,id DESC);
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK(action IN ('settings.update','offer.create','offer.update','content.save','content.upload','content.remove-image','admin.role','admin.activate','admin.deactivate','admin.revoke'));
COMMIT;
