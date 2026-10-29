# Honeycrisp App

Markdown notes in a repository (`@epicenter/repository`): a lens and a
Svelte root that the web shell (`apps/web`) mounts over whichever repository
its URL names, synced when it has a server. Read [the README](README.md) for the
current page flow and verify it against the code.

## The repository is the data

- The repository's files are the saved data. Do not add another durable
  store, browser-storage copy, import step, or app save queue.
- Do not add Yjs, a CRDT, or an account. Nothing in `src/` may import `@y/*`,
  `yjs`, `@epicenter/auth`, or `@epicenter/sync`. The shell's bundle test (`apps/web/src/lib/bundle.test.ts`) checks this.
- Do not add a migration or compatibility path for earlier Honeycrisp data.
- Notes and folders are read from page memory (`repo.notes.all()`,
  `get()`, tracked by `reactive`). Writes go through the repository (`create`,
  `patch`, `delete`, `commit`), show at once, resolve once saved on the
  device, and are reported with `report` when they cannot be saved; never
  wait for the server in an action.
- A field control sets only its field (`patch`); the body is written through
  the note's editor. Never rewrite a whole note to change part of it.
- A save moves no timestamp (ADR-0573). The list orders by `createdAt`.

## Editor ownership

- `src/editor/` owns the CodeMirror view and imports nothing from
  Honeycrisp's UI. `FileDetail` opens the note's one editor (`openEditor`)
  and gives it to `NoteDetail`'s body view and to the source view.
- The view's state owns the cursor and the undo history. Its mount depends
  on nothing reactive; `editorBinding` hands local changes to the editor and
  applies changes from elsewhere as `Transaction.remote` changes outside the
  history.

## Lifecycle and boundary

- The shell opens the repository and puts `HoneycrispApp` under the
  repository gate, which mounts it once. This package has no routes. `HoneycrispApp` creates the
  `notes` state and provides the repository through context.
- Do not import Bun or Node modules under `src/`. Tests use
  `src/repository.test-support.ts`, the repository API on a replica on
  `bun:sqlite`, with no server.

## Words a person reads

Say note, folder, file, saved, and browser. Do not put `entry`, `buffer`,
`scope`, `shell`, `baseline`, `canonical`, `draft`, `row`, `lens`, or
`outbox` in UI copy.
