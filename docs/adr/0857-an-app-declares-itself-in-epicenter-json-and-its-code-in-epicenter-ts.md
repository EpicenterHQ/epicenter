# 0857. An app declares itself in `epicenter.json`, and its code in `epicenter.ts`

- **Status:** Proposed
- **Date:** 2026-11-08 (amended 2026-11-09: `epicenter.ts` exports its actions, typed through `epicenter:app`)
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at the declaration: an app's name, description, and every collection live in `epicenter.json`; `epicenter.ts`, when present, exports actions, and `defineApp` leaves apps. At fields: JSON Schema, which the `field` helpers produce. At an action's hints, which are MCP's `annotations`, and its positional, which is its first required field. At the folder's `remove`, which is `delete`. [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at a collection's fields, which are the JSON Schema of its front matter.
- **Relates:** [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (collection actions, groups, and the client), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (`.cache/`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views).
- **Unbuilt:** `epicenter:app` and the generated `.cache/epicenter/`, `action()`, exports as actions and groups, `view` on an action, `collections` in `run`, the first required field read by position, `folder`'s `get`, `getBytes`, and `set` of bytes, asserting `format`, and publishing the schema at its URL. Built 2026-11-09 and kept: loading `epicenter.json`, the declaration's TypeBox schema and `packages/app/epicenter.schema.json`, `annotations` on actions, `@epicenter/app` supplied by `epicenter`, and `folder.delete`. Built 2026-11-09 and retired by this amendment: `defineApp(declaration, { actions })` and `positional`.

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

Typing `collections` in `run` from `epicenter.json` was the open part. A JSON
import widens its literals, so the first answer (below) needed a generated
sibling file, a compiler flag, and a property on the declaration's type that
the JSON does not have.

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
import { action, field } from 'epicenter:app';

export const summarizeWeek = action({
  description: 'Summarize one week of recordings',
  input: { week: field.text() },
  run: async ({ week }, { collections }) => {
    const takes = await collections.recordings.list();
    await collections.summaries.set({ week, title: `Week ${week}` });
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
- **Every export of `epicenter.ts` is an action or a group.** An object with
  `run` is an action, any other object is a group of them, and `null` removes
  one. The exports lay over the collections' groups one level deep (ADR-0853):
  `export const words = { archive: action({…}), delete: null }`. `action()`
  returns its argument; it exists so TypeScript infers `input` and types
  `collections` from this app's declaration. An export that is none of these is
  a problem in the listing.
- **A name is a JavaScript identifier.** `delete` and `new` can name an action
  only inside a group (`words.delete`). Outside TypeScript a camelCase name is
  written in kebab-case: `summarizeWeek` is `epicenter whispering summarize-week`
  and the MCP tool `whispering_summarize-week`.
- **`epicenter --json` prints the declaration**, with each action as an MCP
  tool definition.

**Fields are JSON Schema.** A collection's `fields` is the JSON Schema of its
files' front matter (or a JSON file's contents); an action's `input` is a map of
fields that becomes its MCP `inputSchema`. In TypeScript the `field` helpers write
the same JSON Schema concisely: `field.text({ optional: true })` leaves the name
out of `required`, `field.date()` is `{ type: 'string', format: 'date', pattern }`,
and `field.boolean()` and `field.tags()` carry `default` values. `epicenter`
asserts `format` when it checks a value, where JSON Schema by default only
annotates. On the command line an action's first required field, in the order
its `input` declares them, is read by position, and every field is also a flag:
`epicenter vocab review 你好 --grade good`. Nothing else is positional, and MCP
passes every field by name.

**An action's hints are MCP's `annotations`,** verbatim: `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`, with MCP's defaults, so an
action that is not read-only reads as destructive unless it says
`destructiveHint: false`. `epicenter --json` prints all four. `epicenter` trusts
what an author writes and checks none of it.

**An action may name a view** (`view: 'practice'` for `views/practice.html`),
which hosts that render MCP Apps show with its result (ADR-0860).

**`run` receives `{ collections, folder, secrets }`.** `collections.<name>`
offers the same `list`, `get`, `set`, and `delete` every client gets, checked
against the collection's schema. `folder` offers the same verbs for any file,
with no schema: `set(path, data)` takes a string or a `Uint8Array`, `get`
returns text and `getBytes` returns bytes, and `commit` (ADR-0850). Collections
stay under their own name so that a collection called `folder` or `secrets`
collides with nothing.

**`epicenter:app` is the app's own module, generated from its
`epicenter.json`.** It exports `action` and `field` bound to this app's
collections, and the type `App`, the app's whole tree of actions, which types a
client (ADR-0853). At run time `epicenter` serves it with a Bun plugin; in an
editor the app's `tsconfig.json` resolves it to `.cache/epicenter/app.d.ts`.
`epicenter` writes `.cache/epicenter/` in `epicenter new` and `epicenter add`,
and again whenever it loads an app whose generated files are missing or older
than `epicenter.json`. They are rebuildable and ignored with the rest of
`.cache/` (ADR-0854), so nobody edits or commits them.

**An app's `tsconfig.json` is one line,** which `epicenter new` writes:

```json
{ "extends": "./.cache/epicenter/tsconfig.json" }
```

The generated config sets `strict`, `module: "preserve"`, `moduleResolution:
"bundler"`, and `paths` for `epicenter:app` and `@epicenter/app`. `epicenter`
supplies both modules when it loads `epicenter.ts`, so an app needs a
`package.json` and `node_modules` only for dependencies of its own.

**`epicenter.json` on disk is the declaration.** `epicenter` reads the app's
name, description, and collections from the file; the generated types carry
them to an editor and nowhere else.

**One schema defines the declaration.** A TypeBox schema in `@epicenter/app` is
the source of the JSON Schema published at
`https://epicenter.so/epicenter.schema.json` and of the check `epicenter` runs on
loading.

**The folder's verbs are a collection's:** `list`, `get`, `set`, `delete`, plus
`commit`.

## Consequences

- A folder with only `epicenter.json` cannot run code, and any language can read
  and write its declaration.
- A program's shapes and another author's actions share a folder: the actions
  are in `epicenter.ts`, and a collection they need is one more entry in
  `epicenter.json`, which the program keeps when it rewrites its own.
- An app with code has `epicenter.json`, `epicenter.ts`, and a one-line
  `tsconfig.json`. Its types live in `.cache/epicenter/`.
- An editor's types follow an edit to `epicenter.json` once `epicenter` next
  loads the app, and a clone made with `git clone` instead of `epicenter add` is
  untyped until then.
- A program that rewrites `epicenter.json` parses it and keeps the collections
  it does not own.
- Apps no longer call `defineApp`; `@epicenter/app` keeps `field`, the types,
  and the client. The `reading` example gains an `epicenter.json`.
- Verified 2026-11-09 in a spike (TypeScript 5.9.3, stand-in types): with
  `epicenter:app` generated into `.cache/epicenter/` and the one-line
  `tsconfig.json`, a misspelt field was refused with "Did you mean
  'interval'?"; comparing a `field.select(['again', 'good', 'easy'])` value to
  `'great'` was refused as a comparison with no overlap; and a page typed by
  `createClient<{ vocab: App }>` refused `grade: 'great'` and a `words.delete`
  that `null` removed, and kept `review`'s return type. A Bun plugin resolving
  `epicenter:app` ran the same file.
- Verified 2026-11-08: a binary from `bun build --compile` (Bun 1.4.3) that
  registers `@epicenter/app` with `plugin().module()` loads an `epicenter.ts`
  importing it from a folder with no `node_modules`.

## Considered alternatives

- **`import declaration from './epicenter.json'` and `defineApp(declaration,
  actions)` (this record's decision until 2026-11-09).** TypeScript 7.0.2 widens
  a JSON import, so an `enum` of `['new', 'known']` accepted `'other'`. Typing it
  exactly took a committed `epicenter.d.json.ts` beside `epicenter.json`,
  `allowArbitraryExtensions` (without which TypeScript refuses to resolve the
  sibling), and, to type `collections`, a property on the declaration's type
  that the JSON does not have. The spike reproduced it, and it also needed
  `resolveJsonModule: false`.
- **`export default defineApp({ … })`, typed through `epicenter:app`.** In the
  spike a `field.select` inside the one object lost its literals, so comparing
  `grade` to `'great'` compiled.
- **Generated types committed beside `epicenter.json`.** A generated file in the
  person's history that two writers regenerate, and a fresh clone typed before
  anything runs, which `epicenter add` gives anyway.
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
- **Action names of several words (`'summarize week'`).** Quoted keys in code,
  and a second rule beside groups for where one name ends.
- **Epicenter's own `readOnly` and `destructive`.** The same hints as MCP's under
  other names and defaults.
- **Generated types for every app in one global file.** Types reach
  `epicenter.ts` through module augmentation instead of the import a reader can
  follow.
