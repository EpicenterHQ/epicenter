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
  path: 'data/books/{slug}.md',
  description: 'book I am reading',
  fields: { title: field.text(), finished: field.date({ optional: true }) },
});

const log = defineAction({
  description: 'Record minutes read today',
  input: { minutes: field.number(), book: field.text({ optional: true }) },
  positional: ['minutes'],
  annotations: { destructiveHint: false },
  run: async ({ minutes, book }) => {
    await folder.update('data/2026.csv', (before = 'minutes,book\n') => `${before}${minutes},${book ?? ''}\n`);
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
`epicenter reading books set data/books/dune.md --finished 2026-11-10` runs a verb
the collection gives. The `epicenter` command supplies `@epicenter/app` when it
loads `epicenter.ts`, so the folder needs a `package.json` only for its own
dependencies and for types in an editor. An app's name is its folder's.

## Three values, composed

`defineCollection`, `defineAction`, and `defineApp` each check what they are
given and throw, one problem a line, when it is wrong in a way the types
cannot say. `epicenter` lists an app whose `epicenter.ts` throws while loading,
or whose default export `defineApp` refuses, with those lines as its problems,
and does not run it.

- `defineCollection` returns what it was given, plus methods an action calls
  (`books.get({ path })`) and `actions()`, which gives its verbs to expose.
- `defineAction` returns the action as a function of its input, carrying its
  description, input, `positional`, and `annotations`. It exists to type
  `run`'s input from `input`: an action written inline in `defineApp` would
  have an untyped input. Calling it fills each field's default before `run`,
  as a call through the CLI or MCP does, so a caller may leave out a field
  with a default and `run` always has it. `run` returns a value that survives
  JSON; anything else, such as a `Date`, is a type error where the action is
  written.
- `defineApp` checks what it was given and returns that same object. It needs
  `description`, `collections`, and `actions`, with `{}` for none. Each
  collection's name is its key in `collections`; each action's words are its
  keys in `actions`, so `{ books: books.actions(), log }` gives `books list`
  through `books delete` and `log`. `app.actions.books.add(...)` in code,
  `epicenter reading books add` on the command line, and `reading_books_add`
  over MCP are one action. No key at any depth may be `then`, which a UI's
  client cannot call.

An app with one collection usually spreads its verbs at the top, so they are
the app's own: `actions: { ...tasks.actions(), add }` reads `epicenter tasks
add`, not `epicenter tasks tasks add`. An app with several collections nests
each under its name, as the example above does.

A later key replaces an earlier one, as in any object:
`{ ...words.actions(), add: learn }` gives every verb with `add` replaced.
Name verbs to give fewer: `settings.actions('get', 'set')`. An action is a
function, so `{ ...learn, description: 'x' }` drops its call; `defineApp`
refuses it and says to use `defineAction`.

## Collections

A collection is a typed set of Markdown files. Its `path` is one template
that says which files belong, a record's address, and where `add` writes:

| `path` | Files | `add` takes |
| --- | --- | --- |
| `data/words/{word}.md` | every `.md` file in `data/words/` | `word` |
| `data/captures/{time}.md` | the same, named by the time | nothing; `{time}` is made |
| `data/notes/{year}/{time}.md` | one folder per year | `year` |
| `data/settings.md` | that one file | (no `add`) |

A placeholder matches one path segment, and two in one segment are refused.
A record's address is its path inside the app: `data/words/你好.md`. Files in a
second layout, such as `data/entries/archive/{slug}.md` beside `data/entries/{time}.md`,
are a second collection, so membership, reading, making, and addressing each
have one answer.

Each file's fields are its front matter, as `key: <JSON>` lines, and its body
is the text after it. YAML front matter is read too, and rewritten as
`key: <JSON>` lines on the first write that changes a field. A file whose
front matter is neither is all body: `set` refuses it until it is fixed by
hand, and a read says so in `problems`.

### Methods and verbs

An action reads and writes through the collection's methods. `actions()`
gives the same operations as verbs to expose, each taking the same object:

| Many files (`data/words/{word}.md`) | One file (`data/settings.md`) |
| --- | --- |
| `list()`: every file as a row, sorted by path | |
| `get({ path })`: the file, or `undefined` when there is none | `get()`: the file, or its defaults while there is none |
| `add({ ...placeholders, ...fields, body? })`: makes a file; throws when one is at its path | |
| `set({ path, ...fields })`: changes the fields given; `null` removes an optional one | `set(fields)`: the same, making the file when there is none |
| `edit({ path, old, new })`: replaces one passage of the body, quoted exactly as `get` returned it | `edit({ old, new })` |
| `update({ path }, (record) => patch)`: writes what the function computes from the file, or makes it from `undefined`; a method only | `update((record) => patch)` |
| `delete({ path })`: deletes the file; `true` when there was one | |
| `pathOf({ ...placeholders })`: the path `add` would write | |

The exposed `get`, `set`, and `edit` throw `FileError.Missing` (`There is no
<path>`) where the method answers `undefined`. `pathOf` fills the template, `{time}` included, as `add` does:
it names the file by the value as NFC, trimmed, with each run of whitespace
one space, so `" 你好 "` and `"你好"` name one file, and it throws for a value
that is then empty, holds `/` or `\`, starts with `.`, or is over 200 bytes.
So an action never writes `data/words/${word}.md` itself:

```ts
const found = await words.get({ path: words.pathOf({ word }) });
```

`edit`'s quote is its own check: a passage someone changed since it was read
is never overwritten, and the refusal is `{ name: 'Changed' }`. `set` writes
the values it is given, so two callers setting the same field from stale
screens: the last write wins.

The same goes for a value an action computes from `get` and writes with
`set`: a change made between them is lost. Compute it inside `update`
instead. Its function gets the record as `get` gives it, `problems`, `other`,
and `body` included, or `undefined` when there is no file, and returns what
`set` takes, without `path` and with `body` when the body changes. `update`
writes that only over the record the function was given, and when there was
no file, what it returns makes one as `add` would, refusing a required field
it leaves out; a one-file collection's function gets its defaults instead.
When the file changed meanwhile, it calls the function again on what is
there now, so keep the function pure. A function that throws writes nothing,
and one that returns nothing to change (`{}`) for a file leaves it as it is.
It returns the record written. `update` is not a verb, since a caller cannot
send a function. Vocab's `review` schedules a word this way, so two reviews
at once both count, and refuses a word that is not there:

```ts
await words.update({ path }, (word) => {
  if (!word) throw FileError.Missing({ path }).error;
  return schedule(word, grade, now);
});
```

"Make it if it is not there, else change it" is one `update`, so two calls
at once never both try to make the file. Reading's `start` is:

```ts
books.update({ path: books.pathOf({ title }) }, (book) =>
  book?.started === undefined || book.finished !== undefined
    ? { started: localDay(), finished: null }
    : {},
);
```

A field marked `readOnly` is written only by the app's own actions, through
the collection's methods; the exposed `add` and `set` leave it out, and
refuse it from a caller. Vocab's schedule fields are `readOnly`, so only
`review` changes them. When a `readOnly` field is required and has no
default, no caller could give it, so `actions()` leaves out `add`, in its
value and its type, and `actions('add')` throws saying why. Write the app's
own `add` with `defineAction`, as Capture does for `capturedAt`.

A collection's methods read and write the folder of the run they are called
in, so an action reaches them however deep its code goes. Outside a run they
throw, so loading an app never touches its files. `words.holds(path)` says
whether a path is one of its files.

### What a read gives

A read never trusts the file. `list`, `get`, and the file `add`, `set`, and
`edit` return check each declared field the same way. A field is:

- its value, when the value fits the field;
- else the field's default, when it has one;
- else absent.

`path`, each placeholder's value from the path, and `body` come from the
file itself, after the fields, so front matter never replaces them: `data/words/你好.md` reads as `{ path: 'data/words/你好.md', word: '你好', ... }`.

A file that does not fit has `problems`, one line per problem, quoting the
value it dropped as JSON: `due: "next week" is not a day like 2026-11-12`, `title is missing`,
or `its front matter is neither key: <JSON> lines nor YAML`. A file that fits
has no `problems` key. `words.list()` returns rows with `problems`; for a one-file collection,
`get()` returns the file with `problems`. `epicenter update` reports those
rows as `<path>: <problem>; <problem>`.

`get`, and the file `add`, `set`, and `edit` return, also have `other`: the
front matter that is not a field's fitting value, keyed by name. It holds
keys no field declares and the raw values of fields that did not fit, and is
absent when empty. `list` rows have no `other`. Every write keeps front
matter no field declares. A value that does not fit appears twice on `get`:
quoted in `problems`, and raw in `other`.

The types say the same. A field with a default is always there; every other
field is optional, a required one included, since a file written by hand may
lack it. Every placeholder is there, since the path holds it. Rows and files
have `problems?: string[]`; files have `other?: Record<string, JsonValue>`.
Read code handles an absent field rather than trusting the declaration.

A path's case is its own: on a disk that ignores case, such as macOS's,
`data/words/Hello.md` and `data/words/hello.md` name one file, and `get` answers under
the path it was asked for, while `list` gives the name on disk.

### What a definition may say

`defineCollection` refuses:

- a path outside `data/`, naming the path with that prefix;
- a path that is not a relative `.md` template, has an empty part or one
  starting with `.`, has a placeholder twice, or a brace
  that is not a placeholder;
- a list of paths: a second layout is a second collection;
- a field or placeholder named `path`, `body`, `problems`, or `other`, which
  a read gives itself, or `json`, `help`, or `input`, which `epicenter` reads
  itself; a field named as a placeholder, which the file's name holds; a
  field name that a front matter line cannot hold;
- in a one-file collection, a field that is required and has no default,
  since the file reads as its defaults before its first `set`.

### Addressing a record

The generated verbs are for the generic case, so they address a record by its
path, the one address every collection has. An action you write chooses its
own input, and one people type should take what they type. Vocab's `review`
takes `{ path, grade }`; it could take `{ word, grade }` and call
`words.pathOf({ word })`, so a person types `epicenter vocab review 你好 good`.

## Fields

| Field | Value | On the command line |
| --- | --- | --- |
| `field.text()` | `string` | `--name <text>` |
| `field.number({ min, max })`, `field.integer({ min, max })` | `number` | `--name <number>` |
| `field.date()` | `string`, `2026-11-08` | `--name <day>` |
| `field.datetime()` | `string`, RFC 3339 | `--name <date and time>` |
| `field.select(['a', 'b'])` | `'a' \| 'b'` | `--name a` |
| `field.boolean()` | `boolean`, `false` unless given | `--name`, `--name=false` |
| `field.tags()` | `string[]`, empty unless given | `--name a --name b` |

Each field is JSON Schema, so any TypeBox schema works as a field too. A field
is required unless it says `optional: true`; `readOnly: true` is described
above, and every field helper keeps it in its type. A field may not be named
`json`, `help`, or `input`, which `epicenter` reads itself.

`localDay()` and `localTime()` give now, or a `Date` passed to them, as
`field.date` and `field.datetime` hold it, in the time zone of the computer
that runs the action: `2026-11-10` and `2026-11-10T22:41:05+08:00`. Reading's
`start` writes `started: localDay()`.

`field.text({ pattern, description })` takes a regular expression the whole
value must match. Write the `description` to read after "must be", since the
command line's refusal reads `--title must be <description>` and a read's
problem reads `title: "…" is not <description>`. Tasks' title is
`{ pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$', description: 'one line, not blank, saying what to do' }`.

An action's `positional` lists, in order, the fields the command line also
reads by position: `positional: ['from', 'to']` reads
`epicenter reading between 2026-11-01 2026-11-08`. A list field may be last,
and takes every word left. Flags always work.

An action's `annotations` are MCP's tool annotations, verbatim:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, with
MCP's defaults. An action that does not say otherwise reads as one that may
destroy.

## Runs

Whatever runs an action opens a run with the app's folder:
`inRun({ folder }, () => action(input))`. For its length, the app's
collections and `folder` reach it; an action that calls another stays in the
same run
([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).
`folder` has `read`, `readBytes`, `write`, `writeBytes`, `update`, `list`, and
`delete`, and `path` on a computer.

An action changes files and never commits; on a computer, the call that ran
it commits before it answers, however it arrived
([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)).
The commit holds exactly the files the run wrote through `folder` that
changed, named for the call; other pending files stay pending until
`epicenter sync` or `serve`'s 5-minute clock snapshots them as
`<app>: changed outside epicenter`; `epicenter history` lists each commit's
paths from Git. What an
action wrote before it throws is committed as `<call> (threw)`; whether a
failed action should be rolled back instead is undecided
([ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

Calls that write one app take turns, from the command line, an agent, and a
UI alike: a call holds the app's lock from its first write until its commit,
and a call that only reads never takes it. So an action that fetches or
computes first and writes last holds the app for the least time.
`folder.write` replaces the file, and the last write wins. A change that
depends on what it read goes through `folder.update(path, change)`: it reads
the file, calls `change` with its text (`undefined` when there is none), and
writes what `change` returns, nothing when that is what is there. A writer
outside epicenter, such as an editor, may change the file between the read
and the write; then `update` calls `change` again on what is there now, and
after 10 tries it throws `FileError.Changed`. A `change` that
throws writes nothing. It returns the text written. Every collection write (`add`, `set`, `edit`, `update`)
goes through it, so two `set`s of different fields of one file both land, and
two `update`s of one field each see the other's.

```ts
await folder.update('data/2026.csv', (before = 'minutes,book\n') => `${before}${minutes},\n`);
```

A run of an action marked `readOnlyHint: true` is never snapshotted. Its
context carries `readOnly: { action }`, and in it `folder.write`,
`folder.writeBytes`, `folder.update`, and `folder.delete` throw before doing
anything, unless the path is `.local` under `data/`: `The action "<words>" is read-only, so
it cannot write <path>`. A raw `node:fs` write, or a change made through an
outside service, is the action's own promise.

`folder` is a convenience, not a sandbox: an action may also write through
`folder.path` with `node:fs`. What the app can rebuild lives in files it
gitignores inside its folder, such as `ui/dist/`; they are never committed.
Paths are relative to the folder with `/` between parts, and `read` gives
`undefined` for a missing file.
Every write through `folder` stays under `data/`. A path with a `.git*` segment
is refused at any depth. Reads may reach code files.

## Secrets are `.local` files

A path with a part matching `*.local` or `*.local.*`, in any case, stays on
the computer that runs the app
([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)).
`isLocalPath(path)` says whether a path is one. Such a file:

- is never committed: the app's `.gitignore` leaves it out, and a snapshot
  refuses one it lets through;
- may be written and deleted in a read-only run, since it is never in the
  app's history, so an action that only reads may still refresh a token;
- is made `0600`, readable by its owner alone, when `folder` creates it on a
  computer, and a directory `folder` creates on such a path is `0700`;
- is never one of a collection's files unless the collection's own `path` is
  `.local`: a value such as `token.local` that would make one is skipped by
  `list`, `get`, and `holds`, and refused by `add` and `pathOf`.

An app's secret is a one-file collection at a `.local.md` path, with its
fields declared like any other:

```ts
const google = defineCollection({
  path: 'data/google.local.md',
  description: "this computer's Google sign-in",
  fields: {
    account: field.text({ optional: true }),
    refreshToken: field.text({ optional: true }),
  },
});

// in an action
const { refreshToken } = await google.get();
await google.set({ refreshToken: fresh });
```

Its `actions()` throws `data/google.local.md never leaves this computer, so it
offers no actions`, so no generated verb hands a token to an MCP client. An
action the app writes may still return what it reads. A fresh clone of the
app has no `.local` files: the person signs in again.

## Testing an action

```ts
import { createMemoryContext, inRun } from '@epicenter/app';
import reading from './epicenter.ts';

const context = createMemoryContext({ 'data/2026.csv': 'minutes,book\n' });
await inRun(context, () => reading.actions.log({ minutes: 30 }));
expect(await context.folder.read('data/2026.csv')).toBe('minutes,book\n30,\n');
```

The memory context has no Git, so a test checks the files an action wrote. A
test seeds a secret as it seeds any file:
`createMemoryContext({ 'data/google.local.md': '---\nrefreshToken: "t"\n---\n' })`.

## A UI

An app's UI calls its actions through `epicenter serve`, under the same words,
typed by the app. It imports the app as a type, so its bundle carries no app
code:

```ts
import { type ActionOutput, connect } from '@epicenter/app/client';
import type reading from '../../epicenter.ts';

const app = connect<typeof reading>();
type Book = ActionOutput<typeof reading.actions.books.get>;

const { data: books, error } = await app.books.list();
```

A call resolves to a Result: what the action returned, in its JSON form, or
an `ActionError` saying why not, told apart by `name`. The action's
`FileError`s arrive as themselves: `Changed` (`{ path, why }`) for an `edit`
whose passage changed or an `update` of a file that kept changing, and
`Missing` (`{ path }`) for a file that is not there. `Threw` carries anything
else the action threw, with a tagged error whole as `thrown`; `Refused` means
nothing ran, with serve's `next` when it has one; `Unreachable` means no
answer came back. Whatever becomes of the snapshot after a call, the
call resolves; the app's status on the computer that serves it says when one
failed.

A view hands these calls to TanStack Query through Wellcrafted's
`resultQueries` and `resultMutations` (ADR-0661), and makes its one
QueryClient with `createQueryClient()`: every write refreshes every read the
page shows before it counts as done, and reads refresh when the view is shown
again (its tab or app comes back). Nothing refreshes on a timer.

```ts
import { resultMutations, resultQueries } from 'wellcrafted/query';

export const reads = resultQueries(['reading'], { list: app.books.list });
export const writes = resultMutations(['reading'], { set: app.books.set });
// In a component: createQuery(() => reads.list()), createMutation(() => writes.set)
```

`ActionInput<A>` and `ActionOutput<A>` name what action `A` takes from a
caller and returns to a client: `ActionInput<typeof app.actions.set>`. A field
with a default is optional in `ActionInput`.

A UI routes to a record by its whole path, each part URL-encoded, so no UI
needs code that knows the app's templates. Capture, Tasks, and Vocab put a
record's page at its path: `#/data/tasks/<time>.md`.
