# 0613. A table is a top-level directory described by its table.json

- **Status:** Accepted
- **Date:** 2026-10-18
- **Supersedes:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (a data folder keeps `epicenter.ts`, and `epicenter generate <dir>` writes the `epicenter.json` it declares): a table's description is the literal JSON Schema in its `table.json`, and nothing generates it.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at the root `epicenter.json`, its `app` and `title`, and "A data folder is every real, non-dot directory directly in the Epicenter folder": a table is described by its own `<table>/table.json`, which the library never writes on its own, and the unit a person owns is a repository; [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) at `field.optional` as the declaration of optionality: a field is optional when its table's `required` list omits it; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at "A row is addressed by its stem, never by an id": the address is unchanged and its name is `id`; [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "`epicenter.json` included": a `table.json` is text and merges as any text file does ([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`check` and `query`), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the repository a table lives in), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) (the app API over tables and rows).
- **Unbuilt:** all of it: tables found as top-level directories, each described by its own `table.json`, and the deletion of the root `epicenter.json`; the one row predicate; the `id` name; readers that describe and never refuse; and a save keeping a file's key order.

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
row is a `.md` file directly inside it.** A directory without a
`table.json` is not a table, so code and documents live beside tables
under no rule.

```txt
<repository>/
├── cards/                  table "cards"
│   ├── table.json          JSON Schema describing a row's frontmatter fields
│   ├── abc.md              row id "abc": frontmatter fields, then a body
│   └── abc/                row abc's own files, optional
├── docs/                   no table.json: plain files, under no rule
└── scripts/                no table.json: plain files, under no rule
```

A row's id is its file name without `.md`. `<table>/<id>/` holds that row's
own files and is never a table. There is no nesting: a directory below a
table is never a table, and an id never contains `/`. Outside tables no rule
applies. One row predicate, beside `rowStemOf` in
`packages/folder/src/paths.ts`, decides rows for `check`, `query`, and the
data browser, and the name `stem` becomes `id`. An app reads rows through the
tables it names and any path through its repository's `files`
([ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md)). Deleted: the root
`epicenter.json` with its `app` and `title`, `epicenter.ts`, and
`packages/folder/src/generate-declaration.ts`. Cost: rows have no folder
hierarchy, so a category is a field.

**`table.json` describes and never refuses.** No write is refused for not
fitting it: the only refusals are a non-text write from the library, a push
that would rewrite history, and what Git cannot represent
([ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md)).
`check` lists what does not fit, `query` shows every row with `NULL` for a
value that does not fit its column, and an app that reads a row that does
not fit its own schema gets the row's raw fields. Optionality is the
schema's `required` list. Deleted: `mismatches` as a gate,
`DefinitionMismatch`, and `InvalidValues`. Cost: nothing stops a malformed
row from landing; it shows up in `check` and as raw fields in every app.

**Whoever writes `table.json` authors it, and the library never writes
one on its own.** An app reads rows with its own schema
([ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md)), and
neither `open` nor `set` reads, creates, or changes a `table.json`. A
person, an agent, or an app writing through `files` writes one as it
writes any file. Deleted: `publishDefinition`. Cost: a directory an app
writes rows into is plain files to `check`, `query`, and the data browser
until someone writes its `table.json`; the app itself reads and writes its
rows either way.

**When the library saves a row, its frontmatter keeps the file's existing
key order, and keys new to the file follow alphabetically, without
comments.** A new row's keys are alphabetical, and no save reads
`table.json`. The save formats the row (`formatRowSource` in
`packages/folder/src/canonical.ts`) with that order. A merge reads no description: it keeps the change's key
order and adds keys only the other side has
([ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md)).
A row a person wrote by hand keeps its bytes until something rewrites its
frontmatter.

## Consequences

- A row that does not fit never disappears: `query` shows it with `NULL`s,
  `check` names it, and an app gets its raw fields.
- An app one field behind the repository's description keeps reading and
  writing.
- A directory an app writes rows into becomes a table when someone writes
  its `table.json`; a `table.json` someone deletes stays deleted.
- A top-level directory of notes or code, such as `docs/` or `scripts/`,
  is never a table unless someone gives it a `table.json`.
- Two apps that pick one table name share it, and each reads it with its
  own schema.
- A YAML comment in a row's frontmatter is lost the next time Epicenter
  rewrites that frontmatter.
- The Vault's `pages/<slug>/` payloads are row folders under the flat row
  rule.

## Considered alternatives

- **Every top-level directory holding Markdown is a table, untyped until
  described.** A repository's `docs/` and `scripts/` become tables, so a
  table opts in with its `table.json` instead.
- **A hidden `.epicenter.json` per table.** A person browsing the
  repository does not see what describes the table.
- **Every Markdown file under a table is a row, with its path as id.** Row
  folders' Markdown becomes rows, and moving a directory needs link repair.
- **A description that refuses writes.** An app one field behind the
  repository's description stops writing until someone catches up.
- **An app that publishes or widens the description it finds.** The app
  becomes the description's author and overwrites what an agent wrote.
- **The library writing `table.json` with a table's first row.** Two
  clones that each make one table write two descriptions, which merge as
  text into one neither app wrote, and the app becomes an author of a file
  people and agents own.
