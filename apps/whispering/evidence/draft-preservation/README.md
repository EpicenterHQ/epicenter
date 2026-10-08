# Recording draft preservation evidence

Starting commit: `5b4bb69a956c56b95fa5ec2dae64b73c5cb4fdbd`.
Branch: `codex/whispering-draft-preservation`, created from fetched `origin/main` on 2026-10-08.
The original dirty checkout and the previous UI checkout were left untouched.

## Repeat the rendered comparison

From the repository root after `bun install --frozen-lockfile`:

```sh
bun --bun apps/whispering/node_modules/vite/bin/vite.js --config apps/whispering/evidence/draft-preservation/vite.config.ts
```

Open `http://localhost:5189/`. Schedule the unrelated B update, open A,
and replace its transcript within five seconds. The draft and enabled Save
should survive the update. Other controls schedule incoming changes, unmount
the table rows, and delete fixture A. Reload to reset the fixture.

To repeat the failure, stop that server and run:

```sh
VITE_DRAFT_BASELINE=1 bun --bun apps/whispering/node_modules/vite/bin/vite.js --config apps/whispering/evidence/draft-preservation/vite.config.ts --port 5190
```

Open `http://localhost:5190/` and repeat the same sequence. This mode loads the
original transcript cell and detail modal directly from the starting Git commit.
It uses the same fixture and unchanged recordings domain cache.

The harness renders the real transcript cell, detail form, shared Modal,
Dialog/Drawer components, recordings domain cache, and Svelte adapter.
Audio, storage, download, deletion, clipboard, and transcription actions are
inert. Fixture deletion bypasses those actions and only removes a test row.
The fixture table returns fresh row objects and invalidates subscribers,
matching `packages/data/src/store/store.ts`'s `rows` getter. It does not prove
the full application or persistence lifecycle. Automated editor tests use the
real memory store rather than this fixture table.

## Baseline observations

Safari computer use observed this sequence before production edits:

1. A initially displayed `Saved transcript A`; Save was disabled.
2. Typing `Unfinished draft A` enabled Save.
3. The scheduled B update made A display `Saved transcript A` again and disabled Save.
4. A second run with `Second unfinished draft A` produced the same reset.

The first fixture reused unchanged row objects and did not reproduce the reset.
Returning fresh rows, as the real store does, reproduced it. The final baseline
replay also reproduced the reset using components loaded from the starting commit.

Both baseline Whispering typecheck configurations passed with zero errors or
warnings. Existing recordings and UI-session-opening tests passed (9 tests).
The baseline full app rendered blank in Safari; the dev server reported
`ReferenceError: Cannot access 'component' before initialization` in SvelteKit's
client. This was observed before production edits.

## Chosen lifetime and behavior

Drafts belong to the UI session and contain only edited fields and their saved
baselines. Saved recordings remain in the recordings domain. There is no durable
draft storage. The editor is independent of table row and responsive form mounts.

| Event | Result |
| --- | --- |
| X, Close, Escape, outside click, mobile drag | Close and retain the draft without a confirmation prompt. |
| Reopen or switch recordings | Resume the selected recording's draft. Other drafts remain discoverable. |
| Row unmount or responsive layout switch | The open editor and its input remain. |
| Resize past the shared breakpoint | Use the shared Modal's live Dialog/Drawer switch, preserving the draft. |
| Incoming change to an untouched field | Show the new saved value. |
| Incoming change to an edited field | Keep input, show the latest saved version, and require a choice before Save. |
| Keep my edit | Acknowledge only the version shown; a later incoming change requires another choice. |
| Use saved version | Remove that field's edit and show its current saved value. |
| Save | Recheck current values synchronously and patch only edited fields; clear the draft on success. |
| Save failure or invalid timestamp | Keep the form and input for repair and retry. |
| Discard draft | Drop edits and show current saved values. |
| Recording becomes unavailable | Keep its draft discoverable and copyable; disable Save and never recreate the row. |
| Reload, quit, or account departure | End the in-memory lifetime. Session disposal clears drafts before asynchronous teardown. |

Replacing raw transcript text also clears its polished transcript. A newer
polished result therefore requires acknowledgement even if the raw saved text
has not changed. If incoming raw text already equals the draft, that edit is
satisfied and its current polish stays intact. A delayed pipeline polish checks
the saved raw/polished pair before storing, so it cannot hide a newer save.

## Design and cumulative review

Two independent reviews and focused proposal challenges preceded implementation.
They agreed on session ownership, sparse field edits, explicit conflict handling,
and a stable detail host. A dismissed draft recovery list addresses deletion
while the form is closed. The existing auth-generation reload helper supplies
the browser account boundary; desktop account departure already relaunches the host.

The cumulative review followed the session, context, global host, row opener,
form, recovery list, saved-data boundary, and asynchronous pipeline. The editor
owns the retention/conflict invariants. The keyed form isolates recording-specific
query state. Shared Modal owns presentation and dismissal. No local event veto
or shared primitive changes remain. RecipePicker retains its existing behavior.

Review found and corrected deletion completion reading a later selection: the
callback now captures its deletion target and closes only that target's editor.
The polish race is a separate commit because it belongs to the asynchronous
saved-data writer rather than the form's draft lifetime.

Files read for the cumulative review:

```text
apps/whispering/
|-- README.md
|-- src/lib/
|   |-- components/RecipePicker.svelte
|   |-- operations/
|   |   |-- delete-recordings.ts
|   |   |-- pipeline.ts
|   |   |-- pipeline-auto-upload.test.ts
|   |   `-- transcription-history.ts
|   |-- state/recordings.svelte.ts
|   `-- whispering/
|       |-- recording.ts
|       |-- recordings.ts
|       |-- recordings.test.ts
|       |-- recording-editor.ts
|       |-- recording-editor.test.ts
|       |-- context.ts
|       |-- ui-session.ts
|       |-- ui-session-opening.test.ts
|       `-- WhisperingUiSessionProvider.svelte
|-- src/routes/
|   |-- +layout.svelte
|   `-- (app)/
|       |-- +layout.svelte
|       |-- _components/GlobalDialogs.svelte
|       `-- (config)/recordings/
|           |-- +page.svelte
|           |-- RecordingTranscriptCell.svelte
|           |-- RecordingDetailModal.svelte
|           |-- RecordingDetailForm.svelte
|           `-- RecordingDrafts.svelte
`-- evidence/draft-preservation/
    |-- Harness.svelte
    |-- vite.config.ts
    |-- stubs.ts
    |-- Empty.svelte
    |-- main.ts
    |-- index.html
    `-- style.css
packages/
|-- auth/src/svelte/reload-on-auth-change.ts
|-- data/src/store/store.ts
`-- ui/src/
    |-- modal/{modal.svelte,modal-content.svelte,modal-state.svelte.ts}
    |-- dialog/dialog-content.svelte
    `-- drawer/drawer-content.svelte
```

## Rendered result and limits

Native Safari clicks, typing, Escape, outside clicks, window resizing, and drag
worked during this task. Observed results in the fixed harness:

- Unrelated B update preserved A's unfinished text and enabled Save.
- X, Close, Escape, outside click, and mobile drag closed without prompts;
  reopening restored input. The page stayed usable after drag-close.
- The open editor survived row unmount and changed from Dialog to Drawer on
  resize without losing input or dirty state.
- Incoming raw text displayed a conflict and disabled Save. Keep my edit
  enabled Save; Save persisted the draft and removed its recovery entry.
- Incoming polish displayed both saved versions and retained input. Use saved
  version removed the edit, retained the new polish, and disabled Save.
- Discard restored current saved input and disabled Save.
- After fixture A was deleted while dismissed, its recovery button said
  `recording unavailable`. Reopening retained input and disabled Save.

An initial polish fixture run failed because the harness lacked the app's
Tooltip.Provider. Adding the same provider fixed that fixture error.

The complete app still rendered blank in Safari after the implementation.
End-to-end sign-out, native-host relaunch, real audio/storage operations, touch
hardware, and exact Drawer body-style restoration have not been exercised.
The rendered drag check establishes page usability, not equality of inline styles.

## Diagnostics and regression coverage

- Monorepo `bun typecheck`: passed.
- Whispering browser and desktop typechecks: passed with zero errors or warnings.
- Whispering production build: passed.
- Focused editor, recordings, session-opening, pipeline, and auth-generation
  tests: 35 passed, 0 failed, 86 assertions.
- Scoped Biome lint and formatting: passed for supported files. Repository
  configuration excludes Svelte files; Svelte diagnostics own those files.
- Full Whispering suite: 132 passed, 3 failed. A separate checkout at the starting
  commit reproduced the same three failures (120 passed, 3 failed): signed-out
  fixture tests in `app.test.ts` fail because app boot now requires an account.
- Both new delayed-polish regression cases fail against the original pipeline
  and pass against the fix. The failures reproduce overwriting after either a
  changed raw transcript or a newer polished transcript.
