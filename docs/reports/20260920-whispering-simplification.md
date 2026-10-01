# Whispering simplification: execution and review

The UI now reads the selected library through `fromData` and device settings
through `fromKv`. Operations receive their owner explicitly. Whispering stores
connection/model pairs in device KV, and the shared picker accepts a value and a
callback. Chat owns the separate policy for matching local targets to synced
conversation models.

The ready context remains because it distributes the selected data and owns
recording and query lifetimes. No global App registry, `app.inference` façade,
or `fromApp` adapter was added.

## Final evidence

- `bun run typecheck`: passed across the repository, including both Whispering targets and scripts.
- `bun test --isolate apps/whispering/src/lib packages/svelte/src/from-data.svelte.test.ts packages/app-shell/src apps/vocab/src`: 280 passed, 0 failed, 878 assertions.
- `bun packages/app-shell/scripts/inference-picker.browser.mjs`: passed pending/failed saves, hidden credentials, cross-window changes, and suppression of late selections.
- `bun packages/app/scripts/ai-connections.browser.mjs`: passed in Chromium and WebKit, including account isolation, restored selections, retired handles, and legacy-byte retention.
- `bun apps/whispering/scripts/audio-player.browser.mjs`: passed in Chromium and WebKit. Metadata edits preserve playback; changing audio references, disabling playback, and late acquisition release sources correctly.
- `git diff --check`: passed.
- `bun scripts/check-doc-hygiene.ts`: 60 flags. Reading the same files from task-start commit `2517a1552f0dc6b6bedceb187f9376e6eb748a00` produced 59. The additional flag is revised ADR-0373: its implementation is complete and its status remains Proposed under the repository's explicit acceptance rule. No unrelated ADR statuses were changed.

The picker browser harness originally timed out before loading its acceptance
component because Vite invalidated newly discovered dependencies. Declaring its
generated entry fixed cold-cache loading. The second browser harness also now
declares the source entries used by its generated page and dynamic device-config
import. Neither harness uses a retry or sleep to mask loading failures.

Native microphone capture and a full Tauri product boot were not exercised.
Explicit disposal removed the new importer's dependency on browser support for
`using` syntax.

## Final review decisions

Claude reviewed each checkpoint through the repository's consult-claude skill.
The checkpoint reviews accepted the ownership design. The staging review below
found additional defects and cleanup opportunities. Codex verified the findings and applied these repairs:

- Replaced the importer's `using` declaration with `try/finally` disposal.
- Rejected empty legacy model choices, with a regression test.
- Kept legacy bytes intentionally intact so a crash before KV persistence can retry.
- Renamed the one-line resolvers to `resolveTranscriptionTarget` and `resolveCompletionTarget`, and removed a duplicate target read during capture.
- Updated the remaining browser resolver caller and the constants comment.

The migration imports only when a connection key is absent. Explicit null means
initialized or reset, so reopening cannot resurrect a reset choice. An unavailable
connection ID stays unavailable. A legacy model mismatch becomes unselected,
which means audio-only recording until a transcription target is chosen. The
previous implicit completion default is captured explicitly only when it matches
a legacy choice. New installations start with no completion destination.

Further work is separate from this collapse: retire the importer when pre-KV
upgrades cease to be supported, consider removing obsolete chat selections when
conversations are deleted, and consider capturing Polish inputs once per pass.
The review also mentioned shared picker manual-model input state; it was not
rechecked in the final review and remains an unverified cleanup suggestion.

Baseline: `2517a1552f0dc6b6bedceb187f9376e6eb748a00`. Existing Epicenter/Local Mail edits and reports are outside this task.

## Checkpoint 1: explicit operation ownership

Operations receive the ready app explicitly. The module-global application registry and its mocks are removed. Completion uses the existing reactive settings and connection reads instead of another subscription layer.

Validation: both Whispering typecheck targets passed; 45 focused tests passed. App-shell and Vocab baseline typechecks also passed.

Edited files:

- `apps/whispering/src/lib/application.test.ts` (deleted)
- `apps/whispering/src/lib/application.ts` (deleted)
- `apps/whispering/src/lib/boot-node.test.ts`
- `apps/whispering/src/lib/components/RecipePicker.svelte`
- `apps/whispering/src/lib/components/settings/CompletionRuntimeConfig.svelte`
- `apps/whispering/src/lib/operations/completion.test.ts`
- `apps/whispering/src/lib/operations/completion.ts`
- `apps/whispering/src/lib/operations/pipeline.test.ts`
- `apps/whispering/src/lib/operations/pipeline.ts`
- `apps/whispering/src/lib/operations/run-polish.test.ts`
- `apps/whispering/src/lib/operations/run-polish.ts`
- `apps/whispering/src/lib/operations/run-recipe.ts`
- `apps/whispering/src/lib/operations/settings.ts`
- `apps/whispering/src/lib/operations/transcribe.test.ts`
- `apps/whispering/src/lib/operations/transcribe.ts`
- `apps/whispering/src/lib/state/completion.svelte.ts`
- `apps/whispering/src/lib/state/polish.svelte.ts`
- `apps/whispering/src/routes/(app)/(config)/settings/dictation/+page.svelte`
- `apps/whispering/src/routes/(app)/_components/PolishStatusLink.svelte`
- `apps/whispering/src/routes/(app)/_components/WhisperingShell.svelte`

Design review: Claude found no blockers. Accepted: remove the remaining completion-label wrapper in checkpoint 2 and expose the existing KV adapter so settings do not project an undisplayed local library. Retained: one ready context and exact destination resolution. Full Whispering library suite: 169 passed.

## Checkpoint 2: direct reactive data

Device preferences use fromKv and getSetting; the selected library uses fromData. Recording and recipe reads use tables directly. Pure functions retain audio IO and built-in recipe copying. Removed the settings/domain caches, their observers/disposers, redundant Recording alias, and unused syncStatus forwarding.

Validation: Whispering both targets and packages/svelte typecheck passed. 185 tests passed across Whispering and the Svelte adapter.

Edited files since checkpoint 1:

- `apps/whispering/src/lib/components/AudioBlobPlayer.svelte`
- `apps/whispering/src/lib/components/OutputDeliveryControls.svelte`
- `apps/whispering/src/lib/components/RecipePicker.svelte`
- `apps/whispering/src/lib/components/TranscriptionModelPicker.svelte`
- `apps/whispering/src/lib/components/settings/CompletionRuntimeConfig.svelte`
- `apps/whispering/src/lib/components/settings/SettingSelect.svelte`
- `apps/whispering/src/lib/components/settings/SettingSwitch.svelte`
- `apps/whispering/src/lib/components/settings/TranscriptionRuntimeConfig.svelte`
- `apps/whispering/src/lib/data.ts`
- `apps/whispering/src/lib/operations/analytics.ts`
- `apps/whispering/src/lib/operations/completion.test.ts`
- `apps/whispering/src/lib/operations/completion.ts`
- `apps/whispering/src/lib/operations/delete-recordings.ts`
- `apps/whispering/src/lib/operations/delivery.ts`
- `apps/whispering/src/lib/operations/import.test.ts`
- `apps/whispering/src/lib/operations/media.ts`
- `apps/whispering/src/lib/operations/pipeline.test.ts`
- `apps/whispering/src/lib/operations/pipeline.ts`
- `apps/whispering/src/lib/operations/recording-close.test.ts`
- `apps/whispering/src/lib/operations/recording.svelte.test.ts`
- `apps/whispering/src/lib/operations/recording.svelte.ts`
- `apps/whispering/src/lib/operations/run-polish.test.ts`
- `apps/whispering/src/lib/operations/run-polish.ts`
- `apps/whispering/src/lib/operations/run-recipe.ts`
- `apps/whispering/src/lib/operations/save-audio-recording.ts`
- `apps/whispering/src/lib/operations/settings.ts`
- `apps/whispering/src/lib/operations/sound.ts`
- `apps/whispering/src/lib/operations/transcribe.test.ts`
- `apps/whispering/src/lib/operations/transcribe.ts`
- `apps/whispering/src/lib/operations/transcription-history.test.ts`
- `apps/whispering/src/lib/operations/transcription-history.ts`
- `apps/whispering/src/lib/operations/upload-recording.test.ts`
- `apps/whispering/src/lib/operations/upload-recording.ts`
- `apps/whispering/src/lib/queries/audio.ts`
- `apps/whispering/src/lib/queries/download.test.ts`
- `apps/whispering/src/lib/queries/download.ts`
- `apps/whispering/src/lib/queries/transcription.test.ts`
- `apps/whispering/src/lib/queries/transcription.ts`
- `apps/whispering/src/lib/settings/transcription-validation.ts`
- `apps/whispering/src/lib/shortcuts/focused.ts`
- `apps/whispering/src/lib/state/README.md`
- `apps/whispering/src/lib/state/capture-surface.svelte.ts`
- `apps/whispering/src/lib/state/completion.svelte.ts` (deleted)
- `apps/whispering/src/lib/state/polish.svelte.ts` (deleted)
- `apps/whispering/src/lib/state/polish.ts`
- `apps/whispering/src/lib/state/recipes.svelte.ts` (deleted)
- `apps/whispering/src/lib/state/recordings.svelte.ts` (deleted)
- `apps/whispering/src/lib/state/settings.svelte.ts` (deleted)
- `apps/whispering/src/lib/whispering/app.test.ts`
- `apps/whispering/src/lib/whispering/app.ts`
- `apps/whispering/src/lib/whispering/context.ts`
- `apps/whispering/src/lib/whispering/recipes.svelte.ts` (deleted)
- `apps/whispering/src/lib/whispering/recipes.ts`
- `apps/whispering/src/lib/whispering/recording.ts` (deleted)
- `apps/whispering/src/lib/whispering/recordings-markdown-export.test.ts`
- `apps/whispering/src/lib/whispering/recordings-markdown-export.ts`
- `apps/whispering/src/lib/whispering/recordings.test.ts`
- `apps/whispering/src/lib/whispering/recordings.ts`
- `apps/whispering/src/lib/whispering/ui-session.ts`
- `apps/whispering/src/routes/(app)/(config)/debug/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/recipes/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/RecordingAudioCell.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/RecordingDetailModal.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/RecordingTranscriptCell.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/TranscriptionStatusBadge.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/actions/DownloadRecordingButton.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/actions/RecordingRowActions.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/actions/TranscribeRecordingButton.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/actions/UploadRecordingButton.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/+layout.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/analytics/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/dictation/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte`
- `apps/whispering/src/routes/(app)/+page.svelte`
- `apps/whispering/src/routes/(app)/_components/PolishStatusLink.svelte`
- `packages/svelte/README.md`
- `packages/svelte/src/from-data.svelte.test.ts`
- `packages/svelte/src/from-data.svelte.ts`
- `packages/svelte/src/from-kv.svelte.ts`
- `packages/svelte/src/index.ts`

Design review: accepted by Claude with no blockers.

Checkpoint 2 Claude review: accepted, no blockers. Retained fromKv and plain operation functions. Next checkpoint removes redundant shell projection and inference wrappers. Legacy import uses existing storage owner only during import, checks raw undefined versus explicit null, preserves unavailable references, and does not delete legacy bytes before KV durability. A legacy model mismatch becomes an unselected workflow (audio-only for transcription).

## Checkpoint 3: explicit inference targets

279 tests pass across Whispering, shared Svelte, app-shell, and Vocab. Both Whispering targets, app-shell, and Vocab typecheck. Browser picker acceptance passes with fresh-cache discovery fixed and catalog-replacement race covered. Final design review accepted the design and required explicit browser-safe disposal; that repair is complete.

Edited files since checkpoint 2 (52):

- apps/vocab/README.md
- apps/vocab/src/lib/state/inference-connections.svelte.ts (deleted)
- apps/vocab/src/lib/surface.ts
- apps/vocab/src/routes/components/ConversationView.svelte
- apps/vocab/src/routes/components/VocabShell.svelte
- apps/whispering/ARCHITECTURE.md
- apps/whispering/src/lib/boot-node.test.ts
- apps/whispering/src/lib/components/TranscriptionModelPicker.svelte
- apps/whispering/src/lib/components/settings/CompletionRuntimeConfig.svelte
- apps/whispering/src/lib/data.ts
- apps/whispering/src/lib/operations/completion.test.ts
- apps/whispering/src/lib/operations/completion.ts
- apps/whispering/src/lib/operations/run-polish.test.ts
- apps/whispering/src/lib/operations/run-polish.ts
- apps/whispering/src/lib/operations/save-audio-recording.ts
- apps/whispering/src/lib/operations/settings.ts
- apps/whispering/src/lib/operations/transcribe.test.ts
- apps/whispering/src/lib/operations/transcribe.ts
- apps/whispering/src/lib/settings/transcription-validation.ts
- apps/whispering/src/lib/shortcuts/focused.ts
- apps/whispering/src/lib/state/README.md
- apps/whispering/src/lib/state/inference-connections.svelte.ts (deleted)
- apps/whispering/src/lib/state/polish.ts
- apps/whispering/src/lib/whispering/app.ts
- apps/whispering/src/lib/whispering/inference.test.ts
- apps/whispering/src/lib/whispering/inference.ts
- apps/whispering/src/lib/whispering/recipes.ts
- apps/whispering/src/lib/whispering/recordings.test.ts
- apps/whispering/src/lib/whispering/recordings.ts
- apps/whispering/src/lib/whispering/ui-session.ts
- apps/whispering/src/routes/(app)/(config)/recipes/+page.svelte
- apps/whispering/src/routes/(app)/+page.svelte
- apps/whispering/src/routes/(app)/_components/WhisperingShell.svelte
- docs/adr/0363-an-inference-selection-identifies-the-connection-and-model.md
- docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md
- docs/adr/0373-product-operations-receive-their-resource-handles-explicitly.md
- docs/adr/README.md
- packages/app-shell/package.json
- packages/app-shell/scripts/inference-picker.browser.mjs
- packages/app-shell/src/agent-chat/agent-chat-thread.svelte
- packages/app-shell/src/agent-chat/agent-chat.svelte.test.ts
- packages/app-shell/src/agent-chat/agent-chat.svelte.ts
- packages/app-shell/src/inference-picker/catalog.svelte.ts
- packages/app-shell/src/inference-picker/catalog.test.ts
- packages/app-shell/src/inference-picker/connections.svelte.ts (deleted)
- packages/app-shell/src/inference-picker/connections.test.ts (deleted)
- packages/app-shell/src/inference-picker/cross-device-model-gap.svelte
- packages/app-shell/src/inference-picker/index.ts
- packages/app-shell/src/inference-picker/inference-picker.svelte
- packages/app-shell/src/inference-selections.ts
- packages/app-shell/src/inference-target.ts
- packages/svelte/src/from-data.svelte.test.ts

## Final repairs after checkpoint 3

The importer and its test, the two operation resolvers and their consumers, the
existing browser acceptance script, and the constants comment received the
repairs above. All code checks were rerun after those repairs. The final inventory
below includes these files and the staging review repairs. No commit was created.

## Staging review: full reread

The initial cumulative review read all 115 supplied task file bodies, including
the baseline bodies of deleted files. No supplied body was skipped. The tree
below records the expanded staging scope, including the repairs and ADR link
updates. Findings were shown before editing; the repaired sources were reread.

### File inventory before analysis

121 paths, including both sides of deletions and renames:

```text
.
|-- apps
|   |-- vocab
|   |   |-- README.md
|   |   `-- src
|   |       |-- lib
|   |       |   |-- state
|   |       |   |   `-- inference-connections.svelte.ts
|   |       |   `-- surface.ts
|   |       `-- routes
|   |           `-- components
|   |               |-- ConversationView.svelte
|   |               `-- VocabShell.svelte
|   `-- whispering
|       |-- ARCHITECTURE.md
|       |-- scripts
|       |   `-- audio-player.browser.mjs
|       `-- src
|           |-- lib
|           |   |-- application.test.ts
|           |   |-- application.ts
|           |   |-- boot-node.test.ts
|           |   |-- components
|           |   |   |-- AudioBlobPlayer.svelte
|           |   |   |-- OutputDeliveryControls.svelte
|           |   |   |-- RecipePicker.svelte
|           |   |   |-- TranscriptionModelPicker.svelte
|           |   |   `-- settings
|           |   |       |-- CompletionRuntimeConfig.svelte
|           |   |       |-- SettingSelect.svelte
|           |   |       |-- SettingSwitch.svelte
|           |   |       `-- TranscriptionRuntimeConfig.svelte
|           |   |-- data.ts
|           |   |-- operations
|           |   |   |-- analytics.ts
|           |   |   |-- completion.test.ts
|           |   |   |-- completion.ts
|           |   |   |-- delete-recordings.ts
|           |   |   |-- delivery.ts
|           |   |   |-- import.test.ts
|           |   |   |-- media.ts
|           |   |   |-- pipeline.test.ts
|           |   |   |-- pipeline.ts
|           |   |   |-- recording-close.test.ts
|           |   |   |-- recording.svelte.test.ts
|           |   |   |-- recording.svelte.ts
|           |   |   |-- run-polish.test.ts
|           |   |   |-- run-polish.ts
|           |   |   |-- run-recipe.ts
|           |   |   |-- save-audio-recording.ts
|           |   |   |-- settings.ts
|           |   |   |-- sound.ts
|           |   |   |-- transcribe.test.ts
|           |   |   |-- transcribe.ts
|           |   |   |-- transcription-history.test.ts
|           |   |   |-- transcription-history.ts
|           |   |   |-- upload-recording.test.ts
|           |   |   `-- upload-recording.ts
|           |   |-- queries
|           |   |   |-- audio.ts
|           |   |   |-- download.test.ts
|           |   |   |-- download.ts
|           |   |   |-- transcription.test.ts
|           |   |   `-- transcription.ts
|           |   |-- settings
|           |   |   `-- transcription-validation.ts
|           |   |-- shortcuts
|           |   |   `-- focused.ts
|           |   |-- state
|           |   |   |-- README.md
|           |   |   |-- capture-surface.svelte.ts
|           |   |   |-- completion.svelte.ts
|           |   |   |-- inference-connections.svelte.ts
|           |   |   |-- polish.svelte.ts
|           |   |   |-- polish.ts
|           |   |   |-- recipes.svelte.ts
|           |   |   |-- recordings.svelte.ts
|           |   |   `-- settings.svelte.ts
|           |   `-- whispering
|           |       |-- app.test.ts
|           |       |-- app.ts
|           |       |-- context.ts
|           |       |-- inference.test.ts
|           |       |-- inference.ts
|           |       |-- recipes.svelte.ts
|           |       |-- recipes.ts
|           |       |-- recording.ts
|           |       |-- recordings-markdown-export.test.ts
|           |       |-- recordings-markdown-export.ts
|           |       |-- recordings.test.ts
|           |       |-- recordings.ts
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
|                   |   |   |-- RecordingAudioCell.svelte
|                   |   |   |-- RecordingDetailModal.svelte
|                   |   |   |-- RecordingTranscriptCell.svelte
|                   |   |   |-- RenderAudioUrl.svelte
|                   |   |   |-- TranscriptionStatusBadge.svelte
|                   |   |   `-- actions
|                   |   |       |-- DownloadRecordingButton.svelte
|                   |   |       |-- RecordingRowActions.svelte
|                   |   |       |-- TranscribeRecordingButton.svelte
|                   |   |       `-- UploadRecordingButton.svelte
|                   |   `-- settings
|                   |       |-- +layout.svelte
|                   |       |-- analytics
|                   |       |   `-- +page.svelte
|                   |       |-- dictation
|                   |       |   `-- +page.svelte
|                   |       `-- recording
|                   |           `-- +page.svelte
|                   |-- +page.svelte
|                   `-- _components
|                       |-- PolishStatusLink.svelte
|                       |-- RecordingResult.svelte
|                       `-- WhisperingShell.svelte
|-- docs
|   |-- adr
|   |   |-- 0363-an-inference-selection-identifies-the-connection-and-model.md
|   |   |-- 0365-ai-owns-inference-access-and-applications-own-workflow-selection.md
|   |   |-- 0373-product-operations-read-the-page-owned-app-when-invoked.md
|   |   |-- 0373-product-operations-receive-their-resource-handles-explicitly.md
|   |   `-- README.md
|   `-- reports
|       `-- 20260920-whispering-simplification.md
|-- packages
|   |-- app
|   |   `-- scripts
|   |       `-- ai-connections.browser.mjs
|   |-- app-shell
|   |   |-- package.json
|   |   |-- scripts
|   |   |   `-- inference-picker.browser.mjs
|   |   `-- src
|   |       |-- agent-chat
|   |       |   |-- agent-chat-thread.svelte
|   |       |   |-- agent-chat.svelte.test.ts
|   |       |   `-- agent-chat.svelte.ts
|   |       |-- inference-picker
|   |       |   |-- catalog.svelte.ts
|   |       |   |-- catalog.test.ts
|   |       |   |-- connections.svelte.ts
|   |       |   |-- connections.test.ts
|   |       |   |-- cross-device-model-gap.svelte
|   |       |   |-- index.ts
|   |       |   `-- inference-picker.svelte
|   |       |-- inference-selections.ts
|   |       `-- inference-target.ts
|   |-- constants
|   |   `-- src
|   |       `-- ai-providers.ts
|   `-- svelte
|       |-- README.md
|       `-- src
|           |-- from-data.svelte.test.ts
|           |-- from-data.svelte.ts
|           |-- from-kv.svelte.ts
|           `-- index.ts
`-- specs
    |-- 20260908T212054-whispering-call-time-app-composition.md
    `-- 20260908T233656-local-mail-app-and-saved-queries.md
```


Additional supporting reads in this pass:

```text
.agents/skills/
|-- consult-claude/SKILL.md
|-- error-handling/SKILL.md
|-- git/SKILL.md
|-- greenfield-clean-breaks/SKILL.md
|-- post-implementation-review/SKILL.md
|-- standalone-commits/SKILL.md
|-- svelte/SKILL.md
`-- testing/SKILL.md
apps/whispering/
|-- AGENTS.md
`-- package.json
packages/app/
|-- scripts/shared-ai-catalog-native/page.ts
`-- src/data/store/
    |-- document.ts
    |-- handles.ts
    `-- store.ts
```

### Findings and repairs

| Finding | Why it matters | Disposition |
| --- | --- | --- |
| Playback subscribed to the whole recording row through an async helper's synchronous read | Editing a transcript disposed and reopened playing audio | Reproduced in Chromium. The player derives primitive audio references and passes them to `openRecordingAudio(blobs, refs)`. Both browser engines now pass the regression. |
| `RenderAudioUrl` forwarded a redundant audio prop | One wrapper and a prop chain obscured the actual playback dependency | Deleted the wrapper and the prop in all consumers. |
| Table data getter created and sorted an array on every read | TanStack could not reuse its row model across unrelated UI changes | Keep one derived newest-first array. The table applies any selected sort; clearing it preserves the previous newest-first behavior. |
| Upload checked whether the remote key existed | The key also exists when remote access is null | Gate on the non-null capability. |
| Draft recipes generated IDs discarded at save | Unnecessary work and an exported helper with no domain rule | Inline an empty draft; the table still owns ID creation. |
| Obsolete types and exported internal parsers | Extra API with no consumers | Remove `RecordingAudioAvailability`, `WhisperingUiSession`, and parser export modifiers. |
| History callers and comments still described asynchronous writes | API descriptions and a test mock disagreed with synchronous table writes | Remove redundant awaits and the nonexistent omitted key; fix the mock to return a Result. |
| Tests asserted against nonexistent `blobs.removeLocal` and stubbed `patch` | The cleanup assertions could never detect a regression | Remove phantom members and assert each test's own finalization and publication events. Separate real-store tests prove byte retention. |
| Architecture and ADR prose described removed APIs | New readers would reconstruct the old ownership model | Update current-state prose, rename ADR-0373, and update its links. No status changes. |

Current and resulting playback composition:

```text
Before
RecordingAudioCell
`-- RenderAudioUrl(id, audio)
    `-- AudioBlobPlayer(id, audio)
        `-- openRecordingAudio(app, id): reads whole row

After
RecordingAudioCell
`-- AudioBlobPlayer(id)
    |-- derives audioBlobId and audioUrl
    `-- openRecordingAudio(blobs, refs)
```

### Boundaries that remain

- The ready context distributes one selected owner. Replacing it with a global
  binding would reintroduce publication order and ambient operation routing.
- The UI session owns capture admission, query lifetime, and teardown.
- `fromData` and `fromKv` supply shared reactivity while preserving table and KV
  APIs. They are not product CRUD wrappers.
- The catalog owns observation and model discovery. The target resolver binds
  the exact selected connection and model without persisting workflow policy.
- Chat reconciles a local target with a synced conversation model. Whispering's
  direct KV preferences do not remove that distinct requirement.
- Audio sources have a component lifetime, including late acquisition cleanup.
  Keeping that ownership in `AudioBlobPlayer` prevents duplicated disposal code.

### Remaining work

The reviewer recommended the following additional cleanups. They are recorded
rather than folded into a stage-now request after the correctness repairs:

1. Delete the test-only `transcribeAudio` wrapper and exercise
   `captureTranscription` directly. Remove the vacuous legacy-provider loop and
   unnecessary selection-store fixture in catalog tests.
2. Make Polish capture its settings and target once per pass. Currently retired
   custom and account targets have different failure shapes; the pipeline's
   synchronous admission checks guard its current call path.
3. Improve file homes and exports as shown below. The catalog move is useful
   because non-UI tests currently deep-import a file under the picker folder.
4. Reconcile duplicate `WhisperingData` type names, remove remaining no-op casts
   and picker aliases, combine Vocab's duplicate context reads, and use the
   resolved model directly there. Normalize the inserted import blocks.
5. Document undefined-versus-null initialization beside the KV declarations
   and the historical completion default beside its importer. Retire that
   importer only when pre-KV upgrades no longer need support.
6. Consider deleting local chat selections with deleted conversations. Review
   the dev metrics refresh and the older Vocab/Svelte README statements. The
   call-time composition spec still describes the removed registry and domain
   subscriptions; a dated reconciliation should distinguish its remaining
   native acceptance obligations from that obsolete plan.
7. Exercise native microphone capture and the full Tauri product boot. Browser
   harnesses and typechecks do not establish that acceptance.

Optional organization proposal, not applied:

```text
Current
apps/whispering/src/lib/
|-- state/polish.ts
`-- whispering/app.test.ts
packages/app-shell/src/inference-picker/
|-- catalog.svelte.ts
`-- catalog.test.ts

Proposed
apps/whispering/src/lib/
|-- settings/polish.ts
`-- operations/settings.test.ts
packages/app-shell/src/
|-- inference-catalog.svelte.ts
`-- inference-catalog.test.ts
```

The final Claude re-review accepted the repairs with no staging blocker, then
completed a full-body reread of all 20 remaining updated files with none unread. It
verified playback ownership, capability gating, table identity, and the removed
wrappers. A final documentation correction names the resolver's AI capability
argument accurately. The final pass also strengthened two publication assertions
against stale shared events and kept newest-first order when table sorting is
cleared. Those files were reread and their checks rerun before refreshing the index.

Completing an upload still changes the remote URL and can restart local
playback. This behavior also occurred before the repair. A future playback
change could subscribe to the remote URL only after local bytes are missing.

The rest of the original inventory retains its boundaries or contains mechanical
caller updates. The review found no unresolved production blocker in legacy
import, exact target capture, shared reactivity, or session retirement.

### Staging scope

The index contains only the inventory above. Existing Epicenter server, Local Mail, native
storage, BACKLOG, transcript-review, session, and September 18 report changes
belong to other work and are excluded. This is one coordinated API migration:
the shared adapters, picker contract, and consumers must remain together for
the checkout to compile. No commit was requested beyond preparing the index.
