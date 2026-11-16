# Tasks

Things to do, as an app in `~/Epicenter/apps/tasks`. This `code/` folder holds
the software; sibling `data/` holds the tasks. The home’s private Git
repository checkpoints both, separately from actions. `epicenter serve`
serves its UI at `/tasks/`.

From an Epicenter running CLI 0.4.0 or later, take a copy with:

```sh
epicenter new tasks --from 'https://github.com/EpicenterHQ/epicenter#examples/tasks'
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

`data/tasks/<time>.md`, named by the time it was added, such as
`data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md`. The time is the task's key:
every action names a task by it, `{"time":"2026-11-10T09-30-00-000Z-k3x9a2f8"}`.
`title` is required and is one line, not blank. `done` is `false` unless set.
`due` is a day, absent when there is none. The notes are the body, in
Markdown. This is the earlier Todos app's shape (`todos/<id>.md` with `title`
and `done`) plus `due`, so its files move over by renaming the folder.

The title is a field, not the body's first line, because `tasks list` gives
every task's fields without its body: the list, and an agent asking what is
left to do, read titles from one call.

A file written by hand that does not fit reads as far as it can: a `due` that
is not a day is left out, a missing `done` reads as `false`, and the task
carries `problems` quoting what did not fit.

## Actions

| Action | Does |
| --- | --- |
| `list`, `get`, `set`, `delete` | list all tasks, or use a task's `time` to read, change, or delete it |
| `add` | a new task named by the time, from `title` and optional `due` and `notes`; a title of several lines keeps its first line as the title and the rest as notes |

Each action takes one JSON object; `epicenter tasks <action> --help` lists
its keys.

```sh
epicenter tasks add '{"title":"Email Sam the slides","due":"2026-11-12"}'
epicenter tasks set '{"time":"2026-11-10T09-30-00-000Z-k3x9a2f8","done":true}'
epicenter tasks set '{"time":"2026-11-10T09-30-00-000Z-k3x9a2f8","due":null}'
```

A title or notes that may hold an apostrophe or a line break go on stdin,
where nothing needs quoting for the shell:

```sh
epicenter tasks add - <<'EOF'
{"title":"Call Mom\nabout the trip","notes":"Ask what she'd like for Sunday"}
EOF
```

To change the notes, `set` with an `edit` object quotes what is there and gives what replaces it;
`old` may be the whole notes, and is refused when it is not in them:

```sh
epicenter tasks set - <<'EOF'
{"time":"2026-11-10T09-30-00-000Z-k3x9a2f8","edit":{"old":"The deck is in Drive.","new":"The deck's final copy is in Drive."}}
EOF
```

`set` merges as JSON Merge Patch does, so `"due":null`, over the command
line, MCP, or the UI, removes the line. `set` refuses a title of several lines
or a blank one, as `add` does. `set` with `was`, such as
`"was":{"done":false}`, is refused when a value named there has changed since.

## The UI

To change the colors, edit `apps/tasks/code/ui/src/theme.css` in your Epicenter.
Set `--primary` under `:root` for the light-mode Add button and under `.dark`
for dark mode. Run `epicenter build tasks` and reload the page. The exported
app includes its own copy of the palette.

`ui/`: the list (`#/`) with a quick add and optional due date. Open tasks are
grouped as Overdue, Today, Upcoming, and No date. Done tasks fold under Completed.
A task's page is at its key (`#/tasks/<time>`): it edits the title, done,
due day, and notes, and deletes the task after asking.

Done, title, and due changes use ordinary TanStack mutations through `set`.
Title saves when its field changes; notes save whenever I leave their field.
Until then, notes live only in the page: navigation, reload, or closing before
blur can discard them, with no notes-specific leave warning. After a save error the UI checks the submitted fields or notes against a fresh
read. If they differ or the read fails, it keeps unfinished input. Notes wait for their own pending save and its refreshed
reads, so a click on a due-day button after leaving notes still counts.
Reloading with an unsaved title asks before leaving.

Another writer may change a task while its page is open. Each `set` names in
`was` the value the page showed, and notes save through `edit`, quoting the
notes as they were when typing began. A save over a change made elsewhere is
refused: the page then shows what is saved, keeps the typed title or notes,
and offers Save mine, which saves them over the change; for notes, Show saved
drops the draft. Every write refreshes the active reads. Reads also refresh
when the page becomes visible, with no polling.

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
must remain. Lose the answer after a save and verify that a fresh read of the
notes confirms the edit. If the read fails, the draft must remain. Hold the follow-up read open:
notes must stay disabled until it finishes. Leaving notes to click Tomorrow
must save both changes on that first click. No notes draft is retained in
browser storage.
