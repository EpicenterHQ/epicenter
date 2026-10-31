# Honeycrisp App

Markdown notes over Honeycrisp's file contract. Read [the README](README.md)
for the layout and page flow, and verify it against the code.

## The files are the data

- Honeycrisp is online web only for now (a desktop app comes later). Every
  read and write goes through the contract's client, one store per page:
  `openRemote` from `@epicenter/folder/remote`, set by the signed-in layout
  (`src/routes/(app)/+layout.svelte`, `setRepo`) and passed by the page to
  `HoneycrispApp` through `fromClient(getRepo())`. Nothing is kept in the
  browser: no device, OPFS, uploader, or service worker (ADR-0700).
  Components take the state from context and never import a client, so a
  later variant is a new root. Do not add another store, cache, or save
  queue.
- A change to the layout is a change to `src/lib/contract.ts`, then
  `bun run contract`; the fit test fails until the two agree. No migration or
  compatibility code: there is no earlier data to read (decision 72).
- A note's id is its file name; Honeycrisp mints it with `timeId()`. A note
  names its folder by id; deleting a folder never touches its notes.
- Deletes are real. There is no trash and no `deletedAt`.

## Editing

- Text a person types (the title, the body) goes through `fieldEdit`, one per
  field per open note, with `<UnsavedEdit>` beside it. Commands (folder, pin,
  delete) call the list's `update` or `delete` and say when they fail.
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
