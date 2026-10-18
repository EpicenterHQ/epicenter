# 0613. A table's schema describes its rows without refusing writes

- **Status:** Proposed
- **Date:** 2026-10-18
- **Supersedes:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (a data folder keeps `epicenter.ts`, and `epicenter generate <dir>` writes the `epicenter.json` it declares): a table's schema is the literal JSON Schema in its `.epicenter.json`, and nothing generates it.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at the root `epicenter.json`, its `app` and `title`, "never reads the folder's `epicenter.json`", and "A data folder is every real, non-dot directory directly in the Epicenter folder": each table carries `<table>/.epicenter.json`, an app reads it, and the unit a person owns is a namespace; [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principles 3 and 5: they read as restated below; [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "every `.json` file merges key by key" for `.epicenter.json`: a schema merges as indivisible bytes; [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) at `field.optional` and the code column: optionality is the schema's `required` list; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at "A row is addressed by its stem, never by an id": the address is unchanged and its name is `id`; [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md) at `template/` and "An author ships a change to their app's data as code": nothing is copied, and an app never changes an existing schema.
- **Relates:** [0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (the v1 model and its build order), [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) (what sync refuses).
- **Unbuilt:** almost all of it: `<table>/.epicenter.json` discovery and the deletion of the root `epicenter.json`; the one row predicate; the `id` column; the reader that describes and never refuses; `.epicenter.json` merging as bytes; `open({ tables })` and the `@epicenter/data` surface; and every deletion below.

## Context

Today a data folder is a directory whose root `epicenter.json` describes its
tables ([ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md)).
Its author may keep `epicenter.ts`, built from `defineFolder`, `defineTable`,
and field builders such as `field.string()` and `field.optional()`, and run
`epicenter generate` (`packages/folder/src/generate-declaration.ts`) to write
the JSON ([ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md)).
An app opens a folder with the definition compiled into its code. When the
folder is named after the app, `open-at-root.ts` takes the app's definition as
the truth (`if (target.own) prepared = target.definition;`), and
`publishDefinition` in `packages/folder/src/publish-definition.ts` writes it
back. Otherwise `mismatches` in `packages/definition/src/shape.ts` compares
the two and refuses with `DefinitionMismatch`, and `table.create` refuses a
row with `RowWriteError.InvalidValues`. A row is addressed by its stem
([ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md)),
and `merge` in `packages/folder/src/merge-file.ts` merges a `.json` both
replicas changed key by key
([ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md)).

Review rounds at `7a05d60556` found that "every Markdown or JSON file beneath a
table is a row" turns the Vault's 134 page-local payloads into invalid rows,
that an app publishing its definition overwrites a schema an agent wrote, and
that a schema refusing writes stops an app whose schema is one field behind the
namespace's.

## Decision

**A table is a top-level directory holding `.epicenter.json`, and a row is a
`.md` file directly inside it whose name does not start with `.`.** The row's
id is its file name without `.md`, and `<table>/<id>/` holds the row's own
files. Renaming a row changes its id and breaks links to it; no stable id
exists. One row predicate, beside `rowStemOf` in `packages/folder/src/paths.ts`,
decides rowhood for the library, `check`, `query`, and sync. The SQL row
column `stem` is renamed `id`. Deleted: the root `epicenter.json` with its
`app` and `title`, nested tables, and ids containing `/`. Cost: rows have no
folder hierarchy, so a category is a field.

**A schema is literal JSON Schema in `.epicenter.json`; TypeBox infers types
from it and validates rows against it.** Optionality is the schema's
`required` list. Deleted: the field builders (`field.string()`,
`field.optional()`, and the rest) across the apps, `epicenter.ts`,
`epicenter generate`, and `packages/folder/src/generate-declaration.ts`. Cost:
a person writing a schema by hand loses shared TypeBox constants; the Vault's
own 300-line `epicenter.ts` is the counter-case, and restoring it is on the
Deferred list of [0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md).

**The schema describes and never refuses.** Every write is accepted.
`epicenter check` reports what does not fit, with undeclared fields and type
mismatches as warnings. `epicenter query` types the columns a schema declares
and shows every row, with `NULL` for a value that does not fit its column.
Each reader validates against its own schema, and a row that does not fit
reaches it as raw data with the reason. Refused, as before, is only what Git
cannot represent, the list in
[ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md).
Deleted: `mismatches` as a gate, `DefinitionMismatch`, and
`RowWriteError.InvalidValues`. Withdrawn before it was built: table-level
read-only opening, exact-match and add-only schema comparison, and
`replaces`. Cost: nothing stops a malformed row from landing; it shows up in
`check` and as a raw row in every reader.

**A table is get-or-create, and an app never changes an existing schema.**
`open({ tables })` creates an absent table's directory and `.epicenter.json`
and never overwrites one that exists. Changing a schema is an edit a person or
an agent makes. `.epicenter.json` merges as indivisible bytes: when two
replicas change it, the remote's copy wins. Deleted: `publishDefinition`, and
`own` and `through` in `open-at-root.ts`. Withdrawn before it was built: app
templates. Cost: a table someone deletes comes back empty the next time an app
that names it opens.

**The library knows tables, rows, and row files, and nothing else.** It has
no settings concept and no namespace-wide file API. Settings are a
convention: a family of first-party apps may share a plain `settings` table
with one row per app, and an outside app prefixes its table
(`kanban_settings`). Device-local state lives in the site's own storage.

**`open()` from `@epicenter/data` is the whole app API.** Its shape:

```txt
open({ namespace?: string, tables: { <name>: <literal JSON Schema> } }): Promise<Namespace>
  const-generic, so ns.tables is typed from the literal schemas
  a schema with additionalProperties: false is refused, so unknown fields stay warnings
ns.tables.<t>.list()              rows: { ok: true, id, value } | { ok: false, id, raw, reason }
ns.tables.<t>.get(id)             one row of the same shape, or undefined
ns.tables.<t>.set(id, fields)     upsert; fields it does not name are kept
ns.tables.<t>.delete(id)
ns.tables.<t>.files(id).write(name, bytes)
ns.namespace                      { id, name }
ns.status                         the sync badge, read only
<Epicenter namespace tables>      the Svelte component over open()
```

There is no `ns.table()`, and apps have no `sync()`. A row with a `<id>/`
directory cannot be renamed or deleted through the library in v1. Cost: an
app that needs either sends the person to an agent or the CLI.

The principles of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
that change read:

- **Principle 3.** A table's `.epicenter.json` describes its rows; nothing
  reads it to refuse a write or to rewrite data.
- **Principle 5.** A table starts when someone first writes its schema;
  nothing is copied from an app.

## Consequences

- A row that does not fit never disappears: `query` shows it with `NULL`s,
  `check` names it, and the library hands it back raw with its reason. An app
  whose schema lags the namespace's keeps working on the rows that fit.
- The Vault's `pages/<slug>/` payloads are row files under the flat row rule.
- A table someone deletes comes back empty the next time an app that names it
  opens, because get-or-create cannot tell absent from deleted. A table an
  agent renames splits the same way.
- Two apps that pick one table name share it, and each validates it against
  its own schema. An outside app avoids that by prefixing.

## Considered alternatives

- **Every Markdown or JSON file under a table is a row, with its relative
  path as id.** It makes the Vault's 134 page payloads and each
  `.epicenter.json` into rows, collides `a.md` with `a.json`, and needs link
  repair when a directory moves.
- **A schema that refuses writes, with a table opening read-only on a
  mismatch.** Every app then needs a read-only state per table, and an app one
  field behind the namespace's schema stops writing until an agent catches up.
- **A stable row id beside the file name.** It keeps links across renames but
  puts a second identity in every file, which a person editing by hand can
  break.
- **An app may widen a schema it finds.** It finishes a customizer's update
  without an agent, but it makes the app a schema author, and the owner chose
  that apps never change schemas.
- **Keep `epicenter.ts` as the authored source.** It keeps `generate`, the
  only TypeScript the CLI runs, and a second file that can disagree with the
  JSON; it is deferred, not refused.
