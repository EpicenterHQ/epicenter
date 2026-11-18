# Whispering App

Whispering keeps its recordings on the device it runs on
([ADR-0894](../../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)).
One build serves two places: in the desktop app (`src-tauri/`) the folder
is `data/` in the app's local data directory unless the person moved it,
and in a browser it is `data/` in the Origin Private File System. Both hold
the same tree of plain files, laid out as `src/lib/format/folder.ts`
declares, and neither needs an account, a server, or Git.
Read `README.md` for behavior and `ARCHITECTURE.md` for structure.

## Constraints

- **One `Files`, chosen in one place.** `src/lib/app.ts` picks
  `tauriFiles` or `opfsFiles` and opens Whispering's folder over it
  (`openFolder`). Everything above `Files` (`notes.ts`, `settings.ts`,
  `folder.ts`, `folder-query.ts`) is written once and never asks where it
  runs. Tests use `memoryFiles()`. Every `Files` passes the one
  conformance suite (`src/lib/files/conformance.ts`). On the desktop
  `tauriFiles` calls Whispering's own `files_*` commands; the page holds
  none of `@tauri-apps/plugin-fs`'s commands.
- **Every file is written inside the folder, at or beside its path**
  ([ADR-0962](../../docs/adr/0962-whispering-8-writes-every-file-inside-its-folder-at-or-beside-its-final-path.md)).
  A take is `recordings/<id>.webm` from its first second and is finished
  there; nothing repairs one a crash cut off. A note or `settings.md` is
  written to `.<name>.tmp` beside it, flushed, and renamed over it; the
  first file command on a folder in a run removes what a crash left of
  those. Nothing waits in the app's local data directory on its way into
  the folder.
- **Rust moves bytes; TypeScript reads notes.** Notes use the home's
  Markdown grammar from `@epicenter/app/markdown` (`src/lib/format/note.ts`).
  Do not parse a note in Rust or copy the grammar.
- **The folder is two TanStack queries; every write is a mutation.** The
  services (`notes.ts`, `settings.ts`, `folder.ts`) keep nothing between
  calls; `folder-query.ts` holds the page's one `QueryClient`. The notes
  and audio are one query and `settings.md` another, each read before the
  app renders (`src/routes/(app)/+layout.svelte`), after every write (one
  `MutationCache` rule), and when the window regains focus. The services'
  functions are the mutations, with nothing between (`resultMutations`),
  keyed under `['folder']` (`folderMutations`) so every write to the
  folder shares one mutation `scope`. Code that is not a component hears a
  query through a `QueryObserver`. Do not add a watcher, a second cache,
  or an `invalidateQueries` call after a write. Typing is Svelte state
  (`note-editor.svelte.ts`), not a cache entry; a transcription's state is
  its mutation's (`runs.ts`).
- **Never write over what another program wrote.** A change to fields
  rewrites only their lines in the file as it is now; `settings.md` too.
  Only a write that replaces text the person typed (an editor's body, a
  repair) says what it replaces (`seen`), and refuses with
  `NoteError.Changed`, writing nothing, when the file differs; the person
  sees the newer text.
- **Every write answers a `Result`; a failure keeps what the person typed.**
  An editor keeps unsaved text and offers Try again or Discard
  (`SaveProblem.svelte`). A transcription whose answer cannot be written
  fails like one with no answer: nothing is kept, and Try again sends
  again. Do not add an outbox or a queue that writes later on its own.
- **One writer.** The desktop app is single-instance; a browser tab holds a
  Web Lock (`one-tab.svelte.ts`) and a second tab waits. Nothing steals the
  lock.
- **A recording is its id, found from its note or its audio.** Audio is
  `recordings/<id>.<ext>` beside its note. Audio with no note lists as an
  untitled recording dated from its id; a note with no audio stays a
  recording. Store no audio path in a note, refuse ambiguous matches, and
  never rename a recording's files (results point at it by id).
- **A recording's note is written once, after Stop, when its audio is at
  its path.** The note holds facts only: never a status, pending, or
  interrupted field. The library leaves the take under way out until its
  note is written (`takeInProgress`). Audio a crash cut off stays as it is
  and lists as an untitled recording.
- **What belongs to one computer stays out of the folder**
  (`src/lib/this-computer.ts`). A secret (a connection's key) is a Keychain
  item on the desktop and in `localStorage` in a browser. The folder's path
  and the microphone are in `localStorage`. A key never reaches the folder,
  a log, or an error message.
- **`settings.md` holds what moves with the recordings:** the model for each
  job, the connections (never their keys), and the shortcut.
- **A request goes only where it was prepared to go.** On the desktop it
  goes through Tauri's HTTP plugin with no redirect followed; in a browser
  through `fetch`. A connection edited or removed since a request was
  prepared is not sent to. A lost reply is reported as unknown, never as
  "not sent", and nothing is sent again without the person asking.
- **Provider requests are explicit.** Nothing is sent at launch or after a
  recording without the person asking.
- **Branch on what a capability offers**
  ([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
  A capability a place lacks is `null` there (`speech`, `shortcut`). Only
  the files named in `src/lib/page-boundary.test.ts` reach Tauri, and every
  Tauri module but `@tauri-apps/api/core` loads when first used;
  `apps/whispering/scripts/first-load.test.ts` refuses one in the web's first load.
- **Capabilities are module values; product state is the app's own**
  ([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
  `app.ts` exports them, opened once per page. `WhisperingApp` makes
  Whispering and its library over them. `dispose` refuses new work and late
  replies and waits for nothing.
- **No migration or compatibility code.** Nothing reads an earlier build's
  stores.
- **Every recording is a microphone take.** Tests fake the microphone in
  their own support code; the product has no stand-in for it.
- Use wellcrafted `Result` types instead of try-catch for expected failures.

## Checks

From `apps/whispering`: `bun run typecheck`, `bun run test` (Svelte's
browser runtime over jsdom, `src/lib/svelte-dom.test-support.ts`),
`bun run build`, and `cargo test -p whispering` (after `bun run build`).
The OPFS conformance run needs a real browser:
`await (await import('/src/lib/files/conformance.ts')).runFilesChecks(...)`
in the dev page's console. Only using the app establishes that it works.
