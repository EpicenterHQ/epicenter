# Honeycrisp App

File-authoritative Markdown notes, an installed app in Epicenter and a
browser build. Read [the README](README.md) for how the page, Epicenter's
shell, and the folder plugin fit together, and verify it against the code. The constraints below apply to every edit here.

## The files are the data

- The notes directory's current files are the saved data, and `<root>/.git`
  is ordinary Git. Do not add a second store beside them: no browser-storage copy
  on the desktop, no mirrored checkout, no import step, no cache that can
  disagree with a file.
- Do not add Yjs, a CRDT, an account, or sync to this app. Nothing in
  `src/` may import `@y/*`, `yjs`, `@epicenter/auth`, or
  `@epicenter/sync`. `src/lib/platform-selection.test.ts` checks the
  bundles.
- Do not add a migration, a legacy reader, or a compatibility path for the
  earlier Yjs-backed Honeycrisp. There are no users to carry forward.
- Opening or listing a note must not write its file. Only an edit writes.
- Opening an initialized folder changes no saved file, commit, or ref,
  even when its repository has no commit yet. Only missing layout/defaults
  are initialized. Do not request a commit because a folder has no head.
- Epicenter's shell writes nothing inside the notes directory. A missing
  layout of Honeycrisp's own folder is created by the page through the
  granted folder, after the shell's grant takes the folder's lock, in
  `src/lib/platform/first-open.ts`: look first, write `kv.json` only when a
  read confirmed it absent and only if it is still absent, and never retry an
  outcome that is unknown. Table directories come from the declaration. A
  folder Epicenter hands the window that is not Honeycrisp's own is opened
  through Honeycrisp's shape and never set up.
- The query cache holds what the files held when they were read (ADR-0528,
  ADR-0548). The note and folder listings, the file listing, each file
  opened as text, and Git status are queries from the folder's options
  (`folderOptions`) in `src/lib/notes.svelte.ts`. Do not add a second
  store, a review, or a retained editor per path. `$state` holds only input
  that is not saved yet: a title typed, body and text drafts, the search, a
  folder name being typed.
- A field edit is an update of the file as it is now (ADR-0554): title,
  folder, pin, list actions, and folder names set their fields through the
  folder's update options and keep every field another writer changed. The
  open note holds a title typed in its own `$state` until it is sent.
- A note's body, from rich text or Source, is opened with a body editor
  (`createBodyEditor` from `@epicenter/folder/svelte`, ADR-0575), one per
  note in the store. It takes the row and its version at the first change,
  keeps the body outside the cache, and saves the body alone a second after
  the last change, or at once when the view leaves it; `table.setBody`
  merges by line with a file changed elsewhere since. A read never replaces a draft. A failed save keeps
  the draft and reports it through `onWriteFailed`. While a file is open as
  text, its text is a draft of its own, written whole over the version it
  started from, and row edits of it are refused.
- A save moves no timestamp (ADR-0573). Do not add a last-edited field or
  write `updatedAt`; the list orders and groups notes by `createdAt`.
- Row editors pass the text typed as it is (ADR-0572): the folder reads a
  body with line feeds and writes a lone surrogate as U+FFFD. Do not convert
  line endings or call `wellFormed` on a title or body. `FileView` edits a
  file's exact text through `files`, so it keeps `withFileNewlines`.
- Nothing goes stale on its own (`staleTime: Infinity`) and focus never
  refetches. The tests in `notes.test.ts` that hold a save while a read
  lands, and that save while another tab changed the file, guard the
  drafts; keep them.
- Every action is a mutation (create, rename, delete, delete folder, Save
  version), so `notes.close()` can wait for the mutation
  cache to be idle before it releases the folder. Do not add a manual `refresh()` after an action; its mutation
  invalidates what it changed.
- Commits happen only on **Save version** (`folder.git.commit()`, ADR-0529).
  Nothing commits on its own, and setup records no commit.
- A note whose text does not read as one is listed for repair and opens as
  text, with its issues read live from the text on screen (`parseRow`).
  There is no structured partial-row repair.
- The page reads the folder when it opens, after its own actions, and when
  `folder.onFilesChanged` reports a change, wired to the cache in one line
  in `createNotes`. Do not add a focus reread or a per-view refresh. A
  reread that changes the open note's body while it has no body draft replaces
  the rich-text state, so its undo history restarts.
- A destructive action that must find every related file refuses when any
  file's relation did not read (`deleteFolder`).

## Editor ownership

- The note's body draft, or the cache when there is none, owns the note's body.
  ProseMirror's `EditorState` owns only what neither has a place for: the
  cursor, pending formatting, undo history, and an empty paragraph Markdown
  cannot spell yet. Its document is never a third copy of the body.
- Every ProseMirror transaction that changes the document goes through
  `stateAfter`: reconciliation with the body shown now (the draft's, or the
  cache's), checked Markdown serialization, then `NoteBody.edit`, before it
  is shown. An edit that is refused is not shown. The same transaction
  replaces a lone surrogate with U+FFFD, as the file will store it; do not
  drop that step, or the save landing restarts the state and its undo
  history.
- `stateShowing` follows the body shown by content: the same content keeps
  the state; different content (Source, a version, another writer's change)
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
- Views disable their inputs with `notes.isLocked(path)`: once the notes
  are closing, and while the file is renamed or deleted.

## Closing

- Closing the window, or quitting Epicenter, does not wait for the page
  (ADR-0542). Do not add a close gate, a page vote, a wait for writes, an
  exit hold, or a quit dialog. A save cut off by a quit leaves the old file
  or the new one, because each save renames into place.
- `notes.close()` releases the folder when the page itself goes away. Once it
  begins, `notes.fenced` is set for good: edits are refused, notes actions
  refuse to run, and `NotesView` is `inert`. A new way to
  change a file must check it, and a control in a menu, popover, or dialog
  must also be `disabled`, because those render outside the inert root.
- Keep the reload and in-page navigation guards in `NotesView`
  (`beforeunload`, `beforeNavigate`): they hold a reload back while a write
  runs.

## The boundary

- The page reaches its folder only through `#platform/folder`. Do not
  detect the platform at runtime, and do not import a Node or Bun module
  under `src/`.
- The installed build's folder is the one Epicenter hands the window as
  `?folder=`, or Honeycrisp's own when none is handed. The page opens its own
  with `openFolder` and any other with `openDataFolder` and Honeycrisp's
  definition as the lens, both from `@epicenter/folder/tauri`, and names the
  scope only. Never publish Honeycrisp's declaration over another folder's. Shared code imports
  the folder contract from the bare `@epicenter/folder`, which each build
  aliases to its one adapter entry in `vite.config.ts`; keep
  `packages/vite-config/scripts/module-graph.ts` doing the same. Do not add another folder
  engine, a Git implementation, or a history scheduler to the desktop page,
  and do not fall back to browser storage when the grant fails.
- The root, the commit author, and the windows allowed to use them are
  decided by Epicenter's shell. Nothing the page calls accepts a root or a
  working directory.
- History stays in the directory. The shell registers only the root and the
  fallback author; the remote and the person's `user.name` and `user.email`
  are the repository's Git configuration, which the page's engine reads. Do
  not give the shell a remote.
- Honeycrisp has no desktop shell and no native commands of its own (ADR-0552).
  A native need is a host function Epicenter grants every installed app
  (ADR-0555, ADR-0570); do
  not add a Tauri shell back to this app. Each leaf returns the folder
  itself, and `notes.close()` releases it. A future reveal, ADR-0555's
  `reveal_folder`, arrives as `folder.reveal`; `FileBrowser` would add a
  **Reveal folder** button back then.
- Do not describe the native conditional save as atomic. It compares, then
  replaces; another program can write in between.
- Do not add fault injection to Epicenter's shell or wrap the folder's writes to
  simulate failures. The README lists how to produce a real failure in a
  disposable directory; never test against the default one. Tests fault the
  folder's storage stand-in, never a wrapper around the notes state.
- A commit failure is a Git fact. Do not turn one into a save error, and do
  not make a save request or wait for a commit.
- `bun run test` must not need Rust. Installing Honeycrisp from this folder
  is tested by the CLI's `installs Honeycrisp from its folder` in
  `packages/cli/src/installed-apps.test.ts`, run when `EPICENTER_MONOREPO`
  names a clone of this repository.

## Words a person reads

Say note, folder, file, saved, version, and commit. Do not put `entry`,
`buffer`, `scope`, `shell`, `baseline`, or `canonical` in anything a person
reads; those are the right words in code and the wrong ones in a status line.
