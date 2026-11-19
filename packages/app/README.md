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
    actions: { ...data.books.actions('list', 'get', 'create', 'patch'), log },
  };
});
```

The app is a function of its folder
([ADR-0960](../../docs/adr/0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md)).
`epicenter` calls it with the folder of `apps/reading/`, and everything
inside it, data and actions alike, reaches the files through that argument.
A helper outside the function that touches files takes the folder as a
parameter. Serve imports the app and calls the function once, when it
starts, so a value kept in the function body lasts until serve restarts:
keep anything the app must remember in a file.

`epicenter reading log '{"minutes":30,"book":"Dune"}'` runs `log`;
`epicenter reading patch '{"id":"dune","finished":"2026-11-10"}'`
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
  have an untyped input. However it is called, `run` gets the input as the
  caller gave it: an absent field stays absent, and `run` writes its default,
  as `({ done = false })`. Every action returns one Wellcrafted
  Result. Return `Ok(value)`, return a tagged Err, or forward the Result of
  another call. `@epicenter/app` exports `Ok`, `Err`, `Result`, and
  `defineErrors`. Error factories already return Err. `run` may take a
  second argument, `update`, and call it to report while it runs; its return
  is still the answer. The UI, CLI and MCP receive its JSON form.
- `defineApp` takes a function of `{ folder }` and returns a function that
  calls it and checks what it returned. That object needs
  `description` and `actions`, with `{}` for none, and takes `data` when the
  app keeps records. Each action has one name, its key in `actions`, so
  `{ ...data.books.actions('list', 'get', 'create', 'patch'), log }` gives
  `list` through `patch` and `log`. `app.actions.create(...)` in code,
  `epicenter reading create` on the command line, `reading_create` over MCP
  and `app.call('create', ...)` in a page are one action. A name is lowercase
  letters, digits and dashes; actions do not nest. It may also return
  `fetch`; see [Web requests](#web-requests).

Two data keys give verbs with the same names, so an app with several keys
names the second key's apart: `const notes = data.notes.actions('list');`
then `actions: { ...data.books.actions('list'), 'list-notes': notes.list }`.

A later key replaces an earlier one, as in any object:
`{ ...data.words.actions('list', 'get', 'create'), create: learn }` gives
`create` from `learn`. An action is a function, so `{ ...learn, description: 'x' }`
drops its call; `defineApp` refuses it and says to use `defineAction`.

## Data

`defineData(folder, { ... })` declares an app's records, inside the app's
function. Each key is a folder under `data/`: `notes` holds every `.md` file
directly in `data/notes/`, and a record's id is its file name without `.md`.
A key is a name (lowercase letters, digits, and dashes, starting with a
letter). Each key gives a `description`, what one record is as a singular
noun without "a" or "the", such as `"task"` (not `"tasks"`), which its verbs'
descriptions use (`Read one task`, `Every task`), and `fields`.

An app with one record of a kind, such as its settings, gives it a fixed id:
the key `settings` and the id `settings` are the file
`data/settings/settings.md`, read with `data.settings.get('settings')` and
made with `data.settings.edit('settings', (now) => Ok({ ... }))`.

An id is the file's name exactly as it is on disk: non-empty NFC text of at
most 200 UTF-8 bytes, without `/`, `\`, control characters, a leading dot,
or whitespace at either end (ADR-0933). No method or generated verb changes
an id: one that does not fit returns `Misfit` at the key's folder, quoting
the id with the reason and, when trimming or NFC would fix it, the name to send instead.
An app trims or normalises what a person typed before it passes it on.
`list` skips a file whose name is not an id. An action that takes an id
takes it as `field.text()`; the handle refuses one that cannot name a file
when the action reads or writes it. A new record's id comes from the caller
or the app: the method and the generated `create` both require one, and
`timeId()` names a record by the moment it is made, as
`create({ id: timeId(), title })`.

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

An action reads and writes through a key's handle. A method that names one
record takes its id first, and a method that changes it takes the change
second.

| Method | What it does |
| --- | --- |
| `get(id)` | `Ok(record)`, `Ok(undefined)` when the file is absent, or an Err with the reason |
| `list()` | one Result per file, sorted by path |
| `create(id, record)` | creates the file, or returns `Changed` (`there`) when it exists |
| `patch(id, change)` | merges a change into an existing record; an absent id returns `Missing` |
| `edit(id, fn)` | computes a patch from a fitting record, or from `undefined` when the file is absent, and may create it. The patch holds only the fields that change: one that names `path` or `id`, as a spread of the record does, is refused with `Misfit` |
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
`patch` refuses one that is not there, so a mistyped id never
makes a stray file. Code that computes a name and makes the record when it is
absent uses `edit` with a function.

`actions(...verbs)` gives the verbs it names, and only those: `list`, `get`,
`create`, `patch`, `edit`, and `delete`. A verb's input is its method's
arguments folded into one object: the id as `id`, and the change's keys
beside it, so `epicenter vocab patch '{"id":"serendipity","meaning":"a lucky find"}'`
calls `patch('serendipity', { meaning: 'a lucky find' })`. The function form
of `edit` stays in code, since a caller cannot send a function. One verb
differs from its method: `get` returns `Missing` for an absent id where the
method returns `Ok(undefined)`. `list` returns `Ok(rows)`, one Result per
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

`create`, `patch` and `delete` are safe to repeat, and their annotations say
so: a repeated `create` answers `Changed` (`there`) and writes nothing. A
repeated `edit` replaces again in the text it already changed, so it is not
marked idempotent.

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

A record is its `path`, its `id`, its fields, and its `body`. An optional
field absent from the file is absent from the record; nothing is filled in. A computed read forwards a refusal or handles it before using fields:

```ts
const read = await data.watches.get(id);
if (read.error !== null) return read;
if (!read.data) return ActionError.Missing({ path: data.watches.path(id) });
return Ok(read.data.from);
```

`Misfit` carries the file path, the record's `id`, and its diagnostic lines
and kinds. When
front matter is readable, it also carries `record`: the path, id, body, and
the fields that fit, for a repair form. `partitionResults(await data.watches.list())`
from `@epicenter/app` separates fitting records from files that need repair.
UI code can import the same helper from `@epicenter/app/client`.

### What a definition may say

`defineData` refuses:

- a key that is not a name;
- a key without a `description`;
- a field named `path`, `body`, or `id`: a read gives `path`, and a verb's
  input folds the fields beside `id` and `body`;
- a field marked `readOnly`: an app offers only the verbs a caller may use;
- a field name that a front matter line cannot hold;
- a field whose schema has a `default` at any depth. Write the default in
  code where the value is read: `(record.limit ?? 50)`;
- a `field.ref` whose target is not a key of the same `defineData`.

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
| `field.boolean()` | `boolean` | `"name": true` |
| `field.list(item, { min })` | an array of `item`'s value, with at least `min` items | `"name": ["a", "b"]` |
| `field.ref('shelves')` | `string`, the id of a record in the key `shelves` | `"name": "essays"` |

`field.list(item)` is a list of any field: `field.list(field.select(['x', 'threads']))`
is several of a fixed set, and `field.list(Type.Object({ name: Type.String() }))`
is several objects. Like every field it is required unless it says
`optional: true`. `field.list(item, { min: 1 })` needs at least one item
when it is given: its schema has `minItems`. `min: 0` is the same as none.

`field.ref('shelves')` holds the id of a record in the key `shelves` of the
same `defineData`: `"essays"` for `data/shelves/essays.md`, never the path.
`field.list(field.ref('shelves'))` holds several. `defineData` refuses a ref
whose target is not a key beside it when it runs; the types do not check it.

- A write takes a ref as given and opens no other file, so a ref may name a
  record that is not there, and nothing reports it until an action follows
  it.
- A read returns the id and opens no other file, so an id whose record was
  deleted since still reads as that id.
- In an action's `input`, a reference is text. The action finds out whether
  the record exists, and whether the id can name a file, when it reads it.

A reference's JSON Schema is text with its target key, which the app
listing prints with the rest of the schema:
`{ "type": "string", "x-epicenter-ref": { "key": "shelves" } }`.

Each field is JSON Schema, so any TypeBox schema works as a field too. Every
field, `field.boolean` and `field.list` included, is required unless it says
`optional: true`, and an absent optional field stays absent in a read and in
an action's input: nothing is filled in. A field helper given an option it
does not declare, such as `field.integer({ default: 50 })`, throws when the
field is made, naming the options it takes. No field has a `default`:
`defineData` and `defineAction` refuse a schema with one at any depth, so
the default is written in code where the value is read:
`run: ({ done = false, tags = [] }) => ...`. Raw JSON Schema annotations pass through unchanged. Schemas must serialize as
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
piped on stdin, not as a command argument or through an agent. Do not keep
secrets in a `.env` at the root of the Epicenter that Git could commit:
`epicenter serve` will not start while that `.env` is tracked by Git or not
ignored
([ADR-0963](../../docs/adr/0963-local-ignores-itself-and-serve-refuses-a-dotenv-that-git-would-commit.md)).

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
marked `readOnlyHint: true` that writes is the action's own mistake. Write no annotations by default, and `readOnlyHint: true` on an action that
only reads.

An action that declares `mcp: false` is not offered to agents over MCP:
`tools/list` leaves it out and `tools/call` refuses its name. The Messages app
marks "send a message as me" this way, so an agent that reads messages from
strangers is not also handed a send tool. The command line, HTTP, pages and
routines call the action as any other. The key shapes the tool list and is not
a wall: an agent with a shell can still call the action through the CLI or
HTTP.

## The folder

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
- An action that leaves the argument out sends no updates. In the library
  every action still takes `options?: { onUpdate? }`, which it never calls. A
  page's call of such an action takes its input alone, so it stays a function
  of one argument that helpers such as wellcrafted's `resultMutations` accept.
  `run` is never an `async function*`; `defineAction`
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

An app's UI calls its actions through `epicenter serve` by their names,
typed by the app. It imports the app as a type, so its bundle carries no app
code:

```ts
import { type ActionOutput, connect } from '@epicenter/app/client';
import type reading from '../../epicenter.ts';

const app = connect<typeof reading>();
type Book = ActionOutput<ReturnType<typeof reading>['actions']['get']>;

const { data: books, error } = await app.call('list');
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

export const reads = resultQueries(['reading'], { list: app.action('list') });
export const writes = resultMutations(['reading'], { patch: app.action('patch') });
// In a component: createQuery(() => reads.list()), createMutation(() => writes.patch)
```

An action that sends updates accepts `onUpdate` after its input. Each update
arrives in order. What the callback returns is not awaited; what it throws is
reported to the page and does not end the call:

```ts
const said = await app.chat.say(
	{ message },
	{ onUpdate: (token) => (draft += token) },
);
```

Closing the page stops the page from listening; the action runs to its end.
A call that reaches no answer resolves to `Unreachable`: the action may have
run, so the page rereads its records.

`ActionInput<A>`, `ActionOutput<A>`, and `ActionUpdate<A>` name what action
`A` takes from a caller, returns to a client, and reports while it runs:
`ActionInput<ReturnType<typeof app>['actions']['patch']>`. An action that
only returns reports `never` as its `ActionUpdate`.

A UI routes to a record by its id, which every folder row carries,
URL-encoded: `#/words/<id>`. The page calls `get` with the id from its
route, so the route never spells the record's path.

## Web requests

An app may return `fetch` beside `description`, `data` and `actions`: a
web-standard `(request: Request) => Response | Promise<Response>`
([ADR-0945](../../docs/adr/0945-an-app-may-answer-web-requests-at-its-address-with-fetch.md)).
A Hono or Elysia app's `fetch` fits as it is. It reaches the app's folder by
closing over `folder`:

```ts
import { defineApp } from '@epicenter/app';
import { Hono } from 'hono';

export default defineApp(({ folder }) => {
	const web = new Hono({ strict: false }).basePath('/apps/mail');
	web.get('/oauth/callback', async (c) => {
		await folder.write('local/code.txt', c.req.query('code') ?? '');
		return c.redirect('../');
	});
	return { description: 'Mail', actions: {}, fetch: web.fetch };
});
```

`epicenter serve` gives each app the address `/apps/<app>/`. A `GET` or `HEAD`
there answers a file from `code/ui/dist/` when one matches; every other
request goes to `fetch`, and an app without one answers 404. The request
arrives as the browser sent it, whole path included, so the app names its
own address: `basePath('/apps/mail')` above, after its folder. Serve
redirects `/apps/mail` to `/apps/mail/`, so a page route `'/'` needs
`strict: false`, which lets Hono match the trailing slash. A body over
25 MB is refused with 413. A `fetch` that throws answers 500, and serve logs a line naming the app.

`fetch` is for protocols someone else defined: an OAuth redirect, a file
download, a feed, a form upload, or an app's own page when it has no build
step. The command line and MCP never see its routes, so anything a person or
an agent should be able to do is an action. The launcher links only to an
app with a built page.

Serve refuses a request a browser marks as coming from another site
(`Sec-Fetch-Site: cross-site`) unless it opens a page: a top-level `GET`
navigation, which is how an OAuth provider sends the browser back. Another
site's `<img>`, script, `fetch()` or frame gets 403. A cross-site form
`POST`, such as OAuth's `response_mode=form_post`, is refused.

Serve loads the app again for each request that reaches `fetch`, as it does
for each action call, so nothing an app keeps in memory lasts from one
request to the next. A load takes well under a millisecond for a small app
and leaves a little memory behind until serve restarts. A page of many
images makes one load per image.

A test calls `fetch` with no server:

```ts
const app = mail({ folder });
const answer = await app.fetch(new Request('http://localhost/apps/mail/oauth/callback?code=abc'));
```

## Upgrading from 0.7.0

0.8.0 makes an app a function of the folder it is handed
([ADR-0960](../../docs/adr/0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md)),
keeps that folder on disk
([ADR-0964](../../docs/adr/0964-a-folder-is-on-disk-and-it-holds-a-path-and-the-calls-that-change-files.md)),
and puts the `epicenter` command in this package. The command now finds its
Epicenter only by walking up, and asks serve for everything it shows
([ADR-0965](../../docs/adr/0965-the-command-finds-its-epicenter-by-walking-up-and-serve-starts-in-its-folder.md),
[ADR-0961](../../docs/adr/0961-the-command-sends-an-actions-input-to-serve-and-serve-alone-reads-it.md)).
TypeScript flags each change in the first table, so in each app run the
type-check and fix what it names; the sections after it list what it does
not flag, then the steps in order.

| 0.7.0 | After |
| --- | --- |
| `export default defineApp({ description, data, actions })` | `export default defineApp(({ folder }) => ({ description, data, actions }))` |
| `defineData({ ... })` beside the app | `defineData(folder, { ... })` inside the function |
| `import { folder } from '@epicenter/app'` | the `folder` the function is handed; a helper outside it takes the folder as a parameter |
| `folder.read(path)`, `folder.readBytes(path)` | `readFile(join(folder.path, path), 'utf8')` from `node:fs/promises`, or `Bun.file(join(folder.path, path))` |
| `folder.list(dir)` | `readdir` or `Bun.Glob` on `join(folder.path, dir)` |
| `folder.writeBytes(path, bytes)` | `folder.write(path, bytes)`, which takes text or bytes |
| `folder.update(path, (before) => text)` | `folder.edit(path, (before) => Ok({ text }))` |
| `inRun({ folder }, () => action(input))` with `createMemoryContext` in a test | `app({ folder: folderOnDisk(dir) }).actions.log(input)`, with `dir` a temporary directory |
| `(typeof app)['actions']` in a page | `ReturnType<typeof app>['actions']` |
| `@epicenter/app` and `@epicenter/cli` in the root `package.json` | `@epicenter/app` alone, which carries the `epicenter` command |

A `Folder` is now `path`, `write`, `edit` and `delete`; see
[The folder](#the-folder). Every read is a plain file call on
`folder.path`. `inRun`, `createMemoryContext` and the in-memory folder are
gone, so a test makes a temporary directory and calls the app with
`folderOnDisk` on it.

Some other names 0.7.0 exported are gone:

| 0.7.0 | After |
| --- | --- |
| `expectOk`, `expectErr` from `@epicenter/app/testing` | the same functions from `wellcrafted/testing` |
| `textUpdate(edit)` | `folder.edit(path, (before) => Ok({ text }))` |
| `type Context` | the `{ folder }` the app's function is handed |
| `App<A, D>` | `App`, which takes no type parameters |
| `isUnderLocal`, `normalizePath`, `readMarkdown`, `isAction`, `isActionResult`, `encodeActionResult`, `whatFits`, `whatTakes`, `RESERVED_NAMES` | nothing; they were the library's own helpers |

### Data and fields

Every data key is a folder, nothing is filled in, and the library invents no
value. The compiler flags the rows that change a call or a type, at each
place the code breaks, except where a row says it does not. It does not flag
a key still named `'settings.md'`: that compiles, and `defineData` throws
when the app loads, naming the key to write and where to move the file. For the
`done` and `tags` rows it flags only code that leaves the field out of a
record it passes or reads it as always there; the callers and files it
cannot see are in the next section.

| 0.7.0 | 0.8.0 |
| --- | --- |
| `'settings.md': { fields }`, then `data['settings.md'].get()` | `settings: { description: 'settings record', fields }`, then `data.settings.get('settings')`; move `data/settings.md` to `data/settings/settings.md`. Not flagged by the compiler for the key itself, only for the calls; a file left at `data/settings.md` is read by nothing, and nothing lists it |
| one-file `data['settings.md'].patch(change)`, which made the file and repaired one that did not fit | no one call does both now: `data.settings.edit('settings', () => Ok(change))` makes an absent record but answers the `Misfit` for one that does not fit, and `data.settings.patch('settings', change)` repairs one that does not fit but answers `Missing` for an absent one |
| `tasks: { fields }` | `tasks: { description: 'task', fields }`: a description is required, a noun without "a" or "the" |
| `create({ title })` through the generated action, named by the moment | `create({ id: timeId(), title })` |
| `done: field.boolean()`, absent read as `false` | `done: field.boolean({ optional: true })` and `({ done = false })` where it is read, or `field.boolean()` and every file and caller gives it |
| `tags: field.list(field.text())`, absent read as `[]` | `tags: field.list(field.text(), { optional: true })` and `({ tags = [] })` where it is read |
| `field.list(item, { min: 1 })`, required because of its `min` | the same, required because it does not say `optional` |
| `edit(id, (record) => Ok({ ...record, done: true }))` | `edit(id, () => Ok({ done: true }))`; not flagged by the compiler: a patch naming `path` or `id` is refused with `Misfit` at run time |
| `field.ref('missing')` a type error | not flagged by the compiler; `defineData` still throws when it runs |
| `field.integer({ default: 50 })` a type error | not flagged by the compiler; the helper still throws when the field is made |
| `DataRecord<'words', typeof data.words>` | `DataRecord<typeof data.words>` |

### Changes the compiler does not flag

- Serve calls the app's function once, when it starts. A cache or counter kept in the function body lasts until serve restarts; keep what must last in a file. Read and write inside actions, not in the function body.
- A test that relied on memory for speed or isolation writes to its own temporary directory instead, and removes it afterward.
- The function must return a plain object, written `{ ... }`. A class instance, or an object made with `Object.create(base)`, is refused with "An app returns an object".
- `checkAnswer` refuses a `Threw` whose `thrown` is not a plain object, such as an `Error` instance a test passes in, and answers `Unreachable`. An answer read from serve is parsed JSON, so it is unaffected.
- `field.boolean()` and `field.list(item)` are required now. In 0.7.0 they were optional and filled in with `false` and `[]`. Two kinds of caller the compiler cannot see change with them:
  - A JSON caller that leaves one out, such as the command, an agent over MCP, a script or a routine, is refused before `run`.
  - A record file without the line is a `Misfit` with "<field> is missing".

  To keep 0.7.0's behavior, say `optional` and write the default where the value is read:

  ```ts
  // 0.7.0
  done: field.boolean(),
  tags: field.list(field.text()),
  // 0.8.0
  done: field.boolean({ optional: true }), // read as ({ done = false })
  tags: field.list(field.text(), { optional: true }), // read as ({ tags = [] })
  ```

  An optional switch or list absent from a file reads as absent, so code that read `record.tags.length` reads `(record.tags ?? []).length`.
- The generated `create` no longer writes `done: false` and `tags: []` into a new file for fields the caller left out; it writes what `data.<key>.create(id, record)` writes.
- A data action's description uses the key's `description` as written, so `description: 'a note'` reads "Read one a note" and `'notes'` reads "Every notes". Write `'note'`.
- A misspelled field option beside a correct one, such as `field.text({ description: 'Title', optinal: true })`, is not a type error; the helper throws when the app loads. The compiler flags only an options object that shares no key with the helper's.
- The generated `create` declares `idempotentHint: true`, where 0.7.0 declared `false`: it takes an id, so a repeat answers `Changed` (`there`) and writes nothing.
- An agent can no longer make a record named by the moment: the generated `create` takes an id the caller chooses, and `timeId()` runs only in an app's code. An app that wants that writes its own action that calls `timeId()`.
- `epicenter serve` will not start while a `.env` at the root of the Epicenter is tracked by Git or not ignored ([ADR-0963](../../docs/adr/0963-local-ignores-itself-and-serve-refuses-a-dotenv-that-git-would-commit.md)). It says which, and the fix: `git rm --cached .env`, or add `.env*` to `.gitignore`.
- The folder writes `local/.gitignore` when it makes `local/`. A `local/` made another way runs, and is listed as a problem with the one-line fix.

### Where the command runs, and what needs serve

- A command finds its Epicenter only by walking up from the folder it runs in. `EPICENTER_ROOT` and the `~/Epicenter` fallback are gone: `cd` into your Epicenter, or set a script's working directory there.
- `epicenter serve` starts only in the Epicenter's own folder. Started anywhere else it refuses and exits, so a job that restarts it on exit fails again each time. Set the job's working directory to your Epicenter: `WorkingDirectory` in a launchd LaunchAgent's plist, `WorkingDirectory=` in a systemd unit.
- Bare `epicenter`, `epicenter <app>` and an action's `--help` ask serve, and are refused while it is stopped.


### Addresses and action names

Serve's addresses change, every action has one name, and every app's page
must be rebuilt
([ADR-0967](../../docs/adr/0967-serve-keeps-action-calls-outside-an-apps-address-which-is-apps-name.md)).

| 0.7.0 | After |
| --- | --- |
| an app's page at `/<app>/` | `/apps/<app>/` |
| `POST /<app>/<words joined by .>`, such as `POST /vocab/words.create` | `POST /actions/<app>/<action>`, such as `POST /actions/vocab/create-word` |
| actions nested in groups, `actions: { words: { create } }` | one flat name each, `actions: { 'create-word': create }` |
| `epicenter vocab words create`, MCP tool `vocab_words_create` | `epicenter vocab create-word`, MCP tool `vocab_create-word` |
| a page calls `app.list(input)`, `app.words.create(input)` | `app.call('list', input)`, or `app.action('list')` held as a function |
| a refused call: a 400 whose body is `{ data: null, error }` | a 200 whose one line is `{"answer": { data: null, error }}` |

- **Rename grouped actions.** Give each action in a group one name of
  lowercase letters, digits and dashes, and change the scripts, routines and
  playbooks that name it.
- **Rebuild every page** (step 4). A page bundles `@epicenter/app/client`,
  and an old bundle calls the old address, which now answers 404.
- **Bookmarks and home-screen icons** that open `/<app>/` need the new
  address. Nothing redirects.
- **A page that calls `connect()` with no `app`** reads its app from
  `/apps/<app>/` with no change. A page served elsewhere passes `{ app }`.
- **A script or test that posts to serve directly**, or fakes its URLs,
  uses `/actions/<app>/<action>`, and reads a refusal from the `answer` line
  of a 200. Any status other than 200 means serve did not take the call.
- **Serve refuses a cross-site request that does not open a page.** Another
  site that loaded an app's icon or framed its page gets 403.

### Serve loads once, and routines run actions

Serve loads every app once, when it starts
([ADR-0959](../../docs/adr/0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md)),
and a routine names an action instead of a command
([ADR-0937](../../docs/adr/0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md)).
The compiler flags none of these.

| 0.7.0 | After |
| --- | --- |
| an edit to an app's code shows on the next call | it shows after serve restarts; nothing says the code on disk is newer |
| an app that failed to load stayed failed until serve restarted, even once fixed | the same, and so does every app: serve loads once |
| `AGENTS.md` read on each MCP initialize | read once, when serve starts |
| `routines/` read once a minute | read once, when serve starts; restart after adding or changing one |
| a routine with `run: ["epicenter", "flights", "daily", "run", {"recheck": false}]` | `action: "flights daily"` and `input: {"recheck": false}`; a file with `run` is refused |
| a routine running a shell command or Git | not possible; write an action that does it, or use the computer's own scheduler |
| a routine naming a missing action failed when it ran | refused when serve starts, printed beside the address, and listed by bare `epicenter` |
| `EPICENTER.md` with no `port` used 4747 | `port` is required; a marker without one is refused |
| an entry in `apps/` that is a link to a folder elsewhere loaded that folder | refused: `apps/<name> is a link; an app is a folder in apps/, not a link to one` |
| serve rewrote every error it sent, an action's included, showing the Epicenter's folder as `.` and your home folder as `~` | a problem serve makes names a path from the Epicenter's folder, such as `apps/<app>/code/epicenter.ts`; an action's own error is sent as written, full paths included |
| a folder in `apps/` without `code/epicenter.ts` answered 404 at its address | it answers 500 with its problem, and is listed with `no code/epicenter.ts` |
| a second serve on the port, or another program there, reached through a probe | a command naming another Epicenter is refused with 409, naming the folder it took and its marker; serve refuses to start on a port in use |
| a refusal for a missing action named the app's actions only in its message | `--json` also carries them as `error.actions` |
| `epicenter check [<app>]` read every data key and reported files that did not fit, stray names, broken references and old `data/<key>.md` files | deleted; `epicenter check` is refused like any unknown app, and an app may be named `check` |
| `import { checkData } from '@epicenter/app'` | deleted; call a key's `list` action, which answers one Result per file, refusals included |
| a command's error carrying `report` printed that report on stdout | an error prints its message and next step only |

- **Add the restart command to your `AGENTS.md`.** Agents that edit code
  must restart serve to run it. Write how, for this computer, in the
  Epicenter's `AGENTS.md`, such as
  `After editing an app's code, restart serve: launchctl kickstart -k gui/$(id -u)/<label>`.
- **Rewrite each routine** from `run` to `action` and `input`. A routine
  that ran something other than `epicenter <app> <action>` becomes an
  action, or moves to the computer's scheduler.
- **Add `port` to `EPICENTER.md`** if it has none: `port: 4747` between two
  `---` lines.
- **Move a linked app into `apps/`.** Copy its folder in place of the link.
- **Drop `epicenter check` and `checkData`** from scripts and tests. To see
  which records of a key do not fit, call its `list` action.

### Upgrade steps

1. In the root `package.json`, remove `@epicenter/cli` and set `@epicenter/app` to the new version.
2. Run `bun install`.
3. Fix each app until `bun run typecheck` and `bun test` pass, and rename its grouped actions.
4. Run `bun run build` in each app that has a UI.
5. Name `port` in `EPICENTER.md`, rewrite each routine to `action`, and add your restart command to `AGENTS.md`.
6. Restart `epicenter serve`. Until you do, the old serve does not answer the command's addresses, and the command runs nothing.
7. Commit the result as one commit, so reverting it returns everything to 0.7.0.

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
- **The CLI's own commands answer the same way.** A script that reads `epicenter --json`, or `epicenter <app> --json` reads the result under `.data`, and a failure under `.error`: `epicenter --json | jq .apps` becomes `jq .data.apps`. A command that never began, such as a misused word, answers `NotStarted` and exits 2.
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
the old code.

A data field whose schema carried `x-epicenter-file` used to be refused. No
field helper made that marker, so the check is gone.

### Steps

1. Change both `@epicenter/app` and `@epicenter/cli` to `0.7.0` in the Epicenter's `package.json`.
2. Run `bun install`.
3. Fix each app until `bun run typecheck` and `bun test` pass.
4. Run `bun run build` in each app that has a UI.
5. Restart `epicenter serve`. Nothing reminds you; until you do, the old version answers every call.
6. Commit the result as one commit, so reverting it returns the Epicenter to 0.6.
