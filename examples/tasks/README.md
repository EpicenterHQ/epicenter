# Tasks

Things to do, as an app in `~/Epicenter/apps/tasks`. This `code/` folder holds
the software; sibling `data/` holds the tasks. The home’s private Git
repository checkpoints both, separately from actions. `epicenter serve`
serves its UI at `/tasks/`.

Use the latest Epicenter CLI for a new home. Tasks runs on 0.2.0 or later.
To add Tasks to your home, run these at the top of the home

```sh
epicenter new tasks --from EpicenterHQ/epicenter/examples/tasks
bun install && bun run build
epicenter serve
```

Open `/tasks/` at the address printed by `serve`. Add a task with the plus
button. Your new list starts empty.

## A task is a file

```md
---
title: "Email Sam the slides"
done: false
due: "2026-11-12"
---
The deck is in Drive.
```

`data/tasks/<id>.md`, named by the time it was added, such as
`data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md`. The file stem is the task's id:
`get`, `set`, and `delete` name it with `{"id":"2026-11-10T09-30-00-000Z-k3x9a2f8"}`.
`title` is required and is one line, not blank. `done` is `false` unless set.
`due` is a day, absent when there is none. The notes are the body, in
Markdown. `add` makes the id with `timeId()` inside the action.

`list` returns each fitting record with its path, id, fields, and body. A file
that does not fit returns a Misfit beside the readable records. Its partial
record keeps fitting fields and the body for repair; it is never silently
included in the open task groups.

## Actions

| Action | Does |
| --- | --- |
| `list`, `get`, `set`, `delete` | list all tasks, or use a task's `id` to read, change, or delete it |
| `add` | a new task named by the time, from `title` and optional `due` and `notes`; a title of several lines keeps its first line as the title and the rest as notes |

Each action takes one JSON object; `epicenter tasks <action> --help` lists
its keys.

```sh
epicenter tasks add '{"title":"Email Sam the slides","due":"2026-11-12"}'
epicenter tasks set '{"id":"2026-11-10T09-30-00-000Z-k3x9a2f8","done":true}'
epicenter tasks set '{"id":"2026-11-10T09-30-00-000Z-k3x9a2f8","due":null}'
```

A title or notes that may hold an apostrophe or a line break go on stdin,
where nothing needs quoting for the shell:

```sh
epicenter tasks add - <<'EOF'
{"title":"Call Mom\nabout the trip","notes":"Ask what she'd like for Sunday"}
EOF
```

To change the notes, `set` with an `edit` object quotes what is there and gives what replaces it;
`old` must be nonempty and occur exactly once. Use `body` to replace empty
notes:

```sh
epicenter tasks set - <<'EOF'
{"id":"2026-11-10T09-30-00-000Z-k3x9a2f8","edit":{"old":"The deck is in Drive.","new":"The deck's final copy is in Drive."}}
EOF
```

`set` merges as JSON Merge Patch does, so `"due":null`, over the command
line, MCP, or the UI, removes the line. `set` refuses a title of several lines
or a blank one. Field patches use the last write. A save of a deleted task
returns Missing and does not recreate it.

## The UI

To change the colors, open [ui/src/theme.css](ui/src/theme.css) beside this
README in the app's `code/` folder.
Set `--primary` under `:root` for the light-mode Add button and under `.dark`
for dark mode. Run `bun run build` in `code/` and reload the page. The exported
app includes its own copy of the palette.

`ui/`: the list (`#/`) with a quick add and optional due date. Open tasks are
grouped as Overdue, Today, Upcoming, and No date. Done tasks fold under Completed.
A task's page is at its key (`#/tasks/<id>`): it edits the title, done,
due day, and notes, and deletes the task after asking.

Done, title, and due changes use ordinary TanStack mutations through `set`.
Title saves when its field changes; notes save whenever I leave their field.
Until then, notes live only in the page: navigation, reload, or closing before
blur can discard them, with no notes-specific leave warning. Failed writes
report their errors without recovery reads or automatic resends. Notes wait for their own pending save and its refreshed
reads, so a click on a due-day button after leaving notes still counts.
Reloading with an unsaved title asks before leaving.

Title, due and completion changes use field patches. Notes quote the previous
nonempty body through `set` with `edit`. If the quote changed, the page keeps
the draft and offers Save mine against the latest saved text, or Show saved
to drop it. Empty notes use `set` with `body`. Every write refreshes the active
reads. Reads also refresh when the page becomes visible, with no polling.

A task whose file does not fit shows a mark in the list, and its page quotes
the problems. Navigation starts at the top, including Back and Forward.

A successful save puts its returned record into the query cache before reads
refresh. If a refresh fails, the saved record stays visible and a Refresh
action retries that read without repeating the write. Save errors still show
after leaving the page.

## Browser checks

Use a disposable Epicenter with synthetic tasks. Check title, notes, due-day
changes and completion across reload. Check Delete cancellation, disabled
controls while pending, failure and retry. Check quick add, phone and desktop
widths, encoded keys and malformed route encoding. Real `data/` is not test
input.

For save regressions, fail a write after navigating away and check that its
error is still shown. Fail only the follow-up read after a successful save:
the saved value must remain visible, and Refresh must make no second write.
Edit notes, leave their field, then reopen and reload the task: the saved text
must remain. Lose the answer after a save and verify that the draft remains
and the page reports the failure without resending. Hold the follow-up read open:
notes must stay disabled until it finishes. Leaving notes to click Tomorrow
must save both changes on that first click. No notes draft is retained in
browser storage.

The declaration in `data.ts` has one folder key, `tasks`; ids keep existing
file stems. No data or local-file moves are needed. None of the actions
streams updates. Devices call serve directly while online.
