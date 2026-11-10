---
name: epicenter-app
description: Make or change an app that lives in ~/Epicenter, from its source in the monorepo's apps/<app>: its collections, its actions, and its view. Use when asked to build a new personal app (a tracker, a log, a list), add a field or action to Capture, Tasks, or Vocab, change an app's view, or install an app onto the computer that runs epicenter serve.
---

# Epicenter apps

An app is a Git repository of files in `~/Epicenter/<app>` (ADR-0864). Its
source lives in this monorepo at `apps/<app>/`, and
`bun apps/install.ts <app>` puts it there. `epicenter serve` offers its
actions over MCP at `/mcp` and its view at `/<app>/`. Read
`apps/README.md`, `packages/app/README.md`, and one existing app before
starting; `apps/tasks` is the smallest whole example.

## Decide the files first

The files outlive every view and agent, so their shape is the decision that
matters most. Declare each collection in `epicenter.json`: a path with one
placeholder and the JSON Schema of each file's fields. A collection gives
`<name> list|get|set|delete` with no code (`packages/app/src/collection.ts`).

- Choose the key by how people and agents will name a file. A time id
  (`timeId()`) suits things made in passing (captures, tasks); a natural key
  suits things named by what they are (`words/你好.md`), at the cost of
  characters a file name cannot hold.
- `list` returns fields without bodies. Put what a list or an agent needs at a
  glance in a field (a task's `title`); put prose in the body.
- Keep fields few. `set` merges as JSON Merge Patch does: `null` removes a
  field, so a field that may be absent needs no `null` in its type.
- Keep an earlier app's file shape when it is sound, so its files can move
  over; say what changed and why.

## Write actions only for what the four verbs cannot do

`epicenter.ts` default-exports `defineApp(declaration, { actions })` and may
import only `@epicenter/app` and `./epicenter.json`. Add an action when the
caller cannot do the job with `set`: making an id (`add`), a rule across
fields (Vocab's `review` scheduling), or a read shaped for a screen (Capture's
`recent`). Reuse `collectionActions(name, collection)` inside an action
instead of parsing front matter again.

Annotate honestly. `serve` commits after every call that is not
`readOnlyHint: true`, one commit per call named `<app>: <words> <first
positional>`, so a read marked as a write leaves empty work and a write
marked as a read is never committed.

## Build the view as a client

Copy an existing app's scaffold: SvelteKit with the hash router (no page
options; routes are `#/t/<id>`), `@epicenter/ui` and its `app.css`, a
manifest and icons in `static/`. Ask for everything with
`connect('<app>').call('<words>', input)` from `@epicenter/app/client`; the
view keeps nothing of its own.

- It is a phone Home Screen app first: safe-area insets, 44 px targets, 16 px
  inputs so iOS does not zoom, light and dark from the system.
- Update optimistically and say a failed write in a toast. Refresh on
  visibility and every 15 s while visible, and drop a refresh that began
  before a write, so it cannot undo what the screen shows.
- Every write is a commit. Save on blur, on a pause, or on an explicit
  action, never on each keystroke.

## Verify without touching the person's data

Never run anything against the real `~/Epicenter` until the person asks to
install. `HOME` decides `~`, so:

```sh
bun test                                   # in apps/<app>: actions over createMemoryContext
T=$(mktemp -d); HOME=$T git lfs install
HOME=$T bun apps/install.ts <app>
HOME=$T bun packages/cli/src/bin.ts <app> <words> ...
HOME=$T bun packages/cli/src/bin.ts serve --port 4799   # then drive http://localhost:4799/<app>/
```

Run `bun run typecheck` and `bun run build` in the app. Run tests one file or
package at a time.

## Install

`bun apps/install.ts <app>` makes the app with `epicenter new` the first
time, commits `epicenter.json` and `epicenter.ts` as `install <app>`, and
builds the view into the app's gitignored `views/`. It never touches data. A
running `epicenter serve` sees the change on the next request: it lists tools
and reads views from disk each time.
