# 0613. A table is a top-level directory described by its table.json

- **Status:** Proposed
- **Date:** 2026-10-18
- **Supersedes:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (a data folder keeps `epicenter.ts`, and `epicenter generate <dir>` writes the `epicenter.json` it declares): a table's description is the literal JSON Schema in its `table.json`, and nothing generates it.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at the root `epicenter.json`, its `app` and `title`, and "A data folder is every real, non-dot directory directly in the Epicenter folder": each table carries `<table>/table.json`, and the unit a person owns is a repository; [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) at `field.optional` as the declaration of optionality: a field is optional when its table's `required` list omits it; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at "A row is addressed by its stem, never by an id": the address is unchanged and its name is `id`; [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "`epicenter.json` included" and "keys in ours' order, then keys only theirs added": a `table.json` merges as any `.json` file does, and a written row's keys follow its `table.json`.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`check` and `query`), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the repository a table lives in).
- **Unbuilt:** all of it: `<table>/table.json` discovery and the deletion of the root `epicenter.json`; the one row predicate; the `id` name; readers that describe and never refuse; an app writing `table.json` with a table's first row; and key order from `table.json`.

## Context

A data folder is a directory whose root `epicenter.json` describes its
tables
([ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md)).
Its author may keep `epicenter.ts` and run `epicenter generate`
(`packages/folder/src/generate-declaration.ts`) to write the JSON
([ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md)).
An app named after a folder takes its own definition as the truth and
`publishDefinition` (`packages/folder/src/publish-definition.ts`) writes it
over the folder's; otherwise `mismatches` in
`packages/definition/src/shape.ts` refuses the folder with
`DefinitionMismatch`, and a table write refuses a row with
`RowWriteError`'s `InvalidValues`. A row is addressed by its stem
([ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md)),
and a merged row's keys follow the side that wrote it
([ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md)).

With several apps sharing one repository
([ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md)),
no app owns a table's description, an app one field behind another refuses
a repository it could otherwise use, and a root description names one app.

## Decision

**A table is a top-level directory holding a visible `table.json`, and a
row is a `.md` file directly inside it.**

```txt
<repository>/
├── cards/                  table "cards"
│   ├── table.json          JSON Schema describing a row's frontmatter fields
│   ├── abc.md              row id "abc": frontmatter fields, then a body
│   └── abc/                row abc's own files, optional
└── attachments/            no table.json: plain files, under no rule
```

A row's id is its file name without `.md`. `<table>/<id>/` holds that row's
own files and is never a table. There is no nesting: a directory below a
table is never a table, and an id never contains `/`. Outside tables no rule
applies. One row predicate, beside `rowStemOf` in
`packages/folder/src/paths.ts`, decides rowhood for the library, `check`,
`query`, and sync, and the name `stem` becomes `id`. Deleted: the root
`epicenter.json` with its `app` and `title`, `epicenter.ts`, and
`packages/folder/src/generate-declaration.ts`. Cost: rows have no folder
hierarchy, so a category is a field.

**`table.json` describes and never refuses.** Every write is accepted.
`check` lists what does not fit, `query` shows every row with `NULL` for a
value that does not fit its column, and an app that reads a row that does
not fit its own schema gets the row's raw fields. Optionality is the
schema's `required` list. Deleted: `mismatches` as a gate,
`DefinitionMismatch`, and `InvalidValues`. Cost: nothing stops a malformed
row from landing; it shows up in `check` and as raw fields in every app.

**An app writes a `table.json` only in the same commit as its table's first
row, only after its clone has fetched once, and never overwrites one.**
Changing a table's description is an edit a person or an agent makes.
Deleted: `publishDefinition`.

**A row's frontmatter keys are written in `table.json` order, then
alphabetically, without comments.** Every writer that formats a row
(`formatRowSource` in `packages/folder/src/canonical.ts`) takes that order;
a row a person wrote by hand keeps its bytes until something rewrites its
frontmatter.

## Consequences

- A row that does not fit never disappears: `query` shows it with `NULL`s,
  `check` names it, and an app gets its raw fields.
- An app one field behind the repository's description keeps reading and
  writing.
- A table someone deletes comes back with the next first row an app
  writes, with that app's description.
- Two apps that pick one table name share it, and each reads it with its
  own schema.
- A YAML comment in a row's frontmatter is lost the next time Epicenter
  rewrites that frontmatter.
- The Vault's `pages/<slug>/` payloads are row folders under the flat row
  rule.

## Considered alternatives

- **A hidden `.epicenter.json` per table.** A person browsing the
  repository does not see what describes the table.
- **Every Markdown file under a table is a row, with its path as id.** Row
  folders' Markdown becomes rows, and moving a directory needs link repair.
- **A description that refuses writes.** An app one field behind the
  repository's description stops writing until someone catches up.
- **An app that publishes or widens the description it finds.** The app
  becomes the description's author and overwrites what an agent wrote.
- **Writing `table.json` before the first fetch.** A new clone then creates
  a description over one that already exists on the server.
