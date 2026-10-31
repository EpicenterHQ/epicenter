# 0632. Apps supply schemas; CLI readers use root epicenter.json

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amended by:** [ADR-0648](0648-a-folders-saved-views-live-in-its-optional-epicenter-json.md) at the declaration's schema-only purpose and generic editor discovery: saved views share the optional declaration; the v1 CLI still requires declared schemas.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md), and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) only where repository descriptions determine generic table discovery or a reader's lifetime.
- **Amended by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at "CLI check and query require the root epicenter.json": `check` takes a contract.
- **Relates:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) (CLI readers), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (schema-independent saves).
- **Unbuilt:** migration of CLI readers to the new schema-file format, registry acquisition, schema-independent file browsing, reader-scoped diagnostics, preserving drafts through schema changes, and application migration. External-schema CLI flags are deferred; the Epicenter desktop app remains deferred.

## Context

The former `epicenter.ts → epicenter generate → epicenter.json` workflow is
preserved in superseded [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md).
It generated a declaration alongside the data. The chosen design retains a
root JSON file for CLI interpretation while removing app publication and
TypeScript generation. The older generator remains implemented until its
callers migrate.

Whispering declares its recording and transcription fields in
`606cbceebb64:apps/whispering/src/lib/definition.ts`. It already brings the knowledge
needed to read its files. The internal browser engine accepts caller-supplied
schemas in `packages/folder/src/browser/repository.ts`; its saves do not validate
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
Apps supply read schemas from code. In v1, CLI `check` and `query` read
`<folder>/epicenter.json`. A schema file grants no access and configures no
data identity, merge behavior, or ignored files.

```text
voice-notes/
    epicenter.json              schemas used by CLI check and query
    recordings/<id>.md
    transcriptions/<id>.md
```

**Apps and ordinary file access require no schema file.**
Apps name the directories they use and bring their own read schemas. Neither
`epicenter.json` nor `table.json` identifies data or establishes permissions.
Opening or saving in an app never creates or replaces a schema file. Missing
CLI metadata does not prevent Git synchronization or ordinary file access.
Files outside the described tables remain accessible.

**CLI check and query require the root epicenter.json in v1.**
That file supplies the CLI's table names and frontmatter schemas. If it is
missing, unreadable, or malformed, those commands report the problem and how
to obtain or repair it. They do not infer schemas, run `epicenter.ts`, or
silently claim validation succeeded. Schema-free checking and SQL, external
schema paths, and remembered reader selections are deferred.

**A schema is obtained independently and copied into the folder explicitly.**
A person can download it from a registry or app distribution, or author the
JSON themselves. Acquisition installs `epicenter.json` deliberately; it does
not alter row files. Normal app opening and saving never install it. Reading
the installed file works offline, executes no code, and fetches no external
references or updates. Registry hosting, lookup, and versions remain unbuilt.
The old TypeScript-to-JSON generator remains retired as a design.

Any ordinary folder can use a supported schema copied to that root path.
There is no owning-app, repository-identity, or containment gate. Table names
still address actual top-level directories. Whether rows match is a diagnostic,
not permission to access them. Supported JSON Schema features remain the
reader's contract. Legacy metadata such as `local` configures no Git policy.

The root file is one shared default interpretation for CLI readers. Changing
it changes subsequent CLI checks and queries; apps retain their own schemas.
Committing it lets a clone restore that CLI interpretation. It does not
restore app interfaces or machine-local settings.

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
Deliberately installing or updating a schema changes its JSON file, not row
data, and does not reopen storage. Field edits
preserve unshown fields, including when the row does not fit the schema.
A missing, unreadable, or malformed schema file produces an issue with that
selection while raw file access remains available. A named table whose
directory is absent is empty; applying schemas creates no directory.

## Consequences

- A fresh clone remains readable as files without an app, schema file, or account.
  CLI checking and queries require the root schema file.
- Apps can use different read schemas over the same files. CLI readers share
  the root file; external-schema overrides are deferred.
- Cloning a committed root schema restores the CLI interpretation. A folder
  without one needs explicit schema acquisition before check or query.
- A stale schema file can report disagreements with current data. It never
  migrates records, discards unknown fields, or changes merge policy.
- The CLI keeps root-file discovery but must migrate its legacy declaration
  format. The browser's declaration-driven reopening must be replaced. Invalid rows currently
  excluded by `checkFolder` and SQL projection must retain a source and
  diagnostic path in schema-based views. The browser's current read-only
  invalid-row display still needs a source repair path.
- Declaration publication, ownership and containment gates, and mandatory
  app-description discovery are unnecessary. Existing description files remain
  ordinary files; migration removes none automatically.
- A registry distributes schema artifacts; it does not identify data or own
  its interpretation. Registry hosting, lookup, and version selection remain
  unbuilt. A local schema file needs no registry connection to be read.
- Schema-free checking and SQL, automatic table discovery, and the exact raw-grid
  interface remain separate features. No tool claims conformance without schemas.

## Considered alternatives

- **Require a separately selected schema path for each CLI command.** Supports
  multiple interpretations but adds flags and reader settings before a concrete
  need. V1 uses one root file instead.
- **Require the root file for apps or file access.** Couples ordinary local
  data use to metadata that an app already supplies from code.
- **A required `table.json` beside every table.** Makes generic discovery
  depend on a description no app needs to write.
- **Infer schemas and typed editors from observed values.** Existing values
  cannot establish required fields, valid choices, or semantic date types.
- **A registry with automatic schema file updates.** Adds availability, versioning,
  and update policy before static JSON distribution has demonstrated a need.
