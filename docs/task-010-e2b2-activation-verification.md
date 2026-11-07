# Task 010-E2B2 staff activation verification

**PASS on 2026-11-08.** Verified against `main` at `984cc7305edb7589a53f459e2ad2e873fdb3ec7d`, matching local `origin/main`. The worktree contains the uncommitted implementation and this report.

## Recipient flow and authorization

The existing `/staff/accept-invitation` page supports invitation and mailbox verification, password setup, and a return visit using native Better Auth email/password sign-in. Once E2B1 provisions the identity, the server selects onboarding by the authenticated user ID and checks the original invitation, email, role, user, and inactive membership. The invitation deadline governs resumption, including after the original E2B1 attempt expires or its cookie is lost. Expiry, revocation, previous consumption, altered bindings and unrelated identities fail closed.

`POST /api/staff/activation` requires the configured exact origin, JSON, the onboarding request header, and a bounded operation shape. Its setup and activation operations require a live password session created within five minutes and after the membership's existing authorization cutoff. Setup and setup-key recovery also ask for the current password. The browser cannot nominate a different binding. An inactive membership or a password-only session fails the existing central admin authorization.

## Better Auth and TOTP

Reviewed the installed Better Auth **1.7.7** email sign-in, two-factor enable, TOTP URI and verification endpoints, internal session adapter, cookie rotation, and Prisma adapter. The existing two-factor plugin produces and encrypts its own pending secret. The setup interface displays the manual authenticator key from that plugin's URI through a scoped, private, no-store response. Responses omit backup codes, native session tokens and the full URI. Reopening setup with the correct password returns the same pending factor. It cannot replace a verified factor.

The request-bound server scope matches the native operation path, trusted origin and exact authenticated user and session. The scope is established only after the application locks and checks the onboarding binding. The native adapter resolves its model delegates through the same Prisma transaction during these calls. Outside the scope, it uses the existing client. Direct native factor-management endpoints remain blocked. The public TOTP route continues handling pending login challenges and cannot verify a pending factor from an inactive staff member's existing session. The local Owner enrollment scope and the session-bound login proof writer retain their original rules.

The scoped verification calls Better Auth's actual TOTP endpoint. Success marks the bound factor verified, enables two-factor authentication on the user, and rotates the session within the transaction. The application rechecks the exact verified factor, the user flag, and retirement of the original session. It uses a durable five-failure budget with a fifteen-minute lockout for enrollment attempts. Only the normal post-activation login challenge may issue administrative session MFA proof.

## Migration and atomic activation

Migration `prisma/migrations/20261030050000_activate_staff_onboarding/migration.sql` is thirteenth in order. Its SHA-256 is `eb222f1995f57f818bc4c0f13d7c964659d471b28cbb050969834d78411dc10b`. The twelve previous migration files match HEAD byte for byte.

The new columns bind enrollment to the exact existing factor and record start time, failures, lockout and completion time. A restrictive composite reference binds the factor to the provisioned user. The transition trigger preserves the original E2B1 mailbox-proof and attempt deadlines for initial provisioning. Subsequent enrollment uses the invitation deadline and keeps the original identity and mailbox proof immutable. Initial inserts cannot fabricate completion. A pending invited membership cannot be activated through the independent governance mutation.

The transaction takes the `88009` governance lock, then the `88008` identity lock, then locks and rechecks membership, invitation, onboarding and session records. After native TOTP succeeds, it consumes the invitation for that user, activates the existing role-bound membership, advances governance version and cutoff, deletes the user's existing sessions and exact obsolete two-factor challenges, and records completed onboarding plus an append-only activation audit. A deferred constraint rechecks the consumed user, membership, factor, completion, audit and expiry at commit. The prior E2A terminal-state trigger makes consumption irreversible.

The response expires onboarding and authentication cookies after commit. The browser receives no enrollment-era session rotation cookie. Fresh access requires the existing password and login TOTP flow, a newly issued session-bound proof, and a session created after the cutoff. The integration probe restored a pre-activation session with a manufactured MFA timestamp and confirmed the cutoff still denied it. Any overlapping password-only login remains subject to the same central MFA requirement.

## Failure and interruption

- Before verification, a recipient can sign in again and recover the same pending factor with their password. Pending factor material remains encrypted in the Better Auth table.
- A test worker reached a PostgreSQL advisory-lock barrier inside the activation audit insert, after native verification and session rotation. The harness terminated that process, released the barrier and waited for rollback. Factor verification, user state, membership, invitation, onboarding, sessions and audit matched the pre-activation snapshot. A fresh password login resumed the exact pending factor.
- Injected audit failure and a delayed audit crossing invitation expiry each rolled back native and application writes. Concurrent activation produced one consumed invitation and one activation audit. A lost completion response can be resolved through a fresh password and TOTP login, which reads the completed state without repeating activation.
- Revocation and expiry prevent further use of the binding. They preserve inactive historical records. Production mail still needs a provider and operational key configuration. Existing recovery and factor reset remain outside this workflow. The integration runtime emitted a non-failing `pg` overlapping-query deprecation warning for a future major version.

## Verification evidence

Evidence is outside Git under `C:/Users/wadud/.codex/tmp/task-010-e2b2/`. Each integration controller verified PostgreSQL **18.6**, applied all 13 checksum-matched migrations in a disposable localhost tmpfs container, preserved pre-existing containers and source files, and removed its own container. The browser uses the isolated mail sink and native Better Auth routes.

| Gate | Result | Run ID |
| --- | --- | --- |
| Activation controller with `ONBOARDING_BROWSER=1` and `--activation` | 10 E2B2 and 25 E2B1 groups, plus browser acceptance | `bcd273be-b980-420d-89f8-eec221d4acae` |
| Invitation controller with `--invitations` | 24 E2A groups passed | `3e155b49-89b8-4867-91fd-8e1763109d5e` |
| Governance controller | 12 E1 groups passed | `593f7548-91fc-4a13-b5f0-42a6b2773858` |
| Focused auth and Owner protection | 19 HTTP-handler and 18 read-only/in-memory Owner rehearsal checks passed | `focused-results.json` |
| Crypto and input regressions | 6 invitation and 4 onboarding checks passed | `focused-results.json` |
| Quality | Prisma validation, TypeScript, ESLint, production build, whitespace and sensitive-artifact review passed | `build-results.json` and final source review |

The integration cases cover lost E2B1 cookie and elapsed attempt deadline, actual password login and wrong-password denial, wrong identity and forged role denial, concurrent enrollment, wrong and cross-identity TOTP, durable lockout, revoked and expired invitations, audit failure, worker termination, one-time consumption, stale and cross-origin requests, restored old-session denial, and fresh permission checks for Product, Order and Marketing managers. Native signup and direct factor controls remain blocked, including for a disposable Owner. Activation audit summaries contain safe state, role and count fields. PostgreSQL statement logs were checked for the tested raw password, setup key and invitation secret. Application code does not log request bodies or native authentication responses.

Browser acceptance exercised the full journey from invitation and independent mailbox code to password setup, sign-in after clearing cookies, setup-key recovery after reload, TOTP verification and activation. It checked revoked, expired and replayed credentials, incorrect password and TOTP, pre-activation denial, replay of the enrollment session, and sign-out. A fresh native password and login TOTP unlocked Orders and denied Staff. The invitation, password confirmation, authenticator setup and activation-completed views fit at 375px and 1440px with no horizontal overflow. The authorized setup key appears only in the transient setup UI and response. Server-rendered entry HTML, completed HTML and browser logs were checked for fixture secrets and codes. The controller removed the browser-ready credential file.

## Development preservation and Git state

The final read-only audit matched all 18 original development table fingerprints and all six applied migration records and checksums. Development remains at six applied migrations and seven pending, with zero auth users and zero administrators. All test writes ran in disposable databases. `next-env.d.ts` and `tsconfig.json` match their original bytes. HEAD and local `origin/main` remain at the starting SHA. The index is empty, with 12 modified and 6 new files in the worktree. No commit, push or database deployment was performed.

## Complete changed-file manifest

1. `.gitattributes`
2. `next.config.ts`
3. `prisma/schema.prisma`
4. `scripts/run-governance-verification.mjs`
5. `scripts/verify-governance-integration.ts`
6. `scripts/verify-invitations-integration.ts`
7. `scripts/verify-staff-onboarding.ts`
8. `src/app/staff/accept-invitation/onboarding-form.tsx`
9. `src/lib/admin-governance.ts`
10. `src/lib/auth.ts`
11. `src/lib/invitation-delivery.ts`
12. `src/lib/staff-onboarding.ts`
13. `docs/task-010-e2b2-activation-verification.md`
14. `prisma/migrations/20261030050000_activate_staff_onboarding/migration.sql`
15. `src/app/api/staff/activation/route.ts`
16. `src/app/staff/accept-invitation/staff-activation.tsx`
17. `src/lib/staff-activation.ts`
18. `src/lib/staff-enrollment-scope.ts`

## E2B2-G final security review

**PASS for the Git checkpoint.** The complete 18-file diff was reviewed against the starting commit. Password resumption derives the exact identity from an authoritative Better Auth session. The locked lookup rechecks the invitation, verified mailbox binding, user, inactive membership, assigned staff role, session token and freshness. Recovery uses the original pending factor and cannot reset credentials, replace the factor, change the binding or revive an invitation. The server-only scope authorizes exact native TOTP operations. Public signup and public factor-management endpoints remain disabled.

The review distinguishes four states:

1. Pending onboarding is an inactive membership with its immutable invitation binding and, once configured, one encrypted pending factor. It survives a return visit independently of the E2B1 capability.
2. Better Auth's factor verification and user flag are persistent factor state only once their transaction commits. For activation, native factor verification, user updates and session rotation resolve their Prisma delegates through the scoped transaction client.
3. Committed activation consumes the invitation once, marks onboarding complete and advances the membership version and authorization cutoff. The same transaction revokes sessions and obsolete challenges and inserts the activation audit. The deferred constraint checks the exact binding, verified factor, active membership, audit and invitation deadline. The previous append-only audit trigger remains intact.
4. Administrative MFA proof belongs to a new session issued through a post-cutoff password challenge and successful TOTP login. The enrollment-era session cannot satisfy this proof check. A restored pre-activation session with a manufactured proof timestamp was still rejected by the cutoff.

The worker-interruption verdict is **PASS**. The test observed a separate process blocked in the activation audit insert after native TOTP verification and session rotation. After termination and PostgreSQL rollback, it compared the complete factor, user and session records as well as invitation, onboarding, membership and audit state. A new password session recovered the same pending factor. This directly checks the Better Auth writes as part of the shared transaction. An independent injected audit error and an expiry across the delayed audit also rolled back the full operation.

The checkpoint retained the successful 10 E2B2 groups, 61 E2B1/E2A/E1 regressions, five browser evidence groups and production-build record. Responsive measurements were verified at both 375px and 1440px. All 13 migration checksums match the disposable PostgreSQL 18.6 records, including `20261030050000_activate_staff_onboarding/migration.sql` with SHA-256 `eb222f1995f57f818bc4c0f13d7c964659d471b28cbb050969834d78411dc10b`. The twelve prior migration files and both generated configuration files are byte-identical. A fresh read-only audit matched all 18 development fingerprints and six applied migration records. Seven migrations remain pending and permanent auth user and administrator counts are both zero. Source and container preservation, cleanup, and the sensitive-artifact review passed. No runtime source or test was changed during the checkpoint. The preflight Git state above is retained as implementation evidence. The checkpoint uses the same 18-file manifest.

Production operation remains pending. It requires a reviewed email-provider adapter and configuration for invitation and mailbox-verification mail, production secret and key management, deployment of the pending migrations and matching application client, authorized permanent Owner provisioning, and scheduling and monitoring of the invitation-delivery worker. The existing local-sink acceptance does not exercise production email. Factor reset and recovery remain outside this workflow.
