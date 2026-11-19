# @epicenter/app

What a home's `epicenter.ts` imports to define its records, apps and
actions; the client a page calls those actions through; and the `epicenter`
command, which serves them to the command line, agents (MCP) and pages.
A home depends on it and runs it with Bun.

The design is [ADR-0971](../../docs/adr/0971-an-epicenter-is-one-program-composed-in-its-root-epicenter-ts.md):
a home is one program, composed in its root `epicenter.ts`.

## A home

```txt
~/Epicenter/
  package.json     "epicenter": { "port": 4747 }; this key marks the home
  epicenter.ts     the program serve imports
  .env             secrets and this computer's settings, read through process.env
  data/            the records, plain Markdown, one folder per key
  apps/            code only: each app is a function of the home's data
  local/           caches an app can rebuild, ignored by Git
```

```ts
// epicenter.ts
import { defineData, defineEpicenter, field } from '@epicenter/app';
import { writing } from './apps/writing';

export const data = defineData(import.meta.dir, {
  notes: {
    description: 'writing note',
    fields: { kind: field.select(['thought', 'quote', 'link']) },
  },
});
export type Data = typeof data;

export default defineEpicenter({ apps: { writing: writing(data) } });
```

```ts
// apps/writing/index.ts
import { defineAction, field, timeId } from '@epicenter/app';
import type { Data } from '../../epicenter';

export function writing({ notes }: Data) {
  const add = defineAction({
    description: 'Save a thought, quote or link, named by the time',
    input: {
      body: field.text({ pattern: '\\S' }),
      kind: field.select(['thought', 'quote', 'link'], { optional: true }),
    },
    run: ({ body, kind = 'thought' }) => notes.create(timeId(), { body, kind }),
  });
  return { description: 'Notes for later writing', actions: { add } };
}
```

## Data

`defineData(dir, spec)` gives one handle per key. `data.notes` reads and
writes `data/notes/<id>.md`, whose front matter holds the declared fields as
one JSON value per line and whose body is the rest of the file. A handle
has `list`, `get`, `create`, `patch`, `edit` and `delete`, each answering a
Wellcrafted Result:

- A read that does not fit its fields is `Misfit`, naming each line and
  carrying the fields that fit, for repair.
- `create` refuses a record already there with `Exists`; `patch` refuses a
  missing one with `Missing`.
- `edit` computes a change from the record and writes it with nothing else
  in this process changing the file between the read and the write.
- A write replaces the whole file at once, changes only the lines it names,
  keeps every other line byte for byte, and lands only in a real folder
  under `data/`: a key folder that is a link is neither read nor written.
- `field.ref('watches')` is text that holds the id of a record in another
  key of the same `defineData`, which refuses a key it does not define. A
  write does not check that the record is there: deleting one can leave a
  ref to nothing, so an app that needs the record checks for it.

`defineData` touches no file. A handle generates no actions.

## Actions and apps

`defineAction({ description, input, run })` types `run`'s input by its
fields. `run` returns `Ok(data)` or `Err(error)`, where `data` survives
JSON, and may report progress through its second argument:

```ts
async run({ recheck = false }, update: Update<{ checked: number }>) {
  update({ checked: 1 });
  return Ok(null);
}
```

An app is a function of `Data` returning `{ description, actions }`. Its
name is its key in `defineEpicenter({ apps })`, which refuses a name that
is not lowercase letters, digits and dashes, starting with a letter. Its
type refuses `serve`, the command's own word.

## The command and serve

```txt
epicenter                            every app in this home
epicenter <app>                      what an app can do
epicenter <app> <action> [<input>]   run an action; the input is one JSON object
epicenter serve                      run the home
```

`epicenter serve` starts in the home's folder, imports `epicenter.ts`
once, and listens on 127.0.0.1 at the marker's port. Restart it after
changing code. Every other command asks serve and runs no app code.

| Route | What it answers |
| --- | --- |
| `POST /actions/<app>/<action>` | JSON lines: `{"update": ...}` for each update, then `{"answer": {data, error}}` |
| `POST /` | MCP, one tool per action, named `<app>_<action>` |
| `GET /actions/` | every app, action, description and input schema |

Serve refuses a request a tunnel delivered, a `Host` that is not loopback,
an IP literal or `*.ts.net`, an `Origin` on another host, and a browser
request `Sec-Fetch-Site` marks as from another origin. A program that
throws on import leaves serve answering that one problem with no apps.

An answer's error names whether the action ran: `NotStarted` (it never
began), `Threw` (it began and threw), `Unreachable` (the outcome is
unknown), or the action's own error. A request serve refuses, and a
serve that is not running, is `NotStarted`. The command exits 0 for success, 2
for `NotStarted` and 1 otherwise.

## A page's client

```ts
import { connect } from '@epicenter/app/client';
import type home from '../../../../epicenter.ts';

const epicenter = connect<typeof home>();
const added = await epicenter.writing.add({ body: 'Fares drop in late March' });
```

Each call resolves to a Result typed by the action. Pass
`{ onUpdate }` as the second argument to hear its updates.

## Tests

A test rebinds the home's data to a temporary folder and calls the app
function with it:

```ts
const app = writing(defineData(tmp, data));
await app.actions.add({ body: 'hello' });
```

`defineData(tmp, data)` takes an earlier result as its spec and returns
the same type, with every key, so every ref still has its target.

## Not built yet

Routines, an app's page (`ui`) and an app's `fetch` are designed when the
first rebuilt app needs one (ADR-0971, "Not decided").
