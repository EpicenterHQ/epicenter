# The Folders window replaces Matter

**Status**: Draft
**Date**: 2026-10-15

## Goal

Matter (`apps/matter`, `@epicenter/matter-core`) is a grid, board, and SQL
console over Markdown rows, with its own schema format (`matter.json`), its
own Rust watcher, and its own SQLite mirror. Its job moves into the Epicenter
desktop app's Folders window, over Epicenter data folders, and Matter is
deleted.

## Already decided

- **How folders open (ADR-0535).** `openFolder` opens an
  application's own data with its code definition; `openDataFolder` opens a
  folder that already exists with its own `epicenter.json`, never writes it,
  and creates nothing. Several windows may edit one folder; the shell compares
  and publishes every save under one mutex per root.
- **`epicenter.json` is a generated, portable contract.** A folder no
  application owns declares itself in `epicenter.ts` and runs
  `epicenter generate` (ADR-0527).
- **The Folders window** lists the data folders under the Epicenter root and
  edits rows in a grid.
- **One SQL projection** (`projectTables` in `@epicenter/folder`, over
  `@epicenter/sqlite`'s handle): `epicenter query` and a page build the same
  tables.
- **Closed tables** report undeclared keys (ADR-0536).

## What is left

1. **Folders a person picks.** The shell's own dialog, a grant recorded so it
   survives a restart, and an opaque grant to the page. Needed for the Vault
   at `~/Code/vault`.
2. **SQL in the Folders window.** A page builds `projectTables` over
   sqlite.org's WASM build and runs the same read-only statements `query`
   accepts; the grid's filter is a `WHERE` clause over it.
3. **Field editors from the schema's shape.** `fieldEditorOf` falls back to
   the JSON editor when a field has no `x-field` hint, so plain TypeBox fields
   edit as JSON. Infer the kind from the shape when there is no hint, as
   Matter's `recognize` does.
4. **Views and the board.** Matter keeps `views` in `matter.json`, which
   `epicenter.json` has no place for. Decide whether a saved view (a query, a
   layout, a grouping field) is a file in the folder, such as
   `views/<name>.view.yaml`, shared and versioned, or the window's own state.
5. **Delete Matter.** Move `packages/app`'s `parseMarkdown` and `editField`
   imports, if `@epicenter/app` survives ADR-0534, then delete `apps/matter`
   and `@epicenter/matter-core`, and amend ADR-0420.

## Order

This work continues on the same long-lived branch as the folder engine,
which reaches `main` only once its deploy gate holds (merging to `main`
deploys the API and its Durable Object migrations). In order: the Vault opens
through `openDataFolder({ root })` and closes its tables (its own repository);
picked folders (1); SQL (2) and editors (3); views and the board (4); delete
Matter (5).

## Open question

Views as files in the folder or as the window's state (item 4). A file is
shared, versioned, and writable by an agent; state is personal and adds
nothing to the folder.
