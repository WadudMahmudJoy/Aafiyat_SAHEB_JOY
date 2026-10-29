# Tasks 010-D1 and 010-D2 â€” Settings, Offers and Content Administration

Status: PASS for the tested D1 and D2 functional slices, verified on 2026-10-30. Functional acceptance performed no commit, push, production deployment or development migration; the D3 checkpoint is authorized separately.

## Repository and database

Branch main, HEAD 9397fdef9e95ed50cc609b5be872602dc2f282c8. The three pre-existing Task 010-D files were retained and reused. The original development identity was verified read-only as 127.0.0.1:55432/aafiyat_dev. Six applied migration checksums match disk; Orders/Customers is applied once. Product Media and Business Settings/Offers migrations remain unapplied. Existing applied migration files, authentication policy, order/payment rules and stock accounting were not changed. next-env.d.ts was restored byte-for-byte after framework generation by the existing isolated harness/build preservation mechanism and has no Git diff; it was not manually reconstructed.

## Migration and database protections

New migration: 20261030000000_add_business_settings_offers/migration.sql.
SHA-256: bef838928f57341d1232af45035ed12d393f752926d681978dbca136b974dae1.
A migration-specific LF rule is included in .gitattributes.

business_settings is a CHECK-enforced boolean singleton with a positive BIGINT version, BDT currency, exact nonnegative BIGINT shipping threshold defaulting to 500000, optional nonnegative INTEGER low-stock default, consent visibility/text/version, fixed three-day exchange duration, unresolved exchange anchor, disabled reviews, restrictive administrator reference and microsecond modification timestamp. Empty consent wording cannot be displayed. No consent-grant records or messaging integration exist.

offers has UUID identity, bounded name, optional normalized unique coupon, fixed BDT minor-unit or percentage-basis-point value, ordered UTC schedule, active/inactive administrative configuration, optimistic BIGINT version, modifying administrator FK and modification timestamp. Percentage values are 1â€“10000 basis points. Values use BIGINT arithmetic; schedules are start-inclusive/end-exclusive for previews. No product/category stacking, usage limits, checkout redemption, payment shortcut or automatic customer promotion was added.

audit_logs records the authorized membership, action, entity, timestamp and bounded JSON version/change summary. It contains no session tokens, customer contact data or credentials. An ALWAYS statement trigger rejects UPDATE, DELETE and TRUNCATE. Business writes and their audit inserts share the same bounded Prisma transaction. No hard-delete endpoint is provided for settings, offers or history.

## Services and actual workflows

admin-business.ts provides request-bound settings and offers reads, bounded UUID-keyset offer pagination (20 rows), recent audit history (20 rows), atomic updates, unique-coupon conflict handling, generic safe errors and exact administrative discount previews. Reads require settings:manage or marketing:manage. Mutations check configured origin and fresh session-bound MFA using the existing authorization guard. No permission grants changed.

Settings use a locked version comparison. Offer updates use a conditional version write. Stale writes do not overwrite current records. Wording changes increment the consent notice version; visibility-only changes do not. Settings do not create consent grants. A null global low-stock threshold means no configured default; no numeric business default was invented. The public catalogue now reads the configured default when the table exists and retains per-variant override precedence; output remains limited to the three public stock labels.

Routes: /admin/settings, /admin/marketing and /admin/marketing/offers. Forms persist real settings and offers, show validation and safe errors, preserve saved feedback and require reload before another edit after success. UTC datetime controls, fixed/percentage controls, optional coupons, active/inactive configuration and a computed BDT 1000-subtotal preview are included. Offers can be edited and activated/deactivated. Navigation is role-aware with accurate active-page state. MARKETING_MANAGER has offers access and no settings access. On the intentionally unmigrated development database these routes accurately report pending schema deployment rather than simulate a save.

The settings view explicitly shows three-day/unresolved exchange policy, disabled reviews, absent verified SSLCOMMERZ integration, unconfigured zones/charges and storage configuration presence without exposing credentials or claiming connectivity. Production storage and the existing media scheduler remain separate undeployed dependencies.

## Integration evidence

Command: node scripts/run-business-verification.mjs. Final clean run a4fdbff6-dc32-45ee-b142-845e7507df93: PASS, 10 groups. It created a uniquely labelled PostgreSQL 18.6 container, verified identity and emptiness, then applied all eight reviewed migrations only there. Actual shared Prisma transactions were used. Session lookup alone was simulated for service probes; database membership/session/MFA guards remained real.

Passing groups:
1. Settings save/readback and matching audit evidence.
2. Concurrent same-version settings edits: exactly one success, one stale rejection.
3. Exact 499999/500000/500001 shipping boundary; inherited low-stock versus variant overrides.
4. Consent visibility/notice version separation, reviews disabled and exchange three-day/unresolved invariants.
5. Offer creation/update, basis points, active status and stale-version rejection.
6. Duplicate coupon, schedule and excess-percentage rejection without new audit rows; exact BigInt preview.
7. OWNER/MARKETING_MANAGER/other-role separation, missing/old MFA, anonymous and cross-origin denial before mutation.
8. Real audit-insert trigger failure rolls the settings update back.
9. Append-only audit enforcement and database checks preventing reviews activation or altered exchange days.
10. New-migration recreation inside BEGIN/ROLLBACK preserves all settings, offer and audit fingerprints.

The integration fixtures are committed only within the disposable database; it is removed afterward. A fault-injection trigger was installed only in that database for the atomicity test and removed. No database transaction was mocked. Schedule boundary and monetary overflow tests additionally pass in the reused eight-group pure-rule suite. The long-running media-worker suites were not rerun.

## Real authenticated browser acceptance

Command: BUSINESS_BROWSER=1 node scripts/run-business-verification.mjs (PowerShell: set $env:BUSINESS_BROWSER='1' first). Browser run 8b2a1428-1a46-4725-9d7f-0f66da8ab35b used actual password/TOTP login and disposable authentication fixtures. No production authentication bypass was introduced.

Observed passing behavior: settings saved and reloaded (5000.01 and subsequently 5555.55 BDT); success feedback remained visible after the remount fix. An offer with coupon BROWSER_010D was created, reloaded, edited to BDT 99.99, activated and reloaded. A 100.01 percent input showed a server validation error. MARKETING_MANAGER could use offers and was redirected from settings to /admin. Anonymous settings access redirected to login. After database membership revocation a stale browser form POST was rejected; the offer fingerprint and audit count (10) remained identical before/after. Membership was restored only for orderly test-harness completion.

Both settings and offers pages were checked at 375px (client/scroll 360/360) and 1440px (1425/1425). The first mobile check exposed long audit-text overflow; the scoped layout/wrapping correction passed the repeated check. The first settings save exposed success-feedback loss on form remount; removing version-based remount keys passed the repeated check. Initial browser locator/date-fill errors were corrected in test interaction without changing business assertions.

The browser case passed, but that controller's overall source-preservation flag was false because source fixes were made while it was running. This is not reported as a clean controller PASS. The subsequent final non-browser integration run passed with source preservation true and verified the finalized source/development baseline. Both runs removed only their own labelled container and preserved development fingerprints.

## Quality checks and preservation

PASS: Prisma schema validation; TypeScript (including production-build type checking); ESLint; Next.js 16.4.3 production build; git diff --check. The build used a process-only HTTPS auth origin and read-only PostgreSQL options; no temporary configuration was persisted. The build includes all existing administration routes plus the three new routes.

Affected regressions: 8 business-rule groups, 11 catalogue presentation checks, 8 Orders/Customers presentation groups, 8 receiving-validation checks, 8 correction-validation checks and 13 dashboard policy/access checks passed (56 groups/checks total across these scripts). The dashboard expectation was updated for the OWNER-only settings destination without changing role permissions. Raw evidence is retained outside Git in the OS temporary directory; credentials, screenshots, generated clients and build output are excluded.

Final integration evidence confirms developmentUnchanged=true, preservedSourcesUnchanged=true and preexistingContainersPreserved=true. It compares all eighteen development table fingerprints before/after. A final read-only identity/checksum audit again confirmed six migrations; no permanent test customer, product or administrator was added to development. No Docker volume or unrelated container was removed.

## Limits and next slice

010-D1 is configuration administration. Offer redemption and precedence, checkout acceptance, shipping charges/zones, payment verification, messaging/consent collection and automatic exchange eligibility remain unimplemented. The exchange start event remains unresolved. Audit summaries preserve change/version categories, not complete historical copies of consent wording. History is deliberately limited to the most recent twenty summaries; offer listing has keyset pagination. No operational scheduler or production storage was configured.

The D2 implementation and its additional evidence follow below. Public storefront rendering remains outside this batch.

## D2 â€” Implemented CMS workflows

The existing D1 settings/offers services, forms, migration and evidence were preserved. Content navigation now appears only for content:manage administrators; marketing/settings destinations remain functional. No role grants or authentication policy changed.

Routes: /admin/content (redirect), /admin/content/homepage, /admin/content/pages and /admin/content/size-guides. Homepage supports a single keyed hero, promotional banners, ordered featured category/product references and plain-text editorial/story blocks. Editors provide title/subtitle/body, approved internal CTA, SEO, draft/published and visible/hidden states, display order, real upload/preview and image association removal. Saves persist and reload PostgreSQL data; version conflicts require reload. Unpublishing/hiding safely removes entries from public projections while retaining records; no destructive content delete is provided.

Informational pages support administrator-written About, Contact, Shipping, Exchange, Privacy and Terms content through safe slugs/plain-text sections, stored previews and publication controls. No legal wording or shipping prices were invented. Size guides provide cm/in units, measurement descriptions, editable columns/rows and validated positive decimal measurement text, with product/category association. Synthetic measurements appear only in isolated tests. Table editing does not require source changes.

Ordered references use comma-separated UUID fields with available eligible choices displayed by name/ID. Choice lists are bounded to the first 100 records; this initial editor does not offer a searchable selector for larger catalogues. Admin content lists use UUID-keyset pagination, twenty entries per page. Public projections return at most fifty ordered entries per kind. Banner ordering uses explicit display-order fields. Hidden/unpublished entries remain editable. Editorial layout is deliberately plain text and structured blocks, not arbitrary HTML or a rich-text builder.

## D2 migration and integrity

Migration: 20261030010000_add_content_cms/migration.sql.
SHA-256: 1c9c72b733173429d7308018cc945321e5f03f60e8c4a5ac331b0a90265c9afd.
D1 remains byte-identical: bef838928f57341d1232af45035ed12d393f752926d681978dbca136b974dae1.
Product Media remains byte-identical: fce25e4d36941cdfdd37022f85c91e3ed1413505afd194760c1e8d73f79d1c63.
Migration-specific LF rules preserve new SQL bytes. No previously applied migration changed.

Three additive tables: content_entries (UUID, unique slug, validated kind/state, bounded text/SEO/CTA, ordering, measurements, BIGINT version, administrator FK); content_references (restrictive product/category/entry FKs, exactly one reference type, unique per-entry ordering); content_assets (entry ownership, immutable unique key/idempotency identity, image metadata/hashes, lifecycle, durable upload attempt and reconciliation claim/deadline). Composite cover ownership FK and locking triggers require a READY asset owned by that entry. Retired identities cannot be restored or hard-deleted. Referenced READY media cannot be retired. D2 extends the existing audit action CHECK for content operations without editing D1 SQL.

## D2 security and media architecture

All privileged reads use request-bound content:manage authorization. Mutations enforce configured origin, existing fresh session-bound MFA, strict unflattened FormData validation and bounded transactions. Successful save/upload/removal writes include atomic D1 audit records. Denied or stale writes do not leave partial content, references or audit entries. Text rejects executable markup; CTA destinations use the existing approved internal-path allowlist. Product/category references are checked at publication, then filtered again in public projections so inactive categories and discontinued/archived/ineligible products are excluded. Unpublished entries never enter publicCms. Exact inventory, actor data, object keys and hashes are absent from public content DTOs.

CMS assets have separate ownership and an immutable content-specific key namespace, not product-owned keys. The shared reviewed decoder verifies signature/MIME/size, decodes dimensions and re-encodes WebP; the existing S3-compatible adapter verifies stored bytes before READY finalization. A database upload-attempt UUID and sixty-second deadline fence finalization, with content-version checks and reauthorization after I/O. No transaction spans storage I/O. Same-key identical authorized retries return the recorded receipt or safely retry pending work; retired attempts cannot restore an association. Failed uploads remain invisible and recoverable.

Private preview GET /api/admin/content-media/[id] is permission-protected; public GET /api/content-media/[id] requires linked published/visible content. Both require READY state and verified object hash, return generic unavailable responses on failure and never disclose keys. The existing cover component supplies unavailable-image fallback. Production storage absence is accurately shown as unavailable.

Run the separate CMS worker with node --conditions=react-server --import tsx scripts/reconcile-content.ts. Each invocation claims at most 100 due assets using real PostgreSQL SKIP LOCKED, a UUID and one-minute retry deadline. Retirement/completion check the current unexpired claim, entry ownership and absence of references. Pending uploads expire after 24 hours; unlinked/replaced images wait 24 hours before cleanup. Deleted tombstones remain eligible indefinitely, ordered by next retry, so late writes can be swept again. Storage deletion is idempotent. Eventual cleanup depends on upload activity ending, available storage and continued worker execution. The scheduler is NOT configured, and production object storage is NOT deployed. A CMS-specific OS-process interruption/restart test subsequently passed in the D3 acceptance gate below. CMS-specific concurrent-worker stress and paused-service-upload interleavings remain untested; accepted Product Media evidence is not relabeled as a CMS-specific test.

## D2 database and regression evidence

Command: node scripts/run-cms-verification.mjs. Final run a6309b50-77b0-46be-9a6c-a8c1f1c82f99: PASS, twelve groups. Unique disposable PostgreSQL 18.6 and pinned S3-compatible object storage were verified before applying all nine migrations. Actual shared Prisma transactions were used; only service-probe session lookup was simulated, while session/MFA/membership checks remained database-backed. Browser authentication below was real.

1. Draft save/readback and unpublished-content privacy.
2. Real content image upload, same-key replay and private/public ownership checks.
3. Hero publish/unpublish and sanitized public projection.
4. Banner order, references, inactive-category filtering and cross-entry cover rejection.
5. Concurrent same-version edits permit one winner; unsafe HTML/URL rejection and page publication.
6. Structured size-guide persistence/publication and invalid-unit rejection.
7. Role/MFA/origin denial without content/audit side effects.
8. Audit insertion failure rolls entry/reference mutation back.
9. Unlink/retire, actual late object PUT after deletion and repeated claim-fenced reconciliation remove the recreated object.
10. D1 settings/offers smoke regression.
11. Storage failure remains pending/invisible, same-key recovery, corrupt/unavailable object rejection and restored verified-object response.
12. CMS migration recreation inside BEGIN/ROLLBACK preserves all three CMS table fingerprints.

The late-write CMS test uses a direct controlled object PUT. It proves repeated reconciliation of a recreated object, not every service-upload/network interleaving. Product Media's previously accepted paused-service upload, process interruption and worker concurrency evidence remains applicable only to that existing module. No Product Media lifecycle SQL or service was changed; shared object-key validation gained the separate strict CMS namespace.

Full D1 suite against nine migrations: CMS_REGRESSION=business node scripts/run-cms-verification.mjs, run 81c70237-1b91-4dc3-9eaf-7b64c6fa0719, ten groups PASS. Corrected catalogue suite against nine migrations: CMS_REGRESSION=catalogue node scripts/run-cms-verification.mjs, run 343d19da-e07e-4342-9696-0a6b1840d7ec, twenty-one checks PASS, rollback fixtures preserved. Existing default eight/seven-migration harness expectations remain unless the explicit isolated-controller compatibility flag is supplied.

## D2 actual authenticated browser acceptance

CMS_BROWSER=1 node scripts/run-cms-verification.mjs; run 7ccad00b-5eac-4c05-8b5f-490810a0d002 passed with actual password/TOTP login and isolated database/storage fixtures. The final controller reports PASSED, developmentUnchanged=true, preservedSourcesUnchanged=true and preexistingContainersPreserved=true.

Verified actual browser edits: hero title save/reload; file upload, image decode/preview and hero publication; banner order update/reload; informational page creation/publication; size-guide creation/publication and decimal measurement edit/reload. MARKETING_MANAGER performed authorized content writes. Replaying the actual Server Action after switching to ORDER_MANAGER was denied; missing MFA proof was denied; a cross-origin replay was blocked by the framework origin guard (HTTP 500, not a successful mutation). Entry fingerprint and audit count (24) remained identical across these denied requests. Anonymous private-page access redirected to login. No private content object-key pattern was present in rendered HTML.

Homepage, pages and size-guide routes were checked at 320, 375, 393, 768 and 1440 pixels: fifteen route/width combinations passed without page overflow. The browser run preceded the additional failed-storage/corrupt-object and migration-rollback service assertions; no subsequent production behavior changed. Final twelve-group service run verified the additional assertions.

## Final quality and preservation audit

PASS: Prisma schema validation, TypeScript, ESLint, Next.js 16.4.3 production build and Git whitespace verification. Database-free CMS validation: ten checks PASS. Media validation: existing eight groups plus strict product/CMS namespace assertions PASS. Business rules: eight groups PASS. Catalogue presentation: eleven checks PASS. Orders/Customers presentation: eight groups PASS. Updated dashboard policy/access: thirteen checks PASS. Accepted unrelated receiving and Product Media process suites were reused rather than rerun unnecessarily.

The production build used a process-only HTTPS authentication origin and read-only database options. No security configuration was persisted. All existing Products, Inventory, Orders, Customers, Marketing and Settings routes and the new CMS routes compiled. Framework-generated next-env.d.ts and tsconfig bytes were preserved by the existing snapshot mechanism; next-env.d.ts has no Git diff and was not manually edited.

Final read-only audit confirms exactly 127.0.0.1:55432/aafiyat_dev, six applied migrations with matching checksums, Orders/Customers applied exactly once, and Product Media/D1/D2 unapplied. All eighteen original development table counts and fingerprints match the preserved D1 baseline. No permanent CMS/product/customer/admin fixture was added. Both final CMS and browser controllers removed their own labelled PostgreSQL/storage resources and retained pre-existing container identities. Two independent regression runs overlapped; intermediate container inventory flags from overlapping runs are not used as proof of historical global preservation. Final sequential CMS evidence confirms preservation for its own run. Raw evidence, screenshots and credentials remain outside Git; no unrelated container/volume cleanup was performed.

## Remaining operational dependencies and limits

No public storefront was implemented; server-only read projections and controlled image retrieval are ready for separate storefront integration. Product Media, D1 and D2 migrations remain undeployed locally by instruction. Production storage and both periodic reconciliation jobs require reviewed deployment and scheduling. No claim is made that source availability means those operations are live. Offer checkout precedence/redemption, shipping prices/zones, consent collection/messaging, payment verification and exchange-anchor approval remain separate unresolved work. Plain-text layout, bounded reference choices and recent audit-summary limits are explicit V1 UI limitations, not simulated saves. No confirmed source defect remains in the tested workflows; untested CMS concurrent-worker and service-upload interleavings remain a verification limitation.

## D3 final security and recovery acceptance

Acceptance: PASS for checkpoint on 2026-10-30. Preflight confirmed main at 9397fdef9e95ed50cc609b5be872602dc2f282c8, matching fetched origin/main, an empty index and exactly the documented 43 paths (11 tracked modifications and 32 untracked files). No unexpected task artifacts or generated-file changes were present. The final checkpoint includes those reviewed paths only.

Source review confirmed that CMS has a distinct lifecycle implementation sharing only the reviewed decoder and S3 adapter with Product Media. Its immutable content namespace and ownership, bound READY cover trigger, attempt UUID/deadline, entry-version finalization, retryable retained tombstones, reference checks and claim UUID/deadline fencing were inspected directly. Storage I/O occurs outside transactions. No retired identity can become READY again. Stale completion cannot overwrite a newer claim. Repeated storage deletion is permitted and required after possible late writes. No source defect requiring a production-code change was identified.

Added a test-only HTTP proxy barrier in verify-cms-integration.ts. It forwards the actual worker DELETE to the real disposable object store and withholds the successful response. The test independently confirms object absence and the durable delete_pending claim, terminates the actual OS worker with SIGKILL, and verifies the database completion did not occur. It advances only that disposable asset's retry deadline to reproduce lease expiry, leaving integrity triggers enabled. A new OS worker uses the normal storage endpoint, reclaims with a different UUID and finishes deletion of the already missing object. A third process repeats reconciliation. A separate referenced READY asset remains READY and returns a valid verified image. This establishes tested recovery at that precise process boundary; it does not prove every possible CMS upload/crash/concurrent-worker interleaving or remote storage failure mode.

Command: node scripts/run-cms-verification.mjs. Final D3 run c667c2ea-4c8f-4bd5-b823-98d85a4ec8e3 passed thirteen groups, including all prior twelve groups and the real worker interruption/restart test. Initial test development failed while selecting a retired hero, then while unintentionally selecting the retirement target as the protected READY fixture. The independent protected asset selection was corrected and explicitly asserted distinct; assertions were retained and the full focused suite passed. Those failed runs also removed their own disposable resources and preserved development fingerprints. No production repair was needed.

Fresh checks: Prisma validation PASS; TypeScript PASS; ESLint PASS; business rules eight groups PASS; CMS validation ten checks PASS; media validation eight groups plus namespace assertions PASS; catalogue presentation eleven checks PASS; Next.js 16.4.3 production build PASS; dependency versions next/eslint-config-next both exactly 16.4.3; Git whitespace PASS. The presentation test initially ran with the inappropriate react-server condition and was rerun with its normal node --import tsx invocation, passing all eleven checks. The real production build retained the process-only HTTPS origin/read-only database settings and restored exact framework-generated snapshot bytes. next-env.d.ts matches HEAD. Previous ten-group D1, twenty-one-check catalogue and actual authenticated-browser acceptance remain valid because production behavior was unchanged during D3.

The unchanged role matrix gives OWNER all three permissions, MARKETING_MANAGER marketing/content only, and neither ORDER_MANAGER nor PRODUCT_MANAGER any of these permissions. Existing D1 database denials explicitly cover both unauthorized roles, missing/expired MFA and origin; CMS browser evidence covers ORDER_MANAGER, missing MFA and origin, with current PRODUCT_MANAGER denial confirmed by the unchanged shared guard/matrix. No claim is made of an additional PRODUCT_MANAGER browser run. Prior real role revocation leaves data/audit unchanged. Audit inserts remain atomic and append-only, with safe redacted summaries. No checkout redemption, consent grants, payment verification shortcut or exchange-anchor decision was introduced.

The final read-only database audit again confirms 127.0.0.1:55432/aafiyat_dev; six applied migration checksums match reviewed bytes; all eighteen table counts/fingerprints match the D1 baseline. Orders/Customers is applied once; Product Media, D1 and D2 remain pending. All seven existing migration files are unchanged from HEAD. D1 and D2 hashes above remain accurate. Explicit SQL LF attributes ensure staged bytes retain those hashes on Windows. Sensitive-artifact scanning found no embedded credentials, private absolute paths, raw evidence or generated output. Disposable controller connection templates interpolate fresh random credentials and are not static secrets.

Production deployment remains separate: pending migration deployment, reviewed S3 configuration and periodic Product Media/CMS reconciliation scheduling are not performed by this checkpoint. Shipping charges/zones, exchange start event and checkout offer precedence/redemption remain unapproved or unimplemented as documented above. No critical unresolved security/correctness blocker was found in the reviewed scope.

## Complete pending file manifest

- `.gitattributes`
- `docs/media-reconciliation.md`
- `docs/task-010-d-marketing-cms-settings-verification.md`
- `prisma/migrations/20261030000000_add_business_settings_offers/migration.sql`
- `prisma/migrations/20261030010000_add_content_cms/migration.sql`
- `prisma/schema.prisma`
- `scripts/reconcile-content.ts`
- `scripts/run-business-verification.mjs`
- `scripts/run-cms-verification.mjs`
- `scripts/verify-admin-catalog.ts`
- `scripts/verify-admin-dashboard.ts`
- `scripts/verify-business-integration.ts`
- `scripts/verify-business-rules.ts`
- `scripts/verify-cms-integration.ts`
- `scripts/verify-cms-validation.ts`
- `scripts/verify-media-validation.ts`
- `src/app/admin/admin-session.tsx`
- `src/app/admin/business-actions.ts`
- `src/app/admin/business-form.tsx`
- `src/app/admin/business-page.tsx`
- `src/app/admin/business-view.tsx`
- `src/app/admin/business.module.css`
- `src/app/admin/content/cms-actions.ts`
- `src/app/admin/content/cms-form.tsx`
- `src/app/admin/content/cms-page.tsx`
- `src/app/admin/content/cms-view.tsx`
- `src/app/admin/content/homepage/page.tsx`
- `src/app/admin/content/page.tsx`
- `src/app/admin/content/pages/page.tsx`
- `src/app/admin/content/size-guides/page.tsx`
- `src/app/admin/dashboard-view.tsx`
- `src/app/admin/marketing/offers/page.tsx`
- `src/app/admin/marketing/page.tsx`
- `src/app/admin/settings/page.tsx`
- `src/app/api/admin/content-media/[id]/route.ts`
- `src/app/api/content-media/[id]/route.ts`
- `src/lib/admin-business.ts`
- `src/lib/admin-cms.ts`
- `src/lib/admin-dashboard.ts`
- `src/lib/business-rules.ts`
- `src/lib/catalog.ts`
- `src/lib/cms-validation.ts`
- `src/lib/media-validation.ts`

Pre-checkpoint Git state: main at 9397fdef9e95ed50cc609b5be872602dc2f282c8; eleven modified tracked files and thirty-two untracked files; empty index. The manifest includes preserved D1 and new D2 work. D3 authorizes the reviewed checkpoint and normal push after all gates pass; the resulting commit identity is reported separately. next-env.d.ts has no diff.
