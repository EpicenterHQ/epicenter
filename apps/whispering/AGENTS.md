# Whispering App

Whispering keeps its recordings on the device it runs on
([ADR-0894](../../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)).
One build serves two places: in the desktop app (`src-tauri/`) the folder
is `data/` in the app's local data directory unless the person moved it,
and in a browser it is `data/` in the Origin Private File System. Both hold
the same tree of plain files that fit the `whispering` contract
(`src/lib/contract.ts`), and neither needs an account, a server, or Git.
Read `README.md` for behavior and `ARCHITECTURE.md` for structure.

## Constraints

- **One `Files`, chosen in one place.** `src/lib/app.ts` picks
  `tauriFiles` or `opfsFiles` and opens Whispering's folder over it
  (`openFolder`). Everything above `Files` (`notes.svelte.ts`,
  `settings.svelte.ts`, `folder.svelte.ts`) is written once and never asks
  where it runs. Tests use `memoryFiles()`. Every `Files` passes the one
  conformance suite (`src/lib/files/conformance.ts`). On the desktop
  `tauriFiles` calls Whispering's own `files_*` commands; the page holds
  none of `@tauri-apps/plugin-fs`'s commands.
- **The folder only ever receives finished files, each by one rename.** A
  write stages in `local/.tmp/` and a take records in `local/recording/`,
  both in the app's local data directory, outside the folder. The one
  exception is the place step's copy beside its target
  (`.ep-<random>.save`) when the folder is on another volume; one a crash
  left is removed when the folder next opens (`clear_saves`, run by
  `recover`). Never write any other temporary or growing file inside the
  folder.
- **Rust moves bytes; TypeScript reads notes.** Notes use the home's
  Markdown grammar from `@epicenter/app/markdown` (`src/lib/format/note.ts`).
  Do not parse a note in Rust or copy the grammar.
- **Lists are Svelte state that `load()` fills.** The folder is read before
  the app renders (`src/routes/(app)/+layout.svelte`) and again when the
  window regains focus. A successful write updates the state. Do not add a
  watcher, a cache layer, or a store per collection.
- **Never replace a note that changed since it was shown.** A write re-reads
  the file first and refuses with `NoteError.Changed` when its bytes differ;
  the person sees the newer text. `settings.md` follows the same rule.
- **Every write answers a `Result`; a failure keeps what the person typed.**
  An editor keeps unsaved text and offers Try again or Discard
  (`SaveProblem.svelte`); an answer whose result was not written stays in
  the window with Save again, which sends nothing (`runs.svelte.ts`). Do not
  add an outbox or a queue that writes later on its own.
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
  interrupted field. On the desktop, audio a quit or a crash cut off is
  completed by the next launch's `capture.recover`, beside the pages, and
  lists as an untitled recording.
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
