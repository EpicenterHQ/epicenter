# Whispering fixed-owner review, 2026-09-21

## Files read

The edited-file inventory below precedes the review. Additional source and
guidance consulted follow it. Unrelated worktree changes are excluded.

```text
|-- apps
|   `-- whispering
|       |-- scripts
|       |   `-- audio-player.browser.mjs
|       `-- src
|           |-- lib
|           |   |-- components
|           |   |   |-- OutputDeliveryControls.svelte
|           |   |   |-- RecipePicker.svelte
|           |   |   `-- settings
|           |   |       |-- SettingSwitch.svelte
|           |   |       `-- TranscriptionRuntimeConfig.svelte
|           |   |-- operations
|           |   |   |-- analytics.ts
|           |   |   |-- delivery.ts
|           |   |   |-- media.ts
|           |   |   |-- pipeline.test.ts
|           |   |   |-- pipeline.ts
|           |   |   |-- recording.svelte.ts
|           |   |   |-- run-polish.test.ts
|           |   |   |-- run-polish.ts
|           |   |   |-- run-recipe.ts
|           |   |   |-- settings.ts
|           |   |   |-- sound.ts
|           |   |   |-- transcribe.test.ts
|           |   |   `-- transcribe.ts
|           |   |-- shortcuts
|           |   |   `-- focused.ts
|           |   |-- state
|           |   |   |-- README.md
|           |   |   |-- capture-surface.svelte.ts
|           |   |   `-- polish.ts
|           |   `-- whispering
|           |       |-- app.test.ts
|           |       |-- app.ts
|           |       |-- context.ts
|           |       |-- inference.test.ts
|           |       |-- recipes.ts
|           |       `-- ui-session.ts
|           `-- routes
|               `-- (app)
|                   |-- (config)
|                   |   |-- debug
|                   |   |   `-- +page.svelte
|                   |   |-- recipes
|                   |   |   `-- +page.svelte
|                   |   |-- recordings
|                   |   |   |-- +page.svelte
|                   |   |   `-- actions
|                   |   |       `-- TranscribeRecordingButton.svelte
|                   |   `-- settings
|                   |       |-- +layout.svelte
|                   |       |-- analytics
|                   |       |   `-- +page.svelte
|                   |       |-- dictation
|                   |       |   `-- +page.svelte
|                   |       |-- recording
|                   |       |   `-- +page.svelte
|                   |       `-- sound
|                   |           `-- +page.svelte
|                   `-- _components
|                       |-- CaptureBehaviorPopover.svelte
|                       `-- WhisperingShell.svelte
|-- docs
|   `-- adr
|       `-- 0373-product-operations-receive-their-resource-handles-explicitly.md
`-- packages
    `-- svelte
        |-- README.md
        `-- src
            |-- from-data.svelte.test.ts
            |-- index.ts
            `-- from-app.svelte.ts
```

Additional evidence read in full or in relevant excerpts:

```text
.agents/skills/
|-- consult-claude/SKILL.md
|-- design-review/SKILL.md
|-- greenfield-clean-breaks/SKILL.md
|-- post-implementation-review/SKILL.md
|-- refactoring/SKILL.md
|-- svelte/SKILL.md
|-- svelte/references/component-ui-patterns.md
|-- svelte/references/lifecycle-and-reactivity.md
|-- testing/SKILL.md
`-- typescript/SKILL.md
apps/whispering/
|-- AGENTS.md
|-- README.md
|-- package.json
`-- src/
    |-- lib/components/LibrarySelection.svelte
    |-- lib/data.ts
    |-- lib/platform/auth.browser.ts
    |-- lib/services/index.ts
    |-- lib/services/download/index.browser.ts
    |-- lib/services/download/types.ts
    `-- routes/(app)/+layout.svelte
packages/
|-- app/src/
|   |-- open.ts
|   |-- scopes.test.ts
|   |-- blob-retirement.test.ts
|   `-- data/
|       |-- field/field.ts
|       `-- store/store.ts
|-- app-shell/src/persistence-notice/persistence-notice.svelte
|-- auth/src/
|   |-- browser-redirect-auth.ts
|   |-- create-session-auth.ts
|   `-- persisted-auth-storage.ts
|-- blobs/src/browser.ts
`-- svelte/
    |-- package.json
    `-- src/
        |-- from-data.svelte.ts
        `-- from-kv.svelte.ts
package.json
bun.lock
```

## Implemented decision

Both App stores are reactive. Each settings or recipe caller names its fixed
owner. Account absence controls availability, never a fallback destination.

| Data | Owner |
| --- | --- |
| Sounds, shortcuts, delivery, recording behavior, model selections, language, analytics | `app.device.kv` |
| Dictionary, Polish instructions, transcription prompt | `app.account.personal.kv` |
| Custom recipes | `app.account.personal.tables.recipes` |
| Recording history | Pending product decision; existing selected store retained |

`getSetting` and storage-aware `SettingSwitch` behavior are removed. Controls
receive values and callbacks. `DEVICE_DEFAULTS` and `PERSONAL_DEFAULTS` replace
the combined defaults map. Reset remains device-only.

`app.account` now means the framework account scope. `authAccount` holds the
captured authentication capability used by Add credits links. The document
still owns the App lifetime, and the UI session owns recording and queries.

The only added production module is the small `fromApp` adapter:

```text
Before                         After
packages/svelte/src/           packages/svelte/src/
|-- from-data.svelte.ts        |-- from-app.svelte.ts
|-- from-kv.svelte.ts          |-- from-data.svelte.ts
`-- index.ts                  |-- from-kv.svelte.ts
                              `-- index.ts
```

## Review findings and adjudication

Claude reviewed the current sources read-only through the consult-claude skill,
session `9a36fcef-48d9-4e02-9bd1-31ac4ff29053`. The consultation completed with
`is_error: false`, no permission denials, and no child agents. Claude could not
execute Git or tests; Codex owns diff inspection and verification.

- Accepted: resetting personal KV from the general settings button expanded
  its destructive reach. Removed that write and corrected the dialog copy.
- Accepted: the first `fromApp` implementation added an unnecessary root cache,
  freezing, casts, and descriptor copying. Removed them. `fromData` already
  caches each store projection. The adapter test now checks actual store and
  capability preservation rather than an invented root-getter requirement.
- Accepted: old device-authored content would become invisible. The shell now
  offers a JSON download before sign-in or account departure. This is manual
  recovery, not automatic import, synchronization, or a fallback read path.
- Accepted: separate defaults make owner intent easier to review. They do not
  enforce storage ownership in TypeScript: both stores still share a schema.
- Accepted: avoid writing an unchanged transcription prompt on blur. Removed
  redundant dictionary fallback steps and unnecessary shortcut-array casts.
- Rejected: hiding `close` behind another restricted App wrapper. No current
  caller misuses it, and preserving the raw framework API is the requested
  direction. Bootstrap remains its designated owner.
- Retained: `fromApp` as the requested framework adapter. It now only composes
  the two existing projections. No selector, policy map, or new lifecycle.
- Retained: context distributes a ready document-owned instance. Recording
  admission, captured inference targets, and query disposal still have real
  lifecycle responsibilities; replacing them with global publication would
  reintroduce ordering and retained-owner problems.

## Remaining decisions and limits

1. Choose recording history's permanent owner. Always-device preserves
   signed-out capture. Always-personal requires an account for the current
   save-and-transcribe workflow. No answer has been inferred from elapsed time.
   Once settled, delete `app.library`, `LibrarySelection.svelte`, the persisted
   selection, the selector/reload flow, and the `data` prop through shell/session.
2. Dictionary is one KV array. `store.ts` updates it with `setAttr`, so concurrent
   term additions replace the field rather than merging per term. A table with
   one row per term is the structural next step if that guarantee is required.
3. Both stores share one declaration. Ownership is explicit at call sites and
   tested with conflicting values, but the compiler still permits wrong-store
   writes. Scope-specific schemas would strengthen the invariant and avoid
   projecting unused tables. That is a framework decision, not another router.
4. Previous content recovery requires manual copying from the downloaded JSON.
   Signed-out and signed-in device stores remain different account partitions.
5. `saveRecipe` has one editor caller, and its built-in-copy branch has no
   reachable editor action today. Inline it into that editor or add the intended
   copy action when that product behavior is decided. The shared recipe-list
   function earns its boundary through its two consumers and ordering policy.

Both stores are projected eagerly once per raw identity. The existing store
cache prevents repeated subscriptions. No performance claim about large
unused recording tables was measured.

Auth hydration is synchronous on the inspected browser path: persisted storage
reads `localStorage` into `initial`, and session construction creates its account
attachment before returning. No new async readiness layer was added.

## Verification

- 282 tests passed, 895 assertions, across Whispering, the Svelte adapters,
  app-shell, and Vocab.
- Chromium and WebKit passed independent device/personal KV reactivity plus
  playback identity and disposal checks.
- `@epicenter/svelte` typecheck passed with zero errors or warnings.
- Whispering browser typecheck reports one error in untouched
  `packages/blobs/src/browser.ts:214`: the `put` implementation can return
  `BlobAlreadyExists`, while its declared result permits only `BlobStoreFailed`.
  The host check also reported this error. Those blob files have no diff from
  `07f1a16a68`; a clean baseline typecheck was not run, so attribution remains
  unverified. This work is not being presented as a green whole-repository build.
- `git diff --check` passed for this work.

No new commit, staging, deployment, or automatic data migration was performed.
