# @epicenter/app

What an app's `epicenter.ts` imports
([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md)).
An app is a folder; its `epicenter.ts` default-exports `defineApp(...)`, and
the `epicenter` command turns each action into a command for the person and a
tool for their agent.

```ts
// ~/Epicenter/reading/epicenter.ts
import { defineApp, field } from '@epicenter/app';

export default defineApp({
  name: 'reading',
  description: 'How much I read each week',
  actions: {
    log: {
      description: 'Record minutes read today',
      input: {
        minutes: field.number({ positional: true }),
        book: field.text({ optional: true }),
      },
      run: async ({ minutes, book }, { folder }) => {
        const before = (await folder.read('2026.csv')) ?? 'minutes,book\n';
        await folder.write('2026.csv', `${before}${minutes},${book ?? ''}\n`);
        return { minutes };
      },
    },
  },
});
```

`epicenter reading log 30 --book Dune` runs it.

## Fields

| Field | Value | On the command line |
| --- | --- | --- |
| `field.text()` | `string` | `--name <text>` |
| `field.number()` | `number` | `--name <number>` |
| `field.date()` | `string`, `2026-11-08` | `--name <day>` |
| `field.select(['a', 'b'])` | `'a' \| 'b'` | `--name a` |
| `field.boolean()` | `boolean`, `false` unless given | `--name` |
| `field.tags()` | `string[]`, empty unless given | `--name a --name b` |

A field is required unless it says `optional: true`. One field may say
`positional: true`, and is then also the command's positional. Any TypeBox
schema works as a field too. `run`'s input is typed from the fields, and its
return value stays typed for whatever calls the action.

An action may say `readOnly` (it changes nothing) or `destructive` (it changes
something outside the folder that cannot be taken back); agents see both as
MCP hints.

## Context

`run` receives its input and a context, `{ folder, cache, secrets }`, three
stores that differ by how long what they hold lives:

| Store | Holds | Methods |
| --- | --- | --- |
| `folder` | the app's data, in its Git repository | `read`, `readBytes`, `write`, `writeBytes`, `list`, `remove`; `path` on a computer |
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

`problemsOf(app)` lists what is wrong with an app as the `epicenter` command
would: a bad name, an action whose words start another's, two positional
fields, a field named `json`, `help`, or `version`.
