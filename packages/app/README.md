# @epicenter/app

What an app's `code/epicenter.ts` imports
([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md)).
An app container under `apps/` holds code/, data/ and local/ siblings; what
is in local/ stays on this computer. Its
`code/epicenter.ts` default-exports `defineApp(...)`. The
`epicenter` command turns each of its actions into a command for the person
and an MCP tool for their agent, and its UI calls the same actions.

```ts
// <Epicenter>/apps/reading/code/epicenter.ts
import { defineAction, defineApp, defineData, field, folder, Ok } from '@epicenter/app';

const data = defineData({
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
    await folder.update('data/2026.csv', (before = 'minutes,book\n') => `${before}${minutes},${book ?? ''}\n`);
    return Ok({ minutes });
  },
});

export default defineApp({
  description: 'How much I read each week',
  data,
  actions: { books: data.books.actions('list', 'get', 'add', 'set'), log },
});
```

`epicenter reading log '{"minutes":30,"book":"Dune"}'` runs `log`;
`epicenter reading books set '{"id":"dune","finished":"2026-11-10"}'`
runs a verb the data key gives. `@epicenter/app` is the API of the `epicenter` that runs
the app, so the command supplies it: to `epicenter.ts` when it loads the file,
and to the editor, `bun test`, and the UI's build by linking
`code/node_modules/@epicenter/app` to its own copy (ADR-0873). The code project's
`package.json` names only the app's own dependencies. An app's name is its
folder's.

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
- `defineApp` checks what it was given and returns that same object. It needs
  `description` and `actions`, with `{}` for none, and takes `data` when the
  app keeps records. Each action's words are its keys in `actions`, so
  `{ books: data.books.actions('list', 'get', 'add', 'set'), log }` gives
  `books list` through `books set` and `log`. `app.actions.books.add(...)`
  in code, `epicenter reading books add` on the command line, and
  `reading_books_add` over MCP are one action. No key at any depth may be
  `then`, which a UI's client cannot call.

An app with one data key usually spreads its verbs at the top, so they are
the app's own: `actions: { ...data.tasks.actions('list', 'get', 'set'), add }`
reads `epicenter tasks add`, not `epicenter tasks tasks add`. An app with
several keys nests each under its name, as the example above does.

A later key replaces an earlier one, as in any object:
`{ ...data.words.actions('list', 'get', 'add'), add: learn }` gives `add`
from `learn`. An action is a function, so `{ ...learn, description: 'x' }`
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
most 200 UTF-8 bytes, without `/`, control characters, a leading dot, or
spaces at either end (ADR-0933). A method or verb given another id returns
`Refused`, and `list` skips a file whose name is not an id. `field.id()` is
an input field that takes one. A new record's id comes from the caller or the
app: Tasks and Writing name each new record with `timeId()`.

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
| `add(id, record)` | creates the file, or returns `Changed` (`there`) when it exists; folder keys only |
| `set(id, change)` | patches an existing record; an absent id returns `Missing`. A one-file `set(change)` creates its file |
| `update(id, fn)` | computes a patch from a fitting record, or from `undefined` when the file is absent, and may create it |
| `delete(id)` | returns whether a file existed |
| `pathOf(id)` | the record's path, without checking the id or the disk |

Writes return the fitting record in Ok. Check a write's Result before
continuing work that depends on it. A malformed record produces `Misfit`.
A plain patch can repair it when the front matter is readable and the
resulting record fits. A computed write refuses before invoking its callback.
A change merges as JSON Merge Patch: `null` removes an optional field, and
`body` replaces the text after the front matter.

`actions(...verbs)` gives the verbs it names, and only those: a folder key
offers `list`, `get`, `add`, `set`, and `delete`, and a one-file key `get`,
`set`, and `delete`. The verb `get` returns `Missing` for an absent folder
id; `list` returns `Ok(rows)`, one Result per file, bodies included; `delete`
returns the boolean in Ok. A verb's input is flat: `id` sits beside the
fields, so `epicenter vocab set '{"id":"serendipity","meaning":"a lucky find"}'`
sets one word.

The `set` verb is the `set` method for a caller that cannot send a function,
so one call is one write. It takes the fields to change, `null` to remove an
optional one, and `body` or `edit`, not both. `edit` is `{ old, new }`, both
required: `old` is a non-empty passage of the body the caller last saw, and
`new` replaces it. When `old` is not in the body now, or is there twice, the
answer is `Changed` with `why` `quote` or `twice`, and neither the fields nor
the body are written. A page saves a record's fields and its notes in one
call:

```sh
epicenter vocab set '{"id":"serendipity","meaning":"a lucky find","edit":{"old":"First seen.\n","new":"First seen in a novel.\n"}}'
```

Two callers setting the same field from stale screens: the last write wins.
Two callers setting different fields both land, since a write changes only
the lines it names.

A value computed from `get` and written later with `set` can overwrite a
concurrent change. Compute it inside the write with `update`. Its callback
must return a Result: `Ok(patch)` to apply fields or body, or a tagged Err to
decline. The caller receives that Err and the file stays as it was. The
callback runs once, and no other write to the file runs between its read and
its write. `Ok({})` leaves an existing record alone. Vocab's review can
therefore count two concurrent reviews:

```ts
return data.words.update(word, (found) =>
  found ? Ok(schedule(found, grade, now)) : ActionError.Missing({ path: data.words.pathOf(word) }),
);
```

`update` is not a verb, since a caller cannot send a function.

A handle reads and writes the folder of the run it is called in, so an action
reaches it however deep its code goes. Outside a run it throws, so loading an
app never touches its files.

### What a read gives

A record is its `path`, its `id` for a folder key, its fields, and its
`body`. A computed read forwards a refusal or handles it before using fields:

```ts
const read = await data.watches.get(id);
if (read.error !== null) return read;
if (!read.data) return ActionError.Missing({ path: data.watches.pathOf(id) });
return Ok(read.data.from);
```

`Misfit` carries the file path and its diagnostic lines and kinds. When
front matter is readable, it also carries `record`: the path, id, body, and
the fields that fit, for a repair form. `partitionResults(await data.watches.list())`
from `@epicenter/app` separates fitting records from files that need repair.
UI code can import the same helper from `@epicenter/app/client`.

`checkData(data)`, which `epicenter check` runs, reads every key and reports
each file that does not fit, each name that is not an id, names that are one
file on a disk that ignores case, and each reference that names no file.

### What a definition may say

`defineData` refuses:

- a key that is not a name, optionally followed by `.md`;
- a field named `path`, `body`, `id`, or `edit`, which a record or the `set`
  verb supplies;
- a field marked `readOnly`: an app offers only the verbs a caller may use;
- a field name that a front matter line cannot hold;
- a field whose schema has a `default` at any depth. Write the default in
  code where the value is read: `(record.limit ?? 50)`;
- a `field.ref` whose target is not a folder key of the same `defineData`.

### Naming a record

The generated verbs take a record's id: `epicenter vocab get '{"id":"你好"}'`.
An action you write chooses its own input, and one people or agents call
should take what they know. Vocab's `review` takes `{ word, grade }` and calls
`data.words.update(word, ...)`, so a caller gives
`epicenter vocab review '{"word":"你好","grade":"good"}'`.

## Fields

| Field | Value | In the input object |
| --- | --- | --- |
| `field.text()` | `string` | `"name": "text"` |
| `field.id()` | `string`, a record id | `"name": "dune"` |
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
- In an action's `input`, a reference is checked as an id. The action finds
  out whether the record exists when it reads it.

A reference's JSON Schema is an id with its target key, which the app
listing prints with the rest of the schema:
`{ "type": "string", "format": "epicenter-id", "x-epicenter-ref": { "key": "shelves" } }`.

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

A secret, such as a token, is ordinary input: the app's page sends it once
and the action keeps it under `local/`, which never enters Git:
`await folder.write('local/google.md', token)`, read back with
`await folder.read('local/google.md')`. An action writes only under `data/`
and `local/`. Epicenter treats that input as any other, so give it from the page or
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

Whatever runs an action opens a run with the app's folder:
`inRun({ folder }, () => action(input))`. For its length, the app's
data handles and `folder` reach it; an action that calls another stays in the
same run
([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).
`folder` has `read`, `readBytes`, `write`, `writeBytes`, `update`, `list`, and
`delete`, and `path` on a computer.

An action changes files and makes no Git commit. Its writes remain pending,
including when it returns an Err, throws, or stops. Git stores the home, and its
commits record code and records together
([ADR-0910](../../docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md), Accepted).
Reads tolerate records that no longer fit the declaration; repair follows a
code change rather than blocking the whole app.

Nothing locks a call. One process, `epicenter serve`, runs every action,
including one the command line sends.
Fetch or compute first and write last, so a slow step never leaves a file
half done.
`folder.write` replaces the file, and the last write wins. A change that
depends on what it read goes through `folder.update(path, change)`: it reads
the file, calls `change` with its text (`undefined` when there is none), and
writes what `change` returns, nothing when that is what is there. `change`
runs once. One process runs actions, so no other update runs between the read
and the write; a writer outside epicenter, such as an editor, is not guarded
against. A `change` that throws writes nothing. It returns the text written. Every data write (`add`, `set`, `update`, and the verbs built on them)
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

`folder` is a convenience, not a sandbox: an action may also write through
`folder.path` with `node:fs`. That path is the real app container, not code/
or data/. What the app can rebuild lives in files it
gitignores inside its folder, such as `code/ui/dist/`; they are never committed.
Paths are relative to the folder with `/` between parts, and `read` gives
`undefined` for a missing file.
Every write through `folder` stays under `data/`. Reads may reach code files.

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

// Any caller, in the home or in a page:
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
[CLI's call route](../cli/README.md#a-call-over-http).

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

- `Changed` (`{ path, why }`): a quoted passage changed or is there twice, or a new record's file is already there.
- `Misfit` carries diagnostics about a malformed record.
- `Missing` (`{ path }`): the file is not there.
- `Threw` (`{ message, thrown? }`): an unrecognized throw, with a JSON-safe tagged payload kept as `thrown`.
- `Refused` (`{ message, next? }`): an operation declined the request.
- `Unreachable` (`{ message }`): a required operation returned no usable answer. The message identifies the dependency.

The shared errors carry a serializable namespace marker. The client validates
all their fields and returns every recognized shared error whole, preserving
its message and extra fields. App-defined returned errors keep their names and
public fields. The client maps a new fault to `Threw`, including when the
action threw a tagged value.

A name gives the failure reason, not proof of what was saved or whether
repeating an action is safe. When a UI needs to know what persisted, it
rereads the record. While the outcome is uncertain, it keeps the person's
draft and reports the uncertainty. `Missing` and `Changed` identify their own
`path`, which may belong to a dependency; match the requested record before
interpreting either as its state.

A UI hands these calls to TanStack Query through Wellcrafted's
`resultQueries` and `resultMutations` (ADR-0661), and makes its one
QueryClient in its own `src/lib/query-client.ts`, from its own
`@tanstack/svelte-query`, so the bundle carries one TanStack Query. This
package does not depend on TanStack Query.

```ts
import { resultMutations, resultQueries } from 'wellcrafted/query';

export const reads = resultQueries(['reading'], { list: app.books.list });
export const writes = resultMutations(['reading'], { set: app.books.set });
// In a component: createQuery(() => reads.list()), createMutation(() => writes.set)
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
A call that reaches no answer resolves to `Unreachable`, whose message says
whether the action started.

`ActionInput<A>`, `ActionOutput<A>`, and `ActionUpdate<A>` name what action
`A` takes from a caller, returns to a client, and reports while it runs:
`ActionInput<typeof app.actions.set>`. A switch and a list without `min` are
optional in `ActionInput`; an action that only returns reports `never`.

A UI routes to a record by its id, which every folder row carries,
URL-encoded: `#/words/<id>`. The page calls `get` with the id from its
route, so the route never spells the record's path.
