# 0391. The build selects every implementation, and an application declares only its id and data

- **Status:** Accepted
- **Date:** 2026-09-12
- **Amended by:** [ADR-0408](0408-one-app-opener-uses-a-complete-runtime.md) permits a complete runtime at App opening while retaining build-selected defaults and inert declarations. The runtime injection amendment is unbuilt.
- **Amended by:** [ADR-0405](0405-one-flat-application-declaration-opens-the-live-app.md) at the declaration shape: one flat `defineApp({ id, title, kv, tables })` replaces the nested application/data pair.
- **Proposed follow-ups:** [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) proposes replacing build conditions with runtime selection. [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) proposes a host capability grant independent of window labels. Neither proposal changes the accepted selector here.
- **Implementation checkpoint, 2026-09-18:** The package selects resources, AI, and clipboard leaves through `epicenter-host` and default conditions. ADR-0407 makes the declaration platform-free and moves acquisition to `/open`; explicit `runtime` and `ai` options and Whispering's `#platform/runtime` seam are removed. `settingsKey` is removed. ADR-0405 implements the flat declaration; ADR-0404 implements account-owned local storage. ADR-0403's runtime selector remains unbuilt. No storage-prefix migration is implied by this checkpoint.

## Context

Three mechanisms select implementations for one handle. The build condition
selects sqlite, secrets, and the clipboard through `#platform/*` seams. The
`runtime` option selects blobs and recording. The `ai` binding selects
inference. Only Whispering passes `runtime` or `ai`, and what it passes is
not what the package would have chosen: its host leaves supply the host blob
store, desktop recording, and a native inference transport, while the
package's own host leaves supply browser blobs, browser recording, and no
runtime transport. Whispering's seams exist because the package's host leaves
are incomplete.

The default runtime is `{ ...browser, ...resources }`, where `browser` is a
static import. In a host build the spread swaps sqlite and secrets for the
host's and leaves blobs and recording as the browser's. So every application
except Whispering constructs a WebView-origin IndexedDB blob store in the
host, outside the Epicenter data root, invisible to the host's staging sweep
and per-principal erase. No standard app declares a blob field today, so
those stores hold nothing, and the first attachment any of them adds would
land in the wrong place. Every host bundle also carries browser blob code it
never runs. The generic trusted app-window capability already grants every
window the native recording commands, so the `runtime` opt-in guards nothing.

`settingsKey` reaches one thing, the AI storage-key prefix. Honeycrisp and
Vocab pass it (`'honeycrisp'`, `'vocab'`) to keep a pre-app-id namespace.
Whispering does not pass it; its prefix `'whispering'` is a literal in its own
AI seam. The desktop catalog dedupes one-time imports by a source string that
contains the prefix, and the inference selections key is a separate argument
built from the same prefix.

## Decision

**`defineApplication({ appId, definition })` is the whole declaration, and a
`#platform/*` seam inside `@epicenter/app` selects every implementation.**

A `#platform/runtime` seam selects blobs and recording the way
`#platform/resources` selects sqlite and secrets. The package's `#platform/ai`
host leaf supplies the native inference transport that Whispering's seam
supplies today. In a host build every application stores blobs on disk under
the host's data root at `apps/<app-id>/local/blobs` or
`apps/<app-id>/accounts/<authority>/<principal>[/shared]/blobs`, the layout
Whispering already uses.

The `runtime` and `ai` options and `settingsKey` are deleted. The AI storage
prefix is the app id for every application.

## Consequences

- `ApplicationRuntime`, `AppBlobFactory`, and the `/browser` and
  `/epicenter-host` exports of `@epicenter/app` are deleted, with the
  import-time SQLite owner construction they carried.
- Whispering's `#platform/runtime` and `#platform/ai` seams are deleted.
- Tests that pass a custom `runtime` to substitute sqlite and blobs doubles
  lose that option; they mock the seam, as Whispering's boot-failure test
  already does, or open the store directly.
- `packages/app/README.md` changes wherever it describes runtime selection,
  `settingsKey`, the `${settingsKey}` storage keys, and the host AI
  composition helpers, and its caveat that TypeScript cannot prove a custom
  runtime publishes recordings into the blob store it exposes is deleted; the
  seam pairs them by construction.
- The storage prefix changes for Honeycrisp, Vocab, and Whispering. No
  migration exists: `migrate-ai-settings.ts` renames key shapes inside one
  prefix, not the prefix. The change ships only with a prefix migration that
  also covers the inference selections key and the desktop catalog's import
  dedupe source.
- ADR-0366's sentence "Application composition selects a browser or desktop
  implementation" is edited in place to "the build selects", since that
  record is Proposed.
- ADR-0304 fixes a desktop layout without a blob branch; the blob layout here
  is the one the host writes today and ADR-0349 describes. Reconciling 0304 is
  separate work.

## Considered alternatives

- **Keep `runtime` so a standard app in a host WebView can prefer browser
  storage.** No code depends on that preference, no standard app declares a
  blob field, and the README sentence that claims it describes the default,
  not a decision. Refused.
- **Keep `ai` for apps that want no inference.** Absence is already expressed
  by the binding's nullable members, and no app passes a null binding. Refused.
- **Keep `settingsKey` to avoid the migration.** Three apps would carry a
  second name for their id forever to avoid one migration. Refused.
