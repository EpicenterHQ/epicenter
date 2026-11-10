---
name: epicenter-app
description: Make or change an app that lives in an Epicenter (such as ~/Epicenter), or the starter it comes from: its collections, its actions, and its UI. Use when asked to build a new personal app (a tracker, a log, a list), add a field or action to Capture, Reading, Tasks, or Vocab, change an app's UI, set up an Epicenter, or make or update an app from a starter on the computer that runs epicenter serve.
---

# Epicenter apps

An Epicenter is a folder holding `EPICENTER.md`; its apps are the folders
directly inside it with an `epicenter.ts`, each a Git repository of its own
(ADR-0868). `epicenter` works on the Epicenter you stand in (walking up from
the current folder), else `EPICENTER_ROOT`, else `~/Epicenter`; a computer may
hold several, such as one per person. `epicenter serve` offers one
Epicenter's actions over MCP at `/` and each app's UI at `/<app>/`, on the
`port` in its `EPICENTER.md` front matter (4747 when absent).

An app can start from a starter, a repository with no data, which it keeps as
its `upstream` remote; `epicenter update` merges the starter's later changes
and builds the UI (ADR-0866). Capture, Reading, Tasks, and Vocab are starters' source
in `apps/<app>/`; `apps/tasks` is the smallest whole example. Read
`apps/README.md`, `packages/app/README.md`, and one existing app before
starting.

Change an app where the change belongs. A change for one person's app is
made in the app's folder in its Epicenter and committed there; Git merges it with the
starter's on the next update. A change for every app made from a starter is
made in the starter.

```txt
<app>/
  epicenter.ts     the app: its collections and actions, composed by defineApp
  epicenter.test.ts, package.json   the actions' tests and what they need
  ui/              the UI, a SvelteKit project of its own
  ui/dist/         the view serve shows at /<app>/: built, and ignored by ui/.gitignore
  <data>           files the collections' paths match; never in a starter
```

## Decide the files first

The files outlive every UI and agent, so their shape is the decision that
matters most. Define each collection with `defineCollection({ path, fields })`
in `epicenter.ts`: a path template and the fields of each file's front matter
(`packages/app/README.md`). A collection gives
`list|get|add|set|edit|delete` (`get|set|edit` for one file) through
`.actions()`. An app with one collection spreads them at the top, so they are
its own (`epicenter tasks set`, MCP `tasks_set`); an app with several nests
each under its name (`epicenter mail messages list`). A record's address is
its path: `tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md`.
A path is one relative `.md` template that starts with a folder of its own
(`days/{day}.md`, not `{day}.md`); files in a second layout are a second
collection. `defineCollection` refuses a list of paths, a part starting with
`.`, a first part of `ui` or `node_modules`, and one
starting with `epicenter.`. A field or placeholder may not be named `path`,
`body`, `problems`, `other`, `json`, `help`, or `input`.

- Choose the path by how people and agents will name a file. `{time}` suits
  things made in passing (`captures/{time}.md`, `tasks/{time}.md`): `add`
  names the file by the time. A placeholder `add` takes suits things named by
  what they are (`words/{word}.md`, `books/{title}.md`), at the cost of
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
  `.local.md` path (`google.local.md`), its fields declared like any other
  (ADR-0870). A `.local` file stays on the computer that runs the app: the
  app's `.gitignore` leaves it out of every commit, `folder` makes it `0600`,
  and its `actions()` throws, so no generated verb hands it to an MCP client.
  Read it in an action with `google.get()` and write it with `google.set(...)`.
  A fresh clone has none, so the person signs in again.
- The collections are the contract between a starter and the data. A starter
  that renames or tightens a field changes existing files itself: Git merges
  code and does not migrate data, and a file that no longer fits says so in
  the `problems` of every read.

## Write actions only for what the verbs cannot do

`epicenter.ts` default-exports `defineApp({ description, collections,
actions })` and may import only `@epicenter/app`, which `epicenter` supplies
when it runs the file, and Node's built-ins: nothing installs the app's own
packages. Write each action with `defineAction`, which types its
`run` from its `input`. Add one when the caller cannot do the job with the
verbs: a rule on making a file (Tasks' `add` splits a title from its notes),
a rule across fields (Vocab's `review` scheduling), or a read shaped for a
screen (Capture's `recent`). Replace a verb by key, as in any object:
`{ ...words.actions(), add: learn }`. Inside `run`, read and write through the
collection's methods (`words.get({ path })`, `words.set({ path, ...fields })`,
`words.edit({ path, old, new })`, `words.update({ path }, change)`) instead of
parsing front matter again, and through the imported `folder` for any other
file. Build a path with `words.pathOf({ word })`, never by hand.

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
await folder.update('2026.csv', (text = 'day,minutes\n') => `${text}${day},${minutes}\n`);
```

Every collection write goes through `folder.update`. `set` writes the values
it is given, and `folder.write` is for a file whose whole content the action
decides: for both, the last write wins.

The generated verbs address a record by its path, the one address every
collection has. An action you write chooses its own input, and one people type
should take what they type: Vocab's `review` could take `{ word, grade }` and
call `words.pathOf({ word })`, giving `epicenter vocab review 你好 good`.

Annotate honestly. An action never commits; after a run that is not
`readOnlyHint: true`, `epicenter` commits exactly the files it wrote through
`folder`, named for the call (`<app>: <words> <first positional>`, with
` (threw)` when it threw). A read-only run never commits, and its writes
through `folder` throw, so an action that writes a file is not read-only. A
`.local` file is the exception: it is never in history, so a read-only action
may refresh the token it keeps there.

Write last. A call holds its app's lock from its first write until its
commit, and other writes to the app wait for it, so fetch from a service or
compute first, then write. Never run `epicenter` against the action's own app
after writing: the inner call waits for the lock its own caller holds, and
fails after 30 seconds.

When you edit an app's files yourself rather than through its actions, commit
your own edits when you finish, saying what you did:
`epicenter sync <app> -m "<what you did>"` commits everything pending in the
app under that message and backs it up. A plain `git commit` in the app's
folder is safe too, since the app's `.gitignore` keeps `*.local` and
`*.local.*` out; never add one with `git add -f`. Edits nobody commits are
committed by `epicenter serve` within 5 minutes as
`<app>: changed outside epicenter`.

An agent can read and reverse that history. `epicenter history <app>` lists
the commits, newest first, each with its commit, local time, subject, and the
paths it changed (`--json` gives `{ commit, date, subject, changed, undid? }`). `epicenter undo
<app>` snapshots what is pending, then reverts the newest snapshot that is not
an undo and not undone, as `<app>: undid <subject>`; run it again to go further
back, `epicenter undo <app> <commit>` to undo that commit, and undo an undo to
bring it back. It refuses a commit not in the app's history, a revert Git
refuses (a merge), and one that conflicts or changes nothing, leaving the
folder as it was. After a write that went
wrong, undo it rather than rewriting the file by hand, so history says what
happened.

## Build the UI as a client

Copy an existing app's `ui/`: SvelteKit with the hash router, `@epicenter/ui`
and its `app.css`, a manifest and icons in `static/`, and its
`svelte.config.js`, which builds into `ui/dist/` with the app's folder
name as the base. `serve` serves `ui/dist/` and looks nowhere else. A tiny
view needs no build: with no `build` script in `ui/package.json`, write
`ui/dist/index.html` by hand and commit it. Ask for everything through
`connect<typeof app>('<app>')` from
`@epicenter/app/client`, importing the app as a type
(`import type app from '../../../epicenter.js'`): `app.set({ path, done: true
})` calls the action under the same words, typed by the app. Name types with
`ActionInput<typeof app.actions.set>` and
`ActionOutput<typeof app.actions.get>`. The UI keeps nothing of its own.

- Route a record by its whole path: a rest route `src/routes/[...path]`, so the
  page is at `#/tasks/<time>.md`, linked with each part URL-encoded
  (`path.split('/').map(encodeURIComponent).join('/')`) and read back from
  `page.params.path`. Write no code that knows the app's templates; show a
  record's name from its read (`row.word`). SvelteKit decodes the hash once
  when the page loads, so a name holding `?`, `#`, or `%` survives a link
  inside the UI but not a reload.
- Show a record's `problems` quietly where the record is shown, and never
  crash on a field that is absent.

- It is a phone Home Screen app first: safe-area insets, 44 px targets, 16 px
  inputs so iOS does not zoom, light and dark from the system.
- Send `set` only the fields that changed, and `null` for one emptied, so a
  save never writes back a value read before someone else changed it. Skip a
  save with nothing to send.
- Save a changed body with `edit`, quoting the body as it was loaded
  (`old: loaded, new: draft`), after `set` has saved the fields. When
  `changedElsewhere(error)` from `@epicenter/app/client` is true, get the
  file again: reapply a small change to the new body (Capture's checkbox), or
  keep what was typed and say it was not saved, letting the person save over
  the other change on purpose (Tasks' "Keep mine").
- Update optimistically and say a failed write in a toast. Refresh on
  visibility and every 15 s while visible, and drop a refresh that began
  before a write, so it cannot undo what the screen shows.
- Every write is a commit in the app's history. Save on blur, on a pause,
  or on an explicit action, never on each keystroke.

## Verify without touching the person's data

Never run anything against the real `~/Epicenter` until the person asks.
`HOME` decides `~`, so try an app in a temporary home. In the monorepo, build
the UI in place, then copy the app into the temporary home as a repository of
its own, since `epicenter` commits every write into the app's repository:

```sh
bun test ./epicenter.test.ts               # in apps/<app>: actions over createMemoryContext
(cd apps/<app>/ui && bun run build)        # writes apps/<app>/ui/dist/
T=$(mktemp -d)
printf '[user]\n\tname = Test\n\temail = test@example.com\n' > $T/.gitconfig
HOME=$T bun packages/cli/src/bin.ts init $T/Epicenter   # writes EPICENTER.md and AGENTS.md
rsync -a --exclude node_modules --exclude .svelte-kit apps/<app>/ $T/Epicenter/<app>/
git -C $T/Epicenter/<app> init -q && git -C $T/Epicenter/<app> add -A && git -C $T/Epicenter/<app> commit -qm start
HOME=$T bun packages/cli/src/bin.ts <app> <words> ...
HOME=$T bun packages/cli/src/bin.ts serve --port 4799   # then drive http://localhost:4799/<app>/
```

The temporary `.gitconfig` keeps the person's own, which may sign commits,
out of the test. Run `bun run typecheck` in the app and in its `ui/`. Run
tests one file or package at a time.

## Put an app on the server

Only when the person asks, on the computer that runs `epicenter serve`:

- `epicenter new <app> --from <git url|path>` clones a starter, keeps it as
  `upstream`, and builds the UI. The path must be a repository's root, so a
  folder inside the monorepo is not a starter; Capture, Reading, Tasks, and Vocab
  become starters when each moves to a repository of its own.
- `epicenter update [<app>]` snapshots what is pending, merges the starter's
  changes, and builds. It undoes a merge that conflicts, naming the command
  that resolves it.
- Backups go to `origin`: add the remote, and `epicenter sync` pushes there
  by name at once, and `serve` every 5 minutes, never to `upstream`. Nothing
  else pushes, `undo` included.
- `epicenter build [<app>]` rebuilds a UI after a local edit, keeping the last
  one that built; the UI project's own `bun run build` empties `ui/dist/`
  first, so a page served meanwhile is missing.
- Run these from inside the Epicenter the app belongs to; another person's
  Epicenter on the same computer is another folder with its own port.

A running `epicenter serve` sees a change on the next request: it lists tools
and reads `ui/dist/` from disk each time.
