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
  handles, apply at once, and are reported with `report` when they do not
  land. Never await a write's `Pending` in an action: without a server it
  never settles.
- A write names only the fields and body it changes. Never rewrite a whole
  note to change part of it.
- A save moves no timestamp (ADR-0573). The list orders by `createdAt`.

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
