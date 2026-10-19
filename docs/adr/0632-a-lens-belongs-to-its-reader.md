# 0632. Readers select schema files independently of data

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md), and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) only where repository descriptions determine generic table discovery or a reader's lifetime.
- **Relates:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) (CLI readers), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (schema-independent saves).
- **Unbuilt:** explicit schema-file input in the CLI and the later Epicenter desktop app; separate registry acquisition; browsing without a schema file; reader-scoped conformance diagnostics; preserving drafts through schema file changes; and migration of current declaration-dependent readers and application openers.

## Context

The former `epicenter.ts → epicenter generate → epicenter.json` workflow is
preserved in superseded [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md).
It generated a declaration alongside the data. The chosen design separates
the schema artifact from the folder being read; the older generator remains
implemented until its callers migrate.

Whispering declares its recording and transcription fields in
`apps/whispering/src/lib/definition.ts`. It already brings the knowledge
needed to read its files. The internal browser engine accepts caller-supplied
schemas in `packages/data/src/repository.ts`; its saves do not validate
against those schemas.

Applications still use `@epicenter/folder`. Its opener reads a root
description or publishes the owning app's definition. `readFolder` requires
`epicenter.json` before inspecting tables. The existing Epicenter desktop app derives its
tables from that description and reopens the folder when it changes.

ADR-0585 originally made the root description optional for apps. The
earlier table.json rule in ADR-0613 instead made a per-table file the marker
for generic tools. ADR-0611 and ADR-0626 carried that rule into the desktop
app and CLI. Both arrangements supplied a repository-stored default
interpretation. Several apps can use the same files while holding
different expectations about their fields.

Schema selection belongs to the reader. ADR-0613's flat row
paths, row attachment directories, key ordering, and schema-independent
saves remain. ADR-0626's caller-supplied read schemas remain. Authentication,
repository identity, Git transport, and merge behavior are unchanged.

## Decision

**A schema file supplies named table schemas to the reader that selects it.**
Its `tables` map pairs top-level directory names with JSON Schemas for row
frontmatter. Each schema checks the frontmatter object, not the complete
API `Row` wrapper. The file contains a map of schemas, not one JSON Schema
for the whole repository.

```json
{
  "tables": {
    "recordings": {
      "type": "object",
      "properties": { "title": { "type": "string" } }
    }
  }
}
```

Table keys name actual directories. There are no aliases, computed fields,
transforms, or migration instructions. Supported schemas follow the reader's
schema support; the filename promises no additional JSON Schema features.
Apps supply read schemas from code. The CLI can select a local schema file;
the deferred Epicenter desktop app can do the same later. A schema file
grants no access and configures no data identity or ignored files.

```text
voice-notes/                    data repository
    recordings/<id>.md
    transcriptions/<id>.md

whispering-schema.json          obtained separately, outside the data folder
    tables.recordings          JSON Schema for recording frontmatter
    tables.transcriptions      JSON Schema for transcription frontmatter
```

**No schema file is required to open, save, sync, or browse the files.**
Neither `epicenter.json` nor `table.json` identifies data or establishes a
directory's status as a table. Apps name the directories they use; a selected
schema file names those a generic reader presents as tables. Files remain
available without schemas. The later Epicenter desktop app can inspect
source and raw frontmatter without inventing field meanings. Selecting
schemas never hides files outside the named tables.

**Schema files are obtained separately from the data they interpret.**
A person can obtain a schema file from a registry, an app's distribution,
or a local file they authored or copied. The reader keeps that artifact
outside the data folder. Registry acquisition is an explicit step; reading
an already obtained schema works offline and does not contact the registry.
Obtaining or selecting it creates no `epicenter.ts`, `epicenter.json`, or
`table.json` alongside the data.

**Any folder can be read with any explicitly selected supported schema file.**
Selection requires no owning app, folder marker, repository identity, or
declaration-containment check. Whether values match is a read result, not
permission to open the folder. Table names still address actual top-level
directories, and files outside those tables stay accessible. Supported JSON
Schema features remain the reader's contract; selection does not promise
every JSON Schema extension or reinterpret arbitrary bytes as valid rows.

Existing JSON files inside a data folder remain ordinary source files; their
presence neither installs a schema nor changes the selected interpretation.
Nothing applies a schema merely because of its name. Remembered
selections belong to machine-local settings outside the data. Reading a
schema file executes no code and fetches no external references or updates.
Legacy top-level metadata such as `local` supplies no Git-policy behavior;
handling unsupported metadata belongs to the reader migration.

**A schema file describes expectations without determining which source survives.**
A row that fails its schema retains its raw fields, source, and issues.
A structured editor keeps a parseable mismatched value visible beside its
issue and lets the person edit it there. Unparseable source uses file repair.
Malformed frontmatter remains available through file access for repair.
Diagnostics identify the schema they check against. Without selected
schemas, a generic reader gives no conformance verdict. An empty schema's
successful check is not evidence that the files fit an app.

**Selecting a schema file changes interpretation without changing data lifetime.**
It preserves unsaved input and the exact starting source needed to save it.
Selection writes no data file and does not reopen storage. Field edits
preserve unshown fields, including when the row does not fit the schema.
A missing, unreadable, or malformed schema file produces an issue with that
selection while raw file access remains available. A named table whose
directory is absent is empty; applying schemas creates no directory.

## Consequences

- A fresh clone remains browsable offline without an app, schema file, or account.
  Its typed forms and app-specific checks require a schema file obtained separately.
- Two readers can select different schema files over the same files. Neither
  selection publishes a declaration or changes the other reader's schemas.
- A team can obtain the same published schema independently of its data.
  Cloning data alone does not install a schema or restore machine-local selections.
- A stale schema file can report disagreements with current data. It never
  migrates records, discards unknown fields, or changes merge policy.
- The CLI's declaration-required `readFolder` path and the browser's
  declaration-driven reopening must be replaced. Invalid rows currently
  excluded by `checkFolder` and SQL projection must retain a source and
  diagnostic path in schema-based views. The browser's current read-only
  invalid-row display still needs a source repair path.
- Declaration publication, ownership and containment gates, and mandatory
  description discovery are unnecessary. Existing description files remain
  ordinary files; migration removes none automatically.
- A registry distributes schema artifacts; it does not identify data or own
  its interpretation. Registry hosting, lookup, and version selection remain
  unbuilt. A local schema file needs no registry connection to be read.
- Schema-free SQL, automatic table discovery, and the exact raw-grid interface
  remain separate features. No tool claims semantic conformance without schemas.

## Considered alternatives

- **An optional root description applied automatically.** Restores a typed
  default on clone, but introduces filename discovery and a shared default
  interpretation. Separately obtained schemas preserve explicit reader selection.
- **A required `table.json` beside every table.** Makes generic discovery
  depend on a description no app needs to write.
- **Infer schemas and typed editors from observed values.** Existing values
  cannot establish required fields, valid choices, or semantic date types.
- **A registry with automatic schema file updates.** Adds availability, versioning,
  and update policy before static JSON distribution has demonstrated a need.
