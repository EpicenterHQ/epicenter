# Notes

Notes I write and develop, as an app in `~/Epicenter/notes` (ADR-0864).
This folder is the starter's source (ADR-0866); `epicenter serve` serves its
UI at `/notes/`.

## A note is a file

An ordinary note lives at `notes/<time>.md`, named by when it was made:

```md
---
title: "A quieter morning"
createdAt: "2026-11-11T08:30:00+08:00"
---
Leave the phone outside the bedroom.
```

A note developed from a capture keeps the capture's path:

```md
---
title: "A quieter morning"
createdAt: "2026-11-11T08:30:00+08:00"
capture: "captures/2026-11-10T09-30-00-000Z-k3x9a2f8.md"
---
Leave the phone outside the bedroom. Start with a book instead.
```

It lives at `notes/capture-2026-11-10T09-30-00-000Z-k3x9a2f8.md`, or
`notes/capture-<capture time>.md`. The capture names the note, so two retries
meet at one file. An ordinary note's name has the same time format as Capture
and Tasks, with eight random characters after the time.

`title` is optional, one line and not blank when present. `createdAt` is
optional, a date and time with an offset; `add` fills it. `capture` is
optional, a path shaped as `captures/<name>.md`. Both `createdAt` and
`capture` are readOnly through the actions. A person can still edit the file
by hand. The body is Markdown, kept as written; `add` gives a nonempty body
a trailing newline.

The title is a field so `list` gives every note's title without reading its
body. A file written by hand reads as far as it can and carries `problems`
quoting anything that does not fit.

## Actions

| Action | Does |
| --- | --- |
| `list`, `get`, `set`, `edit`, `delete` | the collection's verbs, each taking a note's path (`packages/app/README.md`) |
| `add [title] [--body <text>] [--capture <path>]` | makes a note, or returns the note already made from that capture with `added: false` |

```sh
epicenter notes add "A quieter morning" --body "Leave the phone outside."
epicenter notes add "A quieter morning" --body "Start with a book." --capture captures/2026-11-10T09-30-00-000Z-k3x9a2f8.md
epicenter notes set notes/capture-2026-11-10T09-30-00-000Z-k3x9a2f8.md --title "Morning without a phone"
```

`set` changes the title; `title: null` over MCP or `--title null` on the CLI
removes it. `edit` changes the body by quoting the passage to replace.

An agent develops a capture in two calls: `capture_get` with
`{ "path": "captures/<time>.md" }`, then `notes_add` with a title, a developed
Markdown body, and `capture: "captures/<time>.md"`. A retry returns the same
note with `added: false` and leaves its text alone. `add` first checks every
note's `capture`, including files written by hand at another path. Concurrent
retries rely on the deterministic path and `add` refusing a file already there.
Deleting the note lets a later `add` make it again.

Notes never reads or changes Capture. It has no move action or summary
action. The agent reads the capture and writes the developed note; the
capture stays where it is, unchanged, and its history does not advance.

## The UI

`ui/`: the list (`#/`) has title search and a New note button. A note's page
is at its path (`#/notes/<name>.md`), with its title and Markdown body ready
to edit. Wide screens keep the list beside the editor; narrow screens show
one at a time. Delete asks first. Leaving a fresh, empty note removes it.

Changes save after a pause (800 ms for a title, 1500 ms for a body), when a
field loses focus, on Cmd/Ctrl+S, and when leaving the page. One save runs at
a time. The body saves with `edit`, quoting it as loaded. If it changed
elsewhere, the editor keeps the person's text and offers Keep mine or Use
theirs. While idle, the editor follows an agent's change every ten seconds
and when the page is shown again. The list refreshes every fifteen seconds
while visible and when the page is shown.

A developed note shows its capture's time when the name has one, its raw
path, and Open in Capture. Notes builds that link without fetching Capture.
Files that do not fit show a mark in the list and quote their problems in
the editor.

## Checks

From this folder:

```sh
bun run test
bun run typecheck
```

From `ui/`:

```sh
bun run test
bun run typecheck
bun run build
```

The action tests run against an in-memory folder. They cover capture retries,
concurrent adds, hand-written source paths, validation, readOnly fields, and
stale body edits. UI helper tests cover ordering, title search, capture times,
and encoded links. The build writes `../.cache/ui/` with assets under `/notes/`.
