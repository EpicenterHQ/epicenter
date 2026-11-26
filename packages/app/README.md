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
  .epicenter/      this computer's working state, private and ignored by Git
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

## This computer's state

Visible folders are yours. `.epicenter/` is this computer's:

```txt
.epicenter/
  apps/<app>/   an app's sign-ins, caches and scratch files
  replaced/     files an upload replaced, by time and path
  tmp/          writes in progress
```

Deleting `.epicenter/` costs you sign-ins, rebuildable caches, and the saved
copies of files an upload replaced. Git history is untouched, so anything
committed can still be restored. `replaced/` matters only for files Git never
had, such as ignored recordings.

`epicenter.ts` is the only file that knows where the home is. It builds each
path and hands an app exactly what it touches, so one file shows everything
each app can reach on disk:

```ts
const home = import.meta.dir;

export default defineEpicenter({
  apps: { mail: mail(data, join(home, '.epicenter/apps/mail')) },
});
```

An app reads and changes its files with Node and Bun. The library adds one
call, because Node has no safe whole-file write:

```ts
import { replaceFile } from '@epicenter/app';

replaceFile(join(state, 'settings.md'), text);
new Database(join(state, 'cache.sqlite'), { create: true });
```

Serve makes `.epicenter/` readable by its owner alone (0700), with its own
`.gitignore`, before any app runs.

## Actions and apps

`defineAction({ description, input, run })` types `run`'s input by its
fields. `run` returns `Ok(data)` or `Err(error)`, where `data` is JSON:
`null` for nothing, never `undefined`, so a page receives the type `run`
returned. A property may be `undefined`; it arrives absent. `run` may
report progress through its second argument:

```ts
async run({ recheck = false }, update: Update<{ checked: number }>) {
  update({ checked: 1 });
  return Ok(null);
}
```

Its third argument, `signal`, aborts when the caller is gone: a page closed
or abandoned the call, the command stopped, or the connection dropped. An
action that ignores it runs to the end. One that only streams, such as a
feed of changes, returns when it aborts.

An app is a function of `Data` returning `{ description, actions }`. Its
name is its key in `defineEpicenter({ apps })`. Serve refuses an app or
action name that is not lowercase letters, digits and dashes, starting
with a letter, since an MCP tool is `<app>_<action>`; the type refuses an
app named `serve`, the command's own word. Serve also refuses an input
schema that does not compile, such as a raw `pattern` that is not a regular
expression; every call runs the check compiled then, so it cannot fail a
call. An action whose `run` returns something other than a Result, or data
JSON cannot carry, answers `Threw`. Add `mcp: false` to an action an agent
must not call through MCP, such as one that sends as you.

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
| `GET /apps/<app>/<file>` | the app's built page, from `apps/<app>/ui/dist/` |
| `GET /data/<path>` | a file's bytes, with range requests for video and audio |
| `PUT /data/<path>` | stores a file: 201 when new, 204 when it replaced one and kept the old copy |
| `POST /` | MCP, one tool per action not marked `mcp: false`, named `<app>_<action>` |
| `GET /actions/` | every app, action, description and input schema |

Serve refuses a request Tailscale Funnel delivered, a `Host` that is not
loopback, an IP literal or `*.ts.net`, and an `Origin` on another host. A
program that
throws on import leaves serve answering that one problem with no apps.

An answer's error names whether the action ran: `NotStarted` (it never
began), `Threw` (it began and threw), `Unreachable` (the outcome is
unknown), or the action's own error. A request serve refuses, and a
serve that is not running, is `NotStarted`. Every call over the route and
MCP ends in one answer; a command that fails where it cannot tell whether
serve ran the action answers `Unreachable`. The command exits 0 for success, 2
for `NotStarted` and 1 otherwise.

## A page's client

```ts
import { connect } from '@epicenter/app/client';
import type home from '../../../../epicenter.ts';

const epicenter = connect<typeof home>();
const added = await epicenter.writing.add({ body: 'Fares drop in late March' });
```

Each call resolves to a Result typed by the action. Pass
`{ onUpdate, signal }` as the second argument to hear its updates and to
abandon the call; abandoning aborts the action's `signal` and answers
Unreachable.

## Files

Epicenter moves bytes to and from paths under `data/`. An app decides where
its files go, how many a record has, and what replacing or deleting one
means:

```ts
import { dataUrl } from '@epicenter/app/client';

// One video beside each page.
const videoPath = (id: string) => `pages/${id}.mp4`;

await fetch(dataUrl(videoPath(id)), { method: 'PUT', body: file });
await epicenter.pages.add({ id, title });
// <video src={dataUrl(videoPath(id))} />
```

```ts
// The page's delete action removes what this layout put there.
await rm(join(import.meta.dir, '../../data', videoPath(id)), { force: true });
return pages.delete(id);
```

## Tests

A test rebinds the home's data to a temporary folder and calls the app
function with it, and a temporary folder when the app takes one:

```ts
const app = writing(defineData(tmp, data));
await app.actions.add({ body: 'hello' });
const mailApp = mail(defineData(tmp, data), join(tmp, 'mail'));
```

`defineData(tmp, data)` takes an earlier result as its spec and returns
the same type, with every key.

## Scheduled actions

A home can name an action and its input on a cron schedule in `epicenter.ts`:

```ts
schedules: {
  'morning-flights': {
    cron: '0 8 * * *',
    action: ['flights', 'daily'],
    input: {},
  },
},
```

Use Bun 1.4 or later for the cron parser's local-time behavior. Serve validates
the target, input and cron when it loads the home. An occurrence must be after
serve became ready, and its local minute must still be current when serve checks
the clock. A serve that finishes starting at 8:00 or later waits until tomorrow
for the example above.

Bare `epicenter` lists each schedule and its next occurrence. Serve calls
scheduled actions through the usual action runner, which logs each answer
to stderr. After a restart the clock considers future occurrences. Apps
own any saved results.

## Not built yet

Each is designed when the first rebuilt app needs it. What the earlier
design taught each one must keep:

- **An app's `fetch`.** A handler for OAuth, a feed or a webhook must sit
  behind serve's guards, and must learn its public address without
  `epicenter.ts` passing it.

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
- **`.epicenter/` is the one folder Epicenter owns in a home. It is private,
  carries its own `.gitignore`, and holds no primary copy of your work.**
  The name says whose it is, where `local/` did not, since every folder in a
  home is local. Other tools keep their own dot folders, so a leading dot
  alone does not mean Epicenter.
  Refused: `local/`; treating every dot name as Epicenter's; separate state,
  cache and secrets folders; state under `~/Library`, which a renamed home
  would orphan.
- **`epicenter.ts` builds every path and passes an app plain strings. An app
  never receives the home.** One file then shows what each app can reach, and
  a test passes a temporary folder. The library exports only `replaceFile`,
  the one file operation Node lacks.
  Refused: a `Folder` object or `defineLocal`, which wrapped paths without
  limiting them; passing `home` for each app to assemble paths; paths relative
  to the working directory, which a test run elsewhere would misplace.
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
- **An action names each of its errors with fixed text, and an error's
  fields are JSON; any error may carry `next`, a command that helps.** A
  name that is any string turns every name a page sees into `string`, so
  `defineAction` refuses it, and a `cause` that is an `Error` arrives as
  `{}`, so it stays inside the action. Epicenter names no refusal for an
  app: a check the input schema can make belongs there, and answers
  `NotStarted`.
  Refused: a ready-made `Refused` name (removed: a caller could not tell
  one refusal from another, and catch-alls hid crashes behind it); an
  `errors` list on each action (a page already infers the names from
  `run`, and an agent reads the description).
- **An action call is a function call: serve keeps no run history, receipt
  or replay, only one line on stderr when a run ends (app, action, outcome,
  duration; never the input or the result).** What must outlast a call goes
  in a file, and progress goes through `run`'s second argument.
  Refused: `async function*` and `yield`; an ambient `report()`.
- **A caller leaving aborts `run`'s `signal` and stops nothing by itself.**
  A command interrupted after starting a send must not cancel it halfway,
  and a stream of changes must stop listening once its page is gone. The
  action decides which it is.
  Refused: aborting every action when its caller leaves; a stream that ends
  on a timer, which repeats the page's own reconnect deadline on the server.
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

- **Serve gzips action answers and pages, and sends `data/` byte for byte.**
  One action can answer with a whole document, and an app should not compress
  its own answers. Each write is flushed, so an update still arrives live.
  Refused: compressing inside an action, which hides it from every other app;
  a binary route beside actions, a second way to call one.
- **After an action's words the command takes at most one more word, a JSON
  object. No input means `{}`.** One grammar covers every input shape.
  Refused: flags spelling the same JSON; JSON5 or `key=value`.
- **The command exits 0 for success, 2 for `NotStarted` and 1 otherwise.**
  A script can retry what never started without guessing.
- **One serve per home holds a SQLite write lock in
  `.epicenter/serve-lock.sqlite` from before app loading through exit.** The
  lock covers the home even if the configured port changes. It requires a
  local filesystem and a stable lock file while serve runs. Every CLI call
  asks that one process; it alone loads the apps.
  Refused: relying on the listening port alone to protect the home.
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
- **Serve answers `/apps/<app>/` from `apps/<app>/ui/dist/` for an app in
  `epicenter.ts`.** Guards refuse a page's calls from another origin, so a
  page must come from serve itself, and the folder is found by the layout
  every home already has.
  Refused: a setting naming each app's folder.
- **Serve has one owner, so it checks only what stops a website in that
  owner's browser or an unrecoverable loss.** It keeps `Host`, `Origin`, the
  Funnel check, one path check that stays inside the served folder, the
  sandbox on `/data`, and the saved copy `PUT` keeps. Each stopped a demonstrated
  attack or protects bytes Git does not hold.
  Refused: file name rules; refusing links the owner made; body size caps;
  `Sec-Fetch-Site`, which blocked links to the owner's own pages.
- **`PUT /data/<path>` replaces a file and keeps the old one in
  `.epicenter/replaced/<time>/<path>`. Everything else about a file is an
  action's.** A retry just works and a page needs no conflict prompt, while a
  bad upload over media Git does not hold can still be undone by copying it
  back. Epicenter knows paths, and each app owns its layout, so
  `records.delete` removes only the `.md`.
  Refused: create-only `PUT`; replacing with no saved copy; committing each
  upload or sending media through Git LFS; a framework rule for which files
  belong to a record; a pointer field; base64 in JSON.
- **MCP offers one tool per action and sends no instructions.** An agent
  learns each tool from its action's description. A home's `AGENTS.md`
  guides an agent working in the home's files, with steps an MCP client
  cannot take, such as `bun install`; an agent working there reads it
  itself.
  Refused: sending `AGENTS.md` as MCP instructions.
- **An action marked `mcp: false` is left out of MCP and refused there by
  name; the command and a page still call it.** Some actions act as the
  owner, such as sending a message or changing Gmail, and an agent that
  reaches your Epicenter only through MCP, such as one on a phone, must not
  run them. An agent with a shell on your computer can still run the command, so
  this limits a channel, not a person.
  Refused: a description telling agents not to call it; per-caller
  permissions.
