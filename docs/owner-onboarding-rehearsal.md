# Disposable local Owner rehearsal

Prepared in Task 008O; the full disposable rehearsal was operator-confirmed PASS in Task 008P.
No real Owner exists; disposable fixtures were removed. Any further `--start` run requires separate authorization.

## Operator commands (interactive Windows PowerShell)

```powershell
Set-Location D:\Aafiyat_SAHEB_JOY
node --conditions=react-server --import tsx scripts/rehearse-owner-onboarding.ts --check
# Only after supervisory review:
node --conditions=react-server --import tsx scripts/rehearse-owner-onboarding.ts --start
# Recovery after cancellation or interruption:
node --conditions=react-server --import tsx scripts/rehearse-owner-onboarding.ts --cleanup
```

Stop other authentication servers, bootstrap utilities, and database-writing
verification scripts before starting or cleaning up. Use the local console;
do not record it or share passwords, QR images, keys, codes, cookies, or tokens.
The harness invokes existing HTTP handlers in-process; no external service is used.

## Rehearsal sequence

1. Read-only preflight requires local `aafiyat_dev`, five categories, four roles,
   and no authentication identities or memberships. Review the generated unique
   `aafiyat-owner-test-<UUID>@example.invalid` identity and explicit start prompt.
2. Choose and repeat a disposable password locally (hidden input). Creation is
   atomic and produces an **inactive** Owner. No permanent credentials exist.
   The confirmed password is reused in memory until the rehearsal ends; no further
   password entry is needed. References are released in `finally`; secure memory
   erasure is not guaranteed. Recovery metadata never contains this password.
3. The utility uses that password for password-only logins. Admin access is denied.
4. Controlled enrollment uses the same in-memory password. Scan the private offline
   QR, or reveal its manual key. Press Done, then enter enrollment TOTP locally.
5. Enrollment and the old password-only session must still be denied admin access;
   enrollment must leave session MFA proof absent.
6. Credential login uses the retained password; enter a fresh TOTP. Inactive membership still denies
   access. Confirm the intended TEST identity and type the activation confirmation
   within five minutes of login proof. Wait for a new authenticator code when needed.
7. Existing atomic activation retains only the verified session. Check its allowed
   permission, unknown-permission denial, and denial of revoked older sessions.
   OWNER has all defined permissions; insufficient-role tests remain separate.
8. A fresh post-activation login reuses the password and prompts separately for TOTP; verify catalog permission,
   sign out, and verify the revoked session cannot authorize.
9. Confirm exact cleanup by typing the displayed `DELETE TEST <UUID>` phrase.
   Success requires all 12 database table fingerprints to match the baseline.
10. Remove this disposable TEST entry from your authenticator. Personally confirm
    QR usability, enrollment/activation boundaries, denial messages, and cleanup.

## Cancellation and recovery

Ctrl+C cancels local prompts; X/Cancel or the 120-second viewer expiry aborts
enrollment. Close other auth processes and run `--cleanup` after review. A new
`--start` refuses an existing journal. Interrupted setup is cleaned up rather
than overwriting an account or replacing any verified factor.

The Git-ignored `.local/owner-rehearsal.json` stores only exact fixture IDs,
TEST labels, timestamps, challenge identifier hashes, and baseline fingerprints.
It contains no password, key, URI, cookie, token, or QR. Interrupted atomic journal
replacement can leave an additional non-secret journal file. Retain recovery
metadata until cleanup is confirmed; never substitute another identity's IDs.

Cleanup checks the verified local database, TEST label, UUIDs, creation boundary,
credential-account ownership, and sole Owner membership. A crash before IDs were
saved can be recovered only through that complete binding. It refuses unfamiliar
records or unrelated fingerprint changes. Transaction locks coordinate exact
deletion with activation/MFA operations; failed comparisons roll back deletion.
No reference roles, categories, Docker resources, or other identities are deleted.

The process lock prevents overlapping operator runs. Recovery removes a stale
lock only after confirmation and after its PID is no longer alive. Never bypass
an active or ambiguous lock. Keep other auth processes stopped through cleanup:
uncoordinated external writers are outside this operator workflow. Any cleanup
failure retains the journal and requires investigation, not a reset or broad delete.

## Verification and acceptance

Read-only preflight and in-memory refusal tests alone do not prove live cleanup SQL.
The Owner bootstrap verifier was skipped in Task 008O because that task prohibited
fixture provisioning. Later focused regressions exercised disposable identities.
The operator confirmed the complete interactive Task 008P sequence, exact cleanup,
restoration of all 12 fingerprints, and final preflight. No new interactive run or
human GUI acceptance is claimed by this checkpoint. Authentication is not production-ready.
