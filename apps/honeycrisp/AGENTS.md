# Honeycrisp App

File-authoritative Markdown notes over one local folder. Read [the README](README.md)
for the current page flow and verify it against the code.

## The files are the data

- The folder mirror's current files and rows are the saved data. Do not add
  another durable store, browser-storage copy, import step, or app save queue.
- Do not add Yjs, a CRDT, an account, or sync. Nothing in `src/` may import
  `@y/*`, `yjs`, `@epicenter/auth`, or `@epicenter/sync`. The bundle test checks this.
- Do not add a migration or compatibility path for earlier Honeycrisp data.
  The shared opener handles the old OPFS refusal. Do not restore rename, move,
  mkdir, or Git operations that the mirror does not offer.
- Opening or listing a note writes nothing. `folder.files` and table rows show
  landed values. Await `Saved` before opening a newly created file or relying
  on a write in an action.
- Text inputs and selects use one `draft(source, save)` per editor component,
  including titles and folder selection. Every change enters the folder queue
  immediately. The draft shows typed input until its save lands, then follows
  the mirror. A failed save keeps the typed value and shows `<UnsavedEdit>`
  beside its editor with Save again,
  Discard, and Copy. Command callers report their own failed writes.
- Row patches use `tables.x.update(id, { fields?, body? })`; whole-file edits
  use `folder.write(path, text)`. A patch saves over the file as it is when
  sent. Canonical frontmatter keeps declared keys in schema order, then other
  keys sorted; comments and original key order do not survive a patch.
- A save moves no timestamp (ADR-0573). The list orders by `createdAt`.
- The folder writes lone surrogates as U+FFFD, and its copy shows the same
  text. The rich editor also replaces them in its transaction, so its undo
  history matches. Note bodies use line
  feeds (ADR-0572); whole-file editing uses `fileDraft` to keep the file's
  line endings.
- The mirror refreshes from another tab through its change hints. Opening
  reads text files. Read errors offer `refresh()` as Try again.
- There are no versions or sync. A note that does not parse is listed for
  repair and opens as text. `readRow(raw.value, schema)` checks typed repair
  text before it saves. Folder deletion refuses when any note's relation
  cannot be read.

## Editor ownership

- `NoteDetail` owns one body draft shared by its Rich text and Source views.
  ProseMirror's `EditorState` owns cursor, pending formatting, undo history,
  and an empty paragraph Markdown cannot spell. `stateAfter` validates a
  changed document, calls `body.set`, then shows it. `stateShowing` preserves
  state for equivalent content and replaces it when the shown body changes.
- A failed rich-text save keeps the typed body visible until the person retries,
  discards, or edits again.
- Do not weaken `checkNoteDoc`. Fix the Markdown serializer and add tests if
  an edit ought to be spellable. New nodes or marks need both Markdown
  directions and tests.
- The rich editor mount effect depends only on its element and `editable`
  boolean. Reading save or row changes there recreates it and loses history.
- Switching between note fields and the whole-file editor changes the view
  immediately. Earlier typed input is already in the folder queue. The
  whole-file editor follows the mirror as those writes land.

## Lifecycle and boundary

- `<OpenFolder>` from `@epicenter/svelte/open-folder` opens, wraps, refreshes,
  and closes the folder. The page passes its folder to
  `HoneycrispApp`, which creates the `notes` state and provides context.
- Shared imports use `@epicenter/folder`; Vite selects the platform
  opener. Do not import Bun or Node modules under `src/`.
- The host build opens the desktop shell's granted directory through the
  same component. Browser tests fault `fake-indexeddb` storage.

## Words a person reads

Say note, folder, file, saved, and browser. Do not put `entry`, `buffer`,
`scope`, `shell`, `baseline`, `canonical`, `draft`, or `row` in UI copy.
