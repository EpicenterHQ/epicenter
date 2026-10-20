# 0648. A folder's saved views live in its optional epicenter.json

- **Status:** Proposed
- **Date:** 2026-10-20
- **Amends:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at the folder declaration's schema-only purpose: generic views share that file, and the generic editor can interpret files without a declaration; the v1 CLI requirement for declared schemas remains.
- **Relates:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) separates portable records from machine state; [ADR-0641](0641-epicenter-remembers-folders-as-machine-local-paths.md) keeps remembered paths on this machine; [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md) binds one directory to a native editor window.
- **Unbuilt:** the Tables UI, observed-column discovery, grid and board editing, desktop SQL, saved-view persistence, app-schema export and import, and declaration readers that accept optional tables and views.

## Context

The general editor in `apps/epicenter/src/folders/Editor.svelte` opens a
Folder with no table schemas and displays files. Apps such as Todos supply
TypeBox schemas from application code. The CLI's `check` and `query` read
declared table schemas from the folder's root `epicenter.json`.

A general table editor needs to remember columns, sorting, grouping, and SQL
queries. Storing these centrally would require another mapping from a saved
view to a directory on each computer. Making views an ordinary record table
would add a table schema and discovery rules for the editor's own metadata.
Both schemas and saved views describe how to work with one folder's files.

## Decision

**A folder keeps its schemas and saved views in one optional root `epicenter.json`.**
The declaration retains `title`, `local`, and `tables` and adds `views`.
`tables` maps top-level directory names to frontmatter object schemas.
`views` maps stable, folder-local view names to named grid, board, or SQL
configurations. Each view has a display title and a type. Grid views name a
table and retain columns, filtering, and sorting. Board views name a table
and a supported grouping field. SQL views retain one read-only SQL statement.
These are configuration records in the JSON file, not another Markdown table.

`tables` and `views` are independently optional. No declaration means no
declared expectations and no saved views. Opening or browsing a folder
creates neither the file nor a Git repository. Saving the first named view
creates the declaration if it is absent, without inventing table schemas.
Saving a view preserves existing schemas, other views, title, and `local`
rules. An unusable existing declaration remains accessible for repair and
is never replaced with defaults.

**Files and Tables use the same folder and its existing edit lifetime.**
Files edits complete source text. Tables offers grid, board, and read-only
SQL over one shared reading of Markdown records, including diagnostics.
Without a declared schema, columns come from observed frontmatter fields;
missing fields are absent values, and observation establishes no required
fields or validation rules. Declared schemas add expectations and editor
hints. Malformed files stay accessible in Files, and SQL reports files it
omits. SQL results do not introduce another write path. A SQL run builds a
disposable projection from saved files; it is not a continuously maintained
database or a projection of unfinished typing.

The first delivery is grid and read-only SQL. Saved-view persistence follows;
board grouping reuses the same table reading and edit machinery. The CLI's
v1 `check` and `query` continue to require declared schemas until their
reader contract changes explicitly. Schema-free desktop SQL does not imply
that the existing CLI already supports schema-free queries.

**An app's schema enters a folder only through an explicit import.**
An app keeps its runtime schema and developer types in application code.
Its distribution can export JSON schemas from that same source. Import
installs selected table definitions in `epicenter.json` without replacing
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
- A shared JSON file means unrelated view and schema edits can conflict.
  Invalid JSON prevents reading either section. Source remains available
  for a person or agent to repair; readers do not substitute an empty file.
- Declaration readers must accept `views` without treating it as a table
  schema. The existing parser rejects that key, so the storage format must
  change before any product writes it.
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
