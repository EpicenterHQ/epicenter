# 0857. An app's declaration is plain data, in `epicenter.json` or `epicenter.ts`

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at the declaration, which is data with `run` functions beside it, in `epicenter.json` when the app has no code; at fields, which are plain data and replace `field`; and at the folder's `remove`, which is `delete`. [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at a collection's fields, in the same short form.
- **Relates:** [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (the rule of least power, and the ladder), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (Whispering writes its declaration).
- **Unbuilt:** all of it: the schema and its published JSON Schema, loading `epicenter.json`, the short form, `defineApp`'s new typing, `@epicenter/app` supplied by `epicenter`, and `folder.delete`. `packages/app` has `defineApp` and `field` as ADR-0841 wrote them, and `packages/cli` loads only `epicenter.ts`.

## Context

ADR-0841 declared an app by calling helpers in `epicenter.ts`
(`defineApp`, `field.select(…)`), so even a folder with no code was a
TypeScript module importing a package, and only a JavaScript runtime could tell
what an app was. A program in another language, such as Whispering's Rust side,
would have written a file it could not read back. Splitting every app into a
JSON declaration and separate action files was considered and refused: every
action would live in two places, and types would have to be generated, since
TypeScript widens what it imports from JSON.

## Decision

**An app's declaration is plain data, never computed.** Its name, description,
collections, and actions (each with a description, input, and hints) are values
a JSON file could hold. Only an action's `run` is code.

- **An app without actions declares itself in `epicenter.json`.** It cannot run
  code, which anyone adding a stranger's app can see from its files.
- **An app with actions declares itself in `epicenter.ts`,** whose default export
  is the same data with a `run` beside each action, usually through `defineApp`.
- **Never both.** `epicenter` lists a folder with both as a problem. Adding a
  first action is renaming the file and wrapping the data.

```json
{
  "$schema": "https://epicenter.so/epicenter.schema.json",
  "name": "whispering",
  "collections": {
    "recordings": { "path": "recordings/{id}.md", "fields": { "title": "text", "recordedAt": "datetime", "durationMs": "number?" } }
  }
}
```

```ts
import { defineApp } from '@epicenter/app';

export default defineApp({
  name: 'vocab',
  collections: {
    words: { path: 'words/{stem}.md', fields: { stage: ['new', 'known'] } },
  },
  actions: {
    define: {
      description: "Look up a word's definition",
      input: { stem: 'text' },
      run: async ({ stem }, { folder }) => { … },
    },
  },
});
```

**Fields have a short form and a long form.**

| Written | Means |
| --- | --- |
| `'text'`, `'number'`, `'date'`, `'datetime'`, `'boolean'`, `'tags'` | that type, required |
| `'text?'` | optional |
| `['new', 'known']` | one of these |
| `{ type: 'number', positional: true, description: 'Minutes read' }` | the long form, for options |

**One schema defines the declaration.** A TypeBox schema in `@epicenter/app` is
the source of the JSON Schema published at
`https://epicenter.so/epicenter.schema.json`, of the check `epicenter` runs when
it loads a declaration, and of the types `defineApp` builds on. `defineApp`
infers each `run`'s input from the plain data: `'number'` is `number`, `'text?'`
is `string | undefined`, and `['new', 'known']` is `'new' | 'known'`.

**`epicenter` supplies `@epicenter/app`,** so `epicenter.ts` loads in a folder with
no `node_modules`; an app adds a `package.json` for its own dependencies and for
types in an editor. `epicenter --json` prints any app's declaration as JSON,
whichever file holds it.

**The folder's `remove` is `delete`,** the word a collection's action uses.

## Consequences

- An app without code is readable and writable in any language, so rung 1 of
  the ladder (ADR-0852) needs no runtime.
- A declaration cannot be computed (collections built in a loop, a field chosen
  by an environment variable). An app's shape is fixed; its code goes in `run`.
- `field` goes from `@epicenter/app`, and with it TypeBox schemas as fields;
  `defineApp`'s typing is rewritten, and the `reading` example with it.
- Verified 2026-11-08: TypeScript 7.0.2 with `--strict` infers inputs from the
  short form through a `const` type parameter, and refuses a select assigned to
  another value and a required field treated as missing. A binary from
  `bun build --compile` (Bun 1.4.3) that registers `@epicenter/app` with
  `plugin().module()` loads an `epicenter.ts` importing it from a folder with no
  `node_modules`.

## Considered alternatives

- **Always `epicenter.ts`.** A data-only app would be a code file, and whether an
  app can run code would not show in its files.
- **A JSON declaration for every app, with actions in `actions/<words>.ts`.** Two
  places per action, and generated types to keep them in step.
- **Field helpers (`field.select(…)`).** An import and a call for what is data.
- **JSON Schema spelled out for every field.** Standard, but noisy for the files
  people and Claude read most; the long form covers what the short form cannot.
- **TypeBox schemas as fields.** More power than a declaration needs, and not
  writable as JSON.
