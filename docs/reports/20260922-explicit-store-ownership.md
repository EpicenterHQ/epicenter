# Explicit Local and Personal ownership

The implemented boundary is `openLocal(definition)` and
`openPersonal(definition, { account })`, exported from `@epicenter/app/open`.
One private opener owns document admission and cleanup. Personal captures its
account identity and transport before asynchronous work. Local has no account
option. Each handle closes independently and exposes its ID as `definition.id`.
No Shared opener, transfer operation, storage migration, or route migration was
implemented.

The user revised the task to prioritize API consistency and defer Whispering
migration, including accepting a broken product build. App now composes Local
with SQL, secrets, recording, blobs, and AI. Its account supplies remote
capabilities; it never acquires Personal. `app.account.personal` is removed.
Local rows, SQL, secrets, recording output, and audio remain in the no-account
namespace across account changes. Custom inference configuration remains
account-scoped. A native upload reads Local audio while its captured account
authorizes the remote destination.

## Baseline and preservation

Before editing, the task recorded `git status --short --branch`,
`git diff --name-status`, `git ls-files --others --exclude-standard`, and a binary
patch in `/tmp/epicenter-store-boundary-baseline/`. That directory contains the
original dirty-file inventory, reconstructed contents, and verification logs.
The initial branch was ahead 45 and behind 1; concurrent work advanced HEAD
during this task. This task performed no Git staging or history operations.

Whispering route/context work from the original plan was removed after the scope
revision. All 41 checked Whispering files exactly match the task-start snapshot.
Existing unrelated dirty work remains. The small native-server source change
preserves the preexisting SQLite logging edit. The existing untracked `fromApp`
adapter was updated to adapt Local only; standalone Personal uses `fromData`.

## Adversarial checkpoints

Two independent read-only Codex reviewers challenged API structure and lifecycle
correctness before implementation, after the store primitive, and after the
scope revision and cumulative collapse. The route checkpoint was replaced by
API review because route migration was explicitly deferred.

Accepted findings and changes:

- Keep two semantic public openers and one private acquisition implementation.
  The deletion prize is duplicated ownership logic without exposing generic
  owner configuration to product callers.
- StoreRuntime supplies only claims and document backing. The document engine
  retains persistence, retirement, and cleanup ownership.
- Keep established document claim keys to exclude duplicate writers. App's
  separate capability claim remains until all capability cleanup succeeds.
- Preserve guarded property descriptors when borrowing Local for App. Spreading
  the store would evaluate its guarded accessors and lose their close checks.
- Local audio must follow Local rows. The native upload broker now reads the
  no-account source; tests plant conflicting account-local bytes to prove it.
- Remove automatic Personal opening, bootstrap, and retirement coupling from
  App. Personal failure or retirement cannot stop Local recording.
- Delete duplicate store IDs, App scope construction, media-owner switches,
  upload-source headers, the reverse Local-to-App retirement listener, and the
  account options on App's secret and recorder factories.

One suggested deletion was declined: App's abort-to-Local close listener fences
borrowed data before consumer App abort listeners run. The normal cleanup queue
runs after that notification. The reentrant-close test now checks that Local
reads already refuse inside a consumer abort handler.

The final reviewers found no remaining ownership blocker. The two claims and
descriptor-preserving borrowed handle still own concrete invariants.

## Verification

- `bun test --isolate packages/app/src`: 712 passed. A final targeted lifecycle
  rerun after the abort-handler assertion passed 9 tests.
- Native account transport and device claim tests: 18 passed.
- Svelte data/App adapter tests: 17 passed; Svelte package typecheck passed.
- Chromium and WebKit admission probes passed duplicate refusal, handoff,
  retained data, failed-cleanup exclusion, page-teardown release, 50 immediate
  reopenings, 50 reloads, and runtime isolation.
- App's data, DOM, and four evidence typecheck configurations passed separately.
- App's main typecheck remains blocked by the recorded baseline error in
  `src/data/definition/compile.test.ts:92`: an unbranded table declaration.
- Whispering typecheck reports 28 errors in 14 files: the recorded baseline
  blob generic error plus the deliberately unmigrated Personal API callers and
  resulting inference errors. No passing product integration is claimed.
- `git diff --check` passed.

## Remaining work and limits

Products must explicitly compose Personal and decide which surfaces require it.
Whispering route gates, its recording destination policy, and an explicit
save-to-Personal or sharing action remain product work. Shared data and audio
sharing semantics remain undecided; no Shared API is exposed.

Historical account-local bytes are untouched. This change neither adopts nor
migrates them into Local. Existing document locks exclude older document writers,
but the new App capability claim is unknown to old versions. Old windows must
close at version cutover before using the new API. Cross-version capability
coexistence is not promised.
