# Matter on Epicenter data folders

**Status**: Draft
**Date**: 2026-10-14

## Goal

Matter stays a product: a grid, board, row editor, and SQL console over a
folder of Markdown rows. It stops being a second data model. It reads any
Epicenter data folder (a directory with `epicenter.json`, ADR-0517) through
`@epicenter/folder`, edits rows through the same guarded writes every
application uses, and runs as an installed application in the Epicenter
desktop host instead of its own Tauri shell. `@epicenter/matter-core` and the
`matter.json` format are deleted at the end.

The Vault is the first real folder: it already declares six tables in
`epicenter.ts` and reads and writes them only through `@epicenter/folder`.

## Decisions taken

- **Placement:** an installed application in the desktop host, not a
  standalone shell.
- **One query engine:** the SQL console and the grid's filters read the
  projection `epicenter query` reads. Done in #2526: `projectTables` in
  `@epicenter/folder`, over `@epicenter/sqlite`'s handle, so the WebView builds
  it with sqlite.org's WASM build.
- **Edits are guarded:** a cell or body edit saves through the folder's
  `replace` with the capture it read, so an edit from another writer since
  then is `Conflict`, never silently overwritten. Matter today reads, edits,
  and writes with no check between.
- **Undeclared keys:** a table may close with `additionalProperties: false`
  (ADR-0533, #2524), which replaces Matter's extras report.

## What maps directly

| Matter | Epicenter |
| --- | --- |
| `matter.json` per table, `optional` list | `epicenter.json`, `required`, `field.optional` |
| `read_entry`, `editField`, `write_entry` | `get`, `formatRow`, guarded `replace` |
| `recognize` (13 kinds from schema shape) | `fieldEditorOf` (the same 13 kinds from `x-field` hints) |
| `mirror.rs`, `.matter/matter.sqlite` | in-memory `projectTables`, rebuilt on read |
| `watch_folder` (arm, scan, send) | `onFilesChanged` subscribed before the first read |

## Phases

Each phase is one pull request that leaves Matter working.

1. **Shared projection.** Done (#2526).
2. **Field editors on `fieldEditorOf`.** Swap the registry's `Kind` import;
   the 13 kinds match. Decide the hintless case first (open question 3).
3. **Reads, writes, and watching through the folder package,** still in
   Matter's shell, behind the existing mounted and e2e tests with a folder
   mock in place of the hand-copied IPC mock. Delete `watch.rs`, `entry.rs`,
   `mirror.rs`, `assess`, and `matter.json` handling.
4. **Host placement.** The path grant below, then Matter as an installed
   application. Delete `apps/matter/src-tauri`.
5. **Delete `@epicenter/matter-core`.** Move `packages/app`'s
   `artifact/frontmatter.ts` (`parseMarkdown`, `editField`) and
   `apps/epicenter`'s uses onto the folder package, then amend ADR-0420.

## Open questions

1. **How an application opens a folder the person chose.** The host never
   gives a page a path (`apps/epicenter/AGENTS.md`, ADR-0201), and an
   application's folder scope is its ID at `<folderDir>/<app-id>`. The seam
   that keeps that rule: Rust opens the native folder dialog itself,
   registers the chosen root as a new scope for that window, persists the
   grant so it survives a restart, and returns only the scope ID, so
   `openFolder({ id })` is unchanged. This is the first per-window path
   grant, so it needs an ADR beside ADR-0201, ADR-0334, ADR-0402, and
   ADR-0517, with a decision on whether the host requires `epicenter.json`
   before registering.
2. **A data folder inside another repository.** The native owner initializes
   Git at a root with no `.git`, so a data folder in a subdirectory of a
   repository would get a nested repository. ADR-0517 lists this as unbuilt.
   The Vault is a repository root, so it is not blocked; nested folders are.
3. **Fields declared without hints.** `fieldEditorOf` falls back to the JSON
   editor when a field has no `x-field` hint, so the Vault's plain TypeBox
   fields would all edit as JSON. Either declarations use the `field.*`
   helpers (the Vault would switch), or `fieldEditorOf` infers the kind from
   the schema shape when there is no hint, as `recognize` does.
4. **Board views.** Matter keeps `views` in `matter.json`; `epicenter.json`
   holds only `title`, `kv`, and `tables`. A board's grouping field is a view
   preference, not data: keep it in the application's own state, or drop the
   board until there is a home for views.
5. **A row with a missing required field.** Matter shows the row with an
   empty cell to fill; the folder package reads it as `InvalidRow`, repaired
   as text. Show invalid rows read-only with their issues and a text editor
   (as Todos does), or relax the grid to edit them per field.
6. **Reference verdicts.** Matter marks a reference whose row does not
   exist; Epicenter checks no reference integrity (folder README). A verdict
   over `list()` results needs only stems, so it could live in the grid
   without returning to the folder package. Keep or drop.
7. **Git side effects.** An opened folder records history and publishes
   `epicenter.json`. For a folder another tool owns, such as a Vault, decide
   whether opening it in the host should commit, or read and write files
   only.
