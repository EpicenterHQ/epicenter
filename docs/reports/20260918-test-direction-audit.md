# Test direction audit, 2026-09-18

Start with stale ownership harnesses, settled prototypes, and assertions that cannot detect the failure they claim. Preserve the Account, persistence, cancellation, and sync tests: those mostly protect Epicenter's current direction.

## Scope and confidence

The inventory covers all **305 existing repository `*test.ts` files**, including five under `.agents`, approximately 69,753 lines. Git lists 307 tracked paths; two test files are already deleted in the user's worktree. Dependencies and generated output are excluded.

This is an all-file triage with focused deep review, **not an exhaustive assertion-by-assertion deletion certification**. Every file received a disposition; suspicious cases received source/caller tracing, selective Git history, or execution. “Retain at triage” means no deletion was justified here. It does not certify every assertion. The inventory includes a representative test title to make each file's current purpose recognizable; that title is not independent proof of its claim.

Reviewed against HEAD `c3ea49df11` plus the existing uncommitted changes. Those changes were not made by this audit. In particular, the Whispering bootstrap mismatches below are unfinished worktree migration, not evidence that the new owner is wrong.

No production code or tests were edited. This report is the only repository file added by the audit.

## Recommended first pass

### 1. Replace the tests that require the removed Whispering bootstrap

- [application.test.ts](../../apps/whispering/src/lib/application.test.ts), lines 8, 24, 42, 52, mocks `bootstrap.js` and calls `openApplication()`.
- [whispering-startup.test.ts](../../scripts/whispering-startup.test.ts), line 49, imports the deleted `bootstrap.ts`.
- Current [application.ts](../../apps/whispering/src/lib/application.ts) exposes `attachApplication`, `getApp`, and `getSelections`. [The route](<../../apps/whispering/src/routes/(app)/+layout.svelte>) selects the library and delegates opening to AppBoot.

The first file has three reproduced failures; the second has four. Do not restore the old bootstrap to make them pass. Test double-attachment refusal, access after abort/detachment, signed-out selection of device data despite a saved remote choice, and one captured Account through the mounted route. Shared AppBoot smoke tests cover the component's lifetime, but do not completely replace app-specific route/selection coverage.

### 2. Retire the alternate initialization prototype

[foundation.test.ts](../../packages/server/evidence/scope-ownership/foundation.test.ts), line 153 onward, tests local `openInitialization` and `authorize` implementations that production does not call. At line 231 it requires historical generations to become the initial selection. The real [Worker test](../../packages/server/workers/initial-generation.test.ts), line 112, requires a 409 refusal without changing historical data.

Keep the first two live startup/socket tests in foundation.test.ts. Remove or archive the alternate reserve/initialize/admit implementation and its cases together. Keep the actual Worker and current-generation authority tests. ADR-0385 is useful historical context for the rejected split; the live caller and behavior mismatch is the deciding evidence.

[passkey-hooks.test.ts](../../packages/server/evidence/enrollment/passkey-hooks.test.ts) similarly reproduces a rejected enrollment design. It can move out of routine product regression coverage. Preserve `authenticator.ts`: the production self-host auth tests use it.

### 3. Stop making model-output repair a product guarantee

[Vocab's candidate tests](../../apps/vocab/src/lib/entry-candidates.test.ts), lines 59 and 64, require stripping presumed glosses. The actual promise is a verbatim span from the passage, yet the parser never sees that passage.

Reproduced with the current parser:

| Input | Candidate |
| --- | --- |
| `Yes: absolutely` | `Yes` |
| `你好：世界` | `你好` |
| `wait - what` | `wait` |
| `say:` | discarded |

This is the clearest example of tests reinforcing a questionable product assumption. Recommend requiring candidates to match source text and refusing ambiguous repair. Structured output could help, but source validation is the actual promise. Change production and these tests together. Keep ordering, deduplication, empty-input, and lossless-text coverage. The candidates remain transient until the person saves them, so this is a truncation/selection problem, not demonstrated corruption of already saved data.

### 4. Rewrite assertions that cannot detect their named failure

| Test | Why it can stay green when broken | Replacement evidence |
| --- | --- | --- |
| [from-subscription.svelte.test.ts](../../packages/svelte/src/from-subscription.svelte.test.ts), 95 and 106 | Uses a no-op update callback; manually rereads the getter; teardown only checks subscribe count | Observe invalidation and listener removal, preferably through a real Svelte effect |
| [persisted-map.svelte.test.ts](../../packages/svelte/src/persisted-map.svelte.test.ts), 98 | Disk and memory both contain dark, so permanently suppressed rereads still pass | Change storage externally after successful recovery, then fire focus |
| [mailbox.test.ts](../../apps/local-mail/src/mailbox.test.ts), 106 | “Throwing the cache away” creates an unrelated empty database | Invoke the actual cache deletion/rebuild owner, reopen, and verify durable intents survive |
| [loop.test.ts](../../packages/agent/src/loop.test.ts), 172 | Immediately resolving tools only prove invocation order; parallel calls pass | Hold the first tool and prove the second has not started |
| [message-fields.test.ts](../../apps/local-mail/src/message-fields.test.ts), 140 | “Returns null” only asserts no throw | Assert the malformed-input result |
| [from-data.svelte.test.ts](../../packages/svelte/src/from-data.svelte.test.ts), 342 | Flush forwarding accepts any successful async no-op | Assert actual forwarding, or fold into a stronger capability test |

These protect real contracts. Fixing the test is better than deleting the contract.

### 5. Remove source-spelling tests where stronger boundaries exist

[hosted-identity.test.ts](../../apps/whispering/tests/hosted-identity.test.ts) is a strong whole-file pruning candidate: old directory absence, retired strings, and exact configuration spelling. [build-applications.test.ts](../../apps/epicenter/scripts/build-applications.test.ts) actually builds each app and checks its hosted base path. Platform-selection and static-assets tests protect other useful parts of this boundary.

The Whispering and Vocab `boot-node.test.ts` files should keep the callback/ownership concern but drop spellings such as `= $props()`, `fromData(opened.account!.personal)`, and forbidden variable name `showing`. A transitive helper can acquire an App without those regexes noticing. Shared AppBoot browser smoke is related evidence, not sufficient app-route coverage. No invocation of that smoke was found in checked-in workflow files or package scripts.

[api/scripts/dev.test.ts](../../apps/api/scripts/dev.test.ts), line 25, finds source substrings and the first throw before the first mkdir. It cannot prove reachable validation before side effects. Prefer exercising the launcher boundary; do not create a new production helper solely to give this test an entry point.

[local-model-boundary.test.ts](../../apps/whispering/src/lib/tauri/local-model-boundary.test.ts) slices a hand-written facade while describing generated bindings as the boundary. The generated bindings actually contain administration commands. Rust capability tests in `apps/epicenter/src-tauri/src/lib.rs`, around line 2374, check the current window grants. The sibling `tauri.tauri.test.ts` already uses mocked IPC. Move useful command/input checks to those actual boundaries.

Do not generalize this into “all source tests are bad.” Real bundle metafile checks, command-grant relations, persisted credential exclusions, and unknown wire-operation refusals can protect failures the compiler cannot see.

## Decisions that should precede deletion

### Historical static tokens: remove enrollment separately from historical data isolation

Current self-host deployments use named sessions. `createEnvTokenResolver` has no current deployable caller; the standalone verifier has no production caller. The old `createInstanceAuth().signIn(token)` enrollment path also has no app caller.

Browser and desktop code still restore historical saved instance attachments. Therefore `instance-auth.test.ts`, `browser-auth.test.ts`, and desktop restoration cases are not wholesale deletion candidates. Preserve offline restoration and the refusal to assign historical instance data to a newly signed-in named user.

Recommend retiring the unused enrollment/verifier/resolver API and obsolete token-generation workflow together. Preserve or explicitly replace the restore-only path. A Worker authorization-deadline test uses the resolver as a fixture; replace that fixture when removing the resolver. This is a code and data-access decision, not a test-only cleanup.

### Working copy: decide whether the unconsumed API is a product commitment

`createWorkingCopy` is exported and documented, but the caller search finds only its definition, tests, and benchmark. Its [checkout.test.ts](../../packages/app/src/data/artifact/checkout.test.ts) has approximately 1,980 lines.

The host's checkout transport has real callers and its own useful tests. That does not establish a caller for the bidirectional working-copy engine. Decide whether an app will own this workflow. If not, remove the unconsumed engine with its tests. If yes, first exercise that app workflow. Locally, the body-edit cases around lines 1357 and 1374 can be folded without making the product decision.

### Replication should require a way to invalidate its generation

[store-retirement.test.ts](../../packages/app/src/data/store/store-retirement.test.ts), line 185, normalizes a “legacy backing” with replication but no invalidation support. `StoreBacking` makes `replication` and `discard` independently optional. The real current browser backing supplies both.

Recommend making that combination invalid at construction/type boundaries. Keep the tests for actual retirement, invalidation failure, fencing, and retained ownership. Removing only the legacy test would hide the invalid state rather than remove it.

## Historical evidence is mixed

[deletion-model.test.ts](../../packages/app/evidence/data/deletion-model.test.ts) still says production clears fields and flags a row absent. Actual `deleteRow` calls `root.deleteAttr(rowId)`. The file compares locally implemented rival models. Its result helped justify the current design, but its description now teaches the old design as current.

Archive or consolidate that settled argument and correct the prose. Keep real store coverage for deletion, concurrent edits, no revival, and bounded churn. Preserve references from production comments/ADRs if moving the evidence.

Do not delete `evidence/data/current-generation/authority.test.ts`, `hub.test.ts`, `retention.test.ts`, or `a-row-is-not-a-value.test.ts` as dead prototypes: they import production code. Other raw Yjs cases can remain useful dependency-upgrade evidence. Make random winner/encoded-size assertions deterministic rather than turning current dependency quirks into permanent product requirements.

Git history supports this distinction. September 18's `eb5f42f856` moved the data engine, making old tests look freshly authored. `git log --follow` traces deletion-model evidence to `05132dd79a` on August 7. The ownership prototype arrived with `ea8f2d254d` on September 9 and was updated during later migrations without becoming the production implementation. Modification date alone is a poor deletion rule.

## Smaller follow-ups

- `scripts/check-api-paths.test.ts:98` expects the old OAuth callback family to be flagged. The gate now scans only API route families. This case currently fails. Reconcile the route-ownership policy instead of restoring obsolete OAuth URLs.
- Honeycrisp's `node-text.test.ts:66` times 200 reads and allows `shortMs * 20 + 50`. Keep title/preview correctness; move timing to a benchmark or establish bounded traversal deterministically.
- Local Books `mode.test.ts:35` and `:41` create identical state. Delete one.
- Matter's `query.test.ts` repeats executed SQL semantics as exact SQL strings. Preserve explicit-sort-over-FTS coverage with an executed query before removing its unique string case.
- `constants/app-data.test.ts:200` still describes Local Mail partitioning by email “until the sub wave lands.” Keep generic safe-segment coverage; remove that obsolete product rationale.
- Local Mail reconciliation comments say reports are never written down, although the account owner records them. Correct the explanation, retain the behavior.
- The instruction-evaluation tests include an exact list of three unmeasurable consultation cases. That is corpus inventory coupling; test router classification independently of the number of examples.

## What should stay

Account isolation and retirement, request/stream cancellation, persistence commits and failure recovery, recording save ordering, reconnect/hibernation, blob/path safety, provider protocol boundaries, and actual build/runtime composition all protect the current direction.

Local Books and Local Mail have real standalone/provider workflows. Their SQLite and CLI tests are not stale merely because the three store apps use page-owned App lifetimes. Chat and skills also have real executable tests; an unsettled product purpose does not make their behavior automatically disposable.

Hosted account deletion currently refuses before destructive work because complete erasure cannot yet be guaranteed. Keep its refusal tests until a real deletion workflow replaces that behavior. A future desired feature is not a reason to remove today's safety check.

## Verification and consultation

Executed focused checks, not the whole suite:

- Six selected Whispering/API files: **15 pass, 3 fail**. All failures were missing `openApplication`.
- API-path gate plus Whispering startup: **2 pass, 5 fail**. One stale OAuth-family expectation and four missing-bootstrap imports.
- Direct Vocab parser probe reproduced the truncations above.

Claude Code reviewed representative suites and current callers through the [consult-claude skill](../../.agents/skills/consult-claude/SKILL.md). Native session: `af36dc3e-a87d-4adb-b98a-813a9851bb66`. Both review turns completed successfully with no permission denials. Claude independently found the Whispering mismatch, unused static enrollment, source-spelling tests, and the need to preserve production evidence.

I did not adopt two blanket suggestions: negative assertions against retired names can still prevent recurrence at real boundaries, and a production helper should not be extracted solely to let a unit test call it.

In the follow-up, Claude agreed with those qualifications and proposed giving Vocab's parser the source passage. I agree the missing source is the central issue. Matching a shortened prefix alone would still not prove which span was intended, so the recommendation remains to preserve whole valid spans and refuse ambiguous repair. Claude also suggested a process-level rejection test for the dev launcher; that would establish more than source-position comparisons without adding a test-only production boundary.

This checkout continued changing during the review. Findings and line numbers describe the inspected state; recheck the specific files before acting on them.

## Complete file inventory

“Retain at triage” is provisional. Rows marked otherwise point to a specific follow-up, not authorization to delete the whole file. “Representative behavior” quotes one test title for orientation; read the findings above for independently verified claims.

| File | Lines | Disposition | Reason or representative behavior |
| --- | ---: | --- | --- |
| [.agents/skills/agent-instructions/scripts/audit-routing-collisions.test.ts](../../.agents/skills/agent-instructions/scripts/audit-routing-collisions.test.ts) | 121 | Retain at triage | Representative behavior: no phrase is a usage error |
| [.agents/skills/agent-instructions/scripts/audit-skill-links.test.ts](../../.agents/skills/agent-instructions/scripts/audit-skill-links.test.ts) | 204 | Retain at triage | Representative behavior: a reference link that resolves passes |
| [.agents/skills/agent-instructions/scripts/run-trigger-eval.test.ts](../../.agents/skills/agent-instructions/scripts/run-trigger-eval.test.ts) | 540 | Keep/narrow | Keep eval parsing/scoring/probe boundary; exact number of Codex-only consult cases is corpus inventory coupling. |
| [.agents/skills/agent-instructions/scripts/skill-catalog.test.ts](../../.agents/skills/agent-instructions/scripts/skill-catalog.test.ts) | 100 | Retain at triage | Representative behavior: reads a single-line field |
| [.agents/skills/consult-claude/scripts/consult-claude.test.ts](../../.agents/skills/consult-claude/scripts/consult-claude.test.ts) | 97 | Retain at triage | Representative behavior: new and resumed turns preserve the brief and enforce the same access boundary |
| [apps/api/dev-auth.test.ts](../../apps/api/dev-auth.test.ts) | 73 | Retain at triage | Representative behavior: resolves Bearer dev:<principalId> to a synthetic principal on localhost |
| [apps/api/runtime-profile.test.ts](../../apps/api/runtime-profile.test.ts) | 412 | Trim one | Keep actual routing/outage tests; explanation-on-PROFILE-row test is fixture policy. |
| [apps/api/scripts/dev.test.ts](../../apps/api/scripts/dev.test.ts) | 42 | Rewrite | Source substrings cannot establish validation before side effects; avoid exact script spelling as a contract. |
| [apps/api/ui/src/lib/auth/session-request.test.ts](../../apps/api/ui/src/lib/auth/session-request.test.ts) | 47 | Retain at triage | Representative behavior: browser and native bindings retain their exact callback and deliberate reauthentication |
| [apps/api/ui/src/lib/dashboard/navigation.test.ts](../../apps/api/ui/src/lib/dashboard/navigation.test.ts) | 47 | Retain at triage | Representative behavior: sign-in preserves the purchase account and destination |
| [apps/api/ui/src/lib/dashboard/runtime.test.ts](../../apps/api/ui/src/lib/dashboard/runtime.test.ts) | 260 | Retain at triage | Representative behavior: late results from Alice cannot populate a new ${successor} attachment |
| [apps/api/worker/account/routes.test.ts](../../apps/api/worker/account/routes.test.ts) | 137 | Retain at triage | Representative behavior: fresh requests and retries refuse before storage or external deletion |
| [apps/api/worker/billing/autumn-products.test.ts](../../apps/api/worker/billing/autumn-products.test.ts) | 32 | Retain at triage | Representative behavior: the automatically enabled free plan grants storage without a price |
| [apps/api/worker/billing/autumn.test.ts](../../apps/api/worker/billing/autumn.test.ts) | 83 | Retain at triage | Representative behavior: an AutumnError maps to the fixed opaque message, not the provider wording |
| [apps/api/worker/billing/policies.test.ts](../../apps/api/worker/billing/policies.test.ts) | 398 | Retain at triage | Representative behavior: top-up checkout requests the catalog credit quantity from Autumn |
| [apps/api/worker/session-callbacks.test.ts](../../apps/api/worker/session-callbacks.test.ts) | 90 | Retain at triage | Representative behavior: only a local issuer admits the exact configured desktop callback port |
| [apps/api/worker/storage/service.test.ts](../../apps/api/worker/storage/service.test.ts) | 184 | Retain at triage | Representative behavior: unseen workspace is registered at zero before first push |
| [apps/api/worker/trusted-origins.test.ts](../../apps/api/worker/trusted-origins.test.ts) | 50 | Retain at triage | Representative behavior: rejects arbitrary chrome-extension origins (no wildcard regression) |
| [apps/epicenter/scripts/build-applications.test.ts](../../apps/epicenter/scripts/build-applications.test.ts) | 53 | Retain at triage | Representative behavior: ${application.title} builds and is served below its id |
| [apps/epicenter/scripts/build-sidecar.test.ts](../../apps/epicenter/scripts/build-sidecar.test.ts) | 208 | Retain at triage | Representative behavior: compiled host refuses a mis-bound production boot, serves packaged apps, and exits on parent EOF |
| [apps/epicenter/src/account-transport.test.ts](../../apps/epicenter/src/account-transport.test.ts) | 783 | Retain at triage | Representative behavior: desktop profile uses the HTTP relay with credentials only on upstream requests |
| [apps/epicenter/src/ai-catalog-routes.test.ts](../../apps/epicenter/src/ai-catalog-routes.test.ts) | 160 | Retain at triage | Representative behavior: two subscribed app windows receive initial and committed shared snapshots |
| [apps/epicenter/src/ai-catalog.test.ts](../../apps/epicenter/src/ai-catalog.test.ts) | 620 | Retain at triage | Representative behavior: each account restores its own catalog and keys without adopting the no-account catalog |
| [apps/epicenter/src/app-installation.test.ts](../../apps/epicenter/src/app-installation.test.ts) | 218 | Retain at triage | Representative behavior: installs a release and discovers it from the app directory |
| [apps/epicenter/src/checkout.test.ts](../../apps/epicenter/src/checkout.test.ts) | 262 | Retain at triage | Representative behavior: a folder is the data id, one segment under the root |
| [apps/epicenter/src/desktop-auth-authority.test.ts](../../apps/epicenter/src/desktop-auth-authority.test.ts) | 1132 | Retain at triage | Representative behavior: cancelling browser sign-in preserves the boot Account and releases application launching |
| [apps/epicenter/src/device.test.ts](../../apps/epicenter/src/device.test.ts) | 193 | Retain at triage | Representative behavior: account lifetimes hold independent files and reopen the same owner |
| [apps/epicenter/src/host.test.ts](../../apps/epicenter/src/host.test.ts) | 520 | Retain at triage | Representative behavior: host-owned approval prompt gates a mutation and approval resumes the turn |
| [apps/epicenter/src/mail-authorization.test.ts](../../apps/epicenter/src/mail-authorization.test.ts) | 80 | Retain at triage | Representative behavior: admits the authorization endpoint Local Mail actually builds |
| [apps/epicenter/src/server.test.ts](../../apps/epicenter/src/server.test.ts) | 2662 | Retain at triage | Representative behavior: development browser callback completes the pending sign-in without a Home cookie |
| [apps/epicenter/src/sidecar-runtime.test.ts](../../apps/epicenter/src/sidecar-runtime.test.ts) | 656 | Retain at triage | Representative behavior: source and compiled argv shapes select the Rust-supplied mode |
| [apps/epicenter/src/static-assets.test.ts](../../apps/epicenter/src/static-assets.test.ts) | 61 | Retain at triage | Representative behavior: loads only the explicitly compiled application directories |
| [apps/honeycrisp/src/lib/data.artifact.test.ts](../../apps/honeycrisp/src/lib/data.artifact.test.ts) | 154 | Retain at triage | Representative behavior: a store exports to Markdown files and imports back whole |
| [apps/honeycrisp/src/lib/editor/markdown.test.ts](../../apps/honeycrisp/src/lib/editor/markdown.test.ts) | 126 | Retain at triage | Representative behavior: body text round-trips through its own export |
| [apps/honeycrisp/src/lib/editor/node-text.test.ts](../../apps/honeycrisp/src/lib/editor/node-text.test.ts) | 88 | Rewrite one | Keep result tests; replace timing threshold with bounded-work evidence or a separate benchmark. |
| [apps/honeycrisp/src/lib/notes.test.ts](../../apps/honeycrisp/src/lib/notes.test.ts) | 149 | Retain at triage | Representative behavior: closing an editor flushes its queued derived title exactly once |
| [apps/honeycrisp/src/lib/platform-selection.test.ts](../../apps/honeycrisp/src/lib/platform-selection.test.ts) | 84 | Retain at triage | Representative behavior: every seam names a host leaf and a default leaf |
| [apps/local-books/src/books/query.test.ts](../../apps/local-books/src/books/query.test.ts) | 66 | Retain at triage | Representative behavior: runs a read-only SELECT and returns the live rows, bounded |
| [apps/local-books/src/books/recategorize.test.ts](../../apps/local-books/src/books/recategorize.test.ts) | 243 | Retain at triage | Representative behavior: moves the expense line in QuickBooks and folds it into the mirror |
| [apps/local-books/src/books/report.test.ts](../../apps/local-books/src/books/report.test.ts) | 80 | Retain at triage | Representative behavior: runs a report live against QuickBooks and passes the period through |
| [apps/local-books/src/books/status.test.ts](../../apps/local-books/src/books/status.test.ts) | 119 | Retain at triage | Representative behavior: reports an unbuilt mirror without creating it |
| [apps/local-books/src/db-file.test.ts](../../apps/local-books/src/db-file.test.ts) | 260 | Retain at triage | Representative behavior: names the file books.v<version>.db |
| [apps/local-books/src/token-store.test.ts](../../apps/local-books/src/token-store.test.ts) | 183 | Retain at triage | Representative behavior: writes a 0600 file and round-trips a token set |
| [apps/local-books/test/app-api.test.ts](../../apps/local-books/test/app-api.test.ts) | 371 | Retain at triage | Representative behavior: every route but the exchange requires a bearer |
| [apps/local-books/test/books-cli.test.ts](../../apps/local-books/test/books-cli.test.ts) | 84 | Retain at triage | Representative behavior: CLI: `query` returns mirror rows as JSON |
| [apps/local-books/test/cli-e2e.test.ts](../../apps/local-books/test/cli-e2e.test.ts) | 114 | Retain at triage | Representative behavior: CLI: `sync --full` then `sync` runs incremental, advances the cursor, no re-pull |
| [apps/local-books/test/db.test.ts](../../apps/local-books/test/db.test.ts) | 202 | Retain at triage | Representative behavior: a newer object overwrites an older row |
| [apps/local-books/test/entities.test.ts](../../apps/local-books/test/entities.test.ts) | 173 | Retain at triage | Representative behavior: lifts the header scalars from a live-shaped object |
| [apps/local-books/test/env-example.test.ts](../../apps/local-books/test/env-example.test.ts) | 40 | Retain at triage | Representative behavior: .env.example lists exactly QB_SPEC's qualified names |
| [apps/local-books/test/grill-e2e.test.ts](../../apps/local-books/test/grill-e2e.test.ts) | 134 | Retain at triage | Representative behavior: sync --full then query: grill the mirror the pipeline produced |
| [apps/local-books/test/mcp-server.test.ts](../../apps/local-books/test/mcp-server.test.ts) | 242 | Retain at triage | Representative behavior: mcp: tools/list, query rows, the two error channels, and a clean stream |
| [apps/local-books/test/mode.test.ts](../../apps/local-books/test/mode.test.ts) | 93 | Trim one | No-state and null-cursor cases construct the same fixture. |
| [apps/local-books/test/oauth.test.ts](../../apps/local-books/test/oauth.test.ts) | 132 | Retain at triage | Representative behavior: authorization-code exchange yields a token set |
| [apps/local-books/test/sync.test.ts](../../apps/local-books/test/sync.test.ts) | 349 | Retain at triage | Representative behavior: full pull seeds the mirror with valid JSON and the realm cursor |
| [apps/local-books/test/token-manager.test.ts](../../apps/local-books/test/token-manager.test.ts) | 51 | Retain at triage | Representative behavior: refuses a token minted for a different environment than requested |
| [apps/local-books/test/tokens.test.ts](../../apps/local-books/test/tokens.test.ts) | 88 | Retain at triage | Representative behavior: converts relative expiries into absolute timestamps |
| [apps/local-mail/src/accounts.test.ts](../../apps/local-mail/src/accounts.test.ts) | 400 | Retain at triage | Representative behavior: reconnecting one Google subject lands on the row it already has |
| [apps/local-mail/src/gmail-client.test.ts](../../apps/local-mail/src/gmail-client.test.ts) | 378 | Retain at triage | Representative behavior: modifyMessage sends POST body and accepts a slim message response |
| [apps/local-mail/src/intent-store.test.ts](../../apps/local-mail/src/intent-store.test.ts) | 89 | Retain at triage | Representative behavior: an older delivery cannot retire an overlapping undo from another store |
| [apps/local-mail/src/mailbox.test.ts](../../apps/local-mail/src/mailbox.test.ts) | 273 | Rewrite one | Cache-loss case creates unrelated empty database; invoke real storage-owner cache reset instead. |
| [apps/local-mail/src/message-fields.test.ts](../../apps/local-mail/src/message-fields.test.ts) | 156 | Rewrite one | Malformed-base64 case promises null but only checks no throw. |
| [apps/local-mail/src/oauth.test.ts](../../apps/local-mail/src/oauth.test.ts) | 235 | Retain at triage | Representative behavior: the consent URL asks for the mailbox and the identity |
| [apps/local-mail/src/outbox.test.ts](../../apps/local-mail/src/outbox.test.ts) | 365 | Retain at triage | Representative behavior: nothing has ever run, so the outbox says so rather than guessing |
| [apps/local-mail/src/reconcile-now.test.ts](../../apps/local-mail/src/reconcile-now.test.ts) | 474 | Retain at triage | Representative behavior: a pass delivers what is owed and empties the outbox |
| [apps/local-mail/src/reconcile.test.ts](../../apps/local-mail/src/reconcile.test.ts) | 934 | Keep; correct prose | Real drain/race behavior; claims about reports never being persisted contradict account-owned report recording. |
| [apps/local-mail/src/storage.test.ts](../../apps/local-mail/src/storage.test.ts) | 231 | Retain at triage | Representative behavior: a first open creates the durable file and stamps its version |
| [apps/local-mail/src/sync.pass.test.ts](../../apps/local-mail/src/sync.pass.test.ts) | 1156 | Retain at triage | Representative behavior: first run pulls every message, labels, and records the profile historyId as cursor |
| [apps/local-mail/src/sync.resume.test.ts](../../apps/local-mail/src/sync.resume.test.ts) | 332 | Retain at triage | Representative behavior: a killed downloader resumes its next page without losing the first page or original baseline |
| [apps/local-mail/src/token-manager.test.ts](../../apps/local-mail/src/token-manager.test.ts) | 542 | Retain at triage | Representative behavior: a held access token is used without touching the token endpoint |
| [apps/local-mail/ui/src/lib/actions.test.ts](../../apps/local-mail/ui/src/lib/actions.test.ts) | 92 | Retain at triage | Representative behavior: inbox toggles on presence of INBOX |
| [apps/local-mail/ui/src/lib/data.test.ts](../../apps/local-mail/ui/src/lib/data.test.ts) | 94 | Retain at triage | Representative behavior: invalid SQL and duplicate names survive a durable close and reopen with their row ids |
| [apps/local-mail/ui/src/lib/mail.test.ts](../../apps/local-mail/ui/src/lib/mail.test.ts) | 245 | Retain at triage | Representative behavior: local reads and durable triage do not require Gmail credentials or identity |
| [apps/local-mail/ui/src/lib/platform-selection.test.ts](../../apps/local-mail/ui/src/lib/platform-selection.test.ts) | 56 | Retain at triage | Representative behavior: every seam names a host leaf and a default leaf that exist |
| [apps/local-mail/ui/src/lib/sanitize-email.test.ts](../../apps/local-mail/ui/src/lib/sanitize-email.test.ts) | 97 | Retain at triage | Representative behavior: strips <script> and inline event handlers |
| [apps/matter/src/lib/components/board.test.ts](../../apps/matter/src/lib/components/board.test.ts) | 254 | Retain at triage | Representative behavior: boardColumnsFor groups ordered in-memory rows and projects card fields |
| [apps/matter/src/lib/editor/markdown-live-preview.test.ts](../../apps/matter/src/lib/editor/markdown-live-preview.test.ts) | 150 | Retain at triage | Representative behavior: hides a heading marker on an inactive line |
| [apps/matter/src/lib/editor/markdown-shortcuts.test.ts](../../apps/matter/src/lib/editor/markdown-shortcuts.test.ts) | 97 | Retain at triage | Representative behavior: wraps a selection |
| [apps/matter/src/lib/routes.test.ts](../../apps/matter/src/lib/routes.test.ts) | 119 | Retain at triage | Representative behavior: ?panel=sql resolves panel |
| [apps/matter/src/lib/view/projector-roundtrip.test.ts](../../apps/matter/src/lib/view/projector-roundtrip.test.ts) | 82 | Retain at triage | Representative behavior: a status edit moves a card between board buckets through the projector |
| [apps/reddit/src/lib/workspace/ingest/reddit/index.test.ts](../../apps/reddit/src/lib/workspace/ingest/reddit/index.test.ts) | 93 | Retain at triage | Representative behavior: returns transformed table rows and account metadata |
| [apps/reddit/src/lib/workspace/ingest/reddit/parse.test.ts](../../apps/reddit/src/lib/workspace/ingest/reddit/parse.test.ts) | 112 | Retain at triage | Representative behavior: concatenates split CSVs into a single array |
| [apps/self-host/runtime-profile.test.ts](../../apps/self-host/runtime-profile.test.ts) | 467 | Trim one | Keep actual composition; explanation-on-every-PROFILE-row test checks its own fixture. |
| [apps/self-host/shutdown.test.ts](../../apps/self-host/shutdown.test.ts) | 124 | Retain at triage | Representative behavior: shutdown drains a suspended auth request before closing its database and shares repeated signals |
| [apps/self-host/trusted-origins.test.ts](../../apps/self-host/trusted-origins.test.ts) | 93 | Retain at triage | Representative behavior: trusts the instance, Tauri, and exact configured browser origins |
| [apps/skills/src/lib/application.test.ts](../../apps/skills/src/lib/application.test.ts) | 148 | Retain at triage | Representative behavior: the runtime opens the captured account current Personal library |
| [apps/sync-lab/worker/hibernation.test.ts](../../apps/sync-lab/worker/hibernation.test.ts) | 279 | Retain at triage | Representative behavior: the object is evicted, and the other device still receives what it missed |
| [apps/vocab/src/lib/boot-node.test.ts](../../apps/vocab/src/lib/boot-node.test.ts) | 68 | Rewrite | Keep callback/acquisition ownership, replace exact component and variable spelling. |
| [apps/vocab/src/lib/entry-candidates.test.ts](../../apps/vocab/src/lib/entry-candidates.test.ts) | 99 | Decision + rewrite | Gloss-repair cases require truncating valid verbatim spans. Validate candidates against source text. |
| [apps/vocab/src/lib/practice.test.ts](../../apps/vocab/src/lib/practice.test.ts) | 65 | Trim | Fold single-entry and two-example title-noncollision cases into stronger verbatim/title tests. |
| [apps/vocab/src/lib/readings/cyrillic.test.ts](../../apps/vocab/src/lib/readings/cyrillic.test.ts) | 36 | Retain at triage | Representative behavior: segments cover the whole input in order, lossless |
| [apps/vocab/src/lib/readings/pinyin.test.ts](../../apps/vocab/src/lib/readings/pinyin.test.ts) | 49 | Retain at triage | Representative behavior: segments cover the whole input in order, lossless |
| [apps/vocab/src/lib/readings/registry.test.ts](../../apps/vocab/src/lib/readings/registry.test.ts) | 54 | Retain at triage | Representative behavior: each provider reads only the runs earlier ones left plain |
| [apps/vocab/src/lib/readings/romaji.test.ts](../../apps/vocab/src/lib/readings/romaji.test.ts) | 37 | Retain at triage | Representative behavior: segments cover the whole input in order, lossless |
| [apps/vocab/src/lib/state/dictation.test.ts](../../apps/vocab/src/lib/state/dictation.test.ts) | 116 | Retain at triage | Representative behavior: close joins microphone startup, stops it, then drains captured phrases |
| [apps/whispering/src/lib/application.test.ts](../../apps/whispering/src/lib/application.test.ts) | 56 | Replace | Calls removed openApplication and mocks deleted bootstrap; preserve attachment, retirement and startup behavior at the new owner. |
| [apps/whispering/src/lib/boot-node.test.ts](../../apps/whispering/src/lib/boot-node.test.ts) | 67 | Rewrite | Keep callback/acquisition ownership, replace exact component and variable spelling. |
| [apps/whispering/src/lib/data.local-model-is-not-synced.test.ts](../../apps/whispering/src/lib/data.local-model-is-not-synced.test.ts) | 36 | Trim | Keep actual definition policy; reconsider retired setting-name list and heuristic key-name matching. |
| [apps/whispering/src/lib/operations/build-system-prompt.test.ts](../../apps/whispering/src/lib/operations/build-system-prompt.test.ts) | 79 | Retain at triage | Representative behavior: returns instructions verbatim when the dictionary is empty |
| [apps/whispering/src/lib/operations/completion.test.ts](../../apps/whispering/src/lib/operations/completion.test.ts) | 284 | Retain at triage | Representative behavior: Polish and Recipe completion uses the exact connection when model IDs collide |
| [apps/whispering/src/lib/operations/credit-action.test.ts](../../apps/whispering/src/lib/operations/credit-action.test.ts) | 59 | Retain at triage | Representative behavior: Add credits captures the failing account and only opens its website |
| [apps/whispering/src/lib/operations/import.test.ts](../../apps/whispering/src/lib/operations/import.test.ts) | 154 | Retain at triage | Representative behavior: failed import does not abandon its sibling before departure drains |
| [apps/whispering/src/lib/operations/pipeline.test.ts](../../apps/whispering/src/lib/operations/pipeline.test.ts) | 527 | Retain at triage | Representative behavior: A inference finishes into its row while B retains current feedback |
| [apps/whispering/src/lib/operations/push-to-talk.test.ts](../../apps/whispering/src/lib/operations/push-to-talk.test.ts) | 74 | Retain at triage | Representative behavior: dispose stops an active push-to-talk recording before app teardown |
| [apps/whispering/src/lib/operations/recording-close.test.ts](../../apps/whispering/src/lib/operations/recording-close.test.ts) | 349 | Retain at triage | Representative behavior: closing admission during native finalization still saves the admitted recording |
| [apps/whispering/src/lib/operations/recording.svelte.test.ts](../../apps/whispering/src/lib/operations/recording.svelte.test.ts) | 614 | Retain at triage | Representative behavior: capture creates no row and stop saves finished bytes and duration before original inference |
| [apps/whispering/src/lib/operations/run-polish.test.ts](../../apps/whispering/src/lib/operations/run-polish.test.ts) | 191 | Retain at triage | Representative behavior: importing Polish reads no App or device configuration |
| [apps/whispering/src/lib/operations/transcribe.test.ts](../../apps/whispering/src/lib/operations/transcribe.test.ts) | 406 | Retain at triage | Representative behavior: exact configured client sends multipart bytes, model, credential, and dictionary hints |
| [apps/whispering/src/lib/operations/transcription-history.test.ts](../../apps/whispering/src/lib/operations/transcription-history.test.ts) | 107 | Retain at triage | Representative behavior: a committed write confirms the history save |
| [apps/whispering/src/lib/operations/upload-recording.test.ts](../../apps/whispering/src/lib/operations/upload-recording.test.ts) | 67 | Retain at triage | Representative behavior: upload sends a local ID and retains the returned remote URL |
| [apps/whispering/src/lib/platform-selection.test.ts](../../apps/whispering/src/lib/platform-selection.test.ts) | 85 | Retain at triage | Representative behavior: each platform-dependent capability selects a browser or host leaf |
| [apps/whispering/src/lib/queries/download.test.ts](../../apps/whispering/src/lib/queries/download.test.ts) | 50 | Retain at triage | Representative behavior: recording download supplies a complete .${extension} filename |
| [apps/whispering/src/lib/queries/transcription.test.ts](../../apps/whispering/src/lib/queries/transcription.test.ts) | 80 | Retain at triage | Representative behavior: departure drains manual and bulk retry persistence and refuses new work |
| [apps/whispering/src/lib/report/humanize.test.ts](../../apps/whispering/src/lib/report/humanize.test.ts) | 11 | Retain at triage | Representative behavior: humanize converts tagged error variants into human titles |
| [apps/whispering/src/lib/services/download/index.browser.test.ts](../../apps/whispering/src/lib/services/download/index.browser.test.ts) | 64 | Retain at triage | Representative behavior: ${fails ? 'failed' : 'successful'} browser download preserves the filename and revokes its URL |
| [apps/whispering/src/lib/services/download/index.tauri.test.ts](../../apps/whispering/src/lib/services/download/index.tauri.test.ts) | 76 | Retain at triage | Representative behavior: native download supplies ${name} and its suffix without changing the bytes |
| [apps/whispering/src/lib/shortcuts/reach-router.test.ts](../../apps/whispering/src/lib/shortcuts/reach-router.test.ts) | 295 | Retain at triage | Representative behavior: a chord on a global command routes the write to the global store (desktop) |
| [apps/whispering/src/lib/tauri.tauri.test.ts](../../apps/whispering/src/lib/tauri.tauri.test.ts) | 41 | Retain at triage | Representative behavior: native import preserves basename and bytes for the shared format policy |
| [apps/whispering/src/lib/tauri/local-model-boundary.test.ts](../../apps/whispering/src/lib/tauri/local-model-boundary.test.ts) | 72 | Rewrite/prune | Slices hand-written facade text; generated bindings include administration. Preserve model-input policy through actual types/IPC and Rust grants. |
| [apps/whispering/src/lib/utils/key-binding.test.ts](../../apps/whispering/src/lib/utils/key-binding.test.ts) | 150 | Retain at triage | Representative behavior: a chord maps to a global-hotkey accelerator |
| [apps/whispering/src/lib/utils/reserved-shortcuts.test.ts](../../apps/whispering/src/lib/utils/reserved-shortcuts.test.ts) | 64 | Retain at triage | Representative behavior: an empty binding is treated as unset and passes |
| [apps/whispering/src/lib/whispering/app.test.ts](../../apps/whispering/src/lib/whispering/app.test.ts) | 94 | Retain at triage | Representative behavior: settings recover application defaults, notify, and survive a reopen |
| [apps/whispering/src/lib/whispering/recordings-markdown-export.test.ts](../../apps/whispering/src/lib/whispering/recordings-markdown-export.test.ts) | 103 | Retain at triage | Representative behavior: ZIP export retains row descriptions and full audio keys under recordings.zip |
| [apps/whispering/src/lib/whispering/recordings.test.ts](../../apps/whispering/src/lib/whispering/recordings.test.ts) | 365 | Retain at triage | Representative behavior: rows stay live, sort newest first, and allow replacing the blob reference |
| [apps/whispering/tests/delivery.test.ts](../../apps/whispering/tests/delivery.test.ts) | 91 | Retain at triage | Representative behavior: cursor off and clipboard on copies to the clipboard sink |
| [apps/whispering/tests/dictation-projection.test.ts](../../apps/whispering/tests/dictation-projection.test.ts) | 113 | Retain at triage | Representative behavior: idle capture with no outcome hides the pill |
| [apps/whispering/tests/hosted-identity.test.ts](../../apps/whispering/tests/hosted-identity.test.ts) | 59 | Prune | Cutover names, directory absence and exact config text; build-applications and platform checks cover the useful boundaries. |
| [apps/whispering/tests/recording-mic-level.test.ts](../../apps/whispering/tests/recording-mic-level.test.ts) | 26 | Retain at triage | Representative behavior: silence remains silent |
| [packages/agent/src/compose-tool-catalogs.test.ts](../../packages/agent/src/compose-tool-catalogs.test.ts) | 79 | Retain at triage | Representative behavior: unions definitions and routes calls to their owner |
| [packages/agent/src/local-tool-catalog.test.ts](../../packages/agent/src/local-tool-catalog.test.ts) | 99 | Retain at triage | Representative behavior: lists action metadata and resolves raw values |
| [packages/agent/src/loop.test.ts](../../packages/agent/src/loop.test.ts) | 347 | Rewrite one | Immediate tools establish invocation order, not sequential completion; delay first tool. |
| [packages/agent/src/namespace-tool-catalog.test.ts](../../packages/agent/src/namespace-tool-catalog.test.ts) | 53 | Retain at triage | Representative behavior: prefixes definitions and strips the prefix during resolution |
| [packages/agent/src/tools.test.ts](../../packages/agent/src/tools.test.ts) | 119 | Retain at triage | Representative behavior: default policy auto-runs queries and asks for mutations |
| [packages/app-shell/src/agent-chat/agent-chat.svelte.test.ts](../../packages/app-shell/src/agent-chat/agent-chat.svelte.test.ts) | 372 | Rewrite harness | Nonreactive rune and CRDT fakes have admitted historical drift; preserve conversation/target behavior. |
| [packages/app-shell/src/boot-screens/departure.test.ts](../../packages/app-shell/src/boot-screens/departure.test.ts) | 265 | Retain at triage | Representative behavior: departure drains producers, closes storage, then changes authentication |
| [packages/app-shell/src/boot-screens/desktop-close.test.ts](../../packages/app-shell/src/boot-screens/desktop-close.test.ts) | 75 | Retain at triage | Representative behavior: native success acknowledgement waits for App closure |
| [packages/app-shell/src/boot-screens/open-failure.test.ts](../../packages/app-shell/src/boot-screens/open-failure.test.ts) | 99 | Retain at triage | Representative behavior: the noun and the app name come from the application |
| [packages/app-shell/src/inference-picker/connections.test.ts](../../packages/app-shell/src/inference-picker/connections.test.ts) | 355 | Retain at triage | Representative behavior: the same model selects either custom connection or hosted independently |
| [packages/app-shell/src/inference-selections.test.ts](../../packages/app-shell/src/inference-selections.test.ts) | 147 | Retain at triage | Representative behavior: saved scopes preserve exact identities and models across reload without retaining caller objects |
| [packages/app/evidence/data/a-row-is-not-a-value.test.ts](../../packages/app/evidence/data/a-row-is-not-a-value.test.ts) | 97 | Retain at triage | Representative behavior: two converged stores do NOT produce equal rows |
| [packages/app/evidence/data/current-generation/authority.test.ts](../../packages/app/evidence/data/current-generation/authority.test.ts) | 367 | Retain at triage | Representative behavior: two first callers observe one complete current generation |
| [packages/app/evidence/data/current-generation/hub.test.ts](../../packages/app/evidence/data/current-generation/hub.test.ts) | 338 | Retain at triage | Representative behavior: retired joins receive no replacement bytes, including reconstructed attachments |
| [packages/app/evidence/data/deletion-model.test.ts](../../packages/app/evidence/data/deletion-model.test.ts) | 238 | Archive/consolidate | Historical rival-model comparison incorrectly describes clear-and-flag as current; real delete uses root removal. |
| [packages/app/evidence/data/delta-names-the-row.test.ts](../../packages/app/evidence/data/delta-names-the-row.test.ts) | 163 | Retain at triage | Representative behavior: a created row |
| [packages/app/evidence/data/detached-type.test.ts](../../packages/app/evidence/data/detached-type.test.ts) | 142 | Rewrite one | Keep codec evidence; replace random encoded-size comparison with deterministic fixture. |
| [packages/app/evidence/data/independent-document-roots.test.ts](../../packages/app/evidence/data/independent-document-roots.test.ts) | 47 | Consolidate | Overlap with invariants; retain any unique text-root evidence. |
| [packages/app/evidence/data/invariants.test.ts](../../packages/app/evidence/data/invariants.test.ts) | 475 | Trim/correct research | Retain dependency/root evidence; clear-and-flag discussion is historical, not an open production requirement. |
| [packages/app/evidence/data/retention.test.ts](../../packages/app/evidence/data/retention.test.ts) | 171 | Keep; correct title | Uses actual production authority; second-test title overstates post-snapshot tail setup. |
| [packages/app/evidence/data/rewriting-a-body.test.ts](../../packages/app/evidence/data/rewriting-a-body.test.ts) | 110 | Research | Local rewrite experiment; move necessary concurrency coverage through actual codec before pruning. |
| [packages/app/evidence/data/validation.test.ts](../../packages/app/evidence/data/validation.test.ts) | 286 | Research | Historical filter comparison; corpus-relative counts do not prove production validation. |
| [packages/app/evidence/data/what-the-crdt-buys.test.ts](../../packages/app/evidence/data/what-the-crdt-buys.test.ts) | 140 | Research; rewrite one | Conceptual model evidence, not production contract; replace probabilistic winner sampling with fixed IDs. |
| [packages/app/src/ai-connections.epicenter-host.test.ts](../../packages/app/src/ai-connections.epicenter-host.test.ts) | 181 | Retain at triage | Representative behavior: readiness waits for the initial host snapshot and subscribe supplies it immediately |
| [packages/app/src/ai-connections.test.ts](../../packages/app/src/ai-connections.test.ts) | 174 | Retain at triage | Representative behavior: rename, key rotation, reorder, and reopen preserve independent same-URL IDs |
| [packages/app/src/ai.test.ts](../../packages/app/src/ai.test.ts) | 474 | Retain at triage | Representative behavior: reads construct actual SDK clients without requests or ambient credentials |
| [packages/app/src/app.test.ts](../../packages/app/src/app.test.ts) | 1683 | Retain at triage | Representative behavior: local handle opens without account and survives close and reopen |
| [packages/app/src/blob-retirement.test.ts](../../packages/app/src/blob-retirement.test.ts) | 115 | Retain at triage | Representative behavior: document retirement aborts an upload and releases playback before explicit App close |
| [packages/app/src/clipboard.browser.test.ts](../../packages/app/src/clipboard.browser.test.ts) | 45 | Retain at triage | Representative behavior: reads and writes through navigator.clipboard |
| [packages/app/src/clipboard.test.ts](../../packages/app/src/clipboard.test.ts) | 77 | Retain at triage | Representative behavior: returns the platform text |
| [packages/app/src/data/__benchmarks__/root-rotation.test.ts](../../packages/app/src/data/__benchmarks__/root-rotation.test.ts) | 111 | Research | Contains real assertions about experiment; optional evidence suite, not a rename to benchmark just because of directory. |
| [packages/app/src/data/artifact/checkout.test.ts](../../packages/app/src/data/artifact/checkout.test.ts) | 1981 | Product decision | Exported working-copy engine has no app caller; 1,980 lines protect unconsumed product surface. Fold duplicated body-edit cases. |
| [packages/app/src/data/artifact/frontmatter.test.ts](../../packages/app/src/data/artifact/frontmatter.test.ts) | 60 | Retain at triage | Representative behavior: strings that YAML would reinterpret bare stay quoted strings |
| [packages/app/src/data/artifact/import.test.ts](../../packages/app/src/data/artifact/import.test.ts) | 283 | Retain at triage | Representative behavior: an exported store imports back into an identical one |
| [packages/app/src/data/artifact/optional-content.test.ts](../../packages/app/src/data/artifact/optional-content.test.ts) | 79 | Retain at triage | Representative behavior: a fields-only artifact round-trips fields and an empty node |
| [packages/app/src/data/artifact/render.test.ts](../../packages/app/src/data/artifact/render.test.ts) | 245 | Retain at triage | Representative behavior: one row becomes one file: fields on top, body text underneath |
| [packages/app/src/data/definition/addresses.test.ts](../../packages/app/src/data/definition/addresses.test.ts) | 59 | Retain at triage | Representative behavior: a row id is safe verbatim in a path segment and never hides |
| [packages/app/src/data/definition/compile.test.ts](../../packages/app/src/data/definition/compile.test.ts) | 84 | Retain at triage | Representative behavior: trusted TypeScript definitions compile and retain their codecs |
| [packages/app/src/data/field/field.test.ts](../../packages/app/src/data/field/field.test.ts) | 464 | Retain at triage | Representative behavior: field.${kind} recognizes back as ${kind} and matches exactly one meta |
| [packages/app/src/data/open.test.ts](../../packages/app/src/data/open.test.ts) | 26 | Retain at triage | Representative behavior: disposing data leaves caller-owned SQLite open and preserves rows for reopening |
| [packages/app/src/data/store/browser.test.ts](../../packages/app/src/data/store/browser.test.ts) | 385 | Retain at triage | Representative behavior: current and local addresses retain their durable spellings |
| [packages/app/src/data/store/current-open.test.ts](../../packages/app/src/data/store/current-open.test.ts) | 308 | Retain at triage | Representative behavior: independent caches install canonical bytes and reopen offline without discovery |
| [packages/app/src/data/store/document.test.ts](../../packages/app/src/data/store/document.test.ts) | 213 | Retain at triage | Representative behavior: a row that was not there is there afterwards |
| [packages/app/src/data/store/flush-on-hide.test.ts](../../packages/app/src/data/store/flush-on-hide.test.ts) | 138 | Retain at triage | Representative behavior: registers nothing and disposes cleanly |
| [packages/app/src/data/store/idb-runtime.test.ts](../../packages/app/src/data/store/idb-runtime.test.ts) | 82 | Retain at triage | Contract identified in file-level review; no deletion justified. |
| [packages/app/src/data/store/idb-transactions.test.ts](../../packages/app/src/data/store/idb-transactions.test.ts) | 171 | Retain at triage | Representative behavior: transaction failure reports the first request error only after rollback abort |
| [packages/app/src/data/store/persist.test.ts](../../packages/app/src/data/store/persist.test.ts) | 67 | Retain at triage | Representative behavior: a runtime with no Storage API is not an error |
| [packages/app/src/data/store/persistence.test.ts](../../packages/app/src/data/store/persistence.test.ts) | 675 | Retain at triage | Representative behavior: a blocked store keeps accepting, and reads follow immediately |
| [packages/app/src/data/store/port-conformance.test.ts](../../packages/app/src/data/store/port-conformance.test.ts) | 478 | Retain at triage | Representative behavior: an append survives a reopen |
| [packages/app/src/data/store/store-opening.test.ts](../../packages/app/src/data/store/store-opening.test.ts) | 732 | Retain at triage | Representative behavior: retained reads and writes throw as soon as close starts |
| [packages/app/src/data/store/store-retirement.test.ts](../../packages/app/src/data/store/store-retirement.test.ts) | 202 | Decision on one case | Legacy replicated backing without invalidation is an avoidable invalid state; keep retirement/drain safety coverage. |
| [packages/app/src/data/store/store.test.ts](../../packages/app/src/data/store/store.test.ts) | 1209 | Retain at triage | Representative behavior: disposing the data disposes the store under it |
| [packages/app/src/data/store/sync.test.ts](../../packages/app/src/data/store/sync.test.ts) | 318 | Rewrite claims | Equal output does not prove no re-merge; keep actual durable/outbox checks. |
| [packages/app/src/data/sync/attach.test.ts](../../packages/app/src/data/sync/attach.test.ts) | 297 | Retain at triage | Representative behavior: the first dial names the dataId, a cursor of zero, and the main subprotocol |
| [packages/app/src/data/sync/authority.test.ts](../../packages/app/src/data/sync/authority.test.ts) | 151 | Retain at triage | Representative behavior: append assigns positions and since returns the bytes untouched |
| [packages/app/src/data/sync/connection.test.ts](../../packages/app/src/data/sync/connection.test.ts) | 986 | Retain at triage | Representative behavior: a row created on one device arrives on the other |
| [packages/app/src/data/sync/frames.test.ts](../../packages/app/src/data/sync/frames.test.ts) | 32 | Retain at triage | Representative behavior: admission controls round-trip without a selectable generation payload |
| [packages/app/src/data/sync/hub.test.ts](../../packages/app/src/data/sync/hub.test.ts) | 310 | Retain at triage | Representative behavior: admission fails when ${operation} cannot be read |
| [packages/app/src/data/sync/persistence-scheduling.test.ts](../../packages/app/src/data/sync/persistence-scheduling.test.ts) | 197 | Retain at triage | Representative behavior: a durable append wakes an idle connection after the original send window |
| [packages/app/src/data/sync/transport.test.ts](../../packages/app/src/data/sync/transport.test.ts) | 2308 | Retain at triage | Representative behavior: a row created on one device arrives on the other |
| [packages/app/src/epicenter-host.test.ts](../../packages/app/src/epicenter-host.test.ts) | 12 | Fold | Fold assignment/export assertions into platform selection and behavioral host/blob tests. |
| [packages/app/src/import-boundaries.test.ts](../../packages/app/src/import-boundaries.test.ts) | 155 | Retain at triage | Representative behavior: a ${host ? 'host' : 'browser'} declaration works without browser globals |
| [packages/app/src/index.test.ts](../../packages/app/src/index.test.ts) | 290 | Retain at triage | Representative behavior: App readiness includes catalog hydration and failed hydration releases the App |
| [packages/app/src/native-ai.test.ts](../../packages/app/src/native-ai.test.ts) | 186 | Retain at triage | Representative behavior: SDK uploads actual file bytes and explicit model with hints |
| [packages/app/src/platform-selection.test.ts](../../packages/app/src/platform-selection.test.ts) | 95 | Retain at triage | Representative behavior: default runtime and clipboard select ${host ? 'host' : 'browser'} without I/O |
| [packages/app/src/recording.test.ts](../../packages/app/src/recording.test.ts) | 350 | Retain at triage | Representative behavior: resolved opening binds recording once and permits microphone acquisition |
| [packages/app/src/recording/browser.test.ts](../../packages/app/src/recording/browser.test.ts) | 448 | Retain at triage | Representative behavior: stop commits into the independently opened app-local store |
| [packages/app/src/recording/desktop.test.ts](../../packages/app/src/recording/desktop.test.ts) | 669 | Retain at triage | Representative behavior: construction and construction-only close acquire no native session |
| [packages/app/src/runtime.test.ts](../../packages/app/src/runtime.test.ts) | 308 | Retain at triage | Representative behavior: one runtime reopens committed storage while another is isolated |
| [packages/app/src/scopes.test.ts](../../packages/app/src/scopes.test.ts) | 314 | Retain at triage | Representative behavior: device rows, SQLite, secrets and blobs isolate owners and survive returning to each owner |
| [packages/app/src/sync-subprotocol.test.ts](../../packages/app/src/sync-subprotocol.test.ts) | 115 | Retain at triage | Representative behavior: the dial offers the main subprotocol beside the bearer |
| [packages/auth/src/account-lifetime.test.ts](../../packages/auth/src/account-lifetime.test.ts) | 360 | Retain at triage | Representative behavior: verification and uninterrupted same-person sign-in preserve the Account object |
| [packages/auth/src/account-management.test.ts](../../packages/auth/src/account-management.test.ts) | 35 | Retain at triage | Representative behavior: account links encode the principal and discard unrelated base URL context |
| [packages/auth/src/browser-auth.test.ts](../../packages/auth/src/browser-auth.test.ts) | 335 | Keep; historical decision | Historical restore is live; do not conflate it with unused static-token enrollment. |
| [packages/auth/src/client-boundary.test.ts](../../packages/auth/src/client-boundary.test.ts) | 95 | Keep/narrow | Real credential exclusion; stale directory allowlist and positive export-presence assertions can go. |
| [packages/auth/src/contract.test.ts](../../packages/auth/src/contract.test.ts) | 694 | Retain at triage | Representative behavior: signed-out client has no callback method unless the launcher provides one |
| [packages/auth/src/desktop-broker-auth.test.ts](../../packages/auth/src/desktop-broker-auth.test.ts) | 426 | Retain at triage | Representative behavior: window fetch attaches no credential to any request |
| [packages/auth/src/instance-auth.test.ts](../../packages/auth/src/instance-auth.test.ts) | 210 | Decision; split | New enrollment/repair has no app caller, but historical offline restoration still protects saved identities. |
| [packages/auth/src/instance-server.test.ts](../../packages/auth/src/instance-server.test.ts) | 24 | Retain at triage | Representative behavior: equivalent origins select the same authority before boot |
| [packages/auth/src/instance-token.test.ts](../../packages/auth/src/instance-token.test.ts) | 54 | Decision | Token-strength test belongs to obsolete generator/gate workflow; retire workflow before test. |
| [packages/auth/src/persisted-auth-format.test.ts](../../packages/auth/src/persisted-auth-format.test.ts) | 30 | Retain at triage | Representative behavior: the direct-session cell round-trips without grant metadata |
| [packages/auth/src/persisted-auth-storage.test.ts](../../packages/auth/src/persisted-auth-storage.test.ts) | 104 | Retain at triage | Representative behavior: treats a corrupt cell as signed out |
| [packages/auth/src/read-api-session.test.ts](../../packages/auth/src/read-api-session.test.ts) | 70 | Rewrite one | Test title says 401/403 but only exercises 401. |
| [packages/auth/src/refusal-is-not-an-identity-change.test.ts](../../packages/auth/src/refusal-is-not-an-identity-change.test.ts) | 35 | Retain at triage | Representative behavior: session refusal preserves the captured Account |
| [packages/auth/src/session-authority.test.ts](../../packages/auth/src/session-authority.test.ts) | 125 | Trim one | Keep authority isolation; remove standalone function-exists assertion. |
| [packages/auth/src/session-handoff-client.test.ts](../../packages/auth/src/session-handoff-client.test.ts) | 395 | Retain at triage | Representative behavior: ${callback}: persisted attempt survives reconstruction and creates an independent session |
| [packages/auth/src/verify-instance-token.test.ts](../../packages/auth/src/verify-instance-token.test.ts) | 136 | Retire with code | Standalone historical token verifier has no production caller; remove its unused surface together. |
| [packages/blobs/src/app-remote.test.ts](../../packages/blobs/src/app-remote.test.ts) | 76 | Retain at triage | Representative behavior: close aborts an admitted request, drains its late source and rejects new work |
| [packages/blobs/src/app.test.ts](../../packages/blobs/src/app.test.ts) | 337 | Retain at triage | Representative behavior: every retained blob verb refuses before readiness and throughout close without primitive calls |
| [packages/blobs/src/blob-format.test.ts](../../packages/blobs/src/blob-format.test.ts) | 101 | Retain at triage | Representative behavior: structural filename evidence works without a File constructor |
| [packages/blobs/src/blob-id.test.ts](../../packages/blobs/src/blob-id.test.ts) | 46 | Retain at triage | Representative behavior: mint requires a bounded extension and preserves the random body |
| [packages/blobs/src/browser-lifecycle.test.ts](../../packages/blobs/src/browser-lifecycle.test.ts) | 163 | Retain at triage | Representative behavior: omitting the account selects the application no-account namespace |
| [packages/blobs/src/browser.test.ts](../../packages/blobs/src/browser.test.ts) | 411 | Retain at triage | Representative behavior: fresh records contain only id, ArrayBuffer bytes, and derived size and survive reopening |
| [packages/blobs/src/bun.test.ts](../../packages/blobs/src/bun.test.ts) | 445 | Retain at triage | Representative behavior: one complete key is one ordinary file with canonical format and no sidecar |
| [packages/blobs/src/webview.test.ts](../../packages/blobs/src/webview.test.ts) | 208 | Retain at triage | Representative behavior: all local operations retain the app selected at construction |
| [packages/chat/src/index.test.ts](../../packages/chat/src/index.test.ts) | 71 | Retain at triage | Representative behavior: the agent store observes writes and survives a restart |
| [packages/client/src/blob-format.test.ts](../../packages/client/src/blob-format.test.ts) | 79 | Retain at triage | Contract identified in file-level review; no deletion justified. |
| [packages/client/src/index.test.ts](../../packages/client/src/index.test.ts) | 175 | Retain at triage | Representative behavior: add sends bytes directly through Account and returns the owner-pinned URL |
| [packages/client/src/openai-provider.test.ts](../../packages/client/src/openai-provider.test.ts) | 572 | Retain at triage | Representative behavior: builds the OpenAI request: system prompts, mapped transcript, tools, streaming |
| [packages/constants/src/ai-providers.test.ts](../../packages/constants/src/ai-providers.test.ts) | 27 | Retain at triage | Representative behavior: resolves a known provider id to its vendor label |
| [packages/constants/src/app-data.test.ts](../../packages/constants/src/app-data.test.ts) | 207 | Trim stale claim | Local Mail email-partition rationale is retired; keep generic path safety and live Local Books realm behavior. |
| [packages/constants/src/app-id.test.ts](../../packages/constants/src/app-id.test.ts) | 81 | Retain at triage | Representative behavior: every first-party application id is admitted |
| [packages/constants/src/provider-credentials.test.ts](../../packages/constants/src/provider-credentials.test.ts) | 128 | Retain at triage | Representative behavior: multi-environment provider reads env-qualified names |
| [packages/device/src/app-claim.test.ts](../../packages/device/src/app-claim.test.ts) | 80 | Retain at triage | Representative behavior: App admission separates app and account namespaces and refuses duplicates |
| [packages/device/src/browser-sqlite.test.ts](../../packages/device/src/browser-sqlite.test.ts) | 63 | Retain at triage | Representative behavior: shared requests fail together and a retired worker cannot fail its replacement |
| [packages/device/src/browser-sqlite.worker.test.ts](../../packages/device/src/browser-sqlite.worker.test.ts) | 81 | Retain at triage | Representative behavior: application and database names select independent files |
| [packages/device/src/desktop.test.ts](../../packages/device/src/desktop.test.ts) | 219 | Retain at triage | Representative behavior: SQL uses one lifetime socket and secrets survive its acknowledged close |
| [packages/device/src/index.test.ts](../../packages/device/src/index.test.ts) | 23 | Retain at triage | Representative behavior: a database name is checked at the scoped capability boundary |
| [packages/device/src/memory.test.ts](../../packages/device/src/memory.test.ts) | 76 | Retain at triage | Representative behavior: close retains committed data but rolls back transactions and clears temporary tables |
| [packages/device/src/owner.test.ts](../../packages/device/src/owner.test.ts) | 649 | Retain at triage | Representative behavior: SQL acquires on first use and holds its identity until close |
| [packages/device/src/query.test.ts](../../packages/device/src/query.test.ts) | 92 | Retain at triage | Representative behavior: ordered duplicate headers preserve distinct values and empty results retain headers |
| [packages/device/src/secrets.test.ts](../../packages/device/src/secrets.test.ts) | 137 | Retain at triage | Representative behavior: browser secrets survive reopening and isolate applications and labels |
| [packages/matter-core/src/core/conformance.test.ts](../../packages/matter-core/src/core/conformance.test.ts) | 162 | Retain at triage | Representative behavior: a present valid value is OK; the row is valid when every cell is OK |
| [packages/matter-core/src/core/contract.test.ts](../../packages/matter-core/src/core/contract.test.ts) | 255 | Retain at triage | Representative behavior: accepts the palette subset and derives kinds in declared order |
| [packages/matter-core/src/core/expected.test.ts](../../packages/matter-core/src/core/expected.test.ts) | 57 | Retain at triage | Representative behavior: a scalar kind reduces to its name |
| [packages/matter-core/src/core/integrity.test.ts](../../packages/matter-core/src/core/integrity.test.ts) | 380 | Retain at triage | Representative behavior: a present, valid non-reference value is ok |
| [packages/matter-core/src/core/parse.test.ts](../../packages/matter-core/src/core/parse.test.ts) | 75 | Retain at triage | Representative behavior: splits frontmatter from body |
| [packages/matter-core/src/core/query.test.ts](../../packages/matter-core/src/core/query.test.ts) | 130 | Trim/replace | Prefer executed SQLite semantics over duplicate SQL text; first preserve explicit-sort-over-FTS behavior. |
| [packages/matter-core/src/core/serialize.test.ts](../../packages/matter-core/src/core/serialize.test.ts) | 115 | Retain at triage | Representative behavior: an empty mapping is body only (no fence) |
| [packages/matter-core/src/core/sqlite.test.ts](../../packages/matter-core/src/core/sqlite.test.ts) | 365 | Retain at triage | Representative behavior: drops then recreates: stem PK, one nullable column per field by storage class, _extra JSON, body |
| [packages/matter-core/src/core/table.test.ts](../../packages/matter-core/src/core/table.test.ts) | 104 | Retain at triage | Representative behavior: splits readable rows from unreadable files and lists raw columns |
| [packages/matter-core/src/core/view.test.ts](../../packages/matter-core/src/core/view.test.ts) | 287 | Retain at triage | Representative behavior: a board entry parses with its optional keys |
| [packages/matter-core/src/core/violations.test.ts](../../packages/matter-core/src/core/violations.test.ts) | 412 | Retain at triage | Representative behavior: a missing required cell is a missing-required violation |
| [packages/matter-core/src/field/field.test.ts](../../packages/matter-core/src/field/field.test.ts) | 459 | Retain at triage | Representative behavior: field.${kind} recognizes back as ${kind} and matches exactly one meta |
| [packages/matter-core/src/load/fs.test.ts](../../packages/matter-core/src/load/fs.test.ts) | 242 | Retain at triage | Representative behavior: reads a typed folder into a readable table named for its basename |
| [packages/matter-core/src/report/exit-code.test.ts](../../packages/matter-core/src/report/exit-code.test.ts) | 115 | Retain at triage | Representative behavior: 0 when every row is healthy |
| [packages/matter-core/src/report/format.test.ts](../../packages/matter-core/src/report/format.test.ts) | 106 | Retain at triage | Representative behavior: scalar kinds render their phrase |
| [packages/principal/src/device-owner.test.ts](../../packages/principal/src/device-owner.test.ts) | 44 | Retain at triage | Representative behavior: account identity encodes without case folding or separator collisions |
| [packages/recorder/src/vad-recorder.test.ts](../../packages/recorder/src/vad-recorder.test.ts) | 61 | Retain at triage | Representative behavior: failed VAD destruction stops tracks but retains ownership until a successful retry |
| [packages/server/evidence/enrollment/passkey-hooks.test.ts](../../packages/server/evidence/enrollment/passkey-hooks.test.ts) | 121 | Archive research | Reproduces rejected enrollment design; preserve shared authenticator fixture used by actual self-host tests. |
| [packages/server/evidence/scope-ownership/foundation.test.ts](../../packages/server/evidence/scope-ownership/foundation.test.ts) | 325 | Prune prototype cases | Keep first two live integration cases; remaining alternate ownership/initialization implementations are test-only. |
| [packages/server/src/auth/account-linking.test.ts](../../packages/server/src/auth/account-linking.test.ts) | 383 | Retain at triage | Representative behavior: ${path} accepts a fresh cookie with its expected principal |
| [packages/server/src/auth/base-config.test.ts](../../packages/server/src/auth/base-config.test.ts) | 84 | Retain at triage | Representative behavior: email/password is disabled and only Google is a trusted linking provider |
| [packages/server/src/auth/cookie-config.test.ts](../../packages/server/src/auth/cookie-config.test.ts) | 62 | Retain at triage | Representative behavior: localhost cookies are host-only, Lax, and non-secure |
| [packages/server/src/auth/create-auth.test.ts](../../packages/server/src/auth/create-auth.test.ts) | 74 | Trim one | Keep provider completeness gate; redundant Object.keys check adds little. |
| [packages/server/src/auth/instance-token.test.ts](../../packages/server/src/auth/instance-token.test.ts) | 44 | Retire with code | Static-token resolver has no current deployable caller; remove obsolete owner/export alongside tests, preserve socket fixture needs. |
| [packages/server/src/auth/oauth-resource.test.ts](../../packages/server/src/auth/oauth-resource.test.ts) | 43 | Retain at triage | Representative behavior: InvalidToken returns 401 with the invalid_token challenge |
| [packages/server/src/auth/parse-bearer.test.ts](../../packages/server/src/auth/parse-bearer.test.ts) | 19 | Retain at triage | Representative behavior: parseBearer extracts the token from a Bearer header |
| [packages/server/src/auth/plugins.test.ts](../../packages/server/src/auth/plugins.test.ts) | 96 | Retain at triage | Representative behavior: passkey authenticate options are mintable without a session |
| [packages/server/src/auth/session-handoff.postgres.test.ts](../../packages/server/src/auth/session-handoff.postgres.test.ts) | 390 | Retain at triage | Representative behavior: the fresh deployment baseline has direct session tables and no OAuth or JWKS tables |
| [packages/server/src/auth/session-handoff.test.ts](../../packages/server/src/auth/session-handoff.test.ts) | 302 | Retain at triage | Representative behavior: browser and native callbacks issue independent sessions without replacing the hosted cookie |
| [packages/server/src/auth/signed-session-socket.test.ts](../../packages/server/src/auth/signed-session-socket.test.ts) | 184 | Retain at triage | Representative behavior: an issued session opens the hosted socket and revocation refuses its next admission |
| [packages/server/src/create-cloud-context-middleware.test.ts](../../packages/server/src/create-cloud-context-middleware.test.ts) | 205 | Retain at triage | Representative behavior: public shells and unrelated 404s bypass failing acquisition and auth setup |
| [packages/server/src/middleware/cors.test.ts](../../packages/server/src/middleware/cors.test.ts) | 56 | Retain at triage | Representative behavior: a trusted origin is echoed back with credentials |
| [packages/server/src/middleware/rate-limit.test.ts](../../packages/server/src/middleware/rate-limit.test.ts) | 73 | Retain at triage | Representative behavior: allows up to the limit, then denies with a 429 OpenAI envelope |
| [packages/server/src/middleware/require-auth.test.ts](../../packages/server/src/middleware/require-auth.test.ts) | 166 | Retain at triage | Representative behavior: the explicit bearer selects Alice even with Bob cookies and returns no credential |
| [packages/server/src/middleware/require-origin-for-cookie-mutations.test.ts](../../packages/server/src/middleware/require-origin-for-cookie-mutations.test.ts) | 97 | Retain at triage | Representative behavior: CSRF guard rejects cookie-auth POST from a non-trusted origin |
| [packages/server/src/principal.test.ts](../../packages/server/src/principal.test.ts) | 42 | Retain at triage | Representative behavior: the resource segment is data, a sibling of blobs (ADR-0276) |
| [packages/server/src/routes/auth.test.ts](../../packages/server/src/routes/auth.test.ts) | 57 | Retain at triage | Representative behavior: sign-in serves the shell without redirecting arbitrary callback URLs |
| [packages/server/src/routes/blobs.test.ts](../../packages/server/src/routes/blobs.test.ts) | 222 | Retain at triage | Representative behavior: upload publishes actual bytes under a fresh ID and returns an owner-pinned URL |
| [packages/server/src/routes/inference.test.ts](../../packages/server/src/routes/inference.test.ts) | 224 | Retain at triage | Representative behavior: answers ProviderNotConfigured in the OpenAI error shape when no key is available |
| [packages/server/src/routes/session.test.ts](../../packages/server/src/routes/session.test.ts) | 45 | Retain at triage | Representative behavior: /api/session returns the principal projection |
| [packages/server/src/routes/transcription.test.ts](../../packages/server/src/routes/transcription.test.ts) | 162 | Retain at triage | Representative behavior: answers ProviderNotConfigured in the OpenAI error shape when no key is available |
| [packages/server/src/self-host-auth/bun.test.ts](../../packages/server/src/self-host-auth/bun.test.ts) | 132 | Retain at triage | Representative behavior: file-backed sessions and passkeys survive reopen while recovery and removal remain durable |
| [packages/server/src/self-host-auth/index.test.ts](../../packages/server/src/self-host-auth/index.test.ts) | 566 | Retain at triage | Representative behavior: registration requires its browser cookie and consumes the grant once |
| [packages/server/src/store-sync/browser-dial.test.ts](../../packages/server/src/store-sync/browser-dial.test.ts) | 262 | Retain at triage | Representative behavior: the browser offers the main subprotocol and the bearer, in that order |
| [packages/server/workers/account-deletion.test.ts](../../packages/server/workers/account-deletion.test.ts) | 128 | Retain at triage | Representative behavior: deletion refuses the explicit fresh principal without changing either account |
| [packages/server/workers/authorization-deadline.test.ts](../../packages/server/workers/authorization-deadline.test.ts) | 344 | Retain at triage | Representative behavior: grants exactly 600 seconds from admission and ignores request deadlines |
| [packages/server/workers/current-retirement.test.ts](../../packages/server/workers/current-retirement.test.ts) | 173 | Retain at triage | Representative behavior: a retained socket cannot finish an old partial submission after replacement |
| [packages/server/workers/e2e.test.ts](../../packages/server/workers/e2e.test.ts) | 235 | Retain at triage | Representative behavior: a note written on the phone arrives on the laptop, with its text |
| [packages/server/workers/generations.test.ts](../../packages/server/workers/generations.test.ts) | 102 | Retain at triage | Representative behavior: Personal selects the authenticated actor while Shared returns the same bytes to both actors |
| [packages/server/workers/initial-generation.test.ts](../../packages/server/workers/initial-generation.test.ts) | 161 | Retain at triage | Representative behavior: competing seeds return one canonical snapshot and retain it after eviction |
| [packages/server/workers/large-snapshot.test.ts](../../packages/server/workers/large-snapshot.test.ts) | 102 | Keep/trim | Keep real large transfer; digest-control self-test is optional. |
| [packages/server/workers/selfhost.test.ts](../../packages/server/workers/selfhost.test.ts) | 60 | Retain at triage | Representative behavior: named-session removal rejects further access while another admitted user retains Shared data |
| [packages/skills/src/skills.test.ts](../../packages/skills/src/skills.test.ts) | 205 | Retain at triage | Representative behavior: a stricter Skills workspace exposes nonconformance until an update repairs it |
| [packages/sqlite/src/adapters.test.ts](../../packages/sqlite/src/adapters.test.ts) | 168 | Retain at triage | Representative behavior: ${name}: writes, reads, and rollback share one contract |
| [packages/svelte/src/from-data.svelte.test.ts](../../packages/svelte/src/from-data.svelte.test.ts) | 430 | Rewrite/trim | Keep cache/projection identity; fake reactivity does not prove rendering and flush test accepts no-op. |
| [packages/svelte/src/from-subscription.svelte.test.ts](../../packages/svelte/src/from-subscription.svelte.test.ts) | 115 | Rewrite | No notification/unsubscribe observation; manual getter reads and subscribe count miss stated failures. |
| [packages/svelte/src/persisted-map.svelte.test.ts](../../packages/svelte/src/persisted-map.svelte.test.ts) | 117 | Rewrite one | Recovery reread uses identical memory/disk values; externally change storage before focus. |
| [packages/sync/src/auth-subprotocol.test.ts](../../packages/sync/src/auth-subprotocol.test.ts) | 44 | Retain at triage | Representative behavior: parseSubprotocols splits a comma-separated subprotocol header |
| [packages/sync/src/current-download.test.ts](../../packages/sync/src/current-download.test.ts) | 103 | Retain at triage | Representative behavior: a response owns its captured bytes and positions before its source changes |
| [packages/ui/src/confirmation-dialog/confirmation-dialog.test.ts](../../packages/ui/src/confirmation-dialog/confirmation-dialog.test.ts) | 230 | Retain at triage | Representative behavior: a rejected confirmation keeps input and becomes retryable |
| [packages/ui/src/natural-language-date-input/parse.test.ts](../../packages/ui/src/natural-language-date-input/parse.test.ts) | 80 | Retain at triage | Representative behavior: returns no suggestions for empty input |
| [scripts/check-api-paths.test.ts](../../scripts/check-api-paths.test.ts) | 113 | Reconcile stale case | OAuth path expectation fails against current API-only gate; clarify policy instead of restoring retired route. |
| [scripts/check-doc-hygiene.test.ts](../../scripts/check-doc-hygiene.test.ts) | 158 | Retain at triage | Representative behavior: clean repo (Draft spec, no ADRs) passes |
| [scripts/check-doc-paths.test.ts](../../scripts/check-doc-paths.test.ts) | 228 | Retain at triage | Representative behavior: living doc passes when backticked repo path exists |
| [scripts/check-vocabulary.test.ts](../../scripts/check-vocabulary.test.ts) | 213 | Retain at triage | Representative behavior: the settled words pass |
| [scripts/whispering-startup.test.ts](../../scripts/whispering-startup.test.ts) | 88 | Replace | Four cases import deleted bootstrap.ts; re-establish saved-library and captured-Account coverage through the actual route. |
