# Honeycrisp App

Markdown notes over Honeycrisp's file contract. Read [the README](README.md)
for the layout and page flow, and verify it against the code.

## The files are the data

- Honeycrisp has two stores, and `home` from `@epicenter/folder` picks one
  where the page runs; the app never asks which platform it is on
  ([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md),
  [ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)):
  `src/lib/app.ts` exports `folder`, one
  `openFolder(honeycrisp, home({ site, account }))`, which is the signed-in
  person's repository in a browser and the window's folder in a Tauri
  window, which offers no sign-in yet. Every read and write goes through it:
  components import `folder` from `$lib/app.js` and read `folder.notes` and
  `folder.folders`. Only `app.ts` opens the store; components never import
  a client or know which store they are over, and only the header says,
  branching on `folder.reveal` (`FolderChrome` or `RepositoryChrome`). One
  build serves the web and the desktop. The web app keeps nothing in the browser: no device, uploader, or service
  worker (ADR-0700). Do not add another store, cache, or save queue.
- A change to the layout is a change to `src/lib/contract.ts`, then
  `bun run contract`; the fit test fails until the two agree. No migration or
  compatibility code: there is no earlier data to read (decision 72).
- A note's id is its file name (ADR-0776); Honeycrisp mints it with
  `timeId()` and never renames a note: a title is a field. A note
  names its folder by id; deleting a folder never touches its notes.
- Deletes are real. There is no trash and no `deletedAt`.

## Editing

- The open note's title, body, folder and pin go through its one editor
  (`folder.notes.edit({ id })`, every value read and bound through
  `edit.fields`). The list's commands (folder, pin) and Delete call the
  notes' `set` or `delete`. Writes never fail (ADR-0775): there is no error
  branch at a write and no failed-save UI; `<WhenOpen>` says when the store
  cannot be reached.
- `NoteEditor.svelte` owns CodeMirror's state for as long as it is mounted:
  its mount reads nothing reactive, and a body that changes from elsewhere is
  applied as the smallest edits outside Undo (`applyExternal`). Do not make
  the mount depend on props; that recreates the editor and loses history.
- The editor edits the Markdown text itself. Live preview only decorates; it
  never changes the text to show something.
- A file that does not read is repaired through its editor's whole `text`
  (`RepairDetail.svelte`), never with field edits.

## Words a person reads

Say note, folder, file, saved, browser and repository. Do not put `entry`,
`buffer`, `scope`, `shell`, `baseline`, `canonical`, `draft`, `row`, `side`
or `collection` in UI copy.
