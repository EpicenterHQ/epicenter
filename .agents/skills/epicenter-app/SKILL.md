---
name: epicenter-app
description: Make or change an app that lives in an Epicenter (such as ~/Epicenter), or the starter it comes from: its collections, its actions, and its UI. Use when asked to build a new personal app (a tracker, a log, a list), add a field or action to Capture, Tasks, or Vocab, change an app's UI, set up an Epicenter, or make or update an app from a starter on the computer that runs epicenter serve.
---

# Epicenter apps

An Epicenter is a folder holding `epicenter.root.json`; its apps are the
folders directly inside it with an `epicenter.json`, each a Git repository of
its own (ADR-0868). `epicenter` works on the Epicenter you stand in (walking
up from the current folder), else `EPICENTER_ROOT`, else `~/Epicenter`; a
computer may hold several, such as one per person. `epicenter serve` offers
one Epicenter's actions over MCP at `/` and each app's UI at `/<app>/`, on the
port in its `epicenter.root.json`.
An app can start from a starter, a repository with no data, which it keeps as
its `upstream` remote; `epicenter update` merges the starter's later changes
and builds the UI (ADR-0866). Capture, Tasks, and Vocab are starters' source
in `apps/<app>/`; `apps/tasks` is the smallest whole example. Read
`apps/README.md`, `packages/app/README.md`, and one existing app before
starting.

Change an app where the change belongs. A change for one person's app is
made in the app's folder in its Epicenter and committed there; Git merges it with the
starter's on the next update. A change for every app made from a starter is
made in the starter.

```txt
<app>/
  epicenter.json   the declaration: its collections
  epicenter.ts     its actions beyond each collection's five
  epicenter.test.ts, package.json   the actions' tests and what they need
  ui/              the UI, a SvelteKit project of its own
  .cache/ui/       the built UI, ignored by Git
  <data>           files the collections' paths match; never in a starter
```

## Decide the files first

The files outlive every UI and agent, so their shape is the decision that
matters most. Declare each collection in `epicenter.json`: a path with one
placeholder and the JSON Schema of each file's fields. A collection gives
`list|get|set|edit|delete` with no code (`packages/app/src/collection.ts`): as the
app's own verbs when it is the app's only collection (`epicenter tasks set`,
MCP `tasks_set`), and under its name when there are several (`epicenter mail
messages list`). Adding a second collection renames the first's actions, so
prefer one collection per app.
A path may not start with `ui/`, `.cache/`, or `epicenter.`.

- Choose the key by how people and agents will name a file. A time id
  (`timeId()`) suits things made in passing (captures, tasks); a natural key
  suits things named by what they are (`words/你好.md`), at the cost of
  characters a file name cannot hold.
- `list` returns fields without bodies. Put what a list or an agent needs at a
  glance in a field (a task's `title`); put prose in the body.
- Keep fields few. `set` merges as JSON Merge Patch does: `null` removes a
  field, so a field that may be absent needs no `null` in its type; a
  required field takes no `null`. A `set` with no field and no body throws.
- `set` gives a body only to a new file. A body already there changes through
  `edit --old <text> --new <text>`, which replaces one passage and is refused
  unless `old` occurs exactly once, so a body read before someone else
  changed it is never written back over theirs (ADR-0869). An empty `old`
  fills an empty body.
- The declaration is the contract between a starter and the data. A starter
  that renames or tightens a field changes existing files itself: Git merges
  code and does not migrate data, and `epicenter update` lists each file that
  no longer fits.

## Write actions only for what the five verbs cannot do

`epicenter.ts` default-exports `defineApp(declaration, { actions })` and may
import only `@epicenter/app`, which `epicenter` supplies when it runs the
file, and `./epicenter.json`. Add an action when the caller cannot do the job
with `set`: making an id (`add`), a rule across fields (Vocab's `review`
scheduling), or a read shaped for a screen (Capture's `recent`). Reuse
`collectionActions(name, collection)` inside an action instead of parsing
front matter again.

Annotate honestly. A run that is not `readOnlyHint: true` commits what it
wrote, one commit per call named `<app>: <words> <first positional>`, so a
read marked as a write leaves empty work and a write marked as a read is
never committed.

## Build the UI as a client

Copy an existing app's `ui/`: SvelteKit with the hash router (routes are
`#/t/<id>`), `@epicenter/ui` and its `app.css`, a manifest and icons in
`static/`, and its `svelte.config.js`, which builds into `../.cache/ui/` with
the app's folder name as the base. Ask for everything with
`connect('<app>').call('<words>', input)` from `@epicenter/app/client`
(`call('set', …)` in an app with one collection); the UI keeps nothing of its
own.

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
- Every write is a commit. Save on blur, on a pause, or on an explicit
  action, never on each keystroke.

## Verify without touching the person's data

Never run anything against the real `~/Epicenter` until the person asks.
`HOME` decides `~`, so try an app in a temporary home. In the monorepo, build
the UI in place, then copy the app into the temporary home as a repository of
its own, since `epicenter` commits every write into the app's repository:

```sh
bun test ./epicenter.test.ts               # in apps/<app>: actions over createMemoryContext
(cd apps/<app>/ui && bun run build)        # writes apps/<app>/.cache/ui/
T=$(mktemp -d)
printf '[user]\n\tname = Test\n\temail = test@example.com\n' > $T/.gitconfig
HOME=$T bun packages/cli/src/bin.ts init $T/Epicenter   # writes epicenter.root.json
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
  folder inside the monorepo is not a starter; Capture, Tasks, and Vocab
  become starters when each moves to a repository of its own.
- `epicenter update [<app>]` merges the starter's changes, lists files that no
  longer fit, and builds. It refuses an app with uncommitted changes and undoes
  a merge that conflicts, naming the command that resolves it.
- Backups go to `origin`: add the remote, and `epicenter sync` and `serve`
  push there by name, never to `upstream`.
- `epicenter build [<app>]` rebuilds a UI after a local edit, keeping the last
  one that built; the UI project's own `bun run build` empties `.cache/ui/`
  first, so a page served meanwhile is missing.
- Run these from inside the Epicenter the app belongs to; another person's
  Epicenter on the same computer is another folder with its own port.

A running `epicenter serve` sees a change on the next request: it lists tools
and reads `.cache/ui/` from disk each time.
