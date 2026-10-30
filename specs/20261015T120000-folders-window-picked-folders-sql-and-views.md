# The Folders window: picked folders, SQL, editors, and views

**Status**: Draft
**Date**: 2026-10-15

## Goal

The Epicenter desktop app's Folders window edits Epicenter data folders in a
grid. Matter, a separate grid, board, and SQL console over Markdown rows with
its own `matter.json`, Rust watcher, and SQLite mirror, was deleted before the
Folders window reached parity; Git history keeps it. This spec records what the
Folders window still needs to cover that work.

## Already decided

- **How folders open (ADR-0535, ADR-0583).** `openFolder({ app, definition })`
  publishes an application's code definition only to the folder named after
  it; `openFolder({ id })` opens a folder that already exists with its own
  `epicenter.json`, never writes it, and creates nothing. Several windows may edit one folder; the shell compares
  and publishes every save under one mutex per root.
- **`epicenter.json` is a generated, portable contract.** A folder no
  application owns declares itself in `epicenter.ts` and runs
  `epicenter generate` (ADR-0527).
- **The Folders window** lists the data folders under the Epicenter root and
  edits rows in a grid.
- **One SQL projection** (`projectTables` in `@epicenter/folder`, over any
  database that can run a statement and a transaction): `epicenter query`
  builds it over `bun:sqlite`, and a page can build the same tables.
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
   Matter's `recognize` did.
4. **Views and the board.** Matter kept `views` in `matter.json`, which
   `epicenter.json` has no place for. Decide whether a saved view (a query, a
   layout, a grouping field) is a file in the folder, such as
   `views/<name>.view.yaml`, shared and versioned, or the window's own state.
   Build them when a folder needs them.

## Order

This work continues on the same long-lived branch as the folder engine,
which reaches `main` only once its deploy gate holds (merging to `main`
deploys the API and its Durable Object migrations). In order: the Vault opens
through `openFolder({ root })` and closes its tables (its own repository);
picked folders (1); SQL (2) and editors (3); views and the board (4).

## Open question

Views as files in the folder or as the window's state (item 4). A file is
shared, versioned, and writable by an agent; state is personal and adds
nothing to the folder.
