# 0613. A table is a view of one top-level directory

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amended by:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at requiring a table.json to discover a table: apps and selected schemas name directories; the flat row layout and schema-independent saves remain.
- **Supersedes:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (a data folder keeps `epicenter.ts`, and `epicenter generate <dir>` writes the `epicenter.json` it declares): a table's description is the literal JSON Schema in its `table.json`, and nothing generates it.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at the root `epicenter.json`, its `app` and `title`, and "A data folder is every real, non-dot directory directly in the Epicenter folder": a table is described by its own `<table>/table.json`, which the library never writes on its own, and the unit a person owns is a repository; [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) at `field.optional` as the declaration of optionality: a field is optional when its table's `required` list omits it; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at "A row is addressed by its stem, never by an id": the address is unchanged and its name is `id`; [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "`epicenter.json` included": a `table.json` is text and merges as any text file does ([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).
- **Amended by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at CLI `check` requiring the root `epicenter.json`: `check` takes a contract.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`check` and `query`), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the repository a table lives in), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) (the app API over tables and rows).
- **Unbuilt:** migration of generic readers to selected schema files, the shared row predicate, and application migration from legacy declaration gates.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

A data folder is a directory whose root `epicenter.json` describes its
tables
([ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md)).
Its author may keep `epicenter.ts` and run `epicenter generate`
(`a705179adf5d:packages/folder/src/generate-declaration.ts`) to write the JSON
([ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md)).
An app named after a folder takes its own definition as the truth and
`publishDefinition` (`9d13dd25854e:packages/folder/src/publish-definition.ts`) writes it
over the folder's; otherwise `mismatches` in
`2c2cd06e3125:packages/definition/src/shape.ts` refuses the folder with
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

**A table presents immediate Markdown files in one named top-level directory as rows.**
An app names that directory through its read schemas. The CLI obtains the
same mapping from a selected schema file (ADR-0632). A directory is not a
table for every reader merely because it contains Markdown.

```text
<local data>/
    cards/
        abc.md            row id abc: frontmatter fields and Markdown body
        abc/              optional files belonging to that row
    docs/                 ordinary files, available through file access
```

A row id is its filename without .md, within its table. It is one filename
segment and can change on rename. A directory below a table is not another
table. The row's files live under <table>/<id>/, which a row deletion removes
with the row under ADR-0626. Existing record-reference field names and values
are unchanged by this vocabulary decision.

**Apps need no table marker or root schema file.**
An app supplies its own schemas. CLI check and query instead require root
epicenter.json for their shared interpretation. Neither filename identifies data or is
created on open or first save. Existing files of those names remain ordinary
files; no automatic deletion or rewrite follows from this decision.

**Schemas check reads without refusing nonconforming writes.**
A parseable row outside the selected schema retains its raw fields and
issues. Malformed source remains available through files. With the root
schema file, check reports the applicable issues and query retains each
row's source and diagnostics alongside its projected values. A typed cell
can be NULL when its value does not fit; the raw value remains available.
No schema means no app-specific conformance verdict.

**A row save preserves existing frontmatter key order and appends new keys alphabetically.**
It reads no schema file. A new row's keys are alphabetical. The formatter
can discard YAML comments when rewriting frontmatter; untouched source
keeps its bytes. Merge behavior remains ADR-0591 and ADR-0622.

## Consequences

- Two apps can use one table with different read schemas.
- A chosen schema determines a generic reader's named tables, including
  empty tables, without creating their directories.
- Files outside selected tables remain accessible. A schema file has no
  publication owner or right to replace another reader's expectations.
- Flat row addresses remain the format. A category can be a field; nested
  note layouts remain ordinary files unless a different app handles them.

## Considered alternatives

- **A required table.json marker.** Makes generic discovery depend on a
  file apps do not need.
- **Treat every Markdown directory as a typed table.** Infers semantics
  that the files alone cannot establish.
- **Publish schemas on open or first save.** Adds shared writes and
  ownership rules to opening data.
