# @epicenter/app

What an app's `epicenter.ts` imports
([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md),
[ADR-0857](../../docs/adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md)).
An app is a folder. Its `epicenter.json` says what the app is and what its
files are; its `epicenter.ts`, if present, default-exports
`defineApp(declaration, { actions })`, and the `epicenter`
command turns each action into a command for the person and an MCP tool for
their agent.

```json
{
  "$schema": "https://epicenter.so/epicenter.schema.json",
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

`epicenter.json` is `{ $schema, description, collections? }`. An app's name
is its folder's: `~/Epicenter/reading` is `reading`, whatever the file says.
`DeclarationSchema` is its TypeBox schema, the check `epicenter` runs on
loading and the source of `epicenter.schema.json` (`bun run schema` rewrites
it). A collection is `{ path, fields }`: a path with at most one placeholder,
such as `words/{stem}.md`, and the JSON Schema of each file's fields. Each
collection gives the actions `list`, `get`, `set`, and `delete` with no code
(`get` and `set` alone for a path with no placeholder); see `collection.ts`.

Every collection is declared in `epicenter.json`; `epicenter.ts` holds
actions and nothing else of the app's shape, so a program, a screen, or an
agent reads every shape without loading code. Two collections with one path
is a problem. An action in `epicenter.ts` named like one a collection gives
(`words set`) replaces it, so an app can add its own rules to a write.

The file on disk is the declaration: `epicenter` reads the description
and collections from `epicenter.json`, never from `defineApp`'s first
argument. The argument, imported from `./epicenter.json`, is taken now so that
collection handles in `run` can be typed from it when they arrive, without
changing any app.

## Fields

| Field | Value | On the command line |
| --- | --- | --- |
| `field.text()` | `string` | `--name <text>` |
| `field.number()` | `number` | `--name <number>` |
| `field.date()` | `string`, `2026-11-08` | `--name <day>` |
| `field.select(['a', 'b'])` | `'a' \| 'b'` | `--name a` |
| `field.boolean()` | `boolean`, `false` unless given | `--name`, `--name=false` |
| `field.tags()` | `string[]`, empty unless given | `--name a --name b` |

Each field is JSON Schema, so any TypeBox schema works as a field too. A field
is required unless it says `optional: true`. `writeOnly: true` is JSON
Schema's keyword and means only what JSON Schema says; nothing in `epicenter`
reads it. `run`'s input is typed from the fields, and its return value stays
typed for whatever calls the action.

An action's `positional` lists, in order, the fields the command line also
reads by position: `positional: ['from', 'to']` reads
`epicenter reading between 2026-11-01 2026-11-08`. A list field may be last,
and takes every word left. Flags always work.

An action's `annotations` are MCP's tool annotations, verbatim:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, with
MCP's defaults (`ANNOTATION_DEFAULTS`). An action that does not say otherwise
reads as one that may destroy.

## Context

`run` receives its input and a context, `{ folder, secrets }`
([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)):

| Store | Holds | Methods |
| --- | --- | --- |
| `folder` | the app's data, in its folder | `read`, `readBytes`, `write`, `writeBytes`, `list`, `delete`; `path` on a computer |
| `secrets` | sign-ins, in this computer's Keychain | `get`, `set`, `delete`; only on a computer |

A write that returns is one commit, named for the call, and writes to one
app take turns
([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)).
The `epicenter` command makes that commit; an action never commits.

`folder` is a convenience, not a sandbox: an action may also write through
`folder.path` with `node:fs`. What the app can rebuild lives in files it
gitignores inside its folder, such as `.cache/`, which the template ignores;
they are written like any file and never committed. A database is a file
there, opened through `folder.path`.

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

The memory context has no Git, so a test checks the files an action wrote.

`problemsOf(declaration, code)` lists what is wrong with an app as the
`epicenter` command would: a declaration that fails the schema, two
collections with one path, a collection whose path is not `.md` or
whose field is named like its placeholder or `body`, an action whose words
start another's, a positional that is not one of the action's fields, an annotation MCP does not
define, a field named `json`, `help`, or `input`.
