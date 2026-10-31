# Honeycrisp App

Markdown notes over Honeycrisp's file contract. Read [the README](README.md)
for the layout and page flow, and verify it against the code.

## The files are the data

- Honeycrisp has two variants, chosen at build time by the `#platform/root`
  seam (`package.json` "imports"), never a run-time check: the online web
  app (`root.ts`: `openRemote` from `@epicenter/folder/remote` behind
  sign-in) and the desktop app (`root.tauri.ts`: the window's folder through
  `openDevice` from `@epicenter/folder/tauri`, which never signs in). Every
  read and write goes through the contract's client, one store per page: the
  variant's `Root` sets it (`setRepo`) and the page passes it to
  `HoneycrispApp` through `fromClient(getRepo())`. The web app keeps
  nothing in the browser: no device, OPFS, uploader, or service worker
  (ADR-0700). Components take the state from context and never import a
  client or know which store they are over; only the header's `Chrome`
  says. Leaves and the components they import use relative imports, not
  `$lib`, so `platform.test.ts` can bundle them. Do not add another store,
  cache, or save queue.
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
