# Honeycrisp App

Markdown notes in a repository on this device (`@epicenter/repository`),
synced when the build names a server. Read [the README](README.md) for the
current page flow and verify it against the code.

## The repository is the data

- The repository's files are the saved data. Do not add another durable
  store, browser-storage copy, import step, or app save queue.
- Do not add Yjs, a CRDT, or an account. Nothing in `src/` may import `@y/*`,
  `yjs`, `@epicenter/auth`, or `@epicenter/sync`. The bundle test checks this.
- Do not add a migration or compatibility path for earlier Honeycrisp data.
- Reads are live queries (`live` from `@epicenter/repository/svelte`); the
  open note is held open (`opened`). Writes go through the repository's
  handles, apply at once, resolve once saved on the device, and are reported
  with `report` when they cannot be saved. What the server later does with a
  saved write is a notice (`repo.notices`), shown by `Notices.svelte`; never
  wait for the server in an action.
- A write names only the fields and body it changes. Never rewrite a whole
  note to change part of it.
- A save moves no timestamp (ADR-0573). The list orders by `createdAt`.

## Editor ownership

- `src/lib/editor/` owns the CodeMirror editor and imports nothing from
  Honeycrisp's UI; `NoteDetail` gives `NoteEditor` a body source.
- The editor's state owns the cursor and the undo history. Its mount depends
  on nothing reactive; changes from elsewhere arrive through `follow`, as
  `Transaction.remote` changes outside the history.
- Local changes write with `note.edit(body)`, never `write({ body })`, so a
  change that arrived while typing is merged, not replaced. Write the text
  with `state.sliceDoc()`, which keeps the body's line breaks.

## Lifecycle and boundary

- `OpenHoneycrisp` opens the repository, shows Try again on failure, and
  closes it on unmount. `HoneycrispApp` creates the `notes` state and provides
  the repository through context.
- Do not import Bun or Node modules under `src/`. Tests use
  `src/lib/repository.test-support.ts`, the real engine on `bun:sqlite` with a
  scripted server.

## Words a person reads

Say note, folder, file, saved, and browser. Do not put `entry`, `buffer`,
`scope`, `shell`, `baseline`, `canonical`, `draft`, `row`, `lens`, or
`outbox` in UI copy.
