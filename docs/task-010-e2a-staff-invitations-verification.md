# Task 010-E2A - Staff Invitations and Delivery Foundation

Status: **PASS** for the implemented E2A scope, verified on 2026-10-30. OWNER can prepare, inspect, revoke and explicitly expire invitations through real PostgreSQL-backed `/admin/staff` controls. Delivery is truthful when disabled and verified against an isolated local mail sink when configured. Redemption, identity creation, password creation, enrollment and activation remain E2B work. No commit, push, production email or development migration was performed.

## Preflight and preserved baseline

Started on clean `main` at `57f18796813fe9acd60dd26ece2d05f3d735059d`, matching the local `refs/remotes/origin/main`. Reviewed the current Prisma/authentication/membership/session models, central authorization, E1 governance, MFA proof writer and advisory locks, staff UI/actions, append-only audit implementation, authentication foundation, Owner onboarding rehearsal and E1 verification report.

Read-only preflight confirmed PostgreSQL 18.6 at exactly `127.0.0.1:55432/aafiyat_dev`, six finished applied migrations with matching checksums, eighteen development tables, zero authentication users and zero administrator memberships. Product Media, Settings/Offers, CMS and E1 governance were the four committed pending migrations. The original eighteen table counts/fingerprints and generated configuration bytes were captured outside Git before implementation. No Owner onboarding utility or development-writing authentication fixture suite was run.

## Additive schema and lifecycle

New eleventh migration: `prisma/migrations/20261030030000_add_admin_invitations/migration.sql`.

SHA-256: `4ef91224c8d26c052d5b865fa6b787d2ba05b82957fdfe8f8d9ac6bf7a22c4aa`.

`admin_invitations` stores a UUID, normalized destination email, approved non-Owner role, unique SHA-256 token verifier, optional encrypted delivery material, lifecycle and delivery states, restrictive inviter/revoker references, UTC creation/update/expiry timestamps, positive optimistic version, bounded attempt count, next-attempt time, lease identity/deadline, safe error category, hashed provider receipt and confirmation timestamp. Nullable consumed timestamp and restrictive authentication-user reference are reserved for E2B and are not written by E2A.

Lifecycle states are `pending`, `delivered`, `revoked`, `expired` and reserved `consumed`. An invitation lasts 48 hours by default. A partial unique index prevents two pending/delivered rows for the same normalized email. Before replacing a naturally expired active row, issuance atomically expires it and records its expiry. Explicit revocation/expiry also removes encrypted material and any lease. Terminal rows cannot be updated back into an active state. Issuance identity/email/role/verifier/expiry are immutable; every supported update must advance the version exactly once and cannot reduce attempt count. The transition guard is enabled ALWAYS.

CHECK constraints restrict roles, states, normalized email shape, verifier/receipt format, expiry bounds, attempts (zero through five), lease consistency, confirmed-delivery evidence, terminal metadata and sensitive-material erasure. Indexes cover expiry scanning, delivery scheduling, inviter chronology and restrictive references. Prisma models reflect the fields and ordinary indexes; partial uniqueness/scheduling indexes and lifecycle constraints live in reviewed SQL. The new migration has a byte-preserving Git attribute. All ten preceding migration files remain byte-identical to HEAD, including applied and pending SQL.

Display computes natural expiry immediately even before the worker persists cleanup. Mutation and delivery decisions use database time; a revoked/expired invitation cannot be reopened. If provider confirmation crosses expiry, the row becomes expired while retaining accepted-delivery evidence. Possession of an invitation does not create a session or confer any privilege; there is no acceptance URL or consumption endpoint.

## Token secrecy and identity ownership

Each secret is generated with `randomBytes(32)` (256 cryptographic random bits), represented as canonical base64url. The stored verifier is domain-separated SHA-256. There is no plaintext invitation-secret database column. Retained delivery material is AES-256-GCM encrypted with a random 96-bit nonce, authenticated tag and invitation-UUID-bound associated data. The encryption key must be a separately configured, canonical base64 32-byte `ADMIN_INVITATION_ENCRYPTION_KEY`; there is no Better Auth key fallback or key derivation. Misconfigured or reused authentication-key material fails closed.

Without that key, creation retains the hash only and reports delivery not configured. Such a row has no recoverable delivery material: configure delivery/key management, then explicitly revoke and reissue rather than trying to recover a discarded secret. With a key but no provider, encrypted material may wait until delivery is configured or the invitation expires. Key rotation/recovery and production secret management require an operator plan; changing the key cannot decrypt existing envelopes and does not weaken verification.

Email normalization trims outer ASCII spaces, lowercases, bounds the address/local/domain lengths and rejects control/non-ASCII/invalid addresses. Any existing Better Auth identity with that case-insensitive email is refused, including inactive/unverified identities and identities with memberships. An email-string match never binds an invitation to an existing identity. E2B must independently review and enforce identity binding and recheck conflicts during redemption; E2A supplies no claiming mechanism.

Administrator read projections and action results omit verifiers, ciphertext, secrets, lease details and authentication internals. Audit records contain IDs, role/state categories, versions/attempts where relevant, never destination payloads or secret material. Untrusted provider receipt IDs are hashed before persistence, including when a provider echoes a secret as its receipt. No invitation link is generated or displayed. The local sink's private email body intentionally receives the secret for delivery testing; it is not a browser response or application log.

## Authorization, audit and abuse controls

Issuance, revocation and manual expiry require the existing uncached `admins:manage` guard, an actual OWNER membership, current Better Auth session, exact session-bound verified TOTP proof and trusted configured origin. Cross-site requests and duplicate/extra/forged actor/session fields are rejected. Only PRODUCT_MANAGER, ORDER_MANAGER and MARKETING_MANAGER may be invited. Inputs and confirmations are server-validated; closing a row requires its current optimistic version and `CONFIRM`.

Within bounded real transactions, mutations take the existing governance-wide advisory lock `(88009,1)`, then the actor's existing MFA/governance identity lock `(88008,hashtext(userId))` and membership row lock, and reauthorize with the transaction's current membership/session state. Invitation rows are locked for close operations. This preserves E1's lock ordering and prevents invitation writes from retaining authorization across a committed actor deactivation/revocation. Concurrent duplicate issuance is serialized and backed by the partial unique index. Concurrent closes have one winner and a stale-version error. Persisted hourly counts allow at most ten invitations per inviter and one hundred globally; the shared lock prevents concurrent count bypass. Counts include closed invitations and are not reset by revocation.

Successful invitation state changes and their audit records commit together. New audit actions are `invitation.create`, `invitation.revoke`, `invitation.expire` and `invitation.delivery`. Existing audit actions, restrictive historical actor references and database append-only protections remain intact. The audit viewer recognizes the added actions and safe attempt summaries. Automatic expiry/delivery retains the historical inviter as sponsor with `kind=automatic` or `kind=worker`; manual closure records the authenticated operator. Worker execution is an operator-only server module/CLI, not a public or administrator-browser delivery endpoint.

No production change was made to `auth.ts`, `admin-authorization.ts`, `admin-permissions.ts`, `session-mfa-proof.ts`, MFA freshness, session cutoff, Owner protection, signup restrictions or factor-management endpoints. E1 role/status operations continue to revoke sessions and reject old challenges/cookies.

## Delivery architecture and production readiness

Delivery metadata/encrypted material form a small outbox on the invitation row; no second authentication or audit system was created. `scripts/deliver-admin-invitations.ts` runs at most twenty worker iterations. Operator command: `node --conditions=react-server --import tsx scripts/deliver-admin-invitations.ts` in a separately authorized environment. This command was not run against development data.

The default delivery mode is disabled. `ADMIN_INVITATION_DELIVERY=local-sink` requires a non-production environment, the independent encryption key, and `ADMIN_INVITATION_MAIL_SINK_URL` pointing to `http://127.0.0.1:<port>/messages` without credentials/query/fragment. Redirects are forbidden. E2A intentionally ships no production provider adapter and rejects local-sink mode in production. No production email was sent. The UI displays “Delivery not configured” or “Pending delivery”, never a fake “Invitation sent”.

Claims commit a random lease and increment attempts before network work. A second transaction reacquires the governance and row locks, verifies the exact live lease/state/expiry, authenticates/decrypts the envelope and sends only through the configured adapter. Worker claims, confirmation/failure and expiry transitions are audited. A live lease excludes peers; expired leases can recover without exceeding five attempts. HTTP has a two-second deadline; leases last thirty seconds, transaction timeout is fifteen seconds, lock timeout two seconds and statement timeout five seconds. Failed attempts use bounded exponential backoff (first retry sixty seconds). Exhaustion erases the envelope and requires revocation/reissue for a new invitation.

The invitation UUID is the stable provider idempotency key. Successful delivery requires an OK response with explicit `accepted=true` and a bounded valid receipt ID; only its cryptographic hash and confirmation timestamp are stored. “Provider accepted” is not proof of recipient opening or final mailbox delivery. HTTP failure, unconfirmed success, decryption failure, audit failure and lease uncertainty do not falsely report acceptance. Confirmed acceptance across expiry is retained while access expires. Revocation/expiry clears future work and prevents later sends; it cannot recall a message already accepted before closure. If a process/database failure follows provider acceptance, the committed claim remains retryable and the provider must deduplicate the same invitation ID. Delivery is not claimed to be transactionally exactly-once across PostgreSQL and email.

Production sending still needs a reviewed provider adapter, sender/domain configuration, idempotency/receipt behavior, operational scheduling and independent key management. Configure/deploy those separately, along with coherent migration/client deployment. The local adapter sends a reference/secret in a private test email and explicitly says redemption is not yet available; acceptance URL construction belongs to E2B.

## Protected administration controls

`/admin/staff` retains existing membership controls and adds a protected invitation section: email and approved-role selection, role descriptions, real submission state, bounded exact-email filtering, twenty-row UUID cursor pagination, lifecycle/delivery state, expiry/creation timestamps, attempt/version information and confirmed revoke/expire controls. Successful closure replaces the editable form with its committed terminal status. Validation, duplicate/conflict/access errors, empty results and loading states are functional. No secret is passed to client components. Existing permission-gated navigation is reused.

`/admin/audit` shows committed invitation actions alongside Settings, Offers, CMS and E1 actions using the existing safe viewer. No new public route, signup, redemption, password or TOTP endpoint was added.

## Integration and browser evidence

Controller remains fail-closed on `main` and equality of resolved HEAD and local origin/main, recording both. Its new `--invitations` mode selects the invitation harness, requires eleven migrations, fingerprints tracked and untracked non-ignored source files, and fails if pre-existing containers are lost. The original E1 harness still runs every governance group, with only its expected migration count advanced to eleven. No authentication assertion was removed or weakened.

Commands use a dedicated process-only TMP/TEMP evidence directory outside Windows Temp; configuration and raw evidence remain outside Git.

- Invitation integration: `node scripts/run-governance-verification.mjs --invitations`; finalized run `4e5efd0c-cffa-4252-82c1-01ad0e26cd89`: **24 groups PASS**.
- Existing E1 governance regression: `node scripts/run-governance-verification.mjs`; run `6709f93d-a716-4ab5-81d9-c018338e19ac`: **12 groups PASS**.
- Browser acceptance: set process-only `INVITATION_BROWSER=1`, then run the invitation command; run `8e43f33e-4f62-4810-9faa-56e7947642a4`: **24 integration groups plus authenticated browser group PASS**, with ten recorded browser assertion groups.

All three successful controllers applied all eleven migrations only to verified empty disposable PostgreSQL 18.6 tmpfs databases, reported `developmentUnchanged=true`, `preservedSourcesUnchanged=true` and `preexistingContainersPreserved=true`, and removed their exact labelled containers/tmpfs. Source was not edited while those runs were active. Disposable auth fixtures use real framework password hashes, encrypted verified factor fixtures and actual password/TOTP login; production enrollment/authentication was not bypassed or weakened. Persistence uses actual shared application Prisma transactions and PostgreSQL, not mocked storage. As in E1, these service probes use the disposable database administrator connection; they do not establish least-privilege production SQL-role readiness.

The 24 invitation groups cover Owner creation without account creation; three allowed roles and Owner/forged-field denial; concurrent normalized duplicates; invalid/existing identity destinations; 256-bit hash/envelope secrecy; irreversible revocation; stale close versions; natural/manual expiry and reissue; database constraints/immutability; disabled delivery; failures/unconfirmed responses/five-attempt exhaustion; real sink confirmation and stable idempotency; concurrent claims; malicious receipt echo; live/expired leases; provider acceptance followed by audit rollback and idempotent recovery; delayed finalization crossing expiry; cancellation/expiry before future delivery; missing/stale MFA and non-Owner denial; anonymous/cross-origin/duplicate/session-field denial; create/revoke/claim audit rollback; durable concurrent rate limit; migration recreation/rollback and append-only audit; and E1 deactivation/cutoff plus token absence in PostgreSQL logs/read DTOs. The sink recorded twelve HTTP attempts and six unique accepted invitation IDs, including intentional failed/unconfirmed/retried requests.

Browser acceptance used installed Chromium and the existing isolated Next.js test server. Actual Owner and non-Owner password/TOTP login passed. Verified Owner invitation access/creation; pending/disabled-delivery state after reload; normalized duplicate and invalid-email feedback; real non-Owner server-action denial; persisted revocation and encrypted-material removal; stale-form conflict; bounded filter/empty state; explicit expiry; stale MFA-proof and deleted-session mutation denial; committed audit entries; and absence of the known secret, verifier and envelope from HTML, console and action responses. MFA fault injection and session deletion occurred only in the disposable database, after real login; stale proof was restored before the separate revocation probe. No permanent fixture was created.

Responsive staff/audit measurements were clientWidth=scrollWidth=375 at 375px and clientWidth=scrollWidth=1440 at 1440px. Four screenshots were inspected and retained outside Git. Browser PASS and controller-preservation PASS are independently recorded. Driver readiness was corrected to wait for the committed row after its close form is removed and to keep the active tab's existing session check stable before input; development HMR does not provide reliable network-idle readiness. No source edit or production authorization change was used to make browser acceptance pass.

Earlier attempts are not relabeled as passing: a fixture assertion initially tried to JSON-serialize a Prisma BigInt without a serializer; a receipt-hash edit introduced a replacement-string SQL quoting/duplication error in the new unapplied migration. Both were corrected and all later migration/tests passed. Independent source review found and rechecked the confirmed-receipt/expiry correction, with no remaining Important findings. The deterministic delayed-finalization probe uses actual local HTTP acceptance and the exact shared finalization helper under real locks/transactions; it does not pretend to be an additional full password/enrollment workflow.

## Final quality and preservation

PASS: Prisma validation, TypeScript `--noEmit`, ESLint with zero warnings, five crypto/input checks, 23 authorization checks, thirteen dashboard policy checks, nine dashboard presentation checks, seven dashboard session/sign-out checks, eleven catalogue checks, ten login form/transport/accessibility checks, the 24 invitation and twelve E1 integration groups above, authenticated browser acceptance, Next.js 16.4.3 production build, whitespace and sensitive-artifact review.

The production build used process-only HTTPS auth origin and read-only database options. Generated configuration snapshots preserved the original bytes, without manual content changes. Final SHA-256: `next-env.d.ts` = `1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b`; `tsconfig.json` = `c99dc92a460e0a0e91d0902cd2b5cc8fe639077e351e84149483f70a36746fc5`. Neither has a Git diff.

After the browser, regressions and build, a final read-only comparison matched all eighteen original development table fingerprints and the six original applied migration records/checksums. Development still has zero authentication users and administrator memberships. The invitation migration was not applied to `aafiyat_dev`; it joins the previous four pending migrations. All ten older migration files match original HEAD bytes. No checkout/payment/inventory accounting was changed. No unrelated Docker resources, object storage or permanent records were touched. Generated client/build output, screenshots, mail fixtures, keys, logs and raw evidence are excluded from Git. The browser-ready credential file was removed by the harness; mail sink and browser/server resources were closed.

## Remaining E2B and deployment dependencies

E2A is functional and accepted within the invitation/delivery foundation boundary. E2B must implement reviewed acceptance/consumption, identity binding, password creation, controlled TOTP enrollment, activation and fresh-session safety. Public signup, email-based claiming, Owner invitations, TOTP recovery/reset and permanent accounts remain absent. Production provider configuration, deployment of pending migrations and real onboarding require separate authorization. No E2B work was started.

## Complete changed-file manifest and Git status

Exactly nineteen E2A paths:

- `.gitattributes`
- `docs/task-010-e2a-staff-invitations-verification.md`
- `prisma/migrations/20261030030000_add_admin_invitations/migration.sql`
- `prisma/schema.prisma`
- `scripts/deliver-admin-invitations.ts`
- `scripts/run-governance-verification.mjs`
- `scripts/verify-governance-integration.ts`
- `scripts/verify-invitation-security.ts`
- `scripts/verify-invitations-integration.ts`
- `src/app/admin/staff/actions.ts`
- `src/app/admin/staff/invitation-form.tsx`
- `src/app/admin/staff/invitations.tsx`
- `src/app/admin/staff/loading.tsx`
- `src/app/admin/staff/page.tsx`
- `src/lib/admin-governance.ts`
- `src/lib/admin-invitations.ts`
- `src/lib/invitation-delivery-config.ts`
- `src/lib/invitation-delivery.ts`
- `src/lib/invitation-secrets.ts`

Final Git state: `main` remains at `57f18796813fe9acd60dd26ece2d05f3d735059d`, matching local origin/main. Seven tracked paths modified and twelve new files, empty index, no unrelated changes. Only the manifest belongs to E2A. No commit or push. Stopped after reporting.

## Task 010-E2A-G - Final review and checkpoint authorization

Checkpoint acceptance: **PASS**. The implementation-phase Git status above is retained as historical evidence. E2A-G separately authorizes the exact nineteen-path checkpoint and normal push, with the resulting commit identity and remote synchronization reported after completion.

Fresh preflight confirmed main and local origin/main at the expected `57f18796813fe9acd60dd26ece2d05f3d735059d`, exactly the reported seven modified and twelve new files, an empty index and no unexplained artifacts. Reviewed the complete manifest/source, including authorization and transactional reauthorization, identity refusal, role restrictions, token/envelope handling, terminal lifecycle, partial uniqueness, delivery receipts/leases and atomic append-only audit. An independent source-only reviewer found no blocking security or correctness defect; no application changes were required. Authentication/MFA/session guards, permission matrix and public-signup restrictions are unchanged. No E2B endpoint or account provisioning was added.

Reused the actual successful 24-group invitation, 12-group E1, authenticated browser and quality/build records above rather than repeating completed suites. Verified their eleven applied disposable migration checksums against current source, all preservation flags and cleanup, ten browser assertion groups, and the absence of the browser-ready credential file. Non-documentation manifest modification times precede the successful browser controller's start. The new migration still hashes to `4ef91224c8d26c052d5b865fa6b787d2ba05b82957fdfe8f8d9ac6bf7a22c4aa`; all ten older migration files remain byte-identical to HEAD.

Fresh database access was read-only: all eighteen development fingerprints match the original preflight, the six applied migration records/checksums are unchanged, five migrations remain pending and authentication-user/admin counts remain zero. Original next-env.d.ts and tsconfig.json bytes are unchanged. No migration, email sending or fixture creation was performed for this checkpoint.

Delivery limits remain explicit: only isolated local-sink delivery was tested; production email is unconfigured and has no adapter in E2A. Provider acceptance does not establish opening or mailbox delivery. Crash recovery after provider acceptance requires idempotent deduplication; confirmation/audit finalization cannot be globally atomic with an external mail provider. Closure blocks future work but cannot recall accepted mail. Key management, production provider/scheduling, least-privilege SQL validation and coherent schema deployment remain operational dependencies; acceptance, identity binding, password setup, TOTP enrollment and activation remain E2B scope.

Checkpoint staging is restricted to the nineteen paths above. Whitespace, sensitive-artifact and staged-byte reviews exclude credentials, raw links/tokens/mail, logs, screenshots, generated clients, build output and next-env.d.ts. No unrelated resource or production behavior was changed during review. No completed tests were rerun and no E2B work was started.
