# @epicenter/app

What a home's `epicenter.ts` imports to define its records, apps and
actions; the client a page calls those actions through; and the `epicenter`
command, which serves them to the command line, agents (MCP) and pages.
A home depends on it and runs it with Bun.

A home is one program, composed in its root `epicenter.ts`. The rules it
keeps are under [Decisions](#decisions).

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
  keeps every other line byte for byte. A link under `data/` is followed,
  for reads and writes alike.
- A field that holds another record's id is `field.text()`. A write does
  not check that the record is there: deleting one can leave an id that
  points to nothing, so an app that needs the record checks for it.

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
name is its key in `defineEpicenter({ apps })`. Serve refuses an app or
action name that is not lowercase letters, digits and dashes, starting
with a letter, since an MCP tool is `<app>_<action>`; the type refuses an
app named `serve`, the command's own word. An action whose `run` returns
something other than a Result answers `Threw`.

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
the same type, with every key.

## Not built yet

Each is designed when the first rebuilt app needs it. What the earlier
design taught each one must keep:

- **Routines.** A schedule that runs an action must appear in the listing
  and be checked when serve starts.
- **An app's page.** Serving built files must refuse dot names and any
  file or folder that resolves outside the app.
- **An app's `fetch`.** A handler for OAuth, a feed or a webhook must sit
  behind serve's guards, and must learn its public address without
  `epicenter.ts` passing it.
- **Files beside a record,** such as a recording's audio or a book's cover.

## Decisions

These are the rules an agent or a contributor would most likely undo by
mistake. Each says why, and names a tempting alternative that lost. Change
a rule here in the same pull request as the code.

### The home

- **A home is one program: `epicenter.ts` opens the data once and passes it
  to every app, and serve imports that one module.** Records belong to the
  home, not to an app, so a file with no app or with two still has a place.
  Refused: records under each app; apps discovered from `apps/`; each app
  declaring the keys it writes and serve refusing two writers.
- **The command finds its home by walking up to the nearest `package.json`
  with an `"epicenter"` key, and serve refuses to start outside that
  folder.** A command run in an unrelated project must not act on a home
  silently, and Bun reads `.env` from the folder serve starts in.
  Refused: an `EPICENTER_ROOT` variable; `~/Epicenter` as a default.
- **`local/` carries its own `.gitignore`.** It stays out of Git whatever
  the root `.gitignore` says, with no Git process to check it.
  Refused: a Git check for each `local/` at start.
- **No command makes a home or an app, or copies an app in or out, and the
  package ships no template.** Each happens once per owner, and the owner's
  agent already knows how; a command or a template is one more thing to
  keep true.
  Refused: `init`, `new` and `export`; a starter repository.

### Records

- **Front matter is `key: <JSON>` lines, each read on its own, and no YAML is
  read.** A write changes only the lines it names and keeps every other line
  byte for byte. A YAML reader gave values the file did not hold, and
  rewriting the block changed values.
  Refused: reading YAML and replacing only changed keys.
- **A record that does not fit is a `Misfit` carrying the fields that fit,
  and nothing rewrites or drops what this release cannot read.** Another
  program, a person or an agent may write the files, so the code must
  tolerate a repairable state rather than prevent it.
  Refused: preventing every inconsistent relationship.
- **`patch` and `edit` take `null` to remove an optional field.** It is
  RFC 7396's merge patch, with no second concept for agents to learn.
  Refused: `--unset <field>`; an `unset` verb; `set` replacing the whole
  file.
- **Each thing is checked once, where it can change: code when serve
  starts, records when they are read or written.** A sweep reads every
  record for a question the reads already answer.
  Refused: `epicenter check`; data problems in the listing.

### Actions

- **Every action's `run` returns one Wellcrafted Result, and every surface
  answers exactly `{ data, error }`. An action's input is one JSON
  Schema.** One shape means a business object with `data` and `error` keys
  is never ambiguous, and the error's name is what a caller recovers by.
  Refused: plain values beside Results; a `kind` field beside the error.
- **An action call is a function call: serve keeps no run record, receipt
  or replay.** What must outlast a call goes in a file, and progress goes
  through `run`'s second argument.
  Refused: `async function*` and `yield`; an ambient `report()`.
- **An action writes files and makes no commit and takes no lock. No
  command commits, stages or pushes.** Only the person or their agent knows
  why a change was made, and a commit per action could sweep in someone
  else's edit. Git is the owner's tool, and Epicenter does not rename its
  commands.
  Refused: a commit per action; holding an app lock for a call;
  `checkpoint`; serve committing on a clock.
- **Epicenter exports no function for calling a model.** An action imports
  a model client and reads its key itself, so its address stays in its
  code.
  Refused: `model(name)` over connections in `.env` (built and withdrawn in
  #2702); a `models` app or LiteLLM beside serve.

### Running the home

- **After an action's words the command takes at most one more word, a JSON
  object. No input means `{}`.** One grammar covers every input shape.
  Refused: flags spelling the same JSON; JSON5 or `key=value`.
- **The command exits 0 for success, 2 for `NotStarted` and 1 otherwise.**
  A script can retry what never started without guessing.
- **One serve per home runs every action, and the port is its lock. The
  command never starts serve, never runs an action itself, and loads no app
  code: it sends the input to serve, which alone reads it.** One writer
  holds while serve is up, and two loads cannot disagree.
  Refused: a lock file the command tries; the command running the action
  when serve is down.
- **Serve imports the program once at start and never reloads.** Restart it
  to run changed code. Reloading exposes half-written code to every caller,
  and only the agent making edits knows when they are complete.
  Refused: re-importing on each call; a file watcher.
- **Serve listens only on 127.0.0.1, takes no flags and signs no one in.**
  The owner's private network, such as Tailscale, brings other devices in.
  Refused: `--host` limited to loopback and Tailscale addresses; a token of
  serve's own.
- **The command writes no service job and restarts nothing.** The owner
  keeps serve running; an action that throws already returns a failed
  answer, and a restart would hide the rest.
  Refused: `epicenter service` with a LaunchAgent; a parent process that
  restarts serve.
- **MCP offers one tool per action and sends no instructions.** An agent
  learns each tool from its action's description. A home's `AGENTS.md`
  guides an agent working in the home's files, with steps an MCP client
  cannot take, such as `bun install`; an agent working there reads it
  itself.
  Refused: sending `AGENTS.md` as MCP instructions.
