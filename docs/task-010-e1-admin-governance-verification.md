# Task 010-E1 - Administrator Governance Verification

Latest acceptance: **E1 fresh verification PASS** for Task 010-E1R on 2026-10-30, against committed E1 HEAD fc84c6bf86930be99cca508bf02d1ff1e443bf4b. Fresh browser acceptance and controller preservation both passed. The E1R section below supersedes earlier verification-run status for this maintenance repair; earlier evidence remains historical.

Status: PASS for the implemented and tested existing-membership governance slice on 2026-10-30. The implementation phase performed no commit, push, migration to development, permanent provisioning or production deployment. E1G authorizes the reviewed checkpoint separately.

## Starting repository and database

Branch main, HEAD 425183c849dc3d075e6697b941d8d240cb9b062e; initial worktree and index were clean. Reviewed the implemented Prisma/authentication/session/MFA models, fixed permission matrix, shared advisory-lock convention, D1/D2 audit migrations, Owner onboarding documentation and dashboard. Existing onboarding remains separately controlled; no invitation, signup, membership claiming, MFA reset or factor-management endpoint was introduced.

Read-only development identity: exactly 127.0.0.1:55432/aafiyat_dev, PostgreSQL 18.6. Six applied migrations; Orders/Customers applied once. Product Media, D1 and D2 remained pending, and E1 remains pending. All existing migration files are unchanged. Development has zero administrator memberships and zero authentication users; no permanent Owner or staff fixture was added.

## Additive migration

Filename: prisma/migrations/20261030020000_add_admin_governance/migration.sql
SHA-256: 9b028814e86ba1b9327e27141780e3c4982f9f9fc7f007567a7f38ab80c507b7

The tenth migration adds admin_users.governance_version (positive BIGINT, default 1) and authorization_not_before (non-null UTC timestamptz(3), epoch default), plus membership state/role/ID and audit action/time/ID indexes. It expands the existing audit action CHECK for admin.role, admin.activate, admin.deactivate and admin.revoke. The existing append-only trigger and restrictive actor references remain intact. No duplicate identity, role, session or audit tables were added. Prior history and existing sessions are not rewritten merely by migration; governance mutations establish the new revocation boundary. A migration-specific LF attribute preserves SQL bytes on Windows.

The complete ten-migration sequence was deployed only to verified empty, unique disposable PostgreSQL 18.6 databases. Recreation of the governance migration inside BEGIN/ROLLBACK preserved existing membership rows. Prisma models include the corresponding indexes and database fields.

## Working routes and controls

/admin/staff requires admins:manage. It lists existing membership UUID, display name/email, approved role, active/disabled state, verified MFA-enrollment status, created/updated timestamps and optimistic revision. Search is bounded to 100 characters; UUID-keyset pagination returns twenty rows per page. Email is display/search information only; no identity ownership or membership creation is inferred from it. Projections do not select passwords, TOTP secrets, recovery codes or session tokens.

Existing non-Owner roles can change among PRODUCT_MANAGER, ORDER_MANAGER and MARKETING_MANAGER. Verified-MFA inactive non-Owners can be activated; eligible other memberships can be deactivated; existing sessions can be explicitly revoked. Each operation requires typing CONFIRM. Self-management controls are hidden, and all self mutations are independently denied server-side. Success disables the submitted form until reload; stale versions show an explicit conflict; failed access/state changes use generic safe messages. Role permissions are displayed from the unchanged central permission matrix.

/admin/audit requires audit:read. It displays recorded actor name/membership, action, entity, exact six-digit UTC timestamp and allowlisted safe scalar/category summaries. Existing Settings, Offers and CMS actions appear alongside new governance actions. Filters are bounded action, exact actor UUID and exact entity identifier. Descending timestamp-plus-UUID cursor pagination preserves PostgreSQL microseconds and returns twenty rows; malformed cursors fail safely. The viewer does not render arbitrary historical JSON payload fields. Historical actors are restrictive FK references; there is no account or audit deletion UI.

Dashboard/navigation has separate Administrators and Audit history destinations, active-page indicators and permission-based visibility. OWNER alone has these grants. Existing Products, Inventory, Orders, Customers, Settings, Marketing and Content routes remain present.

## Role, session and MFA safety

Mutations first enforce configured trusted origin and fresh request-bound admins:manage authorization. Strict full FormData allowlisting rejects duplicate/extra fields and forged actor/session inputs. The actor is server-derived and must be OWNER. Within a bounded transaction, a governance-wide advisory lock serializes membership/last-Owner decisions. Per-user locks use the existing (88008, hashtext(userId)) convention in sorted identity order, then actor/target membership rows are locked in deterministic ID order. The actor is reauthorized against the transaction's current membership/session state before any write. Lock wait is two seconds, statement timeout five seconds, transaction timeout fifteen seconds.

Each successful operation advances the membership version and a monotonic authorization cutoff, deletes all target identity sessions and appends its redacted audit record atomically. Audit failure rolls back the membership, cutoff and session deletions. The central uncached authorization guard rejects sessions created at or before the cutoff even if a session row remains. Equality fails closed at millisecond precision, matching Better Auth timestamps; a login initiated in the same millisecond may need to be restarted.

The existing TOTP proof writer shares the per-user advisory lock and rejects password challenges created at/before the governance cutoff for all administrator roles. This closes the case where an old pending password challenge would otherwise create a post-change session. Password login plus verified TOTP must begin afresh after role/status changes. Reactivation cannot resurrect an old cookie/session. Proof fields remain server-owned; trusted-device bypass, signup, recovery and public factor management remain disabled. Governance tightens the central boundary as explicitly authorized; it does not add a new authentication mechanism or role grant.

Role changes to or from OWNER are denied. Owner activation is deliberately unavailable in this UI to avoid granting Owner privileges through governance. Self-deactivation, self-demotion and self-revocation are denied; the existing Sign out control remains available. Another active Owner may be deactivated only while another active Owner remains. Global serialization and the active-Owner count guard supplement self-protection. Tests retained one active Owner and verified denial of its deactivation; no broader multi-Owner stress test is claimed.

Revocation applies to subsequent server authorization and MFA-proof issuance. It does not retroactively cancel a request that already completed authorization before the revocation committed. Browser display may remain stale until its next existing session check, but stale display never authorizes a write.

## Actual PostgreSQL and authentication evidence

Command: node scripts/run-governance-verification.mjs.
Final run: 5cccbbad-cb40-4cd2-84af-e8ef03e3742a. Twelve integration groups passed using real shared Prisma transactions and actual Better Auth password/TOTP login. No transaction or service authorization was mocked. Disposable-only fixtures include encrypted factor records, password hashes, direct NULL/stale-proof fault injection, and exact retained-session restoration to test the cutoff independently of deletion. These are test setup/probes, not production bypasses.

1. Real password/TOTP login; directory/search privacy; role denial.
2. Role persistence; immediate session deletion; fresh login obtains only new permissions.
3. A password challenge created before a role mutation cannot obtain valid privileged proof afterward.
4. Deactivation/reactivation cannot restore old cookies; a deliberately restored old database session row is rejected by the authoritative cutoff; fresh login succeeds.
5. Concurrent conflicting version writes: one success and one stale rejection.
6. Self-protection, Owner demotion/activation/promotion denial and preservation of one active Owner.
7. Activation refuses an identity without required verified MFA enrollment.
8. All non-Owner role, anonymous, missing/stale MFA, origin and duplicate-field denials preserve state/audit.
9. Injected audit insertion failure rolls back role/version/cutoff/session deletion.
10. More than twenty directory/audit records paginate without duplicate results; malformed cursor rejection.
11. Explicit session revocation; recorded actor retrieval; UPDATE/DELETE/TRUNCATE audit denial.
12. Governance migration recreation/rollback; existing Settings, Offers and CMS read/write smoke checks; audit viewer retrieves their actual committed action categories.

All SQL fixture writes and authentication activity were confined to verified disposable databases. Service probes used the disposable database administrator connection, not a separately proven least-privilege SQL role. The controller checks the database identity before migrations or writes, compares all eighteen development table fingerprints and removes only its own exact labelled tmpfs container. No object storage or unrelated Docker resource was changed by this task.

## Real authenticated browser acceptance

Command: GOVERNANCE_BROWSER=1 node scripts/run-governance-verification.mjs (set the process environment in PowerShell first).
Run: 053aff8a-f9d8-4472-8986-924e3dd8ed75. Actual browser password/TOTP login succeeded for a disposable Owner and staff member. Verified Owner directory/audit access, non-Owner role change with persisted reload, new-role permission changes, denial of previously issued privileged sessions, deactivation, reactivation without restoring old sessions, an explicit stale-form conflict, committed audit action display, anonymous denial and insufficient-role redirects. A MARKETING_MANAGER reached content but not staff/audit; after changing to PRODUCT_MANAGER, a fresh login reached the catalogue while the old privileged session was rejected. The real browser showed deactivated sessions could not access administration.

Both routes passed at 375px and 1440px without page overflow: staff 375/375 and 1425/1425 client/scroll; audit 375/375 and 1425/1425. Existing MFA/origin/session-revocation service checks used actual framework authentication and database state. No additional browser MFA-expiry or cross-origin replay is claimed for E1; those denials were integration-tested.

The browser case passed, but its controller's overall source-preservation status was FAILED because a confirmed navigation encoding correction was made during the run. Its database/resource preservation passed. This is not represented as an overall clean browser controller PASS. Subsequent finalized-source integration runs passed with source preservation true. Initial fixture errors (wrong TOTP secret interpretation and duplicate index during migration-recreation setup) were corrected without changing production security or weakening assertions. A generated-directory lint failure while the test server was running passed after the harness removed its owned build output; lint exclusions were not weakened.

## Final checks and preservation

PASS: Prisma validation, TypeScript, ESLint, Next.js 16.4.3 production build and git diff --check. The build used a process-only HTTPS auth origin and read-only PostgreSQL options, preserving exact next-env.d.ts and tsconfig.json bytes through the established snapshot mechanism. Both new routes and all existing administration routes compiled. next-env.d.ts has no diff and was not manually edited.

Affected regressions: 23 authorization checks (including retained-session cutoff denial), 13 dashboard policy/access checks and 11 catalogue route/presentation checks passed. Authorization mock projections were updated to include the new server-owned cutoff; mocks do not constitute database integration evidence. The old development-writing MFA lifecycle harness was not run against aafiyat_dev; actual disposable login/challenge/proof and revocation probes provide the targeted E1 evidence. Unrelated stock/payment/media concurrency suites were not rerun because those semantics were unchanged.

The final read-only development audit confirmed exactly 127.0.0.1:55432/aafiyat_dev, six applied matching migration checksums and all eighteen original table counts/fingerprints unchanged. No pending migration was applied. The final clean controller reports developmentUnchanged=true, preservedSourcesUnchanged=true and preexistingContainersPreserved=true. Disposable containers/tmpfs were removed; original container identities remain. Raw results, logs and browser credentials are outside Git. Sensitive-artifact review includes all pending paths; no secrets, screenshots, generated Prisma output or build artifacts belong to this source change.

## Dependencies and limits

Existing-membership administration is functional in the ten-migration isolated environment. Product Media, D1, D2 and governance migration deployment remain separately authorized work. Deploy the schema and generated client coherently before enabling the updated authorization boundary; missing governance schema fails closed. No permanent Owner/staff identity was created. Secure first-Owner onboarding remains the existing separate operator workflow; invitation, new-account registration, email ownership claiming, TOTP reset and staff onboarding are not implemented here. Production storage/scheduling dependencies from previous work remain unchanged. No confirmed unresolved source/security blocker was found in the tested slice.

## E1G final checkpoint review

Acceptance: PASS for the reviewed checkpoint. Preflight confirmed main at 425183c849dc3d075e6697b941d8d240cb9b062e, matching fetched origin/main, exactly nine modified and nine untracked files, an empty index and unchanged next-env.d.ts. No unrelated or unexplained artifacts were present.

Reviewed the actual authorization/MFA-proof source, trusted-origin configuration, governance transaction, staff/audit routes and forms, migration and test harness. No production source change was required by this review. Only server-authorized OWNER sessions can mutate memberships. Approved non-Owner role assignments, self-denial and no Owner promotion/demotion remain enforced. The global governance lock serializes active-Owner decisions; deterministic per-identity locks coordinate with the existing proof writer, while actor/target row locks and optimistic versions prevent lost updates. Reauthorization occurs within the transaction before mutation. Session deletion, monotonic cutoff, version update and audit insertion commit together.

Proof written before a governance change is revoked by session deletion. Verification completing afterward must obtain the shared identity lock, then reject a challenge at/before the new cutoff. The central guard independently rejects retained/restored old session rows; stale proof cannot bypass the creation cutoff. Reactivation does not restore prior sessions. These findings are supported by actual login/challenge/session tests, not only mock role checks. No old-session or old-challenge privilege-regain defect was confirmed. Already-authorized in-flight requests and broader multi-Owner stress coverage retain the limitations stated above.

Audit reads require audit:read; directory reads require admins:manage. Both are bounded and permission-protected. Exact-microsecond timestamp/UUID audit cursors are stable. Existing settings/offer/CMS evidence is retrieved through the same append-only table, using safe summary projections and restrictive actor references. No endpoint edits/deletes historical evidence. The E1 SQL is additive, ordered tenth, preserves the existing audit CHECK vocabulary and append-only trigger, and matches its documented SHA-256. All nine earlier migration files are byte-identical to HEAD. The SQL LF attribute is checked against staged bytes before committing.

Fresh focused command: node scripts/run-governance-verification.mjs; run 77732cc4-57fe-4d80-a4be-9892e210228b: twelve groups PASS. Development, source and pre-existing-container preservation flags are true, and the owned disposable tmpfs container was removed. Fresh Prisma validation, TypeScript, ESLint, 23 authorization checks, 13 dashboard checks, 11 catalogue presentation checks, production build and Git whitespace checks all pass. The build used a process-only HTTPS origin/read-only database settings and preserved framework-generated file snapshots.

Existing authenticated browser and responsive evidence was reviewed rather than repeated. The browser-finished record is later than the modification times of admin-authorization.ts, session-mfa-proof.ts, admin-governance.ts, auth.ts and staff/actions.ts; no authentication-sensitive edit occurred after acceptance. The browser controller's failed source-preservation flag remains explained as a navigation encoding correction during its run; it is not relabeled as a clean controller PASS. The subsequent clean original and fresh E1G integration runs cover the finalized source. No browser authentication bypass or permanent fixture was introduced.

Fresh read-only audit again confirmed exactly aafiyat_dev on 127.0.0.1:55432, six applied migrations with matching checksums, all eighteen original table counts/fingerprints unchanged and zero administrator memberships. Product Media, D1, D2 and E1 remain unapplied. Secret/artifact scanning covers the full eighteen-path manifest; generated clients, build output, raw evidence, credentials, next-env.d.ts and temporary fixtures are excluded. Source-level governance is accepted; schema deployment and secure future onboarding remain separately authorized operational work.

## Complete changed-file manifest

- `.gitattributes`
- `docs/task-010-e1-admin-governance-verification.md`
- `prisma/migrations/20261030020000_add_admin_governance/migration.sql`
- `prisma/schema.prisma`
- `scripts/run-governance-verification.mjs`
- `scripts/verify-admin-authorization.ts`
- `scripts/verify-admin-dashboard.ts`
- `scripts/verify-governance-integration.ts`
- `src/app/admin/admin-session.tsx`
- `src/app/admin/audit/page.tsx`
- `src/app/admin/dashboard-view.tsx`
- `src/app/admin/staff/actions.ts`
- `src/app/admin/staff/page.tsx`
- `src/app/admin/staff/staff-form.tsx`
- `src/lib/admin-authorization.ts`
- `src/lib/admin-dashboard.ts`
- `src/lib/admin-governance.ts`
- `src/lib/session-mfa-proof.ts`

Pre-checkpoint Git state: main at 425183c849dc3d075e6697b941d8d240cb9b062e, nine modified tracked paths and nine untracked files, empty index. E1G authorizes the reviewed commit and normal push after all gates pass; the resulting commit identity is reported separately. No E2 work started.

## Task 010-E1R - Fresh acceptance after baseline repair

Status: **E1 fresh verification PASS; ready for the small verification-maintenance checkpoint.** No commit or push was performed for E1R.

### Baseline defect and exact controller repair

The original E1 controller required the Task 010-D commit 425183c849dc3d075e6697b941d8d240cb9b062e, which was appropriate during the original uncommitted E1 implementation. E1 was subsequently committed as fc84c6bf86930be99cca508bf02d1ff1e443bf4b. The old assertion therefore rejected the committed implementation before any database baseline or disposable resource was created. A fresh invocation reproduced that failure (run 9c320c3a-7e7f-464e-a5a2-0c23b26360c2).

Before editing, E1R confirmed a clean main worktree and independently resolved both HEAD and refs/remotes/origin/main to the required starting commit fc84c6bf86930be99cca508bf02d1ff1e443bf4b. The controller now resolves both references using git rev-parse --verify with the commit suffix, records branch/head/originMain in report.gitBaseline, requires branch main, and requires exact equality of those resolved commits. Missing references, detached HEAD, other branches and diverged commits fail closed before database testing. There is no environment switch or correctionMode bypass for these checks. The repair's exact starting SHA is confirmed by the preflight and both fresh evidence records rather than becoming another obsolete hardcoded assertion. These checks compare the local remote-tracking reference; no claim of a new remote fetch is made.

Five isolated policy probes passed: matching main accepted and recorded, other branch denied, detached HEAD denied, differing origin denied, missing origin reference denied. They executed the actual controller baseline block with synthetic command results without changing Git refs. No governance assertion, migration, production source, fixture policy or test coverage was changed.

### Fresh integration and browser evidence

Integration command: node scripts/run-governance-verification.mjs. Run 5e090216-02c2-4c7d-9719-8df13479158b: all twelve governance integration groups PASS. Actual Better Auth password/TOTP, old-session revocation, pending-challenge rejection, fresh-login permission changes, concurrency, self/Owner protection, missing/stale MFA, origin denials, audit atomicity/append-only protections, failure rollback, migration recreation/rollback and existing-module probes passed. All ten migrations were applied only to a verified empty disposable PostgreSQL 18.6 tmpfs database.

Browser command: GOVERNANCE_BROWSER=1 node scripts/run-governance-verification.mjs, using process-only TMP/TEMP overrides to a dedicated evidence directory outside Windows Temp. Run 383a5057-f4ce-49f8-96b2-2fb526d433fa: twelve integration groups plus actual authenticated browser acceptance PASS (thirteen harness groups total). The installed Chromium executable drove the existing isolated Next.js server and disposable authentication fixtures. No application code or authorization bypass was introduced.

Fresh browser assertions passed for real Owner/staff password and TOTP login; Owner staff/audit access; PRODUCT_MANAGER and anonymous staff/audit denials; confirmation validation; a persisted PRODUCT_MANAGER-to-MARKETING_MANAGER change; rejection of the old privileged session; explicit stale-form conflict feedback; fresh marketing login with content access and inventory/audit denial; deactivation denial; reactivation without resurrecting old sessions; fresh login after reactivation; explicit session revocation; committed role/activation/deactivation/revocation audit entries; action/entity filters; and the directory empty state. The audit-filter probe waits for the resulting row before inspecting it, avoiding a navigation timing race in the browser driver. Assertions were retained.

Responsive evidence: staff and audit each measured clientWidth=scrollWidth=375 at 375px, and clientWidth=scrollWidth=1440 at 1440px. Four full-page screenshots and the browser-finished assertion record are retained outside Git with the run evidence. No source files were edited while either successful controller was running.

Browser acceptance: **PASS**. Browser controller preservation: **PASS**, independently confirmed by developmentUnchanged=true, preservedSourcesUnchanged=true and preexistingContainersPreserved=true. The disposable container was removed and tmpfs destroyed. The integration-only controller reports the same three preservation flags and successful cleanup.

An earlier E1R browser attempt (b0a8b5c4-f32c-4244-ba07-40f9203f3ebf) could not complete: its Windows Temp run directory no longer existed when readiness/results were written, producing ENOENT. The responsible external removal was not established, and no browser PASS or complete preservation report is attributed to that attempt. Its owned database container was removed; Git showed only the intended controller edit afterward. Repeating with dedicated process-only temporary paths resolved the evidence-directory failure without changing or weakening the harness. The later successful controller and final full database comparison establish preservation for the completed acceptance run.

### Quality gates, checksum and preservation

PASS: Prisma validate; TypeScript --noEmit; ESLint with zero warnings; 23 authorization checks; 13 dashboard policy/access checks; nine dashboard presentation/accessibility checks; seven dashboard session/sign-out checks; eleven catalogue route/presentation checks; ten login form/transport/accessibility checks; Next.js 16.4.3 production build; git diff --check. These regressions used read-only development connections and created no identities. The real MFA/session lifecycle evidence comes from the disposable integration and browser runs; the development-writing onboarding lifecycle harness was not run.

The build used process-only HTTPS authentication origin and default_transaction_read_only=on database options. The existing generated-file snapshot/restore approach preserved next-env.d.ts and tsconfig.json exactly. Final SHA-256 values: next-env.d.ts = 1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b; tsconfig.json = c99dc92a460e0a0e91d0902cd2b5cc8fe639077e351e84149483f70a36746fc5. Neither file has a Git diff.

Governance migration: prisma/migrations/20261030020000_add_admin_governance/migration.sql. SHA-256 remains 9b028814e86ba1b9327e27141780e3c4982f9f9fc7f007567a7f38ab80c507b7. No migration file changed.

After browser acceptance, regressions and build, the final read-only comparison matched all eighteen development table fingerprints against the successful integration baseline. Development remains exactly 127.0.0.1:55432/aafiyat_dev with six applied migrations whose checksums match source, zero administrator memberships and zero authentication identities. Product Media, Settings/Offers, CMS and governance remain unapplied. Pre-existing containers remain present; no unrelated Docker resources were changed. Secure Owner/staff onboarding and pending-schema deployment retain the separate dependencies described above.

### E1R changed-file manifest and final Git status

The complete E1R change manifest contains exactly:

- scripts/run-governance-verification.mjs - replace obsolete SHA assertion with resolved main/origin-main equality and recorded baseline evidence.
- docs/task-010-e1-admin-governance-verification.md - fresh repair/acceptance report.

Sensitive-artifact review of both diffs found no credentials, TOTP secrets, session tokens, raw authentication fixtures, screenshots, generated output or unrelated changes. Raw logs, screenshots and evidence remain outside Git; the successful harness removed its browser-ready credential file. The original eighteen-file E1 manifest above describes the existing committed implementation, not new E1R changes.

Final Git state: main at fc84c6bf86930be99cca508bf02d1ff1e443bf4b, matching refs/remotes/origin/main; exactly the two manifest paths modified, empty index, no untracked source artifacts. No permanent accounts, development migration, commit, push or E2 implementation. Stopped after reporting.
