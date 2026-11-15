---
name: epicenter-app
description: "Make or change an Epicenter app: its collections, actions, UI, code/data container, and private root history. Use when asked to build a personal app, change Capture, Reading, Tasks, or Vocab, set up an Epicenter, copy or share app code, or adapt code from another app on the computer that runs epicenter serve."
---

# Epicenter apps

An Epicenter is a marked folder with one private Git repository. Its apps
live in `apps/<app>/`: `code/` is an ordinary Bun project and sibling `data/`
holds records and settings. The source and live Epicenter use this layout
(ADR-0910, Accepted). Inspect an existing app before editing it. An older
Epicenter needs a separately authorized history and directory migration.

`epicenter` selects the nearest marked ancestor of the current folder, then
`EPICENTER_ROOT`, then `~/Epicenter`. A computer may hold several Epicenters,
such as one per person. `epicenter serve` offers MCP at `/` and each UI at
`/<app>/`, on the marker's `port` or 4747 when absent.

```txt
<Epicenter>/                    one private Git repository
  .gitignore  .gitattributes     local files/caches excluded; optional LFS rules
  EPICENTER.md  AGENTS.md
  apps/<app>/                   stable container: folder.path and write lock
    code/                       one Bun project
      epicenter.ts              collections and actions
      epicenter.test.ts         action tests
      package.json  bun.lock    actions' and UI's dependencies
      README.md
      ui/                       UI source
        dist/                   generated, ignored
      node_modules/             supplied @epicenter/app link, ignored
    data/                       records and settings
      tasks/<time>.md
      google.local.md           this computer only
```

`new --from <path|url>[#folder]` copies committed code into a new container's
`code/`, without records, Git history, or a remote. It accepts a repository
root, a subfolder, or an app container's code subtree. Provenance is in
`code/SOURCE.md`. Later source changes are work for the app's owner; there is
no merge-based updater. A copied symlink stays a link. For example,
`code/ui/src/theme.css -> ../../../../../theme.css` needs a root theme in the
destination Epicenter; new reports links that do not resolve.

Read `packages/app/README.md` and one existing app before starting. Tasks is
the smallest whole example. Keep private records out of code publication;
publishing needs a separate code-only history, and no command builds it.

Before shaping a collection, decide where its truth is (`docs/vision.md`,
ADR-0896, ADR-0898), then copy the nearest example in `~/Epicenter/apps`:
Tasks for a kept collection, whose files are the truth; Mail for a cached
one, a `.local` copy of a service with the person's decisions kept beside it
and applied through an action; Messages for a live one, asked each time. An
item from elsewhere moves into a kept collection by transfer: write it with
its source id, then close it at the source. Never keep two writable copies in
step, and never make one app import or call another. Anything under
"Not yet" or "Never" in `docs/vision.md` needs the owner's yes.

Change an app's code in its own `code/`. Keep experiments outside the live
Epicenter: a branch switch, stash, or reset there changes every running app's
code and records together. A change useful to another person is a code copy
for their agent to adapt, with any record repair explained beside it.

## Decide the files first

The files outlive every UI and agent, so their shape is the decision that
matters most. Define each collection with `defineCollection({ path, fields })`
in `code/epicenter.ts`: a path template and the fields of each file's front matter
(`packages/app/README.md`). A collection gives
`list|get|add|set|edit|delete` (`get|set|edit` for one file) through
`.actions()`. An app with one collection spreads them at the top, so they are
its own (`epicenter tasks set`, MCP `tasks_set`); an app with several nests
each under its name (`epicenter mail messages list`). A record's address is
its path: `data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md`.
A path is one relative `.md` template under `data/`, such as
`data/days/{day}.md`; files in a second layout are a second collection.
`defineCollection` refuses a path outside `data/`, a list of paths, or a part
starting with `.`. A field or placeholder may not be named `path`,
`body`, `problems`, `other`, `json`, `help`, or `input`.

- Choose the path by how people and agents will name a file. `{time}` suits
  things made in passing (`data/captures/{time}.md`, `data/tasks/{time}.md`): `add`
  names the file by the time. A placeholder `add` takes suits things named by
  what they are (`data/words/{word}.md`, `data/books/{title}.md`), at the cost of
  characters a file name cannot hold. `add` and `pathOf` name the file by the
  value as NFC, trimmed, with single spaces, so an action passes what the
  person typed.
- Write a day or a moment with `localDay()` or `localTime()` from
  `@epicenter/app`, in the time zone of the computer that runs the action,
  as `field.date` and `field.datetime` hold them; `toISOString()` gives UTC's
  day, which is the wrong one in the evening west of Greenwich.
- Derive a state from fields that already say it rather than storing it
  twice: Reading has no status, since `started` and `finished` say whether
  a book is to read, being read, or read.
- `list` returns fields without bodies. Put what a list or an agent needs at a
  glance in a field (a task's `title`); put prose in the body.
- Keep fields few. `set` merges as JSON Merge Patch does: `null` removes a
  field, so a field that may be absent needs no `null` in its type; a
  required field takes no `null`. A `set` with no field throws. In a one-file
  collection every field is optional or has a default.
- Mark a field `readOnly` when only the app's own actions may write it (Vocab's
  schedule, Capture's `capturedAt`): the exposed `add` and `set` leave it out.
  A `readOnly` field that is required with no default removes the exposed
  `add`, so write the app's own (Capture's `add`).
- Constrain text with `field.text({ pattern, description })`, the description
  reading after "must be" (Tasks' title: `one line, not blank, saying what to
  do`), so the generated `set` refuses what the app's own `add` would.
- A read never trusts the file: a field that does not fit reads as its
  default, or is absent, and the file carries `problems` quoting what was
  dropped; `get` also carries `other`, the front matter that is not a fitting
  field. So every field without a default is optional when read, a required
  one included. Read code handles absence; it never assumes the declaration.
- A body changes through `edit --old <text> --new <text>`, which replaces one
  passage and is refused unless `old` occurs exactly once, so a body read
  before someone else changed it is never written back over theirs
  (ADR-0869). An empty `old` fills an empty body.
- A secret, such as a sign-in token, is a one-file collection at a
  `.local.md` path (`data/google.local.md`), its fields declared like any other
  (ADR-0870). A `.local` file stays on the computer that runs the app:
  the root `.gitignore` leaves it out of every commit, `folder` makes it `0600`,
  and its `actions()` throws, so no generated verb hands it to an MCP client.
  Read it in an action with `google.get()` and write it with `google.set(...)`.
  A fresh clone has none, so the person signs in again.
- The collections are the contract between code and records. Reads tolerate
  disagreement: undeclared keys go to `other`, and a missing optional field
  is no problem. Rename or tighten a field in two steps: change the code,
  then repair records with an action or agent. Read each record's `other` and
  `problems` afterward. A checkpoint records both code and repairs together.
  There is no global migration gate. Explain any repair when sharing code;
  another person's records change only when they run it.

## Write actions only for what the verbs cannot do

For Mail (ADR-0882), agents prepare and revise proposals; the person runs
`epicenter mail apply`. Never apply a proposal or call Gmail's mutation
endpoints on the person's mail as an agent. Exercise the apply path only
against fake Gmail.

`code/epicenter.ts` default-exports `defineApp({ description, collections,
actions })`. An app is one Bun project, with `package.json`, `bun.lock`, and
`node_modules` inside code/. Its actions may import anything its
`package.json` names, plus Node's
built-ins. Add packages with `bun add` in code/, then run
`epicenter install <app>` to restore the supplied link, which Bun can remove.
`@epicenter/app` comes from epicenter and is never listed in the app's
`package.json`. Its `engines.epicenter` (`">=0.2.0"`) is the oldest
`epicenter` the app runs on; `epicenter new` writes its own version there.
Raise it when the app starts using something a newer `@epicenter/app` added,
always as a floor (`>=`), never a caret. `epicenter new` and `epicenter install [<app>]` install from
code/package.json (`--frozen-lockfile` when `bun.lock` exists) and link that package;
a call never installs. Write each action with `defineAction`, which types its
`run` from its `input`. Add one when the caller cannot do the job with the
verbs: a rule on making a file (Tasks' `add` splits a title from its notes),
a rule across fields (Vocab's `review` scheduling), or a read shaped for a
screen (Capture's `recent`). Replace a verb by key, as in any object:
`{ ...words.actions(), add: learn }`. Inside `run`, read and write through the
collection's methods (`words.get({ path })`, `words.set({ path, ...fields })`,
`words.edit({ path, old, new })`, `words.update({ path }, change)`) instead of
parsing front matter again. For other files, the imported `folder` supplies
atomic writes and updates. Build a path with `words.pathOf({ word })`, never by hand.
Make the first write through `folder` or a collection, so the call takes
container's lock. It stays held until the call returns, throws, or stops.
After that first write, a library or `node:fs` write shares the call's lock
lifetime. A call with no folder write takes no lock. All writes stay pending
until a named commit or root checkpoint records them.
`folder` refuses a write outside `data/` or through a `.git*` path segment.
Reads may reach the whole Epicenter, including another app's records by a
path like `../tasks/data/tasks/<time>.md`, using `node:fs` or a library.
Resolve that path from `folder.path`, which is the container. Change another
app's data through its actions so its rules check the write; this is guidance,
not enforced.

Make `run` an `async function*` only when a person watches it work, such as a
chat reply from a model: each yield reaches the page that called it, and no
one else. Return what the call produced, as any action does, since the
command line, Claude, and tests see only the return. Save at the end, before
returning, so a page closed mid-reply leaves nothing half-saved (ADR-0879).
To offer Stop, pass `callSignal()` from `@epicenter/app` to the wait, such as
the model's `fetch`, so a stop ends it at once; what must survive a stop, such
as the person's message, is saved in a `finally`.

Actions run inside `epicenter serve` itself, from the files as they are when
the call arrives, so an edit takes effect on the next call. Never call
`process.exit`, `process.chdir`, or set `process.env` in an action: each
reaches every app `serve` runs.

Writes to one app run at once: a phone, an agent, and the command line can
all call the app at the same moment, and an agent may edit its files
directly. A value computed from `get` and written with `set` is last write
wins: a change made between them is lost. Compute it inside the collection's
`update` instead, which calls `change` with the record as `get` gives it
(`undefined` when there is no file) and writes the patch it returns (what
`set` takes, without `path`, plus `body` when the body changes) only over
that same record, or makes the file from it when there was none; when the
file changed meanwhile, it calls `change` again on what is there now. Vocab's
`review` schedules a word this way, so two reviews at once both count, and
Reading's `start` makes a book or starts it in one `update`, never `get` then
`add`, which two calls at once would race.

```ts
await words.update({ path }, (word) => ({ reps: (word?.reps ?? 0) + 1 }));
```

For any other file, use `folder.update(path, change)`, never `folder.read`
then `folder.write`. It does the same with the file's text (`undefined` when
there is none). Either way, keep `change` a pure function of what it is
given, since it may run more than once; throw in it to refuse, and nothing is
written. A collection's `change` that returns `{}` leaves a file as it is,
so Reading's `start` returns `{}` for a book already started; throw in it
when the record must already be there.

```ts
await folder.update('data/2026.csv', (text = 'day,minutes\n') => `${text}${day},${minutes}\n`);
```

Every collection write goes through `folder.update`. `set` writes the values
it is given, and `folder.write` is for a file whose whole content the action
decides: for both, the last write wins.

The generated verbs address a record by its path, the one address every
collection has. An action you write chooses its own input, and one people type
should take what they type: Vocab's `review` could take `{ word, grade }` and
call `words.pathOf({ word })`, giving `epicenter vocab review 你好 good`.

Annotate honestly. A read-only run takes no lock. Its folder writes throw
except to `.local` paths under data/, so an action that only reads can refresh
a token locally. Actions make no commits. The root ignore rules keep local
files out, and a checkpoint refuses local credentials Git would include.

Write last. A call holds its app's lock from its first write until its
end, and other writes to the app wait for it at most 30 seconds, so fetch
from a service, call a model, or compute first, then write. When the person's
input must survive a failure, write it after the slow step fails, not before
it starts: Vocab's `practice reply` asks the model, then saves both turns, or
saves the learner's turn alone and throws. Never run `epicenter` against the action's own app
after writing: the inner call waits for the lock its own caller holds, and
fails after 30 seconds.

After direct edits, `epicenter checkpoint -m "<what changed>"` records pending
code and records in one root commit and pushes origin when set. A plain named
Git commit works too. The branch and index are shared: checkpoints consume
staged work along with other included files. Make a named commit before a
risky change. Serve runs the same checkpoint at startup, every five minutes
after a scheduled pass completes, and on stop. It samples files, not intent,
and can capture a partial edit or part of a running action.

The root origin is optional and private. It receives all apps' records.
Checkpoints never pull, merge, rebase, or force-push. A failed push leaves
commits local for a later retry. Missing or broken code does not hide data
from a checkpoint. Keep local credentials ignored and never force-add them.
Never run `git clean -x` in the Epicenter: it deletes local credentials.

To recover, inspect Git history, then restore selected paths from the root:

```sh
git log --oneline -- apps/<app>/
git restore --source=<commit> -- apps/<app>/code/    # code only
git restore --source=<commit> -- apps/<app>/data/    # records only
```

A whole `apps/<app>/` restore reverts both and deletes tracked files added
later. Inspect the root `MIGRATION.md` and the commit tree first. Commits from
before a move into `apps/<app>/` use the old paths. An imported per-app commit
can hold only code or only records: restore its code or data prefix, not the
whole app. History retained only in archive refs is outside `main`; fetch it
explicitly into a separate recovery checkout. Keep the live home on its
current branch.

## Build the UI as a client

Copy an existing app's `code/ui/` into the new app's `code/ui/`: Svelte on Bun's bundler, with `ui/build.ts`,
the Svelte plugin beside it (`ui/svelte-plugin.ts`), the hash router in
`src/lib/router.svelte.ts`, and a manifest and icons in `static/`; copy
`bunfig.toml` with it, whose `peer = false` keeps a peer named `bun` from
shadowing Bun. The app's `code/package.json` names every package the UI imports,
from npm, never `workspace:` or `catalog:`. The UI imports Epicenter only
through `@epicenter/app/client`. It owns its components, copied into
`src/lib/components/ui/` with `components.json`, `src/lib/utils.ts`, and the
theme in `src/app.css` (ADR-0874). Add a component by copying it whole,
dependencies and tests included, and change it in place.

Build paths are relative to code/. Component paths starting with src/ or
static/ are relative to code/ui/.

`serve` builds the UI itself from `ui/` as it sits on disk, committed or
not (ADR-0880). The build runs in the app's `code/`
folder: when the app's `package.json` has a `build` script, `serve` runs it
with `EPICENTER_OUT` naming the folder to write; otherwise it bundles
`ui/index.html` and the TypeScript and CSS beside it, so a tiny UI needs no
`package.json`. Either way the build writes relative URLs and is never told
where it is served, and `@epicenter/app` comes from `epicenter`, linked into
`node_modules/` before every build; never list it. `serve` serves `ui/dist/`
and looks nowhere else. A build never installs: after adding a package, run
`epicenter install <app>`.

A change under `ui/` shows at `/<app>/` on the next page load after its
build, and the last good build stays up meanwhile. A build that fails is not
tried again until a file under `ui/`, `package.json`, or `bun.lock` changes;
run `epicenter build <app>` to build now and see the build's errors. Never
commit `ui/dist/`. The UI owns unfinished input and local interaction state.
Actions own stored records; the UI shows what serve answers and sends what the
person submits.

`src/lib/app.ts` is the one place the UI names the app's actions. It calls
`connect<typeof app>()` from `@epicenter/app/client`, importing the app
as a type (`import type app from '../../../epicenter.js'`), and lists what the
pages watch and what they change with Wellcrafted (see `query-layer`):

```ts
const app = connect<typeof tasksApp>();
export const reads = resultQueries(['tasks'], { list: app.list, get: app.get });
export const writes = resultMutations(['tasks'], { add: app.add, set: app.set });
```

For a run that should continue after the page closes, use
`app.action.start(input)`, `app.action.attach(id)`, and `app.action.pending()`.
The client reserves `start`, `attach`, and `pending` below the top level, so
choose other names for nested app actions, such as `daily.begin`.
`field.file()` accepts a temporary browser upload through these run controls;
it does not store a collection attachment. See the app package README for the
run events, cancellation, and retention contract.

Each call answers a Result: what the action returned, or a shared `ActionError`:
`Changed`, `Missing`, `Threw`, `Refused`, `Unreachable`, or `Stopped`. Use the
factories from `@epicenter/app` in actions. Check the name and its subject, never
the message. A `Missing` may describe a dependency rather than the record being
shown. An error does not establish what was saved or rolled back; reread the
record when the outcome is uncertain and retain unsent writing. The layout creates one
QueryClient from the UI's own `@tanstack/svelte-query`, with the invalidation
rule from `query-layer`, and puts it
in `<QueryClientProvider>`; pages read with
`createQuery(() => reads.get({ path }))` and write with
`createMutation(() => writes.set)`. That client refreshes every read after
each write, before the write counts as done, and when the UI is shown
again, so a page never refreshes by hand or on a timer. Name
types with `ActionInput<typeof app.actions.set>` and
`ActionOutput<typeof app.actions.get>`.

An action that yields takes `onYield` after its input, to show its work as it
comes: `app.chat.say({ message }, { onYield: (token) => (draft += token) })`
resolves with the same Result once the reply is whole. Pass it where the page
keeps its draft, and make that call the mutation's function, so every read
still refreshes once it returns. A Stop button passes `{ signal }` too and
aborts it; the call then resolves as the `Stopped` error, which is not a
failure to show.

- Route a record by its whole path: the page is at `#/data/tasks/<time>.md`,
  linked with each part URL-encoded
  (`path.split('/').map(encodeURIComponent).join('/')`) and read back with the
  router's `currentPath()`. Write no code that knows the app's templates; show
  a record's name from its read (`row.word`).
- Show a record's `problems` quietly where the record is shown, and never
  crash on a field that is absent.

- It is a phone Home Screen app first: safe-area insets, 44 px targets, 16 px
  inputs so iOS does not zoom, light and dark from the system.
- Send `set` only the fields being submitted, and `null` for one emptied.
  Do not spread an entire cached record into a field update. Comparing with
  cached data can avoid a request; it cannot establish what is currently saved.
- When draft, recovery, or workflow promises are unsettled, use
  [product-collapse](../product-collapse/SKILL.md) to choose the behavior.
  For settled behavior, choose each input's owner with
  [input ownership](../svelte/references/input-ownership.md).
  Writes also arrive from other tabs, agents, and the command line; blocking
  local edits while pending prevents only this page's overlap.
- Use `edit` with its quoted base (`old: base, new: draft`) when the app promises
  conflict detection. On `Changed`, reread and preserve the submitted text
  while resolving the conflict. When last-write-wins is accepted, use the app's
  replacement action without adding rebasing or a recovery queue.
- Show a write before it lands from the mutations still pending:
  `useMutationState({ filters: { mutationKey: writes.set.mutationKey, status:
  'pending' } })` (Tasks' done, Vocab's review queue, Capture's adds). When the
  write settles, the refreshed read takes over. Say a failed write in a toast
  with `error.message`.
- Save on blur, on a pause, or on an explicit action, never on each keystroke.
  Checkpoints sample those files later; a call is not a commit boundary.

## Verify without touching the person's data

Never run anything against the real `~/Epicenter` until the person asks.
Use a temporary home and a committed source. `new --from` copies code and
creates empty sibling data/; then build it as serve would. Uncommitted edits
are not copied. To test them, commit in a disposable copy outside the live
Epicenter, without changing the live branch or index.

```sh
bun test ./epicenter.test.ts                # from code/: actions over memory
source_path=/absolute/path/to/source        # choose a repository or subfolder
test_home=$(mktemp -d)
printf '[user]\n\tname = Test\n\temail = test@example.com\n' > "$test_home/.gitconfig"
HOME="$test_home" epicenter init "$test_home/Epicenter"
cd "$test_home/Epicenter"
HOME="$test_home" epicenter new example --from "$source_path"
HOME="$test_home" epicenter build example
HOME="$test_home" epicenter example --help
HOME="$test_home" epicenter serve --port 4799   # drive /example/ in this test home
```

In the monorepo, the source CLI is `bun <repo>/packages/cli/src/bin.ts`.
The temporary Git configuration isolates identity and signing settings.
Run `bun run typecheck` and action tests from code/, where package.json lives.
Run tests one file or package at a time.

## Put an app on the server

Only when the person asks, on the computer that runs `epicenter serve`:

- `epicenter new <app> --from <path|url>[#folder]` takes committed code into
  apps/<app>/code/ and creates empty data/. It installs but does not build;
  run `epicenter build <app>` to check it before opening its page.
- To adapt later code, inspect a committed copy in a temporary home, then
  change the existing app's code/ deliberately. Preserve data/ beside it and
  repair records after changing fields. There is no automatic later merge.
- Back up the root to one optional private origin. A checkpoint commits all
  included pending files and pushes only there. Restore with one root clone
  and `epicenter init --from`, then recreate local credentials.
- Sharing code requires a separate code-only history, deliberately made and
  reviewed for private content. Never publish the private root history.
  Make or clone that code-only repository outside the private Epicenter:
  a Git repository inside it makes every checkpoint refuse.
  No publication command is built.
- `epicenter build [<app>]` rebuilds from code/ui/ while retaining the last
  good build. The project's own build script may empty its output first.
- Run from inside the app's Epicenter. Another person's Epicenter is a
  different folder with its own port.

A running serve loads edited code on the next call and checks code/ui/ on a
page load. It serves code/ui/dist/ and keeps the last good build while rebuilding.
