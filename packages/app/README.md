# @epicenter/app

What an app's `code/epicenter.ts` imports
([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md)).
An app container under `apps/` holds code/, data/ and local/ siblings. data/
is what the person would want back if this computer were lost; local/ is what
this computer can rebuild or sign in again, and it never leaves it. Its
`code/epicenter.ts` default-exports `defineApp(({ folder }) => ...)`. The
`epicenter` command turns each of its actions into a command for the person
and an MCP tool for their agent, and its UI calls the same actions.

```ts
// <Epicenter>/apps/reading/code/epicenter.ts
import { defineAction, defineApp, defineData, field, Ok } from '@epicenter/app';

export default defineApp(({ folder }) => {
  const data = defineData(folder, {
    books: {
      description: 'book I am reading',
      fields: { title: field.text(), finished: field.date({ optional: true }) },
    },
  });

  const log = defineAction({
    description: 'Record minutes read today',
    input: { minutes: field.number(), book: field.text({ optional: true }) },
    annotations: { destructiveHint: false },
    run: async ({ minutes, book }) => {
      await folder.edit('data/2026.csv', (before = 'minutes,book\n') =>
        Ok({ text: `${before}${minutes},${book ?? ''}\n` }),
      );
      return Ok({ minutes });
    },
  });

  return {
    description: 'How much I read each week',
    data,
    actions: { books: data.books.actions('list', 'get', 'create', 'patch'), log },
  };
});
```

The app is a function of its folder
([ADR-0960](../../docs/adr/0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md)).
`epicenter` calls it once with the folder of `apps/reading/`, and everything
inside it, data and actions alike, reaches the files through that argument.
A helper outside the function that touches files takes the folder as a
parameter.

`epicenter reading log '{"minutes":30,"book":"Dune"}'` runs `log`;
`epicenter reading books patch '{"id":"dune","finished":"2026-11-10"}'`
runs a verb the data key gives. `@epicenter/app` is the API of the `epicenter` that runs
the app, and the package that holds that command too. An Epicenter is one Bun
workspace whose `package.json` depends on `@epicenter/app`, so `bun install`
at the top of the Epicenter installs one copy, puts `epicenter` in
`node_modules/.bin/`, and `epicenter.ts`, the editor, `bun test` and the UI's
build all find it by ordinary resolution.
An app's `code/package.json` names only the app's own dependencies and never
lists `@epicenter/app`, so the app runs the version the Epicenter names. After
the Epicenter's packages change, restart `serve`. An app's name is its folder's.

The package ships its TypeScript source and runs under Bun. See
[the command's README](src/command/README.md#an-epicenter-is-a-bun-workspace) for the
Epicenter's `package.json`, upgrading, and trying an unreleased change.

## Three values, composed

`defineData`, `defineAction`, and `defineApp` each check what they are
given and throw when it is wrong in a way the types cannot say. `epicenter`
lists an app whose `epicenter.ts` throws while loading, or whose default
export `defineApp` refuses, with those lines as its problems, and does not
run it.

- `defineData` returns one handle per key: methods an action calls
  (`data.books.get('dune')`) and `actions(...)`, which gives the verbs it
  names.
- `defineAction` returns the action as a function of its input, carrying its
  description, input, and `annotations`. It exists to type
  `run`'s input from `input`: an action written inline in `defineApp` would
  have an untyped input. However it is called, `run` gets an absent switch as
  `false` and an absent list as `[]` (unless the list has a `min`), and every
  other field as the caller gave it. Every action returns one Wellcrafted
  Result. Return `Ok(value)`, return a tagged Err, or forward the Result of
  another call. `@epicenter/app` exports `Ok`, `Err`, `Result`, and
  `defineErrors`. Error factories already return Err. `run` may take a
  second argument, `update`, and call it to report while it runs; its return
  is still the answer. The UI, CLI and MCP receive its JSON form.
- `defineApp` takes a function of `{ folder }` and returns a function that
  calls it and checks what it returned. That object needs
  `description` and `actions`, with `{}` for none, and takes `data` when the
  app keeps records. Each action's words are its keys in `actions`, so
  `{ books: data.books.actions('list', 'get', 'create', 'patch'), log }` gives
  `books list` through `books patch` and `log`. `app.actions.books.create(...)`
  in code, `epicenter reading books create` on the command line, and
  `reading_books_create` over MCP are one action. No key at any depth may be
  `then`, which a UI's client cannot call.

An app with one data key usually spreads its verbs at the top, so they are
the app's own: `actions: { ...data.tasks.actions('list', 'get', 'patch'), add }`
reads `epicenter tasks add`, not `epicenter tasks tasks add`. An app with
several keys nests each under its name, as the example above does.

A later key replaces an earlier one, as in any object:
`{ ...data.words.actions('list', 'get', 'create'), create: learn }` gives
`create` from `learn`. An action is a function, so `{ ...learn, description: 'x' }`
drops its call; `defineApp` refuses it and says to use `defineAction`.

## Data

`defineData` declares an app's records as top-level keys under `data/`. A
key's name decides its shape:

| Key | Files | A record's name |
| --- | --- | --- |
| `notes` | every `.md` file directly in `data/notes/` | its id, the file name without `.md` |
| `settings.md` | the one file `data/settings.md` | none |

A key is a name (lowercase letters, digits, and dashes, starting with a
letter), optionally followed by `.md`. Each key gives `fields`, and may give a
`description` of one record, which its verbs' descriptions use.

An id is the file's name exactly as it is on disk: non-empty NFC text of at
most 200 UTF-8 bytes, without `/`, `\`, control characters, a leading dot,
or whitespace at either end (ADR-0933). No method or generated verb changes
an id: one that does not fit returns `Misfit` at the key's folder, quoting
the id with the reason and, when trimming or NFC would fix it, the name to send instead.
An app trims or normalises what a person typed before it passes it on.
`list` skips a file whose name is not an id. An action that takes an id
takes it as `field.text()`; the handle refuses one that cannot name a file
when the action reads or writes it. A new record's id comes from the caller
or the app. A generated `create` takes `id` optionally and names the record
with `timeId()` when it is left out; the `create(id, record)` method always
takes one.

Each file's fields are its front matter, as `key: <JSON>` lines, and its body
is the text after it. Each line is read on its own, and no YAML is read
(ADR-0924):

| A line | Reads as |
| --- | --- |
| `key: <text>`, and the text is JSON | that key's value |
| `key: <text>`, or `key:`, and the text is not JSON | that key is absent, with a problem that gives the line number and what to write |
| anything else, or a key a second time | the front matter cannot be read |

A write replaces only the lines of the keys it names and keeps every other
line byte for byte, so `due: 2026-11-20` typed by hand stays until a write
names `due`. Plain data given for that key replaces the line, which is how
it can be repaired when the entire patched record fits. A computed write
requires a fitting record before it runs. A file that
does not open with `---` has no front matter and is all body. A file that
opens with `---` and has any other line, a key twice, or no closing `---`,
has front matter that cannot be read: `get` and every writer refuse it until
it is fixed by hand. `list` returns a `Misfit` for that file beside the
Results for the other files.

### Methods and verbs

An action reads and writes through a key's handle. A folder key's method
that names one record takes its id first, and a method that changes it takes
the change second. A one-file key's methods take no id.

| Method | What it does |
| --- | --- |
| `get(id)` | `Ok(record)`, `Ok(undefined)` when the file is absent, or an Err with the reason |
| `list()` | one Result per file, sorted by path; folder keys only |
| `create(id, record)` | creates the file, or returns `Changed` (`there`) when it exists; folder keys only |
| `patch(id, change)` | merges a change into an existing record; an absent id returns `Missing`. A one-file `patch(change)` creates its file |
| `edit(id, fn)` | computes a patch from a fitting record, or from `undefined` when the file is absent, and may create it |
| `edit(id, { old, new })` | replaces the one passage `old` of the body with `new`; `Changed` (`quote` or `twice`) unless `old` is there exactly once, and `Missing` when the file is absent |
| `delete(id)` | returns whether a file existed |
| `path(id)` | the record's path for the id as given, without checking it or the disk |

Writes return the fitting record in Ok. Check a write's Result before
continuing work that depends on it. A malformed record produces `Misfit`.
A plain patch can repair it when the front matter is readable and the
resulting record fits. A computed write refuses before invoking its callback.
A change merges as JSON Merge Patch: `null` removes an optional field, and
`body` replaces the whole text after the front matter.

A name can go wrong two ways. `create` refuses a name that is taken, and a
folder key's `patch` refuses one that is not there, so a mistyped id never
makes a stray file. Code that computes a name and makes the record when it is
absent uses `edit` with a function.

`actions(...verbs)` gives the verbs it names, and only those: a folder key
offers `list`, `get`, `create`, `patch`, `edit`, and `delete`, and a one-file
key `get`, `patch`, `edit`, and `delete`. A verb's input is its method's
arguments folded into one object: the id as `id`, and the change's keys
beside it, so `epicenter vocab patch '{"id":"serendipity","meaning":"a lucky find"}'`
calls `patch('serendipity', { meaning: 'a lucky find' })`. The function form
of `edit` stays in code, since a caller cannot send a function. Two verbs
differ from their method: `create` names the record with `timeId()` when
`id` is left out, and `get` returns `Missing` for an absent folder id where
the method returns `Ok(undefined)`. `list` returns `Ok(rows)`, one Result per
file, bodies included; `delete` returns the boolean in Ok.

The `edit` verb takes `id`, `old`, and `new`, and no fields. `old` is a
non-empty passage of the body the caller last saw, and `new` replaces it.
When `old` is not in the body now, or is there twice, the answer is `Changed`
with `cause` `quote` or `twice`, and nothing is written. A caller that changes
fields and a passage makes two calls:

```sh
epicenter vocab patch '{"id":"serendipity","meaning":"a lucky find"}'
epicenter vocab edit '{"id":"serendipity","old":"First seen.\n","new":"First seen in a novel.\n"}'
```

`patch` and `delete` are safe to repeat, and their annotations say so.
`create` without an id makes another record on each call, and a repeated
`edit` replaces again in the text it already changed, so neither is marked
idempotent. A caller that may retry `create` sends an id.

Two callers patching the same field from stale screens: the last write wins.
Two callers patching different fields both land, since a write changes only
the lines it names.

A value computed from `get` and written later with `patch` can overwrite a
concurrent change. Compute it inside the write with `edit` and a function. Its callback
must return a Result: `Ok(patch)` to apply fields or body, or a tagged Err to
decline. The caller receives that Err and the file stays as it was. The
callback runs once, and no other write to the file runs between its read and
its write. `Ok({})` leaves an existing record alone. Vocab's review can
therefore count two concurrent reviews:

```ts
return data.words.edit(word, (found) =>
  found ? Ok(schedule(found, grade, now)) : ActionError.Missing({ path: data.words.path(word) }),
);
```

A handle reads and writes the folder `defineData` was given. Loading an app
should not touch its files: the function's body declares data and actions,
and only an action reads or writes.

### What a read gives

A record is its `path`, its `id` for a folder key, its fields, and its
`body`. A computed read forwards a refusal or handles it before using fields:

```ts
const read = await data.watches.get(id);
if (read.error !== null) return read;
if (!read.data) return ActionError.Missing({ path: data.watches.path(id) });
return Ok(read.data.from);
```

`Misfit` carries the file path, the record's `id` in a folder key (a one-file
key has none), and its diagnostic lines and kinds. When
front matter is readable, it also carries `record`: the path, id, body, and
the fields that fit, for a repair form. `partitionResults(await data.watches.list())`
from `@epicenter/app` separates fitting records from files that need repair.
UI code can import the same helper from `@epicenter/app/client`.

`checkData(folder.path, data)`, which `epicenter check` runs, reads every key
and reports each file that does not fit, each name that is not an id, names
that are one file on a disk that ignores case, and each reference that names
no file, each as one line.

### What a definition may say

`defineData` refuses:

- a key that is not a name, optionally followed by `.md`;
- a field named `path`, `body`, or `id`: a read gives `path`, and a verb's
  input folds the fields beside `id` and `body`;
- a field marked `readOnly`: an app offers only the verbs a caller may use;
- a field name that a front matter line cannot hold;
- a field whose schema has a `default` at any depth. Write the default in
  code where the value is read: `(record.limit ?? 50)`;
- a `field.ref` whose target is not a folder key of the same `defineData`.

### Naming a record

The generated verbs take a record's id: `epicenter vocab get '{"id":"你好"}'`.
An action you write chooses its own input, and one people or agents call
should take what they know. Vocab's `review` takes `{ word, grade }` and calls
`data.words.edit(word, ...)`, so a caller gives
`epicenter vocab review '{"word":"你好","grade":"good"}'`.

## Fields

| Field | Value | In the input object |
| --- | --- | --- |
| `field.text()` | `string` | `"name": "text"` |
| `field.number({ min, max })`, `field.integer({ min, max })` | `number` | `"name": 4` |
| `field.date()` | `string`, `2026-11-08` | `"name": "2026-11-08"` |
| `field.datetime()` | `string`, RFC 3339 | `"name": "2026-11-10T22:41:05+08:00"` |
| `field.select(['a', 'b'])` | `'a' \| 'b'` | `"name": "a"` |
| `field.boolean()` | `boolean`, `false` unless given | `"name": true` |
| `field.list(item, { min })` | an array of `item`'s value, empty unless given, or required with at least `min` items | `"name": ["a", "b"]` |
| `field.ref('shelves')` | `string`, the id of a record in the folder key `shelves` | `"name": "essays"` |

`field.list(item)` is a list of any field: `field.list(field.select(['x', 'threads']))`
is several of a fixed set, and `field.list(Type.Object({ name: Type.String() }))`
is several objects. It is not required, reads as `[]` when its line is
absent, and a write may leave it out. `field.list(item, { min: 1 })` needs at
least one item: its schema has `minItems`, it is required like any other
field, and an absent one is missing rather than `[]`, which would not fit.
An action that cannot run without an item says so this way, so `--help` and
the schema an agent receives call it required. `min: 0` is the same as none.

`field.ref('shelves')` holds the id of a record in the folder key `shelves`
of the same `defineData`: `"essays"` for `data/shelves/essays.md`, never the
path. `field.list(field.ref('shelves'))` holds several. `defineData` refuses
a ref whose target is not a folder key beside it, in its types and when it
runs.

- A write takes a ref as given and opens no other file, so a ref may name a
  record that is not there. `epicenter check` reports each one, such as
  `shelf "poems" names no file in shelves/`.
- A read returns the id and opens no other file, so an id whose record was
  deleted since still reads as that id.
- In an action's `input`, a reference is text. The action finds out whether
  the record exists, and whether the id can name a file, when it reads it.

A reference's JSON Schema is text with its target key, which the app
listing prints with the rest of the schema:
`{ "type": "string", "x-epicenter-ref": { "key": "shelves" } }`.

Each field is JSON Schema, so any TypeBox schema works as a field too. A field
is required unless it says `optional: true`. A field helper given an
option it does not declare, such as `field.integer({ default: 50 })`, is a
type error and throws naming it. No field has a `default`: `defineData`
and `defineAction` refuse a schema with one at any depth, so the default is
written in code where the value is read. `field.boolean` and `field.list`
mark their schema `"x-epicenter-field": "switch"` or `"list"`, which names
their kind rather than a value; a read and an action's call give an absent
one as `false` or `[]`, except a list with `minItems`, which is required.
Raw JSON Schema annotations pass through unchanged. Schemas must serialize as
finite JSON; recursive schemas use references rather than cyclic JavaScript
objects. No field name is reserved: the command line reads the input as one
JSON object, so `json`, `help`, and `input` are keys like any other.

### An action's input schema

An app writes an action's input as a map of fields. `defineAction` turns the
map into one JSON Schema object and keeps that as `action.input`
(ADR-0953). For Reading's `log` above it is:

```json
{
  "type": "object",
  "required": ["minutes"],
  "properties": { "minutes": { "type": "number" }, "book": { "type": "string" } },
  "additionalProperties": false
}
```

`required` lists every key a caller must give, and is `[]` when none is.
TypeBox marks an optional field with a property that `JSON.stringify` drops,
so `required` is the only record of it that survives being sent. The schema
survives `JSON.parse(JSON.stringify(...))` unchanged. Every caller reads this
one value: the check a call's input passes, MCP's `inputSchema`, `--help` and
its example, and `epicenter <app> --json`. `objectSchema(fields)` builds the
same object from any map of fields.

A secret, such as a token, is ordinary input: the app's page sends it once
and the action keeps it under `local/`, which never enters Git:
`await folder.write('local/google.md', token)`, read back with
`readFile(join(folder.path, 'local/google.md'), 'utf8')` from `node:fs/promises`.
An action writes only under `data/` and `local/`. Epicenter treats that input as any other, so give it from the page or
piped on stdin, not as a command argument or through an agent.

`localDay()` and `localTime()` give now, or a `Date` passed to them, as
`field.date` and `field.datetime` hold it, in the time zone of the computer
that runs the action: `2026-11-10` and `2026-11-10T22:41:05+08:00`. Reading's
`start` writes `started: localDay()`.

`field.text({ pattern, description })` takes a regular expression the whole
value must match. Write the `description` to read after "must be", since the
command line's refusal reads `title must be <description>` and a read's
problem reads `title: "…" is not <description>`. Tasks' title is
`{ pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$', description: 'one line, not blank, saying what to do' }`.

On the command line an action's whole input is one argument, the JSON object,
or `-` to read it from stdin (ADR-0925):
`epicenter reading between '{"from":"2026-11-01","to":"2026-11-08"}'`.
HTTP, MCP, and the command line check it alike, and a key the action does not
take is refused.

An action's `annotations` are MCP's tool annotations, verbatim:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, with
MCP's defaults. An action that does not say otherwise reads as one that may
destroy. They are hints for an MCP client, which decides from them how careful
to be before a call. Epicenter forwards them and enforces none: an action
marked `readOnlyHint: true` that writes is the action's own mistake.

An action that declares `mcp: false` is not offered to agents over MCP:
`tools/list` leaves it out and `tools/call` refuses its name. The Messages app
marks "send a message as me" this way, so an agent that reads messages from
strangers is not also handed a send tool. The command line, HTTP, pages and
routines call the action as any other. The key shapes the tool list and is not
a wall: an agent with a shell can still call the action through the CLI or
HTTP.

## Runs

Whatever runs an action calls the app with its folder, then calls the
action: `app({ folder: folderOnDisk(dir) }).actions.log(input)`. `epicenter`
does this with the app's container, and a test does it with a temporary
directory. There is no hidden state between the two: what an action reaches
is what its app function was given.

The folder is `folderOnDisk(dir)`
([ADR-0964](../../docs/adr/0964-a-folder-is-on-disk-and-it-holds-a-path-and-the-calls-that-change-files.md)).
It has four members:

| Member | Does |
| --- | --- |
| `path` | the app's container, `apps/<app>/`, as a real path |
| `write(path, content)` | replaces the file with `content`, text or bytes |
| `edit(path, decide)` | reads the text, calls `decide` with it, and writes what it returns |
| `delete(path)` | removes the file; an absent file is no error |

Reads are plain file reads through `folder.path`, with `node:fs` or
`Bun.file`. Paths given to the folder are relative to it with `/` between
parts.

An action changes files and makes no Git commit. Its writes remain pending,
including when it returns an Err, throws, or stops. Git stores the Epicenter, and its
commits record code and records together
([ADR-0910](../../docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md), Accepted).
Reads tolerate records that no longer fit the declaration; repair follows a
code change rather than blocking the whole app.

Nothing locks a call. One process, `epicenter serve`, runs every action,
including one the command line sends.
Fetch or compute first and write last, so a slow step never leaves a file
half done.
`folder.write` replaces the file, and the last write wins. A change that
depends on what it read goes through `folder.edit(path, decide)`: it reads
the file and calls `decide` with its text, `undefined` when there is none.
`decide` returns `Ok({ text })` to replace the file, `Ok({ value })` to leave
it and hand `value` back, both to do both, or `Err(reason)` to refuse; the
folder returns that Result. Leaving out `text` leaves the file as it is, an
absent one absent. `decide` runs once, and no other write through the folder
runs between the read and the write; a writer outside epicenter, such as an
editor, is not guarded against. A `decide` that throws writes nothing. Every
data write (`create`, `patch`, `edit`, and the verbs built on them) goes
through it, so two `patch`es of different fields of one file both land, and
two `edit`s of one field each see the other's.

```ts
await folder.edit('data/2026.csv', (before = 'minutes,book\n') =>
  Ok({ text: `${before}${minutes},\n` }),
);
```

A write replaces a file by writing `local/.tmp/<uuid>` and renaming it over
the target, so nothing unfinished is ever under `data/`. When the folder
makes `local/` it writes `local/.gitignore` containing `*`
([ADR-0963](../../docs/adr/0963-local-ignores-itself-and-serve-refuses-a-dotenv-that-git-would-commit.md)).
A file it makes under `local/` is readable by its owner alone (`0600`), and
a directory there is `0700`.

The folder is a convenience, not a sandbox: an action may also write through
`folder.path` with `node:fs`. That path is the real app container, not code/
or data/. What the app can rebuild lives in files it
gitignores inside its folder, such as `code/ui/dist/`; they are never committed.
Every write through the folder stays under `data/` and `local/`, and one
outside them throws. Reads may reach code files.

## Updates while an action runs

An action reports by calling `update`, the second argument of `run`. Annotate
it with `Update<T>`, and that `T` is the type of every caller's `onUpdate`:

```ts
import { defineAction, field, Ok, type Update } from '@epicenter/app';

type Progress = { copied: number; of: number };

const sync = defineAction({
	description: 'Copy new mail',
	input: { account: field.text() },
	async run({ account }, update: Update<Progress>) {
		const ids = await newMail(account);
		for (const [index, id] of ids.entries()) {
			await copy(id);
			update({ copied: index + 1, of: ids.length });
		}
		return Ok({ copied: ids.length });
	},
});

// Any caller, in the Epicenter or in a page:
await sync({ account }, { onUpdate: ({ copied, of }) => show(copied, of) });
```

- `update` takes one value that survives JSON. It returns at once and never
  throws: what a listener returns is not awaited and what it throws is
  dropped, so no caller can slow or stop the action.
- A helper that reports takes `update` as an ordinary parameter. It stays a
  plain async function and can report from inside `Promise.all` or an event
  listener.
- An update reports and is never the answer. A caller that passes no
  `onUpdate` loses nothing, and a page must show the right thing after the
  call ends even if every update was lost.
- An action that leaves the argument out sends no updates, and its callers
  take no `onUpdate`. `run` is never an `async function*`; `defineAction`
  refuses one.
- The CLI sends its call to serve and writes each update to stderr as one
  line of JSON. MCP sends the tool result alone.

Serve keeps nothing about a call. It runs the action to its end whether or
not its caller stays, and nothing stops it from outside. A page that reloads
loses the updates of a call it was watching, so what must survive a reload
belongs in the app's records. An action that must not run twice takes an id
in its input and uses it as the record's key. See the
[CLI's call route](src/command/README.md#a-call-over-http).

## A UI

An app's UI calls its actions through `epicenter serve`, under the same words,
typed by the app. It imports the app as a type, so its bundle carries no app
code:

```ts
import { type ActionOutput, connect } from '@epicenter/app/client';
import type reading from '../../epicenter.ts';

const app = connect<typeof reading>();
type Book = ActionOutput<ReturnType<typeof reading>['actions']['books']['get']>;

const { data: books, error } = await app.books.list();
```

The client exposes the action's Result in JSON form, exactly as serve
answers it: `{ data, error }`, where `error` is `null` or the error object
itself
([ADR-0953](../../docs/adr/0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md)).
Its error type is exactly the errors the action returns and the three only
Epicenter answers, `NotStarted`, `Threw` and `Unreachable`, which
`@epicenter/app/client` exports as types. A `switch` on `error.name` is
exhaustive, and comparing a name the action cannot return is a compile error.
Producers import the shared `ActionError` factories from `@epicenter/app`:

- `Changed` (`{ path, cause }`): a quoted passage changed or is there twice, or a new record's file is already there.
- `Misfit` (`{ path, id?, problems, record? }`): a file, or a change to one, does not fit the declared fields. Each problem has its `line` and its `kind`; a read carries the partial `record`. The library answers it for a value that does not fit, an unknown field, removing a required field, a body that is not text, an id that cannot name a file, and bad `edit` arguments.
- `Missing` (`{ path }`): the file is not there.
- `Refused` (`{ message, next? }`): the app said no. The library never answers it; it is a ready-made name for an app's own refusal.
- `Problems` (`{ message, report, next? }`): it ran, `report` is what it found, and the job is not clean. The command line prints `report` on stdout, where data would be, and `message` on stderr.

Three more belong to the platform's handling of a call, and each says whether
the action ran:

| Error | Did the action run? |
| --- | --- |
| `NotStarted` (`{ message, cause, ... }`, fields by `cause`) | no: serve or the CLI refused it before it began |
| any other error, the action's own | yes |
| `Threw` (`{ message, thrown? }`) | yes, and it threw; a tagged value that survives JSON is kept as `thrown` |
| `Unreachable` (`{ message }`) | unknown: the connection dropped, a line was not a frame, or no answer came |

`NotStarted` is one name whose fields depend on its `cause`, so narrowing on
`cause` types them:

| `cause` | Why it never began | Its fields |
| --- | --- | --- |
| `usage` | the words, input or target do not fit | `next?` |
| `app-problems` | the app cannot load | `app`, `problems` |
| `internal` | Epicenter failed before it ran | none |
| `unavailable` | no serve for this Epicenter answers | `next?` |

An action cannot answer `NotStarted` or
`Unreachable`: serve turns an action's own into `Threw`, by its name alone. An action may still return `Threw`.

An error is its name, its message and its own fields, with no marker of who
made it: the name says. The client checks the fields of `Threw` and of each
`NotStarted` cause, and returns every error whole, preserving its message
and extra fields. App-defined errors keep their names and public
fields. `readAnswer` and `checkAnswer`, exported from `@epicenter/app`, are
the one reader of serve's answer the client and the CLI share; anything that
is not an answer is `Unreachable`.

A page can retry a `NotStarted` once its cause is fixed. Any other name gives
the failure reason, not proof of what was saved. When a UI needs to know what
persisted, it rereads the record. While the outcome is uncertain, it keeps
the person's draft and reports the uncertainty. `Missing` and `Changed`
identify their own `path`, which may belong to a dependency; match the
requested record before interpreting either as its state.

A UI hands these calls to TanStack Query through Wellcrafted's
`resultQueries` and `resultMutations` (ADR-0661), and makes its one
QueryClient in its own `src/lib/query-client.ts`, from its own
`@tanstack/svelte-query`, so the bundle carries one TanStack Query. This
package does not depend on TanStack Query.

```ts
import { resultMutations, resultQueries } from 'wellcrafted/query';

export const reads = resultQueries(['reading'], { list: app.books.list });
export const writes = resultMutations(['reading'], { patch: app.books.patch });
// In a component: createQuery(() => reads.list()), createMutation(() => writes.patch)
```

An action that sends updates accepts `onUpdate` after its input. Each update
arrives in order. What the callback returns is not awaited; what it throws is
reported to the page and does not end the call:

```ts
const said = await vocab.chat.say(
	{ message },
	{ onUpdate: (token) => (draft += token) },
);
```

Closing the page stops the page from listening; the action runs to its end.
A call that reaches no answer resolves to `Unreachable`: the action may have
run, so the page rereads its records.

`ActionInput<A>`, `ActionOutput<A>`, and `ActionUpdate<A>` name what action
`A` takes from a caller, returns to a client, and reports while it runs:
`ActionInput<ReturnType<typeof app>['actions']['patch']>`. A switch and a list without `min` are
optional in `ActionInput`; an action that only returns reports `never`.

A UI routes to a record by its id, which every folder row carries,
URL-encoded: `#/words/<id>`. The page calls `get` with the id from its
route, so the route never spells the record's path.

## Upgrading from 0.6

0.7.0 renames a data handle's write verbs and `pathOf`. Behavior is unchanged except where noted. TypeScript flags every call to an old method, so in each app run the type-check and fix what it names.

| 0.6 | 0.7 |
| --- | --- |
| `data.books.add(id, record)` | `data.books.create(id, record)` |
| `data.books.set(id, change)`, one-file `set(change)` | `data.books.patch(id, change)`, one-file `patch(change)` |
| `data.books.update(id, fn)`, one-file `update(fn)` | `data.books.edit(id, fn)`, one-file `edit(fn)` |
| `data.books.pathOf(id)`, one-file `pathOf()` | `data.books.path(id)`, one-file `path()` |
| the generated `set` given `{ id, edit: { old, new } }` | the generated `edit` given `{ id, old, new }`, or `data.books.edit(id, { old, new })` in code |

### What the compiler does not catch

- **Action lists are strings.** In `data.<key>.actions(...)`, replace `'add'` with `'create'`, and `'set'` with `'patch', 'edit'`. Listing `edit` keeps passage edits available to agents.
- **Pages call actions by name.** `app.set(...)` becomes `app.patch(...)`, and `app.add(...)` becomes `app.create(...)`. A page that sent `edit: { old, new }` to `set` now calls `app.edit({ id, old, new })`.
- **Scripts, routines and docs** that run `epicenter <app> set` or `add` with a generated verb need the new name.
- **An app's own action that happens to be named `add`** is not a generated verb. It keeps its name.

### Behavior that changed

- **Fields and a passage in one call.** The generated `edit` takes only `{ id, old, new }`. A caller that changed fields and a passage in one `set` call now sends a `patch` and then an `edit`, or the app defines an action that does both in one `edit(id, fn)`.
- **One-file keys.** A passage `edit` on a missing file answers `Missing`. It used to answer `Changed` (`quote`).
- **Idempotency hints.** `create` and `edit` now declare `idempotentHint: false`. An agent that may retry `create` should send an id.

### The answer is `{ data, error }`

Serve no longer wraps a failure in `{ kind, reason }`. Every surface (a
page's client, `--json`, MCP's `structuredContent`, the HTTP `answer` line)
gives the error object itself:

| 0.6 | 0.7 |
| --- | --- |
| `{ "error": { "kind": "returned", "reason": { "name": "Missing", ... } } }` | `{ "error": { "name": "Missing", ... } }` |
| `{ "error": { "kind": "fault", "message": "...", "thrown": ... } }` | `{ "error": { "name": "Threw", "message": "...", "thrown": ... } }` |
| `{ "error": { "kind": "refused", "reason": { "name": "Usage", ... } } }` | `{ "error": { "name": "NotStarted", "cause": "usage", ... } }` |
| a page's `Refused` for a call serve never ran | `NotStarted` |
| a cut connection in the CLI, `kind: "fault"` | `Unreachable` |

- **A page, script or test that read `kind` or `reason`** reads `error.name` and the error's own fields. A test that fakes serve's answer writes the plain error. `epicenter <app> <action> --json | jq .error.reason.message` becomes `jq .error.message`.
- **A page that matched `Refused` to catch a call that never ran** matches `NotStarted`. `Refused` now comes only from an action.
- **An action that returned `ActionError.Unreachable`**, or its own error named `NotStarted` or `Unreachable`, now answers `Threw`. Return another name, or `Ok` with a field saying the result was not confirmed.
- **Exit codes:** 2 is exactly `NotStarted`. A connection that dropped after the call was sent still exits 1, now as `Unreachable`.
- **The CLI's own commands answer the same way.** A script that reads `epicenter --json`, `epicenter <app> --json` or `check --json` reads the result under `.data`, and a failure under `.error`: `epicenter --json | jq .apps` becomes `jq .data.apps`. A command that never began, such as a misused word, answers `NotStarted` and exits 2. A `check` that finds problems ran and still exits 1: it answers `Problems`, and the report that was `data` is `.error.report`, so a script that read `jq .apps` reads `jq '.data // .error.report | .apps'`.
- **A page or test that matched `Refused` from a library write** matches `Misfit`. A data handle or generated verb answers `Misfit` for a value that does not fit, an unknown field, removing a required field, a body that is not text, an id that cannot name a file, and bad `edit` arguments; the problem is in `problems[].line`, and the message now begins `<path> does not fit its fields:`. `Refused` from your own action is unchanged.
- **`Changed.why` is `Changed.cause`**, with the same values: `there`, `quote` and `twice`.
- **Errors no longer carry `namespace`.** A test that faked an error with `namespace: "epicenter/action-error"` drops the field; the name says which error it is.
- **A page that compares an error name its action cannot return** gets a compile error. A call's error is now exactly the action's errors and `NotStarted`, `Threw` and `Unreachable`, so a branch for a name that never arrives is dead: delete it.

### An action's input is one JSON Schema object

Write an action's `input` as before, a map of fields. What an action carries
changed: in 0.6, `action.input` was that map; in 0.7 it is one JSON Schema
object, with the fields under `properties` and the keys a caller must give in
`required` (see [An action's input schema](#an-actions-input-schema)).

- **Code that read a field from the map** reads it from `properties`:
  `add.input.title` becomes `add.input.properties.title`, and
  `Object.keys(add.input)` becomes `Object.keys(add.input.properties)`.
- **Code that wrapped the map** in `Type.Object(action.input)` to check a value
  passes `action.input` itself, which already refuses keys the action does not
  take.
- **Code that worked out which keys are required** reads `action.input.required`.
- **An action that reuses another's input** writes
  `input: other.input.properties`. `input: other.input` is a type error, and
  `defineAction` refuses it where it is defined.

TypeScript flags a read of a field from the map, since the schema has no key
of that name. `Object.keys(action.input)` and `toHaveProperty` in a test still
compile, so search each app's code and tests for `.input`.

### Serve no longer checks its version

0.6's serve stated its version on every answer, and a command warned when it
reached a serve older than itself. 0.7 drops that check: upgrading is the
owner's step, not Epicenter's. After `bun install`, restart `epicenter serve`
yourself. Nothing warns you if you forget; the old serve keeps answering with
the old code. `epicenter` still refuses to load apps while the Epicenter names two
different versions of `@epicenter/app` and `@epicenter/cli`.

A data field whose schema carried `x-epicenter-file` used to be refused. No
field helper made that marker, so the check is gone.

### Steps

1. Change both `@epicenter/app` and `@epicenter/cli` to `0.7.0` in the Epicenter's `package.json`.
2. Run `bun install`.
3. Fix each app until `bun run typecheck` and `bun test` pass.
4. Run `bun run build` in each app that has a UI.
5. Restart `epicenter serve`. Nothing reminds you; until you do, the old version answers every call.
6. Commit the result as one commit, so reverting it returns the Epicenter to 0.6.
