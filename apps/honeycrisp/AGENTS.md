# Honeycrisp App

Markdown notes over Honeycrisp's file contract. Read [the README](README.md)
for the layout and page flow, and verify it against the code.

## The files are the data

- Honeycrisp has two variants, one store each, and the build picks it,
  never a run-time check
  ([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)):
  `src/lib/app.ts` exports `folder`, one
  `openFolder(honeycrisp, { site, account })`, which is the signed-in
  person's repository in the web build and the window's folder on the
  desktop, which never signs in. Every read and write goes through it:
  components import `folder` from `$lib/app.js` and read `folder.notes` and
  `folder.folders`. Only `app.ts` opens the store; components never import
  a client or know which store they are over, and only the header's
  `Chrome` (`#platform/chrome`) says. The web app keeps nothing in the
  browser: no device, OPFS, uploader, or service worker (ADR-0700). Seam
  leaves use relative imports, not `$lib`, so `platform.test.ts` can bundle
  them. Do not add another store, cache, or save queue.
- A change to the layout is a change to `src/lib/contract.ts`, then
  `bun run contract`; the fit test fails until the two agree. No migration or
  compatibility code: there is no earlier data to read (decision 72).
- A note's id is its file name; Honeycrisp mints it with `timeId()`. A note
  names its folder by id; deleting a folder never touches its notes.
- Deletes are real. There is no trash and no `deletedAt`.

## Editing

- The open note's title, body, folder and pin go through its one editor
  (`folder.notes.edit({ id })`, every value read and bound through
  `edit.fields`), with `<UnsavedEdit>` beside it. The list's commands (folder,
  pin) and Delete call the notes' `update` or `delete` and say when they
  fail.
- `NoteEditor.svelte` owns CodeMirror's state for as long as it is mounted:
  its mount reads nothing reactive, and a body that changes from elsewhere is
  applied as the smallest edits outside Undo (`applyExternal`). Do not make
  the mount depend on props; that recreates the editor and loses history.
- The editor edits the Markdown text itself. Live preview only decorates; it
  never changes the text to show something.
- A file that does not read is repaired with `replace` from its text
  (`RepairDetail.svelte`), never with field edits.

## Words a person reads

Say note, folder, file, saved, browser and repository. Do not put `entry`,
`buffer`, `scope`, `shell`, `baseline`, `canonical`, `draft`, `row`, `side`
or `collection` in UI copy.
