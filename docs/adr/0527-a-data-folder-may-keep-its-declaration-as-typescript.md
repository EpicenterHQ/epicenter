# 0527. A data folder may keep its declaration as TypeScript

- **Status:** Superseded
- **Date:** 2026-10-11
- **Superseded by:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md): a table's description is the literal JSON Schema in its `table.json`, and nothing generates it.
- **Amends:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) at "nothing executes the folder's code": `epicenter generate` runs the folder's `epicenter.ts`; `check` and `query` still never do. [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) at its rejected `epicenter.config.ts`: the TypeScript file is a source a person runs on purpose, never what a reader reads.
- **Relates:** [ADR-0525](0525-a-field-is-plain-json-schema.md) (a field is plain JSON Schema), [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) (`field.optional` and `required`)

## Context

A data folder no app owns, such as a hand-written vault, keeps its
declaration in `epicenter.json`. Writing that JSON by hand means spelling
each table as an object schema and keeping `required` in step with the
fields. The field helpers say the same thing in a few lines, with types,
`field.optional`, and editor hints. ADR-0520 removed the CLI's
`epicenter.config.ts` execution because running a cloned repository's code to
read its data is unsafe.

## Decision

**A data folder may keep `epicenter.ts`, whose default export is
`defineFolder({ ... })`, and `epicenter generate <dir>` writes the
`epicenter.json` it declares.**

```ts
// epicenter.ts
import { defineFolder, defineTable, field } from '@epicenter/folder';

export default defineFolder({
  kv: {},
  tables: {
    pages: defineTable({
      fields: { title: field.string(), queuedAt: field.optional(field.date()) },
    }),
  },
});
```

```text
epicenter generate <dir>          write epicenter.json from epicenter.ts
```

- `epicenter.json` stays the only declaration a reader reads. `check`,
  `query`, `readFolder`, and every app read the JSON and never run
  `epicenter.ts`, so reading a cloned repository still runs none of its code.
- `generate` is the one command that runs a folder's code, and only when a
  person or agent asks for it on that folder.
- The file is `epicenter.ts`, not `epicenter.config.ts`: it declares data,
  and "config" names tool settings.
- `epicenter.ts` may import `@epicenter/folder`, `@epicenter/definition`,
  `typebox` (default export included), and their subpaths
  (`@epicenter/folder/bun`, `@epicenter/definition/field`, and
  `typebox/compile`, `/format`, `/schema`, `/system`, `/value`). `generate`
  resolves each to the checkout's own packages, so a folder in any repository
  needs no install, and a copy the folder installed never wins. Bun ignores a
  runtime redirect of a bare specifier, so each name is listed.
- `defineFolder` refuses a key other than `title`, `kv`, and `tables`, so a
  misspelling in an untyped `epicenter.ts` is an error rather than dropped.
- Git says whether the file is current: run `epicenter generate <dir>` and
  then `git diff --exit-code -- <dir>/epicenter.json`. `generate` has no
  check mode of its own.
- When `epicenter.ts` is a file, `check` says that `epicenter.json` is
  generated from it, so a person or agent edits the TypeScript rather than the
  JSON, and a folder missing `epicenter.json` is told to run `generate`. It
  looks only at whether the file exists.
- The way to keep a folder an app owns in step is for `epicenter.ts` to
  import the definition the app itself uses. Then the app's publication and
  `generate` write the same bytes. That needs the app's definition to be an
  installable package, which nothing publishes yet.

## Consequences

- When an app opens the folder it replaces `epicenter.json` (ADR-0517),
  whatever `epicenter.ts` says. Unless `epicenter.ts` imports the app's own
  definition, the two then describe different things, and running `generate`
  swaps the declaration back until the app opens again.
- `generate` replaces a hand edit to `epicenter.json`; Git shows it
  afterward, and the `check` line says which file to edit.
- An editor outside this monorepo cannot type-check `epicenter.ts` until the
  folder package is installable; `generate` still runs it.
- Until the CLI is distributed, `generate` runs from an Epicenter checkout, as
  `check` and `query` do.

## Considered alternatives

- **Readers run `epicenter.ts` when no JSON exists.** Brings back running a
  cloned repository's code to read its data.
- **Only hand-written JSON.** Correct but verbose, and `required` drifts from
  the fields a person meant.
- **A separate `@epicenter/cli init` scaffold.** Writes the file once and
  leaves later edits to hand-written JSON.
- **Readers use `epicenter.ts` when it exists and fall back to
  `epicenter.json`.** `check` and `query` would run code from any repository
  they are pointed at.
- **`epicenter.ts` writes the JSON when run directly (`bun epicenter.ts`).**
  Its import of `@epicenter/folder` resolves only inside this repository until
  the package is published; then the CLI command could go.
- **`generate --check`.** Git already answers whether the file changed.

## Verification

<!-- doc-path-check: ignore-next-line -->
`scripts/epicenter.test.ts` covers writing the JSON from `epicenter.ts` and
reporting it unchanged, the `check` line, refusal of a missing source, a
missing default export, a misspelled key, and a declaration preparation
refuses, and that `check` and `query` never run `epicenter.ts`.
`86ddc758e5:packages/folder/src/definition.test.ts` covers `defineFolder` refusing an
unknown key.
