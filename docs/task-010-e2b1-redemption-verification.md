# Task 010-E2B1 — invitation redemption verification

Result: **PASS**, 2026-10-30. Implemented and verified locally; not committed, pushed, deployed or applied to the development database. Branch `main`, HEAD and origin/main `ac23e813dd1205396ebcd0ca22353fdfadf79872`; starting worktree was clean.

## Implemented workflow

`/staff/accept-invitation` provides explicit invitation reference/secret entry, requesting an independent mailbox code, code verification, password confirmation and an inactive-account completion screen. `/api/staff/onboarding` implements the bounded public workflow. Credentials never enter URL paths/query strings. The page has no administration shell, no indexing, and no-referrer headers. API responses are private/no-store; errors do not disclose invitation or identity existence.

Only a delivered, confirmed, unexpired invitation for PRODUCT_MANAGER, ORDER_MANAGER or MARKETING_MANAGER can proceed. Its immutable email and role remain authoritative. Revoked, expired, consumed, unsupported-email and conflicting-existing-identity cases fail closed. A separate random 256-bit attempt capability uses an HttpOnly, SameSite=Strict cookie scoped to `/api/staff/onboarding` (Secure over HTTPS), with only its hash stored. It grants no authenticated or administrative session.

POST requests require the configured exact origin, JSON, a custom CSRF header and bounded input. They also reject a cross-site Fetch Metadata header. Durable global operation budgets, invitation/attempt budgets, row locks and the existing governance advisory-lock convention coordinate concurrent requests. Password provisioning has one winner and retries cannot reset its password or create another identity.

## Mailbox proof and delivery

An independent eight-digit cryptographically random code is sent only to the stored invitation email. `STAFF_ONBOARDING_VERIFICATION_KEY` must be configured as an independent 32-byte base64 key, distinct from authentication and invitation-delivery keys. The database stores only an HMAC-SHA256 verifier bound to the attempt and challenge; raw codes exist only in transient delivery memory. Proof expires after ten minutes, challenges allow five incorrect attempts, attempts allow ten verification attempts and three mail requests with a sixty-second cooldown; additional per-invitation and global durable limits apply. Replacement invalidates previous codes and consumption is atomic/single-use.

The reservation, budget and pending challenge commit before delivery. The shared approved local-mail delivery boundary requires explicit bounded provider confirmation and stores only a hashed receipt. An unconfigured or failing provider displays delivery unavailable, never a fake sent/verified result. No code, raw invitation link, password or capability is written to audits, logs or API DTOs. E2A delivery behavior remains covered by its regression suite.

Testing used the isolated local mail sink, not production email. Production provider integration remains unconfigured; this report does not claim production email readiness. Independent key deployment/rotation, production delivery operations and application/schema deployment require their own operational review.

If the process stops after reserving a code, its pending/unconfirmed challenge cannot verify; after cooldown the recipient can request a replacement within the bounded budget. If a provider accepted mail but the database confirmation fails, the code remains unusable. Already accepted external email cannot be unsent; revocation/expiry still blocks verification and provisioning. There is no persisted plaintext or encrypted mailbox-code outbox and no automatic code replay. Delivery uses a bounded HTTP timeout while coordinating database locks. Process-kill recovery was not experimentally injected; durable progress, browser reload, transaction failure/rollback and retry behavior were tested.

## Actual Better Auth provisioning

Inspected installed Better Auth **1.7.7** implementation: `dist/api/routes/sign-up.mjs`, `sign-in.mjs`, `db/internal-adapter.mjs`, `context/create-context.mjs` and `crypto/password.mjs`. Signup hashes with the configured password context and links a `credential` account with `accountId = user.id`; native sign-in verifies that account/password. Generic signup can create sessions and its adapter operations do not share this application's provisioning transaction, so that endpoint is not used.

The restricted workflow calls the installed `auth.$context.password.hash` and creates the existing Better Auth User and credential Account records in the same Prisma transaction as the inactive AdminUser, onboarding binding and audit. Passwords require matching confirmation and the existing configured 12–128-character bounds. No independent hashing convention or generic user-creation API was added. Provisioning fails closed if future Better Auth create hooks or custom user validation would otherwise be bypassed.

The actual native sign-in handler uses Zod email validation. A compatibility review found that the historical invitation normalizer admitted some addresses that this handler rejects. The application now directly pins the already installed Zod **4.6.5**, uses the same email validator for new invitations and redemption eligibility, and preserves historical invitation inspection/revocation. This prevents creating unusable accounts without rewriting the immutable invited email. The positive integration path includes a plus-address and real native password login. The lockfile adds only the direct dependency importer, without changing resolved package versions.

`emailAndPassword.disableSignUp = true` remains unchanged. `auth.ts`, central authorization, permission matrix and session-bound MFA proof writer remain unchanged. User emailVerified is true only after the independent mailbox proof; twoFactorEnabled is false, membership is inactive, no factor/session is created by provisioning, no mfaVerifiedAt is written and the invitation remains delivered/unconsumed. A later explicit native password login succeeds but all privileged authorization fails.

## Database and atomicity

Migration: `prisma/migrations/20261030040000_add_staff_onboarding/migration.sql`.

SHA-256: `2b3a134a520ee33d35f80ebc6386ad23e43ad4655d3b1e5c3497f24b82e8830f`.

The twelfth migration follows `20261030030000_add_admin_invitations`. It adds `admin_onboarding`, `admin_mailbox_challenges` and `staff_onboarding_limits`, not duplicate authentication tables. Restrictive foreign keys, bounded fields, partial uniqueness, optimistic versions, irreversible proof/terminal-state guards and exact user/membership binding protect durable state. Existing audit vocabulary expands for safe onboarding actions; append-only protections remain enforced. All eleven prior SQL migrations are byte-identical to HEAD.

Attempts expire after thirty minutes. Provisioning binds invitation, immutable email/role, consumed mailbox challenge, new User and inactive AdminUser. Database guards enforce the final eligibility deadline as well as inactive/no-factor binding. A review identified a deadline race across asynchronous hashing or delayed writes; eligibility is rechecked after hashing, in the binding trigger and after audit using the database clock. Deterministic delayed account-insert and audit-insert tests now prove complete rollback when a deadline crosses during the transaction. Audit failure also rolls back identity, credential, membership and progress together.

## Recovery and E2B2 boundary

Reload with the valid capability resumes durable progress. Verified proof can be renewed within issuance limits; completed provisioning is idempotent and never resets a password. Losing a capability before provisioning requires waiting for the active attempt to expire before another bounded attempt; at most three attempts per invitation are permitted. Losing/expiring it after provisioning never permits recreating or claiming the identity.

Revocation/expiry closes applicable attempts and invalidates unused challenges. Provisioned identities and historical references remain inactive and retained. There is no broad deletion, email-based rebind, cleanup endpoint or recovery bypass. Abandoned inactive identities require a separately reviewed, audited operator decision using exact invitation/onboarding/user/membership/account identifiers; retain history and restrictive references. An expired invitation must not be revived by cleanup.

E2B2 must implement reviewed password-authenticated resumption, actual TOTP enrollment and verification, renewed invitation/progress/identity binding checks, and atomic final invitation consumption plus membership activation with governance cutoff/session revocation. None of those operations exists in E2B1. No Owner is created and no success screen claims activation or redirects into administration.

## Final-source verification evidence

Evidence is outside Git under `C:/Users/wadud/.codex/tmp/task-010-e2b1/`; private mail/fixture material, screenshots and generated build artifacts are excluded from the manifest. All controller runs used verified PostgreSQL **18.6**, localhost-only disposable tmpfs containers and all twelve migrations. Each recorded matching migration checksums, development/source preservation, preserved pre-existing containers and verified disposal of its own container/tmpfs.

| Run | Final result | Evidence directory suffix |
| --- | --- | --- |
| `node scripts/run-governance-verification.mjs --onboarding` | 25 integration groups PASS | `aafiyat-onboarding-010e2b1-d277dca3-1681-4e0e-b51f-ddc5fd8b7ed8` |
| `node scripts/run-governance-verification.mjs --invitations` | 24 E2A groups PASS | `aafiyat-invitations-010e2a-abda720c-203c-418a-963d-1e3ea49fe58b` |
| `node scripts/run-governance-verification.mjs` | 12 E1 governance/MFA groups PASS | `aafiyat-governance-010e1-7b48f72b-f9c9-46f7-a945-b2bb8a21a621` |
| `ONBOARDING_BROWSER=1` with onboarding controller | 25 integration groups plus browser group PASS | `aafiyat-onboarding-010e2b1-65c69689-a9bc-4621-bd12-5f46a051766d` |

Integration coverage includes real Owner password/TOTP issuance and invitation delivery; independent mailbox proof; incorrect/replayed/concurrent codes; credential expiry/revocation/consumption/undelivered denial; duplicate active attempts; exact email/role and identity-conflict denial; unsupported native-login emails; concurrent provisioning; immutable verified binding; real password hash/native sign-in compatibility; inactive administrative denial across all ten permissions; retry without password reset; proof renewal; delivery disabled/failure; durable retry budgets; origin/CSRF/input bounds; audit and delayed-deadline rollback; append-only behavior; migration recreation inside rollback; and actual PostgreSQL log/response secret absence. Persistence was real PostgreSQL, not mocked. Fixture SQL used disposable database administration; no production least-privilege SQL-role readiness is claimed.

Browser acceptance used actual invitation UI, independent delivered sink mail and native Better Auth login. Six detailed browser case groups passed: public page privacy and restricted cookie; wrong/revoked/competing credentials; incorrect/replayed code and reload resumption; password confirmation and exactly bound inactive success; real password login with `/api/admin/session` returning 401 and fifteen actual admin navigations returning to login; HTML/metadata/DTO/console secret absence and responsive layouts. Browser fixture accounts were disposable. No authenticated or privileged session resulted from redemption itself.

Entry and inactive-success screens both had matching client/scroll widths at **375px and 1440px**. Four screenshots remain outside Git. The fifteen denied destinations are dashboard, staff, audit, products, inventory, categories, orders, customers, settings, marketing, offers, content, homepage, pages and size guides. Detailed evidence is `results.json.browser-finished.json` in the final browser directory. Browser acceptance PASS and controller preservation/cleanup PASS are separate verified results; source files were not edited during the browser run.

Final quality gates: Prisma validate PASS; TypeScript PASS; full ESLint with zero warnings PASS; onboarding security 4 PASS; invitation security 6 PASS; authorization 23 PASS; dashboard 13 PASS; dashboard views 9 + 7 PASS; catalogue views 11 PASS; login form 10 PASS; Next.js production build PASS; git diff --check PASS; sensitive-artifact review PASS. `quality-results.json`, individual logs and `build-results.json` record the final-source runs. `next-env.d.ts` and `tsconfig.json` exactly match their original byte snapshots after build.

## Development preservation and final Git state

Final read-only audit matches all **18** original development table counts/content fingerprints and migration history. Development remains at **six applied migrations**, with **six pending** after adding E2B1 (five pending at preflight). There are **zero auth users and zero administrators**, with no permanent fixtures. No migration was applied to `aafiyat_dev`. All previous migrations, unrelated Docker resources and protected authentication/MFA source files are preserved. `final-preservation.json` records the final comparison.

Final Git: `main` at `ac23e813dd1205396ebcd0ca22353fdfadf79872`, matching origin/main; index empty; **13 modified tracked files and 11 new files**, exactly the 24 paths below. The worktree intentionally contains the uncommitted E2B1 implementation. No commit or push performed; no E2B2 work begun.

## Complete changed-file manifest

Modified:

1. `.gitattributes`
2. `next.config.ts`
3. `package.json`
4. `pnpm-lock.yaml`
5. `prisma/schema.prisma`
6. `scripts/run-governance-verification.mjs`
7. `scripts/verify-governance-integration.ts`
8. `scripts/verify-invitation-security.ts`
9. `scripts/verify-invitations-integration.ts`
10. `src/lib/admin-governance.ts`
11. `src/lib/admin-invitations.ts`
12. `src/lib/invitation-delivery.ts`
13. `src/lib/invitation-secrets.ts`

New:

14. `docs/task-010-e2b1-redemption-verification.md`
15. `prisma/migrations/20261030040000_add_staff_onboarding/migration.sql`
16. `scripts/verify-onboarding-security.ts`
17. `scripts/verify-staff-onboarding.ts`
18. `src/app/api/staff/onboarding/route.ts`
19. `src/app/staff/accept-invitation/page.tsx`
20. `src/app/staff/accept-invitation/onboarding-form.tsx`
21. `src/app/staff/accept-invitation/onboarding.module.css`
22. `src/lib/local-mail-delivery.ts`
23. `src/lib/onboarding-secrets.ts`
24. `src/lib/staff-onboarding.ts`

## Task 010-E2B1-G checkpoint review

Reviewed on 2026-11-08 from the expected starting commit on `main`. Local HEAD, origin/main and live GitHub main agreed at preflight. The implementation-phase Git status above is historical. This checkpoint adds review notes to the same report and keeps the 24-path manifest.

The source review found no critical defect. Invitation credentials and mailbox codes have separate verifiers. Exact-origin checks, immutable invitation data, restrictive foreign keys, unique active and provisioned bindings, and locked transactions enforce the redemption boundary. The provisioning transaction uses Better Auth's configured password hasher and preserves the account, membership and audit rollback boundary. The resulting identity stays inactive and native password login does not satisfy administrative MFA. Public signup, Owner enrollment safeguards and administrator MFA policy retain their existing restrictions. The application does not log submitted credentials or emit them in audit entries or response data. Test mail intentionally carries its own credential to the isolated recipient inbox.

Reused the recorded 25 onboarding, 24 E2A and 12 E1 integration results, browser acceptance and successful production build. Confirmed every disposable migration checksum against the current SQL files, controller preservation and cleanup, browser case counts and original configuration bytes. All eleven prior SQL files still match HEAD byte for byte. Fresh read-only development verification matched all eighteen table fingerprints and the six applied migration records. Six migrations remain pending and authentication user and administrator counts are both zero.

Recovery still depends on the browser capability until E2B2 introduces password-authenticated resumption. Lost or expired capability after provisioning leaves a retained inactive identity and requires that new recovery flow. The activation flow must recheck the exact invitation, user and membership binding and role, verify TOTP, then consume the invitation and activate the membership atomically with governance cutoff and session revocation. Production delivery still needs a provider and key operations. The inherited invitation email still describes redemption as unavailable, so recipient-facing copy will need to match the enabled workflow before rollout. The shared public operation budgets can temporarily affect other recipients when exhausted. They are availability limits and do not grant mailbox proof or privilege.
