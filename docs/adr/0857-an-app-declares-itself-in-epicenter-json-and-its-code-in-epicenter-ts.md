# 0857. An app declares itself in `epicenter.json`, and its code in `epicenter.ts`

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at the declaration: an app's name, description, and every collection live in `epicenter.json`; `epicenter.ts`, when present, holds actions. At fields: JSON Schema, which the `field` helpers produce. At an action's hints, which are MCP's `annotations`, and its positional, which moves onto the action. At the folder's `remove`, which is `delete`. [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at a collection's fields, which are the JSON Schema of its front matter.
- **Relates:** [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (collection actions and MCP).
- **Unbuilt:** `collections` in `run`, the generated `epicenter.d.json.ts`, publishing the schema at its URL, and as amended 2026-11-09: `defineApp(declaration, actions)` without the `actions:` key, the first required field read by position in place of `positional`, and `folder`'s verbs as `list`, `get`, `set`, `delete`, `commit`. Built 2026-11-09: loading `epicenter.json`, `defineApp(declaration, { actions })`, the declaration's TypeBox schema and `packages/app/epicenter.schema.json`, `positional` and `annotations` on actions, `@epicenter/app` supplied by `epicenter`, and `folder.delete`.

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
    },
    "summaries": {
      "path": "summaries/{week}.md",
      "fields": { "type": "object", "properties": { "title": { "type": "string" } } }
    }
  }
}
```

```ts
import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';

export default defineApp(declaration, {
  'summarize week': {
    description: 'Summarize one week of recordings',
    input: { week: field.text() },
    run: async ({ week }, { collections }) => {
      const takes = await collections.recordings.list();
      await collections.summaries.set({ week, title: `Week ${week}` });
    },
  },
});
```

- **Every collection is declared in `epicenter.json`.** `epicenter.ts` holds
  actions and nothing else of the app's shape, so a program, a screen, or an
  agent reads every shape without loading code.
- **`epicenter.json` can have two writers, and each owns its own collections.**
  Whispering creates the file if absent and rewrites only the collections it
  owns when its format changes, keeping the others; a person or agent adds a
  collection by editing the file. `epicenter` writes it only in `epicenter new`.
- **`defineApp(declaration, actions)` takes the actions themselves.** They lay
  over the collections' action groups: the same path replaces, a new one joins
  the group, `null` removes (ADR-0853).
- **`epicenter --json` prints the declaration**, with each action as an MCP
  tool definition.

**Fields are JSON Schema.** A collection's `fields` is the JSON Schema of its
files' front matter (or a JSON file's contents); an action's `input` is a map of
fields that becomes its MCP `inputSchema`. In TypeScript the `field` helpers write
the same JSON Schema concisely: `field.text({ optional: true })` leaves the name
out of `required`, `field.date()` is `{ type: 'string', format: 'date', pattern }`,
and `field.boolean()` and `field.tags()` carry `default` values. On the command
line an action's first required field, in the order its `input` declares them,
is read by position, and every field is also a flag:
`epicenter vocab review 你好 --grade good`. Nothing else is positional, and MCP
passes every field by name.

**An action's hints are MCP's `annotations`,** verbatim: `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`, with MCP's defaults, so an
action that is not read-only reads as destructive unless it says
`destructiveHint: false`. `epicenter --json` prints all four.

**`run` receives `{ collections, folder, secrets }`.** `collections.<name>`
offers the same `list`, `get`, `set`, and `delete` every client gets, checked
against the collection's schema. `folder` offers the same verbs for any file,
with no schema: `set(path, data)` takes a string or a `Uint8Array`, `get`
returns text and `getBytes` returns bytes,
and `commit` (ADR-0850). Collections stay under their own name so that a
collection called `folder` or `secrets` collides with nothing.

**Collections are typed from a generated `epicenter.d.json.ts`.** `epicenter`
writes it beside `epicenter.json` in `epicenter new`, and again whenever it loads
an app whose `epicenter.d.json.ts` is missing or older than `epicenter.json`. It
declares the file's literal type, so `import declaration from './epicenter.json'`
is typed exactly (an `enum` of `["new", "known"]` stays those two strings) and
`defineApp(declaration, actions)` types `collections` in `run` from it. The file is committed, so a fresh clone is typed before anything runs, and
nobody edits it. An app's `tsconfig.json` sets `allowArbitraryExtensions`.

**`epicenter.json` on disk is the declaration.** `epicenter` reads the app's
name, description, and collections from the file, never from `defineApp`'s
first argument, which exists to carry the types.

**One schema defines the declaration.** A TypeBox schema in `@epicenter/app` is
the source of the JSON Schema published at
`https://epicenter.so/epicenter.schema.json` and of the check `epicenter` runs on
loading. `epicenter` supplies `@epicenter/app` when it loads `epicenter.ts`, so an
app needs a `package.json` only for its own dependencies and for types in an
editor.

**The folder's verbs are a collection's:** `list`, `get`, `set`, `delete`, plus
`commit`.

## Consequences

- A folder with only `epicenter.json` cannot run code, and any language can read
  and write its declaration.
- A program's shapes and another author's actions share a folder: the actions
  are in `epicenter.ts`, and a collection they need is one more entry in
  `epicenter.json`, which the program keeps when it rewrites its own.
- An app with code has `epicenter.json`, the generated `epicenter.d.json.ts`,
  and `epicenter.ts`, plus a `package.json` and a `tsconfig.json` for its editor.
- A program that rewrites `epicenter.json` parses it and keeps the collections
  it does not own.
- `defineApp` no longer takes `name` or `description`, and the `reading` example
  gains an `epicenter.json`.
- Verified 2026-11-08, the evidence for `epicenter.d.json.ts`: TypeScript 7.0.2 widens a JSON import, so a test assigning
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
- **A shape declared beside whoever writes it (this record's decision until
  2026-11-09).** Collections in two files, a rule for a collection in both, and
  a merge in the listing, to spare a program from keeping collections it does
  not own.
- **A short form for fields (`'text'`, `'number?'`, `['new', 'known']`).** A
  schema language of Epicenter's own, translated at every consumer, with a long
  form for what it cannot say.
- **JSON Schema spelled out in TypeScript too.** Noisy where people and Claude
  read most, with no types for `run`.
- **`positional` as a keyword inside a field.** Not JSON Schema, and two
  positionals become writable.
- **`positional` listed on each action (this record's decision until
  2026-11-09).** A second place to say what the subject is; ranges read as well
  with a flag (`reading between 2026-11-01 --to 2026-11-08`).
- **Every required field read by position, in order.** Three required fields
  read as `words set 你好 hello "nǐ hǎo"`, and swapping two is silent.
- **Epicenter's own `readOnly` and `destructive`.** The same hints as MCP's under
  other names and defaults.
- **Generated types for every app in one global file.** Types reach
  `epicenter.ts` through module augmentation instead of the import a reader can
  follow.
