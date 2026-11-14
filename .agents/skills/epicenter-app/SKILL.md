---
name: epicenter-app
description: Make or change an app that lives in an Epicenter (such as ~/Epicenter): its collections, its actions, its UI, and its two repositories, code and data. Use when asked to build a new personal app (a tracker, a log, a list), add a field or action to Capture, Reading, Tasks, or Vocab, change an app's UI, set up an Epicenter, share an app or take one from someone, or take later changes from the app an app's code was copied from, on the computer that runs epicenter serve.
---

# Epicenter apps

An Epicenter is a folder holding `EPICENTER.md`; its apps are the folders
directly inside it with an `epicenter.ts` (ADR-0868). `epicenter` works on the
Epicenter you stand in (walking up from the current folder), else
`EPICENTER_ROOT`, else `~/Epicenter`; a computer may hold several, such as one
per person. `epicenter serve` offers one Epicenter's actions over MCP at `/`
and each app's UI at `/<app>/`, on the `port` in its `EPICENTER.md` front
matter (4747 when absent).

An app is two Git repositories (ADR-0877). The app's folder is its code
repository, which ignores `data/`; `data/` is its data repository, holding
every record and every file the app keeps (ADR-0876). The code travels: it is
what someone else takes, by copying it (ADR-0904). The data never travels:
its history records every write, so it is backed up privately and shared
with no one.

```txt
<app>/                 the code repository
  .gitignore           data/  node_modules/
  epicenter.ts         the app: its collections and actions, composed by defineApp
  epicenter.test.ts, package.json   the actions' tests and what they need
  README.md
  ui/                  the UI's source
  ui/dist/             the UI serve shows at /<app>/: built from ui/, never committed
  data/                the data repository
    .gitignore         *.local  *.local.*
    .gitattributes     binary files through LFS (ADR-0856)
    tasks/<time>.md    records
    google.local.md    kept on this computer, never committed
```

An app is its `epicenter.ts` over its data. The collections and actions
there are the contract, and the UI is one view of it that can be replaced:
the UI imports `epicenter.ts` for its types alone and calls the actions
through `connect()`, so `bun run typecheck` says whether a UI is valid for
an `epicenter.ts`. An app can start as a copy of another app's code, taken
with `epicenter new --from`. The copy is a repository of its own with no
remote, and no command merges later changes into it (ADR-0904). An app has
one home: its folder in an Epicenter, backed up to its code repository.
Capture, Reading, Tasks, and Vocab live in their author's Epicenter, each a
private GitHub repository; the monorepo holds the platform and no apps
(ADR-0877). Read `@epicenter/app`'s
README (`packages/app/README.md` in the monorepo) and one existing app before
starting; Tasks is the smallest whole example.

Before shaping a collection, decide where its truth is (`docs/vision.md`,
ADR-0896, ADR-0898), then copy the nearest example in `~/Epicenter/apps`:
Tasks for a kept collection, whose files are the truth; Mail for a cached
one, a `.local` copy of a service with the person's decisions kept beside it
and applied through an action; Messages for a live one, asked each time. An
item from elsewhere moves into a kept collection by transfer: write it with
its source id, then close it at the source. Never keep two writable copies in
step, and never make one app import or call another. Anything under
"Not yet" or "Never" in `docs/vision.md` needs the owner's yes.

Change an app where it is: edit its folder and commit to its code
repository. The code is the person's own, written there or copied, and
nothing keeps it in step with any other copy. A change meant for everyone
who took an app is made in the app they took it from, and reaches each of
them when their agent takes it (see "Take later changes" below).

## Decide the files first

The files outlive every UI and agent, so their shape is the decision that
matters most. Define each collection with `defineCollection({ path, fields })`
in `epicenter.ts`: a path template and the fields of each file's front matter
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
  `data/.gitignore` leaves it out of every commit, `folder` makes it `0600`,
  and its `actions()` throws, so no generated verb hands it to an MCP client.
  Read it in an action with `google.get()` and write it with `google.set(...)`.
  A fresh clone has none, so the person signs in again.
- The collections are the contract between the code and the data, and they
  live in different repositories, so nothing checks that they agree: a key no
  field declares goes to `other`, and a missing optional field is no problem.
  Rename or tighten a field in two steps. Commit the code first; then rewrite
  the records, by an action or by hand, so each data commit names the code it
  was written for. Then read every record's `other` and `problems` to find any
  the rewrite missed. Someone who takes the change into their copy gets the code
  only: their records change when they run the same rewrite, so ship it as an
  action, or say in the README what to run.

## Write actions only for what the verbs cannot do

For Mail (ADR-0882), agents prepare and revise proposals; the person runs
`epicenter mail apply`. Never apply a proposal or call Gmail's mutation
endpoints on the person's mail as an agent. Exercise the apply path only
against fake Gmail.

`epicenter.ts` default-exports `defineApp({ description, collections,
actions })`. An app is one Bun project, with `package.json`, `bun.lock`, and
`node_modules` at the app's top. Its actions may import anything its
`package.json` names, plus Node's
built-ins. Add packages with `bun add` in the app's folder, then run
`epicenter install <app>` to restore the supplied link, which Bun can remove.
`@epicenter/app` comes from epicenter and is never listed in the app's
`package.json`. Its `engines.epicenter` (`">=0.2.0"`) is the oldest
`epicenter` the app runs on; `epicenter new` writes its own version there.
Raise it when the app starts using something a newer `@epicenter/app` added,
always as a floor (`>=`), never a caret. `epicenter new` and `install [<app>]` install from
the app's top-level `package.json` (`--frozen-lockfile` when `bun.lock` exists) and link that package;
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
the app's lock and snapshots pending data separately. After that, writes may
go any way: `folder`, `node:fs`, or a library. The call commits everything
pending in `data/` that Git does not ignore when it ends. A call with no
`folder` write takes no lock and commits nothing; its writes stay pending.
`folder` refuses a write outside `data/` or through a `.git*` path segment.
Reads may reach the whole Epicenter, including another app's records by a
path like `../tasks/data/tasks/<time>.md`, using `node:fs` or a library.
Change another app's data through that app's actions, so its history names
what happened; this is guidance, not enforced.

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

Annotate honestly. An action never commits; after a run that is not
`readOnlyHint: true`, epicenter commits everything pending in `data/`,
named for the call (`<app>: <words> <first positional>`, with ` (threw)`
when it threw). Edits pending before the first write get their own
`<app>: changed outside epicenter` snapshot. If that snapshot fails, the
call leaves everything pending and reports the failure. The call's data
commit carries `Code-Commit: <sha>`, the code HEAD read before `epicenter.ts`
loads, and `Code-Dirty: true` when the code then had uncommitted changes.
A read-only run takes no lock and commits nothing. Its writes through
`folder` throw except to a `.local` file under `data/`: a read-only action
may refresh its token there without taking the lock, and no commit takes it.

Write last. A call holds its app's lock from its first write until its
commit, and other writes to the app wait for it at most 30 seconds, so fetch
from a service, call a model, or compute first, then write. When the person's
input must survive a failure, write it after the slow step fails, not before
it starts: Vocab's `practice reply` asks the model, then saves both turns, or
saves the learner's turn alone and throws. Never run `epicenter` against the action's own app
after writing: the inner call waits for the lock its own caller holds, and
fails after 30 seconds.

When you edit an app's files yourself rather than through its actions, commit
your edits when you finish, each to its own repository:

- Code: `git commit` in the app's folder, with a message that says what the
  code does now. Whoever takes the app reads that history, so a code message
  never names or quotes a record.
- Records: `epicenter sync <app> -m "<what you did>"` commits everything
  pending in the app under that message and backs it up. Commit the code
  first, so the data commit names the code it was written for, and so the
  message, which `sync` gives both repositories, lands only on the data.
  `git commit` inside `data/` is safe too, since `data/.gitignore` keeps
  `*.local` and `*.local.*` out; never add one with `git add -f`.

Edits nobody commits are committed by `epicenter serve` within 5 minutes as
`<app>: changed outside epicenter`, in whichever repository holds them.

Never run `git clean -ffdx` or `git clean -x` in the app's folder: `data/` is
ignored there, so Git deletes it, with any history not yet pushed.

An agent can read and reverse that history. `epicenter history <app>` lists
both repositories' commits together, newest first, each with its commit, local
time, `code` or `data`, subject, and the paths it changed (`--json` gives
`{ commit, date, repository, subject, changed, code?, undid? }`, `code` being
a data commit's `Code-Commit`). `epicenter undo <app>` snapshots what is
pending, then reverts the newest data snapshot that is not an undo and not
undone, as `<app>: undid <subject>`; run it again to go further back,
`epicenter undo <app> <commit>` to undo that data commit, and undo an undo to
bring it back. When the code changed after the commit it undid, its answer
lists the code commits since (`codeSince`): a record rewrite undone may need
the field change it went with undone too. Undo reverts data only; revert a
code commit with `git -C <app folder> revert <sha>`. It refuses a commit not
in the data's history, a revert Git refuses (a merge), and one that conflicts
or changes nothing, leaving the folder as it was. After a write that went
wrong, undo it rather than rewriting the file by hand, so history says what
happened.

## Build the UI as a client

Copy an existing app's `ui/`: Svelte on Bun's bundler, with `ui/build.ts`,
the Svelte plugin beside it (`ui/svelte-plugin.ts`), the hash router in
`src/lib/router.svelte.ts`, and a manifest and icons in `static/`; copy
`bunfig.toml` with it, whose `peer = false` keeps a peer named `bun` from
shadowing Bun. The app's `package.json` names every package the UI imports,
from npm, never `workspace:` or `catalog:`. The UI imports Epicenter only
through `@epicenter/app/client`. It owns its components, copied into
`src/lib/components/ui/` with `components.json`, `src/lib/utils.ts`, and the
theme in `src/app.css` (ADR-0874). Add a component by copying it whole,
dependencies and tests included, and change it in place.

`serve` builds the UI itself from `ui/` as it sits on disk, committed or
not (ADR-0880). An app is one Bun project, so the build runs in the app's
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
commit `ui/dist/`. The UI keeps
nothing of its own: it shows what serve answers and sends what the person
changes.

`src/lib/app.ts` is the one place the UI names the app's actions. It calls
`connect<typeof app>()` from `@epicenter/app/client`, importing the app
as a type (`import type app from '../../../epicenter.js'`), and lists what the
pages watch and what they change with Wellcrafted (see `query-layer`):

```ts
const app = connect<typeof tasksApp>();
export const reads = resultQueries(['tasks'], { list: app.list, get: app.get });
export const writes = resultMutations(['tasks'], { add: app.add, set: app.set });
```

Each call answers a Result: what the action returned, or an `ActionError`
told apart by `name`: `Changed` and `Missing` (the `FileError` the action
threw), `Threw`, `Refused`, `Unreachable`. Check the name, never the message:
a page for one record shows "it was deleted" when its read is `Missing`. The layout makes one
QueryClient with `createQueryClient()` from the UI's own
`src/lib/query-client.ts` (copy it from an existing app; it builds on the UI's
own `@tanstack/svelte-query`, so the bundle has one TanStack Query) and puts it
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
- Send `set` only the fields that changed, and `null` for one emptied, so a
  save never writes back a value read before someone else changed it. Skip a
  save with nothing to send.
- Keep what is typed as a draft over the query's data
  (`bind:value={() => draft ?? file.body, (value) => (draft = value)}`), and
  clear it once it is saved, so a refresh never overwrites typing.
- Save a changed body with `edit`, quoting the body the draft was typed over
  (`old: base, new: draft`), after `set` has saved the fields. When the
  error's `name` is `Changed`, the failed
  write has already refreshed the file: reapply a small change to the new body
  (Capture's thoughts), or keep what was typed and say it was not saved,
  letting the person save over the other change on purpose (Tasks' "Keep
  mine").
- Show a write before it lands from the mutations still pending:
  `useMutationState({ filters: { mutationKey: writes.set.mutationKey, status:
  'pending' } })` (Tasks' done, Vocab's review queue, Capture's adds). When the
  write settles, the refreshed read takes over. Say a failed write in a toast
  with `error.message`.
- Every write is a commit in the app's history. Save on blur, on a pause,
  or on an explicit action, never on each keystroke.

## Verify without touching the person's data

Never run anything against the real `~/Epicenter` until the person asks.
`HOME` decides `~`, so try an app in a temporary home. Take the app from its
code repository with `new --from`, which copies what Git tracks there at
`HEAD` and makes an empty data repository, then `epicenter build <app>`
builds its UI as the server would. Uncommitted changes are not copied, so
commit them on a branch first, or take the app from a copy of its folder
with them committed there:

```sh
bun test ./epicenter.test.ts               # in the app: actions over createMemoryContext
T=$(mktemp -d)
printf '[user]\n\tname = Test\n\temail = test@example.com\n' > $T/.gitconfig
HOME=$T epicenter init $T/Epicenter        # writes EPICENTER.md and AGENTS.md
cd $T/Epicenter
HOME=$T epicenter new <app> --from <the app's folder, or its Git URL>
HOME=$T epicenter build <app>              # the UI, as serve builds it
HOME=$T epicenter <app> <words> ...
HOME=$T epicenter serve --port 4799        # then drive http://localhost:4799/<app>/
```

In the monorepo, run the CLI from source as `bun <repo>/packages/cli/src/bin.ts`.
The temporary `.gitconfig` keeps the person's own, which may sign commits,
out of the test. Run `bun run typecheck` in the app; it checks the actions and
the UI. Run tests one file or package at a time.

## Put an app on the server

Only when the person asks, on the computer that runs `epicenter serve`:

- `epicenter new <app> --from <git url>` takes another app by copying its
  code from the root of that repository; `--from <git url>#<folder>` takes a
  folder inside it, for a repository that holds several apps. On the same
  computer, `--from <path>` names the folder that holds `epicenter.ts`
  (`--from ~/Code/apps/vocab`), a repository's root or any folder inside one,
  with no `#`. Only the files Git tracks at that repository's `HEAD` are
  copied, so the path must be inside a Git repository, and `data/`,
  `node_modules/`, builds, and uncommitted changes never come along. The copy
  is one commit in a new repository with no remote, whose message names
  where it came from (`Source:` and `Source-Commit:`), beside an empty data
  repository. A folder that tracks `data/` is refused.
- Backups go to each repository's `origin`, a private remote: add one to the
  app's folder and one to `data/`, and `epicenter sync` pushes both there at
  once, and `serve` every 5 minutes, never anywhere else. Nothing else pushes,
  `undo` included. Restoring is two clones: the code's backup, then the data's
  into `data/`.
- Sharing an app is pushing its code repository to a remote the person
  chooses, which only they or an agent they ask does: `git -C <app> push
  <remote> main`. Someone takes it with `new --from <its URL>`. Whoever can
  read that remote reads the code's real history, every code commit
  included, so check it for anything private before the first push. To share
  several apps from one place, keep each as a folder of one repository
  outside the Epicenter: `git -C <app> archive HEAD | tar -x -C
  <repository>/<app>` puts an app's tracked files there, without its
  history, and someone takes one with `--from <URL>#<app>`. Never push
  `data/` anywhere but its own `origin`.
- `epicenter build [<app>]` rebuilds a UI after a local edit, keeping the last
  one that built; the UI project's own `bun run build` empties `ui/dist/`
  first, so a page served meanwhile is missing.
- Run these from inside the Epicenter the app belongs to; another person's
  Epicenter on the same computer is another folder with its own port.

A running `epicenter serve` sees a change on the next request: it lists tools
and reads `ui/dist/` from disk each time.

## Take later changes

No command brings an app the later changes of the code it was copied from
(ADR-0904). Do it when the person asks, as a comparison you read. A merge
could not say that a changed collection leaves the person's records not
fitting, so the order below puts that question first.

1. Find where the code came from. `git -C <app> log --reverse --format=%B |
   head` shows the first commit's `Source:`, the `--from` argument, and
   `Source-Commit:`, the commit copied. A Git URL may end in `#<folder>`,
   the app's folder in that repository. A path is the app's folder on the
   computer it was taken on: `git -C <path> rev-parse --show-toplevel` is
   its repository's root, and the rest of the path is `<folder>`. If a later
   commit says it took changes, start from the commit it names. An app made
   when `new --from` still cloned has an `upstream` remote and shares its
   history: `git merge-base HEAD upstream/<branch>` is its commit.
2. Get that code as it is now, in a temporary directory outside the
   Epicenter, so `epicenter` never lists it as an app and no snapshot takes
   it:

   ```sh
   T=$(mktemp -d)
   git clone -q <URL or repository root> $T/code
   # the app is $T/code/<folder>; drop <folder>/ when it is the root
   git -C $T/code diff <Source-Commit> HEAD -- <folder>/epicenter.ts
   git -C $T/code diff <Source-Commit> HEAD -- <folder>/ui
   ```

   When that commit is no longer in the repository, compare the two folders
   as they are.
3. Read the `epicenter.ts` diff first: it is the only change that can affect
   data. When a collection's path or fields changed, stop and plan the
   migration with the person before taking anything: which records stop
   fitting, and the action or rewrite that repairs them, in the two steps
   under "Decide the files first". Take the actions the person wants.
4. Take the UI one of two ways. Replace it whole when the app has not
   changed its own UI, or the person wants the new one more than their own
   changes: commit what is pending, replace `ui/` with the other `ui/`, and
   commit that alone, so `git revert` takes it back. Otherwise port the
   changes wanted over the app's own, file by file. Take what the UI needs
   in `package.json` and `bun.lock`, then run `epicenter install <app>`.
5. Run `bun run typecheck`, which says whether the UI is valid for this
   `epicenter.ts`, then `bun test ./epicenter.test.ts` and
   `epicenter build <app>`. Commit with a message that names the commit you
   compared against, and tell the person what you took, what you left, and
   why.
