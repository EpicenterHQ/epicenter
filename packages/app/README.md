# @epicenter/app

What an app's `epicenter.ts` imports
([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md),
[ADR-0857](../../docs/adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md)).
An app is a folder. Its `epicenter.json` says what the app is and what its
files are; its `epicenter.ts`, if present, default-exports
`defineApp(declaration, { collections?, actions })`, and the `epicenter`
command turns each action into a command for the person and an MCP tool for
their agent.

```json
{
  "$schema": "https://epicenter.so/epicenter.schema.json",
  "name": "reading",
  "description": "How much I read each week"
}
```

```ts
// ~/Epicenter/reading/epicenter.ts
import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';

export default defineApp(declaration, {
  actions: {
    log: {
      description: 'Record minutes read today',
      input: { minutes: field.number(), book: field.text({ optional: true }) },
      positional: ['minutes'],
      annotations: { destructiveHint: false },
      run: async ({ minutes, book }, { folder }) => {
        const before = (await folder.read('2026.csv')) ?? 'minutes,book\n';
        await folder.write('2026.csv', `${before}${minutes},${book ?? ''}\n`);
        return { minutes };
      },
    },
  },
});
```

`epicenter reading log 30 --book Dune` runs it. The `epicenter` command
supplies `@epicenter/app` when it loads `epicenter.ts`, so the folder needs a
`package.json` only for its own dependencies and for types in an editor.

## The declaration

`epicenter.json` is `{ $schema, name, description, collections? }`.
`DeclarationSchema` is its TypeBox schema, the check `epicenter` runs on
loading and the source of `epicenter.schema.json` (`bun run schema` rewrites
it). A collection is `{ path, fields }`: a path with at most one placeholder,
such as `words/{stem}.md`, and the JSON Schema of each file's fields.

Collections a program or a person writes go in `epicenter.json`; collections
the app's own actions introduce go in `epicenter.ts`, with `field` helpers.
Declaring one in both, or naming an action like one a collection gives
(`words save`), is a problem.

TypeScript widens an imported JSON file, so `epicenter` writes a sibling
`epicenter.d.json.ts` with its literal types whenever it loads the app, and
`epicenter types` writes it on request. It is gitignored, and needs
`resolveJsonModule` and `allowArbitraryExtensions` in the app's
`tsconfig.json`.

## Fields

| Field | Value | On the command line |
| --- | --- | --- |
| `field.text()` | `string` | `--name <text>` |
| `field.number()` | `number` | `--name <number>` |
| `field.date()` | `string`, `2026-11-08` | `--name <day>` |
| `field.select(['a', 'b'])` | `'a' \| 'b'` | `--name a` |
| `field.boolean()` | `boolean`, `false` unless given | `--name` |
| `field.tags()` | `string[]`, empty unless given | `--name a --name b` |

Each field is JSON Schema, so any TypeBox schema works as a field too. A field
is required unless it says `optional: true`. `run`'s input is typed from the
fields, and its return value stays typed for whatever calls the action.

An action's `positional` lists, in order, the fields the command line also
reads by position: `positional: ['from', 'to']` reads
`epicenter reading between 2026-11-01 2026-11-08`. A list field may be last,
and takes every word left. Flags always work.

An action's `annotations` are MCP's tool annotations, verbatim:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, with
MCP's defaults (`ANNOTATION_DEFAULTS`). An action that does not say otherwise
reads as one that may destroy.

## Context

`run` receives its input and a context, `{ folder, cache, secrets }`, three
stores that differ by how long what they hold lives:

| Store | Holds | Methods |
| --- | --- | --- |
| `folder` | the app's data, in its Git repository | `read`, `readBytes`, `write`, `writeBytes`, `list`, `delete`; `path` on a computer |
| `cache` | anything the app can rebuild, on this device only | the same, plus `clear()`; `path` and `sqlite(name)` on a computer |
| `secrets` | sign-ins, in this computer's Keychain | `get`, `set`, `delete`; only on a computer |

Paths are relative to the folder with `/` between parts. `read` gives
`undefined` for a missing file. The `epicenter` command supplies the context on
a computer; this package has no Node or Bun runtime code, so a page can import
an app's types.

## Testing an action

```ts
import { createMemoryContext } from '@epicenter/app';
import reading from './epicenter.ts';

const context = createMemoryContext({ '2026.csv': 'minutes,book\n' });
await reading.actions.log.run({ minutes: 30 }, context);
expect(await context.folder.read('2026.csv')).toBe('minutes,book\n30,\n');
```

`problemsOf(declaration, code)` lists what is wrong with an app as the
`epicenter` command would: a declaration that fails the schema, a reserved
name, anything declared twice, an action whose words start another's, a
positional that is not one of the action's fields, an annotation MCP does not
define, a field named `json`, `help`, or `version`.
