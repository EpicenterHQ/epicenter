# 0857. An app declares itself in `epicenter.json`, and its code in `epicenter.ts`

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at the declaration: an app's name, description, and the collections a program or person writes live in `epicenter.json`; `epicenter.ts`, when present, holds actions and the collections they introduce. At fields: JSON Schema, which the `field` helpers produce. At an action's hints, which are MCP's `annotations`, and its positional, which moves onto the action. At the folder's `remove`, which is `delete`. [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at a collection's fields, which are the JSON Schema of its front matter.
- **Relates:** [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (collection actions and MCP).
- **Unbuilt:** collection handles in `run`, and publishing the schema at its URL. Built 2026-11-09: loading `epicenter.json` and merging it with `epicenter.ts`, `defineApp(declaration, …)`, the declaration's TypeBox schema and `packages/app/epicenter.schema.json`, `epicenter.d.json.ts` on load and with `epicenter types`, `positional` and `annotations` on actions, `@epicenter/app` supplied by `epicenter`, and `folder.delete`.

## Context

ADR-0841 declared an app by calling `defineApp` in `epicenter.ts`, so a folder
with no code still had to be a TypeScript module, and only a JavaScript runtime
could tell what an app was. Whispering, which writes its own folder, keeps its
shapes as hand-written JSON Schema (`apps/whispering/src/lib/contract.ts`), and
every consumer of a field already reads JSON Schema: MCP's input schemas, form
renderers, validators, and the `field` helpers' TypeBox values. Two programs can
share one folder: Whispering writes recordings, and an agent may add actions
that summarize them. An invented short form for fields (`'text?'`) and a rule of
one declaration file per app were considered and refused (below).

## Decision

**Every app has an `epicenter.json`. An app with code also has an
`epicenter.ts`.**

```json
{
  "$schema": "https://epicenter.so/epicenter.schema.json",
  "name": "whispering",
  "description": "Voice notes",
  "collections": {
    "recordings": {
      "path": "recordings/{id}.md",
      "fields": {
        "type": "object",
        "properties": { "title": { "type": "string" }, "durationMs": { "type": "number" } },
        "required": ["title"]
      }
    }
  }
}
```

```ts
import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';

export default defineApp(declaration, {
  collections: {
    summaries: { path: 'summaries/{week}.md', fields: { title: field.text() } },
  },
  actions: {
    'summarize week': {
      description: 'Summarize one week of recordings',
      input: { week: field.text() },
      positional: ['week'],
      annotations: { destructiveHint: false },
      run: async ({ week }, { collections }) => {
        const takes = await collections.recordings.list();
        await collections.summaries.save(week, { title: `Week ${week}` });
      },
    },
  },
});
```

- **A shape is declared beside whoever writes it.** A program that writes the
  folder (Whispering), or a person declaring a collection by hand, declares it in
  `epicenter.json`. Collections an app's own actions introduce are declared in
  `epicenter.ts`. The app's name and description are always in `epicenter.json`.
- **Each declaration file has one writer.** Whispering writes `epicenter.json` for its folder,
  creating it if absent and rewriting its collections when its format changes; a
  person or agent writes `epicenter.ts`; `epicenter` writes neither, except
  `epicenter new` creating them.
- **Nothing is declared twice.** A collection or action in both files, or a
  hand-written action whose words equal one a collection gives (`words save`), is
  a problem in the listing. `epicenter.ts` never overrides a shape in
  `epicenter.json`; its actions fit the shapes they write.
- **`epicenter --json` prints the merged declaration**, with each action as an
  MCP tool definition.

**Fields are JSON Schema.** A collection's `fields` is the JSON Schema of its
files' front matter (or a JSON file's contents); an action's `input` is a map of
fields that becomes its MCP `inputSchema`. In TypeScript the `field` helpers write
the same JSON Schema concisely: `field.text({ optional: true })` leaves the name
out of `required`, `field.date()` is `{ type: 'string', format: 'date', pattern }`,
and `field.boolean()` and `field.tags()` carry `default` values. An action's
`positional` lists, in order, the inputs the CLI also reads positionally; it is
not part of `inputSchema`. A collection's positional is its path's last
placeholder.

**An action's hints are MCP's `annotations`,** verbatim: `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`, with MCP's defaults, so an
action that is not read-only reads as destructive unless it says
`destructiveHint: false`. `epicenter --json` prints all four.

**Actions read and write collections through handles.** `run` receives
`{ folder, secrets, collections }`; `collections.<name>` offers the same `list`,
`show`, `save`, and `delete` every client gets, checked against the collection's
schema when they run.

**Typing.** Collections declared in `epicenter.ts` are typed from the `field`
helpers. Collections declared in `epicenter.json` reach `defineApp` through the
import, whose types TypeScript widens (`"enum": ["new", "known"]` would be
`string[]`). So `epicenter` writes a sibling `epicenter.d.json.ts` from
`epicenter.json` whenever it loads the app, and `epicenter types` writes it on
request; TypeScript then reads the import with its literal types. It is
gitignored, and needs `resolveJsonModule` and `allowArbitraryExtensions`, which
the template's `tsconfig.json` sets. Without it, the import's types are loose and
the handles still check at run time.

**One schema defines the declaration.** A TypeBox schema in `@epicenter/app` is
the source of the JSON Schema published at
`https://epicenter.so/epicenter.schema.json` and of the check `epicenter` runs on
loading. `epicenter` supplies `@epicenter/app` when it loads `epicenter.ts`, so an
app needs a `package.json` only for its own dependencies and for types in an
editor.

**The folder's `remove` is `delete`,** the word a collection gives.

## Consequences

- A folder with only `epicenter.json` cannot run code, and any language can read
  and write its declaration.
- A program's shapes and another author's actions share a folder without either
  taking over the other's file, so actions can be added to a folder a program
  owns.
- An app with code has two declaration files, a `package.json` and a
  `tsconfig.json` for its editor, and a generated, ignored `epicenter.d.json.ts`.
- `defineApp` no longer takes `name` or `description`, and the `reading` example
  gains an `epicenter.json`.
- Verified 2026-11-08: TypeScript 7.0.2 widens a JSON import, so a test assigning
  `'other'` to an `enum` of `['new', 'known']` compiled; with a sibling
  `epicenter.d.json.ts` and `allowArbitraryExtensions`, the same assignment was
  refused, and without the flag TypeScript refuses to resolve the sibling. A
  binary from `bun build --compile` (Bun 1.4.3) that registers `@epicenter/app`
  with `plugin().module()` loads an `epicenter.ts` importing it from a folder with
  no `node_modules`.

## Considered alternatives

- **One declaration file per app: `epicenter.json` without code, `epicenter.ts`
  with code, never both.** Adding an action to Whispering's folder would mean
  taking over Whispering's shapes.
- **All shapes in `epicenter.json`, actions only in `epicenter.ts`.** Two writers
  of one file when an agent adds a collection to a program's folder, each needing
  to merge the other's collections.
- **A short form for fields (`'text'`, `'number?'`, `['new', 'known']`).** A
  schema language of Epicenter's own, translated at every consumer, with a long
  form for what it cannot say.
- **JSON Schema spelled out in TypeScript too.** Noisy where people and Claude
  read most, with no types for `run`.
- **`positional` as a keyword inside a field.** Not JSON Schema, and two
  positionals become writable.
- **Epicenter's own `readOnly` and `destructive`.** The same hints as MCP's under
  other names and defaults.
- **Generated types for every app in one global file.** Types reach
  `epicenter.ts` through module augmentation instead of the import a reader can
  follow.
