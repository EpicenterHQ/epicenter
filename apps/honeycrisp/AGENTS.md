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
  bundles.
- Do not add a migration, a legacy reader, or a compatibility path for the
  earlier Yjs-backed Honeycrisp. There are no users to carry forward.
- Opening or listing a note must not write its file. Only an edit writes.
- Opening an initialized folder changes no saved file, commit, or ref,
  even when its repository has no commit yet. Only missing layout/defaults
  are initialized. Do not request a commit because a folder has no head.
- The shell writes nothing inside the notes directory. A missing layout is
  created by the page through the granted folder, after the shell's grant
  takes the folder's lock, in `src/lib/platform/first-open.ts`: look first, write `kv.json`
  only when a read confirmed it absent and only if it is still absent, and
  never retry an outcome that is unknown. Table directories come from the
  declaration; do not list them a second time in Rust.
- The query cache holds the files (ADR-0528). The note and folder
  listings, the file listing, each file opened as text, and Git status are
  queries in `src/lib/notes.svelte.ts`. Do not add a draft, an edit session,
  an autosave, a save merge, a review, a retained editor per path, or any
  other copy beside the cache. `$state` holds only input that is not
  committed yet: the search, a folder name being typed.
- An edit is one immutable change to the cached row or text, then a write
  mutation keyed and scoped by the file's path. It reads the cache when it
  runs and is guarded by the hash the cache last confirmed. A file has at
  most one write running and one waiting. Success moves the guard forward
  and keeps the cached row; failure rereads that one file, which rolls the
  edit back, and reports the lost text through `onWriteFailed`. Title,
  folder, pin, rich text, Source, list actions, and folder names are all
  such edits. While a file is open as text, its text is what saves, and row
  edits of it are refused.
- No read starts while a write runs: an edit cancels reads in flight,
  nothing goes stale on its own (`staleTime: Infinity`), focus does not
  refetch while writing, a text read waits for the file's row write, and
  everything is read again once the last write settles. The race tests in
  `notes.test.ts` fail when the focus, staleness, or text-read guard is
  removed; keep them.
- Every action is a mutation (create, rename, delete, delete folder, Save
  version, terminal commands), so closing can wait for the mutation cache to
  be idle. Do not add a manual `refresh()` after an action; its mutation
  invalidates what it changed.
- Commits happen only on **Save version** (`folder.git.commit()`, ADR-0529).
  Nothing commits on its own, and setup records no commit.
- A note whose text does not read as one is listed for repair and opens as
  text, with its issues read live from the text on screen (`parseRow`).
  There is no structured partial-row repair.
- The page reads the folder when it opens, on window focus, and after its
  own actions and terminal commands. Do not follow `folder.onFilesChanged`
  hints. A reread that changes the open note's body replaces the rich-text
  state, so its undo history restarts.
- A destructive action that must find every related file refuses when any
  file's relation did not read (`deleteFolder`).

## Editor ownership

- The cache owns the note's body. ProseMirror's `EditorState` owns only what
  the cache has no place for: the cursor, pending formatting, undo history,
  and an empty paragraph Markdown cannot spell yet. Its document is never a
  draft beside the cache.
- Every ProseMirror transaction that changes the document goes through
  `stateAfter`: reconciliation with the body the cache holds now, checked
  Markdown serialization, then `NoteBody.edit` with the body made
  `wellFormed`, before it is shown. An edit the cache refuses is not shown.
  Do not refuse an edit only because a file cannot hold it (a lone
  surrogate): sanitize it, or ProseMirror and the cache diverge.
- `stateShowing` follows the cached body by content: the same content keeps
  the state; different content (Source, a version, a reread, a rollback)
  replaces it.
- Do not weaken `checkNoteDoc` to let an edit through. If Markdown cannot
  spell it, the edit is refused. If it should be spellable, fix the
  serializer and add the case to `markdown.test.ts`; the property tests in
  `markdown.fuzz.test.ts` must keep passing with zero refusals for typing
  and for whole-word formatting.
- Adding a node or mark to `editor/schema.ts` requires its Markdown in both
  directions and tests for both. Source the schema cannot hold is refused by
  `inspectNoteBody`, not dropped.
- The rich-text view's lifetime depends on one boolean (`editable`) and its
  element. Do not make its mount effect read anything that changes on a
  keystroke or a write, including `locked`; that recreates the view and
  erases undo history. The view is keyed by its opening, so a rename keeps
  it.
- Views disable their inputs with `notes.isLocked(path)`: while a close is
  answered, and while the file is renamed or deleted.

## Closing

- Once the page holds its folder, every native close needs that page's
  answer to that request. Nothing else approves one: not a write count, not
  a timeout, not a page that stopped answering, not the shell itself. Do not
  add a native prompt that discards on the page's behalf.
- The page registers with the shell before it opens the folder, listens
  before it says the folder is open, and says so before the notes exist.
  `openGuarded` in `src/lib/platform/shell.tauri.ts` keeps that order; do not
  open the desktop folder around it.
- An approval names its page generation and its request. Keep both checks in
  `src-tauri/src/close.rs`. The page answers a close by waiting for the
  mutation cache to be idle (`notes.settle()`), then approving; it never
  asks to discard and never declines. The gate's decline stays for the
  shell's own use.
- Input is fenced before writes are waited for and stays fenced while the
  approval is on its way. `notes.fenceInput()` is the one switch: edits are
  refused, notes actions and the terminal refuse to run, and `NotesView` is
  `inert`. A new way to change a file must check it, and
  a control in a menu, popover, or dialog must also be `disabled`, because
  those render outside the inert root. Do not unmount the editors to fence
  them: that loses undo history.
- Release the fence only for the two gate refusals listed in
  `APPROVAL_NOT_TAKEN` in `shell.tauri.ts`. Those are the texts of
  `Refusal::StalePage` and `Refusal::NoSuchRequest` in `close.rs`; change
  them together. "the app is already closing", any other text, and any other
  failure keep the fence.
- Route every way out through the gate: the window's close request, the run
  loop's exit request, and the macOS Quit menu item, which stays custom
  because the predefined one cannot be prevented.
- A macOS system quit (Dock, logout, Apple Event) is AppKit's `terminate:`,
  which Tao's delegate does not answer. `src-tauri/src/quit.rs` adds only
  `applicationShouldTerminate:` to Tao's existing delegate class during
  setup. It always cancels and calls `app.exit(0)`, so the gate decides.
  Do not let it return anything but cancel, keep state, take a lock, or
  replace the delegate. If the delegate class changes or already answers the
  question, the app must fail to start; do not make it skip the guard.
- After any Tauri, Tao, or macOS upgrade, rerun `bun run test:quit` and
  `evidence/native-quit/late-method-probe.rs`, and record the results in
  `evidence/native-quit/README.md`. The startup checks cannot see whether
  AppKit still asks a method added after the delegate was set.

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
  and do not fall back to browser storage when the grant fails.
- The root, the commit author, and the window allowed to use them are decided
  in `src-tauri`. No command accepts a root or a working directory from the
  page.
- History stays in the directory. The shell registers only the root and the
  fallback author (`folder_config` in `lib.rs`); the remote and the person's
  `user.name` and `user.email` are the repository's Git configuration, which
  the page's engine reads. Do not give the shell a remote.
- The notes window loads the bundled page's exact origin only. Keep the port
  and credentials checks in `is_app_page`.
- A shell command exists in three places that change together:
  `src-tauri/src/command_names.rs`, the handler list in `lib.rs`, and
  `src-tauri/capabilities/main.json`. `src-tauri/src/tests.rs` checks them
  against each other. Update the README's command table with them.
- The terminal is the desktop shell's own `/bin/sh`, an outside writer; the
  browser build has none. Do not route it through the folder's publication,
  and do not make it request a commit.
- A path from the page is checked with the folder plugin's `path_problem`
  before `git` sees it, and a commit must be a hexadecimal id. Keep both
  checks in `history.rs`.
- Do not describe the native conditional save as atomic. It compares, then
  replaces; another program can write in between.
- Do not add fault injection to the shell or wrap the folder's writes to
  simulate failures. The README lists how to produce a real failure in a
  disposable directory; never test against the default one. Tests fault the
  folder's storage stand-in, never a wrapper around the notes state.
- A commit failure is a Git fact. Do not turn one into a save error, and do
  not make a save request or wait for a commit.
- `bun run test` must not need Rust. Tests that need the shell live in
  `src-tauri` and `native-tests/` and run with `bun run test:native`. The
  quit harness, `src-tauri/examples/quit`, opens a window and needs a macOS
  login session, so it runs only on its own (`bun run test:quit`). It quits
  its own process in a fresh directory. Never point it at the default folder,
  and never quit another app to test.

## Words a person reads

Say note, folder, file, saved, version, and commit. Do not put `entry`,
`buffer`, `scope`, `shell`, `baseline`, or `canonical` in anything a person
reads; those are the right words in code and the wrong ones in a status line.
