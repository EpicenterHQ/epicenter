# Honeycrisp App

File-authoritative Markdown notes over one local folder. Read
[the README](README.md) for how the page and the folder fit together, and
verify it against the code. The constraints below apply to every edit here.

## The files are the data

- The folder's current files are the saved data. Do not add a second store
  beside them: no browser-storage copy, no mirrored checkout, no import step,
  no cache that can disagree with a file.
- Do not add Yjs, a CRDT, an account, or sync to this app. Nothing in
  `src/` may import `@y/*`, `yjs`, `@epicenter/auth`, or
  `@epicenter/sync`. `src/lib/bundle.test.ts` checks the bundles.
- Do not add a migration, a legacy reader, or a compatibility path for an
  earlier Honeycrisp: not the Yjs-backed one, and not the OPFS folder the
  declaration-based build kept. Old OPFS data is left untouched and unread;
  the shared opener owns saying so. Do not wrap a method the local folder
  does not have (rename, move, mkdir, Git) to bring it back.
- Opening or listing a note must not write its file. Only an edit writes.
- Keep editable documents and accepted input in the Folder's edit owner.
  Queries list, derive, and schedule refreshes; do not add another document
  owner or save queue in the app. Local state holds unfinished forms,
  search, selection, and other UI state.
- Send immediate note and folder changes through the shared Folder edit.
  Preserve pending input across rereads and view changes. A failed save
  keeps that input and its error; a read must never replace it.
- Whole-file input and row patches share one pending representation and
  one save queue per path.
  Switching representations must preserve failed input for retry, copying,
  or explicit discard. Selecting another file does not release that input.
  Reads must not initiate saves or wait for them.
- A save moves no timestamp (ADR-0573). Do not add a last-edited field or
  write `updatedAt`; the list orders and groups notes by `createdAt`.
- The folder refuses text that is not well-formed, so the title, Source, and
  a file's text pass through `wellFormed`, and the rich-text view replaces a
  lone surrogate with U+FFFD in its transaction. The folder reads a body with
  its file's line endings; `noteBody` shows it with line feeds, so the
  editors read and write line feeds (ADR-0572) and opening writes nothing.
  `FileView` edits a file's exact text, so it keeps `withFileNewlines`.
- Nothing goes stale on its own (`staleTime: Infinity`) and focus never
  refetches. The folder's change channel reports this page's own saves and
  another tab's; do not add a manual reread after an action.
- There are no versions and no sync. Do not add Save version, Sync, or
  Connect back until the local folder offers them.
- A note whose text does not read as one is listed for repair and opens as
  text, with the issues the folder read after its last save. Repair is text
  editing; there is no structured partial-row repair.
- A destructive action that must find every related file refuses when any
  file's relation did not read (`deleteFolder`).

## Editor ownership

- The Folder's row edit owns the note's body.
  ProseMirror's `EditorState` owns only what that edit has no place for: the
  cursor, pending formatting, undo history, and an empty paragraph Markdown
  cannot spell yet. Its document is never a third copy of the body.
- Every ProseMirror transaction that changes the document goes through
  `stateAfter`: reconciliation with the body shown now, checked Markdown
  serialization, then `NoteBody.edit`, before it is shown. An edit that is
  refused is not shown.
- `stateShowing` follows the body shown by content: the same content keeps
  the state; different content (Source, another tab's change) replaces it.
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
  erases undo history.
- Views disable their inputs with `notes.isLocked(path)`: once the notes are
  closing, and while the file is deleted.

## Closing

- `<FolderApp>` closes the folder when the page goes away: the edit
  layer refuses new input (`notes.fenced`), sends every draft, waits for the
  saves, then closes the handle. Views send their own drafts as they go away,
  and the shared root sends pending edits when the page is hidden. A new way
  to change a file must check `fenced`, and a control in a menu, popover, or
  dialog must also be `disabled`, because those render outside the inert
  root.
- Keep the browser unload guard in `FolderApp` and the in-page navigation
  guard (`beforeNavigate`) in `HoneycrispApp`. They ask before leaving only
  while the Folder has a pending save.

## The boundary

- The page reaches its folder only through `<FolderApp>` from
  `@epicenter/svelte/folder-app`, which opens
  `openFolder({ tables: honeycrispTables })`, and components through
  `getFolder()` or the `notes` state built over it. Do not detect the
  platform in app code, and do not import a Node or Bun module under `src/`.
- Shared code imports the folder contract from the bare `@epicenter/folder`,
  which each build aliases to its one adapter entry in `vite.config.ts`.
  Do not add another folder engine or fall back to other browser storage
  when opening fails.
- The bundled host build opens the directory the desktop shell grants this
  window through the same `<FolderApp>`. Never route it to the old
  declaration-based opener or to browser storage.
- Tests fault the folder's storage stand-in (`fake-indexeddb`), never a
  wrapper around the folder or the notes state.

## Words a person reads

Say note, folder, file, saved, and browser. Do not put `entry`, `buffer`,
`scope`, `shell`, `baseline`, `canonical`, `draft`, or `row` in anything a
person reads; those are the right words in code and the wrong ones in a
status line.
