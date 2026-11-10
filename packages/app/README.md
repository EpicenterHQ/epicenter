# @epicenter/app

What an app's `epicenter.ts` imports
([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md),
[ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).
An app is a folder whose `epicenter.ts` default-exports `defineApp(...)`. The
`epicenter` command turns each of its actions into a command for the person
and an MCP tool for their agent, and its UI calls the same actions.

```ts
// <Epicenter>/reading/epicenter.ts
import { defineAction, defineApp, defineCollection, field, folder } from '@epicenter/app';

const books = defineCollection({
  path: 'books/{slug}.md',
  description: 'book I am reading',
  fields: { title: field.text(), finished: field.date({ optional: true }) },
});

const log = defineAction({
  description: 'Record minutes read today',
  input: { minutes: field.number(), book: field.text({ optional: true }) },
  positional: ['minutes'],
  annotations: { destructiveHint: false },
  run: async ({ minutes, book }) => {
    const before = (await folder.read('2026.csv')) ?? 'minutes,book\n';
    await folder.write('2026.csv', `${before}${minutes},${book ?? ''}\n`);
    return { minutes };
  },
});

export default defineApp({
  description: 'How much I read each week',
  collections: { books },
  actions: { books: books.actions(), log },
});
```

`epicenter reading log 30 --book Dune` runs `log`;
`epicenter reading books set books/dune.md --finished 2026-11-10` runs a verb
the collection gives. The `epicenter` command supplies `@epicenter/app` when it
loads `epicenter.ts`, so the folder needs a `package.json` only for its own
dependencies and for types in an editor. An app's name is its folder's.

## Three values, composed

`defineCollection`, `defineAction`, and `defineApp` each check what they are
given and throw, one problem a line, when it is wrong in a way the types
cannot say. `epicenter` lists an app whose `epicenter.ts` throws while loading
with those lines as its problems, and does not run it.

- `defineCollection` returns what it was given, plus methods an action calls
  (`books.get(path)`) and `actions()`, which gives its verbs to expose.
- `defineAction` returns the action as a function of its input, carrying its
  description, input, `positional`, and `annotations`. It exists to type
  `run`'s input from `input`: an action written inline in `defineApp` would
  have an untyped input.
- `defineApp` returns what it was given. Each collection's name is its key in
  `collections`; each action's words are its keys in `actions`, so
  `{ books: books.actions(), log }` gives `books list` through `books delete`
  and `log`. `app.actions.books.add(...)` in code, `epicenter reading books add`
  on the command line, and `reading_books_add` over MCP are one action.

An app with one collection usually spreads its verbs at the top, so they are
the app's own: `actions: { ...tasks.actions(), add }` reads `epicenter tasks
add`, not `epicenter tasks tasks add`. An app with several collections nests
each under its name, as `reading` does.

A later key replaces an earlier one, as in any object:
`{ ...words.actions(), add: learn }` gives every verb with `add` replaced.
Name verbs to give fewer: `settings.actions('get', 'set')`. An action is a
function, so `{ ...learn, description: 'x' }` drops its call; `defineApp`
refuses it and says to use `defineAction`.

## Collections

A collection is a typed set of Markdown files. Its `path` is a template that
says which files belong, a record's address, and where `add` writes:

| `path` | Files | `add` takes |
| --- | --- | --- |
| `words/{word}.md` | every `.md` file in `words/` | `word` |
| `captures/{time}.md` | the same, named by the time | nothing; `{time}` is made |
| `notes/{year}/{time}.md` | one folder per year | `year` |
| `settings.md` | that one file | (no `add`) |
| `['entries/{time}.md', 'entries/archive/{slug}.md']` | both places | what the first takes |

A placeholder matches one path segment, and two in one segment are refused.
A record's address is its path inside the app: `words/你好.md`.

Each file's fields are its front matter, as `key: <JSON>` lines, and its body
is the text after it. YAML front matter is read too, and rewritten as
`key: <JSON>` lines on the first write that changes a field; a file whose front
matter is neither is all body and never rewritten.

| Verb | Many files | One file |
| --- | --- | --- |
| `list` | every file's path and fields | |
| `get` | one file's fields and body | its fields and body, or its defaults while there is none |
| `add` | makes a file; refused when one is at its path | |
| `set` | changes the fields given; `null` removes an optional one | the same, making the file when there is none |
| `edit` | replaces one passage of the body, quoted exactly as `get` returned it | the same |
| `delete` | deletes the file; `true` when there was one | |

`edit`'s quote is its own check: a passage someone changed since it was read
is never overwritten, and the refusal is `{ name: 'Changed' }`. Two callers
setting the same field from stale screens: the last write wins.

A field marked `readOnly` is written only by the app's own actions, through
the collection's methods; the exposed `add` and `set` leave it out, and
refuse it from a caller. Vocab's schedule fields are `readOnly`, so only
`review` changes them.

A collection's methods read and write the folder of the run they are called
in, so an action reaches them however deep its code goes. Outside a run they
throw, so loading an app never touches its files. `words.holds(path)` says
whether a path is one of its files; `words.misfits()`, inside a run, lists
each file whose fields no longer fit, as `epicenter update` reports them.

## Fields

| Field | Value | On the command line |
| --- | --- | --- |
| `field.text()` | `string` | `--name <text>` |
| `field.number({ min })`, `field.integer({ min })` | `number` | `--name <number>` |
| `field.date()` | `string`, `2026-11-08` | `--name <day>` |
| `field.datetime()` | `string`, RFC 3339 | `--name <date and time>` |
| `field.select(['a', 'b'])` | `'a' \| 'b'` | `--name a` |
| `field.boolean()` | `boolean`, `false` unless given | `--name`, `--name=false` |
| `field.tags()` | `string[]`, empty unless given | `--name a --name b` |

Each field is JSON Schema, so any TypeBox schema works as a field too. A field
is required unless it says `optional: true`; `readOnly: true` is described
above. A field may not be named `json`, `help`, or `input`, which `epicenter`
reads itself.

An action's `positional` lists, in order, the fields the command line also
reads by position: `positional: ['from', 'to']` reads
`epicenter reading between 2026-11-01 2026-11-08`. A list field may be last,
and takes every word left. Flags always work.

An action's `annotations` are MCP's tool annotations, verbatim:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, with
MCP's defaults. An action that does not say otherwise reads as one that may
destroy.

## Runs

Whatever runs an action opens a run with the app's folder and secrets:
`inRun({ folder, secrets }, () => action(input))`. For its length, the app's
collections, `folder`, and `secrets` reach them; an action that calls another
stays in the same run
([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

| Import | Holds | Methods |
| --- | --- | --- |
| `folder` | the app's data, in its folder | `read`, `readBytes`, `write`, `writeBytes`, `list`, `delete`; `path` on a computer |
| `secrets` | sign-ins, on this computer | `get`, `set`, `delete`; only on a computer |

A write that returns is one commit, named for the call, and writes to one
app take turns
([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)).
The `epicenter` command makes that commit; an action never commits.

`folder` is a convenience, not a sandbox: an action may also write through
`folder.path` with `node:fs`. What the app can rebuild lives in files it
gitignores inside its folder, such as `.cache/`; they are never committed.
Paths are relative to the folder with `/` between parts, and `read` gives
`undefined` for a missing file.

## Testing an action

```ts
import { createMemoryContext, inRun } from '@epicenter/app';
import reading from './epicenter.ts';

const context = createMemoryContext({ '2026.csv': 'minutes,book\n' });
await inRun(context, () => reading.actions.log({ minutes: 30 }));
expect(await context.folder.read('2026.csv')).toBe('minutes,book\n30,\n');
```

The memory context has no Git, so a test checks the files an action wrote.

## A UI

An app's UI calls its actions through `epicenter serve`, under the same words,
typed by the app. It imports the app as a type, so its bundle carries no app
code:

```ts
import { connect } from '@epicenter/app/client';
import type reading from '../../epicenter.ts';

const app = connect<typeof reading>('reading');
const books = await app.books.list();
await app.books.set({ path: books[0].path, finished: '2026-11-10' });
```

A call resolves to what the action returned, and rejects with an
`ActionError` when it threw or did not run; `changedElsewhere(error)` says an
`edit` was refused because its passage changed.
