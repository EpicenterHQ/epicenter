# @epicenter/app

What an app's `code/epicenter.ts` imports
([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md),
[ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).
An app container under `apps/` holds code/ and data/ siblings. Its
`code/epicenter.ts` default-exports `defineApp(...)`. The
`epicenter` command turns each of its actions into a command for the person
and an MCP tool for their agent, and its UI calls the same actions.

```ts
// <Epicenter>/apps/reading/code/epicenter.ts
import { defineAction, defineApp, defineCollection, field, folder, Ok } from '@epicenter/app';

const books = defineCollection({
  path: 'data/books/{slug}.md',
  description: 'book I am reading',
  fields: { title: field.text(), finished: field.date({ optional: true }) },
});

const log = defineAction({
  description: 'Record minutes read today',
  input: { minutes: field.number(), book: field.text({ optional: true }) },
  annotations: { destructiveHint: false },
  run: async ({ minutes, book }) => {
    await folder.update('data/2026.csv', (before = 'minutes,book\n') => `${before}${minutes},${book ?? ''}\n`);
    return Ok({ minutes });
  },
});

export default defineApp({
  description: 'How much I read each week',
  collections: { books },
  actions: { books: books.actions(), log },
});
```

`epicenter reading log '{"minutes":30,"book":"Dune"}'` runs `log`;
`epicenter reading books set '{"slug":"dune","finished":"2026-11-10"}'`
runs a verb the collection gives. `@epicenter/app` is the API of the `epicenter` that runs
the app, so the command supplies it: to `epicenter.ts` when it loads the file,
and to the editor, `bun test`, and the UI's build by linking
`code/node_modules/@epicenter/app` to its own copy (ADR-0873). The code project's
`package.json` names only the app's own dependencies. An app's name is its
folder's.

## Three values, composed

`defineCollection`, `defineAction`, and `defineApp` each check what they are
given and throw, one problem a line, when it is wrong in a way the types
cannot say. `epicenter` lists an app whose `epicenter.ts` throws while loading,
or whose default export `defineApp` refuses, with those lines as its problems,
and does not run it.

- `defineCollection` returns what it was given, plus methods an action calls
  (`books.get({ slug })`) and `actions()`, which gives its verbs to expose.
- `defineAction` returns the action as a function of its input, carrying its
  description, input, and `annotations`. It exists to type
  `run`'s input from `input`: an action written inline in `defineApp` would
  have an untyped input. However it is called, `run` gets an absent switch as
  `false` and an absent list as `[]` (unless the list has a `min`), and every
  other field as the caller gave it. Every action returns one Wellcrafted
  Result. Return `Ok(value)`, return a tagged Err, or forward the Result of
  another call. `@epicenter/app` exports `Ok`, `Err`, `Result`, and
  `defineErrors`. Error factories already return Err. An async generator
  yields progress and returns its final
  Result. The UI, CLI and MCP receive its JSON form.
- `defineApp` checks what it was given and returns that same object. It needs
  `description`, `collections`, and `actions`, with `{}` for none. Each
  collection's name is its key in `collections`; each action's words are its
  keys in `actions`, so `{ books: books.actions(), log }` gives `books list`
  through `books set` and `log`. `app.actions.books.add(...)` in code,
  `epicenter reading books add` on the command line, and `reading_books_add`
  over MCP are one action. No key at any depth may be `then`, which a UI's
  client cannot call.

An app with one collection usually spreads its verbs at the top, so they are
the app's own: `actions: { ...tasks.actions(), add }` reads `epicenter tasks
add`, not `epicenter tasks tasks add`. An app with several collections nests
each under its name, as the example above does.

A later key replaces an earlier one, as in any object:
`{ ...words.actions(), add: learn }` gives every verb with `add` replaced.
Name verbs to give fewer, or `delete`, which only a name gives:
`settings.actions('get', 'set')`, `{ ...words.actions(), ...words.actions('delete') }`. An action is a
function, so `{ ...learn, description: 'x' }` drops its call; `defineApp`
refuses it and says to use `defineAction`.

## Collections

A collection is a typed set of Markdown files. Its `path` is one template
that says which files belong, how a record is named, and where `add` writes:

| `path` | Files | A record's keys |
| --- | --- | --- |
| `data/words/{word}.md` | every `.md` file in `data/words/` | `word` |
| `data/captures/{time}.md` | the same, named by the time | `time`, which `add` makes |
| `data/notes/{year}/{time}.md` | one folder per year | `year` and `time` |
| `data/settings.md` | that one file | none |

A placeholder matches one path segment, and two in one segment are refused.
A record's keys are its placeholders' values, named as the path names them:
`{ word: '你好' }` names `data/words/你好.md`, which is the record's `path`.
Files in a second layout, such as `data/entries/archive/{slug}.md` beside
`data/entries/{time}.md`, are a second collection, so membership, reading,
making, and naming each have one answer.

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

An action reads and writes through the collection's methods. A method that
names one record takes its keys first, and a method that changes it takes
the change second, because which record and what to change are two roles:

| Method | What it does |
| --- | --- |
| `get(keys)` | `Ok(record)`, `Ok(undefined)` for an absent keyed record, or an Err with the reason |
| `list()` | one Result per file, sorted by path |
| `add(record)` | creates a keyed record and returns its Result |
| `set(keys, change)` | updates an existing keyed record from plain data or a function of the record |
| `update(keys, fn)` | updates a record or creates it when absent |
| `delete(keys)` | returns whether a file existed |
| `pathOf(keys)` | the record's path |
| `check()` | a report counting files and listing problems by path |

Writes return the fitting record in Ok. Check a write's Result before
continuing work that depends on it. A malformed record produces `Misfit`.
A plain patch can repair it when the front matter is readable and the
resulting record fits. A computed write refuses before invoking its callback.

A keyless collection such as `settings` always represents one record.
Its fields must allow an empty file. `get()` gives `Ok(record)` before
the first write, and `set({ theme })` can create the file. It has no `add`.

Generated `get` returns `Missing` for an absent keyed file. Generated
`list` returns `Ok(rows)`, one Result per file with bodies omitted.
Generated `add` and `set` return write Results. The `set` verb accepts
JSON guards `was` and `edit`. An explicitly exposed `delete` returns the
boolean in Ok.

A verb's input is flat: each key is an input field beside the rest of the
input, so `epicenter vocab set '{"word":"serendipity","meaning":"a lucky find"}'`
sets one word.

A key finds its file by its exact name first, then by the tidy name: NFC,
trimmed, with each run of whitespace one space. So `"Tokyo "` finds
`Tokyo.md`, and a row for `data/notes/Dune  Messiah.md`, named by hand with
two spaces, finds that file. `get`, `set`, `delete`, and an `update` of a
file that is there do this. `add` and an `update` that makes a file always
write the tidy name, which `pathOf` gives. A key that is then empty, holds
`/` or `\`, starts with `.`, or is over 200 bytes is refused. So an action
never writes `data/words/${word}.md` itself:

```ts
const found = await words.get({ word });
```

The `set` verb is the `set` method for a caller that cannot send a function,
so it sends what it last saw instead, and one call is one write. `was` names
the field values the caller last saw, `null` for a field that was absent:
`{ meaning: 'a lucky find' }`. `edit` is `{ old, new }`, both required:
`old` names the passage of the body it last saw, and `new` is what replaces
it. `old` must be in the body exactly once, or be the whole body, or be empty
for an empty body. An absent keyed file gives `Missing`. A keyless record
starts with an empty body, so an edit quoting `old: ''` can create its file. Every guard
is checked inside the write before anything is written: when a `was` value
differs now, compared as JSON, the refusal is `{ name: 'Changed', why: 'was' }`,
and when `old` is not there, is there twice, or is empty and the body is not,
it is `Changed` with `why` `quote`, `twice`, or `empty`, and neither the fields nor
the body are written. So a page saves a record's fields and its notes in one
call:

```sh
epicenter vocab set '{"word":"serendipity","meaning":"a lucky find","was":{"meaning":"luck"},"edit":{"old":"First seen.\n","new":"First seen in a novel.\n"}}'
```

Without `was`, two callers setting the same field from stale screens: the
last write wins. Two callers setting different fields both land, since a
write changes only the lines it names. A collection whose fields are all
`readOnly` still has `set`, for its body.

A value computed from `get` and written later with `set` can overwrite a
concurrent change. Compute it inside the write. A `set` or `update` callback
must return a Result. Return `Ok(patch)` to apply fields or body, or a tagged
Err to decline. The caller receives that Err and the file stays as it was.
A plain patch remains valid as the second argument to `set`.

`set` gives its callback a fitting record, including the body. When the file
changes during the write, the callback runs again with the new contents.
Keep it pure. `Ok({})` leaves an existing record alone. Vocab's review can
therefore count two concurrent reviews:

```ts
return words.set({ word }, (found) => Ok(schedule(found, grade, now)));
```

For a keyed collection, `update` also gives its callback `undefined` when
there is no file. The patch must then supply all required fields. For a
keyless collection the callback always receives a record. Reading can
create or start a book in one write:

```ts
return books.update({ title }, (book) =>
  Ok(book?.started === undefined || book.finished !== undefined
    ? { started: localDay(), finished: null }
    : {}),
);
```

`update` is not a verb, since a caller cannot send a function; neither is a
`set` given one, or a `set` given a whole body, which would replace a person's
text blindly from a stale page; the `set` verb's `edit` changes the body
instead.

A field marked `readOnly` is written only by the app's own actions, through
the collection's methods; the exposed `add` and `set` leave it out, and
refuse it from a caller. Vocab's schedule fields are `readOnly`, so only
`review` changes them. When a `readOnly` field is required, no caller could
give it, so `actions()` leaves out `add`, in its
value and its type, and `actions('add')` throws saying why. Write the app's
own `add` with `defineAction`, as Capture does for `capturedAt`.

A collection's methods read and write the folder of the run they are called
in, so an action reaches them however deep its code goes. Outside a run they
throw, so loading an app never touches its files.

### What a read gives

`RecordOf<typeof collection>` names a record that fits. A computed read
forwards a refusal or handles it before using fields:

```ts
const read = await watches.get({ id });
if (read.error !== null) return read;
if (!read.data) return ActionError.Missing({ path: watches.pathOf({ id }) });
return Ok(read.data.from);
```

`Misfit` carries the file path and its diagnostic lines and kinds. When
front matter is readable, a non-local file's error includes the keys, body
and fitting fields for a repair form. Local collections omit partial records
and quoted field values. `partitionResults(await watches.list())` from
`@epicenter/app` separates fitting records from files that need repair. UI code
can import the same helper from `@epicenter/app/client`.

### What a definition may say

`defineCollection` refuses:

- a `field.file()` field, including a nested or read-only file marker;
- a path outside `data/`, naming the path with that prefix;
- a path that is not a relative `.md` template, has an empty part or one
  starting with `.`, has a placeholder twice, or a brace
  that is not a placeholder;
- a list of paths: a second layout is a second collection;
- a field or placeholder named `path`, `body`, `was`, or `edit`. A record
  supplies the first two and the `set` verb accepts the other two as guards;
- a field with the same name as a placeholder, or a name that a front matter
  line cannot hold;
- a field whose schema has a `default` at any depth. Write the default in
  code where the value is read: `(record.limit ?? 50)`.

`field.ref` refuses, when it is called, a target it cannot name one record
of by a key.

### Naming a record

The generated verbs take a record's keys: `epicenter vocab get '{"word":"你好"}'`.
An action you write chooses its own input, and one people or agents call
should take what they know. Vocab's `review` takes `{ word, grade }` and calls
`words.set({ word }, ...)`, so a caller gives
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
| `field.ref(collection)` | `string`, the key of a record in `collection` | `"name": "essays"` |

`field.list(item)` is a list of any field: `field.list(field.select(['x', 'threads']))`
is several of a fixed set, and `field.list(Type.Object({ name: Type.String() }))`
is several objects. It is not required, reads as `[]` when its line is
absent, and a write may leave it out. `field.list(item, { min: 1 })` needs at
least one item: its schema has `minItems`, it is required like any other
field, and an absent one is missing rather than `[]`, which would not fit.
An action that cannot run without an item says so this way, so `--help` and
the schema an agent receives call it required. `min: 0` is the same as none.

`field.ref(collection)` holds the key of a record in `collection`: the value
of the one placeholder in its path. `field.ref(shelves)` for
`data/shelves/{shelf}.md` holds `"essays"` for `data/shelves/essays.md`, and
nothing else, never the path. `field.list(field.ref(shelves))` holds several.
`collection` is declared before the field that names it, so a collection
cannot refer to itself, and two cannot refer to each other. `field.ref`
refuses a target whose path has no placeholder or more than one, and a
`.local` target.

- A collection's `add`, and its `set` given fields, read the record each key
  names before they write. A key is good when `get` on the target would find
  a record by it, its exact name first and then its tidy name, and that
  record's key is the key: `"Dune  Messiah"` finds a file named by hand with
  two spaces, and `" essays "` is refused, naming `"essays"` to write. A key
  whose record is not there is refused too. Each returns
  `ActionError.Refused`, one line per key, such as
  `data/books/dune.md: shelf: "poems" names no record in data/shelves/{shelf}.md`,
  and writes nothing. A `.local` collection's line leaves the key out.
- A function given to `set` or `update` is not checked against the target:
  what it returns is the app's own, as a `readOnly` field is.
- A read returns the key and opens no other file, so a key whose record was
  deleted since still reads as that key.
- In an action's `input`, a reference is checked as text. The action finds
  out whether the record exists when it reads it.

A reference's JSON Schema is text with the target's path, which the app
listing prints with the rest of the schema:
`{ "type": "string", "x-epicenter-ref": { "path": "data/shelves/{shelf}.md" } }`.

Each field is JSON Schema, so any TypeBox schema works as a field too. A field
is required unless it says `optional: true`; `readOnly: true` is described
above, and every field helper keeps it in its type. A field helper given an
option it does not declare, such as `field.integer({ default: 50 })`, is a
type error and throws naming it. No field has a `default`: `defineCollection`
and `defineAction` refuse a schema with one at any depth, so the default is
written in code where the value is read. `field.boolean` and `field.list`
mark their schema `"x-epicenter-field": "switch"` or `"list"`, which names
their kind rather than a value; a read and an action's call give an absent
one as `false` or `[]`, except a list with `minItems`, which is required. Fields describe data;
`defineAction({ privateInput: true, ... })` declares private handling for the
whole input. Raw JSON Schema annotations, including `writeOnly`, pass through
unchanged and have no effect on this policy. Schemas must serialize as
finite JSON; recursive schemas use references rather than cyclic JavaScript
objects. No field name is reserved: the command line reads the input as one
JSON object, so `json`, `help`, and `input` are keys like any other.

An action with `privateInput: true` accepts HTTP or exactly `-` at the CLI.
Its whole input is one JSON object from stdin: an argument and a terminal
prompt are unavailable. MCP neither lists nor runs it.
Validation refuses its whole input without echoing values or undeclared
property names. Actions make no commits.
The flag governs input handling. It does not authenticate HTTP callers or
redact action results. The app owns what it returns, throws, yields, and writes.

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
take is refused. `defineAction` throws on a definition that still has
`positional`.

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

An action changes files and makes no Git commit. Its writes remain pending,
including when it returns an Err, throws, or stops. A root checkpoint records included code
and records together, from the CLI or serve's clock
([ADR-0910](../../docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md), Accepted).
Reads tolerate records that no longer fit the declaration; repair follows a
code change rather than blocking the whole app.

Calls that write one app take turns from their first folder write until they
end. The runner flocks the real container `apps/<app>`, so replacing code/
does not change the lock. A read-only call takes no lock. Fetch or compute
first and write last to keep other writers from waiting.
`folder.write` replaces the file, and the last write wins. A change that
depends on what it read goes through `folder.update(path, change)`: it reads
the file, calls `change` with its text (`undefined` when there is none), and
writes what `change` returns, nothing when that is what is there. A writer
outside epicenter, such as an editor, may change the file between the read
and the write; then `update` calls `change` again on what is there now, and
after 10 tries it throws `ActionError.Changed`. A `change` that
throws writes nothing. It returns the text written. Every collection write (`add`, `set`, `update`, and the verbs built on them)
goes through it, so two `set`s of different fields of one file both land, and
two `update`s of one field each see the other's.

```ts
await folder.update('data/2026.csv', (before = 'minutes,book\n') => `${before}${minutes},\n`);
```

Use `folder.edit(path, decide)` when a raw-text change can decline. The
callback receives the current text on each attempt. Return `Err(reason)` to
refuse the change, `Ok({ value })` to leave the file as it is, or
`Ok({ value, text })` to replace it. The caller receives the value from the
attempt that won. This also lets a check leave an absent file absent.

A run of an action marked `readOnlyHint: true` takes no write lock. Its
context carries `readOnly: { action }`, and in it `folder.write`,
`folder.writeBytes`, `folder.edit`, `folder.update`, and `folder.delete` throw before doing
anything, unless the path is `.local` under `data/`: `The action "<words>" is read-only, so
it cannot write <path>`. A raw `node:fs` write, or a change made through an
outside service, is the action's own promise.

`folder` is a convenience, not a sandbox: an action may also write through
`folder.path` with `node:fs`. That path is the real app container, not code/
or data/. What the app can rebuild lives in files it
gitignores inside its folder, such as `code/ui/dist/`; they are never committed.
Paths are relative to the folder with `/` between parts, and `read` gives
`undefined` for a missing file.
Every write through `folder` stays under `data/`. A path with a `.git*` segment
is refused at any depth. Reads may reach code files.

## Temporary file inputs and runs

A top-level action input can use `field.file({ accept: ['audio/*'], maxBytes })`.
`accept` contains MIME types or `type/*`; `maxBytes` is a positive integer up
to 15 MiB, the default. A file cannot be nested in another schema, or stored
by a collection. Persistent attachments are undecided.

The browser supplies a `Blob` or `File` through separate run controls:

```ts
import { runs } from '@epicenter/app/client';

const ordinary = await app.transcribe({ audio: file }); // Blob or File
const run = runs.start(app.transcribe, { audio: file });
if (run.isRemembered()) showCanReturnLater();
const answer = run.result({ onYield: (value) => show(value) });
// A Stop button calls run.cancel().
await run.cancel();
```

Both forms upload each `Blob` or `File` before the same run admission. The
host passes the action an `UploadedFile` with `name`, `type`, `size`, `path()`,
`bytes()`, and `text()`, valid while the run executes. CLI, MCP, routines,
nested schemas, and collections cannot supply files.

`runs.start` saves `epicenter.run:<id>` before sending. Storage failure never
blocks execution: `isRemembered()` is false, and pending runs remain in a
bounded page-memory fallback. The client imports the old
`epicenter.runs.prototype.v1` array into per-id receipts on read. Receipts
older than seven days are pruned. `runs.pending(action)` lists this action's
receipts; `pendingRuns({ app })` lists across actions. Ordinary calls keep the
id in memory and do not write browser storage.

`events({ signal })` replays the run from the beginning. The SDK manages
reconnect offsets internally. `result({ onYield,
signal })` waits for the answer and delivers yields in order. An aborted
observer, a closed tab, or a throwing callback stops observation only.
`run.cancel()` requests cooperative cancellation, which does not establish
rollback. A terminal event removes the receipt; an unknown or disconnected
run retains it. If an uncertain ordinary call returns `Unreachable` or
`Stopped` with `error.run`, use `runs.attach(app.transcribe, error.run.id)` to
observe the same id. Never resend admission to recover an answer.

Run controls take a connected action and live outside the action tree, so
`daily.start` and `practice.start` remain callable actions. Serve marks an
unfinished run `interrupted` on recovery and never reruns it. For
`privateInput: true`, admission stores neither input values nor an input
digest. File metadata, hashes, and bytes follow the ordinary retention rules.
See the [CLI run policy](../cli/README.md#serve-owned-runs) for limits and retention.

## Save recurring work from setup

An explicit setup action can save a home-owned routine using an exposed action:

```ts
import { routines } from '@epicenter/app';

await routines.set('flights-daily-research', {
  daily: '08:00',
  action: dailyRun,
  input: {},
  timeout: '20m',
});
```

The host infers the installed app and resolves the action reference in that
load's existing action table. The input follows the action's TypeScript type
and is validated against its schema before saving. It must contain only JSON
values. Omitted fields stay omitted, so each invocation uses current code.
Private-input and file-input actions cannot be saved.

The name is home-wide: this call writes `routines/flights-daily-research.md`
using the existing `daily` and command-argv format: the action's words, then
the input as one JSON argument. It atomically updates the
requested fields, preserving notes, unspecified `paused` and `timeout`, and
all runtime state and logs. It refuses an existing command targeting another
app. Copying or importing code never enables a routine. Read-only actions and
hosts without routine support refuse the call.

The action must await its work and forward ordinary failures. Returning after starting
detached work would record launch as completion. A new unpaused routine can
catch up at the next check, even before today's configured time. Inspect and
repair it with `epicenter routines` and `epicenter routines run <name>`.

## Secrets are `.local` files

A path with a part matching `*.local` or `*.local.*`, in any case, stays on
the computer that runs the app
([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)).
`isLocalPath(path)` says whether a path is one. Such a file:

- stays out of root history: the root `.gitignore` excludes it, and a
  checkpoint refuses local credentials Git would include;
- may be written and deleted in a read-only run, since it stays out of
  Git history, so an action that only reads may still refresh a token;
- is made `0600`, readable by its owner alone, when `folder` creates it on a
  computer, and a directory `folder` creates on such a path is `0700`;
- is never one of a collection's files unless the collection's own `path` is
  `.local`: such a file is skipped by `list`, and a key such as `token.local`
  that would name one is refused by every method.

An app's secret is a collection with no placeholder at a `.local.md` path,
with its fields declared like any other:

```ts
const google = defineCollection({
  path: 'data/google.local.md',
  description: "this computer's Google sign-in",
  fields: {
    account: field.text({ optional: true }),
    refreshToken: field.text({ optional: true }),
  },
});

// Inside the action that needs the credential
const read = await google.get();
if (read.error !== null) return read;
const { refreshToken } = read.data;
```

Before sign-in the record has no token. When refreshing, compare the
credential being replaced inside the write so a concurrent sign-out wins.

Its `actions()` throws `data/google.local.md never leaves this computer, so it
offers no actions`, so no generated verb hands a token to an MCP client. A
`Misfit` or write refusal names a field that does not fit without
quoting its value: `refreshToken is not text`. A fresh clone of the app has no
`.local` files: the person signs in again.

The actions an app writes keep two rules, since `serve` hands an answer and a
thrown error to its caller whole, and an MCP caller's input sits in its
transcript:

- **Never return, throw, or yield a value read from a `.local` file.** Return what
  the secret got you: an account name, a count, a result.
- **Never take a secret as ordinary input.** An ordinary action is an MCP tool,
  its input sits in the transcript, and a refusal quotes what did not fit. A secret comes in one of three ways: the person
  writes the `.local` file; the action runs a flow that brings it back to this
  computer itself, as Mail's `connect` does with only a `port` and a loopback
  listener; or an action declaring `privateInput: true`, whose input the app's
  UI posts over HTTP or the CLI reads as JSON through `-`. The flag
  governs the whole input, independently of its fields. MCP neither lists
  nor runs it, and validation returns a fixed refusal. The CLI refuses any other argument before parsing
  it. The app still owns what its actions return, throw, yield, and
  write. Discovery through `epicenter <app> --json` and `<action> --help --json`
  preserves the flag at the top level, separately from MCP's `annotations`.

`.local` means "this computer only", for a cache as much as a sign-in. It is
not a guard against a shell agent on the same computer: give that agent a
deny rule for `*.local*` in its own permissions
([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)
says what each layer defends).

## Testing an action

Keep the test beside `epicenter.ts` under `code/`. Run it from that Bun project.
Import `expectOk` and `expectErr` from `@epicenter/app/testing` when a test
needs the typed value from one branch.

```ts
import { createMemoryContext, inRun } from '@epicenter/app';
import reading from './epicenter.ts';

const context = createMemoryContext({
  'data/2026.csv': 'minutes,book\n',
  'data/books/dune.md': '---\ntitle: "Dune"\n---\n',
});
expect(await inRun(context, () => reading.actions.log({ minutes: 30 }))).toEqual({
  data: { minutes: 30 }, error: null,
});
expect(await context.folder.read('data/2026.csv')).toBe('minutes,book\n30,\n');

const write = await inRun(context, () =>
  reading.actions.books.set({ slug: 'dune', finished: '2026-11-10' }),
);
expect(write.error).toBeNull();
const { books } = reading.collections;
const read = await inRun(context, () => books.get({ slug: 'dune' }));
expect(read).toMatchObject({ data: { finished: '2026-11-10' }, error: null });
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

The client exposes the action's Result in JSON form. Its public error type
includes the action's declared errors and the shared errors below. Producers
import the shared `ActionError` factories from `@epicenter/app`:

- `Changed` (`{ path, why }`): a quoted passage or empty body changed, or a file kept changing during an update.
- `Misfit` carries diagnostics about a malformed record.
- `Missing` (`{ path }`): the file is not there.
- `Threw` (`{ message, thrown? }`): an unrecognized throw, with a JSON-safe tagged payload kept as `thrown`.
- `Refused` (`{ message, next? }`): an operation declined the request.
- `Unreachable` (`{ message }`): a required operation returned no usable answer. The message identifies the dependency.
- `Stopped` (`{ message }`): work was deliberately stopped.

The shared errors carry a serializable namespace marker. The client validates
all their fields and returns every recognized shared error whole, preserving
its message and extra fields. App-defined returned errors keep their names and public fields. The client
maps a new fault to `Threw`, including when the action threw a tagged value.

A name gives the failure reason, not proof of what was saved, whether a stop
has finished, or whether repeating an action is safe. On the wire, the host sets `error.kind` to `returned`,
`fault` or `refused` for this invocation. A returned reason keeps all its own
fields under `error.reason`. The browser client unwraps it for action callers.
When a UI needs to know what persisted, it rereads the record. While the outcome
is uncertain, it keeps the person's draft and reports the uncertainty. `Missing`
and `Changed` identify their own `path`, which may belong to a dependency;
match the requested record before interpreting either as its state. Checkpoint
failures are reported by the checkpoint command or serve's clock, separately
from the action's answer.

A UI hands these calls to TanStack Query through Wellcrafted's
`resultQueries` and `resultMutations` (ADR-0661), and makes its one
QueryClient in its own `src/lib/query-client.ts`, from its own
`@tanstack/svelte-query`, so the bundle carries one TanStack Query: every
write refreshes every read the page shows before it counts as done, and reads
refresh when the UI is shown again (its tab or app comes back). Nothing
refreshes on a timer. This package does not depend on TanStack Query.

```ts
import { resultMutations, resultQueries } from 'wellcrafted/query';

export const reads = resultQueries(['reading'], { list: app.books.list });
export const writes = resultMutations(['reading'], { set: app.books.set });
// In a component: createQuery(() => reads.list()), createMutation(() => writes.set)
```

An action whose `run` yields accepts `onYield` after its input. The client
awaits each callback before delivering the next value. A callback failure
rejects the call and stops observation; the action continues. For a Stop
button, start a run and request cancellation explicitly:

```ts
import { runs } from '@epicenter/app/client';

const run = runs.start(vocab.chat.say, { message });
const said = run.result({ onYield: (token) => (draft += token) });
// On Stop:
await run.cancel();
```

An action that waits between yields can pass `callSignal()` to that wait.
Closing the page or aborting an observer does not cancel execution.

`ActionInput<A>`, `ActionOutput<A>`, and `ActionYield<A>` name what action
`A` takes from a caller, returns to a client, and yields while it runs:
`ActionInput<typeof app.actions.set>`. A switch and a list without `min` are
optional in `ActionInput`; an action that only returns yields `never`.

A UI routes to a record by its keys, which every row carries, each
URL-encoded: `#/words/<word>`. The page calls `get` with the keys from its
route, so the route never spells the app's templates.
