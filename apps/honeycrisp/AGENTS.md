# Honeycrisp App

File-authoritative Markdown notes. Read [the README](README.md) for how the
page, the desktop shell, and the folder plugin fit together, and verify it
against the code. The constraints below apply to every edit here.

## The files are the data

- The notes directory's current files are the saved data, and `<root>/.git`
  is ordinary Git. Do not add a second store beside them: no browser-storage copy
  on the desktop, no mirrored checkout, no import step, no cache that can
  disagree with a file.
- Do not add Yjs, a CRDT, an account, or sync to this app. Nothing in
  `src/` or `src-tauri/` may import `@y/*`, `yjs`, `@epicenter/auth`, or
  `@epicenter/sync`. `src/lib/platform-selection.test.ts` checks the
  bundles. The `smoke/account-popover` fixture belongs to `packages/auth`'s
  smoke test; it is why `@epicenter/auth` and `@epicenter/app-shell` remain
  dev dependencies, and it is not part of this app.
- Do not add a migration, a legacy reader, or a compatibility path for the
  earlier Yjs-backed Honeycrisp. There are no users to carry forward.
- Opening or listing a note must not write its file. Only an edit writes.
- Opening an initialized folder changes no saved file, commit, or ref,
  even when its repository has no commit yet. Only missing layout/defaults
  are initialized. Do not request a commit because a folder has no head.
- The shell writes nothing inside the notes directory. A missing layout is
  created by the page through the attached folder, after the owner holds the
  lock, in `src/lib/platform/first-open.ts`: look first, write `kv.json`
  only when a read confirmed it absent and only if it is still absent, and
  never retry an outcome that is unknown. Table directories come from the
  declaration; do not list them a second time in Rust.
- One item is open at a time, in one edit session from
  `@epicenter/svelte/edit-session`: a note in a row session, any other text
  (a file, a note opened as its file, a note whose text is not a valid row)
  in a text session. Its title, folder, pin, rich-text, and Source controls
  all change that session's draft through `session.edit`. Do not add another
  save engine, a retained editor per path, or a second draft beside the
  session's.
- Every write is guarded by bytes this page read or saved: the session's
  autosave, `replace` on the row a list read, and `move`/`remove` on a
  capture. A change made elsewhere is the conflict prompt (Reload theirs /
  Keep mine), never overwritten silently. `create` is the only unguarded
  write and refuses an occupied path.
- A field command on a row that is not open (pin, trash, restore, folder
  assignment, folder name) is a guarded `replace` of the row the list read,
  then a re-list. On the open note it is an edit to its draft. On a note
  open as text it is refused.
- A note whose text does not read as one is listed for repair and opens as
  text, with its issues read live from the text on screen (`parseRow`).
  There is no structured partial-row repair.
- The page reads the folder when it opens, after its own actions and
  terminal commands, and on focus or visibility. Do not follow
  `folder.onFilesChanged` hints. Reading on return adopts a newer file into
  an open note only while it holds nothing unsaved (the slot's `adopt`);
  that remounts the rich-text editor, so its undo history restarts.
- A destructive action that must find every related file refuses when any
  file's relation did not read (`deleteFolder`).

## Editor ownership

- The session owns the draft; a save never assigns it. ProseMirror's
  `EditorState` owns the rich-text document, cursor, and undo history.
- Every ProseMirror transaction that changes the document goes through
  `stateAfter`: current-body reconciliation, checked Markdown serialization,
  then `session.edit` with the body made `wellFormed`, before it is shown.
  Refuse it while `session.locked`. Do not refuse an edit only because a file
  cannot hold it (a lone surrogate): sanitize it, or ProseMirror and the
  draft diverge.
- Do not weaken `checkNoteDoc` to let an edit through. If Markdown cannot
  spell it, the edit is refused. If it should be spellable, fix the
  serializer and add the case to `markdown.test.ts`; the property tests in
  `markdown.fuzz.test.ts` must keep passing with zero refusals for typing
  and for whole-word formatting.
- Adding a node or mark to `editor/schema.ts` requires its Markdown in both
  directions and tests for both. Source the schema cannot hold is refused by
  `inspectNoteBody`, not dropped.
- The rich-text view's lifetime depends on one boolean (`editable`), its
  element, and the session's `generation` (a read replaced the draft). Do not
  make its mount effect read anything that changes on a keystroke; that
  recreates the view and erases undo history.
- Leaving an item waits for `settled()`, then releases its session. A draft
  whose save failed or conflicted is let go only when the person confirms
  the discard for that session. Rename and delete act on
  `settled().file`; delete releases the session first.
- Views disable their inputs with `session.locked`, and a released session
  takes no input, so a control that outlives its view changes nothing.

## Closing

- Closing never asks. Closing the window, Cmd+Q, and the run loop's exit
  request each send the page `flush-on-close` once; the page flushes for a
  bounded moment and acknowledges with `flush_done`, and the shell exits on
  that acknowledgement or after one second, whichever comes first
  (`src-tauri/src/flush.rs`). Do not add a prompt, a "Keep editing", an input
  fence, or anything else that waits on a person or on the page's consent.
- The flush protects saves in flight only: `notes.flush()` waits for
  `admissions.quiet()` and then the open session's `settled()`, which sends
  an autosave snapshot held behind a running write. A draft whose save
  failed is not held back; the save bar said so when it failed. The page
  wires it with `flushOnClose` from `@epicenter/svelte/flush-on-close` in
  `src/routes/+page.svelte`, and the desktop leaf's `hostClose` in
  `src/lib/platform/shell.tauri.ts` always acknowledges, even when the flush
  failed or ran out of time.
- Keep the custom macOS Quit menu item. The predefined one calls AppKit's
  `terminate:`, which skips the exit request and so the flush.
- A system quit (the Dock, a logout, a shutdown, an Apple Event) reaches the
  run loop only as `RunEvent::Exit`: Tao's application delegate implements
  `applicationWillTerminate:` and not `applicationShouldTerminate:`. The page
  cannot be reached then, so only writes the folder plugin already accepted
  are drained. Do not add `applicationShouldTerminate:` to hold such a quit;
  that would cancel logouts and shutdowns.
- The browser keeps its own leave prompt: `onbeforeunload` while a save is
  running or failed, in `NotesView.svelte`. `pagehide` starts the same flush.

## The boundary

- The page reaches its folder only through `#platform/notes-host`. Do not
  detect the platform at runtime, and do not import a Node or Bun module
  under `src/`.
- The desktop folder is the shell's: the page opens it with `openFolder`
  from `@epicenter/folder/tauri` and names its ID only. Shared code imports
  the folder contract from the bare `@epicenter/folder`, which each build
  aliases to its one adapter entry in `vite.config.ts`; keep
  `apps/honeycrisp/scripts/module-graph.ts` doing the same. Do not add another folder
  engine, a Git implementation, or a history scheduler to the desktop page,
  and do not fall back to browser storage when attaching fails.
- The root, the commit author, and the window allowed to use them are decided
  in `src-tauri`. No command accepts a root or a working directory from the
  page.
- History stays in the directory. Register the folder with no remote, and do
  not enable `use_repository_origin`. Use `use_repository_author` to read
  identity under the owner lock.
- The notes window loads the bundled page's exact origin only. Keep the port
  and credentials checks in `is_app_page`.
- A shell command exists in three places that change together:
  `src-tauri/src/command_names.rs`, the handler list in `lib.rs`, and
  `src-tauri/capabilities/main.json`. `src-tauri/src/tests.rs` checks them
  against each other. Update the README's command table with them.
- The desktop terminal is the shell's own `/bin/sh`, an outside writer. Do
  not replace it with `folder.terminal()`, which is the browser leaf's
  emulated shell; do not route it through the folder's publication, and do
  not make it request a commit.
- A path from the page is checked with the folder owner's `path_problem`
  before `git` sees it, and a commit must be a hexadecimal id. Keep both
  checks in `history.rs`.
- Do not describe the native conditional save as atomic. It compares, then
  replaces; another program can write in between.
- Do not add fault injection to the shell or wrap the folder's writes to
  simulate failures. The README lists how to produce a real failure in a
  disposable directory; never test against the default one. Tests fault the
  folder's storage stand-in, never a wrapper around a session.
- A commit failure is a Git fact. Do not turn one into a save error, and do
  not make a save wait for a commit.
- `bun run test` must not need Rust. Tests that need the shell live in
  `src-tauri` and run with `bun run test:native`.

## Words a person reads

Say note, folder, file, draft, saved, and commit. Do not put `entry`,
`buffer`, `scope`, `shell`, `baseline`, or `canonical` in anything a person
reads; those are the right words in code and the wrong ones in a status line.
