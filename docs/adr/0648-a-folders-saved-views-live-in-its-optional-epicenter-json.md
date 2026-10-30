# 0648. A folder's saved views live in its optional epicenter.json

- **Status:** Proposed
- **Date:** 2026-10-20
- **Amends:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at the folder declaration's schema-only purpose: generic views share that file, and the generic editor can interpret files without a declaration; the v1 CLI requirement for declared schemas remains. Amends [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) at deferring generic structured desktop tools: grid, board, saved views, and read-only SQL are implemented optional clients.
- **Relates:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) separates portable records from machine state; [ADR-0641](0641-epicenter-remembers-folders-as-machine-local-paths.md) keeps remembered paths on this machine; [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md) binds one directory to a native editor window.
- **Unbuilt:** a schema-distribution service.

## Context

The general editor in `apps/epicenter/src/folders/Editor.svelte` opens a
Folder with no table schemas. Its Files, grid, board, and SQL presentations
share that handle. Apps such as Todos supply TypeBox schemas from application
code. The CLI's `check` and `query` read
declared table schemas from the folder's root `epicenter.json`.

A general table editor needs to remember columns, sorting, grouping, and SQL
queries. Storing these centrally would require another mapping from a saved
view to a directory on each computer. Making views an ordinary record table
would add a table schema and discovery rules for the editor's own metadata.
Both schemas and saved views describe how to work with one folder's files.

## Decision

**A folder keeps its schemas and saved views in one optional root `epicenter.json`.**
The declaration retains `title` and `tables` and adds `views`.
`tables` maps top-level directory names to frontmatter object schemas.
`views` maps opaque, folder-local keys to grid, board, or SQL configurations.
The editor creates UUID keys. Each view has a display `title` and a `type`;
renaming the title keeps the key. Grid and board views name one top-level
directory in `table`, whether or not `tables` declares a schema for it. They
retain columns, filters, and ordered sorting. Boards also name `groupBy`.
SQL views retain one read-only SQL statement.
These are configuration records in the JSON file, not another Markdown table.

`tables` and `views` are independently optional. No declaration means no
declared expectations and no saved views. Opening or browsing a folder
creates neither the file nor a Git repository. Saving the first named view
creates the declaration if it is absent, without inventing table schemas.
View settings remain in the window until an explicit save. Saving a view
preserves existing schemas, other views, and title. An unusable
existing declaration remains accessible for repair and is never replaced with
defaults. A schema-free saved view does not imply a schema-free CLI query.

**A structured view save compares and changes one keyed entry.**
`SavedViewChange` carries the key, its starting entry, and its desired entry.
A conditional file write rereads and reapplies the patch after a stale result.
Changes to siblings survive. A different change to the target entry requires
reloading or saving a new copy; an already-present desired entry confirms a
retry. Deletion follows the same comparison. Invalid or future view entries
remain in source with diagnostics while valid siblings stay available.

**One TypeBox schema in `@epicenter/folder` owns the portable declaration format.**
Its static TypeScript document type, runtime shape validation, and exported JSON
Schema come from that source. The schema describes the document envelope and
saved-view variants; the table schemas inside it describe row frontmatter.
Applications keep their own TypeBox row schemas and inferred developer types.
Importing JSON at runtime does not create compile-time types for an app.

Readers share the envelope definition and interpret only the sections they
need. Git history interprets no declaration sections, so unusable table schemas
or saved views cannot block exchange. Meaning that depends on files, such as
table and field references or SQL restrictions, remains an explicit semantic
check after structural validation.

The retained `generate` command and schema imports use conditional section
updates that preserve views. Schema import changes only the table definitions supplied by its
source. Whole-file source editing and Git synchronization still merge JSON by
line; the keyed view operation does not redefine that file merge.

**Files and Tables use the same folder and its existing edit lifetime.**
Files edits complete source text. Tables offers grid, board, and read-only
SQL over one shared reading of Markdown records, including diagnostics.
Without a declared schema, columns come from observed frontmatter fields;
missing fields are absent values, and observation establishes no required
fields or validation rules. Declared schemas add expectations, missing-property
columns, and scalar editor hints. Malformed files stay accessible in Files.
SQL names unreadable and non-text files it omits, while readable malformed
frontmatter remains queryable with diagnostics. SQL results introduce no write
path. A run builds a disposable projection from saved files, independent of
unfinished typing.

Within the generic editor, switching Files, grid, board, or SQL keeps the open
Folder and its unfinished file drafts. Grid cells and board moves use that
same path-keyed draft owner. A board move changes only its grouping field;
it creates no card-rank record. Filter and sort rules read saved values rather
than unfinished cell input. Separate app views can open their own handles over
the same files. A declaration contains no live handle, native label, open-tab
position, or window layout. Placement and cleanup belong to the host. The
current native binding is per window under ADR-0647; tabbed presentation must
preserve the editing lifetime without changing this portable format.

Clean view settings follow changes read from the declaration. Edited settings
retain their starting entry and working copy across view selection and external
changes. Each SQL view owns its running statement, result, and error separately.
These are window state, not declaration fields. Before a structured view write,
the editor drains the declaration's raw source draft and holds source editing
read-only through the write and reread. A failed source save prevents that
structured write and retains the source for repair.

Boards use typed scalar destinations. String, number, boolean, and null values
remain distinct even when their labels match. Enum and boolean hints preserve
empty lanes. **No value** represents an absent field. Object and array values
appear in **Other**, which cannot be chosen as a move destination. Moving a
card uses the normal field-save path, including its visible failure, retry, and
discard behavior.

The generic SQL relation is `documents(path, directory, stem, fields, body,
issues)`, with fields and issues encoded as JSON. This keeps arbitrary field
names and mixed values without inventing SQL column types from observation.
Grid and SQL use the same saved-document reader, including optional declared
schema diagnostics. A declared table covers direct `<table>/<file>.md` rows,
matching app and CLI membership; root and nested Markdown remain browsable
without that schema. The native SQL capability takes a statement only; the shell
derives the bound directory. SQL has no editable result path.

Saved-view writing is a narrow Tauri capability over the calling window's bound
folder. The generic editor is a desktop client; no browser writer or generic
browser product is implied. The CLI's v1 `check` and `query` continue to require
declared schemas until their reader contract changes explicitly. Schema-free desktop SQL does not imply
that the existing CLI already supports schema-free queries.

**An app's schema enters a folder only through an explicit import.**
An app keeps its runtime schema and developer types in application code.
Its distribution can export JSON schemas from that same source. Import
installs source table definitions in `epicenter.json` without replacing
unrelated declarations or records. A conflicting table definition requires
an explicit replacement choice. Opening, saving, installing, or updating an
app does not publish or update folder schemas. The imported definition is
an independent copy. A Git commit containing that file carries the copy to
the folder's remote like its other shared files.

**A saved view travels with the folder it describes.**
Table names and view references are relative to that folder. A view stores
no native directory path, account, remote URL, or central folder ID.
Copying or syncing the folder carries its saved views. People sharing the
folder share those views; there is one persistence scope, with no personal
override layer. Machine-local remembered paths remain in AppData's
`folders.json`. Epicenter's portable records live in its selected data folder,
initially `so.epicenter` under the authored folder root. Merely placing a folder
under that root does not configure a Git remote or start synchronization.

## Consequences

- One declaration reader and writer handle folder schemas and view settings.
  There is no separate view database, view-table schema, or view-to-path map.
- Grid, board, and SQL share file interpretation and diagnostics. They do not
  maintain separate copies of the folder's records.
- Application upgrades and folder-schema changes have separate lifetimes.
  An imported schema can lag the app until someone imports a replacement.
- Conditional section writes preserve concurrent sibling edits and expose
  conflicts in the same view entry. Whole-file source edits and Git merges can
  still produce invalid JSON. Source remains available for repair; readers do
  not substitute an empty file.
- Section readers isolate unusable table schemas and view entries. Invalid JSON still prevents reading the document. A future view
  entry does not prevent using a valid sibling or copying the source.
- Saved views are shared folder content. Private per-person views and
  editable SQL results are outside this model.

## Considered alternatives

- **One Markdown file per saved view.** Reuses row storage but introduces a
  metadata table and its discovery rules before concurrent view editing
  establishes a need for independent records.
- **A separate views JSON file.** Isolates malformed view JSON from schemas,
  but adds another folder configuration file and loading path.
- **All views in `so.epicenter`.** Keeps views personal but requires target
  folder references that survive moves and different paths on each device.
- **Automatic app-schema publication.** Couples an app update to writes in
  every folder the app opens and requires rules for preserving local edits.
- **Require a declaration to browse tables.** Makes schemas an admission
  requirement for a view that can display the fields already in the files.
